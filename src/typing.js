// Inkdrop-style typing helpers for the Markdown editor.
import { EditorSelection, Prec } from '@codemirror/state';
import { keymap, Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EMOJI } from './emoji.js';

// ---------- helpers ----------
function selectedLines(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (b > a && r.to === state.doc.line(b).from) b--; // selection ending at column 0
    for (let n = a; n <= b; n++) set.add(n);
  }
  return [...set].sort((x, y) => x - y);
}

// ---------- inline formatting ----------
export function toggleWrap(open, close = open) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const tr = state.changeByRange((range) => {
      const { from, to } = range;
      if (state.sliceDoc(from - open.length, from) === open && state.sliceDoc(to, to + close.length) === close) {
        return {
          changes: [{ from: from - open.length, to: from }, { from: to, to: to + close.length }],
          range: EditorSelection.range(from - open.length, to - open.length),
        };
      }
      const inner = state.sliceDoc(from, to);
      if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
        return {
          changes: { from, to, insert: inner.slice(open.length, inner.length - close.length) },
          range: EditorSelection.range(from, to - open.length - close.length),
        };
      }
      if (range.empty) {
        const word = state.wordAt(from);
        if (word) {
          return {
            changes: [{ from: word.from, insert: open }, { from: word.to, insert: close }],
            range: EditorSelection.cursor(from + open.length),
          };
        }
        return { changes: { from, insert: open + close }, range: EditorSelection.cursor(from + open.length) };
      }
      return {
        changes: [{ from, insert: open }, { from: to, insert: close }],
        range: EditorSelection.range(from + open.length, to + open.length),
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export function insertLink(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from: r.from, to: r.to, insert: `[](${text})` }, range: EditorSelection.cursor(r.from + 1) };
    }
    const insert = `[${text}]()`;
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length - 1) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

export function setHeading(level) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const changes = [];
    for (const n of selectedLines(state)) {
      const line = state.doc.line(n);
      const m = /^(#{1,6})\s+/.exec(line.text);
      const current = m ? m[1].length : 0;
      const prefix = level && level !== current ? '#'.repeat(level) + ' ' : '';
      changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
    }
    view.dispatch({ changes, userEvent: 'input' });
    return true;
  };
}

const TASK = /^(\s*(?:>\s*)*)([-*+]|\d+[.)])(\s+)\[([ xX])\]/;
const ITEM = /^(\s*(?:>\s*)*)([-*+]|\d+[.)])(\s+)/;

export function toggleTask(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const changes = [];
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n);
    let m;
    if ((m = TASK.exec(line.text))) {
      const pos = line.from + m[1].length + m[2].length + m[3].length + 1;
      changes.push({ from: pos, to: pos + 1, insert: m[4] === ' ' ? 'x' : ' ' });
    } else if ((m = ITEM.exec(line.text))) {
      changes.push({ from: line.from + m[0].length, insert: '[ ] ' });
    } else {
      const indent = /^\s*/.exec(line.text)[0].length;
      changes.push({ from: line.from + indent, insert: '- [ ] ' });
    }
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

// ---------- lists: Tab / Shift-Tab indent to the parent's content column ----------
const LIST = /^(\s*)([-*+]|\d+[.)])(\s+)/;
function listIndent(dir) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const lines = selectedLines(state);
    if (!lines.every((n) => LIST.test(state.doc.line(n).text))) return false;
    // With a plain cursor in the middle of text, only act if the cursor is in the marker area or line is short
    const changes = [];
    for (const n of lines) {
      const line = state.doc.line(n);
      const cur = LIST.exec(line.text)[1].length;
      let target;
      if (dir > 0) {
        target = cur + 2;
        for (let p = n - 1; p >= 1; p--) {
          const t = state.doc.line(p).text;
          if (!t.trim()) continue;
          const pm = LIST.exec(t);
          if (!pm) { if (/^\s/.test(t)) continue; break; }
          if (pm[1].length === cur) { target = cur + pm[2].length + Math.min(pm[3].length, 4); break; }
          if (pm[1].length < cur) break;
        }
      } else {
        if (cur === 0) continue;
        target = 0;
        for (let p = n - 1; p >= 1; p--) {
          const pm = LIST.exec(state.doc.line(p).text);
          if (pm && pm[1].length < cur) { target = pm[1].length; break; }
        }
      }
      changes.push({ from: line.from, to: line.from + cur, insert: ' '.repeat(target) });
    }
    view.dispatch({ changes, userEvent: dir > 0 ? 'input.indent' : 'delete.dedent' });
    return true;
  };
}

