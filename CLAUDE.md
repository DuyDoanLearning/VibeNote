# VibeNote — notes for Claude

Markdown note-taking app (Electron, macOS), an Inkdrop-inspired app built for the repo owner's own use. See README.md for features, data layout and file map.

## Principles
- **Notes are plain files.** `.md` files in a folder, notebooks = folders, metadata = YAML front matter (`tags`, `status`, `pinned`, `created`; unknown keys are preserved in `meta.extra`). Never introduce a database or hidden per-note state that breaks this — the notes folder must stay syncable between Macs.
- Local-only state (version history, settings) lives in `app.getPath('userData')`.
- All file access goes through `main.js` IPC handlers; every path is validated with `inRoot()`. The renderer is sandboxed (contextIsolation, no Node).
- A note's first line is its title **and** its file name: `note:save` renames the file to match.
- UI colours are CSS variables (`--bg`, `--text`, `--accent`, `--syn-*`, `--md-*`, `--list-*`). Themes (built-in or VS Code) only set variables; the editor HighlightStyle and highlight.js CSS read them.

## Commands
- `npm start` — build + run (dev)
- `npm run build` — esbuild bundles `src/renderer.js` → `dist/renderer.js`, copies KaTeX + Mermaid into `dist/`
- `npm run package` — `release/VibeNote-darwin-<arch>/VibeNote.app`; install by copying to /Applications (quit the running app first: `osascript -e 'tell application "VibeNote" to quit'`)
- `npm run smoke` — `scripts/smoke-test.js`

## Testing — important
- **Never run the app under test against the real profile.** Electron's `userData` ignores `$HOME`; a test that changes settings will overwrite the owner's real `~/Library/Application Support/VibeNote/config.json` (this happened once and pointed their notes folder at a temp dir). Always call `app.setPath('userData', <temp dir>)` before requiring `main.js`, and point `config.root` at a temp notes folder — `scripts/smoke-test.js` shows the pattern.
- Drive the UI with `webContents.send('command', id)` (same ids as the menus / `COMMANDS` in renderer.js), `executeJavaScript`, and `webContents.sendInputEvent` for real key presses; check results with `capturePage()` screenshots and by reading files on disk.
- `dialog.showSaveDialog` / `showOpenDialog` can be monkey-patched in the harness to test export/import without UI.

## Conventions
- Plain JS (no TypeScript, no framework). Keep modules small and focused; renderer state lives in the `S` object in `src/renderer.js`.
- New commands: add to `COMMANDS` in renderer.js (shows up in the ⌘K palette) and, if it needs a menu/shortcut, to `buildMenu()` in main.js. Editor keys that CodeMirror must handle use `fmt()` menu items (`registerAccelerator: false`) so the key isn't stolen from the editor.
- Commit messages: imperative summary line; end with the Co-Authored-By trailer.

## Open ideas / not built yet
- AI: inline assistant (BYOK, key in Keychain via `safeStorage`), next-edit ghost text, and an MCP server exposing notes — see Inkdrop docs for the reference design. Waiting on the owner's choice of provider.
- Sync between Macs (owner wants it later; Mac-only, no mobile). Options: notes folder in iCloud Drive, or built-in git/server sync with conflict handling.
- Floating selection toolbar, ordered-list auto-renumbering, `.tmTheme` theme support.
