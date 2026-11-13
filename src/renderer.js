// VibeNote — renderer: state, sidebar, note list, editor/preview, palette and dialogs.
import { createEditor } from './editor.js';
import { renderMarkdown, postProcess, setLinkResolver } from './markdown.js';
import { parseQuery, matchQuery, fuzzy } from './search.js';
import { applyTheme } from './theme.js';
import { createAgentPanel } from './agent-panel.js';
import { createConfluenceUI, CONFLUENCE_ROOT } from './confluence-ui.js';
import { confluenceInfo } from './confluence.js';
import { createComments } from './comments.js';
import { setupResizers } from './resize.js';
import { createWriter } from './writer.js';
import { createApiDocs } from './apidocs.js';
import { createChatsUI } from './chats-ui.js';
import { createChangesUI } from './changes-ui.js';
import { diffLines } from 'diff';
import { splitTarget, parseOperation, apiOperations, embeddedSpecs, mdHeadings, linksTo } from './links.js';
import { toggleWrap, insertLink, setHeading, toggleTask, sortLines, changeCase, joinLines } from './typing.js';
import { moveLineUp, moveLineDown, copyLineDown, deleteLine } from '@codemirror/commands';

const api = window.vibe;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SINGLE = new URLSearchParams(location.search).get('note');

const STATUS = {
  active: { label: 'Active', color: '#3b82f6' },
  onhold: { label: 'On hold', color: '#f59e0b' },
  completed: { label: 'Completed', color: '#10b981' },
  dropped: { label: 'Dropped', color: '#9ca3af' },
};
const TAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];
function tagColor(tag) {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

const ICON = {
  all: '<svg viewBox="0 0 24 24"><path d="M4 5h16M4 12h16M4 19h10"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2zM5 18a2 2 0 012-2h12"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5"/></svg>',
  cmd: '<svg viewBox="0 0 24 24"><path d="M5 7l5 5-5 5M12 17h7"/></svg>',
  api: '<svg viewBox="0 0 24 24"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 00.6-7.95A6 6 0 006.2 9.5 4.3 4.3 0 007 18z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V5M7 10l5-5 5 5M5 19h14"/></svg>',
};

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
  sort: load('sort', 'updated'),
  group: load('group', 'folder'), // note list sections: folder | tag | type | none
  collapsed: new Set(load('collapsed', [])), // collapsed list sections ("folder:Work/Specs", "tag:idea", …)
  order: [], // notes in the order the list shows them (for ↑/↓)
  sections: [], // keys of the list's headings
  current: null, // path of the open note
  currentId: null, // file identity, survives renames done elsewhere
  meta: null, // metadata of the open note (source of truth while editing)
  dirty: false,
  touched: false, // edited since opened (→ snapshot on leave)
  fresh: new Set(), // notes created this session (empty ones get discarded)
  mode: load('mode', 'split'),
  expanded: new Set(load('expanded', [])),
  settings: {},
  back: [], // navigation history (paths)
  forward: [],
  navigating: false,
};

const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const parentOf = (nb) => (nb.includes('/') ? nb.slice(0, nb.lastIndexOf('/')) : '');
const leafOf = (nb) => nb.slice(nb.lastIndexOf('/') + 1);
const inBook = (n, nb) => n.notebook === nb || n.notebook.startsWith(nb + '/');
const live = () => S.notes.filter((n) => !n.trashed);
const currentNote = () => S.notes.find((n) => n.path === S.current);
const isTrashed = () => !!currentNote()?.trashed;
const isApi = () => currentNote()?.kind === 'api';
const langOf = (n) => (n?.kind === 'api' ? (/\.json$/i.test(n.path) ? 'json' : 'yaml') : 'markdown');
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function startsWithTitle(body, title) {
  const first = body.split('\n').find((l) => l.trim()) || '';
  return /^#\s/.test(first) && first.replace(/^#+\s+/, '').trim() === title;
}

const API_ROOT = 'APIs'; // top-level notebook for API specs (own sidebar section)
const kindOf = (n) => (n.kind === 'api' ? 'api' : confluenceInfo(n.meta) ? 'confluence' : 'note');
// [[Title#frag]] → { note, frag }. A title may itself contain '#', so try the whole thing first.
function findByTarget(target) {
  const whole = findByTitle(target);
  if (whole) return { note: whole, frag: '' };
  const { title, frag } = splitTarget(target);
  return { note: findByTitle(title), frag };
}

function findByTitle(t) {
  const q = t.trim().toLowerCase();
  const l = live();
  return l.find((n) => n.title.toLowerCase() === q) || l.find((n) => n.name.toLowerCase() === q);
}

// ---------- editor ----------
let comments = null; // comments panel (created further down; the editor reports selections and clicks to it)
const editor = createEditor({
  parent: $('#editor'),
  // Inline suggestions: grey text when you pause at the end of a line (Tab accepts). Settings → Claude.
  suggest: {
    canSuggest: () => S.settings.inlineSuggest !== false && !!S.current && !isApi() && !isTrashed() && S.mode !== 'preview' && !document.querySelector('.cw:not([hidden])'),
    getSuggestion: ({ before, after }) => api.suggest({ title: S.meta?.title || '', before, after }),
  },
  onChange(userEdit) {
    if (userEdit) onEdit();
    schedulePreview();
    updateStatus();
  },
  onFiles: attachFiles,
  onDropNote(p, pos) {
    const n = S.notes.find((x) => x.path === p);
    if (n && p !== S.current) editor.insert(pos, `[[${n.title}]]`);
  },
  onLinkClick: openByTitle,
  async onPasteUrl(url, pos) {
    if (!S.settings.linkTitles) return;
    const notePath = S.current;
    const title = await api.linkTitle(url);
    if (!title || S.current !== notePath) return;
    const safe = title.replace(/([\[\]])/g, '\\$1');
    editor.replaceNear(pos, url, `[${safe}](${url})`);
  },
  getTitles: () => {
    const seen = new Set();
    return live().filter((n) => n.path !== S.current && !seen.has(n.title) && seen.add(n.title)).map((n) => ({ title: n.title, kind: kindOf(n) }));
  },
  // After [[Title# : endpoints of an API spec (also specs inside notes) and headings of a note
  getFragments: (title) => {
    const n = findByTitle(title);
    if (!n) return [];
    const ops = (n.kind === 'api' ? [n.body] : embeddedSpecs(n.body)).flatMap(apiOperations)
      .map((o) => ({ label: `${o.method} ${o.path}`, detail: o.summary, type: 'function' }));
    const hs = n.kind === 'api' ? [] : mdHeadings(n.body).map((h) => ({ label: h.text, detail: 'H' + h.level, type: 'text' }));
    return [...ops, ...hs];
  },
  onSelection: () => comments?.selectionChanged(),
  onCommentClick: (id) => comments?.commentClicked(id),
});
setLinkResolver((target) => { const { note } = findByTarget(target); return note ? kindOf(note) : null; });
const apiDocs = createApiDocs({ api, container: $('#apidocs'), onJump: (line) => editor.gotoLine(line), isDark: () => isDark() });

// ---------- saving ----------
let saveTimer = null;
let listTimer = null;
let saveChain = Promise.resolve();

function onEdit() {
  S.dirty = true;
  S.touched = true;
  changesUI?.soon();
  const n = currentNote();
  if (n) {
    n.body = editor.text();
    n.mtime = Date.now();
  }
  setStatusSaved(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 200);
  comments?.noteEdited();
}

function metaChanged() {
  if (!S.current || isTrashed()) return;
  S.dirty = true;
  S.touched = true;
  const n = currentNote();
  if (n) n.meta = S.meta;
  renderAll();
  save();
}

function save(forceSnapshot = false) {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(async () => {
    if (!S.current || !S.dirty || isTrashed()) return;
    const from = S.current;
    const body = editor.text();
    const meta = JSON.parse(JSON.stringify(S.meta));
    S.dirty = false;
    try {
      const to = await api.save(from, meta, body, forceSnapshot);
      const n = S.notes.find((x) => x.path === from);
      if (n) Object.assign(n, { path: to, name: nameOf(to), mtime: Date.now(), title: meta.title || 'Untitled' });
      if (S.current === from) S.current = to;
      if (S.fresh.delete(from)) S.fresh.add(to);
      if (!SINGLE) store('last', S.current);
      if (!S.dirty) setStatusSaved(true);
      renderList();
      updateTitle();
    } catch (e) {
      S.dirty = true;
      toast('Could not save: ' + e.message);
    }
  });
  return saveChain;
}

// ---------- data ----------
let refreshing = null;
let refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  setTimeout(() => changesUI?.soon(), 0);
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await saveChain;
      const data = await api.list();
      S.root = data.root;
      S.notebooks = data.notebooks;
      S.notes = data.notes;
      validateFilter();
      if (S.current) {
        let cur = currentNote();
        if (!cur && S.currentId) {
          cur = S.notes.find((n) => n.id === S.currentId); // renamed or moved elsewhere
          if (cur) S.current = cur.path;
        }
        if (!cur) {
          closeNote();
        } else if (S.dirty) {
          cur.body = editor.text();
          cur.meta = S.meta;
          cur.title = S.meta.title || 'Untitled';
        } else {
          S.meta = cur.meta;
          if (cur.body !== editor.text()) { editor.replaceDoc(cur.body); comments?.reanchor(); }
        }
      }
      renderAll();
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function validateFilter() {
  const f = S.filter;
  const ok =
    ['all', 'inbox', 'trash', 'api'].includes(f.type) ||
    (f.type === 'notebook' && S.notebooks.includes(f.name)) ||
    (f.type === 'status' && STATUS[f.name]) ||
    (f.type === 'tag' && live().some((n) => n.meta.tags.includes(f.name)));
  if (!ok) S.filter = { type: 'all' };
}

async function leaveCurrent() {
  await comments?.flush();
  await save();
  const p = S.current;
  if (!p) return;
  if (S.fresh.has(p) && editor.text().trim() === '' && ['', 'Untitled'].includes((S.meta?.title || '').trim())) {
    S.fresh.delete(p);
    S.notes = S.notes.filter((n) => n.path !== p);
    S.current = null;
    await api.discard(p).catch(() => {});
    return;
  }
  if (S.touched && !isTrashed()) {
    S.touched = false;
    api.snapshot(p);
  }
}

