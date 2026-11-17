// Reading desk: save web pages into the notes, highlight while reading, and see every highlight in one place.
// - Save Web Page: an article becomes a Markdown note (Mozilla Readability picks the article out of the page, in an
//   inert DOMParser document, so none of the page's scripts run; Turndown turns it into Markdown). A link to a PDF is
//   saved as the .pdf file itself.
// - Highlight from the preview: select text in the preview → "Highlight" pill → the matching text in the note gets
//   ==…== (one highlight per line, since ==…== can't cross lines). Inside a highlight the pill removes it.
// - Highlights: ⌘K → Highlights lists every ==highlight== in every note, with a filter; click one to go there.
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

const READING_NOTEBOOK = 'Reading';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What Markdown may put between two words that read as "word word" in the preview.
const GAP = String.raw`(?:[\s*_~\`>#|:-]|\\|==|!\[[^\]\n]*\]\([^)\s]*\)|\]\([^)\s]*\)|\]|\[|<br\s*\/?>|<\/?su[bp]>|\d+[.)](?=\s)|\$+)+`;
const HL_RE = /==(?=\S)((?:[^=\n]|=(?!=))*?\S)==/g;

// ---------- article → Markdown ----------
function toMarkdown(html, formulas = []) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea']);
  td.keep(['sup', 'sub']);
  // Pictures without an address (lazy-loaded placeholders) are dropped; the rest keep their full web address.
  td.addRule('img', {
    filter: 'img',
    replacement: (_c, node) => {
      const src = node.getAttribute('src') || '';
      if (!/^https?:/i.test(src)) return '';
      const alt = (node.getAttribute('alt') || '').replace(/[[\]\n]/g, ' ').trim();
      return `![${alt}](${src.replace(/\)/g, '%29')})`;
    },
  });
  return td.turndown(html)
    .replace(/VNTEX(\d+)X/g, (_m, i) => formulas[Number(i)] ?? '')
    .replace(/\u2060/g, '') // word joiners around Wikipedia formulas
    .replace(/^(\s*)([-*+]|\d+\.)\s{2,}/gm, '$1$2 ') // "-   item" → "- item"
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[\[/g, '\\[\\[') // not VibeNote links
    .trim();
}

// "Variance explained | Stats Blog" → "Variance explained": drop the site's name, or use the page's own heading.
export function cleanTitle(title, site = '', h1 = '') {
  const t = String(title).replace(/\s+/g, ' ').trim();
  const head = String(h1 || '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/\s+[|–—·•:-]\s+/);
  if (parts.length < 2) return t;
  const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (head && parts.some((p) => norm(p) === norm(head))) return head;
  const kept = parts.filter((p) => !site || norm(p) !== norm(site));
  return (kept.length && kept.length < parts.length ? kept.join(' – ') : t).trim();
}

function texOf(node) {
  const ann = node.querySelector?.('annotation[encoding="application/x-tex"]');
  // Wikipedia today: <math data-mw='{"body":{"extsrc":"\\sigma^2"}}'>
  let mw = '';
  try { mw = JSON.parse(node.getAttribute?.('data-mw') || node.querySelector?.('math[data-mw]')?.getAttribute('data-mw') || '{}')?.body?.extsrc || ''; } catch {}
  let tex = ann?.textContent || mw || node.getAttribute?.('alttext') || node.querySelector?.('math')?.getAttribute('alttext')
    || node.querySelector?.('img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display')?.getAttribute('alt') || '';
  tex = tex.trim();
  const m = /^\{\\displaystyle\s*([\s\S]*)\}$/.exec(tex); // Wikipedia wraps formulas in {\displaystyle …}
  if (m) tex = m[1].trim();
  return tex.replace(/\s*\n\s*/g, ' ');
}

export function extractArticle(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: scripts never run
  const base = doc.createElement('base');
  base.href = url;
  doc.head.prepend(base);
  // Lazy-loaded pictures keep their real address in data-src / srcset.
  for (const img of doc.querySelectorAll('img')) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
    if (lazy && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) img.setAttribute('src', lazy);
  }
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || '';
  // Page furniture Readability sometimes keeps: Wikipedia's [edit] links, "jump to" links.
  doc.querySelectorAll('.mw-editsection, .mw-jump-link, sup.reference').forEach((x) => x.remove());
  // Formulas: pages keep the original LaTeX next to the drawn formula (MathML alttext / <annotation>, KaTeX,
  // Wikipedia's fallback picture). Swap each formula for a placeholder before Readability (which drops the
  // markers), and put it back as $…$ (VibeNote shows it with KaTeX) after the Markdown is made.
  const formulas = [];
  const outer = [...doc.querySelectorAll('.mwe-math-element, .katex-display, .katex, math, script[type^="math/tex"]')]
    .filter((x, _i, all) => !all.some((o) => o !== x && o.contains(x)));
  for (const node of outer) {
    const tex = node.nodeName === 'SCRIPT' ? node.textContent.trim() : texOf(node);
    if (!tex) continue;
    const block = /mode=display/.test(node.getAttribute('type') || '') || node.classList?.contains('katex-display')
      || node.getAttribute?.('display') === 'block' || node.classList?.contains('mwe-math-element-block')
      || !!node.querySelector?.('math[display="block"], img.mwe-math-fallback-image-display');
    formulas.push(block ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`);
    node.replaceWith(doc.createTextNode(`VNTEX${formulas.length - 1}X`));
  }
  // MathJax 2 leaves its drawn copy next to the script; leave it out.
  doc.querySelectorAll('.MathJax, .MathJax_Display, .MathJax_Preview, mjx-container').forEach((x) => x.remove());
  const art = new Readability(doc.cloneNode(true), { keepClasses: false }).parse();
  const content = art?.content || doc.body?.innerHTML || '';
  // Make links and pictures absolute against the page address.
  const holder = new DOMParser().parseFromString(`<base href="${url.replace(/"/g, '%22')}"><div id="x">${content}</div>`, 'text/html');
  for (const a of holder.querySelectorAll('a[href]')) { try { a.setAttribute('href', new URL(a.getAttribute('href'), url).href); } catch {} }
  for (const i of holder.querySelectorAll('img[src]')) { try { i.setAttribute('src', new URL(i.getAttribute('src'), url).href); } catch {} }
  const site = art?.siteName || meta('meta[property="og:site_name"]') || new URL(url).hostname.replace(/^www\./, '');
  const title = cleanTitle(art?.title || meta('meta[property="og:title"]') || doc.title || new URL(url).hostname, site, doc.querySelector('h1')?.textContent);
  return {
    title,
    site,
    author: art?.byline || meta('meta[name="author"]') || '',
    published: (art?.publishedTime || meta('meta[property="article:published_time"]') || '').slice(0, 10),
    excerpt: art?.excerpt || '',
    markdown: toMarkdown(holder.getElementById('x').innerHTML, formulas),
  };
}

