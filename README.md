# VibeNote

A Markdown note-taking app (Electron). Notes are plain `.md` files in `~/Documents/VibeNotes`
(change via File → Change Notes Folder…). Subfolders are notebooks; the first line of a note is its title and file name.

## Commands
- `npm start` — build and run in dev mode
- `npm run package` — build `release/VibeNote-darwin-arm64/VibeNote.app`
  (then copy it to /Applications to update the installed app)

## Files
- `main.js` — window, menus, all file access
- `preload.js` — safe bridge between UI and main process
- `src/renderer.js` — UI logic (CodeMirror editor, marked preview, list, search)
- `index.html`, `styles.css` — layout and theme (follows macOS light/dark)
