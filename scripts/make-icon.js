// Render build/icon.svg → build/icon.png (1024²) and build/icon.icns (macOS).
// Run with:  npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 1024;
      c.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('could not load SVG'));
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  })`);
  const png = path.join(root, 'build', 'icon.png');
  fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));

  // .iconset with every size macOS wants, then iconutil → .icns
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'vibenote-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', `${set}/icon_${s}x${s}.png`], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', `${set}/icon_${s}x${s}@2x.png`], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'build', 'icon.icns')]);
  fs.rmSync(path.dirname(set), { recursive: true, force: true });
  console.log('wrote build/icon.png and build/icon.icns');
  app.exit(0);
});
