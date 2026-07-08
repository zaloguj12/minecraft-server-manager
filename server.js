'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const serverManager  = require('./src/serverManager');
const processManager = require('./src/processManager');
const serverDetector = require('./src/serverDetector');
const serverCreator  = require('./src/serverCreator');

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Notification broadcasting (notifications WebSocket)
// ============================================================
const notificationClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of notificationClients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch (_) {}
    }
  }
}

// Forward process status changes to browser
processManager.on('statusChange', (serverId, status) => {
  broadcast({ type: 'server_status', serverId, status });
});


// ============================================================
// REST API
// ============================================================

// --- List servers ---
app.get('/api/servers', (req, res) => {
  const servers = serverManager.getAll().map(s => ({
    ...s,
    status: processManager.getStatus(s.id)
  }));
  res.json({ servers });
});

// --- Attach existing server ---
app.post('/api/servers', (req, res) => {
  try {
    const { name, serverPath } = req.body;
    if (!name || !serverPath) return res.status(400).json({ error: 'name and serverPath are required' });

    const detected = serverDetector.detect(serverPath);
    if (!detected.valid) return res.status(400).json({ error: detected.error });

    const server = serverManager.add({
      name,
      serverPath,
      type:          detected.type,
      version:       detected.version,
      jarFile:       detected.jarFile,
      // Use explicitly supplied script, or fall back to auto-detected one
      startupScript: req.body.startupScript !== undefined
                       ? (req.body.startupScript || null)
                       : (detected.scriptFile || null),
      minRam:        req.body.minRam   || 512,
      maxRam:        req.body.maxRam   || 1024,
      javaPath:      req.body.javaPath || 'java',
      javaArgs:      req.body.javaArgs || ''
    });

    res.json({ server: { ...server, status: 'stopped' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Get one server ---
app.get('/api/servers/:id', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.json({ server: { ...s, status: processManager.getStatus(s.id) } });
});

// --- Update server config ---
app.put('/api/servers/:id', (req, res) => {
  try {
    if (!serverManager.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
    const updated = serverManager.update(req.params.id, req.body);
    res.json({ server: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Remove server from manager (no file deletion) ---
app.delete('/api/servers/:id', (req, res) => {
  if (!serverManager.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  const status = processManager.getStatus(req.params.id);
  if (status !== 'stopped' && status !== 'crashed') {
    return res.status(400).json({ error: 'Stop the server before removing it' });
  }
  serverManager.remove(req.params.id);
  res.json({ success: true });
});

// --- Start ---
app.post('/api/servers/:id/start', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const status = processManager.getStatus(req.params.id);
  if (status !== 'stopped' && status !== 'crashed') {
    return res.status(400).json({ error: `Server is already ${status}` });
  }
  try {
    processManager.start(req.params.id, s);
    res.json({ success: true, status: 'starting' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Graceful stop ---
app.post('/api/servers/:id/stop', (req, res) => {
  if (!serverManager.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  const ok = processManager.stop(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Server is not running' });
  res.json({ success: true });
});

// --- Force kill ---
app.post('/api/servers/:id/kill', (req, res) => {
  if (!serverManager.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  const ok = processManager.kill(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Server is not running' });
  res.json({ success: true });
});

// --- Restart ---
app.post('/api/servers/:id/restart', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });

  const status = processManager.getStatus(req.params.id);

  if (status === 'stopped' || status === 'crashed') {
    // Just start it
    try {
      processManager.start(req.params.id, s);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Listen for the stop, then start again
  const onStatusChange = (id, newStatus) => {
    if (id !== req.params.id) return;
    if (newStatus === 'stopped' || newStatus === 'crashed') {
      processManager.removeListener('statusChange', onStatusChange);
      setTimeout(() => {
        try { processManager.start(req.params.id, s); } catch (_) {}
      }, 1500);
    }
  };
  processManager.on('statusChange', onStatusChange);
  processManager.stop(req.params.id);
  res.json({ success: true });
});

// --- Status ---
app.get('/api/servers/:id/status', (req, res) => {
  if (!serverManager.get(req.params.id)) return res.status(404).json({ error: 'Server not found' });
  res.json({ status: processManager.getStatus(req.params.id) });
});

// --- Read properties ---
app.get('/api/servers/:id/properties', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    res.json({ properties: serverDetector.readProperties(s.serverPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Write properties ---
app.put('/api/servers/:id/properties', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  try {
    serverDetector.writeProperties(s.serverPath, req.body.properties || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- File browser ---
app.get('/api/servers/:id/files', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });

  const subDir = req.query.dir || '';
  const base   = path.resolve(s.serverPath);
  const target = path.resolve(base, subDir);

  // Prevent path traversal outside server directory
  if (!target.startsWith(base)) return res.status(403).json({ error: 'Access denied' });

  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const files = entries.map(e => {
      let size = null;
      try {
        if (!e.isDirectory()) size = fs.statSync(path.join(target, e.name)).size;
      } catch (_) {}
      return {
        name:        e.name,
        isDirectory: e.isDirectory(),
        relativePath: subDir ? path.join(subDir, e.name).replace(/\\/g, '/') : e.name,
        size
      };
    }).sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ files, currentDir: subDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- File content viewer (read-only) ---
app.get('/api/servers/:id/files/content', (req, res) => {
  const s = serverManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });

  const filePath = req.query.path || '';
  const base     = path.resolve(s.serverPath);
  const target   = path.resolve(base, filePath);

  // Prevent path traversal outside server directory
  if (!target.startsWith(base)) return res.status(403).json({ error: 'Access denied' });

  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory' });

    // Size limit: 512 KB
    const MAX_SIZE = 512 * 1024;
    if (stat.size > MAX_SIZE) {
      return res.json({
        content: null,
        reason: `File too large to preview (${(stat.size / 1024).toFixed(0)} KB, limit is 512 KB)`
      });
    }

    // Known binary extensions - skip reading entirely
    const BINARY_EXT = new Set([
      'jar', 'zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz',
      'class', 'bin', 'exe', 'dll', 'so', 'dylib',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
      'mp4', 'mp3', 'ogg', 'wav', 'flac',
      'pdf', 'mca', 'nbt', 'lck'
    ]);
    const ext = path.extname(target).toLowerCase().slice(1);
    if (BINARY_EXT.has(ext)) {
      return res.json({ content: null, reason: 'Binary file - cannot display as text' });
    }

    // Read as buffer and check for null bytes (binary detection)
    const buf      = fs.readFileSync(target);
    const checkLen = Math.min(buf.length, 8192);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) {
        return res.json({ content: null, reason: 'Binary file - cannot display as text' });
      }
    }

    res.json({ content: buf.toString('utf8'), size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Detect server type without adding ---
app.post('/api/detect', (req, res) => {
  const { serverPath } = req.body;
  if (!serverPath) return res.status(400).json({ error: 'serverPath is required' });
  const result = serverDetector.detect(serverPath);
  res.json(result);
});

// --- List jar files in a directory ---
app.post('/api/list-jars', (req, res) => {
  const { serverPath } = req.body;
  if (!serverPath) return res.status(400).json({ error: 'serverPath is required' });
  res.json({ jars: serverDetector.listJars(serverPath) });
});

// --- List startup scripts in a directory ---
app.post('/api/list-scripts', (req, res) => {
  const { serverPath } = req.body;
  if (!serverPath) return res.status(400).json({ error: 'serverPath is required' });
  res.json({ scripts: serverDetector.listScripts(serverPath) });
});

// --- Minecraft version list ---
app.get('/api/minecraft/versions', async (req, res) => {
  try {
    const includeSnapshots = req.query.snapshots === 'true';
    const versions = await serverCreator.getVersionList(includeSnapshots);
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Create vanilla server (async, progress via notifications WS) ---
app.post('/api/minecraft/create', (req, res) => {
  const { name, serverPath, version, minRam, maxRam, acceptEula } = req.body;
  if (!name || !serverPath || !version) {
    return res.status(400).json({ error: 'name, serverPath, and version are required' });
  }

  const tempId = `create_${Date.now()}`;
  res.json({ success: true, tempId });

  serverCreator.createServer({
    serverPath,
    version,
    acceptEula: acceptEula !== false,
    onProgress: (message, progress) => {
      broadcast({ type: 'creation_progress', tempId, message, progress });
    }
  }).then((result) => {
    if (result.success) {
      const server = serverManager.add({
        name, serverPath,
        type:          'vanilla',
        version,
        jarFile:       result.jarFile,
        startupScript: null,
        minRam:        Number(minRam) || 512,
        maxRam:        Number(maxRam) || 1024,
        javaPath:      'java',
        javaArgs:      ''
      });
      broadcast({ type: 'creation_done', tempId, server: { ...server, status: 'stopped' } });
    }
  }).catch((err) => {
    broadcast({ type: 'creation_error', tempId, error: err.message });
  });
});


// ============================================================
// HTTP Server + WebSocket setup
// ============================================================
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'ws') { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, parts);
  });
});

wss.on('connection', (ws, req, parts) => {
  if (!parts) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    parts = url.pathname.split('/').filter(Boolean);
  }

  const channel = parts[1];

  if (channel === 'console') {
    const serverId = parts[2];
    if (!serverId) { ws.close(); return; }

    processManager.subscribe(serverId, ws);

    ws.on('message', (msg) => {
      processManager.sendCommand(serverId, msg.toString().trim());
    });

    ws.on('close', () => {
      processManager.unsubscribe(serverId, ws);
    });

  } else if (channel === 'notifications') {
    notificationClients.add(ws);
    ws.on('close', () => {
      notificationClients.delete(ws);
    });
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Minecraft Server Manager');
  console.log(`  Running at http://localhost:${PORT}`);
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[MSM] Shutting down...');
  server.close(() => process.exit(0));
});
