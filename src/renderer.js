// VibeNote — renderer: state, sidebar, note list, editor/preview, palette and dialogs.
import { createEditor } from './editor.js';
import { renderMarkdown, postProcess, setLinkResolver } from './markdown.js';
import { parseQuery, matchQuery, fuzzy } from './search.js';

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
  current: null, // path of the open note
  currentId: null, // file identity, survives renames done elsewhere
  meta: null, // metadata of the open note (source of truth while editing)
  dirty: false,
  touched: false, // edited since opened (→ snapshot on leave)
  fresh: new Set(), // notes created this session (empty ones get discarded)
  mode: load('mode', 'split'),
  expanded: new Set(load('expanded', [])),
  settings: {},
};

const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const parentOf = (nb) => (nb.includes('/') ? nb.slice(0, nb.lastIndexOf('/')) : '');
const leafOf = (nb) => nb.slice(nb.lastIndexOf('/') + 1);
const inBook = (n, nb) => n.notebook === nb || n.notebook.startsWith(nb + '/');
const live = () => S.notes.filter((n) => !n.trashed);
const currentNote = () => S.notes.find((n) => n.path === S.current);
const isTrashed = () => !!currentNote()?.trashed;
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function titleOf(body, fallback) {
  for (const line of body.split('\n')) {
    const s = line.replace(/^#{1,6}\s+/, '').trim();
    if (s) return s;
  }
  return fallback;
}

function findByTitle(t) {
  const q = t.trim().toLowerCase();
  const l = live();
  return l.find((n) => n.title.toLowerCase() === q) || l.find((n) => n.name.toLowerCase() === q);
}

// ---------- editor ----------
const editor = createEditor({
  parent: $('#editor'),
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
  getTitles: () => [...new Set(live().filter((n) => n.path !== S.current).map((n) => n.title))],
});
setLinkResolver((title) => !!findByTitle(title));

// ---------- saving ----------
let saveTimer = null;
let listTimer = null;
let saveChain = Promise.resolve();

function onEdit() {
  S.dirty = true;
  S.touched = true;
  const n = currentNote();
  if (n) {
    n.body = editor.text();
    n.title = titleOf(n.body, n.name);
    n.mtime = Date.now();
  }
  setStatusSaved(false);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 200);
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
      if (n) Object.assign(n, { path: to, name: nameOf(to), mtime: Date.now(), title: titleOf(n.body, nameOf(to)) });
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
          cur.title = titleOf(cur.body, cur.name);
        } else {
          S.meta = cur.meta;
          if (cur.body !== editor.text()) editor.replaceDoc(cur.body);
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
    ['all', 'inbox', 'trash'].includes(f.type) ||
    (f.type === 'notebook' && S.notebooks.includes(f.name)) ||
    (f.type === 'status' && STATUS[f.name]) ||
    (f.type === 'tag' && live().some((n) => n.meta.tags.includes(f.name)));
  if (!ok) S.filter = { type: 'all' };
}

