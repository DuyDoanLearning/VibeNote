// Markdown → HTML: GFM via marked, [[wiki links]], $math$ via KaTeX, mermaid diagrams, code highlighting.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import markedFootnote from 'marked-footnote';

let linkKind = () => 'note'; // target → 'note' | 'confluence' | 'api' | null (missing)
export function setLinkResolver(fn) { linkKind = fn; }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function tex(src, displayMode) {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

const marked = new Marked({ gfm: true });
marked.use(markedFootnote());
marked.use({
  extensions: [
    {
      name: 'highlight',
      level: 'inline',
      start: (src) => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==(?=\S)([^=\n]*?\S)==/.exec(src);
        if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(tok) { return `<mark>${this.parser.parseInline(tok.tokens)}</mark>`; },
    },
    {
      name: 'wikilink',
      level: 'inline',
      start: (src) => { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\[\[([^\n|]+?)(?:\|([^\n]+?))?\]\](?!\])/.exec(src); // titles may contain [ ]
        if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), text: m[2] ? m[2].trim() : m[1].trim().replace(/^(project|diagram):\s*/i, '').replace(/\s*#\s*/, ' › ') };
      },
      renderer(tok) {
        const kind = linkKind(tok.target);
        const cls = kind ? `wikilink kind-${kind}` : 'wikilink missing';
        return `<a class="${cls}" href="#note:${encodeURIComponent(tok.target)}">${esc(tok.text)}</a>`;
      },
    },
    {
      name: 'mathBlock',
      level: 'block',
      start: (src) => { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: (tok) => `<div class="math-block">${tex(tok.text, true)}</div>`,
    },
    {
      name: 'mathInline',
      level: 'inline',
      start: (src) => { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
      },
      renderer: (tok) => tex(tok.text, false),
    },
  ],
});

export function renderMarkdown(md) {
  return DOMPurify.sanitize(marked.parse(md), { ADD_ATTR: ['target'] });
}

// ---------- mermaid (loaded lazily; it's big) ----------
let mermaidP = null;
let mermaidTheme = null;
let mermaidSeq = 0;
const mermaidCache = new Map();
function loadMermaid() {
  return (mermaidP ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'dist/mermaid.min.js';
    s.onload = () => resolve(window.mermaid);
    s.onerror = reject;
    document.head.append(s);
  }));
}
async function renderMermaid(code, dark) {
  const key = (dark ? 'd:' : 'l:') + code;
  if (mermaidCache.has(key)) return mermaidCache.get(key);
  const mermaid = await loadMermaid();
  const themeName = dark ? 'dark' : 'neutral';
  if (mermaidTheme !== themeName) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: themeName, fontFamily: 'inherit' });
    mermaidTheme = themeName;
  }
  let out;
  try {
    out = (await mermaid.render(`mmd-${++mermaidSeq}`, code)).svg;
  } catch (e) {
    out = `<div class="mermaid-error">Diagram error: ${esc(e.message || e)}</div>`;
  }
  if (mermaidCache.size > 50) mermaidCache.clear();
  mermaidCache.set(key, out);
  return out;
}

// Enhance rendered HTML in place. dir = folder of the note (for relative images).
const ALERT_ICONS = { note: 'ℹ️', tip: '💡', important: '❗', warning: '⚠️', caution: '🛑' };

export async function postProcess(root, { dir, dark, onTask, copyButtons = false }) {
  // > [!NOTE] … → callout box
  root.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') return;
    const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent);
    if (!m) return;
    const kind = m[1].toLowerCase();
    // strip the marker from the first text node
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (first) first.textContent = first.textContent.replace(/^\s*\[![a-z]+\]\s*/i, '');
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    bq.classList.add('alert', `alert-${kind}`);
    const title = document.createElement('div');
    title.className = 'alert-title';
    title.textContent = `${ALERT_ICONS[kind]} ${kind[0].toUpperCase()}${kind.slice(1)}`;
    bq.prepend(title);
  });
  // ![w:200](…) / ![photo width:50%](…) → sized image
  root.querySelectorAll('img[alt]').forEach((img) => {
    let alt = img.getAttribute('alt');
    const grab = (re, prop) => {
      const m = re.exec(alt);
      if (!m) return;
      img.style[prop] = /%|px$/.test(m[1]) ? m[1] : `${m[1]}px`;
      alt = alt.replace(m[0], '').trim();
    };
    grab(/\b(?:w|width):\s*(\d+(?:px|%)?)/i, 'width');
    grab(/\b(?:h|height):\s*(\d+(?:px|%)?)/i, 'height');
    img.setAttribute('alt', alt);
  });
  // ```confluence boxes (parts of a Confluence page Markdown can't show, kept as-is on push) → a labelled box
  root.querySelectorAll('pre > code.language-confluence').forEach((code) => {
    const [first, ...rest] = code.textContent.trim().split('\n');
    const box = document.createElement('div');
    box.className = 'confluence-kept';
    const n = /^#(\d+)/.exec(first)?.[1];
    if (n) box.dataset.kept = n;
    const label = document.createElement('div');
    label.className = 'ck-label';
    label.textContent = first.replace(/^#\d+\s*/, '').replace(/\s*·\s*kept in Confluence\s*$/, '');
    const note = document.createElement('div');
    note.className = 'ck-note';
    note.textContent = rest.length ? rest.join(' ') : 'Shown in Confluence · kept unchanged when you push';
    box.append(label, note);
    code.parentElement.replaceWith(box);
  });
  if (copyButtons) {
    root.querySelectorAll('pre > code').forEach((code) => {
      if (code.classList.contains('language-mermaid')) return;
      const pre = code.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      pre.replaceWith(wrap);
      wrap.append(pre);
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
      wrap.append(btn);
      // OpenAPI / Swagger spec in a ```yaml / ```json block → open it as Swagger docs
      if (/language-(ya?ml|json)/.test(code.className) && /^\s*["']?(openapi|swagger)["']?\s*:/m.test(code.textContent.slice(0, 4000))) {
        const apiBtn = document.createElement('button');
        apiBtn.className = 'copy-btn api-btn';
        apiBtn.textContent = '⚡ API docs';
        apiBtn.title = 'Open this spec as Swagger docs (with Try it out)';
        apiBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('vibe:api-docs', { detail: code.textContent })));
        wrap.append(apiBtn);
      }
    });
  }
  root.querySelectorAll('pre code').forEach((c) => {
    if (c.classList.contains('language-mermaid')) return;
    try { hljs.highlightElement(c); } catch {}
  });
  root.querySelectorAll('a[href]').forEach((a) => {
    if (!a.getAttribute('href').startsWith('#')) a.target = '_blank';
  });
  if (dir) {
    root.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return;
      try { img.src = 'file://' + encodeURI(dir + '/' + decodeURI(src)); } catch {}
    });
  }
  root.querySelectorAll('input[type=checkbox]').forEach((box, i) => {
    if (!onTask) return;
    box.disabled = false;
    box.addEventListener('click', (e) => { e.preventDefault(); onTask(i); });
  });
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  for (const code of blocks) {
    const svg = await renderMermaid(code.textContent, dark);
    const div = document.createElement('div');
    div.className = 'mermaid';
    div.innerHTML = svg;
    code.parentElement.replaceWith(div);
  }
}
