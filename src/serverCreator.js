'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

// ============================================================
// Fetch JSON from a URL (follows one redirect)
// ============================================================
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

// ============================================================
// Download a file with progress callback
// onProgress(bytesDownloaded, totalBytes)
// ============================================================
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl) => {
      const get = targetUrl.startsWith('https') ? https.get : http.get;
      get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading server jar`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;

        const file = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) onProgress(downloaded, total);
        });

        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
        res.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
      }).on('error', (err) => { reject(err); });
    };
    doGet(url);
  });
}

// ============================================================
// Return a list of available Minecraft versions from Mojang
// includeSnapshots = false means release only
// ============================================================
async function getVersionList(includeSnapshots = false) {
  const manifest = await fetchJson(VERSION_MANIFEST);
  return manifest.versions
    .filter(v => includeSnapshots || v.type === 'release')
    .map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}

// ============================================================
// Create a new vanilla server
// options: { serverPath, version, acceptEula, onProgress }
// Returns: { success, jarFile }
// ============================================================
async function createServer({ serverPath, version, acceptEula = false, onProgress = () => {} }) {
  // 1. Create directory
  onProgress('Creating server directory...', 5);
  fs.mkdirSync(serverPath, { recursive: true });

  // 2. Fetch manifest to get the version URL
  onProgress('Fetching version manifest...', 10);
  const manifest = await fetchJson(VERSION_MANIFEST);
  const versionEntry = manifest.versions.find(v => v.id === version);
  if (!versionEntry) throw new Error(`Minecraft version "${version}" not found in manifest`);

  // 3. Fetch version details to get the server jar URL
  onProgress('Fetching version details...', 15);
  const versionDetails = await fetchJson(versionEntry.url);
  const serverDownload = versionDetails.downloads && versionDetails.downloads.server;
  if (!serverDownload) throw new Error(`No server download available for version ${version}`);

  // 4. Download the server jar
  const jarName = `minecraft_server.${version}.jar`;
  const jarPath = path.join(serverPath, jarName);

  await downloadFile(serverDownload.url, jarPath, (bytes, total) => {
    const pct = total > 0 ? Math.round(20 + (bytes / total) * 70) : 20;
    const mb  = (bytes / 1024 / 1024).toFixed(1);
    const tot = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : '';
    onProgress(`Downloading server jar: ${mb} MB${tot}`, pct);
  });

  onProgress('Download complete!', 91);

  // 5. Write eula.txt
  if (acceptEula) {
    onProgress('Writing eula.txt...', 93);
    fs.writeFileSync(
      path.join(serverPath, 'eula.txt'),
      '#By changing the setting below to TRUE you also agree to the Minecraft EULA\n#https://aka.ms/MinecraftEULA\neula=true\n',
      'utf8'
    );
  }

  // 6. Write a minimal server.properties so the server is ready to run
  onProgress('Writing server.properties...', 95);
  const defaultProps = [
    '#Minecraft server properties',
    'server-port=25565',
    'max-players=20',
    'gamemode=survival',
    'difficulty=easy',
    'online-mode=true',
    'pvp=true',
    'level-name=world',
    `motd=A Minecraft Server`
  ].join('\n');
  const propsPath = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(propsPath)) {
    fs.writeFileSync(propsPath, defaultProps + '\n', 'utf8');
  }

  onProgress('Done! Server is ready.', 100);
  return { success: true, jarFile: jarName };
}

module.exports = { getVersionList, createServer };