// ---------- preview text ↔ note text ----------
// Find the selected preview text in the note's Markdown. Words may be separated by Markdown (links, **bold**, list
// marks…). When the text appears more than once, take the occurrence at about the same place in the note.
function nearest(src, words, ratio) {
  let re;
  try { re = new RegExp(words.join(GAP), 'g'); } catch { return null; }
  let best = null;
  for (const m of src.matchAll(re)) {
    const r = m.index / Math.max(1, src.length);
    if (!best || Math.abs(r - ratio) < Math.abs(best.r - ratio)) best = { from: m.index, to: m.index + m[0].length, r };
    if (m[0].length === 0) break;
  }
  return best;
}
export function findInSource(src, text, ratio = 0) {
  const words = text.trim().split(/\s+/).filter(Boolean).map(escRe);
  if (!words.length) return null;
  const whole = nearest(src, words, ratio);
  if (whole || words.length < 8) return whole;
  // Something in between doesn't read the same in the note (a formula, a picture…): match the first and the last
  // few words, and take everything between them.
  const head = nearest(src, words.slice(0, 4), ratio);
  if (!head) return null;
  let tre;
  try { tre = new RegExp(words.slice(-4).join(GAP), 'g'); } catch { return null; }
  tre.lastIndex = head.to;
  const tail = tre.exec(src);
  if (!tail || tail.index - head.to > text.length * 2 + 400) return null;
  return { from: head.from, to: tail.index + tail[0].length, r: head.r };
}

// Widen [from, to] so it doesn't cut **bold**, ~~strike~~, `code` or a [link](…) in half.
function balance(src, from, to) {
  const count = (s, mk) => s.split(mk).length - 1;
  for (let round = 0; round < 6; round++) {
    const seg = src.slice(from, to);
    let moved = false;
    for (const mk of ['**', '~~', '`']) {
      const n = mk === '`' ? count(seg.replace(/```/g, ''), '`') : count(seg, mk);
      if (n % 2 === 0) continue;
      if (src.startsWith(mk, to)) to += mk.length;
      else if (src.slice(from - mk.length, from) === mk) from -= mk.length;
      else continue;
      moved = true;
      break;
    }
    if (moved) continue;
    const single = count(seg.replace(/\*\*/g, ''), '*');
    if (single % 2) {
      if (src[to] === '*' && src[to + 1] !== '*') { to++; continue; }
      if (src[from - 1] === '*' && src[from - 2] !== '*') { from--; continue; }
    }
    const open = count(seg, '['), close = count(seg, ']');
    if (open > close) { // ends inside a link's text: take the rest of the link
      const end = /^[^\]\n]*\]\([^)\n]*\)/.exec(src.slice(to));
      if (end) { to += end[0].length; continue; }
    }
    if (close > open || /^[^\[]*\]\(/.test(seg)) { // starts inside a link's text
      const start = src.lastIndexOf('[', from);
      if (start >= 0 && !src.slice(start, from).includes('\n')) { from = start - (src[start - 1] === '!' ? 1 : 0); continue; }
    }
    const tail = /^\]\([^)\n]*\)/.exec(src.slice(to)); // link text ends exactly at `to`
    if (tail && src.slice(from, to).includes('[')) { to += tail[0].length; continue; }
    break;
  }
  return { from, to };
}

