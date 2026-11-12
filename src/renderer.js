// VibeNote — renderer: UI state, editor, preview, list.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

const api = window.vibe;
const $ = (s) => document.querySelector(s);

// ---------- state ----------
function load(k, d) {
  try { const v = localStorage.getItem('vibe.' + k); return v ? JSON.parse(v) : d; } catch { return d; }
}
function store(k, v) {
  try { localStorage.setItem('vibe.' + k, JSON.stringify(v)); } catch {}
}

const S = {
  root: '',
  notebooks: [],
  notes: [],
  filter: load('filter', { type: 'all' }),
  query: '',
  current: null, // path of the open note
  dirty: false,
  fresh: new Set(), // notes created this session (empty ones get cleaned up)
  mode: load('mode', 'split'),
};

const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const currentNote = () => S.notes.find((n) => n.path === S.current);

function titleOf(content, fallback) {
  for (const line of content.split('\n')) {
    const s = line.replace(/^#{1,6}\s+/, '').trim();
    if (s) return s;
  }
  return fallback;
}

// ---------- editor ----------
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, color: 'var(--code)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--faint)' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '14.5px', lineHeight: '1.7' },
  '.cm-content': { maxWidth: '780px', margin: '0 auto', padding: '28px 32px 40vh', caretColor: 'var(--accent)' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--selection)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)' },
  '.cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--faint)' },
});

let suppressEdit = false;
function editorState(doc) {
  return EditorState.create({
    doc,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      editorTheme,
      syntaxHighlighting(mdHighlight),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (!suppressEdit) onEdit();
        schedulePreview();
        updateStatus();
      }),
    ],
  });
}

const view = new EditorView({ state: editorState(''), parent: $('#editor') });

function replaceDoc(text) {
  suppressEdit = true;
  const sel = view.state.selection.main.head;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(sel, text.length) },
  });
  suppressEdit = false;
}

// ---------- saving ----------
let saveTimer = null;
let listTimer = null;
let saveChain = Promise.resolve();

function onEdit() {
  S.dirty = true;
  const n = currentNote();
  if (n) {
    n.body = view.state.doc.toString();
    n.title = titleOf(n.body, n.name);
    n.mtime = Date.now();
  }
  setStatusSaved(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 200);
}

function save() {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(async () => {
    if (!S.current || !S.dirty) return;
    const from = S.current;
    const content = view.state.doc.toString();
    S.dirty = false;
    try {
      const to = await api.save(from, content);
      const n = S.notes.find((x) => x.path === from);
      if (n) Object.assign(n, { path: to, name: nameOf(to), title: titleOf(content, nameOf(to)), mtime: Date.now() });
      if (S.current === from) S.current = to;
      if (S.fresh.delete(from)) S.fresh.add(to);
      store('last', S.current);
      if (!S.dirty) setStatusSaved(true);
      renderList();
    } catch (e) {
      S.dirty = true;
      toast('Could not save: ' + e.message);
    }
  });
  return saveChain;
}

// ---------- data ----------
let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await saveChain;
    const data = await api.list();
    S.root = data.root;
    S.notebooks = data.notebooks;
    S.notes = data.notes;
    if (S.filter.type === 'notebook' && !S.notebooks.includes(S.filter.name)) S.filter = { type: 'all' };
    const cur = currentNote();
    if (S.current && !cur) {
      closeNote();
    } else if (cur) {
      const text = view.state.doc.toString();
      if (S.dirty) cur.body = text;
      else if (cur.body !== text) replaceDoc(cur.body);
    }
    renderAll();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Save the open note; silently drop it if it was created this session and left empty.
async function leaveCurrent() {
  await save();
  const p = S.current;
  if (p && S.fresh.has(p) && view.state.doc.toString().trim() === '') {
    S.fresh.delete(p);
    S.notes = S.notes.filter((n) => n.path !== p);
    try { await api.trash(p); } catch {}
  }
}

async function openNote(path) {
  if (path === S.current) return;
  await leaveCurrent();
  let body;
  try { body = await api.read(path); } catch { return refresh(); }
  S.current = path;
  S.dirty = false;
  view.setState(editorState(body));
  store('last', path);
  renderAll();
  renderPreview();
  updateStatus();
  setStatusSaved(true);
}

function closeNote() {
  S.current = null;
  S.dirty = false;
  view.setState(editorState(''));
  renderAll();
}

async function newNote() {
  const nb = S.filter.type === 'notebook' ? S.filter.name : '';
  await leaveCurrent();
  try {
    const p = await api.create(nb);
    S.fresh.add(p);
    S.query = '';
    $('#search').value = '';
    await refresh();
    await openNote(p);
    if (S.mode === 'preview') setMode('split');
    view.focus();
  } catch (e) {
    toast(e.message);
  }
}