async function openNote(path) {
  if (path === S.current) return;
  await leaveCurrent();
  const n = S.notes.find((x) => x.path === path);
  if (!n) return;
  if (!S.navigating && S.current) {
    S.back.push(S.current);
    if (S.back.length > 100) S.back.shift();
    S.forward = [];
  }
  let data;
  try { data = await api.read(path); } catch { return refresh(); }
  Object.assign(n, { meta: data.meta, body: data.body, title: data.meta.title, ...(data.kind && { kind: data.kind }) });
  S.current = path;
  S.currentId = n.id;
  S.meta = data.meta;
  S.dirty = false;
  S.touched = false;
  editor.setDoc(data.body, !!n.trashed, langOf(n));
  if (!SINGLE) store('last', path);
  renderAll();
  renderPreview();
  updateStatus();
  setStatusSaved(true);
  updateTitle();
  agentPanel.noteChanged();
  comments?.noteOpened();
}

function closeNote() {
  S.current = null;
  S.currentId = null;
  S.meta = null;
  S.dirty = false;
  editor.setDoc('');
  apiDocs.clear();
  renderAll();
  updateTitle();
  comments?.noteOpened();
}

async function newNote(title, kind) {
  const f = S.filter;
  const nb = f.type === 'notebook' ? f.name : SINGLE && currentNote() ? currentNote().notebook : kind === 'api' ? API_ROOT : '';
  await leaveCurrent();
  if (f.type === 'trash') setFilter({ type: 'all' });
  try {
    const p = await api.create(nb, typeof title === 'string' ? title : '', kind);
    if (typeof title !== 'string' && kind !== 'api') S.fresh.add(p);
    S.query = '';
    $('#search').value = '';
    await refresh();
    await openNote(p);
    if (f.type === 'tag') { S.meta.tags.push(f.name); metaChanged(); }
    if (f.type === 'status') { S.meta.status = f.name; metaChanged(); }
    if (S.mode === 'preview') setMode('split');
    if (typeof title === 'string') editor.view.focus();
    else { const ti = $('#title-input'); ti.focus(); ti.select(); }
  } catch (e) {
    toast(e.message);
  }
}

async function openByTitle(target) {
  const { note: n, frag } = findByTarget(target);
  if (n) {
    if (!visibleNotes().includes(n)) setFilter({ type: 'all' });
    await openNote(n.path);
    if (frag) jumpTo(n, frag);
    return;
  }
  const title = splitTarget(target).title;
  if (confirm(`There's no note called “${title}”. Create it?`)) newNote(title);
}

