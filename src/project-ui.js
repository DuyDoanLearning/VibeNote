// Projects: the sidebar section, the project home page, "new project" and "add documents" (spec: docs/workspace-spec.md).
// A project is a top-level notebook with a "Project brief" note and/or a linked code folder. Its documents are the
// notes in that notebook plus the "sources" listed in the brief (Confluence pages, API specs, other notebooks).
import { renderMarkdown } from './markdown.js';

const ICON = {
  project: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5"/></svg>',
  confluence: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 00.6-7.95A6 6 0 006.2 9.5 4.3 4.3 0 007 18z"/></svg>',
  api: '<svg viewBox="0 0 24 24"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2zM5 18a2 2 0 012-2h12"/></svg>',
  repo: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 8.2v7.6M18 11.2c0 3-3 3.3-6 3.8-2 .3-4 .6-5 1.6"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  diagram: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v6M6.5 12h11v3"/></svg>',
};
const KIND_LABEL = { note: 'Note', confluence: 'Confluence', api: 'API spec' };
const STATUS_TEXT = { 'needs-ok': 'Needs your OK', working: 'Working…', idle: '' };

const BRIEF_PROMPT = `Update this project's brief note ("Project brief" in the project notebook). Look at the project's documents, the repositories (README, CLAUDE.md, recent commits) and what we discussed, then fill in: Goal, Key documents, Code (one line per repository: what it does), Decisions (newest first, each with a short why) and Open questions. Keep it under one page, in plain language. Don't invent anything: leave a section short if you don't know. Then tell me in two sentences what you wrote.`;

