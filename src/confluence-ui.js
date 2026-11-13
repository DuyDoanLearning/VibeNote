// Confluence sync UI: the "Fetch from Confluence" window (paste a link, tick pages), Push, Pull latest.
// Conversion lives in confluence.js; network + files in main.js (confluence:* IPC). Spec: docs/confluence-spec.md.
import { fromConfluence, toConfluence, confluenceInfo, withConfluenceInfo } from './confluence.js';

export const CONFLUENCE_ROOT = 'Confluence'; // top-level notebook that holds fetched pages

// Same rules as main.js safeName(), for notebook (folder) names.
const safeSeg = (t) => String(t).replace(/[\/\\:*?"<>|#\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/^\.+/, '').trim() || 'Untitled';
const ICONS = { page: '📄', folder: '📁', whiteboard: '🧩', database: '🗃', embed: '🔗' };

export function createConfluenceUI(ctx) {
  const { api, S, $, el, esc, overlay, closeOverlay, toast, save, refresh, setFilter, openNote, currentNote, editorText, resolveLink, rerender } = ctx;
  const leafOf = (nb) => nb.slice(nb.lastIndexOf('/') + 1);
  const inBook = (n, nb) => n.notebook === nb || n.notebook.startsWith(nb + '/');
  const cf = api.confluence;

  const pageUrl = (site, spaceKey, id, type = 'page') => {
    if (spaceKey) return `https://${site}/wiki/spaces/${spaceKey}/${type === 'page' ? 'pages' : type}/${id}`;
    return `https://${site}/wiki/pages/viewpage.action?pageId=${id}`;
  };
  const linkedNote = (site, id) => S.notes.find((n) => !n.trashed && confluenceInfo(n.meta)?.id === String(id) && confluenceInfo(n.meta)?.site === site);
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- fetch one page into a note ----------
  async function fetchPage({ site, spaceKey, id, notebook, existing }) {
    const p = await cf.page(site, id);
    const conv = fromConfluence(p.body);
    const old = existing ? S.notes.find((n) => n.path === existing) : null;
    const meta = {
      title: p.title,
      tags: old?.meta.tags || [],
      status: old?.meta.status || '',
      pinned: !!old?.meta.pinned,
      created: old?.meta.created || '',
      extra: withConfluenceInfo(old?.meta.extra, { url: (old && confluenceInfo(old.meta)?.url) || pageUrl(site, spaceKey, p.id), version: p.version }),
    };
    const sidecar = { id: p.id, site, version: p.version, title: p.title, fetchedAt: new Date().toISOString(), markdown: conv.markdown, blocks: conv.blocks, kept: conv.kept, people: conv.people };
    return cf.save({ notebook, existing, meta, body: conv.markdown, sidecar });
  }

  // Note text differs from what was last fetched/pushed → it has changes that aren't in Confluence yet.
  async function hasLocalChanges(note, id) {
    const side = await cf.sidecar(id);
    if (!side) return false;
    const body = note.path === S.current ? editorText() : note.body;
    return body.trim() !== String(side.markdown || '').trim() || (note.meta.title || '') !== side.title;
  }

  // ---------- "Fetch from Confluence" window ----------
  async function openFetch(initialUrl = '') {
    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal cf-fetch">
        <h2>Fetch from Confluence</h2>
        <div class="cf-row">
          <input class="cf-url" type="url" spellcheck="false" placeholder="Paste a Confluence page link…">
          <button class="btn primary" data-act="load">Load</button>
        </div>
        <div class="cf-msg"></div>
        <div class="cf-tree" hidden></div>
        <div class="cf-tools" hidden>
          <button class="btn" data-act="all">Select all</button>
          <button class="btn" data-act="none">Select none</button>
          <span class="cf-count"></span>
        </div>
        <div class="actions">
          <button class="btn" data-act="close">Cancel</button>
          <button class="btn primary" data-act="fetch" disabled>Fetch</button>
        </div>
      </div>`;
    const input = $('.cf-url', ov);
    const msg = $('.cf-msg', ov);
    const treeBox = $('.cf-tree', ov);
    const tools = $('.cf-tools', ov);
    const fetchBtn = $('[data-act=fetch]', ov);
    const loadBtn = $('[data-act=load]', ov);
    let data = null;
    let busy = false;
    const say = (text, kind = '') => { msg.textContent = text; msg.className = 'cf-msg ' + kind; };
    $('[data-act=close]', ov).addEventListener('click', () => { if (!busy) closeOverlay(); });

    try {
      const clip = initialUrl || (await navigator.clipboard.readText().catch(() => ''));
      if (/atlassian\.net\/wiki\//.test(clip)) input.value = clip.trim();
    } catch {}
    input.focus();
    input.select();

    async function load() {
      if (busy || !input.value.trim()) return;
      busy = true;
      loadBtn.disabled = fetchBtn.disabled = true;
      treeBox.hidden = tools.hidden = true;
      try {
        if (!(await cf.status())) say('Signing in to Atlassian… a browser tab opened. Sign in there and click Accept, then come back.', 'wait');
        else say('Loading the page tree…', 'wait');
        data = await cf.tree(input.value);
        say('');
        renderTree();
      } catch (e) {
        say(errText(e), 'error');
      } finally {
        busy = false;
        loadBtn.disabled = false;
      }
    }
    loadBtn.addEventListener('click', load);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

    function renderTree() {
      const all = [data.root, ...data.items];
      const kids = new Map();
      for (const it of data.items) {
        if (!kids.has(it.parentId)) kids.set(it.parentId, []);
        kids.get(it.parentId).push(it);
      }
      for (const list of kids.values()) list.sort((a, b) => (a.childPosition ?? 0) - (b.childPosition ?? 0));
      data.kids = kids;
      data.byId = new Map(all.map((it) => [it.id, it]));
      treeBox.textContent = '';
      const add = (it, depth) => {
        const row = el('label', 'cf-item');
        row.style.paddingLeft = `${6 + depth * 18}px`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.id = it.id;
        const draft = it.status && it.status !== 'current';
        box.checked = !draft;
        box.disabled = draft;
        const linked = it.type === 'page' && linkedNote(data.site, it.id);
        row.append(box, el('span', 'cf-ico', ICONS[it.type] || '📄'), el('span', 'cf-title', it.title || 'Untitled'));
        if (draft) row.append(el('span', 'cf-tag', 'draft, skipped'));
        else if (it.type !== 'page' && it.type !== 'folder') row.append(el('span', 'cf-tag', 'link only'));
        else if (linked) row.append(el('span', 'cf-tag', 'already here, will update'));
        box.addEventListener('change', () => {
          // Ticking a page or folder ticks everything under it.
          const walk = (id) => (kids.get(id) || []).forEach((k) => {
            const b = treeBox.querySelector(`input[data-id="${k.id}"]`);
            if (b && !b.disabled) b.checked = box.checked;
            walk(k.id);
          });
          walk(it.id);
          count();
        });
        treeBox.append(row);
        for (const k of kids.get(it.id) || []) add(k, depth + 1);
      };
      add(data.root, 0);
      treeBox.hidden = tools.hidden = false;
      count();
    }
    function selected() {
      return [...treeBox.querySelectorAll('input:checked')].map((b) => data.byId.get(b.dataset.id)).filter(Boolean);
    }
    function count() {
      const n = selected().filter((it) => it.type !== 'folder').length;
      $('.cf-count', ov).textContent = `${n} page${n === 1 ? '' : 's'} selected`;
      fetchBtn.textContent = n ? `Fetch ${n} page${n === 1 ? '' : 's'}` : 'Fetch';
      fetchBtn.disabled = !n;
    }
    $('[data-act=all]', ov).addEventListener('click', () => { treeBox.querySelectorAll('input:not(:disabled)').forEach((b) => { b.checked = true; }); count(); });
    $('[data-act=none]', ov).addEventListener('click', () => { treeBox.querySelectorAll('input').forEach((b) => { b.checked = false; }); count(); });

    fetchBtn.addEventListener('click', async () => {
      if (busy || !data) return;
      busy = true;
      fetchBtn.disabled = loadBtn.disabled = true;
      treeBox.querySelectorAll('input').forEach((b) => { b.disabled = true; });
      await save();
      const result = await fetchTree(data, selected(), (i, n, title) => say(`Fetching ${i} of ${n}: ${title}`, 'wait'));
      busy = false;
      closeOverlay();
      await refresh();
      if (result.rootNotebook) setFilter({ type: 'notebook', name: result.rootNotebook });
      if (result.firstPath) await openNote(result.firstPath);
      const parts = [`Fetched ${result.done} page${result.done === 1 ? '' : 's'}`];
      if (result.skipped.length) parts.push(`${result.skipped.length} skipped because they have changes here that aren't in Confluence yet (${result.skipped.slice(0, 3).join(', ')}${result.skipped.length > 3 ? '…' : ''})`);
      if (result.failed.length) parts.push(`${result.failed.length} failed: ${result.failed[0]}`);
      toast(parts.join('. ') + '.');
      picturesInBackground(result.ids);
    });

    if (input.value) load();
  }

  // Lay the chosen items out as notebooks/notes under "Confluence/" (mirrors the Confluence tree) and fetch them.
  async function fetchTree(data, chosen, progress) {
    const { site, spaceKey, kids, byId } = data;
    const hasKids = (id) => (kids.get(id) || []).length > 0;
    // Notebook that holds an item's own children: folders and pages with sub-pages get one.
    const containerOf = new Map();
    const container = (it) => {
      if (containerOf.has(it.id)) return containerOf.get(it.id);
      const parent = it.id === data.root.id ? CONFLUENCE_ROOT : container(byId.get(it.parentId) || data.root);
      const c = `${parent}/${safeSeg(it.title)}`;
      containerOf.set(it.id, c);
      return c;
    };
    const notebookFor = (it) => {
      if (it.type === 'page' && hasKids(it.id)) return container(it);
      return it.id === data.root.id ? CONFLUENCE_ROOT : container(byId.get(it.parentId) || data.root);
    };
    const pages = chosen.filter((it) => it.type !== 'folder');
    const out = { done: 0, skipped: [], failed: [], firstPath: null, rootNotebook: hasKids(data.root.id) ? container(data.root) : CONFLUENCE_ROOT, ids: [] };
    for (const it of chosen.filter((x) => x.type === 'folder')) await cf.mkdir(container(it)).catch(() => {});
    let i = 0;
    for (const it of pages) {
      progress(++i, pages.length, it.title);
      try {
        const existing = linkedNote(site, it.id);
        if (existing && (await hasLocalChanges(existing, it.id))) { out.skipped.push(existing.title); continue; }
        let p;
        if (it.type === 'page') {
          const args = { site, spaceKey, id: it.id, notebook: notebookFor(it), existing: existing?.path };
          p = await fetchPage(args).catch(() => fetchPage(args)); // one retry: Atlassian is sometimes slow
          out.ids.push(it.id);
        } else {
          const url = pageUrl(site, spaceKey, it.id, it.type);
          p = await cf.save({
            notebook: notebookFor(it),
            existing: existing?.path,
            meta: { title: it.title, tags: [], status: '', pinned: false, created: '', extra: withConfluenceInfo('', { url, kind: it.type }) },
            body: `This is a Confluence ${it.type}; it can only be opened in Confluence.\n\n[Open “${it.title.replace(/[\[\]]/g, '')}” in Confluence](${url})\n`,
          });
        }
        if (it.id === data.root.id || !out.firstPath) out.firstPath = p;
        out.done++;
      } catch (e) {
        out.failed.push(`${it.title}: ${errText(e)}`);
      }
    }
    return out;
  }

  // ---------- Push ----------
  async function push() {
    const note = currentNote();
    const info = note && confluenceInfo(S.meta);
    if (!info || info.kind !== 'page') return;
    await save();
    const side = await cf.sidecar(info.id);
    if (!side) return toast('Fetch this page from Confluence again first — its original copy is missing.');
    let r;
    try { r = toConfluence(editorText(), side, { resolveLink }); } catch (e) { return toast('Could not prepare the page: ' + errText(e)); }
    const title = S.meta.title || side.title;
    const titleChanged = title !== side.title;
    if (r.unchanged && !titleChanged) return toast('Nothing to push — this note is the same as in Confluence.');

    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal cf-push">
        <h2>Push to Confluence</h2>
        <ul class="cf-summary">
          ${r.added ? `<li>✏️ <b>${r.added}</b> edited or new section${r.added === 1 ? '' : 's'} will be updated${r.replaced ? ` (replacing ${r.replaced} original part${r.replaced === 1 ? '' : 's'})` : ''}.</li>` : ''}
          ${!r.added && r.replaced ? `<li>🗑 <b>${r.replaced}</b> part${r.replaced === 1 ? '' : 's'} will be removed.</li>` : ''}
          <li>✅ <b>${r.kept}</b> unchanged part${r.kept === 1 ? '' : 's'} — including diagrams and macros — go back exactly as they are.</li>
          ${titleChanged ? `<li>🏷 Title: “${esc(side.title)}” → “${esc(title)}”</li>` : ''}
          ${r.problems.map((p) => `<li class="warn">⚠️ ${esc(p)}</li>`).join('')}
        </ul>
        <p class="cf-note">Confluence keeps the previous version in its page history, so this can be undone there.</p>
        <div class="cf-msg"></div>
        <div class="actions">
          <button class="btn" data-act="close">Cancel</button>
          <button class="btn" data-act="draft">Save as draft</button>
          <button class="btn primary" data-act="publish">Publish</button>
        </div>
      </div>`;
    const msg = $('.cf-msg', ov);
    const buttons = [...ov.querySelectorAll('button')];
    $('[data-act=close]', ov).addEventListener('click', closeOverlay);
    const go = async (draft) => {
      buttons.forEach((b) => { b.disabled = true; });
      msg.textContent = draft ? 'Saving draft…' : 'Publishing…';
      msg.className = 'cf-msg wait';
      try {
        const res = await cf.push({ site: info.site, id: info.id, title, html: r.html, version: info.version || side.version, draft });
        if (res.conflict) {
          msg.className = 'cf-msg error';
          msg.textContent = `Someone changed this page in Confluence since you fetched it (it's now version ${res.current}, you have ${info.version || side.version}). Nothing was pushed. Copy your changes somewhere, use “Pull Latest from Confluence”, then add them again.`;
          buttons[0].disabled = false;
          buttons[0].textContent = 'Close';
          return;
        }
        if (draft) {
          closeOverlay();
          return toast('Saved as a draft in Confluence. Publish it there when you’re ready.');
        }
        // Re-read what Confluence stored, so the note and its original copy match the new version exactly.
        const path = await fetchPage({ site: info.site, spaceKey: '', id: info.id, notebook: note.notebook, existing: note.path });
        closeOverlay();
        await refresh();
        if (path !== S.current) await openNote(path);
        toast(`Published to Confluence${res.version ? ` (version ${res.version})` : ''}.`);
      } catch (e) {
        msg.className = 'cf-msg error';
        msg.textContent = 'Push failed: ' + errText(e);
        buttons.forEach((b) => { b.disabled = false; });
      }
    };
    $('[data-act=draft]', ov).addEventListener('click', () => go(true));
    $('[data-act=publish]', ov).addEventListener('click', () => go(false));
  }

  // ---------- Publish a note as a new Confluence page ----------
  // Places the new page can go: fetched pages, and Confluence folders (notebooks without a page of their own).
  function locations() {
    const pages = S.notes.filter((n) => !n.trashed && inBook(n, CONFLUENCE_ROOT) && confluenceInfo(n.meta)?.kind === 'page');
    const out = [];
    for (const n of pages) {
      const container = leafOf(n.notebook) === safeSeg(n.title) && n.notebook !== CONFLUENCE_ROOT;
      const where = container ? n.notebook : `${n.notebook}/${safeSeg(n.title)}`; // the notebook its children live in
      out.push({ value: `page:${n.path}`, label: n.title, sort: where, depth: where.split('/').length - 2, icon: '📄', note: n });
    }
    // Where a page sits in the tree: a page with sub-pages lives inside its own notebook, so it sits in the one above.
    const placedIn = (n) => (leafOf(n.notebook) === safeSeg(n.title) && n.notebook !== CONFLUENCE_ROOT ? n.notebook.slice(0, n.notebook.lastIndexOf('/')) : n.notebook);
    for (const nb of S.notebooks.filter((x) => x.startsWith(CONFLUENCE_ROOT + '/'))) {
      if (pages.some((n) => n.notebook === nb && leafOf(nb) === safeSeg(n.title))) continue; // that's a page's own notebook
      const sibling = pages.find((n) => placedIn(n) === nb); // any page directly under this folder tells us the folder's id
      if (!sibling) continue;
      out.push({ value: `folder:${nb}`, label: leafOf(nb), sort: nb, depth: nb.split('/').length - 2, icon: '📁', nb, sibling });
    }
    return out.sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // The location a notebook in the Confluence section stands for (for drag & drop).
  function locationForNotebook(nb) {
    return locations().find((l) => (l.nb && l.nb === nb) || (l.note && leafOf(l.note.notebook) === safeSeg(l.note.title) && l.note.notebook === nb)) || null;
  }

  async function publishNote(note = currentNote(), presetNotebook = null) {
    if (!note || note.trashed || note.kind === 'api') return;
    const info = confluenceInfo(note.meta);
    if (info) { if (note.path === S.current) return push(); return toast('This note is already a Confluence page — open it and use Push.'); }
    if (note.path === S.current) await save();
    const fresh = S.notes.find((n) => n.path === note.path) || note;
    const body = note.path === S.current ? editorText() : fresh.body;
    let r;
    try { r = toConfluence(body, { blocks: [] }, { resolveLink }); } catch (e) { return toast('Could not prepare the page: ' + errText(e)); }
    const locs = locations();
    const preset = presetNotebook ? locationForNotebook(presetNotebook) : null;

    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal cf-push cf-publish">
        <h2>Publish to Confluence</h2>
        <p class="cf-lead">“${esc(fresh.title || 'Untitled')}” becomes a new Confluence page.</p>
        <label class="cf-label">Put it under</label>
        <select class="cf-loc"></select>
        <input class="cf-url cf-parent-url" type="url" spellcheck="false" placeholder="…or paste the link of the page it should go under" hidden>
        <ul class="cf-summary">
          <li>📄 ${r.added ? `${body.split('\n').filter((l) => l.trim()).length} lines of content` : 'An empty page'}${fresh.meta.tags.length ? ' (tags stay in VibeNote)' : ''}.</li>
          <li>🔗 Afterwards the note moves into your Confluence notebooks and stays linked: edit it here and use <b>Push</b> to update the page.</li>
          ${r.problems.map((p) => `<li class="warn">⚠️ ${esc(p)}</li>`).join('')}
        </ul>
        <p class="cf-note">Everyone who can see the parent page will see the new page.</p>
        <div class="cf-msg"></div>
        <div class="actions">
          <button class="btn" data-act="close">Cancel</button>
          <button class="btn primary" data-act="publish">Publish</button>
        </div>
      </div>`;
    const sel = $('.cf-loc', ov);
    const urlIn = $('.cf-parent-url', ov);
    const msg = $('.cf-msg', ov);
    sel.append(new Option(locs.length ? 'Choose a page or folder…' : 'No fetched pages yet — paste a link below', ''));
    for (const l of locs) sel.append(new Option(`${'\u00a0\u00a0\u00a0\u00a0'.repeat(Math.max(0, l.depth))}${l.icon} ${l.label}`, l.value));
    sel.append(new Option('🔗 Paste a page link…', 'url'));
    sel.value = preset ? preset.value : '';
    const sync = () => { urlIn.hidden = sel.value !== 'url' && !!locs.length; if (!urlIn.hidden) urlIn.focus(); };
    if (!locs.length) sel.value = 'url';
    sync();
    sel.addEventListener('change', sync);
    $('[data-act=close]', ov).addEventListener('click', closeOverlay);
    const btn = $('[data-act=publish]', ov);
    btn.addEventListener('click', async () => {
      // Where: a fetched page, a folder (via a page in it), or a pasted link.
      let site, parentId, siblingId, target = CONFLUENCE_ROOT, spaceKey = '', parentNote = null;
      const loc = locs.find((l) => l.value === sel.value);
      if (loc?.note) {
        const i = confluenceInfo(loc.note.meta);
        site = i.site; parentId = i.id; parentNote = loc.note;
        spaceKey = /\/spaces\/([^/]+)/.exec(i.url)?.[1] || '';
      } else if (loc?.nb) {
        const i = confluenceInfo(loc.sibling.meta);
        site = i.site; siblingId = i.id; target = loc.nb;
        spaceKey = /\/spaces\/([^/]+)/.exec(i.url)?.[1] || '';
      } else {
        const m = /^https:\/\/([^/]+\.atlassian\.net)\/wiki\/.*?(?:\/pages\/(?:edit-v2\/|edit\/)?(\d+)|[?&]pageId=(\d+))/.exec(urlIn.value.trim());
        if (!m) { msg.className = 'cf-msg error'; msg.textContent = 'Choose a location, or paste a Confluence page link (…atlassian.net/wiki/…/pages/123…).'; return; }
        site = m[1]; parentId = m[2] || m[3];
        spaceKey = /\/spaces\/([^/]+)/.exec(urlIn.value)?.[1] || '';
      }
      btn.disabled = true;
      sel.disabled = urlIn.disabled = true;
      msg.className = 'cf-msg wait';
      msg.textContent = (await cf.status()) ? 'Publishing…' : 'Signing in to Atlassian… a browser tab opened. Sign in there and click Accept, then come back.';
      try {
        const title = fresh.meta.title || fresh.title || 'Untitled';
        const created = await cf.create({ site, parentId, siblingId, title, html: r.html });
        msg.textContent = 'Published. Linking the note…';
        // The note's new home: the parent page's notebook (a page that gets its first child gets its own notebook).
        if (parentNote) {
          const container = leafOf(parentNote.notebook) === safeSeg(parentNote.title) && parentNote.notebook !== CONFLUENCE_ROOT;
          target = container ? parentNote.notebook : `${parentNote.notebook}/${safeSeg(parentNote.title)}`;
          if (!container) {
            await cf.mkdir(target);
            await api.move(parentNote.path, target);
          }
        } else if (!loc) {
          await cf.mkdir(CONFLUENCE_ROOT).catch(() => {});
        }
        const moved = fresh.notebook === target ? fresh.path : await api.move(fresh.path, target);
        await refresh();
        const p = await fetchPage({ site, spaceKey, id: created.id, notebook: target, existing: moved });
        closeOverlay();
        await refresh();
        await openNote(p);
        toast('Published to Confluence. The note is now linked to the new page.', 4000);
      } catch (e) {
        msg.className = 'cf-msg error';
        msg.textContent = 'Publish failed: ' + errText(e);
        btn.disabled = false;
        sel.disabled = urlIn.disabled = false;
      }
    });
  }

  // ---------- Pull latest ----------
  async function pull() {
    const note = currentNote();
    const info = note && confluenceInfo(S.meta);
    if (!info || info.kind !== 'page') return;
    await save();
    if (await hasLocalChanges(note, info.id)) {
      const id = await api.popup([
        { id: 'pull', label: 'Replace my unpushed changes with the Confluence version' },
        { type: 'separator' },
        { id: 'cancel', label: 'Cancel' },
      ]);
      if (id !== 'pull') return;
    }
    try {
      toast('Pulling the latest version…');
      const path = await fetchPage({ site: info.site, spaceKey: '', id: info.id, notebook: note.notebook, existing: note.path });
      await refresh();
      if (path !== S.current) await openNote(path);
      toast('Updated from Confluence. Your previous text is in Version History.');
      picturesInBackground([info.id]);
    } catch (e) {
      toast('Pull failed: ' + errText(e));
    }
  }

  // ---------- pictures (images, draw.io diagrams) inside the 🔒 boxes ----------
  const picCache = new Map(); // page id → { map: { n: [paths] }, wanted: [n], signedIn }
  const PICTURE_BOX = /^(Image|draw\.io|Gliffy|Layout|Table)/i;

  // Called on each preview render: put downloaded pictures into their boxes.
  async function decorate(root) {
    const info = confluenceInfo(S.meta);
    if (!info || info.kind !== 'page') return;
    const boxes = root.querySelectorAll('.confluence-kept[data-kept]');
    if (!boxes.length) return;
    if (!picCache.has(info.id)) picCache.set(info.id, await cf.pictures(info.id).catch(() => ({ map: {}, wanted: [] })));
    const { map, wanted = [], signedIn } = picCache.get(info.id);
    for (const box of boxes) {
      const n = box.dataset.kept;
      const files = map?.[n];
      if (files?.length) {
        box.classList.add('has-picture');
        const label = box.querySelector('.ck-label');
        for (const f of files) {
          const img = document.createElement('img');
          img.className = 'ck-picture';
          img.src = 'file://' + encodeURI(`${S.root}/${f}`);
          img.alt = label?.textContent || '';
          img.title = 'Click to open full size';
          img.addEventListener('click', () => cf.openPicture(f));
          box.insertBefore(img, label);
        }
        box.querySelector('.ck-note')?.remove();
      } else if (wanted.includes(n) && PICTURE_BOX.test(box.querySelector('.ck-label')?.textContent || '')) {
        const b = document.createElement('button');
        b.className = 'ck-show';
        b.textContent = signedIn ? 'Show picture' : 'Show pictures from Confluence';
        b.addEventListener('click', () => downloadPictures());
        box.append(b);
      }
    }
  }

  async function downloadPictures(id = confluenceInfo(S.meta)?.id) {
    if (!id) return;
    const signedIn = (picCache.get(id) || await cf.pictures(id).catch(() => ({}))).signedIn;
    toast(signedIn ? 'Getting pictures from Confluence…'
      : 'Pictures need one more Atlassian sign-in. A browser tab opened — click Accept there, then come back.', 8000);
    try {
      const r = await cf.pictures(id, { download: true, interactive: true });
      picCache.set(id, { ...r, signedIn: true });
      rerender?.();
      toast(r.got ? `Got ${r.got} picture${r.got === 1 ? '' : 's'}${r.missing ? ` (${r.missing} not found in Confluence)` : ''}.` : 'No pictures found for this page in Confluence.');
    } catch (e) {
      toast('Couldn’t get pictures: ' + errText(e));
    }
  }

  // After fetching / pulling: refresh those pages' pictures quietly (only once pictures are signed in).
  async function picturesInBackground(ids) {
    for (const id of ids || []) {
      try {
        const r = await cf.pictures(id, { download: true, interactive: false });
        if (r.signedIn === false) return;
        picCache.set(id, { ...r, signedIn: true });
        if (confluenceInfo(S.meta)?.id === id) rerender?.();
      } catch {}
    }
  }

  return {
    openFetch,
    push,
    pull,
    publishNote,
    locationForNotebook,
    decorate,
    downloadPictures,
    info: () => confluenceInfo(S.meta),
    openInConfluence: () => { const i = confluenceInfo(S.meta); if (i) window.open(i.url); },
    signOut: async () => { await cf.signOut(); toast('Signed out of Atlassian.'); },
  };
}
