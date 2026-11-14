// Confluence ⇄ Markdown for Confluence sync (spec: docs/confluence-spec.md).
//
// Fetch: Confluence HTML (Atlassian MCP "html" format) → a Markdown note, plus the page's top-level blocks
// ({ md, html } each) which are saved in a sidecar file so Push can tell exactly what the user changed.
// Push: rebuild the page body. Blocks whose Markdown is unchanged go back as their original HTML, byte for
// byte; only changed or new text is converted from Markdown. Things Markdown can't hold (diagrams, macros,
// images, layouts, merged-cell tables) become ```confluence boxes that always go back unchanged — even if
// the box is moved or its label edited.
import { Marked } from 'marked';

// ---------- Confluence HTML → Markdown ----------

const PANEL_TO_CALLOUT = { info: 'NOTE', note: 'IMPORTANT', success: 'TIP', warning: 'WARNING', error: 'CAUTION' };
const CALLOUT_TO_PANEL = { NOTE: 'info', IMPORTANT: 'note', TIP: 'success', WARNING: 'warning', CAUTION: 'error' };
const BLOCK_TAGS = new Set(['P', 'UL', 'OL', 'PRE', 'TABLE', 'BLOCKQUOTE', 'DIV', 'FIGURE', 'SECTION', 'DETAILS', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// People @mentioned on the page being converted: display name → Atlassian account id. Notes show a short
// [@Name](mention) link; the id is kept in the sidecar and put back on push.
let people = {};

const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Escape text so Markdown (and VibeNote's extras: $math$, ==highlight==, [[links]]) shows it literally.
function escText(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([`*~$\[\]])/g, '\\$1')
    .replace(/==/g, '=\\=')
    .replace(/<(?=[A-Za-z\/!?])/g, '&lt;')
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'));
}
// Text at the start of a block line that Markdown would read as a list, heading, quote or rule.
const escLineStart = (s) => s.replace(/^(\s*)([#>+\-=]|\d+[.)])(?=\s|$)/, '$1\\$2');

// **x** / *x* / ~~x~~ — emphasis markers can't touch whitespace, so move it outside. Markdown also won't
// read a marker that sits between a letter and punctuation ("word**: x**") as bold; then use the HTML tag.
// before/after: the characters just outside, to apply Markdown's rule exactly.
const HTML_MARK = { '**': 'strong', '*': 'em', '~~': 's' };
function wrap(mark, s, before = '', after = '') {
  if (!s.trim()) return s;
  const [, lead, mid, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = mid.replace(/^[*~]+/, '').replace(/(?<!\\)[*~]+$/, '').replace(/\\(.)/g, '$1');
  const P = /[\p{P}\p{S}]/u;
  const free = (c) => !c || /\s/.test(c) || P.test(c);
  const b = lead ? ' ' : before, a = trail ? ' ' : after;
  const ok = (!P.test(core[0] || '') || free(b)) && (!P.test(core[core.length - 1] || '') || free(a));
  if (!ok) return `${lead}<${HTML_MARK[mark]}>${mid}</${HTML_MARK[mark]}>${trail}`;
  return `${lead}${mark}${mid}${mark}${trail}`;
}
// Two bold runs side by side ("**a****b**") → one ("**ab**").
const mergeRuns = (s) => s.replace(/<\/(strong|em|s)><\1>/g, '').replace(/(?<=[^\s*\\])(\*\*\*\*|~~~~)(?=[^\s*~])/g, '');

function codeSpan(text) {
  const runs = text.match(/`+/g) || [];
  const ticks = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = /^`|`$/.test(text) || /^ .* $/.test(text) ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

// The element's opening tag as raw HTML (without Confluence's local id, which isn't needed for new content).
function openTag(el) {
  const attrs = [...el.attributes].filter((a) => a.name !== 'data-local-id').map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${attrEsc(a.value)}"`));
  return `<${el.tagName.toLowerCase()}${attrs.join('')}>`;
}

function inline(node) {
  let out = '';
  for (const c of node.childNodes) {
    const before = out.slice(-1);
    const after = (c.nextSibling?.textContent || '').charAt(0);
    if (c.nodeType === 3) { out += escText(c.textContent.replace(/[\t\n\r ]+/g, ' ')); continue; }
    if (c.nodeType !== 1) continue;
    const t = c.tagName.toLowerCase();
    const type = c.getAttribute('data-type') || '';
    if (t === 'strong' || t === 'b') out += wrap('**', inline(c), before, after);
    else if (t === 'em' || t === 'i') out += wrap('*', inline(c), before, after);
    else if (t === 's' || t === 'del') out += wrap('~~', inline(c), before, after);
    else if (t === 'code') out += codeSpan(c.textContent);
    else if (t === 'br') out += '<br>';
    else if (t === 'input') continue;
    else if (t === 'p') out += (out.trim() ? '<br>' : '') + inline(c);
    else if (t === 'a') out += link(c);
    else if (t === 'img') out += `![${escText(c.getAttribute('alt') || '')}](<${c.getAttribute('src') || ''}>)`;
    else if (type === 'mention') {
      const name = c.textContent.replace(/^@/, '').trim();
      people[name] = c.getAttribute('data-user-id');
      out += `[@${escText(name)}](mention)`;
    }
    else if (type === 'emoji' && c.getAttribute('data-emoji-text') && !/^:atlassian/.test(c.getAttribute('data-shortname') || '')) out += c.getAttribute('data-emoji-text');
    else out += openTag(c) + inline(c) + `</${t}>`; // dates, status lozenges, colours, underline, inline comments…
  }
  return mergeRuns(out);
}

function link(a) {
  const href = a.getAttribute('href') || '';
  const text = inline(a);
  const card = a.getAttribute('data-card-appearance');
  if (card && card !== 'inline') return openTag(a) + text + '</a>';
  // Smart links and bare URLs → <url> (pushed back as inline smart links).
  if (/^https?:\/\//.test(href) && (!text.trim() || a.textContent.trim() === href)) return `<${href}>`;
  const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
  return `[${text}](${dest})`;
}

// Label for a ```confluence box: what the protected element is, so the note reads sensibly.
function keptLabel(el) {
  const type = el.getAttribute('data-type') || el.tagName.toLowerCase();
  if (/extension/.test(type)) {
    let p = {};
    try { p = JSON.parse(el.getAttribute('data-parameters') || '{}'); } catch {}
    const title = p.extensionTitle || p.macroMetadata?.title || el.getAttribute('data-extension-key') || 'Macro';
    const detail = p.guestParams?.diagramDisplayName || p.macroParams?.url?.value || '';
    return detail ? `${title}: ${detail}` : title;
  }
  if (type === 'media-single') {
    const alt = el.querySelector('[data-alt]')?.getAttribute('data-alt');
    const cap = el.querySelector('figcaption')?.textContent.trim();
    return `Image${alt ? `: ${alt}` : ''}${cap ? ` (${cap})` : ''}`;
  }
  if (type === 'media-group') return 'Attached files';
  if (type.startsWith('layout')) return `Layout (${el.querySelectorAll(':scope > [data-type="column"]').length} columns)`;
  if (type === 'table') return 'Table with merged cells or rich content';
  if (type.startsWith('panel')) return 'Custom panel';
  return `Confluence ${type}`;
}

class Converter {
  constructor() {
    this.kept = {}; // n → original HTML of protected elements
    this.n = 0;
  }

  keep(el) {
    const n = ++this.n;
    this.kept[n] = el.outerHTML;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const extra = /extension|media|layout/.test(el.getAttribute('data-type') || '') || !text ? '' : `\n${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`;
    return '```confluence\n' + `#${n} ${keptLabel(el)} · kept in Confluence${extra.replace(/`/g, "'")}` + '\n```';
  }

  block(el, indent = '') {
    if (el.nodeType === 3) return el.textContent.trim() ? escLineStart(escText(el.textContent.trim())) : '';
    if (el.nodeType !== 1) return '';
    const tag = el.tagName;
    const type = el.getAttribute('data-type') || '';
    if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(+tag[1])} ${inline(el).replace(/<br>/g, ' ').trim()}`;
    switch (tag) {
      case 'P': return escLineStart(inline(el).trim());
      case 'HR': return '---';
      case 'PRE': return this.code(el);
      case 'UL':
        if (type === 'task-list') return this.tasks(el, indent);
        if (!type) return this.list(el, indent, false);
        break;
      case 'OL': return this.list(el, indent, true);
      case 'TABLE': return this.table(el) ?? this.keep(el);
      case 'BLOCKQUOTE': {
        const inner = this.blocks(el);
        return inner === null ? this.keep(el) : inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
      }
      case 'DIV': {
        const m = /^panel-(\w+)$/.exec(type);
        if (m && PANEL_TO_CALLOUT[m[1]]) {
          const inner = this.blocks(el);
          if (inner !== null) return [`> [!${PANEL_TO_CALLOUT[m[1]]}]`, ...inner.split('\n').map((l) => (l ? `> ${l}` : '>'))].join('\n');
        }
        break;
      }
      case 'DETAILS': {
        if (type) break;
        const summary = el.querySelector(':scope > summary');
        const rest = [...el.childNodes].filter((c) => c !== summary);
        const inner = this.blocks({ childNodes: rest });
        if (inner !== null) return `<details><summary>${summary ? inline(summary).trim() : ''}</summary>\n\n${inner}\n\n</details>`;
        break;
      }
    }
    return this.keep(el);
  }

  // Child blocks joined by blank lines; null if something inside can't be shown (caller keeps the whole thing).
  blocks(el) {
    const parts = [];
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && !['P', 'UL', 'OL', 'PRE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'BLOCKQUOTE'].includes(c.tagName)) return null;
      const md = this.block(c);
      if (md) parts.push(md);
    }
    return parts.join('\n\n');
  }

  code(pre) {
    const code = pre.querySelector('code') || pre;
    const lang = (/language-([\w+#.-]+)/.exec(code.className || '') || [])[1] || '';
    const text = code.textContent.replace(/\n$/, '');
    const runs = text.match(/^`{3,}/gm) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  list(el, indent, ordered) {
    let i = +(el.getAttribute('start') || 1);
    const out = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? `${i++}. ` : '- ';
      out.push(this.item(li, indent, marker));
    }
    return out.join('\n');
  }

  item(li, indent, marker) {
    const pad = indent + ' '.repeat(marker.length);
    let text = '';
    const after = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) after.push(this.block(c, pad));
      else if (c.nodeType === 1 && c.tagName === 'P') text += (text.trim() ? '<br>' : '') + inline(c).trim();
      else if (c.nodeType === 1 && BLOCK_TAGS.has(c.tagName)) after.push(this.block(c, pad).split('\n').map((l) => (l ? pad + l : l)).join('\n'));
      else text += c.nodeType === 3 ? escText(c.textContent.replace(/\s+/g, ' ')) : inline({ childNodes: [c] });
    }
    return [`${indent}${marker}${escLineStart(text.trim())}`, ...after].join('\n');
  }

  tasks(el, indent) {
    const out = [];
    for (const c of el.children) {
      if (c.tagName === 'UL' || c.tagName === 'OL') { out.push(this.block(c, indent + '  ')); continue; }
      if (c.tagName !== 'LI') continue;
      const box = c.querySelector('input[type=checkbox]');
      const done = box?.hasAttribute('checked') || c.getAttribute('data-state') === 'DONE';
      const nested = [...c.children].filter((x) => x.tagName === 'UL' || x.tagName === 'OL');
      const text = inline({ childNodes: [...c.childNodes].filter((x) => !nested.includes(x)) });
      out.push(`${indent}- [${done ? 'x' : ' '}] ${text.trim()}`, ...nested.map((x) => this.block(x, indent + '  ')));
    }
    return out.join('\n');
  }

  // GFM table, or null when it can't be one (merged cells, or blocks other than text/lists in a cell).
  table(el) {
    const rows = [...el.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')];
    if (!rows.length) return null;
    const grid = [];
    for (const tr of rows) {
      const cells = [];
      for (const cell of tr.children) {
        if (+(cell.getAttribute('rowspan') || 1) > 1 || +(cell.getAttribute('colspan') || 1) > 1) return null;
        const md = this.cell(cell);
        if (md === null) return null;
        cells.push(md);
      }
      grid.push(cells);
    }
    const cols = Math.max(...grid.map((r) => r.length));
    const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => cells[i] || ' ').join(' | ')} |`;
    return [line(grid[0]), line(Array(cols).fill('---')), ...grid.slice(1).map(line)].join('\n');
  }

  cell(cell) {
    const parts = [];
    for (const c of cell.childNodes) {
      if (c.nodeType === 3) { if (c.textContent.trim()) parts.push(escText(c.textContent.trim())); continue; }
      if (c.nodeType !== 1) continue;
      if (c.tagName === 'P') parts.push(inline(c).trim());
      else if ((c.tagName === 'UL' || c.tagName === 'OL') && !c.getAttribute('data-type')) {
        const html = this.cellList(c);
        if (html === null) return null;
        parts.push(html);
      } else return null;
    }
    // Lists stay as one-line HTML inside the cell (renders in the preview, round-trips exactly).
    return parts.join('<br>').replace(/<br>(<[uo]l)/g, '$1').replace(/(<\/[uo]l>)<br>/g, '$1').replace(/\|/g, '\\|');
  }

  cellList(el) {
    let out = el.tagName === 'OL' && el.getAttribute('start') ? `<ol start="${attrEsc(el.getAttribute('start'))}">` : `<${el.tagName.toLowerCase()}>`;
    for (const li of el.children) {
      let text = '';
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
          const sub = this.cellList(c);
          if (sub === null) return null;
          text += sub;
        } else if (c.nodeType === 1 && c.tagName === 'P') text += (text && !text.endsWith('>') ? '<br>' : '') + inline(c).trim();
        else if (c.nodeType === 1 && BLOCK_TAGS.has(c.tagName)) return null;
        else text += c.nodeType === 3 ? escText(c.textContent.replace(/\s+/g, ' ')) : inline({ childNodes: [c] });
      }
      out += `<li>${text.trim()}</li>`;
    }
    return out + `</${el.tagName.toLowerCase()}>`;
  }
}

/**
 * Confluence page HTML → { markdown, blocks, kept }.
 * blocks: one entry per top-level element, { md, html } (md may be '' for empty paragraphs).
 * kept: { n: html } of protected elements, referenced by ```confluence boxes as "#n".
 */
export function fromConfluence(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const conv = new Converter();
  people = {};
  const blocks = [];
  for (const node of doc.body.childNodes) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue;
    if (node.nodeType !== 1 && node.nodeType !== 3) continue;
    const md = conv.block(node).replace(/\s+$/, '');
    blocks.push({ md, html: node.nodeType === 1 ? node.outerHTML : attrEsc(node.textContent) });
  }
  const markdown = blocks.map((b) => b.md).filter(Boolean).join('\n\n') + '\n';
  return { markdown, blocks, kept: conv.kept, people: { ...people } };
}

