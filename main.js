// VibeNote — main process: window, menus, and all file-system access.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const isMac = process.platform === 'darwin';
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const config = { root: path.join(os.homedir(), 'Documents', 'VibeNotes') };

let win = null;
let watcher = null;
let changeTimer = null;
let allowClose = false;
let quitting = false;
let pendingClose = null;

// ---------- config ----------
function loadConfig() {
  try { Object.assign(config, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch {}
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ---------- path helpers ----------
const samePath = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

function inRoot(p) {
  const root = path.resolve(config.root);
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside the notes folder');
  return full;
}

function notebookDir(name) {
  if (!name) return path.resolve(config.root);
  if (/[\/\\]/.test(name) || name.startsWith('.')) throw new Error('Invalid notebook name');
  return inRoot(name);
}

function titleOf(content, fallback) {
  for (const line of content.split('\n')) {
    const t = line.replace(/^#{1,6}\s+/, '').trim();
    if (t) return t;
  }
  return fallback;
}

function safeName(title) {
  const s = title
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

// ---------- vault ----------
async function readNote(file, notebook) {
  const [body, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
  const name = path.basename(file, '.md');
  return { path: file, notebook, name, title: titleOf(body, name), body, mtime: st.mtimeMs };
}

async function mdFiles(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

async function listVault() {
  const root = path.resolve(config.root);
  await fsp.mkdir(root, { recursive: true });
  const ents = await fsp.readdir(root, { withFileTypes: true });
  const notebooks = ents
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const jobs = (await mdFiles(root)).map((f) => readNote(f, ''));
  for (const nb of notebooks) {
    for (const f of await mdFiles(path.join(root, nb))) jobs.push(readNote(f, nb));
  }
  const notes = (await Promise.allSettled(jobs))
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => b.mtime - a.mtime);
  return { root, notebooks, notes };
}

const WELCOME = `# Welcome to VibeNote

Your notes are plain **Markdown files** in a folder on your Mac, so you can open, back up, or sync them with anything.

## Basics

- **⌘N** new note · **⇧⌘N** new notebook
- **⌘1 / ⌘2 / ⌘3** editor · split · preview
- **⇧⌘F** search all notes · **⌘F** find in this note
- **⌘\\\\** show / hide the sidebar
- The first line of a note becomes its title *and* its file name
- Drag a note onto a notebook to move it

## Markdown works

- [x] Task lists
- [ ] Tables, code, quotes, images

\`\`\`js
const vibe = 'good';
console.log(\`Notes feel \${vibe}\`);
\`\`\`

> Tip: change the notes folder from **File → Change Notes Folder…**
`;

async function ensureRoot() {
  const root = path.resolve(config.root);
  if (fs.existsSync(root)) return;
  await fsp.mkdir(path.join(root, 'Ideas'), { recursive: true });
  await fsp.writeFile(path.join(root, 'Welcome to VibeNote.md'), WELCOME);
}

function watchRoot() {
  if (watcher) watcher.close();
  watcher = null;
  try {
    watcher = fs.watch(config.root, { recursive: true }, () => {
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('vault:changed');
      }, 250);
    });
  } catch (e) {
    console.error('watch failed', e);
  }
}

// ---------- IPC ----------
ipcMain.handle('vault:list', () => listVault());

ipcMain.handle('vault:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose notes folder',
    defaultPath: config.root,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  config.root = r.filePaths[0];
  saveConfig();
  watchRoot();
  return config.root;
});

ipcMain.handle('note:read', (_e, p) => fsp.readFile(inRoot(p), 'utf8'));

// Write, then rename the file to match the note's title. Returns the (possibly new) path.
ipcMain.handle('note:save', async (_e, p, content) => {
  let file = inRoot(p);
  await fsp.writeFile(file, content, 'utf8');
  const desired = uniquePath(path.dirname(file), safeName(titleOf(content, 'Untitled')), file);
  if (desired !== file) {
    await fsp.rename(file, desired);
    file = desired;
  }
  return file;
});

ipcMain.handle('note:create', async (_e, notebook) => {
  const dir = notebookDir(notebook);
  await fsp.mkdir(dir, { recursive: true });
  const file = uniquePath(dir, 'Untitled');
  await fsp.writeFile(file, '', { flag: 'wx' });
  return file;
});

ipcMain.handle('note:move', async (_e, p, notebook) => {
  const file = inRoot(p);
  const dir = notebookDir(notebook);
  if (samePath(path.dirname(file), dir)) return file;
  await fsp.mkdir(dir, { recursive: true });
  const dest = uniquePath(dir, path.basename(file, '.md'));
  await fsp.rename(file, dest);
  return dest;
});

ipcMain.handle('note:trash', (_e, p) => shell.trashItem(inRoot(p)));
ipcMain.handle('note:reveal', (_e, p) => shell.showItemInFolder(inRoot(p)));

ipcMain.handle('notebook:create', async (_e, name) => {
  const clean = safeName(name);
  await fsp.mkdir(notebookDir(clean), { recursive: true });
  return clean;
});

ipcMain.on('app:flushed', () => pendingClose && pendingClose());

// ---------- window & menu ----------
function createWindow() {
  allowClose = false;
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 500,
    title: 'VibeNote',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  const openExternal = (url) => /^(https?|mailto):/i.test(url) && shell.openExternal(url);
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });

  // Let the renderer flush unsaved edits before the window closes.
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    const done = () => {
      if (allowClose) return;
      allowClose = true;
      pendingClose = null;
      if (quitting) app.quit();
      else if (win && !win.isDestroyed()) win.close();
    };
    pendingClose = done;
    setTimeout(done, 1500);
    win.webContents.send('command', 'flush');
  });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('command', cmd);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: send('new-note') },
        { label: 'New Notebook', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-notebook') },
        { type: 'separator' },
        { label: 'Search Notes', accelerator: 'CmdOrCtrl+Shift+F', click: send('search') },
        { type: 'separator' },
        { label: isMac ? 'Reveal Note in Finder' : 'Show Note in Folder', accelerator: 'CmdOrCtrl+Shift+R', click: send('reveal') },
        { label: 'Move Note to Trash…', click: send('trash') },
        { type: 'separator' },
        { label: 'Change Notes Folder…', click: send('choose-folder') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Editor Only', accelerator: 'CmdOrCtrl+1', click: send('mode-edit') },
        { label: 'Split View', accelerator: 'CmdOrCtrl+2', click: send('mode-split') },
        { label: 'Preview Only', accelerator: 'CmdOrCtrl+3', click: send('mode-preview') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: send('toggle-sidebar') },
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
  await ensureRoot();
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
