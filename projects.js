// Projects: helpers for the project workspace (spec: docs/workspace-spec.md).
// A project is a top-level notebook that has a "Project brief.md" note and/or a linked code folder (workspace).
// The brief is the project's plain file: its front matter lists extra documents ("sources") that live elsewhere in
// the notes folder (Confluence pages, API specs, other notebooks), so the project syncs with the notes.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');

const BRIEF = 'Project brief.md';
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '.venv', '__pycache__', 'Pods', 'release', 'out']);

const BRIEF_TEMPLATE = `## Goal

What is this project for? One or two sentences.

## Key documents

- The specs, pages and notes that matter most.

## Code

- Which repositories are involved and what each one does.

## Decisions

- Decisions made so far, newest first, each with a short why.

## Open questions

-
`;

// fsmonitor/hooks off: these are read-only status questions and must never run anything a repo configures.
const git = (cwd, args, timeout = 5000) => new Promise((resolve) => {
  execFile('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
});

// Git repositories in a workspace folder: the folder itself (if it is one) and repos nested up to maxDepth levels.
async function findRepos(root, maxDepth = 3, cap = 40) {
  const out = [];
  const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
  if (isRepo(root)) out.push({ name: path.basename(root), path: root, rel: '' });
  async function scan(dir, depth) {
    if (depth > maxDepth || out.length >= cap) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name) || out.length >= cap) continue;
      const full = path.join(dir, e.name);
      if (isRepo(full)) out.push({ name: e.name, path: full, rel: path.relative(root, full) });
      else await scan(full, depth + 1);
    }
  }
  await scan(root, 1);
  return out;
}

// Files matching `re` under a folder (hidden and dependency folders skipped).
async function findFiles(root, re, maxDepth = 4, cap = 50) {
  const out = [];
  async function scan(dir, depth) {
    if (depth > maxDepth || out.length >= cap) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || out.length >= cap) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await scan(path.join(dir, e.name), depth + 1); }
      else if (re.test(e.name)) out.push(path.join(dir, e.name));
    }
  }
  if (root) await scan(root, 0);
  return out;
}

// Branch, last commit, uncommitted files, whether it has its own guide for Claude, commits since `since` (ms).
async function repoInfo(repo, since) {
  const [branch, last, status, fresh] = await Promise.all([
    git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repo.path, ['log', '-1', '--format=%h%x1f%s%x1f%ct']),
    git(repo.path, ['status', '--porcelain']),
    since ? git(repo.path, ['rev-list', '--count', `--since=${Math.floor(since / 1000)}`, 'HEAD']) : null,
  ]);
  const [hash, subject, at] = (last || '').trim().split('\x1f');
  return {
    ...repo,
    branch: (branch || '').trim() || null,
    last: hash ? { hash, subject, at: Number(at) * 1000 } : null,
    changed: status == null ? null : status.split('\n').filter(Boolean).length,
    newCommits: fresh == null ? 0 : Number(fresh.trim()) || 0,
    hasGuide: fs.existsSync(path.join(repo.path, 'CLAUDE.md')) || fs.existsSync(path.join(repo.path, '.claude', 'CLAUDE.md')),
    hasSkills: fs.existsSync(path.join(repo.path, '.claude', 'skills')),
  };
}

// "sources:" in the brief's front matter (kept verbatim in meta.extra by the note parser):
//   sources:
//     - "Confluence/Space/Feature X"
function parseSources(extra) {
  const lines = String(extra || '').split('\n');
  const i = lines.findIndex((l) => /^sources:\s*$/.test(l));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = /^\s+-\s+(.*)$/.exec(lines[j]);
    if (!m) break;
    let v = m[1].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch {} }
    if (v) out.push(v);
  }
  return out;
}

function setSources(extra, list) {
  const lines = String(extra || '').split('\n').filter((l, i, a) => !(l === '' && a.length === 1));
  const i = lines.findIndex((l) => /^sources:\s*$/.test(l));
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && /^\s+-\s+/.test(lines[j])) j++;
    lines.splice(i, j - i);
  }
  const clean = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  if (clean.length) lines.push('sources:', ...clean.map((s) => `  - ${JSON.stringify(s)}`));
  return lines.join('\n').trim();
}

module.exports = { BRIEF, BRIEF_TEMPLATE, findRepos, findFiles, repoInfo, parseSources, setSources };
