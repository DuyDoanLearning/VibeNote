// Smoke test: launch VibeNote against a throwaway profile and notes folder, open a note, take screenshots.
// Run with:  npm run smoke   (screenshots go to the system temp folder; the path is printed)
// Never touches the real ~/Library/Application Support/VibeNote or ~/Documents/VibeNotes.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), 'vibenote-smoke');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibenote-profile-'));
const notes = path.join(userData, 'notes');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ root: notes }));
app.setPath('userData', userData); // must happen before main.js loads

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log('[renderer error]', e.message);
  });
  if (started) return;
  started = true;
  win.webContents.on('did-finish-load', async () => {
    const js = (s) => win.webContents.executeJavaScript(s);
    const shot = async (name) => {
      fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage()).toPNG());
      console.log('screenshot', path.join(out, `${name}.png`));
    };
    let ok = true;
    try {
      await wait(2500);
      await shot('1-start');
      const hasPreview = await js(`!!document.querySelector('#preview h1')`);
      console.log('welcome note rendered:', hasPreview);
      ok = ok && hasPreview;

      win.webContents.send('command', 'new-note');
      await wait(800);
      await js(`(() => { const v = document.querySelector('.cm-content'); v.focus();
        document.execCommand('insertText', false, '# Smoke test\\n\\n- [ ] task\\n\\n> [!TIP]\\n> It works'); })()`);
      await wait(1500);
      await shot('2-new-note');
      const saved = fs.existsSync(path.join(notes, 'Smoke test.md'));
      console.log('note saved and renamed from title:', saved);
      ok = ok && saved;
    } catch (e) {
      console.log('ERROR', e);
      ok = false;
    }
    console.log(ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED');
    for (const w of BrowserWindow.getAllWindows()) w.close();
    await wait(2000);
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(ok ? 0 : 1);
  });
});

require(path.join(__dirname, '..', 'main.js'));
