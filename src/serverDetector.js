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

// Preferred script names, platform-appropriate order.
// Windows prefers .bat/.cmd first; Linux/Mac prefers .sh first.
const SCRIPT_NAMES_WIN  = ['run.bat', 'run.cmd', 'start.bat', 'start.cmd', 'launch.bat', 'launch.cmd', 'run.sh', 'start.sh', 'launch.sh'];
const SCRIPT_NAMES_UNIX = ['run.sh', 'start.sh', 'launch.sh', 'run.bat', 'run.cmd', 'start.bat', 'start.cmd', 'launch.bat', 'launch.cmd'];

// ============================================================
// Detect server type + jar + startup script in a given folder
// Returns: { valid, type, version, jarFile, scriptFile, eulaAccepted, warning, error }
//
// scriptFile  - filename of the first recognised startup script found,
//               or null if none present. Prefer platform-native extension.
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

  // Detect startup script (platform-preferred order)
  const scriptFile = detectStartupScript(files);

  if (jars.length === 0) {
    // No jars found — could be script-only or partially set-up
    let guessedType = 'unknown';
    if (hasMods)    guessedType = 'forge';
    if (hasPlugins) guessedType = 'paper';

    const warning = scriptFile
      ? `No .jar file found. Startup script "${scriptFile}" detected — server can be launched via the script.`
      : 'No .jar file found in this directory. Set the jar file manually in Settings.';

    return {
      valid: true,
      type:  guessedType,
      version: 'unknown',
      jarFile: null,
      scriptFile,
      eulaAccepted,
      warning
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
          scriptFile,
          eulaAccepted,
          warning: null
        };
      }
    }
  }

  // Fallback: use first jar but flag as unknown
  const fallbackJar  = jars[0];
  let   fallbackType = 'unknown';
  if (hasMods)    fallbackType = 'forge';
  else if (hasPlugins) fallbackType = 'paper';

  return {
    valid: true,
    type:    fallbackType,
    version: extractVersion(fallbackJar),
    jarFile: fallbackJar,
    scriptFile,
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
// List all startup script files (.sh / .bat / .cmd) in a directory
// (for the Settings script picker)
// ============================================================
function listScripts(serverPath) {
  try {
    return fs.readdirSync(serverPath).filter(f => {
      const ext = f.toLowerCase();
      return ext.endsWith('.sh') || ext.endsWith('.bat') || ext.endsWith('.cmd');
    });
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

function detectStartupScript(files, platform = process.platform) {
  const scriptPriority = platform === 'win32' ? SCRIPT_NAMES_WIN : SCRIPT_NAMES_UNIX;
  for (const preferred of scriptPriority) {
    const match = files.find(f => f.toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return null;
}

module.exports = {
  detect,
  listJars,
  listScripts,
  readProperties,
  writeProperties,
  readEula,
  writeEula,
  detectStartupScript
};