// Go to "#fragment" inside the open note: an endpoint of an API spec, an endpoint of a spec inside the note, or a heading.
async function jumpTo(n, frag) {
  const op = parseOperation(frag);
  if (n.kind === 'api') {
    if (S.mode === 'edit') setMode('split');
    await renderPreview(true);
    if (op && !(await apiDocs.focus(frag))) toast(`No “${frag}” endpoint in this spec.`);
    return;
  }
  if (op) {
    const spec = embeddedSpecs(editor.text()).find((t) => apiOperations(t).some((o) => o.method.toLowerCase() === op.method && o.path === op.path));
    if (spec) { window.dispatchEvent(new CustomEvent('vibe:api-docs', { detail: { text: spec, focus: frag } })); return; }
  }
  const norm = (s) => s.toLowerCase().replace(/[*_`]/g, '').trim();
  const h = headings().find((x) => norm(x.text) === norm(frag));
  if (h) { if (S.mode === 'edit') editor.gotoLine(h.line); else { await renderPreview(true); gotoHeading(h); } }
  else toast(`No heading “${frag}” in this note.`);
}

async function moveNote(p, nb) {
  await save();
  try {
    const to = await api.move(p, nb);
    if (S.current === p) S.current = to;
    if (S.fresh.delete(p)) S.fresh.add(to);
    await refresh();
    toast(`Moved to ${nb ? leafOf(nb) : 'Inbox'}`);
  } catch (e) {
    toast(e.message);
  }
}

async function updateMeta(p, fn) {
  if (p === S.current) {
    fn(S.meta);
    return metaChanged();
  }
  await save();
  const d = await api.read(p);
  fn(d.meta);
  await api.save(p, d.meta, d.body, false);
  await refresh();
}

async function trashNote(p) {
  if (!p) return;
  await save();
  const wasCurrent = p === S.current;
  let next;
  if (wasCurrent) {
    const list = S.order.length ? S.order : visibleNotes();
    const i = list.findIndex((x) => x.path === p);
    next = list[i + 1] || list[i - 1];
  }
  try {
    await api.trash(p);
  } catch (e) {
    return toast(e.message);
  }
  S.fresh.delete(p);
  if (wasCurrent) Object.assign(S, { current: null, currentId: null, dirty: false });
  await refresh();
  if (wasCurrent) {
    if (next && S.notes.some((x) => x.path === next.path)) await openNote(next.path);
    else closeNote();
  }
  toast('Moved to Trash');
}

async function restoreNote(p) {
  try {
    const to = await api.restore(p);
    const wasCurrent = p === S.current;
    if (wasCurrent) Object.assign(S, { current: null, currentId: null });
    await refresh();
    if (wasCurrent) await openNote(to);
    toast('Note restored');
  } catch (e) {
    toast(e.message);
  }
}

async function deleteForever(p) {
  const n = S.notes.find((x) => x.path === p);
  if (!n || !confirm(`Delete “${n.title}” permanently?\n\nIt will be moved to the macOS Trash.`)) return;
  await api.remove(p);
  if (p === S.current) Object.assign(S, { current: null, currentId: null });
  await refresh();
  if (!S.current) closeNote();
}

async function emptyTrash() {
  const count = S.notes.filter((n) => n.trashed).length;
  if (!count) return toast('Trash is already empty');
  if (!confirm(`Permanently delete ${count} note${count === 1 ? '' : 's'} in the Trash?\n\nThey will be moved to the macOS Trash.`)) return;
  if (isTrashed()) Object.assign(S, { current: null, currentId: null });
  await api.emptyTrash();
  await refresh();
  if (!S.current) closeNote();
}

async function chooseFolder() {
  await leaveCurrent();
  const r = await api.chooseFolder();
  if (!r) return;
  closeNote();
  setFilter({ type: 'all' });
  await refresh();
  const first = visibleNotes()[0];
  if (first) openNote(first.path);
}

async function insertImages() {
  if (!S.current || isTrashed()) return;
  const state = editor.view.state;
  const pos = state.selection.main.head;
  try {
    const list = await api.pickImages(S.current);
    if (!list.length) return;
    const atLineStart = pos === state.doc.lineAt(pos).from;
    const text = (atLineStart ? '' : '\n') + list.map((i) => `![${i.alt.replace(/[[\]]/g, '')}](${i.rel})`).join('\n') + '\n';
    editor.insert(Math.min(pos, editor.view.state.doc.length), text);
  } catch (e) {
    toast('Could not add image: ' + e.message);
  }
}

async function attachFiles(files, pos) {
  if (!S.current || isTrashed()) return;
  let text = '';
  for (const f of files) {
    try {
      const rel = await api.attach(S.current, f.name, f.type, new Uint8Array(await f.arrayBuffer()));
      const alt = (f.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
      text += `![${alt}](${rel})\n`;
    } catch (e) {
      toast('Could not add image: ' + e.message);
    }
  }
  if (text) editor.insert(pos, text);
}

// ---------- notebooks ----------
function setExpanded(nb, open) {
  if (open) S.expanded.add(nb); else S.expanded.delete(nb);
  store('expanded', [...S.expanded]);
}
function expandTo(nb) {
  for (let p = parentOf(nb); p; p = parentOf(p)) S.expanded.add(p);
  store('expanded', [...S.expanded]);
}

// Inline text field in the sidebar (create / rename notebook).
function inlineInput({ anchor, replace = false, depth = 0, value = '', placeholder, onSubmit }) {
  const input = document.createElement('input');
  input.className = 'nb-input';
  input.style.marginLeft = `${depth * 14}px`;
  input.style.width = `calc(100% - ${depth * 14}px)`;
  input.placeholder = placeholder;
  input.value = value;
  if (replace) anchor.replaceWith(input);
  else if (anchor) anchor.after(input);
  else $('#notebooks').prepend(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    if (ok && v && v !== value) {
      try { await onSubmit(v); } catch (e) { toast(e.message); }
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

function newNotebook(parent = '') {
  document.body.classList.remove('no-sidebar', 'focus');
  if (parent) { setExpanded(parent, true); expandTo(parent); renderSidebar(); }
  const anchor = parent ? $(`#notebooks [data-nb="${CSS.escape(parent)}"]`) : null;
  inlineInput({
    anchor,
    depth: parent ? parent.split('/').length : 0,
    placeholder: parent ? `New notebook in ${leafOf(parent)}` : 'Notebook name',
    async onSubmit(name) {
      const rel = await api.createNotebook(parent, name);
      expandTo(rel);
      setFilter({ type: 'notebook', name: rel });
      await refresh();
    },
  });
}

function renameNotebook(nb) {
  const row = $(`#notebooks [data-nb="${CSS.escape(nb)}"]`);
  if (!row) return;
  inlineInput({
    anchor: row,
    replace: true,
    depth: nb.split('/').length - 1,
    value: leafOf(nb),
    placeholder: 'Notebook name',
    async onSubmit(name) {
      await save();
      const rel = await api.renameNotebook(nb, name);
      const oldDir = `${S.root}/${nb}/`;
      if (S.current && S.current.startsWith(oldDir)) S.current = `${S.root}/${rel}/${S.current.slice(oldDir.length)}`;
      const swap = (x) => (x === nb ? rel : x.startsWith(nb + '/') ? rel + x.slice(nb.length) : x);
      S.expanded = new Set([...S.expanded].map(swap));
      store('expanded', [...S.expanded]);
      if (S.filter.type === 'notebook') setFilter({ type: 'notebook', name: swap(S.filter.name) });
      await refresh();
    },
  });
}

async function deleteNotebook(nb) {
  const count = live().filter((n) => inBook(n, nb)).length;
  const msg = `Delete notebook “${leafOf(nb)}”${count ? ` and the ${count} note${count === 1 ? '' : 's'} in it` : ''}?\n\nThe folder will be moved to the macOS Trash.`;
  if (!confirm(msg)) return;
  await leaveCurrent();
  const cur = currentNote();
  if (cur && !cur.trashed && inBook(cur, nb)) closeNote();
  try {
    await api.deleteNotebook(nb);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- list helpers ----------
function visibleNotes() {
  const terms = parseQuery(S.query);
  const f = S.filter;
  const list = S.notes.filter((n) => {
    if (f.type === 'trash') { if (!n.trashed) return false; }
    else {
      if (n.trashed) return false;
      if (f.type === 'inbox' && n.notebook) return false;
      if (f.type === 'api' && n.kind !== 'api') return false;
      if (f.type === 'notebook' && !inBook(n, f.name)) return false;
      if (f.type === 'tag' && !n.meta.tags.includes(f.name)) return false;
      if (f.type === 'status' && n.meta.status !== f.name) return false;
    }
    return matchQuery(n, terms);
  });
  const cmp = {
    updated: (a, b) => b.mtime - a.mtime,
    created: (a, b) => b.ctime - a.ctime,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
  }[S.sort] || ((a, b) => b.mtime - a.mtime);
  return list.sort((a, b) => (f.type === 'trash' ? b.deletedAt - a.deletedAt : (b.meta.pinned - a.meta.pinned) || cmp(a, b)));
}

function snippet(n) {
  if (n.kind === 'api') {
    const title = /^\s{2}title:\s*["']?(.+?)["']?\s*$/m.exec(n.body)?.[1] || 'OpenAPI spec';
    const ops = (n.body.match(/^\s+(get|post|put|patch|delete|head|options):\s*$/gm) || []).length;
    const ver = /^\s*["']?(openapi|swagger)["']?\s*:\s*["']?([\d.]+)/m.exec(n.body)?.[2] || '';
    return `${title} · ${ops} endpoint${ops === 1 ? '' : 's'} · OpenAPI ${ver}`;
  }
  let lines = n.body.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#{1,6}\s/.test(lines[first]) && lines[first].replace(/^#+\s+/, '').trim() === n.title) lines = lines.slice(first + 1);
  return lines
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|$]|\[[ xX]\]|^-|\s-\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
function iconEl(svg, cls = 'ico') {
  const s = el('span', cls);
  s.innerHTML = svg;
  return s;
}
function dot(color) {
  const d = el('span', 'dot');
  d.style.background = color;
  return d;
}

// ---------- rendering ----------
function renderAll() {
  if (!SINGLE) {
    renderSidebar();
    renderList();
  }
  renderToolbar();
  renderMeta();
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
    if (!p) return;
    e.preventDefault();
    const n = S.notes.find((x) => x.path === p);
    if (n?.trashed) return toast('Restore the note first');
    if ((notebook === CONFLUENCE_ROOT || notebook.startsWith(CONFLUENCE_ROOT + '/')) && n && !confluenceInfo(n.meta) && n.kind !== 'api') {
      return confluence.publishNote(n, notebook); // becomes a Confluence page there (the window asks before publishing)
    }
    moveNote(p, notebook);
  });
}

function sideRow({ icon, color, label, count, active, depth = 0, onClick, onMenu }) {
  const b = el('button', 'nav-item');
  if (depth) b.style.paddingLeft = `${10 + depth * 14}px`;
  if (icon) b.append(iconEl(icon));
  if (color) b.append(dot(color));
  b.append(el('span', 'label', label), el('span', 'count', count ? String(count) : ''));
  b.classList.toggle('active', !!active);
  b.addEventListener('click', onClick);
  if (onMenu) b.addEventListener('contextmenu', (e) => { e.preventDefault(); onMenu(); });
  return b;
}

function renderSidebar() {
  if (document.activeElement?.classList.contains('nb-input')) return; // don't wipe an inline edit
  const f = S.filter;
  const notes = live();

  const lib = $('#library');
  lib.textContent = '';
  lib.append(
    sideRow({ icon: ICON.all, label: 'All Notes', count: notes.length, active: f.type === 'all', onClick: () => setFilter({ type: 'all' }) }),
  );
  const inbox = sideRow({
    icon: ICON.inbox, label: 'Inbox', count: notes.filter((n) => !n.notebook).length,
    active: f.type === 'inbox', onClick: () => setFilter({ type: 'inbox' }),
  });
  makeDropTarget(inbox, '');
  lib.append(inbox);

  const wrap = $('#notebooks');
  wrap.textContent = '';
  const tree = (parent, depth, target = wrap) => {
    for (const nb of S.notebooks.filter((x) => parentOf(x) === parent && x !== CONFLUENCE_ROOT && x !== API_ROOT)) {
      const kids = S.notebooks.some((x) => parentOf(x) === nb);
      const open = S.expanded.has(nb);
      const row = sideRow({
        icon: ICON.book, label: leafOf(nb), count: notes.filter((n) => inBook(n, nb)).length, depth,
        active: f.type === 'notebook' && f.name === nb,
        onClick: () => setFilter({ type: 'notebook', name: nb }),
        onMenu: () => notebookMenu(nb),
      });
      row.dataset.nb = nb;
      const chev = el('span', 'chev' + (open ? ' open' : ''));
      if (kids) {
        chev.innerHTML = ICON.chevron;
        chev.addEventListener('click', (e) => { e.stopPropagation(); setExpanded(nb, !open); renderSidebar(); });
      }
      row.prepend(chev);
      makeDropTarget(row, nb);
      target.append(row);
      if (kids && open) tree(nb, depth + 1, target);
    }
  };
  tree('', 0);
  if (!S.notebooks.some((x) => x !== CONFLUENCE_ROOT && x !== API_ROOT)) wrap.append(el('div', 'hint', 'Notebooks are folders. Click + to add one.'));

  // API specs: every spec file + notes that contain one, and the "APIs" notebook.
  const apiBox = $('#apis');
  apiBox.textContent = '';
  const specCount = notes.filter((n) => n.kind === 'api').length;
  if (specCount || S.notebooks.includes(API_ROOT)) {
    apiBox.append(sideRow({
      icon: ICON.api, label: 'All API specs', count: specCount,
      active: f.type === 'api', onClick: () => setFilter({ type: 'api' }),
    }));
    if (S.notebooks.includes(API_ROOT)) {
      const row = sideRow({
        icon: ICON.book, label: API_ROOT, count: notes.filter((n) => inBook(n, API_ROOT)).length,
        active: f.type === 'notebook' && f.name === API_ROOT,
        onClick: () => setFilter({ type: 'notebook', name: API_ROOT }), onMenu: () => notebookMenu(API_ROOT),
      });
      makeDropTarget(row, API_ROOT);
      apiBox.append(row);
      tree(API_ROOT, 1, apiBox);
    }
  } else {
    apiBox.append(el('div', 'hint', 'Click + to create an API spec (Swagger / OpenAPI).'));
  }

  // Pages fetched from Confluence live in the "Confluence" notebook, shown as their own section.
  const cfBox = $('#confluence');
  cfBox.textContent = '';
  if (S.notebooks.includes(CONFLUENCE_ROOT)) {
    cfBox.append(sideRow({
      icon: ICON.cloud, label: 'All pages', count: notes.filter((n) => inBook(n, CONFLUENCE_ROOT)).length,
      active: f.type === 'notebook' && f.name === CONFLUENCE_ROOT,
      onClick: () => setFilter({ type: 'notebook', name: CONFLUENCE_ROOT }),
      onMenu: () => notebookMenu(CONFLUENCE_ROOT),
    }));
    if (S.cfChanged?.size) {
      cfBox.append(sideRow({
        icon: ICON.upload, label: 'Changes to push', count: S.cfChanged.size,
        onClick: () => changesUI.open(),
      }));
      cfBox.lastElementChild.classList.add('cf-changes-row');
    }
    tree(CONFLUENCE_ROOT, 0, cfBox);
  } else {
    cfBox.append(el('div', 'hint', 'Click + to fetch pages from Confluence.'));
  }

  const st = $('#statuses');
  st.textContent = '';
  for (const [key, s] of Object.entries(STATUS)) {
    st.append(sideRow({
      color: s.color, label: s.label, count: notes.filter((n) => n.meta.status === key).length,
      active: f.type === 'status' && f.name === key, onClick: () => setFilter({ type: 'status', name: key }),
    }));
  }

  const counts = new Map();
  for (const n of notes) for (const t of n.meta.tags) counts.set(t, (counts.get(t) || 0) + 1);
  const tg = $('#tags');
  tg.textContent = '';
  for (const t of [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    tg.append(sideRow({
      color: tagColor(t), label: t, count: counts.get(t),
      active: f.type === 'tag' && f.name === t, onClick: () => setFilter({ type: 'tag', name: t }),
    }));
  }
  if (!counts.size) tg.append(el('div', 'hint', 'Add tags above the editor.'));

  const tn = $('#trash-nav');
  tn.textContent = '';
  tn.append(sideRow({
    icon: ICON.trash, label: 'Trash', count: S.notes.filter((n) => n.trashed).length,
    active: f.type === 'trash', onClick: () => setFilter({ type: 'trash' }),
    onMenu: async () => { if ((await api.popup([{ id: 'empty', label: 'Empty Trash…' }])) === 'empty') emptyTrash(); },
  }));

  $('#folder-name').textContent = S.root.split('/').filter(Boolean).pop() || '';
  $('#folder-btn').title = `${S.root}\nClick to change notes folder`;
}

function filterLabel() {
  const f = S.filter;
  return { all: 'All Notes', inbox: 'Inbox', trash: 'Trash', api: 'API specs' }[f.type]
    || (f.type === 'notebook' ? leafOf(f.name) : f.type === 'tag' ? `# ${f.name}` : STATUS[f.name]?.label || '');
}

// ---------- list sections (Arrange → Group by) ----------
const GROUP_LABEL = { folder: 'notebook', tag: 'tag', type: 'type', none: 'nothing' };
const KIND_LABEL = { note: 'Note', confluence: 'Confluence', api: 'API' };
const TYPE_GROUPS = [['note', 'Notes'], ['confluence', 'Confluence pages'], ['api', 'API specs']];
const segs = (p) => (p ? p.split('/') : []);
const cmpName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function cmpPath(a, b) {
  const A = segs(a), B = segs(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) { const c = cmpName(A[i], B[i]); if (c) return c; }
  return A.length - B.length;
}

// Split the (already sorted) list into sections: [{ key, label, depth, kind?, color?, notes }].
// One section without a heading when grouping is off or there is nothing to tell apart.
function groupedNotes(list) {
  const mode = S.filter.type === 'trash' ? 'none' : S.group;
  const flat = [{ key: '', label: '', depth: 0, notes: list }];
  if (mode === 'none' || !list.length) return flat;
  const groups = [];
  if (mode === 'folder') {
    // Top-level notebooks are the big headings, notebooks inside them smaller sub-headings.
    const base = S.filter.type === 'notebook' ? S.filter.name : '';
    const top = base ? segs(base).length : 1;
    const by = new Map();
    for (const n of list) {
      const k = n.notebook || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(n);
    }
    const keys = new Set();
    for (const k of by.keys()) {
      const s = segs(k);
      for (let i = top; i <= s.length; i++) keys.add(s.slice(0, i).join('/'));
    }
    if (!base && by.has('')) groups.push({ key: '', label: 'Inbox', depth: 0, notes: by.get('') });
    for (const k of [...keys].sort(cmpPath)) groups.push({ key: k, label: leafOf(k), depth: segs(k).length - top, notes: by.get(k) || [] });
  } else if (mode === 'tag') {
    const tags = [...new Set(list.flatMap((n) => n.meta.tags))].sort(cmpName);
    for (const t of tags) groups.push({ key: t, label: t, depth: 0, color: tagColor(t), notes: list.filter((n) => n.meta.tags.includes(t)) });
    const none = list.filter((n) => !n.meta.tags.length);
    if (none.length) groups.push({ key: '', label: 'No tags', depth: 0, notes: none });
  } else {
    for (const [k, label] of TYPE_GROUPS) {
      const notes = list.filter((n) => kindOf(n) === k);
      if (notes.length) groups.push({ key: k, label, depth: 0, kind: k, notes });
    }
  }
  return groups.length > 1 ? groups : flat;
}

function toggleSection(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id);
  else S.collapsed.add(id);
  store('collapsed', [...S.collapsed]);
  renderList();
}

// Fold or unfold several headings at once: all of them, or one heading and every notebook inside it.
// S.sections = the headings of the list as last drawn (also the ones hidden inside a folded notebook).
function setSections(open, under = null) {
  const mode = S.filter.type === 'trash' ? 'none' : S.group;
  const inside = (k) => under == null || k === under || (under !== '' && k.startsWith(under + '/'));
  for (const k of S.sections) {
    if (!inside(k)) continue;
    if (open) S.collapsed.delete(`${mode}:${k}`);
    else S.collapsed.add(`${mode}:${k}`);
  }
  store('collapsed', [...S.collapsed]);
  renderList();
}

async function sectionMenu(g, mode) {
  const closed = S.collapsed.has(`${mode}:${g.key}`);
  const nested = mode === 'folder' && g.key && S.sections.some((k) => k.startsWith(g.key + '/'));
  const id = await api.popup([
    { id: 'one', label: closed ? `Expand “${g.label}”` : `Collapse “${g.label}”` },
    ...(nested ? [
      { id: 'in-open', label: `Expand “${g.label}” and Everything Inside` },
      { id: 'in-close', label: `Collapse Everything Inside “${g.label}”` },
    ] : []),
    { type: 'separator' },
    { id: 'all-open', label: 'Expand All' },
    { id: 'all-close', label: 'Collapse All' },
  ]);
  if (id === 'one') toggleSection(`${mode}:${g.key}`);
  else if (id === 'in-open') setSections(true, g.key);
  else if (id === 'in-close') {
    // keep this heading open, fold the notebooks inside it
    S.collapsed.delete(`${mode}:${g.key}`);
    for (const k of S.sections) if (k.startsWith(g.key + '/')) S.collapsed.add(`${mode}:${k}`);
    store('collapsed', [...S.collapsed]);
    renderList();
  } else if (id === 'all-open') setSections(true);
  else if (id === 'all-close') setSections(false);
}

function setGroup(g) {
  S.group = g;
  store('group', g);
  renderList();
  toast(g === 'none' ? 'Not grouped' : `Grouped by ${GROUP_LABEL[g]}`);
}

function sectionHead(g, mode, count, closed) {
  const id = `${mode}:${g.key}`;
  const h = el('li', `group-head depth-${Math.min(g.depth, 3)}`);
  h.style.paddingLeft = `${4 + g.depth * 14}px`;
  const chev = el('span', 'chev' + (closed ? '' : ' open'));
  chev.innerHTML = ICON.chevron;
  h.append(chev);
  if (g.kind) h.append(el('span', `api-badge kind-${g.kind}`, KIND_LABEL[g.kind]));
  if (g.color) h.append(dot(g.color));
  h.append(el('span', 'group-label', g.label), el('span', 'group-count', count ? String(count) : ''));
  h.title = mode === 'folder' && g.key ? g.key : g.label;
  // ⌥-click: fold/unfold this heading together with every notebook inside it
  h.addEventListener('click', (e) => (e.altKey ? setSections(closed, g.key) : toggleSection(id)));
  h.addEventListener('contextmenu', (e) => { e.preventDefault(); sectionMenu(g, mode); });
  if (mode === 'folder') makeDropTarget(h, g.key);
  return h;
}

function noteItem(n) {
  const li = el('li', 'note');
  li.dataset.path = n.path;
  li.draggable = true;
  if (n.path === S.current) li.classList.add('active');

  const head = el('div', 'note-title');
  const kind = kindOf(n);
  head.append(el('span', `api-badge kind-${kind}`, KIND_LABEL[kind]));
  if (S.cfChanged?.has(n.path)) head.append(el('span', 'edited-badge', 'edited'));
  if (n.meta.pinned && !n.trashed) head.append(iconEl(ICON.pin, 'pin-ico'));
  head.append(el('span', '', n.title || 'Untitled'));
  li.append(head);

  const meta = el('div', 'note-meta', n.trashed ? `Deleted ${fmtDate(n.deletedAt || n.mtime)}` : fmtDate(n.mtime));
  const s = STATUS[n.meta.status];
  if (s) {
    const b = el('span', 'status-badge');
    b.append(dot(s.color), document.createTextNode(s.label));
    meta.append(b);
  }
  if (n.notebook && !(S.filter.type === 'notebook' && S.filter.name === n.notebook)) meta.append(el('span', 'badge', leafOf(n.notebook)));
  li.append(meta);

  const snip = snippet(n);
  if (snip) li.append(el('div', 'note-snippet', snip));

  if (n.meta.tags.length) {
    const tags = el('div', 'note-tags');
    for (const t of n.meta.tags.slice(0, 4)) {
      const c = el('span', 'tag-chip small', t);
      c.style.setProperty('--tag', tagColor(t));
      tags.append(c);
    }
    li.append(tags);
  }

  li.addEventListener('click', () => openNote(n.path));
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); noteMenu(n); });
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/vibe-note', n.path);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  return li;
}

