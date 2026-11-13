// The Claude chat panel: streaming replies, tool activity, Approve/Deny cards, questions, plans.
import { renderMarkdown } from './markdown.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const QUICK = [
  ['Plan this note', 'Read the note I am viewing. It describes what I want. Write a short, step-by-step plan into that note as a checklist under a "## Plan" heading (ask me first if anything important is unclear). Do not write any code yet.'],
  ['Build next step', 'Look at the plan checklist in the note I am viewing. Do the first unticked step only: make the change, check it works, commit it, tick the checkbox, and add a Change log entry. Then tell me in two or three plain sentences what you did.'],
  ['Explain the codebase', 'Explain how this project is organised for someone who did not write it: the main parts, what each does, and how they connect. Keep it plain. Save it as (or update) the "Codebase map" note in this project notebook.'],
  ['What changed recently?', 'Summarise the last few commits in plain language: what changed and why. Keep it short.'],
];

const TOOL_ASK = {
  Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit',
  Bash: 'Run', Grep: 'Search', Glob: 'List files', WebFetch: 'Fetch', WebSearch: 'Search the web',
};

const TOOL_LABEL = {
  Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited',
  Bash: 'Ran', Grep: 'Searched', Glob: 'Listed', WebFetch: 'Fetched', WebSearch: 'Searched the web',
  TodoWrite: 'Updated the to-do list', Task: 'Started a helper', Agent: 'Started a helper',
};