async function moveNote(p, nb) {
  await save();
  try {
    const to = await api.move(p, nb);
    if (S.current === p) S.current = to;
    if (S.fresh.delete(p)) S.fresh.add(to);
    await refresh();
    toast(`Moved to ${nb || 'Inbox'}`);
  } catch (e) {
    toast(e.message);
  }
}

async function trashCurrent() {
  const n = currentNote();
  if (!n) return;
  if (!confirm(`Move “${n.title}” to the Trash?`)) return;
  await save();
  const list = visibleNotes();
  const i = list.findIndex((x) => x.path === n.path);
  const next = list[i + 1] || list[i - 1];
  try {
    await api.trash(n.path);
  } catch (e) {
    return toast(e.message);
  }
  S.fresh.delete(n.path);
  S.current = null;
  S.dirty = false;
  await refresh();
  if (next && S.notes.some((x) => x.path === next.path)) await openNote(next.path);
  else closeNote();
}

async function chooseFolder() {
  await leaveCurrent();
  const r = await api.chooseFolder();
  if (!r) return;
  closeNote();
  S.filter = { type: 'all' };
  store('filter', S.filter);
  await refresh();
  const first = visibleNotes()[0];
  if (first) openNote(first.path);
}

function startNewNotebook() {
  const wrap = $('#notebooks');
  const existing = wrap.querySelector('input');
  if (existing) return existing.focus();
  const input = document.createElement('input');
  input.className = 'nb-input';
  input.placeholder = 'Notebook name';
  wrap.prepend(input);
  input.focus();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    if (!ok || !name) return;
    try {
      const nb = await api.createNotebook(name);
      setFilter({ type: 'notebook', name: nb });
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- view helpers ----------
function visibleNotes() {
  const terms = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  return S.notes.filter((n) => {
    if (S.filter.type === 'inbox' && n.notebook) return false;
    if (S.filter.type === 'notebook' && n.notebook !== S.filter.name) return false;
    if (terms.length) {
      const hay = (n.title + '\n' + n.body).toLowerCase();
      if (!terms.every((q) => hay.includes(q))) return false;
    }
    return true;
  });
}

function snippet(n) {
  const lines = n.body.split('\n');
  const start = lines.findIndex((l) => l.trim());
  return lines
    .slice(start + 1)
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|]|\[[ xX]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function fmtDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayFmt.format(d);
  return yearFmt.format(d);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- rendering ----------
function renderAll() {
  renderSidebar();
  renderList();
  renderToolbar();
}

function makeDropTarget(node, notebook) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/vibe-note')) return;
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('drop');
    const p = e.dataTransfer.getData('text/vibe-note');
    if (p) moveNote(p, notebook);
  });
}

function renderSidebar() {
  $('#count-all').textContent = S.notes.length || '';
  $('#count-inbox').textContent = S.notes.filter((n) => !n.notebook).length || '';
  document.querySelectorAll('.nav-item[data-filter]').forEach((b) => {
    b.classList.toggle('active', S.filter.type === b.dataset.filter);
  });

  const wrap = $('#notebooks');
  const input = wrap.querySelector('input');
  wrap.textContent = '';
  if (input) wrap.append(input);
  for (const nb of S.notebooks) {
    const b = el('button', 'nav-item nb');
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2zM5 18a2 2 0 012-2h12"/></svg>';
    b.append(el('span', 'label', nb), el('span', 'count', String(S.notes.filter((n) => n.notebook === nb).length || '')));
    b.classList.toggle('active', S.filter.type === 'notebook' && S.filter.name === nb);
    b.addEventListener('click', () => setFilter({ type: 'notebook', name: nb }));
    makeDropTarget(b, nb);
    wrap.append(b);
  }
  if (!S.notebooks.length && !input) wrap.append(el('div', 'hint', 'Notebooks are folders. Click + to add one.'));

  const folder = S.root.split('/').filter(Boolean).pop() || '';
  $('#folder-name').textContent = folder;
  $('#folder-btn').title = `${S.root}\nClick to change notes folder`;
}