function renderList() {
  const list = visibleNotes();
  const title = filterLabel();
  $('#list-title').textContent = S.query ? `${list.length} result${list.length === 1 ? '' : 's'} in ${title}` : title;
  $('#sort-btn').hidden = S.filter.type === 'trash';

  const ul = $('#notes');
  ul.textContent = '';
  S.order = [];
  S.sections = [];
  if (!list.length) {
    const msg = S.query ? 'No matching notes' : S.filter.type === 'trash' ? 'Trash is empty' : 'No notes yet. Press ⌘N';
    ul.append(el('li', 'list-empty', msg));
    return;
  }
  const mode = S.filter.type === 'trash' ? 'none' : S.group;
  const frag = document.createDocumentFragment();
  const seen = new Set();
  let hiddenUnder = null; // a collapsed notebook hides the notebooks inside it too
  const groups = groupedNotes(list);
  S.sections = groups.filter((g) => g.label).map((g) => g.key);
  for (const g of groups) {
    if (hiddenUnder != null && mode === 'folder' && g.key.startsWith(hiddenUnder + '/')) continue;
    hiddenUnder = null;
    const closed = !!g.label && S.collapsed.has(`${mode}:${g.key}`);
    if (g.label) {
      const count = mode === 'folder' ? list.filter((n) => n.notebook === g.key || (g.key && n.notebook.startsWith(g.key + '/'))).length : g.notes.length;
      frag.append(sectionHead(g, mode, count, closed));
    }
    if (closed) { if (mode === 'folder') hiddenUnder = g.key; continue; }
    for (const n of g.notes) {
      frag.append(noteItem(n));
      if (!seen.has(n.path)) { seen.add(n.path); S.order.push(n); }
    }
  }
  ul.append(frag);
  ul.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function renderToolbar() {
  const n = currentNote();
  document.body.classList.toggle('no-note', !n);
  document.body.classList.toggle('in-trash', !!n?.trashed);
  document.body.classList.toggle('api-note', n?.kind === 'api');
  const sel = $('#nb-select');
  sel.textContent = '';
  sel.append(new Option('Inbox', ''));
  for (const nb of S.notebooks) {
    sel.append(new Option('   '.repeat(nb.split('/').length - 1) + leafOf(nb), nb));
  }
  sel.value = n ? n.notebook : '';
  sel.disabled = !n || n.trashed;
  $('#back-btn').disabled = !S.back.length;
  $('#fwd-btn').disabled = !S.forward.length;
  // Push: update the Confluence page — or, for a normal note, publish it as a new page.
  const cfKind = confluenceInfo(S.meta)?.kind;
  $('#push-btn').hidden = !n || !!n.trashed || n.kind === 'api' || (cfKind && cfKind !== 'page');
  $('#push-btn').title = cfKind ? 'Push your changes to Confluence' : 'Publish this note as a new Confluence page';
  $('#pin-btn').classList.toggle('on', !!S.meta?.pinned);
  $('#pin-btn').title = S.meta?.pinned ? 'Unpin note (⌥⌘P)' : 'Pin note (⌥⌘P)';
  $$('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
}

// "Linked from": notes, Confluence pages and specs that link here with [[…]] (or a Confluence page link).
function renderBacklinks() {
  const box = $('#backlinks');
  const n = currentNote();
  box.textContent = '';
  if (!n || n.trashed) { box.hidden = true; return; }
  const cf = confluenceInfo(n.meta);
  const refs = live().filter((o) => o !== n && (linksTo(o.body, n.title, cf?.id) || (n.name !== n.title && linksTo(o.body, n.name))));
  box.hidden = !refs.length;
  if (!refs.length) return;
  box.append(el('span', 'bl-label', `🔗 Linked from`));
  for (const o of refs.slice(0, 12)) {
    const b = el('button', `bl-chip kind-${kindOf(o)}`, o.title);
    b.title = o.notebook ? `${o.notebook} / ${o.title}` : o.title;
    b.addEventListener('click', () => { if (!visibleNotes().includes(o)) setFilter({ type: 'all' }); openNote(o.path); });
    box.append(b);
  }
  if (refs.length > 12) box.append(el('span', 'bl-more', `+${refs.length - 12} more`));
}

function renderMeta() {
  renderBacklinks();
  const m = S.meta;
  if (!m) return;
  const ti = $('#title-input');
  if (document.activeElement !== ti) ti.value = m.title === 'Untitled' && S.fresh.has(S.current) ? '' : m.title || '';
  ti.readOnly = isTrashed();
  const s = STATUS[m.status];
  $('#status-select').value = m.status || '';
  $('#status-pick .dot').style.background = s ? s.color : 'transparent';
  $('#status-pick').classList.toggle('none', !s);
  const box = $('#tag-list');
  box.textContent = '';
  for (const t of m.tags) {
    const chip = el('span', 'tag-chip', t);
    chip.style.setProperty('--tag', tagColor(t));
    const x = el('button', 'tag-x', '×');
    x.title = `Remove “${t}”`;
    x.addEventListener('click', () => { m.tags = m.tags.filter((y) => y !== t); metaChanged(); });
    chip.append(x);
    box.append(chip);
  }
  const all = new Set(live().flatMap((n) => n.meta.tags));
  const dl = $('#tag-options');
  dl.textContent = '';
  for (const t of [...all].filter((t) => !m.tags.includes(t)).sort()) dl.append(new Option(t));
}

function addTag(v) {
  const t = v.trim().replace(/^#/, '').replace(/[,\[\]]/g, '').trim();
  $('#tag-input').value = '';
  if (!t || !S.meta || S.meta.tags.includes(t)) return;
  S.meta.tags.push(t);
  metaChanged();
}

let previewTimer = null;
let previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}
async function renderPreview(force = false) {
  if ((S.mode === 'edit' && !force) || !S.current) return;
  if (isApi()) { apiDocs.show(S.currentId, editor.text()); return; }
  const seq = ++previewSeq;
  const tmp = document.createElement('div');
  const text = editor.text();
  const title = currentNote()?.title || '';
  tmp.innerHTML = (startsWithTitle(text, title) ? '' : `<h1 class="print-title">${esc(title)}</h1>`) + renderMarkdown(text);
  await postProcess(tmp, {
    dir: dirOf(S.current),
    dark: isDark(),
    onTask: isTrashed() ? null : (i) => editor.toggleTask(i),
    copyButtons: true,
  });
  try { await confluence.decorate(tmp); } catch {}
  if (seq !== previewSeq) return;
  const box = $('#preview');
  const top = box.scrollTop;
  box.replaceChildren(...tmp.childNodes);
  box.scrollTop = top;
}

function updateStatus() {
  const words = (editor.text().match(/\S+/g) || []).length;
  $('#status-words').textContent = S.current ? `${words} word${words === 1 ? '' : 's'}` : '';
}
function setStatusSaved(saved) {
  const s = $('#status-save');
  s.textContent = !S.current ? '' : isTrashed() ? 'Read-only' : saved ? 'Saved' : 'Editing…';
  s.classList.toggle('pending', !saved);
}
function updateTitle() {
  const n = currentNote();
  document.title = SINGLE && n ? n.title : 'VibeNote';
}

function setMode(m) {
  S.mode = m;
  store('mode', m);
  $('#panes').className = m;
  renderToolbar();
  renderPreview();
  if (m !== 'preview') editor.view.requestMeasure();
}

function setFilter(f) {
  S.filter = f;
  store('filter', f);
  if (f.type === 'notebook') expandTo(f.name);
  renderAll();
}

function setSort(s) {
  S.sort = s;
  store('sort', s);
  renderList();
  toast(`Sorted by ${{ updated: 'date updated', created: 'date created', title: 'title' }[s]}`);
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function applySettings(s) {
  S.settings = s;
  const fonts = { mono: 'var(--mono)', sans: 'var(--sans)', serif: '"New York", "Iowan Old Style", Georgia, serif' };
  const widths = { narrow: '640px', medium: '780px', wide: '980px', full: 'none' };
  const root = document.documentElement.style;
  root.setProperty('--editor-font', fonts[s.editorFont] || fonts.mono);
  root.setProperty('--editor-size', `${s.fontSize || 15}px`);
  root.setProperty('--line-width', widths[s.lineWidth] || widths.medium);
  editor.applySettings(s);
  renderPreview();
}

function onThemeChanged(theme) {
  applyTheme(theme);
  renderPreview();
}

// ---------- navigation ----------
async function navigate(dir) {
  const from = dir < 0 ? S.back : S.forward;
  const to = dir < 0 ? S.forward : S.back;
  while (from.length) {
    const p = from.pop();
    const n = S.notes.find((x) => x.path === p);
    if (!n) continue;
    if (S.current) to.push(S.current);
    S.navigating = true;
    try {
      if (!visibleNotes().includes(n)) setFilter({ type: 'all' });
      await openNote(p);
    } finally {
      S.navigating = false;
    }
    break;
  }
  renderToolbar();
}

// Headings of the open note (outside code fences) for the outline.
function headings() {
  const out = [];
  let fence = false;
  editor.text().split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1, index: out.length });
  });
  return out;
}

