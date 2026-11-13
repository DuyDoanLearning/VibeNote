# VibeNote — notes for Claude

Markdown note-taking app for macOS (Electron), built by Claude with and for the repo owner, who uses it every day as their main Markdown app. See README.md for features, data layout and the file map.

## Read this first (continuing on another machine or session)
0. **Latest status lives on the `agent` branch in `docs/handoff.md`** (what was built, how to test, what's pending) — read it with `git show origin/agent:docs/handoff.md` even if you work on `main`.
1. `git fetch --all --tags` — work happens on two branches (see *Branches*); check which one the owner wants.
2. `npm install` (Node 20+), then `npm run smoke` to confirm the build works without touching real notes.
3. Read `docs/agent-spec.md` (the current experiment) and `docs/ideas.md` (backlog + owner's top picks).
4. Machine-specific things are **not** in the repo: the notes folder (default `~/Documents/VibeNotes`), settings / chat history / version history (`~/Library/Application Support/VibeNote/`), and project links (notebook → code folder, `config.projects`). On a new Mac, relink the "VibeNote Dev" notebook to this repo from the Claude panel (⋯ → Link a Code Folder).

## The owner and how to work with them
- Not deep into the code; worried about losing track of AI-written code. Explain in **plain, friendly, non-jargon language**, keep summaries short, and say what changed and why.
- Values a **stable** Markdown app above all; experiments must not break it (hence the branches, tag and rollback script).
- Liked: Inkdrop-style experience (left-aligned, tight spacing, explicit title field), VS Code themes, keyboard-driven editing. **Never mention "Inkdrop" in anything public in this repo** (README, docs, code comments, GitHub description).
- Usual loop after each change: test in an isolated profile → `npm run package` → quit the running app gracefully (`osascript -e 'tell application "VibeNote" to quit'`) → copy the .app to /Applications → reopen → commit → push. The owner expects things committed and pushed.
- Commit author is the owner's git identity; repo is public on GitHub (`DuyDoanLearning/VibeNote`, MIT).
- When a user-facing feature changes, update `welcome.md` (first-run note) and, if asked, the owner's "Guide" notebook notes (in their notes folder, not the repo).

## Branches / releases
- `main` + tags `v*-stable` (newest: `v1.0.2-stable`) = the stable Markdown app. Keep it stable; only fixes and docs go here. Tag each stable fix release `vX.Y.Z-stable` (the install script picks the newest).
- `agent` = the experimental Claude panel (spec: `docs/agent-spec.md`). Experimental work goes here.
- `scripts/install-version.sh <ref>` builds any version in a temporary worktree and installs it into /Applications — the owner's rollback path (no argument = newest `v*-stable` tag) and upgrade path (`agent`).

## Principles
- **Notes are plain files.** `.md` files in a folder, notebooks = folders (nestable), metadata = YAML front matter (`title`, `tags`, `status`, `pinned`, `created`; unknown keys are preserved in `meta.extra`). Never introduce a database or hidden per-note state — the notes folder must stay syncable between Macs.
- **Title = file name.** The title field above the editor is the source of truth; saving renames the file. A `title:` line is written to front matter only when the title can't be a file name (`/ : ? …`) or got a ` 2` suffix. Titles no longer come from the note's first line (older notes may still start with a duplicate `# Title`).
- Pasted/picked images go to `<notebook>/.assets/` (HEIC converted to JPEG with `sips`); moving a note copies its assets along. Trash = `<root>/.trash/` + `index.json`.
- Local-only state (version history keyed by file inode, settings, agent chats) lives in `app.getPath('userData')`.
- All file access goes through `main.js` IPC handlers; every path is validated with `inRoot()`. The renderer is sandboxed (contextIsolation, no Node).
- UI colours are CSS variables (`--bg`, `--text`, `--accent`, `--syn-*`, `--md-*`, `--list-*`). Themes (built-in or any installed VS Code theme via `themes.js`) only set variables; the editor HighlightStyle and highlight.js CSS read them.

## Claude panel (agent branch)
- `src-main/agent.js` uses `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` = the user's installed `claude`, so it runs on their Claude login (ANTHROPIC_API_KEY is stripped from the child env on purpose). Owner's decision: internal use only; switch to API-key auth before distributing to others.
- Bundled by esbuild into `dist/agent.mjs` (the SDK's 300 MB platform binary is not shipped) and imported lazily by `main.js`. All npm packages are devDependencies because everything is bundled; the packaged app ships no `node_modules`.
- Login-shell env is read once (`zsh -ilc env`) because GUI apps don't get the user's PATH.
- One chat per project (top-level notebook) in streaming-input mode; transcripts in `userData/agent-chats/`; resumed via the saved session id.
- `canUseTool` → IPC → Allow/Deny cards in `src/agent-panel.js`; AskUserQuestion answers go back as `updatedInput.answers`; ExitPlanMode shows the plan with Approve.
- `systemPromptFor` in main.js defines the note-driven conventions: plans as checklists, tick steps when done, a "Change log" note entry per commit, a "Codebase map" note.
- Known limitation: if the user has unsaved typing in a note while Claude edits the same note, the user's text wins on save.
- Testing the agent spends the owner's Claude usage: keep end-to-end tests tiny, with a scratch git repo and a temp notes folder.

## Commands
- `npm start` — build + run (dev)
- `npm run build` — `build.mjs`: bundles `src/renderer.js` → `dist/renderer.js` and `src-main/agent.js` → `dist/agent.mjs`, copies KaTeX + Mermaid into `dist/`
- `npm run package` — `release/VibeNote-darwin-<arch>/VibeNote.app` (with `build/icon.icns`)
- `npm run smoke` — `scripts/smoke-test.js`
- `npm run icon` — rebuild `build/icon.png` / `.icns` from `build/icon.svg`

## Testing — important
- **Never run the app under test against the real profile.** Electron's `userData` ignores `$HOME`; a test that changes settings will overwrite the owner's real `~/Library/Application Support/VibeNote/config.json` (this happened once and pointed their notes folder at a temp dir). Always call `app.setPath('userData', <temp dir>)` before requiring `main.js`, and point `config.root` at a temp notes folder — `scripts/smoke-test.js` shows the pattern.
- Drive the UI with `webContents.send('command', id)` (same ids as the menus / `COMMANDS` in renderer.js), `executeJavaScript`, and `webContents.sendInputEvent` for real key presses; check results with `capturePage()` screenshots and by reading files on disk.
- `dialog.showSaveDialog` / `showOpenDialog` can be monkey-patched in the harness to test export/import/pickers without UI.

## Conventions
- Plain JS (no TypeScript, no framework). Keep modules small and focused; renderer state lives in the `S` object in `src/renderer.js`.
- New commands: add to `COMMANDS` in renderer.js (shows up in the ⌘K palette) and, if it needs a menu/shortcut, to `buildMenu()` in main.js. Editor keys that CodeMirror must handle use `fmt()` menu items (`registerAccelerator: false`) so the key isn't stolen from the editor.
- Commit messages: imperative summary line; end with the Co-Authored-By trailer.

## What's next
- Agent phases 2–4 (`docs/agent-spec.md`): Plan/Build buttons and templates, automatic change-log/commit links, codebase map, explain-as-notes, diff viewer, other agents (Codex).
- Backlog with the owner's top picks: `docs/ideas.md` (⭐ git sync for notes, ⭐ "why does this line exist?", ⭐ a branch per spec).
- Smaller: floating selection toolbar, ordered-list auto-renumbering, `.tmTheme` theme support.
