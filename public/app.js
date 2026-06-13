'use strict';

// ============================================================
// STATE
// ============================================================
const state = {
  servers:       [],
  selectedId:    null,
  consoleWs:     null,
  notifWs:       null,
  currentDir:    '',
  playit:        { status: 'stopped', tunnels: [], claimUrl: null },
  playitConfig:  { path: 'playit', secret: '' },
  versions:      [],
  createTempId:  null,
};

// ============================================================
// UTILITIES
// ============================================================

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, duration);
}

function fileIcon(name, isDir) {
  if (isDir) return '\uD83D\uDCC1';
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    jar: '\u2615', json: '{}', yml: '#', yaml: '#',
    txt: '\uD83D\uDCCB', log: '\uD83D\uDCC4',
    properties: '\u2699', sh: '\u25B6', bat: '\u25B6',
    zip: '\uD83D\uDCE6', gz: '\uD83D\uDCE6', tar: '\uD83D\uDCE6',
  };
  return map[ext] || '\uD83D\uDCC4';
}

function typeColor(type) {
  const map = {
    vanilla:  '#94a3b8',
    forge:    '#c17d3c',
    fabric:   '#c4bdb4',
    neoforge: '#6b8cc7',
    paper:    '#4fc1e9',
    purpur:   '#9b7fe5',
    spigot:   '#e9a24f',
    bukkit:   '#e9a24f',
    sponge:   '#f5c842',
    unknown:  '#555',
  };
  return map[type] || '#94a3b8';
}

// ============================================================
// API CLIENT
// ============================================================

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============================================================
// NOTIFICATIONS WEBSOCKET
// ============================================================

function connectNotifications() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws    = new WebSocket(`${proto}//${location.host}/ws/notifications`);

  ws.onmessage = (e) => {
    try { handleNotification(JSON.parse(e.data)); } catch (_) {}
  };

  ws.onclose = () => {
    setTimeout(connectNotifications, 3000);
  };

  state.notifWs = ws;
}

function handleNotification(data) {
  switch (data.type) {

    case 'server_status':
      updateServerStatus(data.serverId, data.status);
      break;

    case 'playit_status':
      state.playit = { status: data.status, tunnels: data.tunnels || [], claimUrl: data.claimUrl || null };
      renderPlayitWidget();
      break;

    case 'creation_progress':
      if (data.tempId === state.createTempId) {
        setCreateProgress(data.message, data.progress);
      }
      break;

    case 'creation_done':
      if (data.tempId === state.createTempId) {
        state.servers.push({ ...data.server, status: 'stopped' });
        renderServerList();
        hideAddModal();
        selectServer(data.server.id);
        toast('Server created successfully!', 'success');
        state.createTempId = null;
      }
      break;

    case 'creation_error':
      if (data.tempId === state.createTempId) {
        showCreateError(data.error);
        state.createTempId = null;
      }
      break;
  }
}

// ============================================================
// SERVER LIST
// ============================================================

async function loadServers() {
  try {
    const data = await api('GET', '/api/servers');
    state.servers = data.servers;
    renderServerList();
  } catch (err) {
    toast('Failed to load servers: ' + err.message, 'error');
  }
}

function renderServerList() {
  const list = document.getElementById('server-list');
  list.innerHTML = '';

  if (state.servers.length === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:var(--text-muted);font-size:12px;padding:12px 14px;';
    msg.textContent = 'No servers yet.';
    list.appendChild(msg);
    return;
  }

  for (const server of state.servers) {
    const item = document.createElement('div');
    item.className = 'server-item' + (server.id === state.selectedId ? ' active' : '');
    item.dataset.id = server.id;

    const dot = document.createElement('div');
    dot.className = `server-item-dot ${server.status || 'stopped'}`;
    dot.id = `dot-${server.id}`;

    const info = document.createElement('div');
    info.className = 'server-item-info';

    const name = document.createElement('div');
    name.className = 'server-item-name';
    name.textContent = server.name;

    const sub = document.createElement('div');
    sub.className = 'server-item-sub';
    const ver = server.version && server.version !== 'unknown' ? ` ${server.version}` : '';
    sub.textContent = `${server.type}${ver}`;

    info.appendChild(name);
    info.appendChild(sub);
    item.appendChild(dot);
    item.appendChild(info);
    item.addEventListener('click', () => selectServer(server.id));
    list.appendChild(item);
  }
}

