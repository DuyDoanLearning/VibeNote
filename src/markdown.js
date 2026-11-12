// Markdown → HTML: GFM via marked, [[wiki links]], $math$ via KaTeX, mermaid diagrams, code highlighting.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';

let linkExists = () => true;
export function setLinkResolver(fn) { linkExists = fn; }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function tex(src, displayMode) {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

const marked = new Marked({ gfm: true });
marked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src) => { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), text: (m[2] || m[1]).trim() };
      },
      renderer(tok) {
        const cls = linkExists(tok.target) ? 'wikilink' : 'wikilink missing';
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
export async function postProcess(root, { dir, dark, onTask }) {
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
