# Confluence sync — spec

> Agreed with the owner on 2026-11-13. Experimental: lives on the `agent` branch. Stable `main` is not touched.

## Why

Work documents live in Confluence. Today that means copy-pasting between Confluence and VibeNote in both directions. The goal: **fetch** a Confluence page tree into VibeNote, **edit** it here (by hand and with the Claude panel), then **push** the changes back with one button.

## Decisions

- [x] **VibeNote signs in to Atlassian itself.** It talks to Atlassian's MCP server directly (OAuth sign-in in the browser, once). Fetch and Push do not go through Claude and do not use Claude usage. The sign-in is kept in the macOS Keychain (Electron `safeStorage`), never in the repo, which is public.
- [x] **Pages are rich**: tables with lists inside cells, @mentions, dates, draw.io diagrams, panels. Push must never remove what Markdown can't show.
- [x] **Scope of v1: pages, folders and the nested tree.** Whiteboards and databases are only links.
- [x] **v1 extras:** natural matches (see below), live Jira chips, a comments panel, and "new Confluence page from a note".

## What we learned from a real page (AI Services Architecture, space VV)

Atlassian's own Markdown export is **lossy**. It reports `lossyConversion: true`; draw.io diagrams and dates disappear, multi-paragraph table cells get glued together, lists in cells are flattened, and the automatic row numbers become a real column. **Never push that Markdown back.**

The HTML format gives every block a hidden `data-local-id`, and Atlassian's update operation can change single blocks by that id (`edits`: replaceNode / insertNodeAfter / deleteNode …). It also refuses an update when the page changed since we read it (`snapshotToken`). So:

- VibeNote converts Confluence HTML ↔ Markdown **itself**.
- **Push only sends the blocks that changed** ("surgical push"). Everything else, including diagrams, stays exactly as it is in Confluence.

## How it maps

| Confluence | VibeNote |
|---|---|
| Folder | Notebook (folder) |
| Page with sub-pages | Notebook, with the page itself as its first note |
| Page | Note (`.md`) |
| Page order | Kept |
| Whiteboard / database | Note with a link to open it in Confluence |
| Draft page | Skipped by default |
| Labels | Tags |
| Page status (Draft, In progress, Ready for review, Verified) | Status |
| Info / note / warning / tip panels | Callouts (`> [!NOTE]` …) |
| Tasks | Checkboxes |
| Expand sections | Collapsible sections |
| draw.io diagram | Picture in the preview + "Edit in Confluence"; protected block in the Markdown |
| Jira issue (macro or key) | Live chip: key, title, status |
| @mention, date, anything else | Protected block: shown as a labelled chip/box, put back unchanged on push |
| Table with lists or several paragraphs in a cell | Markdown table using `<br>` / inline HTML in the cell |

Per-note sync info is kept in front matter (plain file, syncable): `confluence: { site, id, version, url }`. The original HTML of protected blocks and the block-id map live in a plain sidecar file in the notebook (`.confluence/<pageId>.json`), next to `.assets/`.

## Build order

- [ ] **1. Connection test (read-only).** VibeNote signs in to Atlassian and reads one page and its tree. Confirms the company allows the connection.
- [ ] **2. Fetch.** "From Confluence…" command: paste a link → choose "this page only" or "with all sub-pages" → notebooks and notes, images into `.assets/`, protected blocks, natural matches.
- [ ] **3. Push.** "Push to Confluence" button: shows what will change, sends only changed blocks, stops on conflict, option "save as Confluence draft". "Pull latest" to refresh a note.
- [ ] **4. Claude panel.** Claude knows the protected-block rules and doesn't break them.
- [ ] **5. Extras.** Live Jira chips, comments panel (read-only), new Confluence page from a note.
- Later: Jira lists in a note, create Jira tickets from a checklist, open a Jira ticket as a note, @mention autocomplete, move pages by dragging, replying to comments.

## Safety rules while building

- Tests push only to a scratch page in the owner's personal Confluence space, never a team page.
- Tests run against a temporary profile and notes folder (see CLAUDE.md, *Testing*).
- Every push must be previewable first, and must refuse to run if the page changed in Confluence since the last fetch.