// ============================================================
// STATUS HELPERS
// ============================================================

function updateServerStatus(serverId, status) {
  const server = state.servers.find(s => s.id === serverId);
  if (server) server.status = status;

  const dot = document.getElementById(`dot-${serverId}`);
  if (dot) dot.className = `server-item-dot ${status}`;

  if (state.selectedId === serverId) {
    updateStatusBadge(status);
    updateActionButtons(status);
  }
}

function updateStatusBadge(status) {
  const badge = document.getElementById('sv-status-badge');
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge badge-status ${status}`;
}

function updateActionButtons(status) {
  const canStart   = status === 'stopped' || status === 'crashed';
  const canStop    = status === 'running' || status === 'starting';
  const canRestart = status === 'running' || status === 'starting';
  const canKill    = status === 'running' || status === 'starting' || status === 'stopping';

  document.getElementById('btn-start').disabled   = !canStart;
  document.getElementById('btn-stop').disabled    = !canStop;
  document.getElementById('btn-restart').disabled = !canRestart;
  document.getElementById('btn-kill').disabled    = !canKill;
}

// ============================================================
// SERVER SELECTION
// ============================================================

function selectServer(id) {
  const server = state.servers.find(s => s.id === id);
  if (!server) return;

  state.selectedId = id;
  state.currentDir = '';

  document.querySelectorAll('.server-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('server-view').classList.remove('hidden');

  document.getElementById('sv-name').textContent = server.name;
  const typeBadge = document.getElementById('sv-type-badge');
  typeBadge.textContent = server.type;
  typeBadge.style.color = typeColor(server.type);
  const verStr = server.version && server.version !== 'unknown' ? `v${server.version}` : '';
  document.getElementById('sv-version').textContent = verStr;

  updateStatusBadge(server.status || 'stopped');
  updateActionButtons(server.status || 'stopped');

  connectConsole(id);
  switchTab('console');
}

// ============================================================
// SERVER ACTIONS
// ============================================================

async function startServer() {
  if (!state.selectedId) return;
  try {
    await api('POST', `/api/servers/${state.selectedId}/start`);
  } catch (err) { toast(err.message, 'error'); }
}

async function stopServer() {
  if (!state.selectedId) return;
  try {
    await api('POST', `/api/servers/${state.selectedId}/stop`);
  } catch (err) { toast(err.message, 'error'); }
}

async function killServer() {
  if (!state.selectedId) return;
  if (!confirm('Force kill the server process?\n\nThis may cause world data corruption.')) return;
  try {
    await api('POST', `/api/servers/${state.selectedId}/kill`);
  } catch (err) { toast(err.message, 'error'); }
}

async function restartServer() {
  if (!state.selectedId) return;
  try {
    await api('POST', `/api/servers/${state.selectedId}/restart`);
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
// CONSOLE
// ============================================================

function connectConsole(serverId) {
  disconnectConsole();
  document.getElementById('console-output').innerHTML = '';

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws    = new WebSocket(`${proto}//${location.host}/ws/console/${serverId}`);

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'console') appendConsoleLine(data.line);
    } catch (_) {
      appendConsoleLine(String(e.data));
    }
  };

  ws.onclose = () => {
    if (state.selectedId === serverId) {
      appendConsoleLine('[MSM] Console disconnected.');
    }
  };

  state.consoleWs = ws;
}

function disconnectConsole() {
  if (state.consoleWs) {
    state.consoleWs.onclose = null;
    state.consoleWs.close();
    state.consoleWs = null;
  }
}

