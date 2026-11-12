#!/bin/sh
# Build any version of VibeNote from git and install it into /Applications.
#
#   scripts/install-version.sh                # the newest stable release (latest v*-stable tag)
#   scripts/install-version.sh agent          # the latest experimental build
#   scripts/install-version.sh <commit/tag>   # any other version
#
# Your notes and settings are untouched: they live outside the app.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$REPO" fetch -q --tags origin 2>/dev/null || true
REF="${1:-$(git -C "$REPO" tag -l 'v*-stable' --sort=-v:refname | head -1)}"
WORK="$(mktemp -d)"
echo "→ Building VibeNote at '$REF'…"
git -C "$REPO" fetch -q --tags origin 2>/dev/null || true
git -C "$REPO" worktree add -q --detach "$WORK/src" "$REF"
trap 'git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
cd "$WORK/src"
npm ci --silent
npm run package --silent >/dev/null
echo "→ Installing into /Applications…"
osascript -e 'tell application "VibeNote" to quit' >/dev/null 2>&1 || true
sleep 2
rm -rf /Applications/VibeNote.app
cp -R release/VibeNote-darwin-*/VibeNote.app /Applications/
open -a /Applications/VibeNote.app
echo "✓ VibeNote '$REF' ($(git rev-parse --short HEAD)) is installed."