export function createProjectUI(ctx) {
  const { api, S, $, el, esc, overlay, closeOverlay, toast, live, inBook, kindOf, fmtDate, openNote, setFilter, leaveCurrent, closeNote, refresh, store } = ctx;
  S.projects = [];
  S.home = null; // project whose home page is showing (when no note is open)
  S.project = ctx.load('project', null); // the project you were last in (decides ties for shared documents)
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const relOf = (n) => n.path.slice(S.root.length + 1);
  const iconEl = (svg, cls = 'ico') => { const s = el('span', cls); s.innerHTML = svg; return s; };
  const chip = (text, cls = '') => el('span', `ph-chip ${cls}`.trim(), text);
  const ago = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
    return fmtDate(ms);
  };

  const inSource = (n, s) => inBook(n, s) || relOf(n) === s || relOf(n).replace(/\.[^./]+$/, '') === s;
  const docsOf = (p) => live().filter((n) => inBook(n, p.name) || p.sources.some((s) => inSource(n, s)));
  const find = (name) => S.projects.find((p) => p.name === name);

  // Which project a note belongs to: its own notebook, or a project that lists it as a document.
  function projectOf(n) {
    if (!n) return null;
    const top = n.notebook.split('/')[0];
    if (find(top)) return top;
    const owners = S.projects.filter((p) => p.sources.some((s) => inSource(n, s)));
    return (owners.find((p) => p.name === S.project) || owners[0])?.name || null;
  }

  function projectOfPath(p) {
    if (p.startsWith(S.root + '/')) {
      const top = p.slice(S.root.length + 1).split('/')[0];
      if (find(top)) return top;
    }
    return S.projects.find((x) => x.repo && p.startsWith(x.repo + '/'))?.name || null;
  }

  async function reload() {
    try { S.projects = await api.projects.list(); } catch { S.projects = []; }
    if (S.home && !find(S.home)) S.home = null;
  }

  // ---------- sidebar ----------
  let statusByProject = {}; // name → 'needs-ok' | 'working'
  function renderSide() {
    const box = $('#projects');
    if (!box) return;
    box.textContent = '';
    for (const p of S.projects) {
      const b = el('button', 'nav-item project-row');
      b.append(iconEl(ICON.project), el('span', 'label', p.name));
      const st = statusByProject[p.name];
      if (st) { const d = el('span', `thread-dot ${st}`); d.title = STATUS_TEXT[st]; b.append(d); }
      b.append(el('span', 'count', String(docsOf(p).length || '')));
      b.classList.toggle('active', S.home === p.name && !S.current);
      b.addEventListener('click', () => openHome(p.name));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); projectMenu(p); });
      box.append(b);
    }
    if (!S.projects.length) box.append(el('div', 'hint', 'A project gathers documents, code and chats. Click + to make one.'));
  }

  async function projectMenu(p) {
    const id = await api.popup([
      { id: 'home', label: 'Open Project Home' },
      { id: 'chat', label: 'New Chat' },
      { type: 'separator' },
      { id: 'docs', label: 'Add Documents…' },
      { id: 'link', label: p.repo ? 'Change Code Folder…' : 'Link a Code Folder…' },
      ...(p.repo ? [{ id: 'unlink', label: 'Unlink the Code Folder' }] : []),
    ]);
    if (id === 'home') openHome(p.name);
    if (id === 'chat') newChat(p.name);
    if (id === 'docs') addDocs(p.name);
    if (id === 'link') linkFolder(p.name);
    if (id === 'unlink') { await api.agent.unlink(p.name); await reload(); renderSide(); if (S.home === p.name) renderHome(); }
  }

  // ---------- actions ----------
  async function linkFolder(name) {
    try {
      const r = await api.agent.link(name);
      if (!r) return;
      await reload();
      renderSide();
      if (S.home === name) renderHome();
      toast(`“${name}” now works in ${r.split('/').pop()}`);
    } catch (e) { toast(errText(e)); }
  }

  async function newChat(name, cwd) {
    S.project = name;
    store('project', name);
    if (S.home !== name && projectOf(ctx.currentNote()) !== name) await openHome(name);
    await api.agent.threadNew(name, cwd ? { cwd } : {});
    await ctx.agent().toggle(true);
  }

  async function openThread(name, id) {
    await api.agent.threadSelect(name, id);
    ctx.agent().toggle(true);
  }

  async function openBrief(name) {
    try {
      const r = await api.projects.create(name);
      await refresh();
      await reload();
      await openNote(r.brief);
    } catch (e) { toast(errText(e)); }
  }

  async function openHome(name) {
    if (!find(name)) return;
    await leaveCurrent();
    await ctx.closeDiagram?.();
    S.home = name;
    S.project = name;
    store('project', name);
    setFilter({ type: 'notebook', name });
    closeNote();
    await renderHome(true);
    ctx.agent().noteChanged();
  }

  // ---------- home page ----------
  let homeSeq = 0;
  const sinceFor = {}; // name → "last looked" time for this visit (so re-renders keep showing what's new)
  async function renderHome(markSeen = false) {
    const box = $('#project-home');
    const name = S.home;
    if (!box || !name) return;
    const seq = ++homeSeq;
    let h;
    try { h = await api.projects.home(name, markSeen); } catch (e) { box.textContent = errText(e); return; }
    if (seq !== homeSeq || S.home !== name) return;
    const p = find(name);
    if (!h || !p) { box.textContent = ''; return; }
    if (markSeen || !(name in sinceFor)) sinceFor[name] = h.seenAt;
    const since = sinceFor[name];
    const docs = docsOf(p).sort((a, b) => b.mtime - a.mtime);
    const threads = h.threads.list;
    statusByProject[name] = threads.some((t) => t.status === 'needs-ok') ? 'needs-ok' : threads.some((t) => t.status === 'working') ? 'working' : '';

    const top = box.scrollTop;
    box.textContent = '';

    // header
    const head = el('div', 'ph-head');
    const titles = el('div', 'ph-titles');
    titles.append(el('div', 'ph-kicker', 'Project'), el('h1', '', name));
    const sub = el('div', 'ph-sub');
    if (h.repo && !h.repoMissing) {
      const a = el('button', 'ph-link', h.repo.replace(/^\/Users\/[^/]+/, '~'));
      a.title = 'Open this folder in Finder';
      a.addEventListener('click', () => api.projects.reveal(h.repo));
      sub.append(iconEl(ICON.repo, 'ico small'), a, document.createTextNode(h.repos.length ? ` · ${h.repos.length} ${h.repos.length === 1 ? 'repository' : 'repositories'}` : ''));
    } else {
      sub.append(document.createTextNode(h.repoMissing ? 'The linked code folder isn’t on this Mac. ' : 'No code folder linked on this Mac. '));
      const a = el('button', 'ph-link', 'Link one…');
      a.addEventListener('click', () => linkFolder(name));
      sub.append(a);
    }
    titles.append(sub);
    const actions = el('div', 'ph-actions');
    const btn = (label, cls, fn) => { const b = el('button', `btn ${cls}`, label); b.addEventListener('click', fn); actions.append(b); return b; };
    btn('New chat', 'primary', () => newChat(name));
    btn('Add documents…', '', () => addDocs(name));
    head.append(titles, actions);
    box.append(head);

    // what changed since you last looked
    const news = el('div', 'ph-news');
    const add = (text, cls, fn) => { const c = el('button', `ph-news-chip ${cls}`, text); if (fn) c.addEventListener('click', fn); else c.disabled = true; news.append(c); };
    const waiting = threads.filter((t) => t.status === 'needs-ok');
    const working = threads.filter((t) => t.status === 'working');
    if (waiting.length) add(`${waiting.length} chat${waiting.length === 1 ? '' : 's'} need${waiting.length === 1 ? 's' : ''} your OK`, 'warn', () => openThread(name, waiting[0].id));
    if (working.length) add(`${working.length} chat${working.length === 1 ? '' : 's'} working`, 'busy', () => openThread(name, working[0].id));
    const toPush = docs.filter((n) => S.cfChanged?.has(n.path));
    if (toPush.length) add(`${toPush.length} Confluence page${toPush.length === 1 ? '' : 's'} to push`, 'warn', () => ctx.openChanges?.());
    if (since) {
      const changed = docs.filter((n) => n.mtime > since);
      if (changed.length) add(`${changed.length} document${changed.length === 1 ? '' : 's'} changed`, '', () => box.querySelector('.ph-docs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      for (const r of h.repos.filter((x) => x.newCommits)) add(`${r.newCommits} new commit${r.newCommits === 1 ? '' : 's'} in ${r.name}`, '', () => box.querySelector('.ph-code')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    const label = el('span', 'ph-news-label', !since ? 'First visit' : news.childElementCount ? `Since you last looked (${ago(since)})` : `Nothing new since you last looked (${ago(since)})`);
    news.prepend(label);
    box.append(news);

    const grid = el('div', 'ph-grid');
    const card = (cls, title, extra) => {
      const c = el('section', `ph-card ${cls}`);
      const hd = el('div', 'ph-card-head');
      hd.append(el('h2', '', title));
      if (extra) hd.append(extra);
      c.append(hd);
      grid.append(c);
      return c;
    };
    const small = (label, fn, cls = '') => { const b = el('button', `ph-small ${cls}`.trim(), label); b.addEventListener('click', fn); return b; };

    // ----- brief -----
    const briefBtns = el('div', 'ph-row-btns');
    briefBtns.append(small(h.briefPath ? 'Open' : 'Create', () => openBrief(name)), small('Update with Claude', async () => {
      if (!h.briefPath) await api.projects.create(name);
      S.project = name;
      await ctx.agent().toggle(true);
      ctx.agent().ask(BRIEF_PROMPT, 'Update the project brief');
    }));
    const bc = card('ph-brief', 'Brief', briefBtns);
    if (h.brief) {
      const md = el('div', 'markdown ph-md');
      md.innerHTML = renderMarkdown(h.brief);
      bc.append(md);
    } else {
      bc.append(el('p', 'ph-hint', 'The brief is what every new chat in this project reads first: the goal, the key documents, what each repository does, decisions and open questions. Write it yourself, or let Claude draft it.'));
    }

    // ----- documents -----
    const counts = { note: 0, confluence: 0, api: 0 };
    for (const n of docs) counts[kindOf(n)]++;
    const summary = [[counts.note, 'note'], [counts.confluence, 'Confluence page'], [counts.api, 'API spec']].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`).join(' · ');
    const dc = card('ph-docs', 'Documents', small('Add…', () => addDocs(name)));
    dc.append(el('div', 'ph-sub2', summary || 'No documents yet.'));
    const ul = el('ul', 'ph-list');
    for (const n of docs.slice(0, 10)) {
      const li = el('li', 'ph-item');
      const k = kindOf(n);
      li.append(iconEl(ICON[k]), el('span', 'ph-item-title', n.title || 'Untitled'));
      if (S.cfChanged?.has(n.path)) li.append(chip('edited', 'warn'));
      else if (since && n.mtime > since) li.append(chip('changed', 'new'));
      if (k !== 'note') li.append(chip(KIND_LABEL[k]));
      li.append(el('span', 'ph-when', fmtDate(n.mtime)));
      li.addEventListener('click', () => openNote(n.path));
      ul.append(li);
    }
    dc.append(ul);
    if (docs.length > 10) dc.append(el('div', 'ph-more', `…and ${docs.length - 10} more in the note list`));
    if (p.sources.length) {
      const src = el('div', 'ph-sources');
      src.append(el('span', 'ph-sources-label', 'Also includes:'));
      for (const s of p.sources) {
        const c = el('span', 'ph-source');
        c.append(document.createTextNode(s.split('/').slice(-2).join(' / ')));
        c.title = s;
        const x = el('button', 'tag-x', '×');
        x.title = 'Remove from this project (the pages themselves stay)';
        x.addEventListener('click', async () => { await api.projects.setSources(name, p.sources.filter((y) => y !== s)); await reload(); renderSide(); renderHome(); });
        c.append(x);
        src.append(c);
      }
      dc.append(src);
    }

    // ----- diagrams -----
    const mine = (S.diagrams?.notes || []).filter((d) => d.notebook === name || d.notebook.startsWith(name + '/'));
    const drawings = [...mine.map((d) => ({ ...d, where: '' })), ...(h.diagrams || []).map((d) => ({ ...d, where: d.rel.includes('/') ? d.rel.slice(0, d.rel.lastIndexOf('/')) : '' }))];
    const gc = card('ph-diagrams', 'Diagrams', small('New', () => ctx.newDiagram(name)));
    if (!drawings.length) {
      gc.append(el('p', 'ph-hint', 'draw.io diagrams in this project’s notebook or code folder show up here. They open in the full draw.io editor, and refresh when Claude edits the file.'));
    } else {
      const gl = el('ul', 'ph-list');
      for (const d of drawings) {
        const li = el('li', 'ph-item');
        li.append(iconEl(ICON.diagram), el('span', 'ph-item-title', d.name));
        if (d.where) li.append(chip(d.where, 'branch'));
        li.title = d.path;
        li.addEventListener('click', () => ctx.openDiagram(d.path));
        gl.append(li);
      }
      gc.append(gl);
    }

    // ----- code -----
    const cc = card('ph-code', 'Code', h.repo && !h.repoMissing ? small('Chat on all of it', () => newChat(name)) : null);
    if (!h.repo || h.repoMissing) {
      cc.append(el('p', 'ph-hint', 'Link the folder that holds this project’s code. It can be one repository, or a big folder with several repositories inside: Claude then sees them all and reads each one’s own CLAUDE.md and skills.'));
      cc.append(small('Link a code folder…', () => linkFolder(name), 'primary'));
    } else if (!h.repos.length) {
      cc.append(el('p', 'ph-hint', 'No git repositories found in this folder (looked three levels deep). Claude can still work in it.'));
    } else {
      const rl = el('ul', 'ph-list');
      for (const r of h.repos) {
        const li = el('li', 'ph-item ph-repo');
        const line = el('div', 'ph-repo-line');
        line.append(iconEl(ICON.repo), el('span', 'ph-item-title', r.rel || r.name));
        if (r.branch) line.append(chip(r.branch, 'branch'));
        if (r.changed) line.append(chip(`${r.changed} uncommitted`, 'warn'));
        if (since && r.newCommits) line.append(chip(`${r.newCommits} new`, 'new'));
        if (r.hasGuide) { const g = chip('CLAUDE.md'); g.title = 'This repository has its own guide for Claude' + (r.hasSkills ? ' and its own skills' : ''); line.append(g); }
        const chatBtn = small('Chat', (e) => { e.stopPropagation(); newChat(name, r.path); });
        chatBtn.title = `New chat focused on ${r.rel || r.name}`;
        line.append(el('span', 'spacer'), chatBtn);
        li.append(line);
        if (r.last) li.append(el('div', 'ph-commit', `${r.last.subject}  ·  ${ago(r.last.at)}`));
        li.title = r.path;
        li.addEventListener('dblclick', () => api.projects.reveal(r.path));
        rl.append(li);
      }
      cc.append(rl);
    }

    // ----- chats -----
    const hc = card('ph-chats', 'Chats', small('New chat', () => newChat(name)));
    const tl = el('ul', 'ph-list');
    for (const t of [...threads].sort((a, b) => b.updated - a.updated)) {
      if (t.empty && threads.length > 1 && t.status === 'idle') continue;
      const li = el('li', 'ph-item');
      li.append(el('span', `thread-dot ${t.status}`), el('span', 'ph-item-title', t.title));
      if (STATUS_TEXT[t.status]) li.append(chip(STATUS_TEXT[t.status], t.status === 'needs-ok' ? 'warn' : 'busy'));
      if (t.scope) li.append(chip(t.scope.split('/').pop(), 'branch'));
      if (t.updated) li.append(el('span', 'ph-when', fmtDate(t.updated)));
      li.addEventListener('click', () => openThread(name, t.id));
      tl.append(li);
    }
    hc.append(tl);
    if (h.past.length) {
      hc.append(el('div', 'ph-sub2 ph-past-label', 'Earlier chats in this code folder (Claude Code, T3 Code)'));
      const pl = el('ul', 'ph-list');
      for (const c of h.past) {
        const li = el('li', 'ph-item');
        li.append(iconEl(ICON.chat), el('span', 'ph-item-title', c.title || c.first || 'Untitled chat'));
        if (c.sub) li.append(chip(c.sub.split('/').pop(), 'branch'));
        li.append(chip(c.source === 't3' ? 'T3 Code' : 'Claude Code'), el('span', 'ph-when', fmtDate(c.updated)));
        li.title = 'Read this chat; “Continue” there carries it on as a new chat of this project';
        li.addEventListener('click', () => ctx.openChats?.({ cwd: h.repo, id: c.id }));
        pl.append(li);
      }
      hc.append(pl, small('See all past chats…', () => ctx.openChats?.()));
    }

    box.append(grid);
    box.scrollTop = top;
    renderSide();
  }

  // ---------- new project ----------
  function newProject() {
    const ov = overlay('modal-ov');
    const others = S.notebooks.filter((n) => !n.includes('/') && !find(n) && !ctx.reserved.includes(n));
    ov.innerHTML = `
      <div class="modal project-new">
        <h2>New project</h2>
        <p class="ph-hint">A project gathers documents, code folders and chats in one place. It lives in a notebook with the same name.</p>
        <input class="pn-name" placeholder="Project name" spellcheck="false" list="pn-books">
        <datalist id="pn-books">${others.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <p class="ph-hint pn-tip">${others.length ? 'Tip: type the name of an existing notebook to turn it into a project.' : ''}</p>
        <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Create</button></div>
      </div>`;
    const input = $('.pn-name', ov);
    const go = async () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      try {
        const r = await api.projects.create(v);
        closeOverlay();
        await refresh();
        await reload();
        await openHome(r.name);
      } catch (e) { toast(errText(e)); }
    };
    $('[data-act=ok]', ov).addEventListener('click', go);
    $('[data-act=cancel]', ov).addEventListener('click', closeOverlay);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
  }

  // ---------- add documents (things that live outside the project's notebook) ----------
  function addDocs(name) {
    const p = find(name);
    if (!p) return;
    const picked = new Set(p.sources);
    const kindIcon = (path) => (path.split('/')[0] === ctx.reserved[0] ? ICON.confluence : path.split('/')[0] === ctx.reserved[1] ? ICON.api : ICON.book);
    const cands = [
      ...S.notebooks.filter((n) => n !== name && !n.startsWith(name + '/') && !ctx.reserved.includes(n)).map((n) => ({ value: n, label: n.split('/').join(' / '), icon: kindIcon(n), what: n.split('/')[0] === ctx.reserved[0] ? 'Confluence pages' : 'folder' })),
      ...live().filter((n) => n.kind === 'api' && !inBook(n, name)).map((n) => ({ value: relOf(n), label: n.title, icon: ICON.api, what: 'API spec' })),
    ];
    for (const s of picked) if (!cands.some((c) => c.value === s)) cands.unshift({ value: s, label: s, icon: ICON.book, what: 'missing' });
    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal project-docs">
        <h2>Documents in “${esc(name)}”</h2>
        <p class="ph-hint">Everything in the “${esc(name)}” notebook is already part of the project. Tick what else belongs to it: Confluence pages you follow, API specs, other notebooks. Nothing is moved or copied.</p>
        <input class="pd-filter" type="search" placeholder="Filter…" spellcheck="false">
        <ul class="pd-list"></ul>
        <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Save</button></div>
      </div>`;
    const list = $('.pd-list', ov);
    const filter = $('.pd-filter', ov);
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      list.textContent = '';
      const shown = cands.filter((c) => !q || c.label.toLowerCase().includes(q));
      for (const c of shown.sort((a, b) => picked.has(b.value) - picked.has(a.value))) {
        const li = el('li', 'pd-item');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = picked.has(c.value);
        const lab = el('label');
        lab.append(box, iconEl(c.icon), el('span', 'pd-label', c.label), el('span', 'pd-what', c.what));
        box.addEventListener('change', () => { if (box.checked) picked.add(c.value); else picked.delete(c.value); });
        li.append(lab);
        list.append(li);
      }
      if (!shown.length) list.append(el('li', 'ph-hint', cands.length ? 'Nothing matches.' : 'Nothing to add yet. Fetch Confluence pages or create an API spec first.'));
    };
    filter.addEventListener('input', draw);
    $('[data-act=cancel]', ov).addEventListener('click', closeOverlay);
    $('[data-act=ok]', ov).addEventListener('click', async () => {
      try {
        await api.projects.setSources(name, [...picked]);
        closeOverlay();
        await refresh();
        await reload();
        renderSide();
        if (S.home === name) renderHome();
        ctx.rerenderList?.();
      } catch (e) { toast(errText(e)); }
    });
    draw();
    filter.focus();
  }

  // Chats report progress while the home page or the sidebar is showing.
  let soon = null;
  api.agent.onEvent(({ key, evt }) => {
    if (!['permission', 'permission_cancel', 'result', 'error', 'closed'].includes(evt.kind)) return;
    const name = key.split('#')[0];
    if (!find(name)) return;
    if (evt.kind === 'permission') statusByProject[name] = 'needs-ok';
    renderSide();
    clearTimeout(soon);
    soon = setTimeout(async () => {
      if (S.home === name && !S.current) return renderHome();
      try {
        const t = await api.agent.threads(name);
        statusByProject[name] = t.list.some((x) => x.status === 'needs-ok') ? 'needs-ok' : t.list.some((x) => x.status === 'working') ? 'working' : '';
        renderSide();
      } catch {}
    }, 400);
  });

  return { reload, renderSide, renderHome, openHome, newProject, addDocs, projectOf, projectOfPath, find, docsOf };
}