function appendConsoleLine(line) {
  const output = document.getElementById('console-output');
  if (!output) return;

  const clean    = stripAnsi(String(line));
  const atBottom = output.scrollHeight - output.scrollTop <= output.clientHeight + 80;

  const el = document.createElement('div');
  el.className = 'console-line' + (clean.startsWith('[MSM]') ? ' msm' : '');
  el.textContent = clean;
  output.appendChild(el);

  while (output.children.length > 2000) {
    output.removeChild(output.firstChild);
  }

  if (atBottom) output.scrollTop = output.scrollHeight;
}

function sendCommand() {
  const input = document.getElementById('console-input');
  const cmd   = input.value.trim();
  if (!cmd) return;
  if (!state.consoleWs || state.consoleWs.readyState !== WebSocket.OPEN) {
    toast('Console is not connected', 'warning');
    return;
  }
  state.consoleWs.send(cmd);
  input.value = '';
}

// ============================================================
// PROPERTIES
// ============================================================

const COMMON_PROPS = [
  { key: 'server-port',  label: 'Port',        type: 'number' },
  { key: 'max-players',  label: 'Max Players',  type: 'number' },
  { key: 'gamemode',     label: 'Gamemode',     type: 'select', options: ['survival','creative','adventure','spectator'] },
  { key: 'difficulty',   label: 'Difficulty',   type: 'select', options: ['peaceful','easy','normal','hard'] },
  { key: 'online-mode',  label: 'Online Mode',  type: 'checkbox' },
  { key: 'pvp',          label: 'PvP',          type: 'checkbox' },
  { key: 'white-list',   label: 'Whitelist',    type: 'checkbox' },
  { key: 'motd',         label: 'MOTD',         type: 'text' },
  { key: 'level-name',   label: 'World Name',   type: 'text' },
];
const COMMON_KEYS = new Set(COMMON_PROPS.map(p => p.key));

async function loadProperties() {
  if (!state.selectedId) return;
  const commonDiv = document.getElementById('props-common');
  const allDiv    = document.getElementById('props-all');
  commonDiv.innerHTML = '<span style="color:var(--text-dim);font-size:12px;">Loading...</span>';
  allDiv.innerHTML = '';

  try {
    const data = await api('GET', `/api/servers/${state.selectedId}/properties`);
    renderProperties(data.properties || {});
  } catch (err) {
    commonDiv.innerHTML = `<span style="color:var(--danger);font-size:12px;">Failed to load: ${err.message}</span>`;
  }
}

function makeFieldEl(key, val, type, options) {
  const wrapper = document.createElement('div');

  if (type === 'checkbox') {
    wrapper.className = 'prop-field checkbox-field';
    const cb  = document.createElement('input');
    cb.type   = 'checkbox';
    cb.id     = `prop-${key}`;
    cb.checked = val === 'true';
    const lbl = document.createElement('label');
    lbl.htmlFor     = `prop-${key}`;
    lbl.textContent = COMMON_PROPS.find(p => p.key === key)?.label || key;
    wrapper.appendChild(cb);
    wrapper.appendChild(lbl);
  } else if (type === 'select' && options) {
    wrapper.className = 'prop-field';
    const lbl = document.createElement('label');
    lbl.htmlFor = `prop-${key}`;
    lbl.textContent = COMMON_PROPS.find(p => p.key === key)?.label || key;
    const sel = document.createElement('select');
    sel.id = `prop-${key}`;
    for (const opt of options) {
      const o   = document.createElement('option');
      o.value   = opt;
      o.textContent = opt;
      if (opt === val) o.selected = true;
      sel.appendChild(o);
    }
    wrapper.appendChild(lbl);
    wrapper.appendChild(sel);
  } else {
    wrapper.className = 'prop-field';
    const lbl = document.createElement('label');
    lbl.htmlFor = `prop-${key}`;
    lbl.textContent = COMMON_PROPS.find(p => p.key === key)?.label || key;
    const inp = document.createElement('input');
    inp.type  = type === 'number' ? 'number' : 'text';
    inp.id    = `prop-${key}`;
    inp.value = val;
    wrapper.appendChild(lbl);
    wrapper.appendChild(inp);
  }

  return wrapper;
}

