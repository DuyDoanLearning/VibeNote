// Slash commands in the Claude panel: a "/" menu over the input (like Claude Code), VibeNote's own commands with
// proper cards (/model, /effort, /usage, /context, /mcp, /clear, /chats, /mode, /help), and every other command
// Claude Code knows (custom commands, skills, plugins, /compact, /init…) passed straight through as a message.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const LOCAL = [
  { name: 'model', description: 'Switch the Claude model', argumentHint: '[model]' },
  { name: 'effort', description: 'How hard Claude thinks: low · medium · high · xhigh · max', argumentHint: '[level]' },
  { name: 'usage', description: 'Plan usage limits and what this chat cost', aliases: ['cost', 'stats'] },
  { name: 'context', description: 'How full Claude’s memory of this chat is' },
  { name: 'clear', description: 'Start a new chat', aliases: ['new'] },
  { name: 'chats', description: 'Past chats: read, continue, save as note', aliases: ['resume'] },
  { name: 'mode', description: 'What Claude may do without asking', argumentHint: '[ask | edits | plan]' },
  { name: 'mcp', description: 'Connected MCP servers (tools)' },
  { name: 'help', description: 'All slash commands' },
];
// Claude Code commands that only make sense in its terminal UI.
const HIDDEN = new Set(['color', 'heapdump', 'focus', 'config', 'vim', 'terminal-setup', 'exit', 'quit', 'theme', 'statusline', 'keybindings', 'ide', 'install-github-app', 'login', 'logout', 'permissions', 'hooks', 'output-style', 'resume', 'design-consent', 'design-revoke', 'workflow-launch-exec']);

