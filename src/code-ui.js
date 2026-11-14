// Code view: review what changed in a project's repository (uncommitted or one commit), read a file, and
// collect line comments to send to Claude. Read-only: editing code stays in your editor (Open in VS Code).
// Spec: docs/workspace-spec.md, step 3.
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlight, theme } from './editor.js';

const MAX_LINES = 1200; // per file, before "too long to show"

// git's unified diff → [{ path, old, status, binary, added, deleted, lines: [{ t: '+'|'-'|' '|'@', text, o, n }] }]
export function parseDiff(text) {
  const files = [];
  let f = null;
  let o = 0;
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { path: '', old: '', status: 'changed', binary: false, added: 0, deleted: 0, lines: [] };
      const m = / b\/(.*)$/.exec(line);
      if (m) f.path = m[1];
      files.push(f);
    } else if (!f) {
      continue;
    } else if (line.startsWith('new file mode')) f.status = 'new';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) { f.old = line.slice(12); f.status = 'renamed'; }
    else if (line.startsWith('rename to ')) f.path = line.slice(10);
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) f.binary = true;
    else if (line.startsWith('--- ')) { if (line !== '--- /dev/null' && !f.path) f.path = line.slice(6); }
    else if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') f.path = line.slice(6); }
    else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m) { o = Number(m[1]); n = Number(m[2]); f.lines.push({ t: '@', text: m[3].trim() }); }
    } else if (line.startsWith('+')) { f.lines.push({ t: '+', text: line.slice(1), n: n++ }); f.added++; }
    else if (line.startsWith('-')) { f.lines.push({ t: '-', text: line.slice(1), o: o++ }); f.deleted++; }
    else if (line.startsWith(' ')) f.lines.push({ t: ' ', text: line.slice(1), o: o++, n: n++ });
  }
  return files;
}

