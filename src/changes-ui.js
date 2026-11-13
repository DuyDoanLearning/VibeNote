// "Changes to push": Confluence pages you edited in VibeNote but haven't pushed yet. A sidebar row + "edited" labels
// show them; the window lists them with what changed, Push (one page, the usual Push window) and Push all.
import { diffLines } from 'diff';

export function createChangesUI(ctx) {
  const { api, S, $, el, overlay, closeOverlay, toast, save, openNote, editorText, isConfluencePage, idOf, pushOne, pushMany, rerender } = ctx;
  S.cfChanged = new Set();
  let timer = null;
  let running = null;

  const bodyOf = (n) => (n.path === S.current ? editorText() : n.body);
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim();

  // Which pages differ from what was last fetched/pushed (text or title).
  async function compute() {
    const pages = S.notes.filter((n) => !n.trashed && isConfluencePage(n));
    const ids = pages.map(idOf).filter(Boolean);
    if (!ids.length) return [];
    const bases = await api.confluence.bases(ids);
    const out = [];
    for (const n of pages) {
      const b = bases[idOf(n)];
      if (!b) continue;
      const body = bodyOf(n);
      const titleChanged = (n.meta.title || n.title) !== b.title && !!b.title;
      if (norm(body) === norm(b.markdown) && !titleChanged) continue;
      let added = 0, removed = 0;
      for (const p of diffLines(norm(b.markdown) + '\n', norm(body) + '\n')) {
        const lines = p.value.split('\n').filter((l) => l.trim()).length;
        if (p.added) added += lines;
        if (p.removed) removed += lines;
      }
      out.push({ note: n, base: b, body, added, removed, titleChanged });
    }
    return out.sort((a, b) => b.note.mtime - a.note.mtime);
  }

  async function update() {
    try {
      const list = await compute();
      const next = new Set(list.map((c) => c.note.path));
      const same = next.size === S.cfChanged.size && [...next].every((p) => S.cfChanged.has(p));
      S.cfChanged = next;
      if (!same) rerender();
      return list;
    } catch {
      return [];
    }
  }
  // Recheck shortly after edits / refreshes (cheap: the original copies are cached).
  function soon() {
    clearTimeout(timer);
    timer = setTimeout(update, 1200);
  }

  function diffView(base, body) {
    const pre = el('pre', 'changes-diff');
    const parts = diffLines(norm(base) + '\n', norm(body) + '\n');
    parts.forEach((p, i) => {
      const lines = p.value.replace(/\n$/, '').split('\n');
      if (!p.added && !p.removed) {
        // unchanged: show up to 2 lines of context around changes
        const show = lines.length <= 4 ? lines : [...(i > 0 ? lines.slice(0, 2) : []), '…', ...(i < parts.length - 1 ? lines.slice(-2) : [])];
        for (const l of show) if (l.trim()) pre.append(el('div', 'ctx', l === '…' ? '  …' : `  ${l}`));
      } else {
        for (const l of lines) if (l.trim()) pre.append(el('div', p.added ? 'add' : 'del', `${p.added ? '+' : '−'} ${l}`));
      }
    });
    return pre;
  }

  async function open() {
    await save();
    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal changes-win">
        <h2>Changes to push</h2>
        <p class="cf-note" style="margin:0 0 10px">Confluence pages you edited here but haven't pushed yet.</p>
        <ul class="changes-list"><li class="changes-empty">Checking…</li></ul>
        <div class="cf-msg"></div>
        <div class="actions">
          <button class="btn" data-act="close">Close</button>
          <button class="btn primary" data-act="all" disabled>Push all</button>
        </div>
      </div>`;
    const ul = $('.changes-list', ov);
    const allBtn = $('[data-act=all]', ov);
    const msg = $('.cf-msg', ov);
    $('[data-act=close]', ov).addEventListener('click', () => { if (!running) closeOverlay(); });
    const list = await update();
    ul.textContent = '';
    if (!list.length) {
      ul.append(el('li', 'changes-empty', 'Nothing to push — every Confluence page matches what you last fetched or pushed.'));
      return;
    }
    allBtn.disabled = false;
    allBtn.textContent = `Push all ${list.length} page${list.length === 1 ? '' : 's'}`;
    const rows = new Map();
    for (const c of list) {
      const li = el('li', 'changes-item');
      const top = el('div', 'changes-top');
      const names = el('div');
      names.style.minWidth = '0';
      names.append(el('div', 'changes-title', c.note.title), el('div', 'changes-where', c.note.notebook.replace(/^Confluence\/?/, 'Confluence › ').replace(/\//g, ' › ')));
      const stat = el('span', 'changes-stat');
      stat.innerHTML = `<span class="a">+${c.added}</span> <span class="d">−${c.removed}</span>${c.titleChanged ? ' · title' : ''}`;
      const show = el('button', 'btn', 'Show changes');
      const openB = el('button', 'btn', 'Open');
      const pushB = el('button', 'btn primary', 'Push');
      top.append(names, el('span', 'spacer'), stat, show, openB, pushB);
      li.append(top);
      const result = el('div', 'changes-result');
      result.hidden = true;
      li.append(result);
      let diff = null;
      show.addEventListener('click', () => {
        if (diff) { diff.remove(); diff = null; show.textContent = 'Show changes'; return; }
        diff = diffView(c.base.markdown, c.body);
        if (c.titleChanged) diff.prepend(el('div', 'del', `− title: ${c.base.title}`), el('div', 'add', `+ title: ${c.note.meta.title || c.note.title}`));
        li.append(diff);
        show.textContent = 'Hide changes';
      });
      openB.addEventListener('click', () => { closeOverlay(); openNote(c.note.path); });
      pushB.addEventListener('click', () => { closeOverlay(); pushOne(c.note.path); });
      rows.set(c.note.path, { li, result, buttons: [show, openB, pushB] });
      ul.append(li);
    }
    allBtn.addEventListener('click', async () => {
      if (running) return;
      allBtn.disabled = true;
      $('[data-act=close]', ov).disabled = true;
      rows.forEach((r) => r.buttons.forEach((b) => { b.disabled = true; }));
      msg.className = 'cf-msg wait';
      msg.textContent = (await api.confluence.status()) ? 'Pushing…' : 'Signing in to Atlassian… a browser tab opened. Sign in there and click Accept, then come back.';
      let ok = 0, skipped = 0, failed = 0;
      running = pushMany(list.map((c) => c.note), (note, state, text) => {
        const r = rows.get(note.path);
        if (!r) return;
        r.result.hidden = false;
        r.result.className = `changes-result ${state}`;
        r.result.textContent = (state === 'ok' ? '✓ ' : state === 'conflict' ? '⚠️ ' : state === 'error' ? '✗ ' : '⏳ ') + text;
        if (state === 'ok') ok++;
        if (state === 'conflict') skipped++;
        if (state === 'error') failed++;
      });
      await running;
      running = null;
      $('[data-act=close]', ov).disabled = false;
      msg.className = failed ? 'cf-msg error' : 'cf-msg';
      msg.textContent = [`${ok} pushed`, skipped ? `${skipped} skipped (changed in Confluence meanwhile)` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
      toast(msg.textContent, 4000);
      update();
    });
  }

  return { open, soon, update };
}