async function leaveCurrent() {
  await save();
  const p = S.current;
  if (!p) return;
  if (S.fresh.has(p) && editor.text().trim() === '') {
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
  let data;
  try { data = await api.read(path); } catch { return refresh(); }
  Object.assign(n, { meta: data.meta, body: data.body, title: titleOf(data.body, n.name) });
  S.current = path;
  S.currentId = n.id;
  S.meta = data.meta;
  S.dirty = false;
  S.touched = false;
  editor.setDoc(data.body, !!n.trashed);
  if (!SINGLE) store('last', path);
  renderAll();
  renderPreview();
  updateStatus();
  setStatusSaved(true);
  updateTitle();
}

function closeNote() {
  S.current = null;
  S.currentId = null;
  S.meta = null;
  S.dirty = false;
  editor.setDoc('');
  renderAll();
  updateTitle();
}

async function newNote(title) {
  const f = S.filter;
  const nb = f.type === 'notebook' ? f.name : SINGLE && currentNote() ? currentNote().notebook : '';
  await leaveCurrent();
  if (f.type === 'trash') setFilter({ type: 'all' });
  try {
    const p = await api.create(nb, typeof title === 'string' ? title : '');
    if (typeof title !== 'string') S.fresh.add(p);
    S.query = '';
    $('#search').value = '';
    await refresh();
    await openNote(p);
    if (f.type === 'tag') { S.meta.tags.push(f.name); metaChanged(); }
    if (f.type === 'status') { S.meta.status = f.name; metaChanged(); }
    if (S.mode === 'preview') setMode('split');
    editor.view.focus();
  } catch (e) {
    toast(e.message);
  }
}

async function openByTitle(title) {
  const n = findByTitle(title);
  if (n) {
    if (!visibleNotes().includes(n)) setFilter({ type: 'all' });
    return openNote(n.path);
  }
  if (confirm(`There's no note called “${title}”. Create it?`)) newNote(title);
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
    const list = visibleNotes();
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
  const lines = n.body.split('\n');
  const start = lines.findIndex((l) => l.trim());
  return lines
    .slice(start + 1)
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
  const tree = (parent, depth) => {
    for (const nb of S.notebooks.filter((x) => parentOf(x) === parent)) {
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
      wrap.append(row);
      if (kids && open) tree(nb, depth + 1);
    }
  };
  tree('', 0);
  if (!S.notebooks.length) wrap.append(el('div', 'hint', 'Notebooks are folders. Click + to add one.'));

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
  return { all: 'All Notes', inbox: 'Inbox', trash: 'Trash' }[f.type]
    || (f.type === 'notebook' ? leafOf(f.name) : f.type === 'tag' ? `# ${f.name}` : STATUS[f.name]?.label || '');
}

function renderList() {
  const list = visibleNotes();
  const title = filterLabel();
  $('#list-title').textContent = S.query ? `${list.length} result${list.length === 1 ? '' : 's'} in ${title}` : title;
  $('#sort-btn').hidden = S.filter.type === 'trash';

  const ul = $('#notes');
  ul.textContent = '';
  if (!list.length) {
    const msg = S.query ? 'No matching notes' : S.filter.type === 'trash' ? 'Trash is empty' : 'No notes yet. Press ⌘N';
    ul.append(el('li', 'list-empty', msg));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const n of list) {
    const li = el('li', 'note');
    li.dataset.path = n.path;
    li.draggable = true;
    if (n.path === S.current) li.classList.add('active');

    const head = el('div', 'note-title');
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
    frag.append(li);
  }
  ul.append(frag);
  ul.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function renderToolbar() {
  const n = currentNote();
  document.body.classList.toggle('no-note', !n);
  document.body.classList.toggle('in-trash', !!n?.trashed);
  const sel = $('#nb-select');
  sel.textContent = '';
  sel.append(new Option('Inbox', ''));
  for (const nb of S.notebooks) {
    sel.append(new Option('   '.repeat(nb.split('/').length - 1) + leafOf(nb), nb));
  }
  sel.value = n ? n.notebook : '';
  sel.disabled = !n || n.trashed;
  $('#pin-btn').classList.toggle('on', !!S.meta?.pinned);
  $('#pin-btn').title = S.meta?.pinned ? 'Unpin note (⌥⌘P)' : 'Pin note (⌥⌘P)';
  $$('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
}

function renderMeta() {
  const m = S.meta;
  if (!m) return;
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
  const seq = ++previewSeq;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMarkdown(editor.text());
  await postProcess(tmp, {
    dir: dirOf(S.current),
    dark: isDark(),
    onTask: isTrashed() ? null : (i) => editor.toggleTask(i),
  });
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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
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
    { id: 'updated', label: 'Date Updated', checked: S.sort === 'updated' },
    { id: 'created', label: 'Date Created', checked: S.sort === 'created' },
    { id: 'title', label: 'Title', checked: S.sort === 'title' },
  ]);
  if (id) setSort(id);
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
  tmp.innerHTML = renderMarkdown(editor.text());
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
  ov.innerHTML = '<div class="palette"><input spellcheck="false" placeholder="Jump to a note… or type > for commands"><ul></ul></div>';
  const input = $('input', ov);
  const ul = $('ul', ov);
  let items = [];
  let sel = 0;
  const run = (it) => {
    closeOverlay();
    if (it.kind === 'note') {
      if (!visibleNotes().includes(it.n)) setFilter({ type: 'all' });
      openNote(it.n.path);
    } else {
      it.c.run();
    }
  };
  const draw = () => {
    ul.textContent = '';
    items.forEach((it, i) => {
      const li = el('li', i === sel ? 'sel' : '');
      if (it.kind === 'note') li.append(iconEl(it.n.meta.pinned ? ICON.pin : ICON.note), el('span', 'pl-title', it.n.title), el('span', 'pl-hint', it.n.notebook ? leafOf(it.n.notebook) : 'Inbox'));
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

function openSettings() {
  const ov = overlay('modal-ov');
  const sizes = [12, 13, 14, 15, 16, 17, 18, 20, 22];
  ov.innerHTML = `
    <div class="modal settings">
      <h2>Settings</h2>
      <label class="row"><span>Appearance</span><select data-k="theme">
        <option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="row"><span>Editor font</span><select data-k="editorFont">
        <option value="mono">Monospace</option><option value="sans">Sans-serif</option><option value="serif">Serif</option></select></label>
      <label class="row"><span>Font size</span><select data-k="fontSize" data-num>
        ${sizes.map((v) => `<option value="${v}">${v} px</option>`).join('')}</select></label>
      <label class="row"><span>Line width</span><select data-k="lineWidth">
        <option value="narrow">Narrow</option><option value="medium">Medium</option><option value="wide">Wide</option><option value="full">Full width</option></select></label>
      <label class="row"><span>Line numbers</span><input type="checkbox" data-k="lineNumbers"></label>
      <label class="row"><span>Vim key bindings</span><input type="checkbox" data-k="vim"></label>
      <label class="row"><span>Spell check</span><input type="checkbox" data-k="spellcheck"></label>
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
  const select = async (i) => {
    $$('li', ul).forEach((li, j) => li.classList.toggle('sel', i === j));
    chosen = await api.historyRead(path, list[i].id);
    article.innerHTML = renderMarkdown(chosen.body);
    await postProcess(article, { dir: dirOf(path), dark: isDark() });
    restoreBtn.disabled = i === 0;
    restoreBtn.dataset.ts = list[i].ts;
  };
  list.forEach((v, i) => {
    const li = el('li');
    li.append(el('span', 'hist-date', fullFmt.format(new Date(v.ts))), el('span', 'hist-label', i === 0 ? 'Current version' : ''));
    li.addEventListener('click', () => select(i));
    ul.append(li);
  });
  restoreBtn.addEventListener('click', async () => {
    if (!chosen || path !== S.current) return;
    closeOverlay();
    S.meta = chosen.meta;
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
  { id: 'copy-link', title: 'Copy Link to Note', key: '⌥⌘L', when: () => !!S.current, run: () => copyLink() },
  { id: 'history', title: 'Version History', key: '⌥⌘Y', when: needNote, run: openHistory },
  { id: 'open-window', title: 'Open Note in New Window', key: '⌥⌘O', when: () => !!S.current && !SINGLE, run: async () => { await save(); api.openWindow(S.current); } },
  { id: 'export-html', title: 'Export as HTML', when: () => !!S.current, run: () => exportNote('html') },
  { id: 'export-pdf', title: 'Export as PDF', key: '⇧⌘E', when: () => !!S.current, run: () => exportNote('pdf') },
  { id: 'print', title: 'Print', key: '⌘P', when: () => !!S.current, run: printNote },
  { id: 'reveal', title: 'Reveal Note in Finder', key: '⇧⌘R', when: () => !!S.current, run: () => api.reveal(S.current) },
  { id: 'trash', title: 'Move Note to Trash', when: needNote, run: () => trashNote(S.current) },
  { id: 'go-all', title: 'Go to All Notes', key: '⇧⌘A', when: () => !SINGLE, run: () => setFilter({ type: 'all' }) },
  { id: 'go-inbox', title: 'Go to Inbox', key: '⇧⌘I', when: () => !SINGLE, run: () => setFilter({ type: 'inbox' }) },
  { id: 'go-trash', title: 'Go to Trash', key: '⇧⌘T', when: () => !SINGLE, run: () => setFilter({ type: 'trash' }) },
  { id: 'empty-trash', title: 'Empty Trash', run: emptyTrash },
  { id: 'mode-edit', title: 'View: Editor Only', key: '⌘1', run: () => setMode('edit') },
  { id: 'mode-split', title: 'View: Split', key: '⌘2', run: () => setMode('split') },
  { id: 'mode-preview', title: 'View: Preview Only', key: '⌘3', run: () => setMode('preview') },
  { id: 'toggle-sidebar', title: 'Toggle Sidebar', key: '⌘\\', when: () => !SINGLE, run: () => document.body.classList.toggle('no-sidebar') },
  { id: 'focus-mode', title: 'Toggle Focus Mode', key: '⇧⌘↵', run: () => document.body.classList.toggle('focus') },
  { id: 'sort-updated', title: 'Sort by Date Updated', run: () => setSort('updated') },
  { id: 'sort-created', title: 'Sort by Date Created', run: () => setSort('created') },
  { id: 'sort-title', title: 'Sort by Title', run: () => setSort('title') },
  { id: 'settings', title: 'Settings', key: '⌘,', run: openSettings },
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
  $('#folder-btn').addEventListener('click', chooseFolder);
  $('#new-note').addEventListener('click', () => newNote());
  $('#empty-new').addEventListener('click', () => newNote());
  $('#sort-btn').addEventListener('click', sortMenu);
  $('#more-btn').addEventListener('click', moreMenu);
  $('#pin-btn').addEventListener('click', () => runCommand('toggle-pin'));
  $('#restore-btn').addEventListener('click', () => restoreNote(S.current));
  $('#delete-btn').addEventListener('click', () => deleteForever(S.current));
  $('#nb-select').addEventListener('change', (e) => S.current && moveNote(S.current, e.target.value));
  $('#status-select').addEventListener('change', (e) => { if (S.meta) { S.meta.status = e.target.value; metaChanged(); } });
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

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
    else if (href.startsWith('#')) e.preventDefault();
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
      const list = visibleNotes();
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
  api.onCommand(async (cmd) => {
    if (cmd === 'flush') {
      await leaveCurrent();
      return api.flushed();
    }
    runCommand(cmd);
  });
  window.addEventListener('blur', () => save());
}

(async function start() {
  if (SINGLE) document.body.classList.add('single');
  bindUI();
  applySettings(await api.getSettings());
  setMode(S.mode);
  await refresh();
  const target = SINGLE || load('last', null);
  const first = (target && S.notes.find((n) => n.path === target)) || (!SINGLE && visibleNotes()[0]);
  if (first) await openNote(first.path);
})();