// ---------- line tools ----------
export function sortLines(desc = false) {
  return (view) => {
    const { state } = view;
    const r = state.selection.main;
    const a = state.doc.lineAt(r.from);
    const b = state.doc.lineAt(r.to);
    if (a.number === b.number) return false;
    const lines = state.sliceDoc(a.from, b.to).split('\n');
    lines.sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }));
    if (desc) lines.reverse();
    view.dispatch({ changes: { from: a.from, to: b.to, insert: lines.join('\n') }, userEvent: 'input' });
    return true;
  };
}

export function changeCase(upper) {
  return (view) => {
    const { state } = view;
    const tr = state.changeByRange((r) => {
      let { from, to } = r;
      if (r.empty) {
        const w = state.wordAt(from);
        if (!w) return { range: r };
        ({ from, to } = w);
      }
      const text = state.sliceDoc(from, to);
      return { changes: { from, to, insert: upper ? text.toUpperCase() : text.toLowerCase() }, range: EditorSelection.range(from, to) };
    });
    view.dispatch(state.update(tr, { userEvent: 'input' }));
    return true;
  };
}

export function joinLines(view) {
  const { state } = view;
  const r = state.selection.main;
  const a = state.doc.lineAt(r.from);
  let b = state.doc.lineAt(r.to);
  if (a.number === b.number) {
    if (b.number === state.doc.lines) return false;
    b = state.doc.line(b.number + 1);
  }
  const lines = state.sliceDoc(a.from, b.to).split('\n');
  const joined = lines.map((l, i) => (i ? l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)?/, '') : l.replace(/\s+$/, ''))).filter((l, i) => i === 0 || l.trim()).join(' ');
  view.dispatch({ changes: { from: a.from, to: b.to, insert: joined }, selection: { anchor: a.from + joined.length }, userEvent: 'input' });
  return true;
}

// ---------- keymap ----------
export const typingKeymap = Prec.high(keymap.of([
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Mod-Shift-x', run: toggleWrap('~~') },
  { key: 'Mod-e', run: toggleWrap('`') },
  { key: 'Mod-Shift-h', run: toggleWrap('==') },
  { key: 'Mod-Alt-k', run: insertLink },
  { key: 'Mod-Enter', run: toggleTask },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: `Ctrl-${n}`, run: setHeading(n) })),
  { key: 'Ctrl-0', run: setHeading(0) },
  { key: 'Tab', run: listIndent(1) },
  { key: 'Shift-Tab', run: listIndent(-1) },
  { key: 'Ctrl-j', run: joinLines },
  { key: 'F5', run: sortLines(false) },
  { key: 'Shift-F5', run: sortLines(true) },
]));