function renderProperties(props) {
  const commonDiv = document.getElementById('props-common');
  const allDiv    = document.getElementById('props-all');
  commonDiv.innerHTML = '';
  allDiv.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'props-grid';
  for (const def of COMMON_PROPS) {
    const val = props[def.key] !== undefined ? String(props[def.key]) : '';
    grid.appendChild(makeFieldEl(def.key, val, def.type, def.options));
  }
  commonDiv.appendChild(grid);

  const restGrid = document.createElement('div');
  restGrid.className = 'props-grid';
  restGrid.style.marginTop = '10px';

  for (const [key, val] of Object.entries(props)) {
    if (COMMON_KEYS.has(key)) continue;
    restGrid.appendChild(makeFieldEl(key, String(val), 'text', null));
  }
  allDiv.appendChild(restGrid);

  window._currentProps = props;
}

async function saveProperties() {
  if (!state.selectedId || !window._currentProps) return;

  const merged = { ...window._currentProps };

  document.querySelectorAll('[id^="prop-"]').forEach(el => {
    const key = el.id.slice(5);
    merged[key] = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
  });

  try {
    await api('PUT', `/api/servers/${state.selectedId}/properties`, { properties: merged });
    window._currentProps = merged;
    toast('Properties saved. Restart the server to apply changes.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================
// FILES
// ============================================================

async function loadFiles(dir) {
  if (!state.selectedId) return;
  state.currentDir = dir !== undefined ? dir : '';

  const container = document.getElementById('files-list');
  container.innerHTML = '<span style="color:var(--text-dim);font-size:12px;">Loading...</span>';

  try {
    const data = await api('GET', `/api/servers/${state.selectedId}/files?dir=${encodeURIComponent(state.currentDir)}`);
    renderFiles(data);
  } catch (err) {
    container.innerHTML = `<span style="color:var(--danger);font-size:12px;">${err.message}</span>`;
  }
}

function renderFiles(data) {
  const container = document.getElementById('files-list');
  const crumb     = document.getElementById('files-breadcrumb');
  container.innerHTML = '';
  crumb.innerHTML = '';

  const rootPart = document.createElement('span');
  rootPart.className = 'breadcrumb-part';
  rootPart.textContent = 'root';
  rootPart.onclick = () => loadFiles('');
  crumb.appendChild(rootPart);

  const currentDir = data.currentDir || '';
  if (currentDir) {
    const segments = currentDir.split('/').filter(Boolean);
    let built = '';
    for (const seg of segments) {
      built = built ? `${built}/${seg}` : seg;
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = ' / ';
      crumb.appendChild(sep);

      const part = document.createElement('span');
      part.className = 'breadcrumb-part';
      part.textContent = seg;
      const captured = built;
      part.onclick = () => loadFiles(captured);
      crumb.appendChild(part);
    }

    const parentSegments = segments.slice(0, -1);
    const parentDir = parentSegments.join('/');
    const backRow   = document.createElement('div');
    backRow.className = 'file-row';
    backRow.innerHTML = '<span class="file-icon">\u2191</span><span class="file-name" style="color:var(--text-dim)">.. (up)</span>';
    backRow.onclick = () => loadFiles(parentDir);
    container.appendChild(backRow);
  }

  for (const f of (data.files || [])) {
    const row  = document.createElement('div');
    row.className = 'file-row';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = fileIcon(f.name, f.isDirectory);

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.name;

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = f.isDirectory ? '' : formatBytes(f.size);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(size);

    if (f.isDirectory) {
      row.style.cursor = 'pointer';
      row.onclick = () => loadFiles(f.relativePath);
    } else {
      row.style.cursor = 'default';
    }

    container.appendChild(row);
  }

  if (!data.files || data.files.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">Empty directory.</span>';
  }
}

// ============================================================
// SETTINGS
// ============================================================

async function loadSettings() {
  if (!state.selectedId) return;
  const server = state.servers.find(s => s.id === state.selectedId);
  if (!server) return;

  document.getElementById('set-name').value     = server.name;
  document.getElementById('set-path').value     = server.serverPath;
  document.getElementById('set-type').value     = server.type || 'unknown';
  document.getElementById('set-version').value  = server.version !== 'unknown' ? server.version : '';
  document.getElementById('set-jar').value      = server.jarFile || '';
  document.getElementById('set-script').value   = server.startupScript || '';
  document.getElementById('set-java').value     = server.javaPath || 'java';
  document.getElementById('set-min-ram').value  = server.minRam || 512;
  document.getElementById('set-max-ram').value  = server.maxRam || 1024;
  document.getElementById('set-jvm-args').value = server.javaArgs || '';

  refreshJarList();
  refreshScriptList();
}

async function refreshJarList() {
  const server = state.servers.find(s => s.id === state.selectedId);
  if (!server) return;

  const picker = document.getElementById('set-jar-picker');
  picker.innerHTML = '<option style="color:var(--text-muted)">Loading...</option>';

  try {
    const data = await api('POST', '/api/list-jars', { serverPath: server.serverPath });
    picker.innerHTML = '';
    if (data.jars.length === 0) {
      picker.innerHTML = '<option style="color:var(--text-muted)">No .jar files found</option>';
      return;
    }
    for (const jar of data.jars) {
      const opt     = document.createElement('option');
      opt.value     = jar;
      opt.textContent = jar;
      if (jar === server.jarFile) opt.selected = true;
      picker.appendChild(opt);
    }
    picker.onchange = () => {
      document.getElementById('set-jar').value = picker.value;
    };
  } catch (_) {
    picker.innerHTML = '<option style="color:var(--danger)">Failed to list jars</option>';
  }
}

async function refreshScriptList() {
  const server = state.servers.find(s => s.id === state.selectedId);
  if (!server) return;

  const picker = document.getElementById('set-script-picker');
  picker.innerHTML = '<option style="color:var(--text-muted)">Loading...</option>';

  try {
    const data = await api('POST', '/api/list-scripts', { serverPath: server.serverPath });
    picker.innerHTML = '';

    // Always show a (none) option first so the user can clear the script
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none - use jar file)';
    if (!server.startupScript) noneOpt.selected = true;
    picker.appendChild(noneOpt);

    if (data.scripts.length === 0) {
      const emptyOpt = document.createElement('option');
      emptyOpt.disabled = true;
      emptyOpt.textContent = 'No script files found in this folder';
      picker.appendChild(emptyOpt);
    } else {
      for (const script of data.scripts) {
        const opt     = document.createElement('option');
        opt.value     = script;
        opt.textContent = script;
        if (script === server.startupScript) opt.selected = true;
        picker.appendChild(opt);
      }
    }

    picker.onchange = () => {
      document.getElementById('set-script').value = picker.value;
    };
  } catch (_) {
    picker.innerHTML = '<option style="color:var(--danger)">Failed to list scripts</option>';
  }
}

async function saveSettings() {
  if (!state.selectedId) return;

  const name          = document.getElementById('set-name').value.trim();
  const jarFile       = document.getElementById('set-jar').value.trim();
  const startupScript = document.getElementById('set-script').value.trim() || null;

  if (!name) { toast('Display name cannot be empty', 'error'); return; }

  const updates = {
    name,
    type:          document.getElementById('set-type').value,
    version:       document.getElementById('set-version').value.trim() || 'unknown',
    jarFile:       jarFile || null,
    startupScript: startupScript,
    javaPath:      document.getElementById('set-java').value.trim() || 'java',
    minRam:        parseInt(document.getElementById('set-min-ram').value, 10) || 512,
    maxRam:        parseInt(document.getElementById('set-max-ram').value, 10) || 1024,
    javaArgs:      document.getElementById('set-jvm-args').value.trim(),
  };

  try {
    const data = await api('PUT', `/api/servers/${state.selectedId}`, updates);
    const idx  = state.servers.findIndex(s => s.id === state.selectedId);
    if (idx !== -1) state.servers[idx] = { ...state.servers[idx], ...data.server };
    renderServerList();
    document.getElementById('sv-name').textContent = name;
    document.getElementById('sv-type-badge').textContent = updates.type;
    document.getElementById('sv-type-badge').style.color = typeColor(updates.type);
    toast('Settings saved!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeServer() {
  if (!state.selectedId) return;
  const server = state.servers.find(s => s.id === state.selectedId);
  if (!confirm(`Remove "${server ? server.name : 'this server'}" from the manager?\n\nYour server files will NOT be deleted.`)) return;

  try {
    await api('DELETE', `/api/servers/${state.selectedId}`);
    state.servers    = state.servers.filter(s => s.id !== state.selectedId);
    state.selectedId = null;
    disconnectConsole();
    renderServerList();
    document.getElementById('server-view').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    toast('Server removed from manager', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================
// TABS
// ============================================================

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.remove('hidden');

  if (name === 'properties') loadProperties();
  if (name === 'files')      loadFiles(state.currentDir);
  if (name === 'settings')   loadSettings();
}

// ============================================================
// ADD SERVER MODAL
// ============================================================

function showAddModal() {
  document.getElementById('at-path').value = '';
  document.getElementById('at-name').value = '';
  document.getElementById('at-script-detected').value = '';
  document.getElementById('detect-result').classList.add('hidden');
  document.getElementById('dr-warning').classList.add('hidden');
  document.getElementById('btn-attach-confirm').disabled = false;
  document.getElementById('btn-attach-confirm').textContent = 'Add Server';
  switchModalTab('attach');
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (state.versions.length === 0) loadVersions(false);
}

function hideAddModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('create-progress').classList.add('hidden');
  document.getElementById('create-error').classList.add('hidden');
  document.getElementById('btn-create-confirm').disabled = false;
  document.getElementById('btn-create-confirm').textContent = 'Create Server';
  state.createTempId = null;
}

function modalOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) hideAddModal();
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mtab === tab);
  });
  document.getElementById('mtab-attach').classList.toggle('hidden', tab !== 'attach');
  document.getElementById('mtab-create').classList.toggle('hidden', tab !== 'create');
}