function renderList() {
  const list = visibleNotes();
  const title =
    S.filter.type === 'all' ? 'All Notes' : S.filter.type === 'inbox' ? 'Inbox' : S.filter.name;
  $('#list-title').textContent = S.query ? `${list.length} result${list.length === 1 ? '' : 's'} in ${title}` : title;

  const ul = $('#notes');
  ul.textContent = '';
  if (!list.length) {
    ul.append(el('li', 'list-empty', S.query ? 'No matching notes' : 'No notes yet — press ⌘N'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const n of list) {
    const li = el('li', 'note');
    li.dataset.path = n.path;
    li.draggable = true;
    if (n.path === S.current) li.classList.add('active');
    li.append(el('div', 'note-title', n.title || 'Untitled'));
    const meta = el('div', 'note-meta', fmtDate(n.mtime));
    if (S.filter.type === 'all' && n.notebook) meta.append(el('span', 'badge', n.notebook));
    li.append(meta);
    const snip = snippet(n);
    if (snip) li.append(el('div', 'note-snippet', snip));
    li.addEventListener('click', () => openNote(n.path));
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/vibe-note', n.path);
      e.dataTransfer.effectAllowed = 'move';
    });
    frag.append(li);
  }
  ul.append(frag);
  ul.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function renderToolbar() {
  const n = currentNote();
  document.body.classList.toggle('no-note', !n);
  const sel = $('#nb-select');
  sel.textContent = '';
  sel.append(new Option('Inbox', ''));
  for (const nb of S.notebooks) sel.append(new Option(nb, nb));
  sel.value = n ? n.notebook : '';
  sel.disabled = !n;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function renderPreview() {
  const box = $('#preview');
  if (S.mode === 'edit' || !S.current) return;
  box.innerHTML = DOMPurify.sanitize(marked.parse(view.state.doc.toString(), { gfm: true }));
  box.querySelectorAll('pre code').forEach((c) => {
    try { hljs.highlightElement(c); } catch {}
  });
  box.querySelectorAll('a[href]').forEach((a) => {
    if (!a.getAttribute('href').startsWith('#')) a.target = '_blank';
  });
  const dir = S.current.slice(0, S.current.lastIndexOf('/'));
  box.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return;
    try { img.src = 'file://' + encodeURI(dir + '/' + decodeURI(src)); } catch {}
  });
}

function updateStatus() {
  const text = view.state.doc.toString();
  const words = (text.match(/\S+/g) || []).length;
  $('#status-words').textContent = S.current ? `${words} word${words === 1 ? '' : 's'}` : '';
}

function setStatusSaved(saved) {
  const s = $('#status-save');
  s.textContent = !S.current ? '' : saved ? 'Saved' : 'Editing…';
  s.classList.toggle('pending', !saved);
}

function setMode(m) {
  S.mode = m;
  store('mode', m);
  $('#panes').className = m;
  renderToolbar();
  renderPreview();
  if (m !== 'preview') view.requestMeasure();
}

function setFilter(f) {
  S.filter = f;
  store('filter', f);
  renderAll();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- wiring ----------
function bindUI() {
  const status = $('#status');
  status.append(el('span', '', ''), el('span', '', ''));
  status.children[0].id = 'status-words';
  status.children[1].id = 'status-save';

  document.querySelectorAll('.nav-item[data-filter]').forEach((b) => {
    b.addEventListener('click', () => setFilter({ type: b.dataset.filter }));
  });
  makeDropTarget($('.nav-item[data-filter="inbox"]'), '');
  $('#add-notebook').addEventListener('click', startNewNotebook);
  $('#folder-btn').addEventListener('click', chooseFolder);
  $('#new-note').addEventListener('click', newNote);
  $('#empty-new').addEventListener('click', newNote);
  $('#trash-btn').addEventListener('click', trashCurrent);
  $('#reveal-btn').addEventListener('click', () => S.current && api.reveal(S.current));
  $('#nb-select').addEventListener('change', (e) => S.current && moveNote(S.current, e.target.value));
  document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const search = $('#search');
  search.addEventListener('input', () => {
    S.query = search.value;
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      S.query = '';
      renderList();
      view.focus();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = visibleNotes();
      if (!list.length) return;
      e.preventDefault();
      const i = list.findIndex((n) => n.path === S.current);
      let j = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : Math.max(i, 0);
      j = Math.max(0, Math.min(list.length - 1, j));
      openNote(list[j].path).then(() => {
        if (e.key === 'Enter') view.focus();
      });
    }
  });

  api.onChanged(() => refresh());
  api.onCommand(async (cmd) => {
    switch (cmd) {
      case 'new-note': return newNote();
      case 'new-notebook':
        document.body.classList.remove('no-sidebar');
        return startNewNotebook();
      case 'search': search.focus(); return search.select();
      case 'reveal': return S.current && api.reveal(S.current);
      case 'trash': return trashCurrent();
      case 'choose-folder': return chooseFolder();
      case 'mode-edit': return setMode('edit');
      case 'mode-split': return setMode('split');
      case 'mode-preview': return setMode('preview');
      case 'toggle-sidebar': return document.body.classList.toggle('no-sidebar');
      case 'flush':
        await leaveCurrent();
        return api.flushed();
    }
  });
  window.addEventListener('blur', () => save());
}

(async function start() {
  bindUI();
  setMode(S.mode);
  await refresh();
  const last = load('last', null);
  const first = (last && S.notes.find((n) => n.path === last)) || visibleNotes()[0] || S.notes[0];
  if (first) await openNote(first.path);
})();
