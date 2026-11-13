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
- **Not available:** block-level edits and the `snapshotToken` conflict guard → conflict check = compare the page's version number right before pushing. **No attachment download on v1** → pictures come from Atlassian's newer MCP server (`/v2/mcp`, own sign-in, `executeRead` → `listConfluenceAttachments` / `getConfluenceAttachment` / `downloadConfluenceAttachment`, a short-lived signed link). They are saved in `<notes>/.confluence/pictures/<pageId>/` and shown inside the 🔒 boxes; the note text is unchanged, so Push is unaffected. draw.io diagrams match the page attachment `<diagram name>.png`; images match by file name, then by media file id. **No page status or label editing**; reading labels via CQL search is unconfirmed.
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

Per-note sync info is kept in front matter (plain file, syncable): `confluence: <page url>` and `confluence-version: N` (plus `confluence-type:` for whiteboards etc.). The page's original blocks (`{md, html}` each), the protected elements and the @mentioned people live in `<notes folder>/.confluence/<pageId>.json`, so they follow the note when it is moved.

### How it's built
- `src-main/atlassian.js` — VibeNote's own MCP client + OAuth (sign-in encrypted with the Keychain).
- `main.js` → `confluence:*` IPC: tree, page, save note + sidecar, push (with the version check).
- `src/confluence.js` — the converter. `fromConfluence(html)` → Markdown + blocks; `toConfluence(markdown, sidecar)` diffs the note's lines against the fetched blocks (LCS), keeps unchanged blocks' original HTML and converts only changed regions (tables get their widths / row numbers / header style back; ```confluence boxes are swapped back by their `#n`).
- `src/confluence-ui.js` — Fetch window (tick pages), Push window (summary, Publish / Save as draft), Pull latest.
- Mentions show as `[@Name](mention)`; the account id comes from the sidecar on push (unknown names stay plain text).
- After a publish the page is re-read, so the note and sidecar always match what Confluence stored.

## Build order

- [x] **1. Connection test (read-only).** Passed 2026-11-13: sign-in, page read, 70-item tree read. Code: `src-main/atlassian.js` (MCP client + OAuth, sign-in encrypted with the macOS Keychain in userData).
- [x] **2. Fetch.** (2026-11-13: 61 real pages fetched; converter round-trips all 61 pages exactly.) "From Confluence…" command: paste a link → choose "this page only" or "with all sub-pages" → notebooks and notes, protected blocks, natural matches.
- [x] **3. Push.** (2026-11-13: tested on a private scratch page — edits arrive, untouched blocks byte-identical, conflict refused.) "Push to Confluence" button: shows what will change, changes only edited blocks, stops if the page version changed, option "save as Confluence draft". "Pull latest" to refresh a note.
- [ ] **4. Claude panel.** Claude knows the protected-block rules and doesn't break them.
- [ ] **5. Extras.** Live Jira chips, comments panel (read-only), new Confluence page from a note.
  - [x] New page from a note: Push on a normal note (pick a fetched page/folder or paste a link) or drag a note onto a Confluence notebook → `createConfluencePage` under that parent (a folder's id comes from a page inside it), then the note moves into the Confluence tree and is re-fetched so it's linked (front matter + sidecar). Publish only (no draft) for new pages.
  - Network: on a company network that re-signs HTTPS with an untrusted proxy certificate, Atlassian calls fail; VibeNote trusts the Mac's certificates and says so plainly (never disables verification).
- Later: 3-way merge when the page changed in Confluence (we have the base copy), a "changed since fetch" dot in the note list, keep Confluence's page order in the note list, Jira lists in a note, create Jira tickets from a checklist, open a Jira ticket as a note, @mention autocomplete, move pages by dragging, replying to comments.

## Safety rules while building

- Tests push only to a scratch page in the owner's personal Confluence space, never a team page.
- Tests run against a temporary profile and notes folder (see CLAUDE.md, *Testing*).
- Every push must be previewable first, and must refuse to run if the page changed in Confluence since the last fetch.
- Test sign-ins use a throwaway profile, never the real one. Nothing from the work site (page content, titles, names) goes into the repo — it is public.
