// VS Code colour-theme support: discover installed themes, import new ones, resolve a theme to plain JSON.
// A theme here is { key, label, type: 'dark' | 'light', colors: {...}, tokenColors: [...] } — the VS Code format.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');

const home = os.homedir();
const userThemesDir = () => path.join(app.getPath('userData'), 'themes');

// Where VS Code-family editors keep extensions (built-in and user-installed).
function sources() {
  return [
    { name: 'VS Code', dir: '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions' },
    { name: 'VS Code', dir: path.join(home, '.vscode/extensions') },
    { name: 'VS Code Insiders', dir: path.join(home, '.vscode-insiders/extensions') },
    { name: 'Cursor', dir: '/Applications/Cursor.app/Contents/Resources/app/extensions' },
    { name: 'Cursor', dir: path.join(home, '.cursor/extensions') },
    { name: 'Windsurf', dir: path.join(home, '.windsurf/extensions') },
    { name: 'VSCodium', dir: path.join(home, '.vscode-oss/extensions') },
    { name: 'Imported', dir: userThemesDir() },
  ];
}

// JSON with comments and trailing commas (VS Code's "JSONC").
function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJsoncSync(file) {
  return parseJsonc(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// Version-aware sort so the newest copy of an extension wins.
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

let cache = null;
function listThemes(force = false) {
  if (cache && !force) return cache;
  const seen = new Map();
  for (const src of sources()) {
    let dirs = [];
    try { dirs = fs.readdirSync(src.dir).sort(byVersion); } catch { continue; }
    for (const d of dirs) {
      const extDir = path.join(src.dir, d);
      let pkg;
      try { pkg = readJsoncSync(path.join(extDir, 'package.json')); } catch { continue; }
      const themes = pkg?.contributes?.themes;
      if (!Array.isArray(themes) || !themes.length) continue;
      let nls = {};
      try { nls = readJsoncSync(path.join(extDir, 'package.nls.json')); } catch {}
      const extId = `${pkg.publisher || 'local'}.${pkg.name || d}`;
      for (const t of themes) {
        if (!t.path || !/\.json$/i.test(t.path)) continue; // .tmTheme (XML) isn't supported
        const file = path.resolve(extDir, t.path);
        if (!file.startsWith(extDir) || !fs.existsSync(file)) continue;
        let label = t.label || t.id || path.basename(t.path, '.json');
        label = label.replace(/^%(.+)%$/, (_, k) => nls[k] || k);
        const key = `${extId}/${t.id || label}`;
        const type = /^(vs-dark|hc-black)$/.test(t.uiTheme) ? 'dark' : 'light';
        // later (newer) versions overwrite earlier ones
        seen.set(key, { key, id: t.id || label, label, type, source: src.name, file });
      }
    }
  }
  cache = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return cache;
}

function loadThemeFile(file, depth = 0) {
  const json = readJsoncSync(file);
  let colors = {};
  let tokenColors = [];
  if (json.include && depth < 8) {
    try {
      const base = loadThemeFile(path.resolve(path.dirname(file), json.include), depth + 1);
      colors = base.colors;
      tokenColors = base.tokenColors;
    } catch {}
  }
  colors = { ...colors, ...(json.colors || {}) };
  if (Array.isArray(json.tokenColors)) tokenColors = [...tokenColors, ...json.tokenColors];
  // semanticTokenColors aren't used by VibeNote; type is optional in the file
  return { colors, tokenColors, type: json.type };
}

function loadTheme(key) {
  const meta = listThemes().find((t) => t.key === key);
  if (!meta) return null;
  try {
    const t = loadThemeFile(meta.file);
    const type = t.type === 'light' || t.type === 'hcLight' ? 'light' : t.type ? 'dark' : meta.type;
    return { key, label: meta.label, type, colors: t.colors, tokenColors: t.tokenColors };
  } catch (e) {
    console.error('theme load failed', key, e.message);
    return null;
  }
}

// ---------- "Same as VS Code" ----------
const vscodeSettingsFile = () => path.join(home, 'Library/Application Support/Code/User/settings.json');

function vscodeThemeKey(prefersDark) {
  let s = {};
  try { s = readJsoncSync(vscodeSettingsFile()); } catch {}
  let name = s['workbench.colorTheme'] || 'Dark Modern';
  if (s['window.autoDetectColorScheme']) {
    name = prefersDark
      ? s['workbench.preferredDarkColorTheme'] || 'Dark Modern'
      : s['workbench.preferredLightColorTheme'] || 'Light Modern';
  }
  const themes = listThemes();
  const match = themes.find((t) => t.id === name) || themes.find((t) => t.label === name);
  return match ? match.key : null;
}

function watchVscodeSettings(onChange) {
  const file = vscodeSettingsFile();
  fs.watchFile(file, { interval: 2000 }, () => onChange());
  return () => fs.unwatchFile(file);
}

// ---------- import (.json theme file or .vsix extension) ----------
const unzip = (zip, dest) => new Promise((resolve, reject) => {
  execFile('/usr/bin/unzip', ['-q', '-o', zip, 'extension/*', '-d', dest], (err) => (err ? reject(err) : resolve()));
});

async function importTheme(file) {
  await fsp.mkdir(userThemesDir(), { recursive: true });
  if (/\.vsix$/i.test(file)) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vibenote-vsix-'));
    try {
      await unzip(file, tmp);
      const extDir = path.join(tmp, 'extension');
      const pkg = readJsoncSync(path.join(extDir, 'package.json'));
      if (!pkg?.contributes?.themes?.length) throw new Error('This extension has no colour themes');
      const dest = path.join(userThemesDir(), `${pkg.publisher || 'local'}.${pkg.name || 'theme'}`.replace(/[^\w.-]/g, '_'));
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(extDir, dest, { recursive: true });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  } else {
    const json = readJsoncSync(file);
    if (!json.colors && !json.tokenColors) throw new Error('Not a VS Code colour theme (no "colors" or "tokenColors")');
    const label = json.name || path.basename(file, path.extname(file));
    const slug = label.replace(/[^\w.-]+/g, '-').toLowerCase();
    const dest = path.join(userThemesDir(), `imported.${slug}`);
    await fsp.mkdir(path.join(dest, 'themes'), { recursive: true });
    await fsp.copyFile(file, path.join(dest, 'themes', 'theme.json'));
    const uiTheme = json.type === 'light' ? 'vs' : 'vs-dark';
    await fsp.writeFile(path.join(dest, 'package.json'), JSON.stringify({
      name: slug, publisher: 'imported',
      contributes: { themes: [{ label, uiTheme, path: './themes/theme.json' }] },
    }, null, 2));
  }
  listThemes(true);
}

module.exports = { listThemes, loadTheme, vscodeThemeKey, watchVscodeSettings, importTheme };
