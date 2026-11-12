# VibeNote — notes for Claude

Markdown note-taking app (Electron, macOS), built for the repo owner's own use. See README.md for features, data layout and file map.

## Principles
- **Notes are plain files.** `.md` files in a folder, notebooks = folders, metadata = YAML front matter (`tags`, `status`, `pinned`, `created`; unknown keys are preserved in `meta.extra`). Never introduce a database or hidden per-note state that breaks this — the notes folder must stay syncable between Macs.
- Local-only state (version history, settings) lives in `app.getPath('userData')`.
- All file access goes through `main.js` IPC handlers; every path is validated with `inRoot()`. The renderer is sandboxed (contextIsolation, no Node).
- A note's first line is its title **and** its file name: `note:save` renames the file to match.
- UI colours are CSS variables (`--bg`, `--text`, `--accent`, `--syn-*`, `--md-*`, `--list-*`). Themes (built-in or VS Code) only set variables; the editor HighlightStyle and highlight.js CSS read them.

## Branches / releases
- `main` + tag `v1.0-stable` = the stable markdown app the owner relies on. Keep it stable.
- `agent` = the experimental Claude panel (spec: the owner's note "VibeNote Dev/VibeNote Agent"). Experimental work goes here.
- `scripts/install-version.sh <ref>` builds and installs any version; it is the owner's rollback path.

## Claude panel (agent branch)
- `src-main/agent.js` uses `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` = the user's installed `claude`, so it runs on their Claude login (ANTHROPIC_API_KEY is stripped from the child env on purpose). Owner's decision: internal use only; switch to API-key auth before distributing.
- It is bundled by esbuild into `dist/agent.mjs` (the SDK's 300 MB platform binary is not shipped) and imported lazily by `main.js`.
- Login-shell env is read once (`zsh -ilc env`) because GUI apps don't get the user's PATH.
- One chat per project (top-level notebook) in streaming-input mode; transcripts in `userData/agent-chats/`. Projects map notebook → code folder in `config.projects` (machine-specific, not in the notes folder).
- `canUseTool` → IPC → Allow/Deny cards in the renderer; AskUserQuestion answers go back as `updatedInput.answers`; ExitPlanMode shows the plan with Approve.
- The system prompt append (`systemPromptFor` in main.js) defines the note-driven conventions: plans as checklists, tick steps, Change log note per commit, Codebase map.
- Testing the agent spends the owner's Claude usage: keep end-to-end tests tiny, and use a scratch repo + temp notes folder.

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
- Agent phases 2–4 (see the spec note): Plan/Build buttons and templates, automatic change-log/commit links, codebase map, explain-as-notes, diff viewer, other agents (Codex). Smaller AI ideas: inline assistant, next-edit ghost text, an MCP server exposing notes.
- Sync between Macs (owner wants it later; Mac-only, no mobile). Options: notes folder in iCloud Drive, or built-in git/server sync with conflict handling.
- Floating selection toolbar, ordered-list auto-renumbering, `.tmTheme` theme support.