// ---------- Markdown → Confluence HTML (Push) ----------

const md = new Marked({ gfm: true });
md.use({
  renderer: {
    code({ text, lang }) {
      if ((lang || '').trim() === 'confluence') {
        const n = /^#(\d+)/.exec(text.trim());
        return n ? `<vibe-kept data-n="${n[1]}"></vibe-kept>` : '';
      }
      return false; // default rendering
    },
  },
});

// Longest common subsequence of two string arrays → for each a[i], the matched index in b (or -1).
// The unchanged start and end are matched directly, so long pages with a local edit stay cheap.
function lcs(a, b) {
  const match = new Array(a.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) { match[head] = head; head++; }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    match[a.length - 1 - tail] = b.length - 1 - tail;
    tail++;
  }
  const A = a.slice(head, a.length - tail), B = b.slice(head, b.length - tail);
  const n = A.length, m = B.length;
  if (!n || !m) return match;
  if (n * m > 20e6) return match; // huge rewrite: treat the middle as all changed
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (A[i] === B[j]) { match[head + i] = head + j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return match;
}

function copyMissingAttrs(from, to) {
  for (const a of from.attributes) if (!to.hasAttribute(a.name)) to.setAttribute(a.name, a.value);
}

// Bring back table settings Markdown can't hold: layout, widths, row numbers, column widths, td-only first row.
function restoreTable(orig, table, doc) {
  copyMissingAttrs(orig, table);
  const origRows = [...orig.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr')];
  const rows = [...table.querySelectorAll('tr')];
  const origCols = origRows[0]?.children.length;
  if (origCols && rows[0]?.children.length === origCols) {
    const widths = [...origRows[0].children].map((c) => c.getAttribute('data-colwidth'));
    for (const tr of rows) [...tr.children].forEach((c, i) => { if (widths[i] && !c.hasAttribute('data-colwidth')) c.setAttribute('data-colwidth', widths[i]); });
  }
  const origHeader = origRows[0] && [...origRows[0].children].some((c) => c.tagName === 'TH');
  if (!origHeader && rows[0]) {
    // Markdown always has a header row; the original didn't, so turn it back into an ordinary row.
    const tr = rows[0];
    for (const th of [...tr.children]) {
      const td = doc.createElement('td');
      for (const a of th.attributes) td.setAttribute(a.name, a.value);
      td.append(...th.childNodes);
      th.replaceWith(td);
    }
    const tbody = table.querySelector('tbody') || table.appendChild(doc.createElement('tbody'));
    tbody.prepend(tr);
    table.querySelector('thead')?.remove();
  }
}

// Markdown (a changed region of the note) → Confluence HTML.
function convertRegion(text, side, replaced, opts = {}) {
  // [[Title]] / [[Title#Heading|text]] → a link to the Confluence page when it is one, otherwise just the words.
  text = text.replace(/\[\[([^\n|]+?)(?:\|([^\n]+?))?\]\](?!\])/g, (_m, target, alias) => {
    const label = (alias || target.replace(/\s*#\s*/, ' › ')).trim().replace(/[[\]]/g, '');
    const url = opts.resolveLink?.(target.trim());
    return url ? `[${label}](<${url}>)` : label;
  });
  const html = md.parse(text);
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const body = doc.body;
  const problems = [];

  for (const k of body.querySelectorAll('vibe-kept')) {
    const orig = side.kept?.[k.getAttribute('data-n')];
    if (!orig) { k.remove(); continue; }
    const t = doc.createElement('template');
    t.innerHTML = orig;
    // A kept block inside a <p> (shouldn't happen from fences) — lift it out.
    k.replaceWith(t.content);
  }
  // > [!NOTE] … → panel
  for (const bq of body.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    const m = p?.tagName === 'P' && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent);
    if (!m) continue;
    const first = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    if (first) first.textContent = first.textContent.replace(/^\s*\[![a-z]+\]\s*/i, '');
    if (p.firstChild?.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent.trim() && !p.querySelector('img,span,time')) p.remove();
    const panel = doc.createElement('div');
    panel.setAttribute('data-type', `panel-${CALLOUT_TO_PANEL[m[1].toUpperCase()]}`);
    panel.append(...bq.childNodes);
    bq.replaceWith(panel);
  }
  // A plain list as lines for inside a to-do item: <br>• text, nested ones indented.
  function flattenList(doc, list, depth) {
    const out = [];
    let i = 0;
    for (const li of [...list.children].filter((x) => x.tagName === 'LI')) {
      i++;
      const bullet = list.tagName === 'OL' ? `${i}. ` : depth ? '◦ ' : '• ';
      out.push(doc.createElement('br'), doc.createTextNode('\u00a0\u00a0'.repeat(depth) + bullet));
      const nested = [];
      for (const c of [...li.childNodes]) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else if (c.nodeType === 1 && c.tagName === 'P') out.push(...c.childNodes);
        else if (!(c.nodeType === 1 && c.tagName === 'INPUT')) out.push(c);
      }
      for (const n of nested) out.push(...flattenList(doc, n, depth + 1));
    }
    return out;
  }
  // - [ ] tasks → Confluence task lists
  for (const ul of [...body.querySelectorAll('ul')].reverse()) {
    const items = [...ul.children].filter((li) => li.tagName === 'LI');
    const isTask = (li) => (li.firstElementChild?.tagName === 'INPUT' ? li.firstElementChild : li.firstElementChild?.tagName === 'P' && li.firstElementChild.firstElementChild?.tagName === 'INPUT' ? li.firstElementChild.firstElementChild : null);
    if (!items.length || !items.every(isTask)) continue;
    ul.setAttribute('data-type', 'task-list');
    for (const li of items) {
      const box = isTask(li);
      const p = li.firstElementChild.tagName === 'P' ? li.firstElementChild : null;
      if (p) { p.replaceWith(...p.childNodes); }
      li.setAttribute('data-type', 'task-item');
      box.removeAttribute('disabled');
      // Nested to-do lists go after the item, inside the parent task list (Confluence's nesting rule). A to-do item
      // can't hold an ordinary list, so plain sub-bullets become extra lines in the item ("• Dev: …").
      for (const sub of [...li.querySelectorAll(':scope > ul, :scope > ol')].reverse()) {
        if (sub.getAttribute('data-type') === 'task-list') li.after(sub);
        else { li.append(...flattenList(doc, sub, 0)); sub.remove(); }
      }
      if (box.nextSibling?.nodeType === 3) box.nextSibling.textContent = ' ' + box.nextSibling.textContent.replace(/^\s+/, '');
    }
  }
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href === 'mention' || href.startsWith('mention:')) {
      const name = a.textContent.replace(/^@/, '').trim();
      const id = href.slice(8) || side.people?.[name];
      if (!id) { a.replaceWith(doc.createTextNode('@' + name)); continue; } // unknown person → plain text, never a made-up id
      const s = doc.createElement('span');
      s.setAttribute('data-type', 'mention');
      s.setAttribute('data-user-id', id);
      s.textContent = '@' + name;
      a.replaceWith(s);
    } else if (/^https?:\/\//.test(href) && a.textContent.trim() === href) {
      a.setAttribute('data-card-appearance', 'inline');
    }
  }
  for (const img of body.querySelectorAll('img')) {
    if (/^https?:\/\//.test(img.getAttribute('src') || '')) continue;
    problems.push(`Image “${img.getAttribute('alt') || img.getAttribute('src')}” is only on this Mac and can't be uploaded yet — it was left out.`);
    img.remove();
  }
  for (const c of body.querySelectorAll('th[align], td[align]')) c.removeAttribute('align');
  // Drop the layout whitespace marked puts between tags (not inside text or code).
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const blank = [];
  for (let t; (t = walker.nextNode());) {
    if (!t.textContent.trim() && /^(BODY|UL|OL|LI|TABLE|THEAD|TBODY|TR|BLOCKQUOTE|DIV|DETAILS)$/.test(t.parentNode.nodeName)) blank.push(t);
  }
  blank.forEach((t) => t.remove());

  // Keep the replaced blocks' settings (ids, widths, layout…) on their edited versions, matched by kind and order.
  const pool = replaced.map((h) => {
    const t = doc.createElement('template');
    t.innerHTML = h;
    return t.content.firstElementChild;
  }).filter(Boolean);
  for (const el of body.children) {
    const kind = (e) => e.tagName + ':' + (e.getAttribute('data-type') || '');
    const i = pool.findIndex((o) => kind(o) === kind(el));
    if (i < 0) continue;
    const [orig] = pool.splice(0, i + 1).slice(-1);
    if (el.tagName === 'TABLE') restoreTable(orig, el, doc);
    else if (el.tagName !== 'PRE' || orig.querySelector('code')?.className === el.querySelector('code')?.className) copyMissingAttrs(orig, el);
    else for (const a of orig.attributes) if (a.name.startsWith('data-breakout') && !el.hasAttribute(a.name)) el.setAttribute(a.name, a.value);
  }
  return { html: body.innerHTML, problems };
}

