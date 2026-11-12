# VibeNote Agent — spec

> Copy of the owner's spec note "VibeNote Dev/VibeNote Agent" (the original lives in their notes folder, which is not in this repo). If the two differ, the note on the owner's Mac is the latest; ask them, and update this copy.

## Why

AI writes a lot of code quickly, and it's easy to lose track of what's inside a project, including VibeNote itself. The goal is **note-driven development**: I write what I want in notes, an assistant plans and builds it, and the notes always explain what was done and why. That way I stay in control and keep understanding my own code.

## The idea

- A **project** is a notebook linked to a code folder (first project: VibeNote's own repo).
- I write a **Spec** note: what I want, in plain words.
- Claude writes a **Plan** into the note as checkboxes. I edit it before anything is built.
- Claude **builds one step at a time**: edits code, runs it, commits, and ticks the checkbox.
- After every commit, Claude adds an entry to the project's **Change log** note: what changed, why, which files, and the commit.
- A **Codebase map** note explains how the code is organised, in plain language, and is kept up to date.
- I can ask Claude to **explain** any file, function or commit, and the answer is saved as a note.

## The chat panel

- It sits on the right, next to the editor, like Claude Code, and knows which note I'm looking at.
- Claude can read and edit notes (I see the changes live), edit code, run commands and commit.
- Anything risky shows an **Approve / Deny** card first. Modes: *Ask every time*, *Auto-approve edits*, *Plan only*.
- Chats are saved per project and can be resumed later.
- Quick actions: **Plan this note**, **Build next step**, **Explain the codebase**, **What changed recently?**

## Decisions

- [x] Runs on **my installed Claude Code** and my existing Claude login (internal use only, no API key). Same approach as t3code: the Claude Agent SDK pointed at the installed `claude`.
- [x] If VibeNote is ever shared as a product, switch to API-key auth (Anthropic's rule for apps built on the Agent SDK).
- [x] **The stable markdown app comes first.** The agent is an experiment:
  - the stable version is git tag `v1.0-stable`
  - experiments happen on the `agent` branch
  - roll back any time with `scripts/install-version.sh v1.0-stable` (reinstalls that exact version into /Applications)

## Build order

- [x] **Phase 1, chat panel:** link a code folder to a notebook; a chat panel with streaming replies, Approve/Deny cards, permission modes, Stop, saved and resumable chats; quick actions; the current note as context.
- [ ] **Phase 2, note-driven loop:** Spec and Plan templates; Plan and Build buttons; checkboxes ticked automatically; change-log entries tied to commits.
- [ ] **Phase 3, understanding:** codebase map note; "explain this" saved as notes; a diff viewer for each commit.
- [ ] **Phase 4, later:** other agents (e.g. Codex) behind the same panel.

## How to use it (Phase 1)

- **⌘J** (or the ✦ button in the toolbar) opens the Claude panel. It knows which note you are viewing.
- This notebook (**VibeNote Dev**) is linked to the VibeNote code folder, so Claude can work on the app itself.
- Panel menu (⋯): **New Chat**, **Link / Unlink a code folder**.
- Mode menu: **Ask every time** (safest), **Auto-approve edits**, **Plan only**.
- Back to the stable app any time: `scripts/install-version.sh v1.0-stable` (in the VibeNote folder, in Terminal). Experimental again: `scripts/install-version.sh agent`.

## Open questions

- Should Claude's edits to notes be shown highlighted (like track changes) until I accept them?
- One chat per project, or one chat per spec note?
