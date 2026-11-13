# Confluence sync — spec

> Agreed with the owner on 2026-11-13. Experimental: lives on the `agent` branch. Stable `main` is not touched.

## Why

Work documents live in Confluence. Today that means copy-pasting between Confluence and VibeNote in both directions. The goal: **fetch** a Confluence page tree into VibeNote, **edit** it here (by hand and with the Claude panel), then **push** the changes back with one button.

## Decisions

- [x] **VibeNote signs in to Atlassian itself.** It talks to Atlassian's MCP server directly (OAuth sign-in in the browser, once). Fetch and Push do not go through Claude and do not use Claude usage. The sign-in is kept in the macOS Keychain (Electron `safeStorage`), never in the repo, which is public.
- [x] **Pages are rich**: tables with lists inside cells, @mentions, dates, draw.io diagrams, panels. Push must never remove what Markdown can't show.
- [x] **Scope of v1: pages, folders and the nested tree.** Whiteboards and databases are only links.
- [x] **v1 extras:** natural matches (see below), live Jira chips, a comments panel, and "new Confluence page from a note".

## What we learned from a real work page

Atlassian's own Markdown export is **lossy**. It reports `lossyConversion: true`; draw.io diagrams and dates disappear, multi-paragraph table cells get glued together, lists in cells are flattened, and the automatic row numbers become a real column. **Never push that Markdown back.**

The HTML format gives every block a hidden `data-local-id`, and Atlassian says HTML is round-trip safe (keeps those ids and inline comments). So:

- VibeNote converts Confluence HTML ↔ Markdown **itself**.
- **Push only changes the blocks you edited** ("surgical push"). VibeNote's direct connection can't update single blocks (see below), so it rebuilds the page body from the HTML it fetched, swapping in only the changed blocks; everything else, including diagrams, is sent back byte-for-byte unchanged.

## What VibeNote's own connection can do (connection test, 2026-11-13)

- Sign-in works on the owner's company site (OAuth in the browser, no admin block). Reconnecting with the saved sign-in takes ~2 s; reading a page ~1 s.
- The server (`https://mcp.atlassian.com/v1/mcp`) gives VibeNote 32 actions — a smaller, older set than the claude.ai connector. The ones we use: `getConfluencePage` (html / markdown / adf), `getConfluencePageDescendants` (pages, folders, whiteboards; up to 10 levels, 250 items), `updateConfluencePage` (replaces the whole body; can save as draft), `createConfluencePage`, footer/inline comments, `searchConfluenceUsingCql`, and Jira: `getJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`, transitions.
- **Not available:** block-level edits and the `snapshotToken` conflict guard → conflict check = compare the page's version number right before pushing. **No attachment download** → images and draw.io pictures can't be shown yet; they appear as "Image / diagram — open in Confluence" boxes (possible later via an API token, only for pictures). **No page status or label editing**; reading labels via CQL search is unconfirmed.
- Sample of 12 real pages: tasks are common (80 task items), plus code blocks, mentions, emoji, images, draw.io.

## How it maps

| Confluence | VibeNote |
|---|---|
| Folder | Notebook (folder) |
| Page with sub-pages | Notebook, with the page itself as its first note |
| Page | Note (`.md`) |
| Page order | Kept |
| Whiteboard / database | Note with a link to open it in Confluence |
| Draft page | Skipped by default |
| Labels | Tags (read-only, if CQL search returns them) |
| Page status (Draft, In progress, Ready for review, Verified) | Not available through this connection |
| Info / note / warning / tip panels | Callouts (`> [!NOTE]` …) |
| Tasks | Checkboxes |
| Expand sections | Collapsible sections |
| draw.io diagram, image | Protected box "Diagram / image — open in Confluence" (pictures need attachment access, not available yet) |
| Jira issue (macro or key) | Live chip: key, title, status |
| @mention, date, anything else | Protected block: shown as a labelled chip/box, put back unchanged on push |
| Table with lists or several paragraphs in a cell | Markdown table using `<br>` / inline HTML in the cell |

Per-note sync info is kept in front matter (plain file, syncable): `confluence: { site, id, version, url }`. The original HTML of protected blocks and the block-id map live in a plain sidecar file in the notebook (`.confluence/<pageId>.json`), next to `.assets/`.

## Build order

- [x] **1. Connection test (read-only).** Passed 2026-11-13: sign-in, page read, 70-item tree read. Code: `src-main/atlassian.js` (MCP client + OAuth, sign-in encrypted with the macOS Keychain in userData).
- [ ] **2. Fetch.** "From Confluence…" command: paste a link → choose "this page only" or "with all sub-pages" → notebooks and notes, protected blocks, natural matches.
- [ ] **3. Push.** "Push to Confluence" button: shows what will change, changes only edited blocks, stops if the page version changed, option "save as Confluence draft". "Pull latest" to refresh a note.
- [ ] **4. Claude panel.** Claude knows the protected-block rules and doesn't break them.
- [ ] **5. Extras.** Live Jira chips, comments panel (read-only), new Confluence page from a note.
- Later: Jira lists in a note, create Jira tickets from a checklist, open a Jira ticket as a note, @mention autocomplete, move pages by dragging, replying to comments.

## Safety rules while building

- Tests push only to a scratch page in the owner's personal Confluence space, never a team page.
- Tests run against a temporary profile and notes folder (see CLAUDE.md, *Testing*).
- Every push must be previewable first, and must refuse to run if the page changed in Confluence since the last fetch.
- Test sign-ins use a throwaway profile, never the real one. Nothing from the work site (page content, titles, names) goes into the repo — it is public.