function gotoHeading(h) {
  if (S.mode !== 'preview') editor.gotoLine(h.line);
  const els = $$('#preview :is(h1, h2, h3, h4, h5, h6):not(.print-title)');
  els[h.index]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- menus ----------
async function noteMenu(n) {
  const items = n.trashed
    ? [{ id: 'restore', label: 'Restore' }, { id: 'delete', label: 'Delete Forever…' }]
    : [
        { id: 'window', label: 'Open in New Window' },
        { id: 'pin', label: n.meta.pinned ? 'Unpin' : 'Pin to Top' },
        { id: 'link', label: 'Copy Link' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { type: 'separator' },
        { id: 'trash', label: 'Move to Trash' },
      ];
  const id = await api.popup(items);
  if (id === 'restore') restoreNote(n.path);
  if (id === 'delete') deleteForever(n.path);
  if (id === 'window') { await save(); api.openWindow(n.path); }
  if (id === 'pin') updateMeta(n.path, (m) => { m.pinned = !m.pinned; });
  if (id === 'link') copyLink(n);
  if (id === 'reveal') api.reveal(n.path);
  if (id === 'trash') trashNote(n.path);
}

async function notebookMenu(nb) {
  const id = await api.popup([
    { id: 'note', label: 'New Note Here' },
    { id: 'sub', label: 'New Notebook Inside' },
    { type: 'separator' },
    { id: 'rename', label: 'Rename…' },
    { id: 'delete', label: 'Delete…' },
  ]);
  if (id === 'note') { setFilter({ type: 'notebook', name: nb }); newNote(); }
  if (id === 'sub') newNotebook(nb);
  if (id === 'rename') renameNotebook(nb);
  if (id === 'delete') deleteNotebook(nb);
}

async function moreMenu() {
  const n = currentNote();
  if (!n) return;
  const id = await api.popup([
    { id: 'open-window', label: 'Open in New Window', enabled: !SINGLE },
    { id: 'copy-link', label: 'Copy Link' },
    { id: 'history', label: 'Version History…' },
    ...(confluenceInfo(S.meta)?.kind === 'page' ? [
      { type: 'separator' },
      { id: 'confluence-push', label: 'Push to Confluence…' },
      { id: 'confluence-pull', label: 'Pull Latest from Confluence' },
      { id: 'confluence-open', label: 'Open in Confluence' },
    ] : []),
    ...(!confluenceInfo(S.meta) && !isApi() ? [
      { type: 'separator' },
      { id: 'confluence-publish', label: 'Publish as a New Confluence Page…' },
    ] : []),
    { type: 'separator' },
    { id: 'export-html', label: 'Export as HTML…' },
    { id: 'export-pdf', label: 'Export as PDF…' },
    { id: 'print', label: 'Print…' },
    { type: 'separator' },
    { id: 'reveal', label: 'Reveal in Finder' },
    { id: 'trash', label: 'Move to Trash' },
  ]);
  if (id) runCommand(id);
}

async function sortMenu() {
  const id = await api.popup([
    { label: 'Sort by', enabled: false },
    { id: 'updated', label: 'Date Updated', checked: S.sort === 'updated' },
    { id: 'created', label: 'Date Created', checked: S.sort === 'created' },
    { id: 'title', label: 'Title', checked: S.sort === 'title' },
    { type: 'separator' },
    { label: 'Group by', enabled: false },
    { id: 'group:folder', label: 'Notebook', checked: S.group === 'folder' },
    { id: 'group:tag', label: 'Tag', checked: S.group === 'tag' },
    { id: 'group:type', label: 'Type (Note / Confluence / API)', checked: S.group === 'type' },
    { id: 'group:none', label: 'No Groups', checked: S.group === 'none' },
    ...(S.sections.length ? [
      { type: 'separator' },
      { id: 'expand-all', label: 'Expand All' },
      { id: 'collapse-all', label: 'Collapse All' },
    ] : []),
  ]);
  if (id === 'expand-all' || id === 'collapse-all') return setSections(id === 'expand-all');
  if (id?.startsWith('group:')) setGroup(id.slice(6));
  else if (id) setSort(id);
}

function copyLink(n = currentNote()) {
  if (!n) return;
  navigator.clipboard.writeText(`[[${n.title}]]`);
  toast(`Copied [[${n.title}]]`);
}

// ---------- export / print ----------
async function exportNote(format) {
  const n = currentNote();
  if (!n) return;
  await save();
  const tmp = document.createElement('div');
  const body = editor.text();
  tmp.innerHTML = (startsWithTitle(body, n.title) ? '' : `<h1>${esc(n.title)}</h1>`) + renderMarkdown(body);
  await postProcess(tmp, { dir: dirOf(n.path), dark: false });
  try {
    const out = await api.exportNote({ title: n.title, html: tmp.innerHTML, format });
    if (out) toast(`Exported ${out.split('/').pop()}`);
  } catch (e) {
    toast('Export failed: ' + e.message);
  }
}

async function printNote() {
  if (!S.current) return;
  await renderPreview(true);
  document.body.classList.add('printing');
  window.print();
  document.body.classList.remove('printing');
}

// ---------- overlays (palette, settings, history) ----------
function overlay(kind) {
  const ov = $('#overlay');
  ov.hidden = false;
  ov.className = kind;
  ov.textContent = '';
  ov.onmousedown = (e) => { if (e.target === ov) closeOverlay(); };
  return ov;
}
function closeOverlay() {
  const ov = $('#overlay');
  if (ov.hidden) return;
  ov.hidden = true;
  ov.textContent = '';
  if (S.current && !isTrashed()) editor.view.focus();
}

function openPalette(initial = '') {
  const ov = overlay('palette-ov');
  ov.innerHTML = '<div class="palette"><input spellcheck="false" placeholder="Jump to a note…   > commands   # headings"><ul></ul></div>';
  const input = $('input', ov);
  const ul = $('ul', ov);
  let items = [];
  let sel = 0;
  const run = (it) => {
    closeOverlay();
    if (it.kind === 'note') {
      if (!visibleNotes().includes(it.n)) setFilter({ type: 'all' });
      openNote(it.n.path);
    } else if (it.kind === 'heading') {
      gotoHeading(it.h);
    } else {
      it.c.run();
    }
  };
  const draw = () => {
    ul.textContent = '';
    items.forEach((it, i) => {
      const li = el('li', i === sel ? 'sel' : '');
      if (it.kind === 'note') li.append(iconEl(it.n.meta.pinned ? ICON.pin : ICON.note), el('span', 'pl-title', it.n.title), el('span', 'pl-hint', it.n.notebook ? leafOf(it.n.notebook) : 'Inbox'));
      else if (it.kind === 'heading') {
        const t = el('span', 'pl-title', it.h.text);
        t.style.paddingLeft = `${(it.h.level - 1) * 14}px`;
        li.append(el('span', 'pl-hash', '#'.repeat(it.h.level)), t, el('span', 'pl-hint', `line ${it.h.line}`));
      }
      else li.append(iconEl(ICON.cmd), el('span', 'pl-title', it.c.title), el('span', 'pl-hint kbd', it.c.key || ''));
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; draw(); } });
      li.addEventListener('click', () => run(it));
      ul.append(li);
    });
    if (!items.length) ul.append(el('li', 'pl-empty', 'No matches'));
    ul.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const update = () => {
    const raw = input.value;
    if (raw.startsWith('#')) {
      const q = raw.slice(1).trim();
      items = headings()
        .map((h) => ({ kind: 'heading', h, score: fuzzy(h.text, q) }))
        .filter((x) => x.score >= 0);
      if (q) items.sort((a, b) => b.score - a.score);
      sel = 0;
      return draw();
    }
    const cmdOnly = raw.startsWith('>');
    const q = (cmdOnly ? raw.slice(1) : raw).trim();
    const cmds = COMMANDS.filter((c) => c.title && (!c.when || c.when()))
      .map((c) => ({ kind: 'cmd', c, score: fuzzy(c.title, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    const notes = cmdOnly ? [] : live()
      .map((n) => ({ kind: 'note', n, score: q ? fuzzy(n.title, q) : n.mtime }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    items = cmdOnly ? cmds : [...notes.slice(0, 8), ...cmds.slice(0, q ? 6 : 0)];
    sel = 0;
    draw();
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
  });
  input.value = initial;
  update();
  input.focus();
}

// Model choices for the Claude settings ('' = the given default label; null = no default entry).
const MODEL_OPTS = (dflt) => [
  ...(dflt ? [['', dflt]] : []),
  ['opus', 'Opus (most capable)'], ['fable', 'Fable'], ['sonnet', 'Sonnet (balanced)'], ['haiku', 'Haiku (fastest, smallest)'],
].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

async function openSettings() {
  const ov = overlay('modal-ov');
  const sizes = [12, 13, 14, 15, 16, 17, 18, 20, 22];
  const themes = await api.themes();
  const groups = new Map();
  for (const t of themes) {
    if (!groups.has(t.source)) groups.set(t.source, []);
    groups.get(t.source).push(t);
  }
  const themeOptions = [...groups].map(([src, list]) => `<optgroup label="${esc(src)} themes">${
    list.map((t) => `<option value="theme:${esc(t.key)}">${esc(t.label)}</option>`).join('')}</optgroup>`).join('');
  ov.innerHTML = `
    <div class="modal settings">
      <h2>Settings</h2>
      <div class="group-label">Appearance</div>
      <label class="row"><span>Theme</span><select data-k="theme" class="theme-select">
        <optgroup label="VibeNote">
          <option value="system">Match system (light / dark)</option>
          <option value="light">VibeNote Light</option>
          <option value="dark">VibeNote Dark</option>
        </optgroup>
        <optgroup label="Visual Studio Code">
          <option value="vscode">Same as VS Code (follows changes)</option>
        </optgroup>
        ${themeOptions}
      </select></label>
      <div class="row"><span class="sub">Use any VS Code colour theme — installed ones appear above automatically.</span>
        <button class="btn" data-act="import">Import theme…</button></div>
      <div class="group-label">Editor</div>
      <label class="row"><span>Editor font</span><select data-k="editorFont">
        <option value="mono">Monospace</option><option value="sans">Sans-serif</option><option value="serif">Serif</option></select></label>
      <label class="row"><span>Font size</span><select data-k="fontSize" data-num>
        ${sizes.map((v) => `<option value="${v}">${v} px</option>`).join('')}</select></label>
      <label class="row"><span>Line width</span><select data-k="lineWidth">
        <option value="narrow">Narrow</option><option value="medium">Medium</option><option value="wide">Wide</option><option value="full">Full width</option></select></label>
      <label class="row"><span>Line numbers</span><input type="checkbox" data-k="lineNumbers"></label>
      <label class="row"><span>Vim key bindings</span><input type="checkbox" data-k="vim"></label>
      <label class="row"><span>Spell check</span><input type="checkbox" data-k="spellcheck"></label>
      <label class="row"><span>Fetch page titles when pasting links</span><input type="checkbox" data-k="linkTitles"></label>
      <label class="row"><span>Sync preview scrolling</span><input type="checkbox" data-k="scrollSync"></label>
      <div class="group-label">Claude</div>
      <label class="row"><span>Claude panel model</span><select data-k="agentModel">${MODEL_OPTS('Claude Code’s default')}</select></label>
      <label class="row"><span>Comments &amp; suggested fixes</span><select data-k="commentModel">${MODEL_OPTS('Same as Claude panel')}</select></label>
      <label class="row"><span>/claude writing</span><select data-k="writeModel">${MODEL_OPTS('Same as Claude panel')}</select></label>
      <label class="row"><span>Inline suggestions while writing (Tab to accept)</span><input type="checkbox" data-k="inlineSuggest"></label>
      <label class="row"><span>Inline suggestions model</span><select data-k="suggestModel">${MODEL_OPTS(null)}</select></label>
      <p class="path">Smaller models (Haiku) answer faster and use less of your plan; bigger ones (Opus, Fable) write better.</p>
      <div class="group-label">Storage</div>
      <div class="row"><span>Notes folder</span><button class="btn" data-act="folder">Change…</button></div>
      <p class="path">${esc(S.root)}</p>
      <div class="actions"><button class="btn primary" data-act="close">Done</button></div>
    </div>`;
  for (const input of $$('[data-k]', ov)) {
    const k = input.dataset.k;
    if (input.type === 'checkbox') input.checked = !!S.settings[k];
    else input.value = String(S.settings[k]);
    input.addEventListener('change', () => {
      const v = input.type === 'checkbox' ? input.checked : input.hasAttribute('data-num') ? Number(input.value) : input.value;
      api.setSettings({ [k]: v });
    });
  }
  $('[data-act=folder]', ov).addEventListener('click', () => { closeOverlay(); chooseFolder(); });
  $('[data-act=import]', ov).addEventListener('click', async () => {
    try {
      const before = new Set(themes.map((t) => t.key));
      const list = await api.importTheme();
      if (!list) return;
      const added = list.find((t) => !before.has(t.key));
      if (added) await api.setSettings({ theme: `theme:${added.key}` });
      toast(added ? `Imported “${added.label}”` : 'Theme imported');
      openSettings();
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
  });
  $('[data-act=close]', ov).addEventListener('click', closeOverlay);
  $('[data-act=close]', ov).focus();
}

async function openHistory() {
  if (!S.current || isTrashed()) return;
  await save();
  await api.snapshot(S.current);
  const path = S.current;
  const list = await api.history(path);
  const ov = overlay('modal-ov');
  ov.innerHTML = `
    <div class="modal history">
      <div class="hist-side"><h2>Version history</h2><ul></ul></div>
      <div class="hist-main">
        <div class="hist-tabs seg"><button data-view="changes" class="active">Changes</button><button data-view="full">Full text</button></div>
        <article class="markdown hist-preview"></article>
        <div class="actions">
          <button class="btn" data-act="close">Close</button>
          <button class="btn primary" data-act="restore" disabled>Restore this version</button>
        </div>
      </div>
    </div>`;
  const ul = $('ul', ov);
  const article = $('article', ov);
  const restoreBtn = $('[data-act=restore]', ov);
  $('[data-act=close]', ov).addEventListener('click', closeOverlay);
  if (!list.length) {
    ul.append(el('li', 'hist-empty', 'No saved versions yet. Versions are kept as you edit.'));
    return;
  }
  let chosen = null;
  let view = 'changes';
  let index = 0;
  const bodies = new Map();
  const bodyOf = async (i) => (bodies.has(i) ? bodies.get(i) : bodies.set(i, (await api.historyRead(path, list[i].id)).body).get(i));
  // What changed in version i compared with the version before it: added lines green, removed red.
  const showChanges = async (i) => {
    const prev = i + 1 < list.length ? await bodyOf(i + 1) : '';
    const parts = diffLines(prev, await bodyOf(i));
    article.classList.remove('markdown');
    article.classList.add('hist-diff');
    article.textContent = '';
    if (!parts.some((p) => p.added || p.removed)) { article.append(el('div', 'hist-same', 'No text changes in this version.')); return; }
    article.append(el('div', 'hist-diff-head', i + 1 < list.length ? `Compared with ${fullFmt.format(new Date(list[i + 1].ts))}` : 'First saved version'));
    for (const p of parts) {
      const lines = p.value.replace(/\n$/, '').split('\n');
      if (!p.added && !p.removed) {
        const keep = lines.length > 6 ? [...lines.slice(0, 2), `… ${lines.length - 4} unchanged lines …`, ...lines.slice(-2)] : lines;
        keep.forEach((l, k) => article.append(el('div', lines.length > 6 && k === 2 ? 'dl gap' : 'dl', l || ' ')));
      } else for (const l of lines) article.append(el('div', p.added ? 'dl add' : 'dl del', (p.added ? '+ ' : '− ') + l));
    }
  };
  const showFull = async (i) => {
    article.classList.add('markdown');
    article.classList.remove('hist-diff');
    article.innerHTML = renderMarkdown(await bodyOf(i));
    await postProcess(article, { dir: dirOf(path), dark: isDark() });
  };
  const select = async (i) => {
    index = i;
    $$('li', ul).forEach((li, j) => li.classList.toggle('sel', i === j));
    chosen = await api.historyRead(path, list[i].id);
    bodies.set(i, chosen.body);
    await (view === 'changes' ? showChanges(i) : showFull(i));
    restoreBtn.disabled = i === 0;
    restoreBtn.dataset.ts = list[i].ts;
  };
  $$('.hist-tabs button', ov).forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    $$('.hist-tabs button', ov).forEach((x) => x.classList.toggle('active', x === b));
    select(index);
  }));
  list.forEach((v, i) => {
    const li = el('li');
    const who = el('span', `hist-who who-${(v.label || 'You').toLowerCase().replace(/[^a-z]+/g, '-')}`, v.label || 'You');
    li.append(el('span', 'hist-date', fullFmt.format(new Date(v.ts))), el('span', 'hist-label', i === 0 ? 'Current version' : ''), who);
    li.addEventListener('click', () => select(i));
    ul.append(li);
  });
  restoreBtn.addEventListener('click', async () => {
    if (!chosen || path !== S.current) return;
    closeOverlay();
    S.meta = { ...chosen.meta, title: chosen.meta.title || S.meta.title };
    const cur = currentNote();
    if (cur) cur.title = S.meta.title;
    editor.replaceDoc(chosen.body, true);
    renderMeta();
    await save(true);
    toast(`Restored version from ${fullFmt.format(new Date(Number(restoreBtn.dataset.ts)))}`);
  });
  select(0);
}

// ---------- commands ----------
const needNote = () => !!S.current && !isTrashed();
const COMMANDS = [
  { id: 'new-note', title: 'New Note', key: '⌘N', run: () => newNote() },
  { id: 'new-api', title: 'New API Spec (Swagger / OpenAPI)', key: '⌥⌘N', run: () => newNote(undefined, 'api') },
  { id: 'new-notebook', title: 'New Notebook', key: '⇧⌘N', run: () => newNotebook(), when: () => !SINGLE },
  { id: 'search', title: 'Search Notes', key: '⇧⌘F', run: focusSearch },
  { id: 'palette', run: () => openPalette() },
  { id: 'toggle-pin', title: 'Pin / Unpin Note', key: '⌥⌘P', when: needNote, run: () => { S.meta.pinned = !S.meta.pinned; metaChanged(); } },
  { id: 'edit-tags', title: 'Add Tag', key: '⌥⌘T', when: needNote, run: () => $('#tag-input').focus() },
  ...Object.entries(STATUS).map(([k, s], i) => ({
    id: `status-${k}`, title: `Set Status: ${s.label}`, key: `⌥⌘${i + 1}`, when: needNote,
    run: () => { S.meta.status = k; metaChanged(); },
  })),
  { id: 'status-none', title: 'Clear Status', key: '⌥⌘0', when: needNote, run: () => { S.meta.status = ''; metaChanged(); } },
  { id: 'insert-image', title: 'Insert Image…', key: '⇧⌘U', when: needNote, run: insertImages },
  { id: 'copy-link', title: 'Copy Link to Note', key: '⌥⌘L', when: () => !!S.current, run: () => copyLink() },
  { id: 'history', title: 'Version History', key: '⌥⌘Y', when: needNote, run: openHistory },
  { id: 'open-window', title: 'Open Note in New Window', key: '⌥⌘O', when: () => !!S.current && !SINGLE, run: async () => { await save(); api.openWindow(S.current); } },
  { id: 'export-html', title: 'Export as HTML', when: () => !!S.current && !isApi(), run: () => exportNote('html') },
  { id: 'export-pdf', title: 'Export as PDF', key: '⇧⌘E', when: () => !!S.current && !isApi(), run: () => exportNote('pdf') },
  { id: 'print', title: 'Print', key: '⌘P', when: () => !!S.current, run: printNote },
  { id: 'reveal', title: 'Reveal Note in Finder', key: '⇧⌘R', when: () => !!S.current, run: () => api.reveal(S.current) },
  { id: 'trash', title: 'Move Note to Trash', when: needNote, run: () => trashNote(S.current) },
  { id: 'go-all', title: 'Go to All Notes', key: '⇧⌘A', when: () => !SINGLE, run: () => setFilter({ type: 'all' }) },
  { id: 'go-inbox', title: 'Go to Inbox', key: '⇧⌘I', when: () => !SINGLE, run: () => setFilter({ type: 'inbox' }) },
  { id: 'go-trash', title: 'Go to Trash', key: '⇧⌘T', when: () => !SINGLE, run: () => setFilter({ type: 'trash' }) },
  { id: 'empty-trash', title: 'Empty Trash', run: emptyTrash },
  { id: 'confluence-fetch', title: 'Fetch from Confluence…', when: () => !SINGLE, run: () => confluence.openFetch() },
  { id: 'confluence-push', title: 'Push to Confluence…', when: () => !isTrashed() && confluenceInfo(S.meta)?.kind === 'page', run: () => confluence.push() },
  { id: 'confluence-changes', title: 'Changes to Push to Confluence…', when: () => !SINGLE, run: () => changesUI.open() },
  { id: 'confluence-publish', title: 'Publish as a New Confluence Page…', when: () => !isTrashed() && !!currentNote() && !confluenceInfo(S.meta) && !isApi(), run: () => confluence.publishNote() },
  { id: 'confluence-pull', title: 'Pull Latest from Confluence', when: () => !isTrashed() && confluenceInfo(S.meta)?.kind === 'page', run: () => confluence.pull() },
  { id: 'confluence-open', title: 'Open in Confluence', when: () => !!confluenceInfo(S.meta), run: () => confluence.openInConfluence() },
  { id: 'confluence-pictures', title: 'Get Pictures from Confluence (images, draw.io)', when: () => !isTrashed() && confluenceInfo(S.meta)?.kind === 'page', run: () => confluence.downloadPictures() },
  { id: 'confluence-signout', title: 'Sign Out of Atlassian', run: () => confluence.signOut() },
  { id: 'mode-edit', title: 'View: Editor Only', key: '⌘1', run: () => setMode('edit') },
  { id: 'mode-split', title: 'View: Split', key: '⌘2', run: () => setMode('split') },
  { id: 'mode-preview', title: 'View: Preview Only', key: '⌘3', run: () => setMode('preview') },
  { id: 'toggle-sidebar', title: 'Toggle Sidebar', key: '⌘\\', when: () => !SINGLE, run: () => document.body.classList.toggle('no-sidebar') },
  { id: 'focus-mode', title: 'Toggle Focus Mode', key: '⇧⌘↵', run: () => document.body.classList.toggle('focus') },
  { id: 'sort-updated', title: 'Sort by Date Updated', run: () => setSort('updated') },
  { id: 'sort-created', title: 'Sort by Date Created', run: () => setSort('created') },
  { id: 'sort-title', title: 'Sort by Title', run: () => setSort('title') },
  { id: 'group-folder', title: 'Group Notes by Notebook', when: () => !SINGLE, run: () => setGroup('folder') },
  { id: 'group-tag', title: 'Group Notes by Tag', when: () => !SINGLE, run: () => setGroup('tag') },
  { id: 'group-type', title: 'Group Notes by Type', when: () => !SINGLE, run: () => setGroup('type') },
  { id: 'group-none', title: 'Don’t Group Notes', when: () => !SINGLE, run: () => setGroup('none') },
  { id: 'sections-expand', title: 'Expand All Note List Headings', when: () => !SINGLE && S.sections.length > 0, run: () => setSections(true) },
  { id: 'sections-collapse', title: 'Collapse All Note List Headings', when: () => !SINGLE && S.sections.length > 0, run: () => setSections(false) },
  { id: 'settings', title: 'Settings', key: '⌘,', run: openSettings },
  { id: 'toggle-agent', title: 'Toggle Claude Panel', key: '⌘J', run: () => { comments.toggle(false); agentPanel.toggle(); } },
  { id: 'claude-chats', title: 'Claude Chats… (past chats: read, continue, save as note)', when: () => !SINGLE, run: () => chatsUI.open() },
  { id: 'claude-write', title: 'Ask Claude to Write… (/claude)', key: '⇧⌘J', when: needNote, run: () => writer.open() },
  { id: 'add-comment', title: 'Add Comment on Selection', key: '⌥⌘M', when: needNote, run: () => comments.addComment() },
  { id: 'toggle-comments', title: 'Toggle Comments', key: '⇧⌘M', run: () => comments.toggle() },
  { id: 'outline', title: 'Go to Heading', key: '⇧⌘O', when: () => !!S.current, run: () => openPalette('#') },
  { id: 'nav-back', title: 'Go Back', key: '⌃-', run: () => navigate(-1) },
  { id: 'nav-forward', title: 'Go Forward', key: '⌃⇧-', run: () => navigate(1) },
  ...[
    ['fmt-bold', 'Bold', '⌘B', toggleWrap('**')],
    ['fmt-italic', 'Italic', '⌘I', toggleWrap('*')],
    ['fmt-strike', 'Strikethrough', '⇧⌘X', toggleWrap('~~')],
    ['fmt-code', 'Inline Code', '⌘E', toggleWrap('`')],
    ['fmt-highlight', 'Highlight', '⇧⌘H', toggleWrap('==')],
    ['fmt-link', 'Insert Link', '⌥⌘K', insertLink],
    ['fmt-task', 'Toggle Checkbox', '⌘↵', toggleTask],
    ...[1, 2, 3, 4, 5, 6].map((n) => [`fmt-h${n}`, `Heading ${n}`, `⌃${n}`, setHeading(n)]),
    ['fmt-h0', 'Normal Text', '⌃0', setHeading(0)],
    ['line-up', 'Move Line Up', '⌥↑', moveLineUp],
    ['line-down', 'Move Line Down', '⌥↓', moveLineDown],
    ['line-dup', 'Duplicate Line', '⇧⌥↓', copyLineDown],
    ['line-delete', 'Delete Line', '⇧⌘K', deleteLine],
    ['line-join', 'Join Lines', '⌃J', joinLines],
    ['line-sort', 'Sort Lines', 'F5', sortLines(false)],
    ['line-sort-desc', 'Sort Lines (Z→A)', '⇧F5', sortLines(true)],
    ['case-upper', 'Transform to UPPER CASE', '', changeCase(true)],
    ['case-lower', 'Transform to lower case', '', changeCase(false)],
  ].map(([id, title, key, cmd]) => ({ id, title, key, when: needNote, run: () => editor.run(cmd) })),
  { id: 'choose-folder', title: 'Change Notes Folder', run: chooseFolder },
];

function runCommand(id) {
  const c = COMMANDS.find((x) => x.id === id);
  if (c && (!c.when || c.when())) c.run();
}

function focusSearch() {
  if (SINGLE) return openPalette();
  document.body.classList.remove('focus');
  const s = $('#search');
  s.focus();
  s.select();
}

// ---------- wiring ----------
function bindUI() {
  $('#add-notebook').addEventListener('click', () => newNotebook());
  $('#cf-fetch').addEventListener('click', () => confluence.openFetch());
  $('#api-add').addEventListener('click', () => { setFilter({ type: 'notebook', name: API_ROOT }); newNote(undefined, 'api'); });
  $('#push-btn').addEventListener('click', () => (confluenceInfo(S.meta) ? confluence.push() : confluence.publishNote()));
  $('#comments-btn').addEventListener('click', () => comments.toggle());
  $('#folder-btn').addEventListener('click', chooseFolder);
  $('#new-note').addEventListener('click', () => newNote());
  $('#empty-new').addEventListener('click', () => newNote());
  $('#sort-btn').addEventListener('click', sortMenu);
  $('#more-btn').addEventListener('click', moreMenu);
  $('#back-btn').addEventListener('click', () => navigate(-1));
  $('#image-btn').addEventListener('click', insertImages);
  $('#agent-btn').addEventListener('click', () => { comments.toggle(false); agentPanel.toggle(); });
  window.addEventListener('vibe:insert-image', insertImages);
  $('#fwd-btn').addEventListener('click', () => navigate(1));

  // Keep the preview roughly in step with the editor while scrolling (split view)
  const scroller = editor.view.scrollDOM;
  scroller.addEventListener('scroll', () => {
    if (!S.settings.scrollSync || S.mode !== 'split') return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const box = $('#preview');
    box.scrollTop = max > 0 ? (scroller.scrollTop / max) * (box.scrollHeight - box.clientHeight) : 0;
  }, { passive: true });
  $('#pin-btn').addEventListener('click', () => runCommand('toggle-pin'));
  $('#restore-btn').addEventListener('click', () => restoreNote(S.current));
  $('#delete-btn').addEventListener('click', () => deleteForever(S.current));
  $('#nb-select').addEventListener('change', (e) => S.current && moveNote(S.current, e.target.value));
  $('#status-select').addEventListener('change', (e) => { if (S.meta) { S.meta.status = e.target.value; metaChanged(); } });
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const titleInput = $('#title-input');
  titleInput.addEventListener('input', () => {
    if (!S.meta || isTrashed()) return;
    S.meta.title = titleInput.value.trim() || 'Untitled';
    const n = currentNote();
    if (n) { n.title = S.meta.title; n.meta = S.meta; }
    onEdit();
    updateTitle();
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      editor.view.focus();
      if (e.key !== 'Escape') editor.view.dispatch({ selection: { anchor: 0 } });
    }
  });
  titleInput.addEventListener('blur', () => { if (!titleInput.value.trim() && S.meta) titleInput.value = ''; });

  const tagInput = $('#tag-input');
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
    else if (e.key === 'Backspace' && !tagInput.value && S.meta?.tags.length) { S.meta.tags.pop(); metaChanged(); }
    else if (e.key === 'Escape') { tagInput.value = ''; editor.view.focus(); }
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) addTag(tagInput.value); });

  $('#preview').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#note:')) { e.preventDefault(); openByTitle(decodeURIComponent(href.slice(6))); }
    else if (/atlassian\.net\/wiki\//.test(href) && !e.metaKey) {
      const id = /\/pages\/(\d+)/.exec(href)?.[1] || /[?&]pageId=(\d+)/.exec(href)?.[1];
      const local = id && live().find((n) => confluenceInfo(n.meta)?.id === id);
      if (local) { e.preventDefault(); if (!visibleNotes().includes(local)) setFilter({ type: 'all' }); openNote(local.path); }
    }
    else if (href.startsWith('#')) {
      e.preventDefault();
      const target = href.length > 1 && $('#preview').querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  const search = $('#search');
  search.addEventListener('input', () => { S.query = search.value; renderList(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      S.query = '';
      renderList();
      editor.view.focus();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = S.order;
      if (!list.length) return;
      e.preventDefault();
      const i = list.findIndex((n) => n.path === S.current);
      let j = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : Math.max(i, 0);
      j = Math.max(0, Math.min(list.length - 1, j));
      openNote(list[j].path).then(() => { if (e.key === 'Enter') editor.view.focus(); });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#overlay').hidden) { closeOverlay(); return; }
    if (document.body.classList.contains('focus') && !S.settings.vim) document.body.classList.remove('focus');
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderPreview());
  api.onChanged(() => refresh());
  api.onSettings(applySettings);
  api.onTheme(onThemeChanged);
  api.onCommand(async (cmd) => {
    if (cmd === 'flush') {
      await leaveCurrent();
      return api.flushed();
    }
    runCommand(cmd);
  });
  window.addEventListener('blur', () => save());
}

// ---------- Claude panel ----------
const confluence = createConfluenceUI({
  api, S, $, el, esc, overlay, closeOverlay, toast, save, refresh, setFilter, openNote, currentNote,
  editorText: () => editor.text(),
  rerender: () => renderPreview(),
  resolveLink: (target) => {
    const { note, frag } = findByTarget(target);
    const info = note && confluenceInfo(note.meta);
    if (!info || info.kind !== 'page') return null;
    return frag && !parseOperation(frag) ? `${info.url}#${frag.trim().replace(/\s+/g, '-')}` : info.url;
  },
});

let refreshSoon = null;
const agentPanel = createAgentPanel({
  api,
  getContext: () => {
    const n = currentNote();
    return {
      notebook: n ? n.notebook : (S.filter.type === 'notebook' ? S.filter.name : ''),
      notePath: n && !n.trashed ? n.path : null,
      noteTitle: n ? n.title : null,
    };
  },
  beforeSend: () => save(),
  // Claude edits files directly; the folder watcher picks that up, this just makes it snappy.
  onNoteMaybeChanged: () => { clearTimeout(refreshSoon); refreshSoon = setTimeout(refresh, 150); },
  openChats: () => chatsUI.open(),
});

// "Changes to push": Confluence pages edited here but not pushed yet.
var changesUI = createChangesUI({
  api, S, $, el, overlay, closeOverlay, toast, save, openNote, refresh,
  editorText: () => editor.text(),
  isConfluencePage: (n) => confluenceInfo(n.meta)?.kind === 'page',
  idOf: (n) => confluenceInfo(n.meta)?.id,
  pushOne: async (p) => { await openNote(p); confluence.push(); },
  pushMany: (list, onStep) => confluence.pushMany(list, onStep),
  rerender: () => { renderSidebar(); renderList(); },
});

// Claude Chats window: past Claude Code chats → read, continue in the panel, save as a note.
const chatsUI = createChatsUI({
  api, $, el, overlay, closeOverlay, toast,
  getNotebook: () => { const n = currentNote(); return n ? n.notebook : (S.filter.type === 'notebook' ? S.filter.name : ''); },
  afterContinue: async (key) => {
    await save();
    await refresh();
    setFilter({ type: 'notebook', name: key });
    const newest = live().filter((n) => inBook(n, key)).sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) await openNote(newest.path);
    else { await leaveCurrent(); closeNote(); }
    agentPanel.toggle(true);
  },
  afterExport: async (p) => {
    await refresh();
    const n = S.notes.find((x) => x.path === p);
    if (n && !visibleNotes().includes(n)) setFilter({ type: 'all' });
    await openNote(p);
  },
});

comments = createComments({
  api, S, $, el, esc, editor, toast, metaChanged, isTrashed,
  closeAgent: () => { if (document.body.classList.contains('agent-open')) agentPanel.toggle(false); },
});

const writer = createWriter({ api, S, $, el, editor, isTrashed, toast, isDark, dirOf, isApi });

// ```yaml / ```json OpenAPI blocks in a note's preview get an "API docs" button → Swagger in a big window.
window.addEventListener('vibe:api-docs', (e) => {
  const { text, focus } = typeof e.detail === 'string' ? { text: e.detail } : e.detail;
  const ov = overlay('modal-ov');
  ov.innerHTML = '<div class="modal api-modal"><div class="api-modal-head"><h2>API docs</h2><span class="hint">From the code block in this note · Try it out works here too</span><div class="spacer"></div><button class="btn" data-act="extract" title="Copy this spec into the APIs section as its own YAML page">Save as API spec</button><button class="btn" data-act="close">Close</button></div><div class="api-modal-body"></div></div>';
  $('[data-act=close]', ov).addEventListener('click', closeOverlay);
  $('[data-act=extract]', ov).addEventListener('click', async () => {
    const title = /^\s{2}title:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] || S.meta?.title || 'API spec';
    try {
      const p = await api.create(API_ROOT, title, 'api');
      await api.save(p, { title: nameOf(p) }, text.endsWith('\n') ? text : text + '\n');
      closeOverlay();
      await refresh();
      setFilter({ type: 'notebook', name: API_ROOT });
      await openNote(p);
      toast(`Saved as an API spec in ${API_ROOT}. It's a copy — the note keeps its own version.`);
    } catch (err) { toast('Could not save: ' + err.message); }
  });
  const docs = createApiDocs({ api, container: $('.api-modal-body', ov), isDark: () => isDark() });
  docs.show('block:' + text.length + ':' + text.slice(0, 200), text).then(() => { if (focus) docs.focus(focus); });
});

(async function start() {
  if (SINGLE) document.body.classList.add('single');
  bindUI();
  setupResizers({ load, store, onResized: () => editor.view.requestMeasure() });
  applySettings(await api.getSettings());
  applyTheme(await api.currentTheme());
  setMode(S.mode);
  await refresh();
  const target = SINGLE || load('last', null);
  const first = (target && S.notes.find((n) => n.path === target)) || (!SINGLE && visibleNotes()[0]);
  if (first) await openNote(first.path);
})();