/**
 * Rebuild the Confluence page body from the edited note.
 * side: the sidecar saved at fetch time ({ blocks: [{md, html}], kept }).
 * Returns { html, kept, changed, added, removed, problems, unchanged }.
 */
export function toConfluence(markdown, side, opts = {}) {
  const blocks = side.blocks.map((b, bi) => ({ ...b, bi, olds: [], kept: false }));
  const oldLines = [];
  blocks.forEach((b) => b.md.split('\n').forEach((l) => { if (l.trim()) { b.olds.push(oldLines.length); oldLines.push(l.trimEnd()); } }));
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const newIdx = []; // raw line index of each non-blank line
  lines.forEach((l, i) => { if (l.trim()) newIdx.push(i); });
  const match = lcs(oldLines, newIdx.map((i) => lines[i].trimEnd()));

  for (const b of blocks) {
    const ns = b.olds.map((oi) => match[oi]);
    b.kept = ns.length > 0 && ns.every((n, k) => n >= 0 && (k === 0 || n === ns[k - 1] + 1));
    if (b.kept) { b.start = newIdx[ns[0]]; b.end = newIdx[ns[ns.length - 1]]; }
  }
  // Text typed right against a kept block (no blank line) belongs to it — e.g. a new list item — so the block counts as changed.
  for (let again = true; again;) {
    again = false;
    const keptNow = blocks.filter((b) => b.kept);
    const owned = (i) => keptNow.some((k) => i >= k.start && i <= k.end);
    for (const b of keptNow) {
      const touches = (i) => i >= 0 && i < lines.length && lines[i].trim() && !owned(i);
      if (touches(b.start - 1) || touches(b.end + 1)) { b.kept = false; again = true; }
    }
  }

  const out = [];
  const problems = [];
  let pos = 0;
  let prev = -1;
  let added = 0;
  const fresh = (from, to, nextBi) => {
    const text = lines.slice(from, to).join('\n');
    const between = blocks.slice(prev + 1, nextBi);
    if (!text.trim()) {
      // Nothing new here: keep empty paragraphs that sat between two kept blocks.
      for (const b of between) if (!b.md.trim()) out.push(b.html);
      return;
    }
    const r = convertRegion(text, side, between.filter((b) => b.md.trim()).map((b) => b.html), opts);
    out.push(r.html);
    problems.push(...r.problems);
    added++;
  };
  for (const b of blocks.filter((x) => x.kept)) {
    fresh(pos, b.start, b.bi);
    out.push(b.html);
    pos = b.end + 1;
    prev = b.bi;
  }
  fresh(pos, lines.length, blocks.length);

  const content = blocks.filter((b) => b.md.trim());
  const keptCount = content.filter((b) => b.kept).length;
  return {
    html: out.join(''),
    unchanged: keptCount === content.length && added === 0,
    kept: keptCount,
    replaced: content.length - keptCount,
    added,
    problems,
  };
}