export function createCodeUI(ctx) {
  const { api, S, $, el, toast, leaveCurrent, closeNote, afterChange, getNotebook, askClaude } = ctx;
  S.code = null; // { tab: 'changes' | 'file', repo, commit, file, line }
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const ago = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  const view = $('#code-view');
  view.innerHTML = `
    <div class="cv-head">
      <div class="seg cv-tabs"><button data-tab="changes">Changes</button><button data-tab="file">File</button></div>
      <select class="cv-repo" title="Repository"></select>
      <select class="cv-commit" title="What to look at"></select>
      <span class="cv-file-name"></span>
      <span class="spacer"></span>
      <button class="ph-small cv-refresh" title="Read the changes again">Refresh</button>
      <button class="ph-small cv-vscode" title="Open this file in VS Code">Open in VS Code</button>
      <button class="icon cv-close" title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="cv-body">
      <div class="cv-changes"></div>
      <div class="cv-file"></div>
    </div>
    <div class="cv-review">
      <div class="cv-pending"></div>
      <div class="cv-comment">
        <span class="cv-target">Click a line to comment on it</span>
        <input class="cv-input" placeholder="Your comment for Claude…" spellcheck="false" disabled>
        <button class="btn cv-add" disabled>Add</button>
        <button class="btn primary cv-send" hidden>Send to Claude</button>
      </div>
    </div>`;
  const changesBox = $('.cv-changes', view);
  const fileBox = $('.cv-file', view);
  const repoSel = $('.cv-repo', view);
  const commitSel = $('.cv-commit', view);
  const input = $('.cv-input', view);

  let repos = [];
  let comments = []; // { file (repo-relative or absolute), line, code, text, where }
  let target = null; // the line being commented on
  let cm = null; // file viewer
  let seq = 0;

  const repoOf = () => repos.find((r) => r.path === S.code?.repo) || null;
  const relIn = (file) => { const r = repos.find((x) => file.startsWith(x.path + '/')); return r ? `${r.rel ? r.rel + '/' : ''}${file.slice(r.path.length + 1)}` : file.replace(/^\/Users\/[^/]+/, '~'); };

  // ---------- comments for Claude ----------
  function setTarget(t) {
    target = t;
    view.querySelectorAll('.dl.picked').forEach((x) => x.classList.remove('picked'));
    t?.node?.classList.add('picked');
    $('.cv-target', view).textContent = t ? `${t.file.split('/').pop()}:${t.line}` : 'Click a line to comment on it';
    $('.cv-target', view).title = t ? `${t.file}:${t.line}  ${t.code.trim()}` : '';
    input.disabled = !t;
    $('.cv-add', view).disabled = !t;
    if (t) input.focus();
  }

  function renderPending() {
    const box = $('.cv-pending', view);
    box.textContent = '';
    comments.forEach((c, i) => {
      const chip = el('span', 'cv-chip');
      chip.append(el('strong', '', `${c.file.split('/').pop()}:${c.line}`), document.createTextNode(` ${c.text}`));
      chip.title = `${c.file}:${c.line}\n${c.code.trim()}`;
      const x = el('button', 'tag-x', '×');
      x.addEventListener('click', () => { comments.splice(i, 1); renderPending(); });
      chip.append(x);
      box.append(chip);
    });
    const send = $('.cv-send', view);
    send.hidden = !comments.length;
    send.textContent = `Send ${comments.length} to Claude`;
  }

  function addComment() {
    const text = input.value.trim();
    if (!target || !text) return;
    comments.push({ file: target.file, line: target.line, code: target.code, text, where: target.where });
    target.node?.classList.add('commented');
    input.value = '';
    setTarget(null);
    renderPending();
  }

  async function sendReview() {
    if (!comments.length) return;
    const where = [...new Set(comments.map((c) => c.where).filter(Boolean))].join('; ');
    const lines = comments.map((c, i) => `${i + 1}. \`${c.file}\` line ${c.line}: \`${c.code.trim().slice(0, 160)}\`\n   ${c.text}`);
    const msg = `I reviewed the code${where ? ` (${where})` : ''} and have ${comments.length === 1 ? 'a comment' : `${comments.length} comments`}. Go through ${comments.length === 1 ? 'it' : 'each one'}: change the code where I asked for a change, answer where I asked a question, and tell me briefly what you did.\n\n${lines.join('\n')}`;
    const n = comments.length;
    comments = [];
    view.querySelectorAll('.dl.commented').forEach((x) => x.classList.remove('commented'));
    renderPending();
    await askClaude(msg, `Review: ${n} comment${n === 1 ? '' : 's'}`);
  }

  // ---------- changes ----------
  function fileBlock(f, repo, where) {
    const d = el('details', 'cv-diff');
    d.open = f.lines.length <= 400;
    const sum = el('summary');
    const badge = el('span', `cv-badge ${f.status}`, f.status === 'changed' ? 'M' : f.status === 'new' ? 'A' : f.status === 'deleted' ? 'D' : 'R');
    badge.title = { changed: 'Changed', new: 'New file', deleted: 'Deleted', renamed: `Renamed from ${f.old}` }[f.status];
    sum.append(badge, el('span', 'cv-path', f.path));
    if (f.added) sum.append(el('span', 'cv-plus', `+${f.added}`));
    if (f.deleted) sum.append(el('span', 'cv-minus', `−${f.deleted}`));
    if (f.status !== 'deleted') {
      const open = el('button', 'ph-small', 'Open');
      open.title = 'Show the whole file';
      open.addEventListener('click', (e) => { e.preventDefault(); openFile(`${repo.path}/${f.path}`); });
      sum.append(el('span', 'spacer'), open);
    }
    d.append(sum);
    const body = el('div', 'cv-lines');
    if (f.binary) body.append(el('div', 'cv-note', 'Binary file — not shown.'));
    else if (f.lines.length > MAX_LINES) body.append(el('div', 'cv-note', `This change is ${f.lines.length} lines long. Open the file to read it.`));
    else {
      const frag = document.createDocumentFragment();
      for (const l of f.lines) {
        if (l.t === '@') { frag.append(el('div', 'dl hunk', l.text ? `⋯ ${l.text}` : '⋯')); continue; }
        const row = el('div', `dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`);
        row.append(el('span', 'ln', l.o ?? ''), el('span', 'ln', l.n ?? ''), el('span', 'sign', l.t === ' ' ? '' : l.t), el('span', 'code', l.text || ' '));
        row.addEventListener('click', () => {
          if (getSelection()?.toString()) return; // the user is selecting text to copy
          setTarget({ node: row, file: `${repo.rel ? repo.rel + '/' : ''}${f.path}`, line: l.n ?? l.o, code: l.text, where });
        });
        frag.append(row);
      }
      body.append(frag);
    }
    d.append(body);
    return d;
  }

  async function loadChanges() {
    const my = ++seq;
    const repo = repoOf();
    changesBox.textContent = '';
    if (!repo) { changesBox.append(el('div', 'cv-empty', 'This project has no git repository linked. Link a code folder on the project’s home page.')); return; }
    changesBox.append(el('div', 'cv-empty', 'Reading the changes…'));
    let data;
    try { data = await api.code.diff(repo.path, S.code.commit || ''); } catch (e) { changesBox.textContent = ''; changesBox.append(el('div', 'cv-empty', errText(e))); return; }
    if (my !== seq || !S.code) return;
    const files = parseDiff(data.diff);
    for (const u of data.untracked || []) {
      const lines = u.text == null ? [] : u.text.replace(/\n$/, '').split('\n').map((t, i) => ({ t: '+', text: t, n: i + 1 }));
      files.push({ path: u.path, old: '', status: 'new', binary: u.text == null, added: lines.length, deleted: 0, lines });
    }
    const where = `${repo.rel || repo.name}, ${S.code.commit ? `commit ${S.code.commit}` : 'not committed yet'}`;
    changesBox.textContent = '';
    if (!files.length) {
      changesBox.append(el('div', 'cv-empty', S.code.commit ? 'This commit changed no files.' : 'Nothing has changed since the last commit. Pick a commit above to review what was committed.'));
      return;
    }
    const total = files.reduce((a, f) => [a[0] + f.added, a[1] + f.deleted], [0, 0]);
    const sum = el('div', 'cv-summary');
    sum.append(document.createTextNode(`${files.length} file${files.length === 1 ? '' : 's'} changed `), el('span', 'cv-plus', `+${total[0]}`), document.createTextNode(' '), el('span', 'cv-minus', `−${total[1]}`));
    if (data.moreUntracked) sum.append(document.createTextNode(`  ·  ${data.moreUntracked} more new files not shown`));
    changesBox.append(sum);
    for (const f of files) changesBox.append(fileBlock(f, repo, where));
  }

  async function loadCommits() {
    const repo = repoOf();
    commitSel.textContent = '';
    commitSel.append(new Option(`Not committed yet${repo?.changed ? ` (${repo.changed})` : ''}`, ''));
    if (!repo) return;
    try {
      for (const c of await api.code.log(repo.path)) commitSel.append(new Option(`${c.hash}  ${c.subject.slice(0, 60)}  ·  ${ago(c.at)}`, c.hash));
    } catch {}
    commitSel.value = S.code?.commit || '';
  }

  // ---------- file viewer ----------
  async function showFile(path, line) {
    const my = ++seq;
    fileBox.textContent = '';
    cm?.destroy();
    cm = null;
    let data;
    try { data = await api.code.read(path); } catch (e) { fileBox.append(el('div', 'cv-empty', errText(e))); return; }
    if (my !== seq || !S.code) return;
    const lang = languages.find((l) => l.filename?.test(path.split('/').pop()) || l.extensions.includes(path.split('.').pop()));
    const exts = [
      lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), syntaxHighlighting(highlight), theme,
      EditorView.theme({ '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '1.55' }, '.cm-content': { maxWidth: 'none', padding: '8px 12px 40vh 4px' }, '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' }, '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', cursor: 'pointer' } }),
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet) return;
        const ln = u.state.doc.lineAt(u.state.selection.main.head);
        setTarget({ file: relIn(path), line: ln.number, code: ln.text, where: '' });
        S.code.line = ln.number;
      }),
    ];
    if (lang) { try { exts.push(await lang.load()); } catch {} }
    if (my !== seq) return;
    cm = new EditorView({ state: EditorState.create({ doc: data.text, extensions: exts }), parent: fileBox });
    if (line > 0) {
      const ln = cm.state.doc.line(Math.min(line, cm.state.doc.lines));
      cm.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
    }
  }

  // ---------- view state ----------
  function render() {
    const c = S.code;
    if (!c) return;
    view.querySelectorAll('.cv-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === c.tab));
    $('.cv-tabs [data-tab=file]', view).disabled = !c.file;
    const changes = c.tab === 'changes';
    changesBox.hidden = !changes;
    fileBox.hidden = changes;
    repoSel.hidden = !changes || repos.length < 2;
    commitSel.hidden = !changes;
    $('.cv-refresh', view).hidden = !changes;
    $('.cv-file-name', view).hidden = changes;
    $('.cv-vscode', view).hidden = changes || !c.file;
    $('.cv-file-name', view).textContent = c.file ? relIn(c.file) : '';
    $('.cv-file-name', view).title = c.file || '';
  }

  async function show() {
    await leaveCurrent();
    await ctx.closeOthers?.();
    closeNote();
    document.body.classList.add('code-open');
    afterChange();
  }

  async function loadRepos() {
    try {
      const r = await api.code.repos(getNotebook());
      repos = r.repos;
      repoSel.textContent = '';
      for (const x of repos) repoSel.append(new Option(`${x.rel || x.name}${x.changed ? `  (${x.changed})` : ''}`, x.path));
      return r.current;
    } catch { repos = []; return null; }
  }

  // Open the review of what changed. repo: a repository path, or empty for the one the open chat works in.
  async function openChanges(repo, commit = '') {
    const current = await loadRepos();
    S.code = { tab: 'changes', repo: repos.some((r) => r.path === repo) ? repo : current, commit, file: S.code?.file || null, line: S.code?.line || 0 };
    repoSel.value = S.code.repo || '';
    await show();
    render();
    await loadCommits();
    await loadChanges();
  }

  async function openFile(path, line = 0) {
    if (!repos.length) await loadRepos();
    S.code = { tab: 'file', repo: S.code?.repo || repos.find((r) => path.startsWith(r.path + '/'))?.path || null, commit: S.code?.commit || '', file: path, line };
    await show();
    render();
    await showFile(path, line);
  }

  // A path as written in a chat ("src/app.js:42" or absolute) → open it if it exists in the project.
  async function openMention(text) {
    const m = /^(.*?)(?::(\d+))?(?:[:-]\d+)?$/.exec(String(text).trim());
    const file = await api.code.resolve(getNotebook(), m[1]);
    if (!file) return false;
    await openFile(file, Number(m[2]) || 0);
    return true;
  }

  function close(quiet) {
    if (!S.code) return;
    S.code = null;
    seq++;
    cm?.destroy();
    cm = null;
    setTarget(null);
    document.body.classList.remove('code-open');
    if (!quiet) afterChange();
  }

  // Claude finished a turn while the changes are showing → read them again.
  let soon = null;
  api.agent.onEvent(({ evt }) => {
    if (evt.kind !== 'result' || S.code?.tab !== 'changes' || S.code.commit) return;
    clearTimeout(soon);
    soon = setTimeout(async () => { if (S.code?.tab === 'changes') { await loadRepos(); repoSel.value = S.code.repo || ''; await loadCommits(); await loadChanges(); } }, 600);
  });

  view.querySelectorAll('.cv-tabs button').forEach((b) => b.addEventListener('click', async () => {
    if (!S.code || b.disabled || S.code.tab === b.dataset.tab) return;
    S.code.tab = b.dataset.tab;
    setTarget(null);
    render();
    if (S.code.tab === 'changes') { if (!repos.length) { S.code.repo = await loadRepos(); repoSel.value = S.code.repo || ''; } await loadCommits(); await loadChanges(); }
    else await showFile(S.code.file, S.code.line);
  }));
  repoSel.addEventListener('change', async () => { S.code.repo = repoSel.value; S.code.commit = ''; await loadCommits(); await loadChanges(); });
  commitSel.addEventListener('change', () => { S.code.commit = commitSel.value; loadChanges(); });
  $('.cv-refresh', view).addEventListener('click', async () => { await loadRepos(); repoSel.value = S.code.repo || ''; await loadCommits(); await loadChanges(); });
  $('.cv-vscode', view).addEventListener('click', () => S.code?.file && api.code.openEditor(S.code.file, S.code.line || 0));
  $('.cv-close', view).addEventListener('click', () => close());
  $('.cv-add', view).addEventListener('click', addComment);
  $('.cv-send', view).addEventListener('click', sendReview);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(); sendReview(); }
    else if (e.key === 'Enter') { e.preventDefault(); addComment(); }
    else if (e.key === 'Escape') setTarget(null);
  });

  return { openChanges, openFile, openMention, close, pendingComments: () => comments.length };
}
