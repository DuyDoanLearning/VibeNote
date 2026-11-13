// Confluence sync UI: the "Fetch from Confluence" window (paste a link, tick pages), Push, Pull latest.
// Conversion lives in confluence.js; network + files in main.js (confluence:* IPC). Spec: docs/confluence-spec.md.
import { fromConfluence, toConfluence, confluenceInfo, withConfluenceInfo } from './confluence.js';

export const CONFLUENCE_ROOT = 'Confluence'; // top-level notebook that holds fetched pages

// Same rules as main.js safeName(), for notebook (folder) names.
const safeSeg = (t) => String(t).replace(/[\/\\:*?"<>|#\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/^\.+/, '').trim() || 'Untitled';
const ICONS = { page: '📄', folder: '📁', whiteboard: '🧩', database: '🗃', embed: '🔗' };

export function createConfluenceUI(ctx) {
  const { api, S, $, el, esc, overlay, closeOverlay, toast, save, refresh, setFilter, openNote, currentNote, editorText, resolveLink } = ctx;
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
    const out = { done: 0, skipped: [], failed: [], firstPath: null, rootNotebook: hasKids(data.root.id) ? container(data.root) : CONFLUENCE_ROOT };
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
    } catch (e) {
      toast('Pull failed: ' + errText(e));
    }
  }

  return {
    openFetch,
    push,
    pull,
    info: () => confluenceInfo(S.meta),
    openInConfluence: () => { const i = confluenceInfo(S.meta); if (i) window.open(i.url); },
    signOut: async () => { await cf.signOut(); toast('Signed out of Atlassian.'); },
  };
}