// ---------- front matter helpers (sync info lives in the note's front matter "extra" lines) ----------

/** { url, id, site, version } from a note's meta.extra, or null if it isn't a Confluence note. */
export function confluenceInfo(meta) {
  const extra = meta?.extra || '';
  const url = /^confluence:\s*(\S+)\s*$/m.exec(extra)?.[1];
  if (!url) return null;
  const id = /\/(?:pages|folder|whiteboard|database)\/(\d+)/.exec(url)?.[1] || /[?&]pageId=(\d+)/.exec(url)?.[1];
  let site = '';
  try { site = new URL(url).host; } catch {}
  const version = +(/^confluence-version:\s*(\d+)/m.exec(extra)?.[1] || 0);
  const kind = /^confluence-type:\s*(\w+)/m.exec(extra)?.[1] || 'page';
  return id && site ? { url, id, site, version, kind } : null;
}

/** meta.extra with the Confluence lines replaced (other unknown keys are kept as they were). */
export function withConfluenceInfo(extra, { url, version, kind }) {
  const rest = (extra || '').split('\n').filter((l) => l.trim() && !/^confluence(-version|-type)?:/.test(l)).join('\n');
  const lines = [`confluence: ${url}`];
  if (version) lines.push(`confluence-version: ${version}`);
  if (kind && kind !== 'page') lines.push(`confluence-type: ${kind}`);
  return [lines.join('\n'), rest].filter(Boolean).join('\n');
}