async function detectServer() {
  const serverPath = document.getElementById('at-path').value.trim();
  if (!serverPath) { toast('Enter a server path first', 'warning'); return; }

  const btn    = document.getElementById('btn-detect');
  btn.disabled = true;
  btn.textContent = 'Detecting...';

  try {
    const result   = await api('POST', '/api/detect', { serverPath });
    const resultEl = document.getElementById('detect-result');

    document.getElementById('dr-type').textContent    = result.type || '-';
    document.getElementById('dr-type').style.color    = typeColor(result.type);
    document.getElementById('dr-version').textContent = result.version || '-';
    document.getElementById('dr-jar').textContent     = result.jarFile    || '(none found)';
    document.getElementById('dr-script').textContent  = result.scriptFile || '(none found)';
    document.getElementById('dr-eula').textContent    = result.eulaAccepted ? 'Accepted' : 'Not accepted';
    document.getElementById('dr-eula').style.color    = result.eulaAccepted ? 'var(--accent)' : 'var(--warning)';

    // Store detected script so attachServer() can pass it along
    document.getElementById('at-script-detected').value = result.scriptFile || '';

    const warnEl = document.getElementById('dr-warning');
    if (!result.valid) {
      warnEl.textContent = result.error || 'Detection failed';
      warnEl.classList.remove('hidden');
    } else if (result.warning) {
      warnEl.textContent = result.warning;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    const nameInput = document.getElementById('at-name');
    if (!nameInput.value.trim()) {
      const parts = serverPath.replace(/\\/g, '/').split('/').filter(Boolean);
      nameInput.value = parts[parts.length - 1] || '';
    }

    resultEl.classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect';
  }
}

async function attachServer() {
  const serverPath    = document.getElementById('at-path').value.trim();
  const name          = document.getElementById('at-name').value.trim();
  const minRam        = parseInt(document.getElementById('at-min-ram').value, 10) || 512;
  const maxRam        = parseInt(document.getElementById('at-max-ram').value, 10) || 1024;
  const javaPath      = document.getElementById('at-java').value.trim() || 'java';
  const startupScript = document.getElementById('at-script-detected').value || null;

  if (!serverPath) { toast('Enter a server folder path', 'warning'); return; }
  if (!name)       { toast('Enter a display name', 'warning'); return; }

  const btn    = document.getElementById('btn-attach-confirm');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    const data = await api('POST', '/api/servers', {
      name, serverPath, minRam, maxRam, javaPath, startupScript
    });
    state.servers.push({ ...data.server, status: 'stopped' });
    renderServerList();
    hideAddModal();
    selectServer(data.server.id);
    toast('Server added!', 'success');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Add Server';
  }
}

