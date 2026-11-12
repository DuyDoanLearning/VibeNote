// VibeNote — main process: windows, menus, and all file-system access.
//
// Storage layout (everything stays plain files, so the folder can be synced later):
//   <root>/Note.md                 note in Inbox
//   <root>/Work/Clients/Note.md    note in nested notebook "Work/Clients"
//   <dir>/.assets/image-….png      pasted images, linked relatively from notes in <dir>
//   <root>/.trash/*.md             VibeNote trash (+ index.json remembering where notes came from)
// Note metadata (tags, status, pinned) lives in YAML front matter at the top of each file.
// Revision history is local-only, in <userData>/history/<file inode>/<timestamp>.md.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const isMac = process.platform === 'darwin';
const TRASH = '.trash';
const ASSETS = '.assets';
const STATUSES = ['active', 'onhold', 'completed', 'dropped'];
const DEFAULT_SETTINGS = {
  theme: 'system',
  editorFont: 'mono',
  fontSize: 15,
  lineWidth: 'medium',
  lineNumbers: false,
  vim: false,
  spellcheck: false,
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const config = { root: path.join(os.homedir(), 'Documents', 'VibeNotes'), settings: { ...DEFAULT_SETTINGS } };

let watcher = null;
let changeTimer = null;
let quitting = false;

// ---------- config ----------
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (c.root) config.root = c.root;
    config.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  } catch {}
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ---------- paths ----------
const rootDir = () => path.resolve(config.root);
const trashDir = () => path.join(rootDir(), TRASH);
const samePath = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

function inRoot(p) {
  const root = rootDir();
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside the notes folder');
  return full;
}

function notebookDir(rel) {
  if (!rel) return rootDir();
  const parts = rel.split('/');
  if (parts.some((s) => !s.trim() || s.startsWith('.') || s.includes('\\'))) throw new Error('Invalid notebook name');
  return inRoot(path.join(...parts));
}

function titleOf(body, fallback) {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#{1,6}\s+/, '').trim();
    if (t) return t;
  }
  return fallback;
}

function safeName(title) {
  const s = String(title)
    .replace(/[\/\\:*?"<>|#\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^\.+/, '')
    .trim();
  return s || 'Untitled';
}

// First free "<base>.md", "<base> 2.md", … in dir. `current` counts as free (it's the file being renamed).
function uniquePath(dir, base, current) {
  for (let i = 1; ; i++) {
    const p = path.join(dir, (i === 1 ? base : `${base} ${i}`) + '.md');
    if ((current && samePath(p, current)) || !fs.existsSync(p)) return p;
  }
}

// ---------- front matter ----------
function parseScalar(v) {
  v = String(v).trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch {} }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseNote(text) {
  const meta = { tags: [], status: '', pinned: false, created: '', extra: '' };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta, body: text };
  const lines = m[1].split(/\r?\n/);
  const extra = [];
  const isContinuation = (l) => /^(\s+|-\s)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) { extra.push(lines[i]); continue; }
    const [, key, raw] = kv;
    const val = raw.trim();
    if (key === 'tags') {
      if (val.startsWith('[')) meta.tags = val.replace(/^\[|\]$/g, '').split(',').map(parseScalar);
      else if (val) meta.tags = val.split(',').map(parseScalar);
      else while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) meta.tags.push(parseScalar(lines[++i].replace(/^\s*-\s+/, '')));
    } else if (key === 'status') {
      meta.status = parseScalar(val).toLowerCase().replace(/[\s_-]/g, '');
    } else if (key === 'pinned') {
      meta.pinned = /^(true|yes)$/i.test(val);
    } else if (key === 'created') {
      meta.created = parseScalar(val);
    } else {
      extra.push(lines[i]);
      while (i + 1 < lines.length && isContinuation(lines[i + 1])) extra.push(lines[++i]);
    }
  }
  if (!STATUSES.includes(meta.status)) meta.status = '';
  meta.tags = [...new Set(meta.tags.map((t) => String(t).trim()).filter(Boolean))];
  meta.extra = extra.join('\n').trim();
  return { meta, body: text.slice(m[0].length) };
}

const yamlStr = (s) => (/^[\p{L}\p{N}_][\p{L}\p{N}_ .\/-]*$/u.test(s) && !/^(true|false|yes|no|null|~)$/i.test(s) ? s : JSON.stringify(s));

