// /claude — a small box at the cursor: type a request, Claude writes Markdown (streamed live, shown rendered),
// then Insert (or Replace, when text was selected), Try again, or Discard. Nothing changes in the note until Insert.
// Claude gets the note title and the text around the cursor; it has no tools (main.js write:start → agent.askOnce).
import { renderMarkdown, postProcess } from './markdown.js';

// Claude sometimes wraps everything in ```markdown … ``` — unwrap that.
const unwrap = (s) => {
  const m = /^\s*```(?:markdown|md|ya?ml|json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(s);
  return (m ? m[1] : s).replace(/^\n+|\s+$/g, '');
};

export function createWriter(ctx) {
  const { api, S, $, el, editor, isTrashed, toast, isDark, dirOf, isApi = () => false } = ctx;
  const box = el('div', 'cw');
  box.hidden = true;
  box.innerHTML = `
    <div class="cw-row">
      <span class="cw-spark">✦</span>
      <textarea class="cw-input" rows="1" spellcheck="false" placeholder="Ask Claude to write…  e.g. a table comparing Qdrant and Memgraph"></textarea>
      <button class="btn primary cw-go" title="Send (Enter)">Write</button>
    </div>
    <div class="cw-status"></div>
    <article class="cw-out markdown" hidden></article>
    <div class="cw-actions" hidden>
      <span class="cw-hint">Type a new request above to change it</span>
      <button class="btn" data-act="discard">Discard</button>
      <button class="btn" data-act="retry">Try again</button>
      <button class="btn primary" data-act="insert">Insert</button>
    </div>`;
  document.body.append(box);
  const input = $('.cw-input', box);
  const out = $('.cw-out', box);
  const status = $('.cw-status', box);
  const actions = $('.cw-actions', box);
  const insertBtn = $('[data-act=insert]', box);

  let at = null; // { from, to, selection } where the result goes
  let draft = ''; // current result (Markdown)
  let lastRequest = '';
  let runId = null;
  let renderTimer = null;

  api.write.onDelta(({ id, text }) => {
    if (id !== runId) return;
    draft += text;
    scheduleRender();
  });

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(async () => {
      renderTimer = null;
      out.hidden = false;
      out.innerHTML = renderMarkdown(unwrap(draft));
      await postProcess(out, { dir: S.current ? dirOf(S.current) : '', dark: isDark() }).catch(() => {});
      place();
    }, 80);
  }

  // Under the cursor line; above it if there isn't room below.
  function place() {
    if (!at || box.hidden) return;
    const c = editor.coordsAt(at.from) || editor.coordsAt(0);
    const ed = $('#editor').getBoundingClientRect();
    const width = Math.min(620, ed.width - 24);
    box.style.width = `${width}px`;
    box.style.left = `${Math.max(ed.left + 12, Math.min(c ? c.left - 16 : ed.left + 12, ed.right - width - 12))}px`;
    const h = box.offsetHeight;
    const below = c ? c.bottom + 8 : ed.top + 40;
    box.style.top = `${below + h > window.innerHeight - 12 && c && c.top - h - 8 > 8 ? c.top - h - 8 : Math.min(below, window.innerHeight - h - 12)}px`;
  }

  function open() {
    if (!S.current || isTrashed()) return;
    if (!box.hidden) { input.focus(); return; }
    const sel = editor.selection();
    at = { from: sel.from, to: sel.to, selection: sel.empty ? '' : sel.text };
    draft = '';
    lastRequest = '';
    input.value = '';
    input.placeholder = at.selection ? 'Ask Claude about the selected text…  e.g. make this clearer, turn into a table' : 'Ask Claude to write…  e.g. a table comparing Qdrant and Memgraph';
    insertBtn.textContent = at.selection ? 'Replace' : 'Insert';
    out.hidden = actions.hidden = true;
    out.textContent = '';
    status.textContent = '';
    box.hidden = false;
    place();
    input.focus();
  }

  function close() {
    stop();
    box.hidden = true;
    at = null;
    editor.view.focus();
  }

  function stop() {
    if (runId) api.write.stop(runId).catch(() => {});
    runId = null;
    box.classList.remove('busy');
  }

  async function run(request) {
    request = request.trim();
    if (!request || !at) return;
    stop();
    const revise = draft && request !== lastRequest ? unwrap(draft) : '';
    lastRequest = request;
    const id = Math.random().toString(36).slice(2);
    runId = id;
    draft = '';
    out.hidden = true;
    actions.hidden = true;
    status.textContent = '✦ Claude is writing…  (Esc to stop)';
    box.classList.add('busy');
    const text = editor.text();
    try {
      const final = await api.write.start(id, {
        title: S.meta?.title || '',
        notePath: S.current,
        before: text.slice(0, at.from),
        after: text.slice(at.to),
        selection: at.selection,
        request,
        draft: revise,
        kind: isApi() ? 'api' : 'note',
      });
      if (runId !== id) return; // stopped or replaced
      draft = final || draft;
      scheduleRender();
      status.textContent = '';
      actions.hidden = false;
      input.value = '';
      input.placeholder = 'Change it…  e.g. shorter, add a column for cost, in Vietnamese';
      insertBtn.focus();
    } catch (e) {
      if (runId !== id) return;
      status.textContent = 'Claude could not write this: ' + String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      if (runId === id) { runId = null; box.classList.remove('busy'); }
      place();
    }
  }

  function insert() {
    let md = unwrap(draft);
    if (!md || !at) return;
    const doc = editor.text();
    if (isApi()) {
      // YAML goes in exactly where the cursor is; keep the following text on its own line.
      const replaced = !!at.selection;
      if (doc[at.to] && doc[at.to] !== '\n' && !md.endsWith('\n')) md += '\n';
      editor.replaceRange(at.from, at.to, md);
      close();
      toast(replaced ? 'Replaced with Claude’s version.' : 'Inserted.');
      return;
    }
    // Keep block content on its own lines.
    const lineStart = at.from === 0 || doc[at.from - 1] === '\n';
    const block = /\n/.test(md) || /^(#|\||- |\d+\. |>|```)/.test(md);
    const pre = block && !lineStart && !at.selection ? '\n\n' : '';
    const post = block && doc.slice(at.to, at.to + 1) && doc[at.to] !== '\n' ? '\n\n' : '';
    const replaced = !!at.selection;
    editor.replaceRange(at.from, at.to, pre + md + post);
    close();
    toast(replaced ? 'Replaced with Claude’s version.' : 'Inserted.');
  }

  $('.cw-go', box).addEventListener('click', () => run(input.value || lastRequest));
  $('[data-act=retry]', box).addEventListener('click', () => { draft = ''; run(lastRequest); });
  $('[data-act=discard]', box).addEventListener('click', close);
  insertBtn.addEventListener('click', insert);
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (runId) { stop(); status.textContent = 'Stopped.'; actions.hidden = !draft; } else close(); }
    if (e.key === 'Enter' && e.target === input && !e.shiftKey) { e.preventDefault(); if (input.value.trim()) run(input.value); else if (draft) insert(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft && !runId) { e.preventDefault(); insert(); }
  });
  // Click elsewhere: close only if nothing is pending (don't lose a result by accident).
  document.addEventListener('mousedown', (e) => {
    if (box.hidden || box.contains(e.target) || runId || draft) return;
    close();
  });
  window.addEventListener('resize', place);
  window.addEventListener('vibe:claude-write', open);

  return { open, close, isOpen: () => !box.hidden };
}
