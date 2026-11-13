// "Claude Chats" window: browse the past Claude Code chats of a project folder (Terminal, VS Code, VibeNote…),
// read one as a clean conversation, continue it in the Claude panel, or save it as a note.
import { renderMarkdown } from './markdown.js';

const SOURCE = { cli: 'Terminal', 'claude-vscode': 'VS Code', 'sdk-ts': 'App', 'sdk-py': 'App', 'sdk-cli': 'Script' };
const TOOL_VERB = {
  Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited', Bash: 'Ran',
  Grep: 'Searched', Glob: 'Listed', WebFetch: 'Fetched', WebSearch: 'Searched the web', TodoWrite: 'Updated to-dos',
  Task: 'Helper', Agent: 'Helper', AskUserQuestion: 'Asked you', ExitPlanMode: 'Proposed a plan',
};
const CHUNK = 150; // conversation items rendered per scroll step

export function createChatsUI(ctx) {
  const { api, $, el, overlay, closeOverlay, toast, getNotebook, afterContinue, afterExport } = ctx;
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const ago = (ms) => {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
  };

  async function open() {
    const ov = overlay('modal-ov');
    ov.innerHTML = `
      <div class="modal chats-win">
        <div class="chats-head">
          <h2>Claude Chats</h2>
          <select class="chats-project" title="Project folder"></select>
          <label class="chats-subs" title="Also show chats started in folders inside this one"><input type="checkbox" checked> Sub-folders</label>
          <div class="spacer"></div>
          <button class="icon chats-close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="chats-body">
          <div class="chats-side">
            <input class="chats-search" type="search" placeholder="Filter chats…" spellcheck="false">
            <ul class="chats-list"></ul>
          </div>
          <div class="chats-main"><div class="chats-empty">Pick a chat on the left.</div></div>
        </div>
      </div>`;
    const sel = $('.chats-project', ov);
    const subs = $('.chats-subs input', ov);
    const list = $('.chats-list', ov);
    const main = $('.chats-main', ov);
    const search = $('.chats-search', ov);
    $('.chats-close', ov).addEventListener('click', closeOverlay);
    let chats = [];
    let projects = [];
    let openId = null;

    try {
      const r = await api.chats.projects(getNotebook());
      projects = r.projects;
      if (!projects.length) {
        main.innerHTML = '<div class="chats-empty">No Claude Code chats on this Mac yet.</div>';
        return;
      }
      for (const p of projects) {
        const o = new Option(`${'   '.repeat(p.depth)}${p.label}  (${p.chats})${p.notebook ? `  · notebook ${p.notebook}` : ''}`, p.cwd);
        sel.append(o);
      }
      let pick = r.current;
      try { pick ||= localStorage.getItem('vibe.chatsProject'); } catch {}
      sel.value = projects.some((p) => p.cwd === pick) ? pick : projects.filter((p) => !p.isHome).sort((a, b) => b.updated - a.updated)[0]?.cwd || projects[0].cwd;
    } catch (e) {
      main.innerHTML = '';
      main.append(el('div', 'chats-empty', errText(e)));
      return;
    }

    const project = () => projects.find((p) => p.cwd === sel.value);

    async function loadList() {
      try { localStorage.setItem('vibe.chatsProject', sel.value); } catch {}
      if (project()?.isHome && document.activeElement !== subs) subs.checked = false;
      list.textContent = '';
      list.append(el('li', 'chats-loading', 'Loading…'));
      try {
        chats = await api.chats.list(sel.value, subs.checked);
      } catch (e) {
        chats = [];
        list.textContent = '';
        list.append(el('li', 'chats-loading', errText(e)));
        return;
      }
      renderList();
      if (chats[0] && !chats.some((c) => c.id === openId)) show(chats[0].id);
      else if (!chats.length) { main.textContent = ''; main.append(el('div', 'chats-empty', 'No chats in this folder.')); }
    }

    function renderList() {
      const q = search.value.trim().toLowerCase();
      list.textContent = '';
      const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.first.toLowerCase().includes(q) || (c.branch || '').toLowerCase().includes(q));
      for (const c of shown) {
        const li = el('li', 'chats-item' + (c.id === openId ? ' active' : ''));
        li.dataset.id = c.id;
        li.append(el('div', 'chats-title', c.title));
        const meta = el('div', 'chats-meta');
        meta.append(el('span', '', ago(c.updated)));
        if (SOURCE[c.entrypoint]) meta.append(el('span', 'chats-src', SOURCE[c.entrypoint]));
        if (c.branch && c.branch !== 'HEAD') meta.append(el('span', 'chats-branch', c.branch));
        if (c.sub) meta.append(el('span', 'badge', c.sub));
        li.append(meta);
        li.title = c.first;
        li.addEventListener('click', () => show(c.id));
        list.append(li);
      }
      if (!shown.length) list.append(el('li', 'chats-loading', q ? 'No matching chats' : 'No chats'));
    }

    async function show(id) {
      openId = id;
      list.querySelectorAll('.chats-item').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
      main.textContent = '';
      main.append(el('div', 'chats-empty', 'Reading the chat…'));
      let chat;
      try {
        chat = await api.chats.read(sel.value, id);
      } catch (e) {
        main.textContent = '';
        main.append(el('div', 'chats-empty', errText(e)));
        return;
      }
      if (openId !== id) return;
      const { meta, items } = chat;
      main.textContent = '';
      const head = el('div', 'chats-chat-head');
      head.append(el('h3', '', meta.title));
      const asked = items.filter((i) => i.kind === 'user').length;
      const info = [
        new Date(meta.started).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        `${asked} message${asked === 1 ? '' : 's'} from you`,
        meta.branch && meta.branch !== 'HEAD' ? `branch ${meta.branch}` : '',
        meta.sub ? `in ${meta.sub}` : '',
        SOURCE[meta.entrypoint] ? `from ${SOURCE[meta.entrypoint]}` : '',
      ].filter(Boolean).join(' · ');
      head.append(el('div', 'chats-info', info));
      const acts = el('div', 'chats-actions');
      const cont = el('button', 'btn primary', 'Continue in Claude panel');
      cont.title = 'Pick up where this chat left off. Claude remembers everything; your messages go to a copy, so the original chat is unchanged.';
      const save = el('button', 'btn', 'Save as note');
      save.title = 'Save the conversation as a Markdown note (updates it if saved before)';
      const copy = el('button', 'btn', 'Copy Terminal command');
      copy.title = 'claude --resume, to continue it in Terminal';
      acts.append(cont, save, copy);
      head.append(acts);
      main.append(head);

      const log = el('div', 'chats-log');
      main.append(log);
      let at = 0;
      const sentinel = el('div', 'chats-more');
      const more = () => {
        const end = Math.min(items.length, at + CHUNK);
        let tools = [];
        const flush = () => {
          if (!tools.length) return;
          const d = el('details', 'chats-tools');
          d.append(el('summary', '', `🔧 ${tools.length} action${tools.length === 1 ? '' : 's'}: ${[...new Set(tools.map((t) => TOOL_VERB[t.name] || t.name.replace(/^mcp__[^_]+__/, '')))].slice(0, 5).join(', ')}`));
          const ul = el('ul');
          for (const t of tools) {
            const i = t.input || {};
            const what = i.file_path || i.description || i.command || i.pattern || i.url || i.query || '';
            ul.append(el('li', t.isError ? 'err' : '', `${TOOL_VERB[t.name] || t.name} ${String(what).split('\n')[0].slice(0, 140)}`));
          }
          d.append(ul);
          log.insertBefore(d, sentinel);
          tools = [];
        };
        for (; at < end; at++) {
          const it = items[at];
          if (it.kind === 'tool') { tools.push(it); continue; }
          flush();
          let node;
          if (it.kind === 'user') node = el('div', 'msg user', it.text);
          else if (it.kind === 'note') node = el('div', 'result-line', it.text);
          else {
            node = el('div', 'agent-md markdown');
            node.innerHTML = renderMarkdown(it.text);
            node.querySelectorAll('a[href]').forEach((a) => { if (!a.getAttribute('href').startsWith('#')) a.target = '_blank'; });
          }
          log.insertBefore(node, sentinel);
        }
        flush();
        if (at >= items.length) { sentinel.remove(); io.disconnect(); }
      };
      log.append(sentinel);
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { root: main, rootMargin: '600px' });
      more();
      io.observe(sentinel);
      if (!items.length) log.append(el('div', 'chats-empty', 'Nothing to show in this chat.'));

      cont.addEventListener('click', async () => {
        cont.disabled = true;
        try {
          let r = await api.chats.continue({ cwd: sel.value, id });
          if (r.needsNotebook) {
            const ok = confirm(`To continue this chat, VibeNote links a notebook to its folder:\n\n${sel.value}\n\nCreate the notebook “${r.name}” for it? (Claude works in that folder; your notes stay in the notebook.)`);
            if (!ok) { cont.disabled = false; return; }
            r = await api.chats.continue({ cwd: sel.value, id, createNotebook: r.name });
          }
          closeOverlay();
          await afterContinue(r.key);
          toast(`Continuing “${meta.title}” in the Claude panel`, 4000);
        } catch (e) {
          cont.disabled = false;
          toast(errText(e), 5000);
        }
      });
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          const r = await api.chats.export({ cwd: sel.value, id });
          closeOverlay();
          await afterExport(r.path);
          toast(r.updated ? 'Chat note updated' : 'Chat saved as a note', 3000);
        } catch (e) {
          save.disabled = false;
          toast(errText(e), 5000);
        }
      });
      copy.addEventListener('click', () => {
        const dir = meta.cwd || sel.value;
        navigator.clipboard.writeText(`cd ${JSON.stringify(dir)} && claude --resume ${meta.id}`);
        toast('Copied — paste it in Terminal to continue there', 3000);
      });
    }

    sel.addEventListener('change', () => { openId = null; loadList(); });
    subs.addEventListener('change', loadList);
    search.addEventListener('input', renderList);
    await loadList();
    search.focus();
  }

  return { open };
}
