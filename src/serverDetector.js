'use strict';

const fs   = require('fs');
const path = require('path');

// ============================================================
// Known server type signatures (checked in priority order)
// ============================================================
const TYPE_PATTERNS = [
  { type: 'neoforge', patterns: ['neoforge'] },
  { type: 'forge',    patterns: ['forge', 'minecraftforge'] },
  { type: 'fabric',   patterns: ['fabric-server', 'fabric-loader', 'fabric'] },
  { type: 'purpur',   patterns: ['purpur'] },
  { type: 'paper',    patterns: ['paper'] },
  { type: 'spigot',   patterns: ['spigot'] },
  { type: 'bukkit',   patterns: ['craftbukkit', 'bukkit'] },
  { type: 'sponge',   patterns: ['sponge'] },
  { type: 'vanilla',  patterns: ['minecraft_server', 'server'] }
];

// ============================================================
// Detect server type + jar in a given folder
// Returns: { valid, type, version, jarFile, eulaAccepted, warning, error }
// ============================================================
function detect(serverPath) {
  // Existence check
  try {
    const stat = fs.statSync(serverPath);
    if (!stat.isDirectory()) {
      return { valid: false, error: 'Path exists but is not a directory' };
    }
  } catch (_) {
    return { valid: false, error: 'Path does not exist or cannot be accessed' };
  }

  let files;
  try {
    files = fs.readdirSync(serverPath);
  } catch (err) {
    return { valid: false, error: `Cannot read directory: ${err.message}` };
  }

  const jars = files.filter(f => f.toLowerCase().endsWith('.jar'));

  // Folder structure hints
  const hasMods    = files.some(f => f === 'mods'    && isDir(serverPath, f));
  const hasPlugins = files.some(f => f === 'plugins' && isDir(serverPath, f));
  const hasEula    = files.some(f => f.toLowerCase() === 'eula.txt');

  let eulaAccepted = false;
  if (hasEula) {
    try {
      const eulaContent = fs.readFileSync(path.join(serverPath, 'eula.txt'), 'utf8');
      eulaAccepted = /eula\s*=\s*true/i.test(eulaContent);
    } catch (_) {}
  }

  if (jars.length === 0) {
    // No jars found — could be a partially set-up server
    let guessedType = 'unknown';
    if (hasMods) guessedType = 'forge';
    if (hasPlugins) guessedType = 'paper';
    return {
      valid: true,
      type: guessedType,
      version: 'unknown',
      jarFile: null,
      eulaAccepted,
      warning: 'No .jar file found in this directory. Set the jar file manually in Settings.'
    };
  }

  // Try to match jar name against known type patterns
  for (const { type, patterns } of TYPE_PATTERNS) {
    for (const jar of jars) {
      const lower = jar.toLowerCase();
      if (patterns.some(p => lower.includes(p))) {
        return {
          valid: true,
          type,
          version: extractVersion(jar),
          jarFile: jar,
          eulaAccepted,
          warning: null
        };
      }
    }
  }

  // Fallback: use first jar but flag as unknown
  const fallbackJar = jars[0];
  let fallbackType = 'unknown';
  if (hasMods) fallbackType = 'forge';
  else if (hasPlugins) fallbackType = 'paper';

  return {
    valid: true,
    type: fallbackType,
    version: extractVersion(fallbackJar),
    jarFile: fallbackJar,
    eulaAccepted,
    warning: `Could not determine server type from jar name "${fallbackJar}". Type was guessed — correct it in Settings if needed.`
  };
}

// ============================================================
// List all .jar files in a directory (for the Settings jar picker)
// ============================================================
function listJars(serverPath) {
  try {
    return fs.readdirSync(serverPath).filter(f => f.toLowerCase().endsWith('.jar'));
  } catch (_) {
    return [];
  }
}

// ============================================================
// Read server.properties -> { key: value } object
// ============================================================
function readProperties(serverPath) {
  const propsFile = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(propsFile)) {
    return {};
  }
  const raw = fs.readFileSync(propsFile, 'utf8');
  const result = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

// ============================================================
// Write { key: value } object back to server.properties
// Preserves existing comment header if present
// ============================================================
function writeProperties(serverPath, properties) {
  const propsFile = path.join(serverPath, 'server.properties');

  // Preserve header comments from existing file
  let header = '#Minecraft server properties\n';
  if (fs.existsSync(propsFile)) {
    const existing = fs.readFileSync(propsFile, 'utf8').split('\n');
    const comments = existing.filter(l => l.trim().startsWith('#'));
    if (comments.length > 0) header = comments.join('\n') + '\n';
  }

  const lines = Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);

  fs.writeFileSync(propsFile, header + lines.join('\n') + '\n', 'utf8');
}

// ============================================================
// Read eula.txt status
// ============================================================
function readEula(serverPath) {
  const eulaFile = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaFile)) return false;
  try {
    return /eula\s*=\s*true/i.test(fs.readFileSync(eulaFile, 'utf8'));
  } catch (_) { return false; }
}

// ============================================================
// Write eula.txt
// ============================================================
function writeEula(serverPath, accepted) {
  fs.writeFileSync(
    path.join(serverPath, 'eula.txt'),
    `#By changing the setting below to TRUE you also agree to the Minecraft EULA\n#https://aka.ms/MinecraftEULA\neula=${accepted ? 'true' : 'false'}\n`,
    'utf8'
  );
}

// ============================================================
// Internal helpers
// ============================================================
function isDir(base, name) {
  try { return fs.statSync(path.join(base, name)).isDirectory(); } catch (_) { return false; }
}

function extractVersion(jarName) {
  // Match patterns like: 1.20.4, 1.20, 1.8.9
  const m = jarName.match(/(\d+\.\d+(?:\.\d+)?(?:-\w+)?)/);
  return m ? m[1] : 'unknown';
}

module.exports = { detect, listJars, readProperties, writeProperties, readEula, writeEula };