// ============================================================
// CREATE SERVER
// ============================================================

async function loadVersions(includeSnapshots) {
  const sel    = document.getElementById('cr-version');
  sel.innerHTML = '<option>Loading...</option>';
  try {
    const data   = await api('GET', `/api/minecraft/versions?snapshots=${includeSnapshots}`);
    state.versions = data.versions;
    sel.innerHTML  = '';
    for (const v of data.versions) {
      const opt     = document.createElement('option');
      opt.value     = v.id;
      opt.textContent = v.id + (v.type !== 'release' ? ` (${v.type})` : '');
      sel.appendChild(opt);
    }
  } catch (err) {
    sel.innerHTML = '<option>Failed to load</option>';
    toast('Could not fetch version list from Mojang', 'error');
  }
}

async function createServer() {
  const name        = document.getElementById('cr-name').value.trim();
  const serverPath  = document.getElementById('cr-path').value.trim();
  const version     = document.getElementById('cr-version').value;
  const minRam      = parseInt(document.getElementById('cr-min-ram').value, 10) || 512;
  const maxRam      = parseInt(document.getElementById('cr-max-ram').value, 10) || 1024;
  const acceptEula  = document.getElementById('cr-eula').checked;

  if (!name)                                    { toast('Enter a server name', 'warning'); return; }
  if (!serverPath)                              { toast('Enter an install path', 'warning'); return; }
  if (!version || version === 'Loading...')     { toast('Select a Minecraft version', 'warning'); return; }
  if (!acceptEula)                              { toast('You must accept the Minecraft EULA to continue', 'warning'); return; }

  const btn    = document.getElementById('btn-create-confirm');
  btn.disabled = true;
  btn.textContent = 'Creating...';
  document.getElementById('create-error').classList.add('hidden');
  document.getElementById('create-progress').classList.remove('hidden');
  setCreateProgress('Starting...', 0);

  try {
    const data       = await api('POST', '/api/minecraft/create', { name, serverPath, version, minRam, maxRam, acceptEula });
    state.createTempId = data.tempId;
  } catch (err) {
    showCreateError(err.message);
  }
}

