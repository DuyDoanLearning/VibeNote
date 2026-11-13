// Comments: select text → 💬 → a thread in the right-hand panel. Mention @Claude (or click "Ask Claude") and Claude
// replies in the thread, optionally with a suggested replacement you Accept or Reject. On Confluence notes each message
// can be posted to the page as a Confluence comment.
// Storage: <notes>/.comments/<id>.json (plain file, syncs with the folder); the note's front matter has `comments-id: <id>`.
// Threads are anchored by the quoted text plus a little context, so they find their words again after edits elsewhere.
import { renderMarkdown } from './markdown.js';
import { confluenceInfo } from './confluence.js';

const CTX = 40; // characters of context kept on each side of the quote
const rid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
const asksClaude = (text) => /(^|\s)@claude\b/i.test(text);

// Find the anchor in the text: every occurrence of the quote, scored by how much of the context around it still matches.
function locate(anchor, text) {
  if (!anchor?.quote) return null;
  let best = null;
  for (let i = text.indexOf(anchor.quote); i >= 0; i = text.indexOf(anchor.quote, i + 1)) {
    const before = text.slice(Math.max(0, i - CTX), i);
    const after = text.slice(i + anchor.quote.length, i + anchor.quote.length + CTX);
    let score = 0;
    for (let k = 1; k <= Math.min(before.length, anchor.prefix.length) && before.endsWith(anchor.prefix.slice(-k)); k++) score++;
    for (let k = 1; k <= Math.min(after.length, anchor.suffix.length) && after.startsWith(anchor.suffix.slice(0, k)); k++) score++;
    if (!best || score > best.score) best = { from: i, to: i + anchor.quote.length, score };
  }
  return best;
}
const anchorAt = (text, from, to) => ({ quote: text.slice(from, to), prefix: text.slice(Math.max(0, from - CTX), from), suffix: text.slice(to, to + CTX) });

// Plain text of a bit of Markdown (what Confluence shows), for anchoring Confluence inline comments.
function plainText(md) {
  const d = document.createElement('div');
  d.innerHTML = renderMarkdown(md);
  return d.textContent.replace(/\s+/g, ' ').trim();
}