function serializeNote(meta = {}, body = '') {
  const lines = [];
  const tags = (meta.tags || []).filter(Boolean);
  if (tags.length) lines.push(`tags: [${tags.map(yamlStr).join(', ')}]`);
  if (STATUSES.includes(meta.status)) lines.push(`status: ${meta.status}`);
  if (meta.pinned) lines.push('pinned: true');
  if (meta.created) lines.push(`created: ${yamlStr(meta.created)}`);
  if (meta.extra) lines.push(meta.extra);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

// ---------- vault ----------
async function readNote(file, notebook, extra = {}) {
  const [text, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
  const { meta, body } = parseNote(text);
  const name = path.basename(file, '.md');
  const created = (meta.created && Date.parse(meta.created)) || st.birthtimeMs;
  return {
    id: `${st.dev}-${st.ino}`,
    path: file,
    notebook,
    name,
    title: titleOf(body, name),
    body,
    meta,
    mtime: st.mtimeMs,
    ctime: created,
    ...extra,
  };
}

async function mdFiles(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

async function walk(dir, rel, notebooks, files) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      notebooks.push(r);
      await walk(full, r, notebooks, files);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      files.push([full, rel]);
    }
  }
}

async function listVault() {
  const root = rootDir();
  await fsp.mkdir(root, { recursive: true });
  const notebooks = [];
  const files = [];
  await walk(root, '', notebooks, files);
  const jobs = files.map(([f, nb]) => readNote(f, nb));
  const index = await readTrashIndex();
  try {
    for (const f of await mdFiles(trashDir())) {
      const info = index[path.basename(f)] || {};
      jobs.push(readNote(f, info.from || '', { trashed: true, deletedAt: info.deletedAt || 0 }));
    }
  } catch {}
  const notes = (await Promise.allSettled(jobs)).filter((r) => r.status === 'fulfilled').map((r) => r.value);
  notebooks.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { root, notebooks, notes };
}

// Move a note file into destDir, bringing along any ".assets/…" files it links to.
async function moveNoteFile(file, destDir, base = path.basename(file, '.md')) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = uniquePath(destDir, base);
  await fsp.rename(file, dest);
  const srcDir = path.dirname(file);
  if (!samePath(srcDir, destDir)) {
    const text = await fsp.readFile(dest, 'utf8');
    for (const m of text.matchAll(/\]\(<?(\.assets\/[^)\s>]+)>?\)/g)) {
      let rel;
      try { rel = decodeURI(m[1]); } catch { rel = m[1]; }
      const from = path.join(srcDir, rel);
      const to = path.join(destDir, rel);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to).catch(() => {});
      }
    }
  }
  return dest;
}

// ---------- trash ----------
let trashLock = Promise.resolve();
const withTrashIndex = (fn) => (trashLock = trashLock.then(async () => {
  const ix = await readTrashIndex();
  const out = await fn(ix);
  await fsp.mkdir(trashDir(), { recursive: true });
  await fsp.writeFile(path.join(trashDir(), 'index.json'), JSON.stringify(ix, null, 2));
  return out;
}));
async function readTrashIndex() {
  try { return JSON.parse(await fsp.readFile(path.join(trashDir(), 'index.json'), 'utf8')); } catch { return {}; }
}

// ---------- history ----------
const histRoot = () => path.join(app.getPath('userData'), 'history');
async function histDir(file) {
  const st = await fsp.stat(file);
  return path.join(histRoot(), `${st.dev}-${st.ino}`);
}
async function snapshot(file, force) {
  const text = await fsp.readFile(file, 'utf8');
  if (!text.trim()) return;
  const dir = await histDir(file);
  await fsp.mkdir(dir, { recursive: true });
  const list = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const last = list[list.length - 1];
  if (last) {
    if (!force && Date.now() - Number(last.slice(0, -3)) < 5 * 60e3) return;
    if ((await fsp.readFile(path.join(dir, last), 'utf8')) === text) return;
  }
  await fsp.writeFile(path.join(dir, `${Date.now()}.md`), text);
  for (const old of list.slice(0, Math.max(0, list.length + 1 - 100))) await fsp.unlink(path.join(dir, old)).catch(() => {});
}