// ---------- coloured list markers by nesting depth ----------
const markerDeco = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-lm cm-lm${i}` }));
function buildMarkers(view) {
  const out = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== 'ListMark') return;
        let depth = 0;
        for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
        out.push(markerDeco[Math.max(0, depth - 1) % 3].range(node.from, node.to));
      },
    });
  }
  return Decoration.set(out, true);
}
export const listMarkers = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildMarkers(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildMarkers(u.view);
  }
}, { decorations: (v) => v.decorations });

// ---------- autocompletion sources ----------
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const now = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const SLASH = [
  ['Heading 1', 'Big section title', '# ¦'],
  ['Heading 2', 'Section title', '## ¦'],
  ['Heading 3', 'Subsection title', '### ¦'],
  ['Bullet list', 'Simple list', '- ¦'],
  ['Numbered list', '1. 2. 3.', '1. ¦'],
  ['Task list', 'Checklist', '- [ ] ¦'],
  ['Quote', 'Block quote', '> ¦'],
  ['Code block', 'Fenced code', '```¦\n\n```'],
  ['Table', '2 × 2 table', '| Column 1 | Column 2 |\n| -------- | -------- |\n| ¦ |  |\n|  |  |'],
  ['Divider', 'Horizontal rule', '---\n¦'],
  ['Note callout', '> [!NOTE]', '> [!NOTE]\n> ¦'],
  ['Tip callout', '> [!TIP]', '> [!TIP]\n> ¦'],
  ['Important callout', '> [!IMPORTANT]', '> [!IMPORTANT]\n> ¦'],
  ['Warning callout', '> [!WARNING]', '> [!WARNING]\n> ¦'],
  ['Caution callout', '> [!CAUTION]', '> [!CAUTION]\n> ¦'],
  ['Math block', 'KaTeX formula', '$$\n¦\n$$'],
  ['Mermaid diagram', 'Flowchart', '```mermaid\ngraph LR\n  A[¦Start] --> B[End]\n```'],
  ['Link to note', '[[…]]', '[[¦'],
  ['Link', '[text](url)', '[¦](url)'],
  ['Image', '![alt](path)', '![¦](path)'],
  ['Highlight', '==text==', '==¦=='],
  ['Footnote', '[^1]', '[^1]¦\n\n[^1]: '],
  ['Date', 'Today', () => today() + '¦'],
  ['Time', 'Now', () => now() + '¦'],
  ['Date and time', 'Today, now', () => `${today()} ${now()}¦`],
];

function applyTemplate(view, from, to, tpl) {
  let text = typeof tpl === 'function' ? tpl() : tpl;
  const at = text.indexOf('¦');
  text = text.replace('¦', '');
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (at < 0 ? text.length : at) },
    userEvent: 'input.complete',
  });
}

export function slashComplete(ctx) {
  const m = ctx.matchBefore(/^\s*\/[\w ]*$/);
  if (!m) return null;
  const slash = m.from + m.text.indexOf('/');
  return {
    from: slash + 1,
    validFor: /^[\w ]*$/,
    options: SLASH.map(([label, detail, tpl]) => ({
      label, detail, type: 'slash',
      apply: (view, _c, from, to) => applyTemplate(view, from - 1, to, tpl),
    })),
  };
}

export function emojiComplete(ctx) {
  const m = ctx.matchBefore(/(?<![\w:]):[a-z0-9_+-]{2,}$/i);
  if (!m) return null;
  return {
    from: m.from,
    validFor: /^:[\w+-]*$/,
    options: EMOJI.map(([name, ch]) => ({ label: `:${name}:`, displayLabel: `${ch}  ${name}`, apply: ch, type: 'emoji' })),
  };
}

const LANGS = ['bash', 'c', 'clojure', 'cpp', 'csharp', 'css', 'dart', 'diff', 'dockerfile', 'elixir', 'erlang', 'go', 'graphql',
  'haskell', 'hcl', 'html', 'ini', 'java', 'javascript', 'js', 'json', 'jsx', 'kotlin', 'latex', 'lua', 'makefile', 'markdown',
  'mermaid', 'nginx', 'objectivec', 'perl', 'php', 'plaintext', 'powershell', 'python', 'r', 'ruby', 'rust', 'scala', 'scss',
  'shell', 'sql', 'swift', 'terraform', 'toml', 'ts', 'tsx', 'typescript', 'vue', 'xml', 'yaml', 'zsh'];

export function fenceComplete(ctx) {
  const m = ctx.matchBefore(/^\s*(?:```|~~~)[\w+#-]*$/);
  if (!m) return null;
  return {
    from: m.from + m.text.search(/[`~]{3}/) + 3,
    validFor: /^[\w+#-]*$/,
    options: LANGS.map((l) => ({ label: l, type: 'keyword' })),
  };
}
