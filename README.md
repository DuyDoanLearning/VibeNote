# VibeNote

A workspace for macOS that keeps a piece of work in one place: your notes and documents, the code, the diagrams and the Claude chats about them. It started as a Markdown note-taking app and still is one at its core. Everything is stored as **plain files** (notes are `.md` files, notebooks are folders), so they stay readable, greppable and easy to back up or sync.

Built with Electron. Personal project; macOS only.

## What's in which version

| Version | What it has | Where |
|---|---|---|
| **Stable** | Notes, the Claude panel, Confluence, API specs | branch `main`, tags `v*-stable` (newest: `v1.1.0-stable`) |
| **Experimental** | Everything in stable, plus Projects, the coding layout and draw.io diagrams | branch `agent` |
| Notes only | The Markdown app before the Claude panel | tag `v1.0.2-stable` |

Install any version into /Applications (notes and settings are not touched):

```sh
scripts/install-version.sh                 # the newest stable release
scripts/install-version.sh agent           # the experimental build
scripts/install-version.sh v1.0.2-stable   # the notes-only app
scripts/install-version.sh <commit>        # anything else
```

## Features

### Notes

- Markdown editor (CodeMirror 6) with live preview, split / edit / preview modes, focus mode
- Notebooks (nested folders), tags, status (Active / On hold / Completed / Dropped), pinned notes
- Search with filters: `tag:x`, `book:x`, `status:x`, `title:x`, `is:pinned`, `-negate`
- Command palette (⌘K), heading outline (⇧⌘O), back / forward between notes
- `[[Wiki links]]` between notes, with autocomplete; backlinks
- Slash commands (`/`), emoji (`:fire`), code-language suggestions, formatting shortcuts, smart list indenting
- Paste / drag images; paste URLs as titled links
- Preview: GFM tables & task lists (clickable), KaTeX math, Mermaid diagrams, callouts (`> [!TIP]`), footnotes, `==highlight==`
- Version history per note that shows who changed what (you, Claude, Confluence); in-app Trash with restore
- Note list grouped by notebook / tag / type; resizable panes
- Export to HTML / PDF, print
- Themes: built-in light/dark, **any VS Code colour theme** installed on the machine, “Same as VS Code”, or import `.json` / `.vsix`
- Vim key bindings, line numbers, spell check, font / width settings

### Claude panel (⌘J)

A chat with Claude next to your notes. Link a notebook to a code folder and Claude can plan in your notes, edit code, run commands, commit, and keep a plain-language **Change log** note. Every risky step shows an **Allow / Deny** card first.

- **Live view**: thinking, each step with its result, diffs, to-dos, helper progress; **Esc** stops Claude
- **Slash commands**: `/model`, `/effort`, `/usage`, `/context`, `/mcp`, … and all your Claude Code commands and skills
- **Claude Chats**: browse past Claude Code chats (Terminal, VS Code, apps, T3 Code) per folder, continue one, or save it as a note
- **/claude** writes Markdown at the cursor; **@Claude** in comments; both can use your panel conversation as background
- **Inline suggestions** while writing (grey text, Tab to accept) and a model choice per feature (Settings → Claude)