// ---------- export ----------
const EXPORT_VARS = `:root{--bg:#fff;--panel:#f6f6f9;--border:#e6e5ec;--text:#1f2028;--muted:#6b6d7c;--faint:#a4a6b4;
--accent:#6d4aff;--accent-soft:rgba(109,74,255,.1);--code:#c2410c;--code-bg:#f3f2f7;--hover:rgba(0,0,0,.045);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",sans-serif;--mono:"SF Mono",ui-monospace,Menlo,monospace;--line-width:780px}
body{margin:0;padding:40px 24px;background:#fff}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function exportDoc(title, html, forPdf) {
  const md = fs.readFileSync(path.join(__dirname, 'markdown.css'), 'utf8');
  let katex = '';
  if (html.includes('class="katex')) {
    const dir = path.join(__dirname, 'dist', 'katex');
    const ver = fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim();
    const fontBase = forPdf ? pathToFileURL(path.join(dir, 'fonts')).href + '/' : `https://cdn.jsdelivr.net/npm/katex@${ver}/dist/fonts/`;
    katex = fs.readFileSync(path.join(dir, 'katex.min.css'), 'utf8').replace(/url\(fonts\//g, `url(${fontBase}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${EXPORT_VARS}\n${md}\n${katex}</style></head>
<body><article class="markdown">${html}</article></body></html>`;
}

// ---------- watcher ----------
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}
function watchRoot() {
  if (watcher) watcher.close();
  watcher = null;
  try {
    watcher = fs.watch(config.root, { recursive: true }, () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => broadcast('vault:changed'), 250);
    });
  } catch (e) {
    console.error('watch failed', e);
  }
}

// ---------- IPC ----------
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.handle('vault:list', () => listVault());

ipcMain.handle('vault:choose', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), {
    title: 'Choose notes folder',
    defaultPath: config.root,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  config.root = r.filePaths[0];
  saveConfig();
  watchRoot();
  broadcast('vault:changed');
  return config.root;
});

ipcMain.handle('note:read', async (_e, p) => parseNote(await fsp.readFile(inRoot(p), 'utf8')));

// Write, then rename the file to match the note's title. Returns the (possibly new) path.
ipcMain.handle('note:save', async (_e, p, meta, body, forceSnapshot) => {
  let file = inRoot(p);
  if (file.startsWith(trashDir() + path.sep)) throw new Error('Notes in the Trash are read-only');
  await fsp.writeFile(file, serializeNote(meta, body), 'utf8');
  const desired = uniquePath(path.dirname(file), safeName(titleOf(body, 'Untitled')), file);
  if (desired !== file) {
    await fsp.rename(file, desired);
    file = desired;
  }
  snapshot(file, forceSnapshot).catch(() => {});
  return file;
});

ipcMain.handle('note:snapshot', (_e, p) => snapshot(inRoot(p), true).catch(() => {}));

ipcMain.handle('note:create', async (_e, notebook, title) => {
  const dir = notebookDir(notebook);
  await fsp.mkdir(dir, { recursive: true });
  const file = uniquePath(dir, safeName(title || 'Untitled'));
  await fsp.writeFile(file, title ? `# ${title}\n\n` : '', { flag: 'wx' });
  return file;
});

ipcMain.handle('note:move', async (_e, p, notebook) => {
  const file = inRoot(p);
  const dir = notebookDir(notebook);
  if (samePath(path.dirname(file), dir)) return file;
  return moveNoteFile(file, dir);
});

ipcMain.handle('note:trash', async (_e, p) => {
  const file = inRoot(p);
  const from = path.relative(rootDir(), path.dirname(file)).split(path.sep).join('/');
  const dest = await moveNoteFile(file, trashDir());
  await withTrashIndex((ix) => {
    ix[path.basename(dest)] = { from, name: path.basename(file, '.md'), deletedAt: Date.now() };
  });
  return dest;
});

ipcMain.handle('note:restore', async (_e, p) => {
  const file = inRoot(p);
  return withTrashIndex(async (ix) => {
    const key = path.basename(file);
    const info = ix[key] || {};
    let dir;
    try { dir = notebookDir(info.from || ''); } catch { dir = rootDir(); }
    const dest = await moveNoteFile(file, dir, info.name || path.basename(file, '.md'));
    delete ix[key];
    return dest;
  });
});

// Permanently remove from VibeNote (goes to the macOS Trash, so still recoverable there).
ipcMain.handle('note:delete', async (_e, p) => {
  const file = inRoot(p);
  await shell.trashItem(file);
  if (path.dirname(file) === trashDir()) await withTrashIndex((ix) => { delete ix[path.basename(file)]; });
});

// Silently remove a note that was created but never written in (no Trash clutter).
ipcMain.handle('note:discard', async (_e, p) => {
  const file = inRoot(p);
  const { body } = parseNote(await fsp.readFile(file, 'utf8'));
  if (!body.trim()) await fsp.unlink(file);
});

ipcMain.handle('trash:empty', async () => {
  const files = await mdFiles(trashDir()).catch(() => []);
  for (const f of files) await shell.trashItem(f).catch(() => {});
  const assets = path.join(trashDir(), ASSETS);
  if (fs.existsSync(assets)) await shell.trashItem(assets).catch(() => {});
  await withTrashIndex((ix) => { for (const k of Object.keys(ix)) delete ix[k]; });
});