// Lines (by index in src) that are inside a ``` / ~~~ fence, so they're never highlighted.
function fencedLines(src) {
  const inside = new Set();
  let fence = null;
  src.split('\n').forEach((line, i) => {
    const m = /^\s*(```|~~~)/.exec(line);
    if (fence) { inside.add(i); if (m && m[1] === fence) fence = null; } else if (m) { fence = m[1]; inside.add(i); }
  });
  return inside;
}

// ==…== around each line of src[from, to] (outside list / quote / heading marks), widened to whole words and to
// whole **bold** / [links]. Code blocks, tables and picture-only lines are left alone.
export function addHighlight(src, from, to) {
  while (from > 0 && /[\p{L}\p{N}_'’-]/u.test(src[from - 1])) from--;
  while (to < src.length && /[\p{L}\p{N}_'’-]/u.test(src[to])) to++;
  ({ from, to } = balance(src, from, to));
  const lineStart = src.lastIndexOf('\n', from - 1) + 1;
  const firstLine = src.slice(0, from).split('\n').length - 1;
  const fenced = fencedLines(src);
  const out = src.slice(from, to).split('\n').map((line, i) => {
    if (fenced.has(firstLine + i)) return line;
    if (/^\s*\|/.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line) || /^\s*(\$\$|<)/.test(line)) return line;
    // The first line's marks (if any) are before `from`; later lines start with their own.
    const lead = i === 0 && from > lineStart ? '' : (/^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?/.exec(line)?.[0] || '');
    const body = line.slice(lead.length);
    const core = body.trimEnd();
    if (!core.trim() || /^(```|~~~|\|?\s*:?-{3,})/.test(core)) return line;
    return `${lead}==${core.replace(/==/g, '')}==${body.slice(core.length)}`;
  }).join('\n');
  return { from, to, text: out };
}