export function createAgentPanel({ api, getContext, beforeSend, onNoteMaybeChanged, openChats }) {
  const root = document.getElementById('agent');
  root.innerHTML = `
    <div class="titlebar agent-head">
      <div class="agent-title"><span class="spark">✦</span> Claude <span class="agent-project"></span></div>
      <div class="spacer"></div>
      <select class="agent-mode" title="What Claude may do without asking">
        <option value="default">Ask every time</option>
        <option value="acceptEdits">Auto-approve edits</option>
        <option value="plan">Plan only</option>
      </select>
      <button class="icon agent-chats" title="Past chats (read, continue, save as note)"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg></button>
      <button class="icon agent-more" title="More"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg></button>
      <button class="icon agent-close" title="Close (⌘J)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="agent-banner" hidden></div>
    <div class="agent-log"></div>
    <div class="agent-foot">
      <div class="agent-quick"></div>
      <div class="agent-input-wrap">
        <textarea class="agent-input" rows="1" placeholder="Ask Claude… (↵ to send, ⇧↵ new line)"></textarea>
        <button class="btn primary agent-send" title="Send (↵)">Send</button>
        <button class="btn agent-stop" title="Stop" hidden>Stop</button>
      </div>
      <div class="agent-status"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const log = $('.agent-log');
  const input = $('.agent-input');
  const status = $('.agent-status');

  let ctx = null; // { key, notebook, repo, claudePath, busy, items }
  let live = null; // streaming assistant bubble
  let liveText = '';
  let liveTimer = null;
  const toolRows = new Map();
  const cards = new Map();

  for (const [label, prompt] of QUICK) {
    const b = el('button', 'chip', label);
    b.addEventListener('click', () => send(prompt, label));
    $('.agent-quick').append(b);
  }

  // ---------- rendering ----------
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const scroll = (force) => { if (force || atBottom()) log.scrollTop = log.scrollHeight; };

  function md(text) {
    const d = el('div', 'agent-md markdown');
    d.innerHTML = renderMarkdown(text);
    d.querySelectorAll('a[href]').forEach((a) => { if (!a.getAttribute('href').startsWith('#')) a.target = '_blank'; });
    return d;
  }

  function relPath(p) {
    const s = String(p || '');
    if (ctx?.repo && s.startsWith(ctx.repo + '/')) return s.slice(ctx.repo.length + 1);
    const notes = s.indexOf('/VibeNotes/');
    return notes >= 0 ? s.slice(notes + 11) : s.split('/').slice(-2).join('/');
  }

  function toolSummary(name, input = {}, ask = false) {
    const verb = (ask ? TOOL_ASK[name] : TOOL_LABEL[name]) || name;
    if (input.file_path) return `${verb} ${relPath(input.file_path)}`;
    if (name === 'Bash') return `${verb} ${input.description || String(input.command || '').split('\n')[0]}`;
    if (input.pattern) return `${verb} for “${input.pattern}”`;
    if (input.url) return `${verb} ${input.url}`;
    if (input.query) return `${verb} “${input.query}”`;
    if (input.description) return `${verb}: ${input.description}`;
    return verb;
  }

  function finishLive() {
    clearTimeout(liveTimer);
    live = null;
    liveText = '';
  }

  function addUser(text) {
    log.querySelector('.agent-empty')?.remove();
    const b = el('div', 'msg user');
    b.textContent = text;
    log.append(b);
    scroll(true);
  }

  function addText(text) {
    if (live) {
      live.replaceWith(md(text));
      finishLive();
    } else {
      log.append(md(text));
    }
    scroll();
  }

  function delta(t) {
    liveText += t;
    if (!live) {
      live = md('');
      live.classList.add('streaming');
      log.append(live);
    }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (live) { live.innerHTML = renderMarkdown(liveText); scroll(); }
    }, 60);
  }

  function addTool(t) {
    if (t.name === 'AskUserQuestion' || t.name === 'ExitPlanMode') return; // shown as cards
    const row = el('details', 'tool');
    const sum = el('summary');
    sum.append(el('span', 'tool-state'), el('span', 'tool-text', toolSummary(t.name, t.input)));
    row.append(sum);
    const pre = el('pre', 'tool-detail');
    pre.textContent = t.name === 'Bash' ? String(t.input?.command || '') : JSON.stringify(t.input, null, 2).slice(0, 3000);
    row.append(pre);
    if (t.done) markTool(row, t.isError, t.result);
    toolRows.set(t.id, row);
    log.append(row);
    scroll();
  }

  function markTool(row, isError, text) {
    row.classList.add(isError ? 'err' : 'ok');
    if (text) {
      const out = el('pre', 'tool-result');
      out.textContent = text;
      row.append(out);
    }
  }

  function addResult(r) {
    finishLive();
    const secs = r.durationMs ? `${Math.max(1, Math.round(r.durationMs / 1000))}s` : '';
    const msg = r.isError ? `Stopped${r.subtype && r.subtype !== 'success' ? ` (${r.subtype.replace(/_/g, ' ')})` : ''}` : 'Done';
    log.append(el('div', `result-line${r.isError ? ' err' : ''}`, [msg, secs, r.turns ? `${r.turns} step${r.turns === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')));
    scroll();
  }

  function addError(message) {
    finishLive();
    log.append(el('div', 'agent-error', message));
    scroll(true);
  }

  // Edit → a small red/green diff; Write → first lines; Bash → the command.
  function permissionDetail(tool, input) {
    const box = el('div', 'perm-detail');
    if (tool === 'Edit' || tool === 'MultiEdit') {
      const edits = input.edits || [input];
      for (const e of edits.slice(0, 4)) {
        const pre = el('pre', 'diff');
        for (const l of String(e.old_string || '').split('\n').slice(0, 12)) pre.append(el('div', 'del', `- ${l}`));
        for (const l of String(e.new_string || '').split('\n').slice(0, 12)) pre.append(el('div', 'add', `+ ${l}`));
        box.append(pre);
      }
    } else if (tool === 'Write') {
      const pre = el('pre', 'diff');
      const lines = String(input.content || '').split('\n');
      for (const l of lines.slice(0, 16)) pre.append(el('div', 'add', `+ ${l}`));
      if (lines.length > 16) pre.append(el('div', 'more', `… ${lines.length - 16} more lines`));
      box.append(pre);
    } else if (tool === 'Bash') {
      const pre = el('pre', 'cmd');
      pre.textContent = input.command || '';
      box.append(pre);
    } else {
      const pre = el('pre', 'cmd');
      pre.textContent = JSON.stringify(input, null, 2).slice(0, 1500);
      box.append(pre);
    }
    return box;
  }

  function addPermission(p) {
    finishLive();
    const card = el('div', 'perm-card');
    if (p.tool === 'AskUserQuestion') return addQuestion(p, card);
    if (p.tool === 'ExitPlanMode') return addPlan(p, card);
    card.append(el('div', 'perm-title', `Allow Claude to ${toolSummary(p.tool, p.input, true).replace(/^./, (c) => c.toLowerCase())}?`));
    if (p.reason) card.append(el('div', 'perm-reason', p.reason));
    card.append(permissionDetail(p.tool, p.input || {}));
    const row = el('div', 'perm-actions');
    const btn = (label, cls, reply) => {
      const b = el('button', `btn ${cls}`, label);
      b.addEventListener('click', () => answer(p.id, card, reply, label));
      row.append(b);
    };
    btn('Allow', 'primary', { decision: 'allow' });
    if (p.canRemember) btn('Allow for this chat', '', { decision: 'always' });
    btn('Deny', 'danger', { decision: 'deny' });
    card.append(row);
    cards.set(p.id, card);
    log.append(card);
    scroll(true);
    notifyAttention();
  }

  function addQuestion(p, card) {
    card.classList.add('question');
    const answers = {};
    const qs = p.input?.questions || [];
    for (const q of qs) {
      card.append(el('div', 'perm-title', q.question));
      const opts = el('div', 'q-options');
      for (const o of q.options || []) {
        const b = el('button', 'q-opt');
        b.append(el('strong', '', o.label), el('span', '', o.description || ''));
        b.addEventListener('click', () => {
          if (q.multiSelect) {
            b.classList.toggle('sel');
            answers[q.question] = [...opts.querySelectorAll('.sel strong')].map((s) => s.textContent).join(', ');
          } else {
            opts.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('sel'));
            b.classList.add('sel');
            answers[q.question] = o.label;
          }
        });
        opts.append(b);
      }
      const other = el('input', 'q-other');
      other.placeholder = 'Or type your own answer…';
      other.addEventListener('input', () => { if (other.value.trim()) answers[q.question] = other.value.trim(); });
      card.append(opts, other);
    }
    const row = el('div', 'perm-actions');
    const ok = el('button', 'btn primary', 'Answer');
    ok.addEventListener('click', () => answer(p.id, card, { decision: 'allow', answers }, 'Answered'));
    const skip = el('button', 'btn', 'Skip');
    skip.addEventListener('click', () => answer(p.id, card, { decision: 'deny', message: 'The user skipped the question.' }, 'Skipped'));
    row.append(ok, skip);
    card.append(row);
    cards.set(p.id, card);
    log.append(card);
    scroll(true);
    notifyAttention();
  }

  function addPlan(p, card) {
    card.classList.add('plan');
    card.append(el('div', 'perm-title', 'Claude’s plan is ready'));
    if (p.input?.plan) card.append(md(String(p.input.plan)));
    const row = el('div', 'perm-actions');
    const go = el('button', 'btn primary', 'Approve and start');
    go.addEventListener('click', () => {
      answer(p.id, card, { decision: 'allow' }, 'Approved');
      setMode('default');
    });
    const keep = el('button', 'btn', 'Keep planning');
    keep.addEventListener('click', () => answer(p.id, card, { decision: 'deny', message: 'The user wants to keep planning. Ask what to change.' }, 'Keep planning'));
    row.append(go, keep);
    card.append(row);
    cards.set(p.id, card);
    log.append(card);
    scroll(true);
    notifyAttention();
  }

  function answer(id, card, reply, label) {
    api.agent.reply(id, reply);
    card.classList.add('answered');
    card.querySelector('.perm-actions')?.replaceWith(el('div', 'perm-answer', label));
    card.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
    cards.delete(id);
  }

  function notifyAttention() {
    if (!document.hasFocus()) new Notification('Claude needs your OK', { body: 'Open VibeNote to approve or deny.', silent: false });
  }

  function renderHistory(items) {
    log.textContent = '';
    toolRows.clear();
    finishLive();
    if (!items.length) {
      const hello = el('div', 'agent-empty');
      hello.innerHTML = ctx?.repo
        ? `<p><strong>${esc(ctx.notebook)}</strong> is linked to<br><code>${esc(ctx.repo)}</code></p><p>Ask anything, or use a quick action below. Claude sees the note you're viewing.</p>`
        : `<p>Claude can read and edit your notes.</p><p>To let it work on code too, <a href="#" class="link-repo">link a code folder</a> to the <strong>${esc(ctx?.notebook || 'current')}</strong> notebook.</p>`;
      hello.querySelector('.link-repo')?.addEventListener('click', (e) => { e.preventDefault(); link(); });
      log.append(hello);
      return;
    }
    for (const it of items) {
      if (it.kind === 'user') addUser(it.text.replace(/^<vibenote-context>[\s\S]*?<\/vibenote-context>\s*/, ''));
      else if (it.kind === 'text') addText(it.text);
      else if (it.kind === 'tool') addTool(it);
      else if (it.kind === 'result') addResult(it);
      else if (it.kind === 'error') addError(it.message);
      else if (it.kind === 'note') log.append(el('div', 'result-line', it.text));
    }
    scroll(true);
  }

  function setBusy(b) {
    ctx && (ctx.busy = b);
    $('.agent-stop').hidden = !b;
    $('.agent-send').hidden = b && !input.value.trim();
    status.textContent = b ? 'Claude is working…' : '';
    root.classList.toggle('busy', b);
  }

  function setMode(mode) {
    $('.agent-mode').value = mode;
    if (ctx) api.agent.setMode(ctx.key, mode);
  }

  // ---------- actions ----------
  async function load() {
    const c = getContext();
    ctx = await api.agent.context(c.notebook);
    $('.agent-project').textContent = ctx.notebook ? `· ${ctx.notebook}` : '';
    $('.agent-project').title = ctx.repo || 'Notes only — no code folder linked';
    const banner = $('.agent-banner');
    banner.hidden = !!ctx.claudePath;
    banner.textContent = ctx.claudePath ? '' : 'Claude Code isn’t installed (or can’t be found). Install it from claude.com/claude-code, run `claude` once in Terminal to log in, then reopen this panel.';
    const s = await api.getSettings();
    $('.agent-mode').value = s.agentMode || 'default';
    renderHistory(ctx.items || []);
    setBusy(!!ctx.busy);
  }

  async function send(text, label) {
    text = text.trim();
    if (!text) return;
    await beforeSend();
    const c = getContext();
    addUser(label || text);
    input.value = '';
    autosize();
    setBusy(true);
    try {
      await api.agent.send({ notebook: c.notebook, text, notePath: c.notePath, noteTitle: c.noteTitle });
    } catch (e) {
      addError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  }

  async function link() {
    const c = getContext();
    try {
      const repo = await api.agent.link(c.notebook);
      if (repo) await load();
    } catch (e) {
      addError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  async function moreMenu() {
    const items = [
      { id: 'new', label: 'New Chat' },
      { id: 'chats', label: 'Past Chats…' },
      { type: 'separator' },
      ctx?.repo ? { id: 'unlink', label: `Unlink “${ctx.notebook}” from its code folder` } : { id: 'link', label: 'Link a Code Folder to This Notebook…' },
    ];
    const id = await api.popup(items);
    if (id === 'new') { await api.agent.newChat(ctx.key); await load(); }
    if (id === 'chats') openChats?.();
    if (id === 'link') link();
    if (id === 'unlink') { await api.agent.unlink(ctx.key); await load(); }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  // ---------- events ----------
  api.agent.onEvent(({ key, evt }) => {
    if (!ctx || key !== ctx.key) return;
    switch (evt.kind) {
      case 'delta': delta(evt.text); break;
      case 'text': addText(evt.text); break;
      case 'tool': addTool(evt); break;
      case 'tool_result': {
        const row = toolRows.get(evt.id);
        if (row) markTool(row, evt.isError, evt.text);
        if (!evt.isError) onNoteMaybeChanged();
        break;
      }
      case 'permission': addPermission(evt); break;
      case 'permission_cancel': {
        const card = cards.get(evt.id);
        if (card) { card.classList.add('answered'); card.querySelector('.perm-actions')?.replaceWith(el('div', 'perm-answer', 'Cancelled')); cards.delete(evt.id); }
        break;
      }
      case 'status': status.textContent = evt.text; break;
      case 'result': addResult(evt); setBusy(false); break;
      case 'error': addError(evt.message); setBusy(false); break;
      case 'closed': setBusy(false); break;
      default: break;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', () => { autosize(); if (ctx?.busy) $('.agent-send').hidden = !input.value.trim(); });
  $('.agent-send').addEventListener('click', () => send(input.value));
  $('.agent-stop').addEventListener('click', () => ctx && api.agent.stop(ctx.key));
  $('.agent-mode').addEventListener('change', (e) => setMode(e.target.value));
  $('.agent-more').addEventListener('click', moreMenu);
  $('.agent-chats').addEventListener('click', () => openChats?.());
  $('.agent-close').addEventListener('click', () => toggle(false));

  let lastKey = null;
  function toggle(force) {
    const open = force ?? !document.body.classList.contains('agent-open');
    document.body.classList.toggle('agent-open', open);
    if (open) { load().then(() => input.focus()); lastKey = getContext().notebook; }
  }

  // When the user switches to a note in another project, reload that project's chat.
  async function noteChanged() {
    if (!document.body.classList.contains('agent-open')) return;
    const nb = getContext().notebook.split('/')[0];
    if (nb === String(lastKey || '').split('/')[0]) return;
    lastKey = nb;
    await load();
  }

  return { toggle, noteChanged, focus: () => input.focus() };
}