ipcMain.handle('note:reveal', (_e, p) => shell.showItemInFolder(inRoot(p)));

ipcMain.handle('note:attach', async (_e, p, name, mime, bytes) => {
  const file = inRoot(p);
  const extFromMime = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/heic': 'heic' };
  let ext = (path.extname(name || '').slice(1) || extFromMime[mime] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const fname = `image-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const dir = path.join(path.dirname(file), ASSETS);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, fname), Buffer.from(bytes));
  return `${ASSETS}/${fname}`;
});

ipcMain.handle('note:history', async (_e, p) => {
  try {
    const dir = await histDir(inRoot(p));
    const list = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse();
    return list.map((f) => ({ id: f, ts: Number(f.slice(0, -3)) }));
  } catch {
    return [];
  }
});

ipcMain.handle('note:history-read', async (_e, p, id) => {
  if (!/^\d+\.md$/.test(id)) throw new Error('Bad snapshot id');
  const dir = await histDir(inRoot(p));
  return parseNote(await fsp.readFile(path.join(dir, id), 'utf8'));
});

ipcMain.handle('note:export', async (e, { title, html, format }) => {
  const w = winOf(e);
  const ext = format === 'pdf' ? 'pdf' : 'html';
  const r = await dialog.showSaveDialog(w, {
    defaultPath: path.join(app.getPath('documents'), `${safeName(title)}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  if (format !== 'pdf') {
    await fsp.writeFile(r.filePath, exportDoc(title, html, false));
    return r.filePath;
  }
  const tmp = path.join(app.getPath('temp'), `vibenote-export-${Date.now()}.html`);
  await fsp.writeFile(tmp, exportDoc(title, html, true));
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pw.loadFile(tmp);
    const pdf = await pw.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fsp.writeFile(r.filePath, pdf);
    return r.filePath;
  } finally {
    pw.destroy();
    fsp.unlink(tmp).catch(() => {});
  }
});

ipcMain.handle('notebook:create', async (_e, parent, name) => {
  const rel = [parent, safeName(name)].filter(Boolean).join('/');
  await fsp.mkdir(notebookDir(rel), { recursive: true });
  return rel;
});

ipcMain.handle('notebook:rename', async (_e, rel, name) => {
  const from = notebookDir(rel);
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const newRel = [parent, safeName(name)].filter(Boolean).join('/');
  const to = notebookDir(newRel);
  if (fs.existsSync(to) && !samePath(from, to)) throw new Error(`A notebook named “${safeName(name)}” already exists`);
  await fsp.rename(from, to);
  return newRel;
});

ipcMain.handle('notebook:delete', async (_e, rel) => {
  if (!rel) throw new Error('Cannot delete the Inbox');
  await shell.trashItem(notebookDir(rel));
});

ipcMain.handle('window:open-note', (_e, p) => { createWindow(inRoot(p)); });

ipcMain.handle('settings:get', () => config.settings);
ipcMain.handle('settings:set', (_e, patch) => {
  config.settings = { ...config.settings, ...patch };
  saveConfig();
  nativeTheme.themeSource = config.settings.theme;
  broadcast('settings:changed', config.settings);
  return config.settings;
});

// Native context menu; resolves with the clicked item's id (or null).
ipcMain.handle('menu:popup', (e, items) => new Promise((resolve) => {
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
  const build = (list) => list.map((it) => it.type === 'separator'
    ? { type: 'separator' }
    : {
        label: it.label,
        enabled: it.enabled !== false,
        type: it.checked != null ? 'checkbox' : 'normal',
        checked: !!it.checked,
        accelerator: it.accelerator,
        registerAccelerator: false,
        submenu: it.submenu ? build(it.submenu) : undefined,
        click: it.submenu ? undefined : () => finish(it.id),
      });
  Menu.buildFromTemplate(build(items)).popup({
    window: winOf(e),
    callback: () => setTimeout(() => finish(null), 100),
  });
}));

ipcMain.on('app:flushed', (e) => {
  const w = winOf(e);
  if (w && w.flushDone) w.flushDone();
});

