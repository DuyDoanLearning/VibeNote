# Projects workspace — spec

Owner's goal (2026-11-13): VibeNote becomes the one place for a piece of work, not only its documents. A **project**
gathers the documents, designs, diagrams, code and chats that belong together, with every piece linked to the others.
VibeNote is where the owner decides, reviews and keeps track; heavy code editing stays in VS Code / T3 Code.

## What a project is

- A **top-level notebook** that has a `Project brief.md` note and/or a linked code folder.
- **It stays a plain file.** The brief is the project's file: its front matter lists extra documents that live
  elsewhere in the notes folder (`sources:` — Confluence pages, API specs, other notebooks), so the project syncs
  with the notes. Nothing is moved or copied.
- **Machine-specific:** the code folder path (`config.projects[name]`), "last looked" times (`config.projectSeen`)
  and chats (`userData/agent-chats/`).
- **The brief is what every chat reads first** (goal, key documents, what each repository does, decisions, open
  questions). It is added to the system prompt of the project's chats, so a fresh chat is never blind.

## Step 1 — built (agent branch, 2026-11-13)

- **Projects section** in the sidebar (+ = new project, or turn an existing notebook into one); status dot when a
  chat is working or needs an OK; right-click for home / new chat / add documents / link folder.
- **Project home page** (shown in the main area while no note is open): what changed since you last looked
  (documents changed, new commits per repository, chats waiting, Confluence pages to push), the brief, documents
  (notes + Confluence + API specs), code (repositories with branch, last commit, uncommitted files, own CLAUDE.md),
  chats (VibeNote chats with status, plus earlier Claude Code / T3 Code chats from the code folder).
- **Multi-repo workspace:** link one big folder; repositories inside are found (three levels deep). Chats run in
  the workspace folder, are told which repositories exist, and Claude Code loads each repository's own CLAUDE.md
  and skills when it works there (verified with a live test).
- **Several chats per project:** a chat switcher in the Claude panel; a chat can be focused on one repository
  (its working folder) and still read the rest of the workspace; chats keep running in the background with a
  status (working / needs your OK); waiting Allow/Deny cards come back when you return to that chat. Continuing a
  past chat now opens it as one more chat instead of replacing the open one.
- **Project chip** in the toolbar of any note that belongs to a project (also Confluence pages / API specs listed
  as its documents): click to go to the home page; the Claude panel follows the note's project.

Code: `projects.js` (repos, git info, sources), threads + `projects:*` IPC in `main.js`, `src/project-ui.js`
(sidebar, home, pickers), chat switcher in `src/agent-panel.js`.

## Step 2 — built (agent branch, 2026-11-13/14)

- **Diagrams**: `.drawio` files open in the full draw.io editor inside VibeNote (sidebar section *Diagrams*, the
  *Diagrams* card on a project's home page, or *Open Diagram File…* for a file anywhere on the Mac).
- Saves as you draw (the file as it was before the first change of a session is kept in
  `userData/diagram-backups/`, newest 10 per diagram); reloads when the file changes on disk, e.g. when Claude
  edits it. The Claude panel knows which diagram is open.
- The editor is the open-source draw.io web app (Apache-2.0), **not in this repo**: `build.mjs` downloads the
  pinned release once into `~/Library/Caches/VibeNote/`, checks its SHA-256 and unpacks a trimmed copy into
  `dist/drawio` (~58 MB). It runs in a frame with its own origin (`vibe-drawio://`) and a policy that only lets it
  load its own bundled files, so nothing in a diagram can leave the Mac.
- Also since step 1: **each chat has its own model, effort and permission mode** (Settings holds the defaults);
  clicking an earlier chat on the home page opens that chat (read it, or Continue it as a new project chat).

Not done: rename / delete a diagram from inside VibeNote (use Finder), diagrams inside notes (embed / link),
version history for diagrams, keyboard-shortcut clashes between VibeNote's menu and the editor are untested with
real keys.

## Next steps (in the order agreed)
3. **Coding layout**: chat in the centre with the doc or diff beside it; review Claude's changes as a diff and
   comment on lines (same comment model as notes); read-only code viewer for `file:line` links; "Open in VS Code".
4. **Spec watch**: when a followed Confluence page changes, show what changed and which code / API specs it
   affects.
5. **Figma → API proposal**: paste a frame link, see the screen beside the API spec editor, Claude drafts the
   endpoints linked to the screen (check what the owner's Figma seat allows first).

## Ideas attached to this spec

- **Start coding from a document** (owner, 2026-11-13): a "Build this" button on a spec/note that opens a new chat
  focused on the right repository with the document attached: plan first, owner approves, then code. Could also
  hand the task to T3 Code if it offers a way to start a thread from outside (not checked yet).
- **Distill a chat** into a note (decisions + open questions, linked back to the chat).
- **Trace chats**: read-only investigation across upstream/downstream repositories, saved as a note.
- **Project memory** (owner, 2026-11-13): what Claude learns in a project's chats is kept and reused (see ideas #17).
- **Link local folders as context** (owner): attach any folder on the Mac to a project as read-only context.
- **Codebase memory for agents** (owner): plug a code-indexing MCP server (the owner mentioned "codebase-memory")
  into project chats so agents get codebase context quickly instead of re-reading files; e.g. a per-project switch
  and index status on the home page. Note: VibeNote chats already load the MCP servers configured in Claude Code.
