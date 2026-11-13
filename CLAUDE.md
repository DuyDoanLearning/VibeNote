# VibeNote — notes for Claude

Markdown note-taking app for macOS (Electron), built by Claude with and for the repo owner, who uses it every day as their main Markdown app. See README.md for features, data layout and the file map.

## Where things stand (updated 2026-11-14)
- **Stable = `v1.1.0-stable` on `main`**: notes, Claude panel, Confluence, API specs.
- **`agent` branch = the owner's daily build right now**: Projects workspace steps 1–3 (projects + home page + multi-repo workspace + several chats per project; draw.io diagrams; coding layout with Changes review, line comments for Claude and a file viewer). All committed, pushed and installed on the owner's main Mac. The owner is trying them for real; expect feedback and small fixes before the next step.
- **Next agreed step: 4, spec watch** (a followed Confluence page changes → what changed and which code / API specs it affects), then 5, Figma → API proposal. Owner's newer ideas (context bridge to T3 Code / a terminal `claude`, "Build this" button on a spec, project memory, local folders as context, a codebase-memory MCP server) are in `docs/workspace-spec.md` → "Ideas attached to this spec" and `docs/ideas.md`. Ask which they want before starting something big.
- The owner keeps a plain-language backlog note in their notes, "Workspace backlog" (they moved it to the Inbox; find it by title, don't assume a notebook). Keep it in step with `docs/` when a step is finished: tick the step and add a short "how to try it".

## Read this first (continuing on another machine or session)
0. **Latest status lives on the `agent` branch in `docs/handoff.md`** (what was built, how to test, what's pending) — read it with `git show origin/agent:docs/handoff.md` even if you work on `main`.
1. `git fetch --all --tags && git checkout agent` — new work happens on `agent` (see *Branches*); `main` only gets fixes and docs.
2. `npm install` (Node 20+), then `npm run smoke` to confirm the build works without touching real notes. The first build on `agent` downloads the draw.io editor (~50 MB from GitHub, cached in `~/Library/Caches/VibeNote/`); if that fails the app still builds, only diagrams won't open. To put the build on that Mac: `sh scripts/install-version.sh agent`.
3. Read **`docs/handoff.md`** (latest status, how to test, what's pending), then `docs/workspace-spec.md` (the current experiment: Projects), `docs/agent-spec.md`, `docs/confluence-spec.md` and `docs/ideas.md` (backlog + owner's top picks).
4. Machine-specific things are **not** in the repo: the notes folder (default `~/Documents/VibeNotes`), settings / chat history / version history (`~/Library/Application Support/VibeNote/`), and project links (notebook → code folder, `config.projects`). On a new Mac, relink the "VibeNote Dev" notebook to this repo from the Claude panel (⋯ → Link a Code Folder).

## The owner and how to work with them
- Friendly and informal (calls Claude "Bob" / "my friend"). Sends short messages and screenshots; when a report is vague, reproduce it with real clicks in an isolated profile first, then ask in plain text (they dismiss question dialogs).
- Not deep into the code; worried about losing track of AI-written code. Explain in **plain, friendly, non-jargon language**, keep summaries short, and say what changed and why.
- Values a **stable** Markdown app above all; experiments must not break it (hence the branches, tag and rollback script).
- Liked: Inkdrop-style experience (left-aligned, tight spacing, explicit title field), VS Code themes, keyboard-driven editing. **Never mention "Inkdrop" in anything public in this repo** (README, docs, code comments, GitHub description).
- Usual loop after each change: test in an isolated profile → `npm run package` → quit the running app gracefully (`osascript -e 'tell application "VibeNote" to quit'`) → copy the .app to /Applications → reopen → commit → push. The owner expects things committed and pushed.
- Commit author is the owner's git identity; repo is public on GitHub (`DuyDoanLearning/VibeNote`, MIT).
- When a user-facing feature changes, update `welcome.md` (first-run note) and, if asked, the owner's "Guide" notebook notes (in their notes folder, not the repo).

## Branches / releases
- `main` + tags `v*-stable` (newest: `v1.1.0-stable`, which brought the Claude panel, Confluence and API specs into stable on 2026-11-13; `v1.0.2-stable` is the last notes-only release) = the stable app. Keep it stable; only fixes and docs go here. Tag each stable fix release `vX.Y.Z-stable` (the install script picks the newest).
- `agent` = experimental work. Current experiment: the Projects workspace (spec: `docs/workspace-spec.md`).
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
- Chats run in streaming-input mode; transcripts in `userData/agent-chats/`; resumed via the saved session id. A project can have several chats (see *Projects workspace*).
- `canUseTool` → IPC → Allow/Deny cards in `src/agent-panel.js`; AskUserQuestion answers go back as `updatedInput.answers`; ExitPlanMode shows the plan with Approve.
- `systemPromptFor` in main.js defines the note-driven conventions: plans as checklists, tick steps when done, a "Change log" note entry per commit, a "Codebase map" note.
- Known limitation: if the user has unsaved typing in a note while Claude edits the same note, the user's text wins on save.
- Testing the agent spends the owner's Claude usage: keep end-to-end tests tiny, with a scratch git repo and a temp notes folder.

## Projects workspace (agent branch, spec: `docs/workspace-spec.md`)
- Project = top-level notebook with `Project brief.md` and/or `config.projects[name]` (code folder). `projectFor(notebook, thread?)` in main.js returns `{ name, repo, thread, key }`; **`name` is the project, `key` is the chat** (`name` for the first chat, `name#<id>` for the others) — don't mix them up.
- Chats index: `userData/agent-chats/_threads.json`; each chat keeps its own file and (optional) `cwd` = the repository it is focused on. `state.pending` holds unanswered Allow/Deny cards so they can be shown again.
- Extra documents: `sources:` list in the brief's front matter (kept in `meta.extra`; `projects.parseSources` / `setSources`). The renderer decides membership (`projectUI.projectOf(note)`), main only stores the list.
- `projects.js` runs git read-only with hooks/fsmonitor disabled. The home page is throttled (`homeSoon`) because it asks git for news.

## Diagrams (agent branch)
- `.drawio` files are **not notes**: `src/diagram-ui.js` shows them in a third main-area state (`S.diagram`, `body.diagram-open`) next to "note" and "project home". IPC `diagrams:*` in main.js; `diagramFile()` only allows files in the notes folder, a linked project folder, or picked by the user (`config.recentDiagrams`).
- The draw.io web app is downloaded by `build.mjs` (pinned version + SHA-256, cached in `~/Library/Caches/VibeNote/`), trimmed, and served from `dist/drawio` through the `vibe-drawio://` protocol with a CSP that blocks all outside requests. To update draw.io: change `DRAWIO.version` and `sha256` in build.mjs, rebuild, and re-run a diagram test (check for missing files).
- The editor runs with `stealth=1` (no outside services). In that mode draw.io shows cramped dialogs, so `DRAWIO_PATCH` in main.js is appended to `js/PostConfig.js` when served (currently: the full "More Shapes" window). Don't use `offline=1`. Add further fixes of that kind there.
- Claude editing an open diagram was verified live (Edit on the .drawio file → Allow card → the editor reloads).
- Embed protocol: `?embed=1&proto=json`; the frame posts `init` / `autosave` / `save`, VibeNote posts `load` / `status`. Test trick: `win.webContents.mainFrame.framesInSubtree` finds the frame; post a fake `autosave` from inside it.

## Code view and coding layout (agent branch)
- `src/code-ui.js`: a fourth main-area state (`S.code`, `body.code-open`) with two tabs, Changes (parsed `git diff`) and File (read-only CodeMirror). Line comments are kept in memory and sent to the open chat with `agentPanel.ask`. `code:*` IPC in main.js is read-only and guarded by `repoDir()` / `codeFile()`.
- Main-area states are exclusive: note, project home (`S.home`), diagram (`S.diagram`), code (`S.code`). Opening one closes the others (`closeOthers` / `beforeOpen` / `closeDiagram` hooks in renderer.js). Check all four when adding a fifth.
- Coding layout = `body.coding` (only with `agent-open`, not with `comments-open`): `#agent` moves to grid column 3 and `#main` to column 4 by explicit `grid-column` (`order` does not work: `#agent` has a fixed column).
- `restartFresh()` in main.js: when resume fails with "No conversation found with session ID", the chat restarts with `transcriptOf(items)` as background. A test that deletes `~/.claude/projects/<folder>` will trigger it.
- Name clash to avoid: `openChanges` in the projectUI context is the Confluence "Changes to push" window; the code review is `openCodeChanges`.

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

## Testing Confluence / Claude features
- Fake Atlassian in a harness: `ipcMain.removeHandler('confluence:…')` after requiring main.js, then register stand-ins. Real Atlassian only off the owner's office network (its proxy re-signs HTTPS with an untrusted certificate) and only under the owner's private scratch page.
- Live Claude tests: tiny prompts on Haiku in a throwaway folder; delete the test folders from `~/.claude/projects` afterwards.
- Details and today's lessons: `docs/handoff.md`.

## What's next
- Projects workspace steps 4–5 in `docs/workspace-spec.md` (next: spec watch), plus the owner's ideas there (context bridge to T3 Code / terminal, "Build this" button).
- See `docs/handoff.md` → "Parked / next": Confluence sync & comments (parked), real end-to-end Publish test.
- Agent phases 2–4 (`docs/agent-spec.md`): Plan/Build buttons and templates, automatic change-log/commit links, codebase map, explain-as-notes, diff viewer, other agents (Codex).
- Backlog with the owner's top picks: `docs/ideas.md` (⭐ git sync for notes, ⭐ "why does this line exist?", ⭐ a branch per spec).
- Smaller: floating selection toolbar, ordered-list auto-renumbering, `.tmTheme` theme support.
