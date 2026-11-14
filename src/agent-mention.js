// @ mentions in the Claude panel: type @ to pick a project, note, Confluence page, API spec or diagram. The message
// keeps a readable "@Name"; Claude also gets where each mentioned thing lives, so it can open it.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const ICON = { project: '◆', note: '📄', confluence: '☁', api: 'API', diagram: '◇' };
const KIND_ORDER = { project: 0, note: 1, confluence: 2, api: 3, diagram: 4 };

export function createMentions({ input, menuHost, getLinkables }) {
  const menu = el('div', 'slash-menu mention-menu');
  menu.hidden = true;
  menuHost.prepend(menu);
  let items = [];
  let sel = 0;
  let at = -1; // where the "@" is in the input
  const picked = new Map(); // "@Title" → item

  function query() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
    if (!m) return null;
    return { q: m[2].toLowerCase(), start: pos - m[2].length - 1 };
  }

  function render() {
    const hit = query();
    if (!hit) { close(); return; }
    at = hit.start;
    const all = getLinkables();
    items = all
      .filter((x) => !hit.q || x.title.toLowerCase().includes(hit.q))
      .sort((a, b) => Number(!a.title.toLowerCase().startsWith(hit.q)) - Number(!b.title.toLowerCase().startsWith(hit.q)) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title))
      .slice(0, 40);
    menu.textContent = '';
    if (!items.length) { menu.append(el('div', 'slash-empty', 'Nothing matches')); menu.hidden = false; return; }
    sel = Math.min(sel, items.length - 1);
    items.forEach((x, i) => {
      const row = el('div', 'slash-item' + (i === sel ? ' sel' : ''));
      row.append(el('span', `mention-ico k-${x.kind}`, ICON[x.kind] || '•'), el('span', 'slash-name mention-name', x.title), el('span', 'slash-desc', x.where || ''));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; accept(); });
      menu.append(row);
    });
    menu.hidden = false;
    menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function close() { menu.hidden = true; sel = 0; at = -1; }

  function accept() {
    const x = items[sel];
    if (!x || at < 0) return;
    const pos = input.selectionStart;
    const token = `@${x.title} `;
    input.value = input.value.slice(0, at) + token + input.value.slice(pos);
    const caret = at + token.length;
    input.setSelectionRange(caret, caret);
    picked.set(`@${x.title}`, x);
    close();
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function onKey(e) {
    if (menu.hidden || !items.length) return false;
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

  // Before sending: what the mentions point at, for Claude (only mentions still in the text).
  function contextFor(text) {
    const used = [...picked].filter(([token]) => text.includes(token)).map(([, x]) => x);
    picked.clear();
    if (!used.length) return '';
    const line = (x) => {
      if (x.kind === 'project') return `- Project "${x.title}": its notes are in ${x.path}${x.repo ? `; its code is in ${x.repo}` : ''}.`;
      if (x.kind === 'diagram') return `- Diagram "${x.title}" (draw.io XML): ${x.path}`;
      return `- ${x.kind === 'confluence' ? 'Confluence page (as a note)' : x.kind === 'api' ? 'API spec (OpenAPI)' : 'Note'} "${x.title}": ${x.path}`;
    };
    return `<vibenote-mentions>\nThe user mentioned these with @ — read them if the request depends on them:\n${used.map(line).join('\n')}\n</vibenote-mentions>\n\n`;
  }

  return { onKey, onInput: render, close, contextFor };
}
