'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

// ============================================================
// ServerManager: persists server configs to data/servers.json
// ============================================================
class ServerManager {
  constructor() {
    this._servers = new Map();
    this._load();
  }

  // ------------------------------------------------------------------
  // Internal: load from disk (called once on startup)
  // ------------------------------------------------------------------
  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(SERVERS_FILE)) return;
      const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const s of list) {
          if (s && s.id) this._servers.set(s.id, s);
        }
      }
      console.log(`[ServerManager] Loaded ${this._servers.size} server(s) from disk`);
    } catch (err) {
      console.error('[ServerManager] Failed to load servers.json:', err.message);
    }
  }

  // ------------------------------------------------------------------
  // Internal: persist to disk
  // ------------------------------------------------------------------
  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SERVERS_FILE, JSON.stringify([...this._servers.values()], null, 2), 'utf8');
    } catch (err) {
      console.error('[ServerManager] Failed to save servers.json:', err.message);
    }
  }

  // ------------------------------------------------------------------
  // Get all servers as an array
  // ------------------------------------------------------------------
  getAll() {
    return [...this._servers.values()];
  }

  // ------------------------------------------------------------------
  // Get a single server by ID (returns undefined if not found)
  // ------------------------------------------------------------------
  get(id) {
    return this._servers.get(id);
  }

  // ------------------------------------------------------------------
  // Add a new server config
  // config: { name, serverPath, type, version, jarFile, minRam, maxRam, javaPath, javaArgs }
  // Returns the new server object with generated ID
  // ------------------------------------------------------------------
  add(config) {
    const server = {
      id:         uuidv4(),
      name:       config.name       || 'Unnamed Server',
      serverPath: config.serverPath,
      type:       config.type       || 'unknown',
      version:    config.version    || 'unknown',
      jarFile:    config.jarFile    || null,
      minRam:     Number(config.minRam) || 512,
      maxRam:     Number(config.maxRam) || 1024,
      javaPath:   config.javaPath   || 'java',
      javaArgs:   config.javaArgs   || '',
      createdAt:  new Date().toISOString()
    };
    this._servers.set(server.id, server);
    this._save();
    return server;
  }

  // ------------------------------------------------------------------
  // Update fields of an existing server
  // Only whitelisted keys can be changed
  // ------------------------------------------------------------------
  update(id, updates) {
    const server = this._servers.get(id);
    if (!server) throw new Error(`Server ${id} not found`);

    const allowed = ['name', 'serverPath', 'type', 'version', 'jarFile', 'minRam', 'maxRam', 'javaPath', 'javaArgs'];
    for (const key of allowed) {
      if (key in updates) {
        server[key] = (key === 'minRam' || key === 'maxRam') ? Number(updates[key]) : updates[key];
      }
    }

    this._servers.set(id, server);
    this._save();
    return server;
  }

  // ------------------------------------------------------------------
  // Remove a server from the manager (does NOT delete files)
  // ------------------------------------------------------------------
  remove(id) {
    const existed = this._servers.delete(id);
    if (existed) this._save();
    return existed;
  }
}

module.exports = new ServerManager();
