# VibeNote

A Markdown note-taking app for macOS, built with Electron. Everything is stored as **plain files** — notes are `.md` files, notebooks are folders — so they stay readable, greppable and easy to back up or sync.

## Features

- Markdown editor (CodeMirror 6) with live preview, split / edit / preview modes, focus mode
- Notebooks (nested folders), tags, status (Active / On hold / Completed / Dropped), pinned notes
- Search with filters: `tag:x`, `book:x`, `status:x`, `title:x`, `is:pinned`, `-negate`
- Command palette (⌘K), heading outline (⇧⌘O), back / forward between notes
- `[[Wiki links]]` between notes, with autocomplete
- Slash commands (`/`), emoji (`:fire`), code-language suggestions, formatting shortcuts, smart list indenting
- Paste / drag images; paste URLs as titled links
- Preview: GFM tables & task lists (clickable), KaTeX math, Mermaid diagrams, callouts (`> [!TIP]`), footnotes, `==highlight==`
- Version history per note, in-app Trash with restore
- Export to HTML / PDF, print
- Themes: built-in light/dark, **any VS Code colour theme** installed on the machine, “Same as VS Code”, or import `.json` / `.vsix`
- Vim key bindings, line numbers, spell check, font / width settings

## Claude panel (experimental, `agent` branch)

Press **⌘J** to open a chat with Claude next to your notes. Link a notebook to a code folder (panel → ⋯ → *Link a Code Folder*) and Claude can plan in your notes, edit code, run commands, commit, and keep a plain-language **Change log** note. Every risky step shows an **Allow / Deny** card first.

It runs on **your installed [Claude Code](https://claude.com/claude-code)** and its existing login (via the Claude Agent SDK), so install Claude Code and run `claude` once to sign in. This is meant for personal use; an app distributed to others should use API-key authentication instead.

### Versions and rollback

| Version | Where |
|---|---|
| Stable markdown app | branch `main`, tags `v*-stable` (newest: `v1.0.1-stable`) |
| Experimental (Claude panel) | branch `agent` |

Install any version into /Applications (notes and settings are not touched):

```sh
scripts/install-version.sh              # back to the newest stable release
scripts/install-version.sh agent        # the experimental build
scripts/install-version.sh <commit>     # anything else
```

## Getting started on a new machine

Requirements: macOS, [Node.js](https://nodejs.org) 20+ and git.

```sh
git clone https://github.com/DuyDoanLearning/VibeNote.git
cd VibeNote
npm install
npm start            # build and run in development
```

Install it as a normal app:

```sh
npm run package      # → release/VibeNote-darwin-<arch>/VibeNote.app
cp -R release/VibeNote-darwin-*/VibeNote.app /Applications/
```

The app isn't code-signed, so the first launch may need right-click → **Open**.

## Where data lives

| What | Where |
|---|---|
| Notes | `~/Documents/VibeNotes` by default (File → Change Notes Folder…) |
| Notebook | a folder; nested folders = nested notebooks |
| Tags / status / pinned | YAML front matter at the top of each note |
| Pasted images | `<notebook>/.assets/`, linked relatively |
| Trash | `<notes>/.trash/` (+ `index.json` remembering the original notebook) |
| Version history | `~/Library/Application Support/VibeNote/history/` (local only) |
| Settings | `~/Library/Application Support/VibeNote/config.json` |

The notes folder is self-contained, so it can be synced between Macs (iCloud Drive, Dropbox, git…). History and settings stay per machine.

## Project layout

| File | What it does |
|---|---|
| `main.js` | Electron main process: windows, menus, all file access (notes, trash, history, export, link titles) |
| `themes.js` | Finds / loads / imports VS Code colour themes; “Same as VS Code” |
| `preload.js` | The only bridge between UI and main (`window.vibe.*`) |
| `src/renderer.js` | UI: sidebar, note list, toolbar, palette, settings, history, commands |
| `src/editor.js` | CodeMirror setup: autocomplete, paste/drop, ⌘-click links |
| `src/typing.js` | Formatting commands, lists, slash commands, emoji, line tools |
| `src/markdown.js` | Markdown → HTML (marked + wiki links, math, highlight, footnotes, callouts, Mermaid) |
| `src/theme.js` | Maps a VS Code theme to VibeNote's CSS variables |
| `src/search.js` | Search filters and fuzzy matching |
| `src/agent-panel.js` | The Claude chat panel (messages, tool activity, Allow/Deny cards, questions, plans) |
| `src-main/agent.js` | Agent host: Claude Agent SDK driving the installed Claude Code (bundled to `dist/agent.mjs`) |
| `styles.css` / `markdown.css` | App styles / preview + export styles |
| `welcome.md` | Note created on first run |
| `scripts/smoke-test.js` | Launches the app against a throwaway profile and takes screenshots |
| `scripts/install-version.sh` | Builds a given git version and installs it into /Applications (rollback) |

## Scripts

- `npm start` — build the renderer and run the app
- `npm run build` — bundle `src/` into `dist/` (esbuild) and copy KaTeX / Mermaid assets
- `npm run package` — build `VibeNote.app` into `release/`
- `npm run smoke` — run the smoke test (prints where the screenshots are saved)

## License

MIT — see [LICENSE](LICENSE).
