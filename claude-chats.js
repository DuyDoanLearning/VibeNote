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
      metas.push({ ...m, sub: m.cwd && m.cwd !== projectCwd ? path.relative(projectCwd, m.cwd) : '' });
    } catch {}
  }
  return metas.sort((a, b) => b.updated - a.updated);
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
  out.push(`> Claude Code chat · **${path.basename(projectCwd)}**${meta.sub ? ` / ${meta.sub}` : ''}${meta.branch ? ` · branch \`${meta.branch}\`` : ''} · ${when} · ${asked} message${asked === 1 ? '' : 's'} from you`);
  out.push(`> Continue it in VibeNote's Claude panel (Claude Chats window), or in Terminal: \`claude --resume ${meta.id}\``);
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

module.exports = { listProjects, listChats, readChat, toMarkdown, findChat };