export function createReading(ctx) {
  const { api, S, $, el, editor, toast, overlay, closeOverlay, refresh, openNote, setMode, setFilter, live, leafOf, isTrashed, currentNote } = ctx;

  // ---------- Save Web Page ----------
  function targetNotebook() {
    const f = S.filter;
    if (f.type === 'notebook' && !f.name.startsWith('Confluence')) return f.name;
    const n = currentNote();
    if (n && !n.trashed && n.notebook && /^(Reading|Resources?)\b/i.test(leafOf(n.notebook))) return n.notebook;
    return READING_NOTEBOOK;
  }

  function saveWebPage(prefill = '') {
    const nb = targetNotebook();
    const ov = overlay('palette-ov');
    ov.innerHTML = '<div class="palette web-save"><input spellcheck="false" placeholder="Paste a link to an article or a PDF, then press Return"><div class="ws-hint"></div></div>';
    const input = $('input', ov);
    const hint = $('.ws-hint', ov);
    hint.textContent = `Saved into “${nb || 'Inbox'}”. An article becomes a note you can highlight; a PDF is kept as a PDF.`;
    input.value = prefill;
    input.focus();
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const url = input.value.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) { hint.textContent = 'That doesn’t look like a link (it should start with https://).'; return; }
      input.disabled = true;
      hint.textContent = 'Fetching the page…';
      try {
        const p = await savePage(url, nb);
        closeOverlay();
        await refresh();
        await openNote(p);
        setMode('preview');
        toast('Saved. Select text in the preview to highlight it.');
      } catch (err) {
        input.disabled = false;
        input.focus();
        hint.textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
    });
  }

  async function savePage(url, nb) {
    const got = await api.web.fetch(url, nb);
    if (got.kind === 'pdf') return got.path;
    const a = extractArticle(got.html, got.url);
    if (!a.markdown || a.markdown.length < 40) throw new Error('Couldn’t find an article on that page (it may need a sign-in, or be built by scripts).');
    const by = [a.author && `by ${a.author}`, a.published].filter(Boolean).join(' · ');
    const body = `> From [${a.site.replace(/[[\]]/g, '')}](${got.url})${by ? ` · ${by}` : ''}\n\n${a.markdown}\n`;
    return api.web.saveArticle(nb, { title: a.title, body, url: got.url, site: a.site, author: a.author, published: a.published });
  }

  // ---------- highlight from the preview ----------
  const pill = el('button', 'hl-pill');
  pill.hidden = true;
  document.body.append(pill);
  let pending = null;
  const preview = $('#preview');

  function previewSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const before = document.createRange();
    before.setStart(preview, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const ratio = before.toString().length / Math.max(1, preview.textContent.length);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    return { text, ratio, range, mark: startEl?.closest('mark') };
  }

  function showPill() {
    const n = currentNote();
    const s = n && !n.trashed && !n.kind && !isTrashed() && previewSelection();
    if (!s) { pill.hidden = true; pending = null; return; }
    pending = s;
    pill.textContent = s.mark ? 'Remove highlight' : 'Highlight';
    const r = s.range.getBoundingClientRect();
    pill.style.top = `${Math.max(8, r.top - 38)}px`;
    pill.style.left = `${Math.max(8, Math.min(innerWidth - 150, r.left + r.width / 2 - 50))}px`;
    pill.hidden = false;
  }

  function applyPending() {
    const s = pending;
    pill.hidden = true;
    pending = null;
    if (!s) return;
    const src = editor.text();
    if (s.mark) {
      const hit = findInSource(src, s.mark.textContent, s.ratio);
      if (!hit) return toast('Couldn’t find that highlight in the note.');
      let { from, to } = hit;
      const open = src.lastIndexOf('==', from);
      const close = src.indexOf('==', to);
      if (open < 0 || close < 0 || src.slice(open + 2, from).includes('\n') || src.slice(to, close).includes('\n')) return toast('Couldn’t find that highlight in the note.');
      editor.replaceRange(open, close + 2, src.slice(open + 2, close));
    } else {
      const hit = findInSource(src, s.text, s.ratio);
      if (!hit) return toast('Couldn’t match that text in the note — highlight it in the editor with ⇧⌘H.');
      const h = addHighlight(src, hit.from, hit.to);
      editor.replaceRange(h.from, h.to, h.text);
    }
    getSelection()?.removeAllRanges();
  }

  pill.addEventListener('mousedown', (e) => { e.preventDefault(); applyPending(); });
  preview.addEventListener('mouseup', () => setTimeout(showPill, 0));
  preview.addEventListener('scroll', () => { pill.hidden = true; });
  document.addEventListener('selectionchange', () => { if (!pill.hidden && !previewSelection()) pill.hidden = true; });

  // ---------- Highlights: every ==highlight== in every note ----------
  function allHighlights() {
    const out = [];
    for (const n of live()) {
      if (n.kind) continue;
      const fenced = fencedLines(n.body);
      n.body.split('\n').forEach((line, i) => {
        if (fenced.has(i)) return;
        for (const m of line.replace(/`[^`\n]*`/g, (c) => ' '.repeat(c.length)).matchAll(HL_RE)) out.push({ n, text: m[1], line: i + 1 });
      });
    }
    return out.sort((a, b) => b.n.mtime - a.n.mtime || a.line - b.line);
  }

  function openHighlights() {
    const ov = overlay('palette-ov');
    ov.innerHTML = '<div class="palette hl-list"><input spellcheck="false" placeholder="Filter highlights…"><ul></ul></div>';
    const input = $('input', ov);
    const ul = $('ul', ov);
    const all = allHighlights();
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      ul.textContent = '';
      let last = null;
      let shown = 0;
      for (const h of all) {
        if (q && !h.text.toLowerCase().includes(q) && !h.n.title.toLowerCase().includes(q)) continue;
        if (last !== h.n) {
          last = h.n;
          ul.append(el('li', 'hl-note', `${h.n.title}  ·  ${h.n.notebook ? leafOf(h.n.notebook) : 'Inbox'}`));
        }
        const li = el('li', 'hl-item');
        li.append(el('mark', '', h.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')));
        li.addEventListener('click', async () => {
          closeOverlay();
          if (!S.notes.some((x) => x.path === h.n.path && !x.trashed)) return;
          setFilter({ type: 'all' });
          await openNote(h.n.path);
          editor.gotoLine(h.line);
          if (S.mode === 'preview') {
            const marks = [...$('#preview').querySelectorAll('mark')];
            marks.find((m) => m.textContent.trim() && h.text.includes(m.textContent.trim().slice(0, 40)))?.scrollIntoView({ block: 'center' });
          }
        });
        ul.append(li);
        shown++;
      }
      if (!shown) ul.append(el('li', 'pl-empty', all.length ? 'No matches' : 'No highlights yet. Select text in the preview and click Highlight, or use ⇧⌘H in the editor.'));
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); } });
    draw();
    input.focus();
  }

  return { saveWebPage, savePage, openHighlights, hidePill: () => { pill.hidden = true; } };
}
