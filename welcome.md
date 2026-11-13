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
- Link notes with double brackets, like [[Welcome to VibeNote]]

## Confluence

- Click **+** next to **Confluence** in the sidebar, paste a page link, tick the pages you want and **Fetch**. Sub-pages become notebooks.
- Edit the note, then click **Push** to send your changes back. Only the parts you changed are updated; diagrams, macros and images (the 🔒 boxes) stay as they are.
- If someone changed the page in Confluence meanwhile, Push stops. Use **Pull Latest from Confluence** (⌘K) to refresh.

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