function setCreateProgress(message, progress) {
  const fill = document.getElementById('progress-bar-fill');
  const msg  = document.getElementById('progress-message');
  if (fill) fill.style.width = `${progress}%`;
  if (msg)  msg.textContent  = message;
}

function showCreateError(message) {
  document.getElementById('create-progress').classList.add('hidden');
  const errEl = document.getElementById('create-error');
  errEl.textContent = `Error: ${message}`;
  errEl.classList.remove('hidden');
  document.getElementById('btn-create-confirm').disabled = false;
  document.getElementById('btn-create-confirm').textContent = 'Create Server';
  state.createTempId = null;
}

// ============================================================
// PLAYIT.GG
// ============================================================

function renderPlayitWidget() {
  const { status, tunnels, claimUrl } = state.playit;

  const dot = document.getElementById('playit-status-dot');
  if (dot) dot.className = `status-dot ${status}`;

  const tunnelDiv = document.getElementById('playit-tunnels');
  if (tunnelDiv) {
    tunnelDiv.innerHTML = (tunnels && tunnels.length > 0)
      ? tunnels.map(t => `<div>${t}</div>`).join('')
      : '';
  }

  const claimDiv = document.getElementById('playit-claim-url');
  if (claimDiv) {
    claimDiv.innerHTML = claimUrl
      ? `<a href="${claimUrl}" target="_blank" title="Claim your playit.gg tunnel">Claim tunnel &#8599;</a>`
      : '';
  }

  const btn = document.getElementById('btn-playit-toggle');
  if (btn) {
    if (status === 'stopped' || status === 'error') {
      btn.textContent = 'Start';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-playit');
    } else {
      btn.textContent = 'Stop';
      btn.classList.remove('btn-playit');
      btn.classList.add('btn-danger');
    }
  }
}