It runs on **your installed [Claude Code](https://claude.com/claude-code)** and its existing login (via the Claude Agent SDK), so install Claude Code and run `claude` once to sign in. This is meant for personal use; an app distributed to others should use API-key authentication instead.

### Confluence and API specs

- **Confluence**: fetch page trees as notes, edit, push back surgically; publish a note as a new page; **Changes to push** (push one or all); pictures and draw.io diagrams; comments
- **API specs**: OpenAPI/Swagger editor with live Swagger or Reference docs and Try it out; deep links between notes, pages and specs

### Experimental (`agent` branch)

- **Projects**: a project is a notebook that gathers documents (its notes, plus Confluence pages, API specs or other notebooks you tick), a code folder with one or many repositories, and several Claude chats. Its **home page** shows what changed since you last looked, a **brief** that every new chat reads first, the documents, the repositories (branch, last commit, uncommitted files) and the chats.
- **Several chats per project**: switch between them in the panel; each can be focused on one repository and has its own model and permission mode; they keep working in the background and show when one needs your OK.
- **Coding layout** (⌥⌘J): the chat in the middle with the code or document beside it. **Changes** shows what is not committed yet, or any recent commit, as a diff. Click a line to comment and send your comments to Claude as one review. A read-only **file viewer** opens files Claude mentions, with **Open in VS Code**.
- **Diagrams**: `.drawio` files open in the full draw.io editor inside the app. It saves as you draw and refreshes when Claude edits the file. The editor is bundled and cannot contact anything outside the app.

Specs and backlog: `docs/workspace-spec.md`, `docs/ideas.md`.

## Getting started on a new machine

Requirements: macOS, [Node.js](https://nodejs.org) 20+ and git. For the Claude features: Claude Code installed and signed in.

```sh
git clone https://github.com/DuyDoanLearning/VibeNote.git
cd VibeNote
git checkout agent     # optional: the experimental branch (stay on main for stable)
npm install
npm start              # build and run in development
```

Install it as a normal app:

```sh
npm run package        # → release/VibeNote-darwin-<arch>/VibeNote.app
cp -R release/VibeNote-darwin-*/VibeNote.app /Applications/
```

- The app isn't code-signed, so the first launch may need right-click → **Open**.
- On the `agent` branch, the first build downloads the draw.io editor (about 50 MB, once, from the draw.io GitHub releases; the file is checked against a fixed checksum and cached in `~/Library/Caches/VibeNote/`).
- Per-machine things to set up again: link each project to its code folder, and sign in to Confluence on the first fetch.

Working on the code with Claude Code: start it in this folder and it reads `CLAUDE.md`, which points to the latest status in `docs/handoff.md`.

## Where data lives

| What | Where |
|---|---|
| Notes | `~/Documents/VibeNotes` by default (File → Change Notes Folder…) |
| Notebook | a folder; nested folders = nested notebooks |
| Tags / status / pinned | YAML front matter at the top of each note |
| Pasted images | `<notebook>/.assets/`, linked relatively |
| Trash | `<notes>/.trash/` (+ `index.json` remembering the original notebook) |
| A project | its notebook; the `Project brief.md` note in it lists the project's extra documents |
| Diagrams | `.drawio` files, in the notes folder, a project's code folder, or anywhere you open them from |
| Version history | `~/Library/Application Support/VibeNote/history/` (local only) |
| Claude chats, diagram backups | `~/Library/Application Support/VibeNote/agent-chats/`, `…/diagram-backups/` (local only) |
| Settings, project → code folder links | `~/Library/Application Support/VibeNote/config.json` (local only) |

The notes folder is self-contained, so it can be synced between Macs (iCloud Drive, Dropbox, git…). History, chats and settings stay per machine.

## Project layout

| File | What it does |
|---|---|
| `main.js` | Electron main process: windows, menus, all file access (notes, trash, history, export), chats, projects, diagrams, read-only git |
| `themes.js` | Finds / loads / imports VS Code colour themes; “Same as VS Code” |
| `projects.js` | Projects: repositories in a workspace folder, read-only git status, the brief's document list |
| `claude-chats.js` | Reads (never changes) past Claude Code chats in `~/.claude/projects` and T3 Code threads for the Claude Chats window |
| `preload.js` | The only bridge between UI and main (`window.vibe.*`) |
| `src/renderer.js` | UI: sidebar, note list, toolbar, palette, settings, history, commands |
| `src/editor.js` | CodeMirror setup: autocomplete, paste/drop, ⌘-click links |
| `src/typing.js` | Formatting commands, lists, slash commands, emoji, line tools |
| `src/markdown.js` | Markdown → HTML (marked + wiki links, math, highlight, footnotes, callouts, Mermaid) |
| `src/theme.js` | Maps a VS Code theme to VibeNote's CSS variables |
| `src/search.js` | Search filters and fuzzy matching |
| `src/agent-panel.js` | The Claude chat panel (messages, steps, Allow/Deny cards, questions, plans, chat switcher) |
| `src/agent-slash.js` | Slash commands in the Claude panel |
| `src/project-ui.js` | Projects: sidebar section, home page, new project, add documents |
| `src/code-ui.js` | Code view: changes (git diff) with line comments for Claude, read-only file viewer |
| `src/diagram-ui.js` | draw.io diagrams: sidebar section and the embedded editor |
| `src/ghost.js` | Inline suggestions while writing |
| `src/confluence*.js`, `src/changes-ui.js`, `src-main/atlassian.js` | Confluence fetch / push / publish, “Changes to push” |
| `src/apidocs.js`, `src/links.js` | API spec docs (Swagger / Reference), links between notes, pages and specs |
| `src/comments.js`, `src/writer.js` | Comments with @Claude; /claude writing at the cursor |
| `src/chats-ui.js` | Claude Chats window: browse past chats, continue one, save as a note |
| `src-main/agent.js` | Agent host: Claude Agent SDK driving the installed Claude Code (bundled to `dist/agent.mjs`) |
| `build.mjs` | Bundles the renderer and the agent host; downloads and trims the draw.io editor into `dist/drawio` |
| `styles.css` / `markdown.css` | App styles / preview + export styles |
| `welcome.md` | Note created on first run |
| `guide/` | The built-in **VibeNote Guide** project (copied into the notes folder; untouched notes are updated with new versions, edited ones are kept) |
| `scripts/smoke-test.js` | Launches the app against a throwaway profile and checks the basics |
| `scripts/install-version.sh` | Builds a given git version and installs it into /Applications (rollback) |
| `docs/` | Hand-over notes, specs and the backlog |

## Scripts

- `npm start` — build and run the app
- `npm run build` — bundle `src/` into `dist/` (esbuild), copy KaTeX / Mermaid, fetch the draw.io editor if missing
- `npm run package` — build `VibeNote.app` into `release/`
- `npm run smoke` — run the smoke test
- `npm run icon` — rebuild the app icon from `build/icon.svg`

## License

MIT — see [LICENSE](LICENSE). The bundled diagram editor is [draw.io](https://github.com/jgraph/drawio) (Apache-2.0), downloaded at build time and not part of this repository.
