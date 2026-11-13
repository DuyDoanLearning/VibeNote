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
20. **Step 2 — Draw.io viewer / editor** inside VibeNote (embedded open-source editor, live refresh when Claude edits the file).
21. **Step 3 — Coding layout**: chat in the centre, diff review with comments on lines, read-only code viewer, "Open in VS Code".
22. **Step 4 — Spec watch**: a followed Confluence page changes → what changed, and which code / API specs it affects.
23. **Step 5 — Figma → API proposal**: frame beside the API spec editor, Claude drafts endpoints linked to the screen.
24. **Start coding from a document** (owner's idea, 2026-11-13): a "Build this" button on a spec that opens a chat on the right repository with the document attached (plan → approve → code); possibly hand over to T3 Code instead.
25. **Distill a chat into a note**; **Trace chats** across upstream/downstream repositories (read-only, saved as a note).

## Fun
13. "Explain like I'm 5" toggle on explanation notes.
14. Weekly recap card.
