// Past Claude Code chats: read (never change) the transcripts Claude Code keeps in ~/.claude/projects/<folder>/<id>.jsonl,
// for the "Claude Chats" window — list a project's chats, show one as a clean conversation, save it as a note.
// The same files are what `claude --resume` and VibeNote's Claude panel continue from.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECTS = () => path.join(os.homedir(), '.claude', 'projects');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- small file helpers ----------
async function readSlice(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const lines = (text) => text.split('\n').filter((l) => l.startsWith('{'));

// Text the user typed (strip what Claude Code / VibeNote add around it). '' = nothing worth showing.
function cleanUserText(s) {
  let t = String(s || '');
  if (/^\s*<local-command-(stdout|stderr|caveat)>/.test(t) || /^Caveat: The messages below/.test(t)) return '';
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ' ' + args : ''}`;
  }
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<vibenote-context>[\s\S]*?<\/vibenote-context>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
  return t;
}
function userText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return cleanUserText(c);
  if (!Array.isArray(c)) return '';
  return c.map((p) => (p.type === 'text' ? cleanUserText(p.text) : p.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n\n');
}
const isToolResult = (msg) => Array.isArray(msg?.content) && msg.content.some((p) => p.type === 'tool_result');

// ---------- projects ----------
const cwdCache = new Map(); // project dir → cwd
async function cwdOf(dir) {
  if (cwdCache.has(dir)) return cwdCache.get(dir);
  let cwd = null;
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const head = await readSlice(path.join(dir, f), 0, 64 * 1024).catch(() => '');
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (m) { cwd = JSON.parse(`"${m[1]}"`); break; }
  }
  if (cwd) cwdCache.set(dir, cwd);
  return cwd;
}

/** All folders that have Claude Code chats, parents before their sub-folders. */
async function listProjects() {
  const root = PROJECTS();
  const dirs = (await fsp.readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
  const all = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    const cwd = await cwdOf(dir);
    if (!cwd || all.some((p) => p.cwd === cwd) || /^\/(private\/)?(tmp|var\/folders)\//.test(cwd)) continue; // skip throwaway temp folders
    let updated = 0;
    for (const f of files) updated = Math.max(updated, (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs);
    all.push({ cwd, chats: files.length, updated });
  }
  for (const t of t3Projects()) {
    const hit = all.find((p) => p.cwd === t.cwd);
    if (hit) hit.updated = Math.max(hit.updated, ms(t.updated));
    else all.push({ cwd: t.cwd, chats: t.n, updated: ms(t.updated) });
  }
  const home = os.homedir();
  const segs = (p) => p.split('/').filter(Boolean);
  all.sort((a, b) => {
    const A = segs(a.cwd), B = segs(b.cwd);
    for (let i = 0; i < Math.min(A.length, B.length); i++) { const c = A[i].localeCompare(B[i], undefined, { sensitivity: 'base' }); if (c) return c; }
    return A.length - B.length;
  });
  return all.map((p) => ({
    ...p,
    name: path.basename(p.cwd) || p.cwd,
    label: p.cwd === home ? '~ (home folder)' : p.cwd.startsWith(home + '/') ? '~/' + path.relative(home, p.cwd) : p.cwd,
    depth: all.filter((q) => q !== p && q.cwd !== home && p.cwd.startsWith(q.cwd + '/')).length,
    exists: fs.existsSync(p.cwd),
    isHome: p.cwd === home,
  }));
}

// ---------- T3 Code threads ----------
// T3 Code (a desktop app for coding agents) keeps its own threads in ~/.t3/userdata/statev2.sqlite. Read-only: threads
// backed by a Claude Code chat on disk are shown once (T3's title, the Claude chat's content, so Continue works);
// T3-only threads (helpers, Codex, …) are read from T3's database. If T3 changes its format, they simply don't show.
const T3_DB = () => path.join(os.homedir(), '.t3', 'userdata', 'statev2.sqlite');
let t3Copy = null; // { key, file } — fallback copy when the live database can't be opened read-only
function t3Open() {
  const file = T3_DB();
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    const st = fs.statSync(file);
    const wal = fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').mtimeMs : 0;
    const key = `${st.mtimeMs}:${wal}`;
    if (t3Copy?.key !== key) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibenote-t3-'));
      const copy = path.join(dir, 'state.sqlite');
      fs.copyFileSync(file, copy);
      if (wal) fs.copyFileSync(file + '-wal', copy + '-wal');
      if (t3Copy) fs.rmSync(path.dirname(t3Copy.file), { recursive: true, force: true });
      t3Copy = { key, file: copy };
    }
    return new DatabaseSync(t3Copy.file, { readOnly: true });
  }
}
function t3Query(fn) {
  let db = null;
  try {
    db = t3Open();
    return db ? fn(db) : null;
  } catch (e) {
    console.warn('T3 Code threads unavailable:', e.message);
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}
const pj = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const ms = (s) => (s ? Date.parse(s) : 0);

// T3 projects (folder → open thread count).
function t3Projects() {
  return t3Query((db) => db.prepare(`
    select p.workspace_root as cwd, count(t.thread_id) as n, max(t.updated_at) as updated
    from projection_projects p join orchestration_v2_projection_threads t on t.project_id = p.project_id
    where p.deleted_at is null and t.deleted_at is null group by p.project_id`).all()) || [];
}

// T3 threads of a folder, with the Claude Code chats behind them.
function t3Threads(projectCwd, subs) {
  return t3Query((db) => {
    const rows = db.prepare(`
      select t.thread_id, t.title, t.default_provider, t.created_at, t.updated_at, t.archived_at, t.payload_json, p.workspace_root
      from orchestration_v2_projection_threads t join projection_projects p on p.project_id = t.project_id
      where t.deleted_at is null and p.deleted_at is null`).all()
      .filter((r) => r.workspace_root === projectCwd || (subs && r.workspace_root.startsWith(projectCwd + '/')));
    const natives = new Map(); // thread → [claude session ids]
    for (const r of db.prepare(`select thread_id, provider, payload_json from orchestration_v2_projection_provider_threads`).all()) {
      const id = pj(r.payload_json).nativeThreadRef?.nativeId;
      if (r.provider === 'claudeAgent' && id && ID_RE.test(id)) (natives.get(r.thread_id) || natives.set(r.thread_id, []).get(r.thread_id)).push(id);
    }
    const counts = new Map(db.prepare(`select thread_id, count(*) as n from orchestration_v2_projection_messages group by thread_id`).all().map((r) => [r.thread_id, r.n]));
    const titles = new Map(rows.map((r) => [r.thread_id.split(':').pop(), r.title]));
    return rows.map((r) => {
      const p = pj(r.payload_json);
      const parent = p.lineage?.relationshipToParent === 'subagent' ? titles.get(String(p.lineage.parentThreadId)) || 'another thread' : '';
      return {
        threadId: r.thread_id,
        title: r.title,
        provider: r.default_provider,
        cwd: r.workspace_root,
        started: ms(r.created_at),
        updated: ms(r.updated_at),
        archived: !!r.archived_at,
        branch: p.branch || '',
        messages: counts.get(r.thread_id) || 0,
        helperOf: parent,
        claudeIds: natives.get(r.thread_id) || [],
      };
    });
  }) || [];
}

// A T3-only thread as panel items.
function t3Read(threadId) {
  const out = t3Query((db) => {
    const t = db.prepare(`select t.title, t.default_provider, t.created_at, t.updated_at, t.payload_json, p.workspace_root
      from orchestration_v2_projection_threads t join projection_projects p on p.project_id = t.project_id where t.thread_id = ?`).get(threadId);
    if (!t) return null;
    const items = [];
    for (const r of db.prepare(`select type, payload_json from orchestration_v2_projection_turn_items where thread_id = ? order by ordinal`).all(threadId)) {
      const j = pj(r.payload_json);
      const at = ms(j.startedAt || j.updatedAt);
      const tool = (name, input, isError = false) => items.push({ kind: 'tool', name, input, done: true, isError, at });
      switch (r.type) {
        case 'user_message': if (j.text?.trim()) items.push({ kind: 'user', text: j.text, at }); break;
        case 'assistant_message': {
          if (!j.text?.trim()) break;
          const last = items[items.length - 1];
          if (last?.kind === 'text' && last.msgId && last.msgId === j.messageId) last.text = j.text;
          else items.push({ kind: 'text', text: j.text, msgId: j.messageId, at });
          break;
        }
        case 'command_execution': tool('Bash', { command: j.input || '' }, j.exitCode != null && j.exitCode !== 0); break;
        case 'file_change': tool('Edit', { file_path: j.fileName || '' }); break;
        case 'dynamic_tool': tool(j.toolName || 'Tool', j.input && typeof j.input === 'object' ? j.input : {}); break;
        case 'web_search': tool('WebSearch', { query: (j.patterns || []).join(', ') }); break;
        case 'subagent': tool('Agent', { description: String(j.progress || j.prompt || '').split('\n')[0].slice(0, 120) }); break;
        case 'compaction': items.push({ kind: 'note', text: 'Earlier part of the conversation was summarised to save space', at }); break;
        case 'handoff': items.push({ kind: 'note', text: 'Handed over to another session', at }); break;
        case 'error': items.push({ kind: 'note', text: `Error: ${String(j.failure?.message || j.failure?.reason || 'something went wrong').slice(0, 200)}`, at }); break;
        default: break;
      }
    }
    for (const it of items) delete it.msgId;
    return { t, items };
  });
  if (!out) throw new Error('That T3 Code thread no longer exists.');
  const { t, items } = out;
  const p = pj(t.payload_json);
  return {
    meta: {
      id: `t3:${threadId}`, source: 't3', provider: t.default_provider, title: t.title, cwd: t.workspace_root,
      branch: p.branch || '', started: ms(t.created_at), updated: ms(t.updated_at), entrypoint: 't3',
    },
    items,
  };
}

// ---------- one project's chats ----------
const metaCache = new Map(); // file → { key, meta }

async function chatMeta(file) {
  const st = await fsp.stat(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = metaCache.get(file);
  if (hit && hit.key === key) return hit.meta;
  const head = await readSlice(file, 0, Math.min(st.size, 512 * 1024));
  const tailStart = Math.max(0, st.size - 512 * 1024);
  const tail = tailStart ? await readSlice(file, tailStart, st.size - tailStart) : head;
  let first = '', cwd = '', branch = '', started = '', entrypoint = '', title = '', aiTitle = '';
  for (const l of lines(head)) {
    const o = parse(l);
    if (!o) continue;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!branch && o.gitBranch) branch = o.gitBranch;
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    if (!started && o.timestamp) started = o.timestamp;
    if (!first && o.type === 'user' && !o.isMeta && !o.isSidechain && !isToolResult(o.message)) first = userText(o.message);
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
  }
  for (const l of lines(tail)) {
    if (!l.includes('-title"')) continue;
    const o = parse(l);
    if (o?.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (o?.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
  }
  const meta = {
    id: path.basename(file, '.jsonl'),
    cwd,
    branch,
    entrypoint,
    title: title || aiTitle || first.split('\n')[0].slice(0, 90) || 'Untitled chat',
    first: first.slice(0, 300),
    started: started ? Date.parse(started) : st.birthtimeMs,
    updated: st.mtimeMs,
    size: st.size,
  };
  metaCache.set(file, { key, meta });
  return meta;
}

// The chat files of a project folder (and, with subs, of the folders inside it).
async function chatFiles(projectCwd, subs = true) {
  const root = PROJECTS();
  const out = [];
  for (const d of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const cwd = await cwdOf(dir);
    if (!cwd || (cwd !== projectCwd && !(subs && cwd.startsWith(projectCwd + '/')))) continue;
    for (const f of await fsp.readdir(dir)) if (f.endsWith('.jsonl') && ID_RE.test(f.slice(0, -6))) out.push(path.join(dir, f));
  }
  return out;
}

async function listChats(projectCwd, subs = true) {
  const metas = [];
  for (const f of await chatFiles(projectCwd, subs)) {
    try {
      const m = await chatMeta(f);
      if (m.size < 200 || (!m.first && m.title === 'Untitled chat')) continue; // empty / aborted sessions
      metas.push({ ...m, source: 'claude', sub: m.cwd && m.cwd !== projectCwd ? path.relative(projectCwd, m.cwd) : '' });
    } catch {}
  }
  // T3 Code threads: one entry each. Backed by Claude Code chats on disk → that chat (newest), with T3's title.
  const byId = new Map(metas.map((m) => [m.id, m]));
  const hidden = new Set();
  for (const t of t3Threads(projectCwd, subs)) {
    const sub = t.cwd !== projectCwd ? path.relative(projectCwd, t.cwd) : '';
    const backing = t.claudeIds.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.updated - a.updated);
    if (backing.length) {
      const m = backing[0];
      Object.assign(m, { title: t.title || m.title, t3: true, helperOf: t.helperOf, updated: Math.max(m.updated, t.updated), archived: t.archived });
      backing.slice(1).forEach((b) => hidden.add(b.id));
    } else if (t.messages) {
      metas.push({
        id: `t3:${t.threadId}`, source: 't3', t3: true, provider: t.provider, title: t.title, first: '', cwd: t.cwd, sub,
        branch: t.branch, entrypoint: 't3', started: t.started, updated: t.updated, helperOf: t.helperOf, archived: t.archived, size: 0,
      });
    }
  }
  return metas.filter((m) => !hidden.has(m.id)).sort((a, b) => b.updated - a.updated);
}

async function findChat(projectCwd, id) {
  if (!ID_RE.test(String(id))) throw new Error('Bad chat id');
  const file = (await chatFiles(projectCwd)).find((f) => path.basename(f, '.jsonl') === id);
  if (!file) throw new Error('That chat no longer exists.');
  return file;
}

// ---------- reading one chat ----------
/** The conversation as panel items: { kind: 'user'|'text'|'tool'|'note', text, name, input, done, isError, at }. */
async function readChat(projectCwd, id) {
  if (String(id).startsWith('t3:')) return t3Read(String(id).slice(3));
  const file = await findChat(projectCwd, id);
  const meta = await chatMeta(file);
  const entries = new Map(); // uuid → entry (user/assistant messages of the main conversation)
  const order = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    const o = parse(line);
    if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || !o.uuid) continue;
    entries.set(o.uuid, o);
    order.push(o.uuid);
  }
  // Follow the conversation back from its last message (skips branches abandoned by rewinds / edits).
  const chain = [];
  const seen = new Set();
  let cur = entries.get(order[order.length - 1]);
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = entries.get(cur.parentUuid) || entries.get(cur.logicalParentUuid);
  }
  chain.reverse();
  // Rewinds can leave too little behind; fall back to file order then.
  const msgs = chain.length >= order.length * 0.3 ? chain : order.map((u) => entries.get(u));

  const items = [];
  const tools = new Map();
  for (const o of msgs) {
    const at = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (o.type === 'user') {
      if (o.isCompactSummary) { items.push({ kind: 'note', text: 'Earlier part of the conversation was summarised to save space', at }); continue; }
      if (o.isMeta || o.isVisibleInTranscriptOnly) continue;
      const c = o.message?.content;
      if (Array.isArray(c)) {
        for (const p of c) {
          if (p.type !== 'tool_result') continue;
          const t = tools.get(p.tool_use_id);
          if (t) { t.done = true; t.isError = !!p.is_error; }
        }
      }
      if (isToolResult(o.message)) continue;
      const text = userText(o.message);
      if (text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]') items.push({ kind: 'note', text: 'Stopped by you', at });
      else if (text) items.push({ kind: 'user', text, at });
    } else {
      for (const p of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (p.type === 'text' && p.text?.trim()) {
          const last = items[items.length - 1];
          if (last?.kind === 'text' && last.msgId === o.message.id) last.text += '\n\n' + p.text;
          else items.push({ kind: 'text', text: p.text, msgId: o.message.id, at });
        } else if (p.type === 'tool_use') {
          const t = { kind: 'tool', id: p.id, name: p.name, input: p.input || {}, done: false, at };
          tools.set(p.id, t);
          items.push(t);
        }
      }
    }
  }
  for (const it of items) delete it.msgId;
  return { meta: { ...meta, sub: meta.cwd && meta.cwd !== projectCwd ? path.relative(projectCwd, meta.cwd) : '' }, items };
}

// ---------- as a note ----------
const TOOL_VERB = {
  Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited', Bash: 'Ran',
  Grep: 'Searched', Glob: 'Listed', WebFetch: 'Fetched', WebSearch: 'Searched the web', TodoWrite: 'Updated to-dos',
  Task: 'Helper', Agent: 'Helper', AskUserQuestion: 'Asked you', ExitPlanMode: 'Proposed a plan',
};
function toolLine(t, cwd) {
  const verb = TOOL_VERB[t.name] || t.name.replace(/^mcp__[^_]+__/, '');
  const i = t.input || {};
  const rel = (p) => (cwd && String(p).startsWith(cwd + '/') ? String(p).slice(cwd.length + 1) : path.basename(String(p)));
  let what = '';
  if (i.file_path) what = rel(i.file_path);
  else if (t.name === 'Bash') what = i.description || String(i.command || '').split('\n')[0];
  else if (i.pattern) what = `“${i.pattern}”`;
  else if (i.url) what = i.url;
  else if (i.query) what = `“${i.query}”`;
  else if (i.description) what = i.description;
  what = what.replace(/`/g, "'").slice(0, 90);
  return `${verb}${what ? ` \`${what}\`` : ''}${t.isError ? ' (failed)' : ''}`;
}

const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function toMarkdown({ meta, items }, projectCwd) {
  const out = [];
  const when = meta.started && meta.updated && fmtDay(meta.started) !== fmtDay(meta.updated)
    ? `${fmtDay(meta.started)} – ${fmtDay(meta.updated)}` : fmtDay(meta.updated || meta.started);
  const asked = items.filter((i) => i.kind === 'user').length;
  out.push(`> ${meta.source === 't3' ? 'T3 Code thread' : 'Claude Code chat'} · **${path.basename(projectCwd)}**${meta.sub ? ` / ${meta.sub}` : ''}${meta.branch ? ` · branch \`${meta.branch}\`` : ''} · ${when} · ${asked} message${asked === 1 ? '' : 's'} from you`);
  out.push(meta.source === 't3'
    ? `> From T3 Code${meta.provider && meta.provider !== 'claudeAgent' ? ` (${meta.provider})` : ''} · continue it in T3 Code, or in VibeNote's Claude panel with this conversation as background`
    : `> Continue it in VibeNote's Claude panel (Claude Chats window), or in Terminal: \`claude --resume ${meta.id}\``);
  let pendingTools = [];
  const flushTools = () => {
    if (!pendingTools.length) return;
    const shown = pendingTools.slice(0, 12).map((t) => toolLine(t, meta.cwd || projectCwd));
    const more = pendingTools.length - shown.length;
    out.push(`*🔧 ${shown.join(' · ')}${more > 0 ? ` · and ${more} more` : ''}*`);
    pendingTools = [];
  };
  let lastSpeaker = '';
  for (const it of items) {
    if (it.kind === 'tool') { pendingTools.push(it); continue; }
    flushTools();
    if (it.kind === 'user') {
      out.push(`### 🧑 You${it.at ? ` · ${fmtTime(it.at)}` : ''}`, it.text);
      lastSpeaker = 'user';
    } else if (it.kind === 'text') {
      if (lastSpeaker !== 'claude') out.push('### ✦ Claude');
      out.push(it.text);
      lastSpeaker = 'claude';
    } else if (it.kind === 'note') {
      out.push(`*— ${it.text} —*`);
    }
  }
  flushTools();
  return out.join('\n\n') + '\n';
}

// Plain-text version of a conversation, to give Claude as background when a chat can't be resumed (T3-only threads).
function asBackground({ meta, items }, max = 60000) {
  const parts = [];
  for (const it of items) {
    if (it.kind === 'user') parts.push(`USER: ${it.text}`);
    else if (it.kind === 'text') parts.push(`ASSISTANT: ${it.text}`);
  }
  let text = parts.join('\n\n');
  if (text.length > max) text = '[…earlier part left out…]\n\n' + text.slice(text.length - max);
  return `<previous-conversation source="${meta.source === 't3' ? 'T3 Code' : 'Claude Code'}" title=${JSON.stringify(meta.title)}>\n${text}\n</previous-conversation>`;
}

module.exports = { listProjects, listChats, readChat, toMarkdown, findChat, asBackground };
