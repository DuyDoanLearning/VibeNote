# Hand-over — status after the 2026-11-17 session (`agent` branch)

A note for Claude picking this up in another session or on another Mac. Read `CLAUDE.md` first (owner, workflow,
branches, testing rules), then this. The repo is **public**: never put work content (Confluence site name, page
titles or ids, colleagues' names, company names) in it.

## Where things stand

- `main` + newest tag **`v1.3.0-stable`** = the stable app. On 2026-11-17 the owner made everything up to sub-notes official (v1.3.0: sub-notes, publish a notebook, picture upload, HTML pages, zoom, new icon). v1.2.1 (2026-11-14): nested project Documents tree. On 2026-11-14 the owner made everything below official
  (`agent` merged into `main`). `v1.1.0-stable` = before Projects; `v1.0.2-stable` = the last notes-only release.
- **`agent`** = where new work starts; it is committed, pushed and installed on the owner's main Mac.
- Before making a new stable release: merge `agent` → `main`, tag `vX.Y.Z-stable`, update the README version table.
  (The smoke test was fixed on 2026-11-13 evening: it now sets the title in the title field; `npm run smoke` passes
  on both branches.)

## New on `agent` since v1.1.0 (2026-11-13, late evening)

**Projects workspace, step 1** (spec and next steps: `docs/workspace-spec.md`): Projects sidebar section, project
home page, multi-repo workspace (repositories found inside the linked folder; nested CLAUDE.md verified to load in a
live test), several chats per project with a switcher in the Claude panel, project chip on notes. Tested with
`projects:*` / `agent:thread-*` IPC in an isolated profile plus one tiny live Haiku chat. Not yet used by the owner on
real projects: expect feedback. The owner's real "VibeNote Dev" notebook shows up as a project automatically
(it has a linked folder).

**Step 3 (2026-11-14): coding layout, Changes review with line comments for Claude, file viewer**, and automatic
recovery when Claude Code no longer has a chat's conversation. See `docs/workspace-spec.md` → Step 3 and CLAUDE.md →
Code view. Tested in an isolated profile including one live Haiku round (comment on a diff line → Claude fixed it →
the Changes view refreshed).

**Step 2 (2026-11-14): draw.io diagrams** inside VibeNote, **a model / effort / mode per chat**, and earlier chats
open directly from the home page. See `docs/workspace-spec.md` → Step 2 and CLAUDE.md → Diagrams. Tested in an
isolated profile (open, save through the editor's message, outside change reloads, write guards, a real 67 KB
diagram renders). Real keyboard shortcuts inside the editor could not be tested automatically.

## 2026-11-19: Allow everything, helper agents view

- **Allow everything** (`allowAll`, a VibeNote mode, per chat or as the default in Settings → Claude): the SDK runs in its normal `default` mode and VibeNote's `canUseTool` approves everything itself (`autoAllowed` in main.js) except AskUserQuestion / ExitPlanMode and risky Bash (`RISKY`). A PreToolUse hook (`mustAsk` → `permissionDecision: 'ask'`) forces risky commands back to the user even when a settings rule would allow them. **Don't map it to the SDK's `acceptEdits`**: that mode lets `rm` / `mv` in the working folder through without calling `canUseTool` (found in the live test). Switching a chat to it approves its waiting cards.
- **Helper agents** (`src/agent-helpers.js`): agent.js now forwards a helper's own steps (`sub_tool` with id, `sub_text`, `sub_result`, `sub_progress`); main `record()` keeps them on the Task/Agent tool item (`sub`, `task`) so they survive reopening. Panel: live line under the helper's row, "N helpers working" strip, and a helper view (asked prompt, steps with results, report). Tested with simulated events and one live Haiku chat (Explore helper, no permission cards, `rm -rf` still asked; test chats deleted from `~/.claude/projects`).
- The owner also floated a real terminal running `claude` inside the app: not built (needs a native module, node-pty, and would bypass VibeNote's cards, note snapshots and project context). Offered as an option.

## 2026-11-17 (afternoon): sub-notes, zoom, new icon

- **Sub-notes (page tree like Confluence):** a note with sub-notes = a notebook with its own page (`Plan/Plan.md`), the convention fetched Confluence pages already used. The Notebooks section is now a page tree (`pageTree` in renderer.js, shared with the Confluence section): notes show under expanded notebooks. Right-click a note → **Add Sub-note** (`makeParent` / `addSubNote`). Drag and drop in the sidebar (`dropInto`): note on note = sub-note, note/notebook on notebook = move, a parent note or notebook moves with everything inside (`notebook:move` IPC), empty space under the tree = top level. Renaming a parent note renames its folder (`note:save`, `isOwnPageFile`); renaming a notebook renames its own page (`notebook:rename`). Projects can't be moved. Publish notebook makes a parent page with sub-pages for such notes. Tested in an isolated profile (add, rename both ways, drag note/list item/parent, refuse dropping into itself, assets follow) and with a stand-in for Atlassian for publishing (not yet live).
- **Click to zoom** Mermaid diagrams and pictures in the preview (`src/zoom-view.js`); Confluence pictures zoom in-app too.
- **New app icon** (Espresso: cream note with a red bookmark ribbon on brown, `build/icon.svg` → `npm run icon`), also as the sidebar logo and the empty-state mark (inline SVG in index.html).

## 2026-11-17: Publish a notebook to Confluence

- Right-click a notebook → **Publish to Confluence…**: notebook → Confluence folder, notes → pages, sub-notebooks → sub-folders. Notes already linked to a page push their edits there; API specs / HTML pages are skipped. Notes stay in their notebook (linked). Details: `docs/confluence-spec.md` → Publish a notebook.
- Tested live under the owner's private scratch page (test profile + throwaway notes): first publish (2 folders, 3 pages, a picture, private top folder), a simulated failure after page creation (retry pushed to the same page, no duplicate), a second publish (remembered folders, one edited note pushed, one new note added), and a notebook rename (folder link follows).
- Also fixed for every Push: a list mixing bullets and to-dos is split before sending (Confluence rejected it).

## 2026-11-16 (evening): HTML pages

- A `.html` file in the notes folder is a note of kind `'html'` (like API specs: no front matter, title = file name, own extension; `rawKind()` / `RAW_META()` in main.js). Editor = CodeMirror HTML; the preview is the real page (`src/html-view.js`).
- The page is served by `serveHtmlPages()` from `vibe-html://page/<absolute path>` (only files inside the notes folder, via `inRoot`) into an iframe with `sandbox="allow-scripts allow-popups allow-modals allow-forms"`, **never** `allow-same-origin`. Unsaved text is sent with `html:preview` (`htmlLive`), so the page updates while typing (reload 400 ms after typing stops).
- A small script is appended to every served page: keeps the scroll position across reloads (`?y=`) and posts clicked http(s)/mailto links to the app, which opens them in the browser. (The frame itself can't navigate to a website: the app's CSP `frame-src` blocks it, so a `will-frame-navigate` handler never fires.)
- Verified in an isolated profile: the page's `parent.api` / `parent.document` / `localStorage` / `fetch('secret.md')` are all blocked; relative pictures load; live update; saved exactly as typed; rename keeps `.html`; links open in the browser; switching to a normal note removes the frame.
- Markdown notes keep stripping scripts from inline HTML (DOMPurify in `src/markdown.js`).

## 2026-11-14 (morning, owner's main Mac)

- **VibeNote Guide**: a built-in project shipped in `guide/` and synced into `<notes>/VibeNote Guide` on start (`syncGuide` in main.js; per notes folder in `config.guides`). Untouched notes are refreshed when the shipped text changes; edited or deleted ones are respected; Help → VibeNote Guide (`open-guide`) restores it. **When a user-facing feature changes, update the matching `guide/` note** (as well as `welcome.md`).
- Project home: cards in balanced columns ("fill the gaps", `masonry` in project-ui.js); repository rows on two lines.
- Documents window: sectioned tree (Notebooks / Confluence pages / API specs), folding, ticking a folder includes its children, Selected strip.
- Diagrams: Delete (to the macOS Trash) from the sidebar, the project page and the editor toolbar.
- Shortcut clash fixed: ⇧⌘J = /claude, **⌥⌘J = Coding layout**.

## What v1.1.0 brought into stable (newest first)

| Feature | Where | Notes |
|---|---|---|
| **Changes to push** — Confluence pages edited but not pushed: orange *edited* label, sidebar row, window with Show changes / Push / **Push all** | `src/changes-ui.js`, `confluence:bases` in main.js, `pushMany` in `src/confluence-ui.js` | Push all never overwrites a page changed in Confluence meanwhile (version check → "skipped"). |
| **Inline writing suggestions** — grey text at the end of a line, Tab accepts, Esc dismisses | `src/ghost.js`, `Suggester` in `src-main/agent.js`, `suggest:get` | One warm Claude process (no tools, `persistSession: false`, thinking off), recycled every 12 suggestions, closed after 5 idle min. ~2–3 s per suggestion (Claude Code login has no faster path). |
| **Per-feature models** — Settings → Claude: panel, comments & fixes, /claude writing, inline suggestions | `MODEL_OPTS` in renderer.js; `commentModel`, `writeModel`, `suggestModel`, `inlineSuggest` settings | '' = same as panel. |
| **Esc stops Claude** in the panel | `src/agent-panel.js` | Result line says "Stopped by you". |
| **Publish a note as a new Confluence page** — Push on a normal note, or drag a note onto a Confluence page/folder in the sidebar | `publishNote` in `src/confluence-ui.js`, `confluence:create` in main.js | `createConfluencePage` under the chosen parent (a folder's id = parent of a page inside it); the note moves into the Confluence tree and is re-fetched so it's linked. **Only tested with a stand-in for Atlassian — real end-to-end test still pending** (do it under the owner's private scratch page in their personal space; ask them for the link). |
| To-do items with plain sub-bullets → extra lines in the item | `flattenList` in `src/confluence.js` | Confluence rejects a bullet list inside a task list (400 "Task Node type expected"). |
| **Slash commands in the Claude panel** — `/model`, `/effort`, `/usage`, `/context`, `/mcp`, `/clear`, `/chats`, `/mode`, `/help` + all Claude Code commands/skills; model button in the header | `src/agent-slash.js`, `agent:*` IPC | `/usage` uses the SDK's experimental usage API (falls back to rate-limit events). |
| **/claude and @Claude use the project's Claude panel chat** as background (switchable in the /claude box) | `panelChat()` in main.js | Newest ~16k chars of what was said, no tool output. |
| **Live Claude panel** — thinking (summarised), steps as they start with one-line results, diffs, to-dos, helper progress, status line with time and tokens | `src-main/agent.js` handle(), `src/agent-panel.js` | `thinking: { type: 'adaptive', display: 'summarized' }`. |
| **Claude Chats window** — past Claude Code chats per folder (Terminal / VS Code / app) **and T3 Code threads**; read, continue in the panel, save as note | `claude-chats.js`, `src/chats-ui.js`, `chats:*` IPC | Read-only on `~/.claude/projects` and `~/.t3/userdata/statev2.sqlite` (node:sqlite, readOnly). Continue = `resume` + `forkSession` in the chat's own folder. T3-only threads continue as a new chat with the old thread as background. |
| **Confluence pictures** (images, draw.io) inside the 🔒 boxes | `downloadPictures` in main.js | Needs Atlassian's newer MCP server (`/v2/mcp`, its own one-time sign-in); files in `<notes>/.confluence/pictures/<pageId>/`. The owner's real app is signed in to v2 (checked 2026-11-16). |
| **Picture upload on Push / Publish** (pasted images → page attachments) | `confluence:upload` in main.js, `withPictures` in `src/confluence-ui.js`, placeholders in `src/confluence.js` | Tested live 2026-11-16 on a private scratch page in the owner's personal space: upload, placement, re-fetch as 🔒 box, picture download. |
| Note list: group by notebook / tag / type, collapsible headings, Expand/Collapse all, Note / Confluence / API badges | `groupedNotes` etc. in renderer.js | |
| Earlier: Confluence fetch/push, comments, API specs + Swagger/Reference, links/backlinks, edit history for people and Claude, /claude, resizable panes | see `docs/confluence-spec.md` and the git log | |

## Setting up on another Mac

1. `git fetch --all --tags && git checkout agent && npm install`, then `sh scripts/install-version.sh agent`.
   The first build downloads the draw.io editor (~50 MB, from the draw.io GitHub releases) into
   `~/Library/Caches/VibeNote/`; without it everything works except opening diagrams.
2. Claude Code must be installed and logged in (`claude` once in Terminal).
3. In VibeNote: link each project to its code folder again (the project's home page → *Link a code folder*, or
   Claude panel → ⋯) — links are per machine (`config.projects`). Chats, "last looked" times and diagram backups
   are per machine too. A project itself (its notebook and `Project brief.md` with the document list) travels with
   the notes folder.
4. Atlassian: the first Fetch opens a browser sign-in (main connection). Pictures need a second, separate sign-in
   (newer server). Both are stored encrypted in the Keychain on that Mac only.
5. T3 Code threads only show if T3 Code is installed on that Mac.

## Testing — what worked today

- **Never** run the app under test against the real profile: `app.setPath('userData', <temp>)` before requiring
  `main.js`, temp notes folder in `config.root`.
- **Stand-in for Atlassian:** after `require('main.js')`, `ipcMain.removeHandler('confluence:create' | 'confluence:push'
  | 'confluence:page' | 'confluence:status')` and register fake handlers. Tests the whole VibeNote side without
  touching Confluence.
- **Converter tests:** bundle `src/confluence.js` with esbuild as an IIFE and run it in a hidden BrowserWindow.
- **Claude usage costs money/plan:** keep live tests tiny (Haiku, one-line prompts, throwaway folder). A
  `claude -p` run in a fresh folder costs ~$0.16 (cache setup). Delete test chat folders from
  `~/.claude/projects` afterwards.
- **Company network:** on the owner's office network a web proxy re-signs HTTPS to `mcp.atlassian.com` with a
  corporate certificate that is *not* trusted on the Mac → all of VibeNote's Atlassian calls fail there. VibeNote
  trusts the Mac's certificates (`tls.setDefaultCACertificates`) and shows a plain message; it never disables
  verification. Real Atlassian tests only work off that network (home Wi-Fi / hotspot).

## Parked / next (see `docs/ideas.md`)

- #18 **Confluence sync & comments**: Sync button + periodic check that marks pages changed by others, Pull all;
  Confluence comments (footer + inline) in the comments panel with replies. Owner parked it.
- #16 chats ↔ notes/code links, #17 project memory note (backlog).
- Real end-to-end tests pending: Publish new page (picture upload on Publish uses the same path as Push, but Publish itself is still only stand-in tested).
- Test profile gotcha: `scratchpad/atl-profile` once had a stale v1 `discovery` entry pointing at v2 ("Protected resource …/v2/mcp does not match expected …/v1/mcp"); clearing that key fixed it. The real profile was fine.
- Known: Swagger docs are light-only; Node fetch ignores macOS proxy settings.