// ---------- windows & menu ----------
function createWindow(notePath) {
  const single = !!notePath;
  const w = new BrowserWindow({
    width: single ? 860 : 1280,
    height: single ? 780 : 820,
    minWidth: single ? 480 : 820,
    minHeight: 420,
    show: false,
    title: 'VibeNote',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  w.once('ready-to-show', () => w.show());
  w.loadFile(path.join(__dirname, 'index.html'), single ? { query: { note: notePath } } : undefined);

  const openExternal = (url) => /^(https?|mailto):/i.test(url) && shell.openExternal(url);
  w.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (ev, url) => { ev.preventDefault(); openExternal(url); });

  // Let the renderer flush unsaved edits before the window closes.
  w.on('close', (ev) => {
    if (w.allowClose) return;
    ev.preventDefault();
    if (w.closing) return;
    w.closing = true;
    w.flushDone = () => {
      if (w.allowClose) return;
      w.allowClose = true;
      if (quitting) app.quit();
      else if (!w.isDestroyed()) w.close();
    };
    setTimeout(() => w.flushDone && w.flushDone(), 1500);
    w.webContents.send('command', 'flush');
  });
  return w;
}

function buildMenu() {
  const send = (cmd) => () => {
    const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (w) w.webContents.send('command', cmd);
    else if (cmd === 'new-note') createWindow();
  };
  const item = (label, cmd, accelerator) => ({ label, accelerator, click: send(cmd) });
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        item('New Note', 'new-note', 'CmdOrCtrl+N'),
        item('New Notebook', 'new-notebook', 'CmdOrCtrl+Shift+N'),
        item('Open Note in New Window', 'open-window', 'CmdOrCtrl+Alt+O'),
        { type: 'separator' },
        item('Export as HTML…', 'export-html'),
        item('Export as PDF…', 'export-pdf', 'CmdOrCtrl+Shift+E'),
        item('Print…', 'print', 'CmdOrCtrl+P'),
        { type: 'separator' },
        item(isMac ? 'Reveal Note in Finder' : 'Show Note in Folder', 'reveal', 'CmdOrCtrl+Shift+R'),
        item('Move Note to Trash', 'trash'),
        { type: 'separator' },
        item('Change Notes Folder…', 'choose-folder'),
        ...(isMac ? [] : [item('Settings…', 'settings', 'Ctrl+,'), { type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Note',
      submenu: [
        item('Pin / Unpin', 'toggle-pin', 'CmdOrCtrl+Alt+P'),
        item('Add Tag…', 'edit-tags', 'CmdOrCtrl+Alt+T'),
        {
          label: 'Status',
          submenu: [
            item('Active', 'status-active', 'CmdOrCtrl+Alt+1'),
            item('On Hold', 'status-onhold', 'CmdOrCtrl+Alt+2'),
            item('Completed', 'status-completed', 'CmdOrCtrl+Alt+3'),
            item('Dropped', 'status-dropped', 'CmdOrCtrl+Alt+4'),
            { type: 'separator' },
            item('None', 'status-none', 'CmdOrCtrl+Alt+0'),
          ],
        },
        { type: 'separator' },
        item('Copy Link to Note', 'copy-link', 'CmdOrCtrl+Alt+L'),
        item('Version History…', 'history', 'CmdOrCtrl+Alt+Y'),
      ],
    },
    {
      label: 'Go',
      submenu: [
        item('Command Palette…', 'palette', 'CmdOrCtrl+K'),
        item('Search Notes', 'search', 'CmdOrCtrl+Shift+F'),
        { type: 'separator' },
        item('All Notes', 'go-all', 'CmdOrCtrl+Shift+A'),
        item('Inbox', 'go-inbox', 'CmdOrCtrl+Shift+I'),
        item('Trash', 'go-trash', 'CmdOrCtrl+Shift+T'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Editor Only', 'mode-edit', 'CmdOrCtrl+1'),
        item('Split View', 'mode-split', 'CmdOrCtrl+2'),
        item('Preview Only', 'mode-preview', 'CmdOrCtrl+3'),
        { type: 'separator' },
        item('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+\\'),
        item('Focus Mode', 'focus-mode', 'CmdOrCtrl+Shift+Enter'),
        {
          label: 'Sort Notes By',
          submenu: [
            item('Date Updated', 'sort-updated'),
            item('Date Created', 'sort-created'),
            item('Title', 'sort-title'),
          ],
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('VibeNote');
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(async () => {
  loadConfig();
  nativeTheme.themeSource = config.settings.theme;
  if (!fs.existsSync(rootDir())) {
    await fsp.mkdir(path.join(rootDir(), 'Ideas'), { recursive: true });
    await fsp.writeFile(path.join(rootDir(), 'Welcome to VibeNote.md'), fs.readFileSync(path.join(__dirname, 'welcome.md'), 'utf8'));
  }
  buildMenu();
  createWindow();
  watchRoot();
  app.on('activate', () => {
    quitting = false;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
