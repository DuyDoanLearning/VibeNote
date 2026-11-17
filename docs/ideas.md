# Ideas backlog

Ideas discussed with the owner (2026-11-13), not yet decided or built. Owner's top picks are marked ⭐.

## Understanding your own code
1. ⭐ **"Why does this line exist?"**: select a line of code and see the spec note, plan step and change-log entry that created it (git blame for *intent*). Needs commits linked to plan steps and specs.
2. **Code tours**: Claude writes a tour note with numbered stops; each stop is a clickable file:line link that opens the code beside the explanation.
3. **Check-your-understanding cards**: after a build step, 2–3 optional quick questions about what changed.
4. **A living architecture diagram**: Mermaid diagram in the Codebase map, updated after each phase; boxes link to explanation notes.
5. **Decision notes**: when Claude picks between options, it saves what the options were, why, and the cost of changing later.

## Safer experiments
6. ⭐ **A branch per spec**: each spec builds on its own git branch; **Try it** launches that build beside the stable app; **Merge** / **Throw away** from the note.
7. **Tracked changes for Claude's note edits**: snapshot before Claude edits a note, show its edits as accept/reject changes.

## Notes superpowers
8. ⭐ **Sync through git**: the notes folder becomes a private GitHub repo that VibeNote auto-commits and pushes; conflicts open as mine-vs-theirs. (Owner wants sync between Macs; Mac-only, no mobile.)
9. **Daily digest note**: what was written, what Claude built, open plan steps.
10. **Inbox tidy-up**: Claude *suggests* notebook/tags/links for Inbox notes; the user accepts each.
11. **Graph view** of note links.
12. **Talk your ideas in**: dictate (Vietnamese or English) → Claude turns it into a spec note.

## Project hub
15. **Project vibe coding** (owner, 2026-11-13, still forming): one place per project for all its docs (incl. Confluence pages), where the owner writes and controls the notes and the AI reads them, writes code and reports back as notes.
16. **Chats ↔ notes and code** (backlog, 2026-11-13): Claude Code transcripts record which files each chat edited → a spec note shows "🔗 Discussed in 3 chats", a code file "Changed in these chats". Feeds ⭐ "Why does this line exist?". (Claude Chats window — browse, continue, save as note — is built.)
17. **Project memory note** (backlog, 2026-11-13; uses Claude usage): Claude reads a project's past chats and keeps one living note — decisions, architecture choices, open TODOs, things tried that failed — which the Claude panel reads first in every new chat.
18. **Confluence sync & comments** (parked by owner, 2026-11-13): a Sync button + quiet check every ~15 min that marks pages changed by others ("Updated by X · 2h ago"), Pull all for untouched notes, both-changed pages listed separately; Confluence footer/inline comments in the comments panel (with replies posted to Confluence, 💬 count for new ones). Works only off the office network (proxy). Test first whether one CQL search can check all page versions.

## Projects workspace (spec: `docs/workspace-spec.md`)
19. **Step 1 — Projects, home page, multi-repo workspace, several chats per project**: built on `agent`, 2026-11-13.
20. **Step 2 — Draw.io editor** inside VibeNote: built on `agent`, 2026-11-14 (plus a model per chat).
21. **Step 3 — Coding layout**, changes review with line comments for Claude, file viewer: built on `agent`, 2026-11-14.
22. **Step 4 — Spec watch**: a followed Confluence page changes → what changed, and which code / API specs it affects.
23. **Step 5 — Figma → API proposal**: frame beside the API spec editor, Claude drafts endpoints linked to the screen.
24. **Start coding from a document** (owner's idea, 2026-11-13): a "Build this" button on a spec that opens a chat on the right repository with the document attached (plan → approve → code); possibly hand over to T3 Code instead.
25. **Distill a chat into a note**; **Trace chats** across upstream/downstream repositories (read-only, saved as a note).

26. **Project memory** (owner, 2026-11-13): a project remembers what was learned and decided across chats.
27. **Link local folders as context** (owner): attach any folder on the Mac to a project, read-only.
28. **Codebase memory MCP** (owner): integrate a code-indexing MCP server so every agent in a project grabs codebase context fast when a "coding" task starts.
29. Diagrams: rename/delete in the app, embed or link diagrams in notes, version history.

## Fun
13. "Explain like I'm 5" toggle on explanation notes.
14. Weekly recap card.

## Brainstorm 2026-11-17 (owner will think about these later)

### One workplace app
30. **Today page for the whole app**: Confluence pages that changed, Claude chats waiting for an answer, open plan steps, unticked checkboxes from all notes, code news.
31. **Quick capture from anywhere**: a global shortcut drops a thought into the Inbox even while VibeNote is hidden.
32. **One search for everything**: notes, Claude chats, Confluence pages and code from the same ⌘K.
33. **Jira beside Confluence** (same Atlassian sign-in): a spec shows its tickets; turn a checklist line into a ticket.
34. **Two notes side by side**, or tabs.
35. Owner to list the moments in a normal workday when they leave VibeNote for another app; each one is a candidate feature.

### What users say about similar apps (web research; mostly blogs quoting Reddit, rough picture)
- Obsidian: loved for plain files you keep if you quit; most disliked is paying monthly for sync; hard for non-technical people.
- Notion: most common complaint is complexity; trust drops after sync bugs or AI deleting content. Common pattern: Notion for teams, lasting knowledge in Obsidian.
- Obsidian + Claude Code setups: the vault turns into a "junk drawer", AI writing drifts into filler, upkeep kills most setups; the praised value is finding old context again.
- Closest to VibeNote: Nimbalyst (specs, diagrams, mockups, Claude Code/Codex side panel, every AI change approved as a diff; free for individuals, MIT). Also Novi Notes (Mac, local-first, MCP, one-time purchase).
- VibeNote's answer to the trust complaints: plain files, Allow/Deny cards, version history. Not seen elsewhere: Confluence two-way sync + Claude + code review in one app.

### Paid product (business model)
36. Options: free app + paid service (sync/publish, voluntary work license); pay once with 1 year of updates (common for Mac apps, ~$29–99); subscription. Suggestion: free open-source notes app + paid "Work" edition (Confluence/Jira, project workspace, sync), pay once ~$39–49 with a year of updates or a yearly work license a company pays. Likely buyers: developers whose specs live in Confluence and who code with Claude.
37. Before selling: (a) the Claude panel must use the buyer's own API key (third-party apps can't use people's Claude subscription login without Anthropic's approval); (b) Apple Developer account for signing, notarization and auto-update; (c) the repo is public MIT, so either sell convenience (sync, signed builds) or keep paid features in a private part of the code.

### Sync between Macs (see ⭐ 8)
38. Today: the app syncs through GitHub + install script; notes (`~/Documents/VibeNotes`) don't sync; settings, chats, Atlassian sign-in and project links stay per Mac on purpose. Options: **A. iCloud Drive** (no building; risk of silent "Note 2" copies, no history) or **B. Sync through git** (⭐ 8, ~1 day; history, mine-vs-theirs on clashes). Suggested: B, not both together. Check that work pages in the notes may live in a personal iCloud/GitHub.