const LIMITS = {
  five_hour: 'Current session (5 hours)',
  seven_day: 'This week · all models',
  seven_day_opus: 'This week · Opus',
  seven_day_sonnet: 'This week · Sonnet',
  seven_day_oauth_apps: 'This week · apps',
  seven_day_cowork: 'This week · Cowork',
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = { ask: 'default', default: 'default', edits: 'acceptEdits', acceptedits: 'acceptEdits', auto: 'acceptEdits', plan: 'plan' };
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `resets ${time}`;
  return `resets ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
};
export const prettyModel = (id) => {
  if (!id || id === 'default') return 'Default';
  const m = /(opus|sonnet|haiku|fable)[-_]?(\d+)?(?:[-_.](\d+))?/i.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] ? `${name} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}` : name;
};

export function createSlash({ api, input, menuHost, getNotebook, addCard, actions }) {
  let remote = null; // commands from Claude Code (loaded on first "/")
  let loading = null;
  let items = [];
  let sel = 0;
  const menu = el('div', 'slash-menu');
  menu.hidden = true;
  menuHost.prepend(menu);

  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  function loadRemote() {
    loading ||= api.agent.commands(getNotebook()).then((c) => { remote = c || []; render(); }).catch(() => { remote = []; });
    return loading;
  }
  const reset = () => { remote = null; loading = null; };

  function all() {
    const local = LOCAL.map((c) => ({ ...c, local: true }));
    const names = new Set(local.flatMap((c) => [c.name, ...(c.aliases || [])]));
    const rest = (remote || []).filter((c) => !names.has(c.name) && !HIDDEN.has(c.name) && !c.name.startsWith('_'))
      .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || a.name.localeCompare(b.name));
    return [...local, ...rest];
  }

  // Exact name or alias first, then names starting with what was typed, then the rest (VibeNote's own commands first).
  const rank = (c, q) => {
    if (!q) return 0;
    const n = c.name.toLowerCase(), al = c.aliases || [];
    if (n === q || al.includes(q)) return 0;
    if (n.startsWith(q) || al.some((a) => a.startsWith(q))) return c.local ? 1 : 2;
    return 3;
  };
  function render() {
    const v = input.value;
    const m = /^\/(\S*)$/.exec(v);
    if (!m || v.includes('\n')) { close(); return; }
    const q = m[1].toLowerCase();
    items = all().filter((c) => !q || c.name.toLowerCase().includes(q) || (c.aliases || []).some((a) => a.startsWith(q)))
      .sort((a, b) => rank(a, q) - rank(b, q))
      .slice(0, 60);
    menu.textContent = '';
    if (!items.length) { menu.append(el('div', 'slash-empty', remote ? 'No matching command' : 'Loading commands…')); menu.hidden = false; return; }
    sel = Math.min(sel, items.length - 1);
    items.forEach((c, i) => {
      const row = el('div', 'slash-item' + (i === sel ? ' sel' : ''));
      row.append(el('span', 'slash-name', `/${c.name}`));
      if (c.argumentHint) row.append(el('span', 'slash-arg', c.argumentHint));
      row.append(el('span', 'slash-desc', c.description || ''));
      if (!c.local && !c.builtin) row.append(el('span', 'slash-kind', 'skill / custom'));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; accept(); });
      menu.append(row);
    });
    if (!remote) menu.append(el('div', 'slash-empty', 'Loading Claude Code commands…'));
    menu.hidden = false;
    menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function close() { menu.hidden = true; sel = 0; }
  const open = () => !menu.hidden && items.length > 0;

  function accept() {
    const c = items[sel];
    if (!c) return;
    input.value = `/${c.name}${c.argumentHint ? ' ' : ''}`;
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
    if (!c.argumentHint) actions.submit(input.value);
  }

  // Keys while the menu is open. Returns true when handled.
  function onKey(e) {
    if (!open()) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); accept(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    return false;
  }

  function onInput() {
    if (/^\/\S*$/.test(input.value)) { if (!remote) loadRemote(); render(); } else close();
  }

  // ---------- running a command ----------
  // Returns true when VibeNote handled it; false = send it to Claude Code as a message.
  async function run(text) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    const name = m[1].toLowerCase();
    const arg = m[2].trim();
    const cmd = LOCAL.find((c) => c.name === name || (c.aliases || []).includes(name));
    if (!cmd) return false;
    const nb = getNotebook();
    try {
      switch (cmd.name) {
        case 'model': await model(nb, arg); break;
        case 'effort': await effort(nb, arg); break;
        case 'usage': await usage(nb); break;
        case 'context': await context(nb); break;
        case 'clear': await actions.newChat(); break;
        case 'chats': actions.openChats(); break;
        case 'mode': mode(arg); break;
        case 'mcp': await mcp(nb); break;
        case 'help': help(); break;
        default: return false;
      }
    } catch (e) {
      addCard(el('div', 'agent-error', errText(e)));
    }
    return true;
  }

  function card(title) {
    const c = el('div', 'slash-card');
    c.append(el('div', 'slash-card-title', title));
    return c;
  }

  async function model(nb, arg) {
    const { models, current } = await api.agent.models(nb);
    const set = async (m) => {
      const v = await api.agent.setModel(nb, m.value);
      actions.modelChanged(v);
      return v;
    };
    if (arg) {
      const a = arg.toLowerCase();
      const hit = models.find((m) => m.value.toLowerCase() === a) || models.find((m) => m.displayName.toLowerCase().startsWith(a)) || models.find((m) => m.value.toLowerCase().includes(a));
      if (!hit) throw new Error(`No model “${arg}”. Type /model to pick from the list.`);
      await set(hit);
      addCard(el('div', 'result-line', `Model: ${hit.displayName}`));
      return;
    }
    const c = card('Model');
    const list = el('div', 'slash-options');
    for (const m of models) {
      const b = el('button', 'slash-opt' + ((current || 'default') === m.value ? ' on' : ''));
      b.append(el('strong', '', m.displayName), el('span', '', m.description || ''));
      b.addEventListener('click', async () => {
        try {
          await set(m);
          list.querySelectorAll('.slash-opt').forEach((x) => x.classList.toggle('on', x === b));
        } catch (e) { addCard(el('div', 'agent-error', errText(e))); }
      });
      list.append(b);
    }
    c.append(list, el('div', 'slash-note', 'Applies from your next message, in this chat and new ones.'));
    addCard(c);
  }

  async function effort(nb, arg) {
    const set = async (lv) => {
      await api.agent.setEffort(nb, lv);
      const s = await api.getSettings();
      return s.agentEffort;
    };
    if (arg) {
      const lv = arg.toLowerCase();
      if (![...EFFORTS, 'default'].includes(lv)) throw new Error(`Effort is one of: ${EFFORTS.join(', ')} (or default).`);
      await set(lv);
      addCard(el('div', 'result-line', `Effort: ${lv}`));
      return;
    }
    const cur = (await api.getSettings()).agentEffort || 'default';
    const c = card('Effort — how hard Claude thinks');
    const row = el('div', 'slash-seg');
    for (const lv of ['default', ...EFFORTS]) {
      const b = el('button', 'btn' + (cur === lv ? ' primary' : ''), lv);
      b.addEventListener('click', async () => {
        try {
          await set(lv);
          row.querySelectorAll('.btn').forEach((x) => x.classList.toggle('primary', x === b));
        } catch (e) { addCard(el('div', 'agent-error', errText(e))); }
      });
      row.append(b);
    }
    c.append(row, el('div', 'slash-note', 'Higher = more careful and slower, uses more of your plan. “max” lasts for this session only.'));
    addCard(c);
  }

  async function usage(nb) {
    const u = await api.agent.usage(nb);
    const c = card(`Usage${u.subscription_type ? ` · ${u.subscription_type[0].toUpperCase()}${u.subscription_type.slice(1)} plan` : ''}`);
    const limits = u.rate_limits || {};
    let shown = 0;
    for (const [key, label] of Object.entries(LIMITS)) {
      const l = limits[key];
      if (!l || l.utilization == null) continue;
      shown++;
      const pct = Math.max(0, Math.min(100, Math.round(l.utilization)));
      const row = el('div', 'usage-row');
      const bar = el('div', 'usage-bar');
      const fill = el('div', 'usage-fill' + (pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''));
      fill.style.width = `${pct}%`;
      bar.append(fill);
      row.append(el('div', 'usage-label', label), bar, el('div', 'usage-meta', `${pct}% used${l.resets_at ? ' · ' + when(l.resets_at) : ''}`));
      c.append(row);
    }
    if (!shown) {
      const fb = u.fallback && Object.values(u.fallback)[0];
      c.append(el('div', 'slash-note', u.rate_limits_available === false
        ? 'Plan limits don’t apply to this login (API key or cloud provider).'
        : fb?.utilization != null ? `Last seen: ${Math.round(fb.utilization * (fb.utilization <= 1 ? 100 : 1))}% of a limit used.` : 'Plan limits aren’t available right now.'));
    }
    const s = u.session;
    if (s) {
      const tokens = Object.values(s.model_usage || {}).reduce((t, m) => t + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0), 0);
      const mins = Math.round((s.total_api_duration_ms || 0) / 60000);
      c.append(el('div', 'usage-session', `This chat: ${s.total_cost_usd ? `$${s.total_cost_usd.toFixed(2)} of API value` : 'nothing yet'}${tokens ? ` · ${fmtTok(tokens)} tokens` : ''}${mins ? ` · ${mins} min of Claude time` : ''}${s.total_lines_added || s.total_lines_removed ? ` · +${s.total_lines_added} −${s.total_lines_removed} lines` : ''}`));
    }
    addCard(c);
  }

  async function context(nb) {
    const u = await api.agent.contextUsage(nb);
    const c = card(`Context · ${fmtTok(u.totalTokens)} of ${fmtTok(u.maxTokens)} tokens (${Math.round(u.percentage)}%)`);
    const used = u.categories.filter((x) => x.kind === 'used' && x.tokens > 0);
    const PALETTE = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#db2777', '#64748b'];
    const bar = el('div', 'ctx-bar');
    used.forEach((x, i) => {
      const seg = el('div', 'ctx-seg');
      seg.style.width = `${Math.max(0.4, (x.tokens / u.maxTokens) * 100)}%`;
      seg.style.background = PALETTE[i % PALETTE.length];
      seg.title = `${x.name}: ${fmtTok(x.tokens)}`;
      bar.append(seg);
    });
    c.append(bar);
    const list = el('div', 'ctx-list');
    used.forEach((x, i) => {
      const row = el('div', 'ctx-item');
      const dot = el('span', 'ctx-dot');
      dot.style.background = PALETTE[i % PALETTE.length];
      row.append(dot, el('span', '', x.name), el('span', 'ctx-n', fmtTok(x.tokens)));
      list.append(row);
    });
    const free = u.categories.find((x) => x.kind === 'free');
    if (free) list.append(el('div', 'ctx-item muted', `Free: ${fmtTok(free.tokens)}`));
    c.append(list, el('div', 'slash-note', 'When it gets full, Claude summarises older messages automatically. Type /compact to do it now.'));
    addCard(c);
  }

  function mode(arg) {
    const m = MODES[arg.toLowerCase()];
    if (!m) {
      const c = card('Mode — what Claude may do without asking');
      c.append(el('div', 'slash-note', 'Use /mode ask, /mode edits (auto-approve edits) or /mode plan — or the menu at the top of the panel.'));
      addCard(c);
      return;
    }
    actions.setMode(m);
    addCard(el('div', 'result-line', `Mode: ${{ default: 'Ask every time', acceptEdits: 'Auto-approve edits', plan: 'Plan only' }[m]}`));
  }

  async function mcp(nb) {
    const list = await api.agent.mcp(nb);
    const c = card(`MCP servers · ${list.filter((s) => s.status === 'connected').length} of ${list.length} connected`);
    for (const s of list) {
      const row = el('div', `mcp-row ${s.status}`);
      row.append(el('span', 'mcp-dot'), el('span', 'mcp-name', s.name.replace(/^plugin:[^:]+:/, '')), el('span', 'mcp-status', s.status.replace(/-/g, ' ')));
      c.append(row);
    }
    addCard(c);
  }

  function help() {
    const c = card('Slash commands');
    for (const x of all()) {
      const row = el('div', 'slash-help');
      const d = String(x.description || '');
      row.append(el('code', '', `/${x.name}`), el('span', '', d.length > 110 ? d.slice(0, 107).replace(/\s+\S*$/, '') + '…' : d));
      c.append(row);
    }
    if (!remote) c.append(el('div', 'slash-note', 'Type / to also load your Claude Code commands and skills.'));
    addCard(c);
  }

  return { onKey, onInput, run, close, reset, preload: loadRemote };
}