export function createComments(ctx) {
  const { api, S, $, el, esc, editor, toast, metaChanged, isTrashed, closeAgent } = ctx;
  const root = $('#comments');
  const floatBtn = $('#comment-float');
  let cur = null; // { path, cid, threads }
  let active = null;
  let draft = null; // id of a new thread whose first message isn't written yet
  let writeTimer = null;
  let anchorTimer = null;

  root.innerHTML = `
    <div class="cm-head"><span class="cm-title">Comments</span><span class="cm-sub"></span><div class="spacer"></div>
      <button class="icon cm-close" title="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="cm-list"></div>`;
  const list = $('.cm-list', root);
  $('.cm-close', root).addEventListener('click', () => toggle(false));

  const cidOf = (meta) => /^comments-id:\s*([a-z0-9]+)\s*$/im.exec(meta?.extra || '')?.[1] || null;
  const isOpen = () => document.body.classList.contains('comments-open');
  const threads = () => cur?.threads || [];
  const openThreads = () => threads().filter((t) => !t.resolved);

  function toggle(force) {
    const open = force ?? !isOpen();
    if (open) closeAgent();
    document.body.classList.toggle('comments-open', open);
    if (open) render();
    updateButton();
  }

  function updateButton() {
    const n = openThreads().length;
    const b = $('#comments-btn');
    b.querySelector('.cm-count').textContent = n ? String(n) : '';
    b.classList.toggle('has', n > 0);
  }

  // ---------- load / save ----------
  async function noteOpened() {
    clearTimeout(writeTimer);
    clearTimeout(anchorTimer);
    active = null;
    draft = null;
    const n = S.current && S.notes.find((x) => x.path === S.current);
    const cid = cidOf(S.meta);
    cur = { noteId: S.currentId, cid, threads: [] };
    if (n && cid) {
      const data = await api.comments.read(cid);
      if (cur.noteId !== S.currentId) return; // switched notes while loading
      cur.threads = data?.threads || [];
    }
    applyMarks();
    render();
    updateButton();
  }

  // Put the highlights on the text (open threads only) and remember which threads lost their words.
  function applyMarks() {
    if (!cur) return;
    const text = editor.text();
    const marks = [];
    for (const t of threads()) {
      if (t.resolved) continue;
      const hit = locate(t.anchor, text);
      t.orphan = !hit;
      if (hit) marks.push({ id: t.id, from: hit.from, to: hit.to });
    }
    editor.setComments(marks, active);
  }

  // Keep each thread's anchor in step with its (moving) highlight.
  function syncAnchors() {
    if (!cur || cur.noteId !== S.currentId) return;
    const text = editor.text();
    for (const m of editor.comments()) {
      const t = threads().find((x) => x.id === m.id);
      if (t && m.to > m.from) { t.anchor = anchorAt(text, m.from, m.to); t.orphan = false; }
    }
  }

  function persist() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 400);
  }
  async function flush() {
    clearTimeout(writeTimer);
    if (!cur?.cid) return;
    syncAnchors();
    const keep = threads().filter((t) => t.messages.length);
    await api.comments.write(cur.cid, { version: 1, threads: keep.map(({ orphan, pending, ...t }) => t) }).catch(() => {});
  }

  // The note gets a comments id (in its front matter) the first time it gets a comment.
  function ensureCid() {
    if (cur.cid) return cur.cid;
    cur.cid = rid();
    S.meta.extra = [S.meta.extra, `comments-id: ${cur.cid}`].filter(Boolean).join('\n');
    metaChanged();
    return cur.cid;
  }

  function noteEdited() {
    if (!cur || !threads().length) return;
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => { syncAnchors(); persist(); render(); }, 1200);
  }

  // ---------- actions ----------
  function addComment() {
    if (!S.current || isTrashed()) return;
    const sel = editor.selection();
    if (sel.empty || !sel.text.trim()) return toast('Select some text first, then add a comment.');
    const text = editor.text();
    const t = { id: rid(), anchor: anchorAt(text, sel.from, sel.to), created: Date.now(), resolved: false, messages: [] };
    cur.threads.push(t);
    draft = t.id;
    active = t.id;
    applyMarks();
    hideFloat();
    toggle(true);
    setTimeout(() => list.querySelector(`[data-tid="${t.id}"] textarea`)?.focus(), 30);
  }

  async function send(t, text, ask) {
    text = text.trim();
    if (!text && !ask) return;
    ensureCid();
    if (text) t.messages.push({ id: rid(), author: 'you', text, at: Date.now() });
    if (draft === t.id) draft = null;
    persist();
    if (ask || asksClaude(text)) await askClaude(t);
    else render();
  }

  async function askClaude(t) {
    syncAnchors();
    t.pending = true;
    render();
    const mark = editor.comments().find((m) => m.id === t.id);
    const quote = mark ? editor.slice(mark.from, mark.to) : t.anchor.quote;
    try {
      const r = await api.comments.ask({
        title: S.meta?.title || '',
        note: editor.text(),
        quote,
        thread: t.messages.map(({ author, text, suggestion }) => ({ author, text, suggestion })),
      });
      t.messages.push({ id: rid(), author: 'claude', text: r.reply || '(no reply)', at: Date.now(), ...(r.suggestion != null && { suggestion: { text: r.suggestion, status: 'pending', from: quote } }) });
      persist();
    } catch (e) {
      toast('Claude could not answer: ' + String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      t.pending = false;
      render();
    }
  }

  function accept(t, m) {
    const mark = editor.comments().find((x) => x.id === t.id);
    if (!mark) return toast('The commented text was changed or removed, so the suggestion can’t be applied automatically.');
    const others = editor.comments().filter((x) => x.id !== t.id);
    const { from } = mark;
    if (!editor.replaceRange(mark.from, mark.to, m.suggestion.text)) return;
    const len = m.suggestion.text.length;
    // The replaced range collapses; put this thread's highlight back on the new text.
    const moved = editor.comments().filter((x) => x.id !== t.id);
    editor.setComments([...(moved.length === others.length ? moved : others), ...(len ? [{ id: t.id, from, to: from + len }] : [])], active);
    m.suggestion.status = 'accepted';
    syncAnchors();
    persist();
    render();
  }

  function setStatus(t, m, status) { m.suggestion.status = status; persist(); render(); }

  function resolve(t, value = true) {
    t.resolved = value;
    if (active === t.id) active = null;
    syncAnchors();
    applyMarks();
    persist();
    render();
    updateButton();
  }

  async function remove(t) {
    const id = await api.popup([{ id: 'delete', label: 'Delete this comment thread' }, { type: 'separator' }, { id: 'cancel', label: 'Cancel' }]);
    if (id !== 'delete') return;
    cur.threads = threads().filter((x) => x !== t);
    if (draft === t.id) draft = null;
    applyMarks();
    persist();
    render();
    updateButton();
  }

  async function postToConfluence(t, m) {
    const info = confluenceInfo(S.meta);
    if (!info) return;
    m.posting = true;
    render();
    try {
      const text = m.author === 'claude' ? `Claude (via VibeNote): ${m.text}${m.suggestion ? `\n\nSuggested text: ${m.suggestion.text}` : ''}` : m.text;
      const r = await api.comments.postToConfluence({
        site: info.site, id: info.id, text,
        quote: t.confluence?.id ? null : plainText(t.anchor.quote).slice(0, 300),
        parentId: t.confluence?.id || null,
      });
      if (!t.confluence?.id) t.confluence = { id: r.id, inline: r.inline };
      m.posted = true;
      persist();
      toast(r.inline ? 'Posted to Confluence on the highlighted text.' : 'Posted to Confluence as a page comment (Confluence couldn’t find the exact text).');
    } catch (e) {
      toast('Could not post to Confluence: ' + String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      delete m.posting;
      render();
    }
  }

  function focusThread(t) {
    active = t.id;
    const mark = editor.comments().find((x) => x.id === t.id);
    applyMarks();
    if (mark) editor.select(mark.from, mark.to);
    render();
  }

  // ---------- rendering ----------
  const time = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function render() {
    if (!isOpen()) return;
    const conf = !!confluenceInfo(S.meta);
    list.textContent = '';
    $('.cm-sub', root).textContent = S.current ? `${openThreads().length} open` : '';
    if (!S.current) { list.append(el('div', 'cm-empty', 'Open a note to see its comments.')); return; }
    const open = openThreads();
    const done = threads().filter((t) => t.resolved && t.messages.length);
    if (!open.length) {
      list.append(el('div', 'cm-empty', 'No comments yet. Select some text and click 💬 (or ⌥⌘M). Type @Claude in a comment to ask Claude.'));
    }
    for (const t of open) list.append(card(t, conf));
    if (done.length) {
      const d = document.createElement('details');
      d.className = 'cm-resolved';
      d.append(el('summary', '', `Resolved (${done.length})`));
      for (const t of done) d.append(card(t, conf));
      list.append(d);
    }
  }

  function card(t, conf) {
    const c = el('div', 'cm-thread' + (t.id === active ? ' active' : '') + (t.resolved ? ' resolved' : ''));
    c.dataset.tid = t.id;
    const q = el('div', 'cm-quote', t.anchor.quote.length > 160 ? t.anchor.quote.slice(0, 160) + '…' : t.anchor.quote);
    q.title = 'Show in the note';
    q.addEventListener('click', () => focusThread(t));
    c.append(q);
    if (t.orphan && !t.resolved) c.append(el('div', 'cm-orphan', 'The commented text was changed or removed.'));

    for (const m of t.messages) {
      const msg = el('div', 'cm-msg ' + m.author);
      const head = el('div', 'cm-meta');
      head.append(el('b', '', m.author === 'claude' ? '✦ Claude' : 'You'), el('span', '', time(m.at)));
      if (conf && !m.posted) {
        const p = el('button', 'cm-link', m.posting ? 'Posting…' : 'Post to Confluence');
        p.disabled = !!m.posting;
        p.addEventListener('click', () => postToConfluence(t, m));
        head.append(p);
      } else if (m.posted) head.append(el('span', 'cm-posted', 'In Confluence'));
      const body = el('div', 'cm-text markdown');
      body.innerHTML = renderMarkdown(m.text);
      msg.append(head, body);
      if (m.suggestion) msg.append(suggestionBox(t, m));
      c.append(msg);
    }
    if (t.pending) c.append(el('div', 'cm-thinking', '✦ Claude is reading the note…'));

    if (!t.resolved) {
      const box = el('div', 'cm-compose');
      const ta = document.createElement('textarea');
      ta.rows = t.messages.length ? 1 : 3;
      ta.placeholder = t.messages.length ? 'Reply…  (@Claude to ask Claude)' : 'Write a comment…  Type @Claude to ask Claude, e.g. “@Claude make this clearer”';
      ta.disabled = !!t.pending;
      const row = el('div', 'cm-actions');
      const askBtn = el('button', 'btn cm-ask', '✦ Ask Claude');
      const sendBtn = el('button', 'btn primary', 'Comment');
      askBtn.disabled = sendBtn.disabled = !!t.pending;
      askBtn.title = 'Send and ask Claude to reply (uses your Claude usage)';
      sendBtn.addEventListener('click', () => send(t, ta.value, false));
      askBtn.addEventListener('click', () => send(t, ta.value, true));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(t, ta.value, false); }
        if (e.key === 'Escape' && draft === t.id && !ta.value.trim()) { e.preventDefault(); remove(t); }
      });
      const label = () => {
        const toClaude = asksClaude(ta.value);
        sendBtn.textContent = toClaude ? '✦ Send to Claude' : 'Comment';
        askBtn.hidden = toClaude;
      };
      ta.addEventListener('input', label);
      ta.addEventListener('focus', () => { if (active !== t.id) { active = t.id; applyMarks(); c.classList.add('active'); } });
      row.append(askBtn, sendBtn);
      box.append(ta, row);
      c.append(box);
    }
    if (t.messages.length || t.resolved) {
      const foot = el('div', 'cm-foot');
      const r = el('button', 'cm-link', t.resolved ? 'Reopen' : '✓ Resolve');
      r.addEventListener('click', () => resolve(t, !t.resolved));
      const d = el('button', 'cm-link danger', 'Delete');
      d.addEventListener('click', () => remove(t));
      foot.append(r, d);
      c.append(foot);
    } else if (draft === t.id) {
      const foot = el('div', 'cm-foot');
      const x = el('button', 'cm-link', 'Cancel');
      x.addEventListener('click', () => { cur.threads = threads().filter((y) => y !== t); draft = null; applyMarks(); render(); });
      foot.append(x);
      c.append(foot);
    }
    return c;
  }

  function suggestionBox(t, m) {
    const s = m.suggestion;
    const box = el('div', 'cm-sug ' + s.status);
    box.append(el('div', 'cm-sug-label', s.status === 'accepted' ? 'Suggestion · accepted' : s.status === 'rejected' ? 'Suggestion · rejected' : 'Suggested change'));
    const diff = el('div', 'cm-diff');
    if (s.from) diff.append(el('del', '', s.from));
    diff.append(el('ins', '', s.text || '(remove the highlighted text)'));
    box.append(diff);
    if (s.status === 'pending' && !t.resolved) {
      const row = el('div', 'cm-actions');
      const rej = el('button', 'btn', 'Reject');
      const acc = el('button', 'btn primary', 'Accept');
      rej.addEventListener('click', () => setStatus(t, m, 'rejected'));
      acc.addEventListener('click', () => accept(t, m));
      row.append(rej, acc);
      box.append(row);
    }
    return box;
  }

  // ---------- floating 💬 button next to a selection ----------
  function hideFloat() { floatBtn.hidden = true; }
  function selectionChanged() {
    const sel = editor.selection();
    if (sel.empty || !sel.focused || !S.current || isTrashed() || !sel.text.trim()) return hideFloat();
    // Sit just above the first selected line, so the pill never covers the selection itself;
    // below the last line when the selection starts at the very top of the editor.
    const start = editor.coordsAt(sel.from);
    const end = editor.coordsAt(sel.to) || start;
    const box = $('#editor').getBoundingClientRect();
    if (!start || end.bottom < box.top || start.top > box.bottom) return hideFloat();
    const above = start.top - 42 >= box.top + 2;
    floatBtn.style.top = `${above ? start.top - 42 : end.bottom + 8}px`;
    floatBtn.style.left = `${Math.max(box.left + 4, Math.min(box.right - 124, (above ? start.left : end.left) - 8))}px`;
    floatBtn.hidden = false;
  }
  floatBtn.addEventListener('mousedown', (e) => { e.preventDefault(); addComment(); });

  function commentClicked(id) {
    const t = threads().find((x) => x.id === id);
    if (!t) return;
    active = id;
    applyMarks();
    toggle(true);
    setTimeout(() => list.querySelector(`[data-tid="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  }

  return { toggle, noteOpened, noteEdited, addComment, selectionChanged, commentClicked, flush, isOpen, reanchor: applyMarks };
}