async function togglePlayit() {
  const { status } = state.playit;
  if (status === 'stopped' || status === 'error') {
    showPlayitModal();
  } else {
    try {
      await api('POST', '/api/playit/stop');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

function showPlayitModal() {
  document.getElementById('pl-path').value   = state.playitConfig.path;
  document.getElementById('pl-secret').value = state.playitConfig.secret;
  document.getElementById('modal-playit-overlay').classList.remove('hidden');
}

function hidePlayitModal() {
  document.getElementById('modal-playit-overlay').classList.add('hidden');
}

function playitModalOverlayClick(e) {
  if (e.target === document.getElementById('modal-playit-overlay')) hidePlayitModal();
}

async function savePlayitConfig() {
  const playitPath = document.getElementById('pl-path').value.trim() || 'playit';
  const secretKey  = document.getElementById('pl-secret').value.trim();
  state.playitConfig = { path: playitPath, secret: secretKey };
  hidePlayitModal();
  try {
    await api('POST', '/api/playit/start', { playitPath, secretKey });
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================
// EVENT BINDING
// ============================================================

function bindEvents() {
  // Sidebar
  document.getElementById('btn-add-server').addEventListener('click', showAddModal);
  document.getElementById('btn-playit-toggle').addEventListener('click', togglePlayit);
  document.getElementById('btn-playit-config').addEventListener('click', showPlayitModal);

  // Server controls
  document.getElementById('btn-start').addEventListener('click',   startServer);
  document.getElementById('btn-stop').addEventListener('click',    stopServer);
  document.getElementById('btn-restart').addEventListener('click', restartServer);
  document.getElementById('btn-kill').addEventListener('click',    killServer);

  // Console
  document.getElementById('btn-send').addEventListener('click', sendCommand);
  document.getElementById('console-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCommand();
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Properties
  document.getElementById('btn-save-props').addEventListener('click', saveProperties);

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-remove-server').addEventListener('click', removeServer);
  document.getElementById('btn-refresh-jars').addEventListener('click', refreshJarList);
  document.getElementById('btn-refresh-scripts').addEventListener('click', refreshScriptList);

  // Modal tabs
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => switchModalTab(btn.dataset.mtab));
  });

  // Attach flow
  document.getElementById('btn-detect').addEventListener('click', detectServer);
  document.getElementById('btn-attach-confirm').addEventListener('click', attachServer);

  // Create flow
  document.getElementById('btn-create-confirm').addEventListener('click', createServer);
  document.getElementById('cr-snapshots').addEventListener('change', function () {
    loadVersions(this.checked);
  });
}

// ============================================================
// INIT
// ============================================================

async function init() {
  bindEvents();
  connectNotifications();
  await loadServers();
}

window.addEventListener('DOMContentLoaded', init);
