---
tags: [guide]
pinned: true
---
Your notes are plain **Markdown files** in a folder on your Mac. Folders are notebooks (they can be nested), and tags, status and pins live at the top of each file.

## Get around

- **⌘K** command palette: jump to any note or run any command
- **⌘N** new note · **⇧⌘N** new notebook · **⇧⌘F** search
- **⌘1 / ⌘2 / ⌘3** editor · split · preview · **⇧⌘↵** focus mode
- Right-click notes, notebooks and the Trash for more options
- Drag the borders between the sidebar, note list, editor, preview and side panels to resize them (double-click a border to reset)

## Organise

- Add tags and a status in the bar above the editor
- Pin important notes with **⌥⌘P**
- Search with filters: `tag:guide`, `book:Ideas`, `status:active`, `title:welcome`, `is:pinned`, `-tag:old`
- The title lives in the big field above the editor; it's also the file name
- Link notes with double brackets, like [[Welcome to VibeNote]] — also Confluence pages and API specs. Add `#` to go deeper: `[[Some note#A heading]]` or `[[My API#GET /users/{id}]]` (type `[[`, then `#`, to pick from a list)
- A note shows **🔗 Linked from** when other notes link to it. Links to Confluence pages you've fetched open your local copy (⌘-click for the browser)

## Confluence

- Click **+** next to **Confluence** in the sidebar, paste a page link, tick the pages you want and **Fetch**. Sub-pages become notebooks.
- Edit the note, then click **Push** to send your changes back. Only the parts you changed are updated; diagrams, macros and images (the 🔒 boxes) stay as they are.
- If someone changed the page in Confluence meanwhile, Push stops. Use **Pull Latest from Confluence** (⌘K) to refresh.

## Ask Claude to write

- Type **/claude** on a new line (or press **⇧⌘J**) and ask for something: a table, a checklist, a summary, a diagram… Claude's Markdown appears as it's written; click **Insert** to add it.
- Select text first and press **⇧⌘J** to have Claude rewrite it (**Replace**). Type a new request in the box to adjust the result.

## API specs (Swagger / OpenAPI)

- **⌥⌘N** (or **+** next to **APIs** in the sidebar) creates an API spec (a `.yaml` file, marked **API** in the list). **All API specs** also lists notes and Confluence pages that contain one. Edit the YAML on the left; the Swagger docs update on the right. Mistakes show as “Line N: …” — click to jump there.
- **Try it out → Execute** calls the real API from VibeNote (no browser CORS errors). Tokens entered under **Authorize** are forgotten when VibeNote closes.
- A ` ```yaml ` OpenAPI block inside any note (e.g. a Confluence page) gets an **⚡ API docs** button in the preview.
- **/claude** works in specs too: “add a POST /bookings endpoint with a 409 conflict response”.

## Comments

- Select text and click **💬** (or **⌥⌘M**) to comment on it; **⇧⌘M** shows all comments.
- Type **@Claude** in a comment (or click **Ask Claude**) and Claude replies in the thread. If it suggests a change, you see before → after and choose **Accept** or **Reject**.
- On Confluence pages, **Post to Confluence** puts a comment on the page for your team. Comments otherwise stay private, in a hidden `.comments` folder next to your notes.

## Write

- [x] Paste or drag images straight into a note
- [ ] Click this checkbox in the preview

Math: $E = mc^2$

```mermaid
graph LR
  Idea --> Note --> Done
```
