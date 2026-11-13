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
  TodoWrite: 'Updated the to-do list', Task: 'Helper', Agent: 'Helper', Skill: 'Used skill',
  TaskCreate: 'Added a to-do', TaskUpdate: 'Updated a to-do', TaskList: 'Checked the to-dos',
};
// What the status line says while a tool runs (Claude Code style).
const TOOL_DOING = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing', NotebookEdit: 'Editing', Bash: 'Running',
  Grep: 'Searching', Glob: 'Listing files', WebFetch: 'Fetching', WebSearch: 'Searching the web', Task: 'Helper working', Agent: 'Helper working',
};
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const fmtSecs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

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
  const toolRows = new Map(); // tool id → { row, name, input, sub }
  const cards = new Map();
  // live turn state (status line)
  let turn = null; // { start, tokens, thinkingTokens, activity }
  let think = null; // live thinking block { box, sum, body, text, start }
  let spinI = 0;
  let ticker = null;

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
    endThinking();
    if (live) {
      live.replaceWith(md(text));
      finishLive();
    } else {
      log.append(md(text));
    }
    scroll();
  }

  function delta(t) {
    endThinking();
    activity('Writing');
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

  // A tool row appears as soon as Claude starts the call (tool_start), and fills in when the full call arrives.
  function addTool(t) {
    if (t.name === 'AskUserQuestion' || t.name === 'ExitPlanMode') return; // shown as cards
    endThinking();
    if (t.name === 'TodoWrite' && t.input?.todos) { toolRows.get(t.id)?.wrap.remove(); toolRows.delete(t.id); return addTodos(t.input.todos); }
    let r = toolRows.get(t.id);
    if (!r) {
      const wrap = el('div', 'tool-wrap');
      const row = el('details', 'tool');
      const sum = el('summary');
      sum.append(el('span', 'tool-state'), el('span', 'tool-text'), el('span', 'tool-sum'), el('span', 'tool-time'));
      row.append(sum);
      wrap.append(row);
      r = { wrap, row, name: t.name, input: {}, steps: 0 };
      toolRows.set(t.id, r);
      log.append(wrap);
    }
    r.name = t.name || r.name;
    if (t.input && Object.keys(t.input).length) {
      r.input = t.input;
      r.row.querySelector('.tool-detail')?.remove();
      const detail = permissionDetail(r.name, r.input);
      detail.classList.add('tool-detail');
      r.row.append(detail);
    }
    r.row.querySelector('.tool-text').textContent = Object.keys(r.input).length ? toolSummary(r.name, r.input) : `${TOOL_LABEL[r.name] || r.name}…`;
    if (Object.keys(r.input).length) activity(doing(r.name, r.input));
    if (t.done) markTool(t.id, t.isError, t.result);
    scroll();
  }

  function doing(name, input = {}) {
    const verb = TOOL_DOING[name];
    if (!verb) return `${TOOL_LABEL[name] || name.replace(/^mcp__[^_]+__/, '')}`;
    if (input.file_path) return `${verb} ${relPath(input.file_path).split('/').pop()}`;
    if (name === 'Bash') return `${verb} ${input.description || String(input.command || '').split('\n')[0].slice(0, 40)}`;
    if (name === 'Task' || name === 'Agent') return `${verb}: ${input.description || ''}`;
    return verb;
  }

  // One-line result next to the step, like Claude Code's "⎿ Read 120 lines".
  function resultSummary(name, input = {}, text = '', isError) {
    if (isError) return 'failed';
    const lines = String(text).split('\n').filter((l) => l.trim());
    if (name === 'Read') return `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    if (name === 'Edit' || name === 'MultiEdit') {
      const edits = input.edits || [input];
      const add = edits.reduce((s, e) => s + String(e.new_string || '').split('\n').length, 0);
      const del = edits.reduce((s, e) => s + String(e.old_string || '').split('\n').length, 0);
      return `+${add} −${del}`;
    }
    if (name === 'Write') return `${String(input.content || '').split('\n').length} lines`;
    if (name === 'Grep' || name === 'Glob') return /^No (files|matches)/i.test(lines[0] || '') ? 'nothing found' : `${lines.length} result${lines.length === 1 ? '' : 's'}`;
    if (name === 'Bash') return lines.length ? lines[lines.length - 1].trim().slice(0, 70) : 'done';
    return '';
  }

  function markTool(id, isError, text) {
    const r = toolRows.get(id);
    if (!r) return;
    r.row.classList.add(isError ? 'err' : 'ok');
    r.row.querySelector('.tool-sum').textContent = resultSummary(r.name, r.input, text, isError);
    r.row.querySelector('.tool-time').textContent = '';
    if (text && !r.row.querySelector('.tool-result')) {
      const out = el('pre', 'tool-result');
      out.textContent = text;
      r.row.append(out);
    }
    r.sub?.classList.add('done');
  }

  // Helper agent progress under its tool row.
  function subProgress(id, { steps, last, tokens, status }) {
    const r = toolRows.get(id);
    if (!r) return;
    if (!r.sub) { r.sub = el('div', 'tool-sub'); r.wrap.append(r.sub); }
    if (steps != null) r.steps = steps; else r.steps++;
    if (last) r.last = last;
    if (tokens) r.tokens = tokens;
    r.sub.textContent = `↳ ${r.steps} step${r.steps === 1 ? '' : 's'}${r.last ? ` · ${r.last}` : ''}${r.tokens ? ` · ${fmtTokens(r.tokens)} tokens` : ''}${status && status !== 'running' ? ` · ${status}` : ''}`;
    scroll();
  }

  // To-do list (TodoWrite) as a live checklist.
  function addTodos(todos) {
    const card = el('div', 'todo-card');
    card.append(el('div', 'todo-title', 'To-dos'));
    for (const t of todos) {
      const row = el('div', `todo ${t.status || 'pending'}`);
      row.append(el('span', 'todo-box', t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'),
        el('span', '', t.status === 'in_progress' ? (t.activeForm || t.content) : t.content));
      card.append(row);
    }
    log.append(card);
    const now = todos.find((t) => t.status === 'in_progress');
    if (now) activity(now.activeForm || now.content);
    scroll();
  }

  // ---------- thinking ----------
  function startThinking() {
    if (think) return;
    finishLive();
    const box = el('details', 'thinking live');
    box.open = true;
    const sum = el('summary', '', '✻ Thinking…');
    const body = el('div', 'thinking-body');
    box.append(sum, body);
    log.append(box);
    think = { box, sum, body, text: '', start: Date.now(), timer: null };
    activity('Thinking');
    scroll();
  }
  function thinkingDelta(t) {
    if (!think) startThinking();
    think.text += t;
    clearTimeout(think.timer);
    const k = think;
    think.timer = setTimeout(() => { k.body.textContent = k.text; scroll(); }, 60);
  }
  function endThinking(finalText) {
    if (!think) {
      if (finalText?.trim()) { // thinking that arrived without streaming (or from history)
        const box = el('details', 'thinking');
        box.append(el('summary', '', '✻ Thought'), el('div', 'thinking-body', finalText));
        log.append(box);
      }
      return;
    }
    const k = think;
    think = null;
    clearTimeout(k.timer);
    const text = finalText?.trim() ? finalText : k.text;
    k.body.textContent = text;
    k.sum.textContent = `✻ Thought for ${fmtSecs(Date.now() - k.start)}`;
    k.box.classList.remove('live');
    k.box.open = false;
    if (!text.trim()) k.box.classList.add('empty');
  }

  // ---------- status line ----------
  function activity(text) {
    if (turn) { turn.activity = text; renderStatus(); }
  }
  function renderStatus() {
    if (!turn) return;
    const parts = [`${turn.activity || 'Working'}…`, fmtSecs(Date.now() - turn.start)];
    if (turn.tokens) parts.push(`↓ ${fmtTokens(turn.tokens)} tokens`);
    status.textContent = `${SPIN[spinI % SPIN.length]} ${parts.join(' · ')}`;
  }
  function startTurn() {
    turn = { start: Date.now(), tokens: 0, thinkingTokens: 0, activity: 'Working' };
    clearInterval(ticker);
    ticker = setInterval(() => { spinI++; renderStatus(); }, 160);
    renderStatus();
  }
  function endTurn() {
    clearInterval(ticker);
    ticker = null;
    turn = null;
    endThinking();
  }

  function addResult(r) {
    finishLive();
    endThinking();
    const secs = r.durationMs ? fmtSecs(Math.max(1000, r.durationMs)) : '';
    const msg = r.isError ? `Stopped${r.subtype && r.subtype !== 'success' ? ` (${r.subtype.replace(/_/g, ' ')})` : ''}` : 'Done';
    log.append(el('div', `result-line${r.isError ? ' err' : ''}`, [msg, secs, r.turns ? `${r.turns} step${r.turns === 1 ? '' : 's'}` : '', r.outputTokens ? `${fmtTokens(r.outputTokens)} tokens` : ''].filter(Boolean).join(' · ')));
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
    endThinking();
    activity('Waiting for your OK');
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
      else if (it.kind === 'thinking') endThinking(it.text);
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
    root.classList.toggle('busy', b);
    if (b && !turn) startTurn();
    if (!b) { endTurn(); status.textContent = ''; }
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
      case 'thinking_start': startThinking(); break;
      case 'thinking_delta': thinkingDelta(evt.text); break;
      case 'thinking': endThinking(evt.text); break;
      case 'tokens': if (turn) turn.tokens = evt.output; break;
      case 'tool_start': addTool({ id: evt.id, name: evt.name }); break;
      case 'tool': addTool(evt); break;
      case 'tool_progress': {
        const r = toolRows.get(evt.id);
        if (r && evt.seconds >= 2) r.row.querySelector('.tool-time').textContent = fmtSecs(evt.seconds * 1000);
        break;
      }
      case 'task': if (evt.toolUseId) subProgress(evt.toolUseId, { steps: evt.steps, last: evt.lastTool, tokens: evt.tokens, status: evt.status }); break;
      case 'sub_tool': subProgress(evt.parent, { last: evt.input ? toolSummary(evt.name, evt.input) : evt.name }); break;
      case 'note': log.append(el('div', 'result-line', evt.text)); scroll(); break;
      case 'tool_result': {
        markTool(evt.id, evt.isError, evt.text);
        activity('Thinking');
        if (!evt.isError) onNoteMaybeChanged();
        break;
      }
      case 'permission': addPermission(evt); break;
      case 'permission_cancel': {
        const card = cards.get(evt.id);
        if (card) { card.classList.add('answered'); card.querySelector('.perm-actions')?.replaceWith(el('div', 'perm-answer', 'Cancelled')); cards.delete(evt.id); }
        break;
      }
      case 'status': activity(/^requesting$/i.test(evt.text) ? 'Thinking' : evt.text.replace(/^./, (c) => c.toUpperCase())); break;
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
