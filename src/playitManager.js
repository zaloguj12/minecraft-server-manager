/*
Commented out since feature cancelled


'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');

// ============================================================
// PlayitManager: manages a single playit.gg process
// Emits 'statusChange' with the status object when state changes
// ============================================================
class PlayitManager extends EventEmitter {
  constructor() {
    super();
    this._proc     = null;
    this._status   = 'stopped'; // stopped | starting | running | error
    this._tunnels  = [];         // Array of tunnel address strings
    this._claimUrl = null;       // URL shown on first-time setup
    this._buffer   = [];         // Last 100 output lines
  }

  // ------------------------------------------------------------------
  // Get current status snapshot
  // ------------------------------------------------------------------
  getStatus() {
    return {
      status:   this._status,
      tunnels:  [...this._tunnels],
      claimUrl: this._claimUrl,
      log:      [...this._buffer]
    };
  }

  // ------------------------------------------------------------------
  // Start playit
  // opts: { playitPath?, secretKey? }
  //   playitPath  - absolute path to playit binary (or 'playit' for PATH)
  //   secretKey   - auth secret key (optional, for pre-authed setups)
  // ------------------------------------------------------------------
  start({ playitPath = 'playit', secretKey } = {}) {
    if (this._proc) throw new Error('playit is already running');

    const args = [];
    if (secretKey && secretKey.trim()) {
      args.push('--secret', secretKey.trim());
    }

    this._proc     = spawn(playitPath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this._status   = 'starting';
    this._tunnels  = [];
    this._claimUrl = null;
    this._buffer   = [];

    this.emit('statusChange', this.getStatus());

    const handleData = (data) => {
      const text = data.toString();
      const lines = text.split('\n').filter(l => l.trim());

      for (const line of lines) {
        this._buffer.push(line);
        if (this._buffer.length > 100) this._buffer.shift();

        // Detect claim/setup URL (first-time auth)
        const claimMatch = line.match(/https:\/\/(?:playit\.gg\/[^\s]+|app\.playit\.gg\/[^\s]+)/i);
        if (claimMatch) this._claimUrl = claimMatch[0];

        // Detect tunnel addresses like:  xxx.at.ply.gg:PORT  or  tcp://xxx.playit.gg:PORT
        const tunnelMatches = [...line.matchAll(/([\w-]+\.(?:playit\.gg|ply\.gg):\d+)/gi)];
        for (const m of tunnelMatches) {
          if (!this._tunnels.includes(m[1])) {
            this._tunnels.push(m[1]);
          }
        }

        if (this._tunnels.length > 0 && this._status !== 'running') {
          this._status = 'running';
        }
      }

      this.emit('statusChange', this.getStatus());
    };

    this._proc.stdout.on('data', handleData);
    this._proc.stderr.on('data', handleData);

    this._proc.on('error', (err) => {
      const msg = `[PlayitManager] Error: ${err.message}`;
      this._buffer.push(msg);
      this._status = 'error';
      this._proc   = null;
      this.emit('statusChange', this.getStatus());
    });

    this._proc.on('exit', (code) => {
      const msg = `[PlayitManager] Process exited (code=${code})`;
      this._buffer.push(msg);
      this._status  = 'stopped';
      this._tunnels = [];
      this._proc    = null;
      this.emit('statusChange', this.getStatus());
    });
  }

  // ------------------------------------------------------------------
  // Stop playit
  // ------------------------------------------------------------------
  stop() {
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }
    this._status  = 'stopped';
    this._tunnels = [];
    this.emit('statusChange', this.getStatus());
  }
}

module.exports = new PlayitManager();


*/