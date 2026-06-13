'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const EventEmitter = require('events');

const CONSOLE_BUFFER_SIZE = 500; // Lines kept per server

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    // Map of serverId -> { proc, subscribers, buffer, status, startTime }
    this.processes = new Map();
  }

  // ------------------------------------------------------------------
  // Start a server process
  // config: { serverPath, javaPath, jarFile, startupScript,
  //           minRam, maxRam, javaArgs }
  //
  // Launch priority:
  //   1. If startupScript is set -> run the script (ignores jar/java/RAM)
  //   2. Otherwise              -> java -jar <jarFile>
  //
  // Script rules:
  //   Windows + .bat/.cmd  ->  cmd /c <script>
  //   anything else        ->  bash <script>   (covers .sh on any OS)
  // ------------------------------------------------------------------
  start(id, config) {
    const existing = this.processes.get(id);
    if (existing && existing.proc) {
      throw new Error('Server is already running');
    }

    const {
      serverPath,
      javaPath     = 'java',
      jarFile,
      startupScript = null,
      minRam        = 512,
      maxRam        = 1024,
      javaArgs      = ''
    } = config;

    let proc;
    let launchDesc;

    if (startupScript) {
      // ---- Script mode ----
      const isWindows = process.platform === 'win32';
      const ext       = path.extname(startupScript).toLowerCase();

      let cmd, args;
      if (isWindows && (ext === '.bat' || ext === '.cmd')) {
        cmd  = 'cmd';
        args = ['/c', startupScript];
      } else {
        // .sh on any platform, or unknown extension -> try bash
        cmd  = 'bash';
        args = [startupScript];
      }

      launchDesc = `${cmd} ${args.join(' ')}`;
      proc = spawn(cmd, args, {
        cwd:   serverPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
    } else {
      // ---- Jar mode (original) ----
      if (!jarFile) throw new Error('No jar file configured for this server');

      const jvmArgs = [`-Xms${minRam}M`, `-Xmx${maxRam}M`];
      if (javaArgs && javaArgs.trim()) {
        jvmArgs.push(...javaArgs.trim().split(/\s+/).filter(Boolean));
      }
      jvmArgs.push('-jar', jarFile, '--nogui');

      launchDesc = `${javaPath} ${jvmArgs.join(' ')}`;
      proc = spawn(javaPath, jvmArgs, {
        cwd:   serverPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
    }

    // Reuse existing entry (keeps subscribers and old buffer) or create fresh
    const entry = existing || {
      subscribers: new Set(),
      buffer:      [],
      status:      'stopped',
      proc:        null,
      startTime:   null
    };

    entry.proc      = proc;
    entry.buffer    = [];
    entry.status    = 'starting';
    entry.startTime = Date.now();

    this.processes.set(id, entry);
    this._broadcast(id, `[MSM] Starting server: ${launchDesc}`);

    // Handle stdout and stderr identically
    const handleData = (data) => {
      const text  = data.toString();
      const lines = text.split('\n');
      for (const raw of lines) {
        const line = raw.replace(/\r/g, '');
        if (!line) continue;

        entry.buffer.push(line);
        if (entry.buffer.length > CONSOLE_BUFFER_SIZE) {
          entry.buffer.shift();
        }

        // Detect that the server has finished starting
        if (entry.status === 'starting' && /Done \(\d+\.\d+s\)! For help/.test(line)) {
          entry.status = 'running';
          this.emit('statusChange', id, 'running');
        }

        // Broadcast line to all connected console subscribers
        for (const ws of entry.subscribers) {
          if (ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'console', line })); } catch (_) {}
          }
        }
      }
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('error', (err) => {
      const msg = `[MSM] Failed to launch process: ${err.message}`;
      entry.buffer.push(msg);
      this._broadcast(id, msg);
      entry.status = 'crashed';
      entry.proc   = null;
      this.emit('statusChange', id, 'crashed');
    });

    proc.on('exit', (code, signal) => {
      const msg = `[MSM] Server process exited | code=${code} signal=${signal}`;
      entry.buffer.push(msg);
      this._broadcast(id, msg);
      // Only mark as crashed if it wasn't a clean stop
      entry.status = (code === 0 || entry.status === 'stopping') ? 'stopped' : 'crashed';
      entry.proc   = null;
      this.emit('statusChange', id, entry.status);
    });

    this.emit('statusChange', id, 'starting');
  }

  // ------------------------------------------------------------------
  // Graceful stop: sends the 'stop' command via stdin
  // ------------------------------------------------------------------
  stop(id) {
    const entry = this.processes.get(id);
    if (!entry || !entry.proc) return false;
    entry.status = 'stopping';
    this.emit('statusChange', id, 'stopping');
    this._broadcast(id, '[MSM] Sending stop command...');
    try {
      entry.proc.stdin.write('stop\n');
    } catch (_) {
      // stdin may already be closed
      entry.proc.kill('SIGTERM');
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Force kill: sends SIGTERM
  // ------------------------------------------------------------------
  kill(id) {
    const entry = this.processes.get(id);
    if (!entry || !entry.proc) return false;
    this._broadcast(id, '[MSM] Force killing server process...');
    entry.proc.kill('SIGTERM');
    return true;
  }

  // ------------------------------------------------------------------
  // Send a command string to stdin
  // ------------------------------------------------------------------
  sendCommand(id, command) {
    const entry = this.processes.get(id);
    if (!entry || !entry.proc || !entry.proc.stdin.writable) return false;
    try {
      entry.proc.stdin.write(command + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Subscribe a WebSocket to this server's console output
  // Sends the buffered lines first so the UI shows history
  // ------------------------------------------------------------------
  subscribe(id, ws) {
    if (!this.processes.has(id)) {
      this.processes.set(id, {
        proc:        null,
        subscribers: new Set(),
        buffer:      [],
        status:      'stopped',
        startTime:   null
      });
    }
    const entry = this.processes.get(id);
    entry.subscribers.add(ws);

    // Replay buffer
    for (const line of entry.buffer) {
      try { ws.send(JSON.stringify({ type: 'console', line })); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------
  // Unsubscribe a WebSocket
  // ------------------------------------------------------------------
  unsubscribe(id, ws) {
    const entry = this.processes.get(id);
    if (entry) entry.subscribers.delete(ws);
  }

  // ------------------------------------------------------------------
  // Get the current status string for a server
  // ------------------------------------------------------------------
  getStatus(id) {
    const entry = this.processes.get(id);
    return entry ? entry.status : 'stopped';
  }

  // ------------------------------------------------------------------
  // Internal: broadcast a line to all subscribers of a server
  // ------------------------------------------------------------------
  _broadcast(id, line) {
    const entry = this.processes.get(id);
    if (!entry) return;
    for (const ws of entry.subscribers) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'console', line })); } catch (_) {}
      }
    }
  }
}

module.exports = new ProcessManager();
