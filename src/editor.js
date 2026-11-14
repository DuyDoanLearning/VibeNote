// CodeMirror setup: Markdown editing, autocomplete (wiki links, slash commands, emoji, code languages),
// image paste/drop, smart URL paste, task toggling. Colours come from CSS variables so themes can restyle it.
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration,
} from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { vim } from '@replit/codemirror-vim';
import { tags as t } from '@lezer/highlight';
import { typingKeymap, listMarkers, slashComplete, slashClaudeOnly, emojiComplete, fenceComplete } from './typing.js';
import { ghostSuggestions } from './ghost.js';

// ---------- comment highlights ----------
// Marks on commented text. They move with edits (mapped through every change), so a comment stays on its words.
const setCommentsFx = StateEffect.define(); // [{ id, from, to }], activeId
const commentField = StateField.define({
  create: () => ({ deco: Decoration.none, active: null }),
  update(value, tr) {
    let { deco, active } = value;
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCommentsFx)) continue;
      active = e.value.active;
      const len = tr.state.doc.length;
      const marks = e.value.list
        .filter((c) => c.from < c.to && c.to <= len)
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map((c) => Decoration.mark({ class: c.id === active ? 'cm-comment active' : 'cm-comment', attributes: { 'data-cid': c.id }, cid: c.id }).range(c.from, c.to));
      deco = Decoration.set(marks, true);
    }
    return { deco, active };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const v = (name) => `var(${name})`;
export const highlight = HighlightStyle.define([
  // Markdown
  { tag: t.heading1, fontSize: '1.4em', fontWeight: '700', color: v('--md-heading') },
  { tag: t.heading2, fontSize: '1.22em', fontWeight: '700', color: v('--md-heading') },
  { tag: t.heading3, fontSize: '1.08em', fontWeight: '700', color: v('--md-heading') },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: v('--md-heading') },
  { tag: t.strong, fontWeight: '700', color: v('--md-bold') },
  { tag: t.emphasis, fontStyle: 'italic', color: v('--md-italic') },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: v('--md-link') },
  { tag: t.url, color: v('--muted') },
  { tag: t.monospace, color: v('--code') },
  { tag: t.quote, color: v('--md-quote'), fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: v('--md-mark') },
  // Code inside fenced blocks
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: v('--syn-keyword') },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: v('--syn-string') },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: v('--syn-number') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('--syn-comment'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: v('--syn-func') },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: v('--syn-type') },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: v('--syn-attr') },
  { tag: [t.tagName, t.angleBracket], color: v('--syn-tag') },
  { tag: [t.annotation, t.special(t.variableName)], color: v('--syn-meta') },
  { tag: t.invalid, color: '#ef4444' },
]);

export const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--editor-font)', fontSize: 'var(--editor-size)', lineHeight: '1.6' },
  '.cm-content': { maxWidth: 'var(--line-width)', margin: '0', padding: '14px 24px 40vh', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--faint)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 14px', fontSize: '0.8em' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-fat-cursor': { background: 'var(--accent) !important', color: 'var(--bg) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: '1px solid var(--accent) !important' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--selection)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button': { fontFamily: 'var(--sans)' },
  '.cm-searchMatch': { backgroundColor: 'var(--match)' },
  '.cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--faint)' },
  '.cm-lm0': { color: 'var(--list-1)' },
  '.cm-lm1': { color: 'var(--list-2)' },
  '.cm-lm2': { color: 'var(--list-3)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--sans) !important', maxHeight: '18em !important' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
  '.cm-completionDetail': { marginLeft: '12px', opacity: '0.6', fontStyle: 'normal' },
});

const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
const URL_RE = /^https?:\/\/[^\s<>"]+$/;

export function createEditor({ parent, onChange, onFiles, onDropNote, onLinkClick, onPasteUrl, getTitles, getFragments = () => [], onSelection, onCommentClick, suggest }) {
  const comps = { vim: new Compartment(), gutter: new Compartment(), spell: new Compartment(), ro: new Compartment(), lang: new Compartment() };
  let lang = 'markdown'; // 'markdown' | 'yaml' | 'json' (API specs)
  // Markdown notes get the Markdown helpers; API specs (YAML/JSON) are plain code: no wrapping, no Markdown
  // shortcuts or templates — only /claude.
  const langExt = () => (lang === 'yaml' || lang === 'json'
    ? [lang === 'yaml' ? yaml() : json(), autocompletion({ override: [slashClaudeOnly], icons: false })]
    : [
      // no "setext" headings (text with a line of - or = under it), same as the preview
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: { remove: ['SetextHeading'] } }), listMarkers, EditorView.lineWrapping, typingKeymap,
      autocompletion({ override: [wikiComplete, slashComplete, emojiComplete, fenceComplete], icons: false }),
    ]);
  let settings = {};
  let readOnly = false;
  let silent = false;

  // [[ → everything you can link to: projects, notes, Confluence pages, API specs, diagrams (grouped in sections)
  const SECTIONS = {
    project: { name: 'Projects', rank: 0 }, note: { name: 'Notes', rank: 1 }, confluence: { name: 'Confluence pages', rank: 2 },
    api: { name: 'API specs', rank: 3 }, diagram: { name: 'Diagrams', rank: 4 },
  };
  const wikiComplete = (ctx) => {
    const m = ctx.matchBefore(/\[\[(?:[^\]\n]|\](?!\]))*/);
    if (!m) return null;
    const typed = m.text.slice(2);
    const hash = typed.indexOf('#');
    if (hash >= 0) {
      // [[Title#…  → headings of a note, or endpoints of an API spec
      const frags = getFragments(typed.slice(0, hash).trim());
      return {
        from: m.from + 2 + hash + 1,
        options: frags.map((f) => ({
          label: f.label,
          detail: f.detail || '',
          type: f.type || 'text',
          apply: (view, _c, from, to) => {
            const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
            const insert = f.label + ']]';
            view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
          },
        })),
      };
    }
    return {
      from: m.from + 2,
      options: getTitles().map(({ title, kind, insert: ins, where }) => ({
        label: title,
        detail: where || '',
        type: kind === 'project' ? 'class' : kind === 'diagram' ? 'constant' : 'note',
        section: SECTIONS[kind] || SECTIONS.note,
        apply: (view, _c, from, to) => {
          const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
          const insert = (ins || title) + ']]';
          view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
        },
      })),
    };
  };

  const imageFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith('image/'));
  const inCode = (state, pos) => {
    for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
      if (/Code|URL|LinkMark|Autolink/.test(n.name)) return true;
    }
    return false;
  };

  const vimExt = () => (settings.vim ? vim() : []);
  const gutterExt = () => (settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []);
  const spellExt = () => EditorView.contentAttributes.of({ spellcheck: settings.spellcheck ? 'true' : 'false', autocorrect: 'off' });
  const roExt = () => (readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

  const extensions = () => [
    ...(suggest ? [ghostSuggestions(suggest)] : []),
    comps.vim.of(vimExt()),
    comps.gutter.of(gutterExt()),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    comps.lang.of(langExt()),
    theme,
    comps.spell.of(spellExt()),
    comps.ro.of(roExt()),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(!silent);
      if (onSelection && (u.selectionSet || u.docChanged || u.geometryChanged || u.focusChanged)) onSelection();
    }),
    commentField,
    EditorView.domEventHandlers({
      click(e) {
        const mark = e.target.closest?.('.cm-comment');
        if (mark && onCommentClick && !e.metaKey) onCommentClick(mark.getAttribute('data-cid'));
        return false;
      },
      // ⌘-click a [[wiki link]] to follow it, or a web link to open it in the browser
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        const hit = (re, fn) => {
          for (const m of line.text.matchAll(re)) {
            const from = line.from + m.index;
            if (pos >= from && pos <= from + m[0].length) { e.preventDefault(); fn(m); return true; }
          }
          return false;
        };
        return (
          (onLinkClick && hit(/\[\[([^\n|]+?)(?:\|[^\n]+?)?\]\](?!\])/g, (m) => onLinkClick(m[1].trim()))) ||
          hit(/https?:\/\/[^\s<>()"\]]+/g, (m) => window.open(m[0], '_blank'))
        );
      },
      paste(e, view) {
        if (readOnly) return false;
        const files = imageFiles(e.clipboardData?.files);
        if (files.length) {
          e.preventDefault();
          onFiles(files, view.state.selection.main.head);
          return true;
        }
        const text = (e.clipboardData?.getData('text/plain') || '').trim();
        if (!URL_RE.test(text)) return false;
        const sel = view.state.selection.main;
        if (!sel.empty) {
          const label = view.state.sliceDoc(sel.from, sel.to);
          if (URL_RE.test(label) || label.includes('\n')) return false;
          e.preventDefault();
          const insert = `[${label}](${text})`;
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: 'input.paste' });
          return true;
        }
        if (!onPasteUrl || inCode(view.state, sel.from) || /\]\($|<$/.test(view.state.sliceDoc(sel.from - 2, sel.from))) return false;
        e.preventDefault();
        view.dispatch({ changes: { from: sel.from, insert: text }, selection: { anchor: sel.from + text.length }, userEvent: 'input.paste' });
        onPasteUrl(text, sel.from);
        return true;
      },
      drop(e, view) {
        if (readOnly) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        const notePath = e.dataTransfer?.getData('text/vibe-note');
        if (notePath) {
          e.preventDefault();
          onDropNote(notePath, pos);
          return true;
        }
        const files = imageFiles(e.dataTransfer?.files);
        if (!files.length) return false;
        e.preventDefault();
        onFiles(files, pos);
        return true;
      },
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '', extensions: extensions() }), parent });

  return {
    view,
    text: () => view.state.doc.toString(),
    setDoc(text, ro = false, language = 'markdown') {
      readOnly = ro;
      lang = language;
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
    },
    // Replace the whole document. asEdit=false means "came from disk": don't mark the note dirty.
    replaceDoc(text, asEdit = false) {
      silent = !asEdit;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
      silent = false;
    },
    insert(pos, text) {
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    },
    // Replace `find` (expected near `near`) with `replacement`, if it's still there.
    replaceNear(near, find, replacement) {
      const doc = view.state.doc.toString();
      let best = -1;
      for (let i = doc.indexOf(find); i >= 0; i = doc.indexOf(find, i + 1)) {
        if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
      }
      if (best < 0) return false;
      view.dispatch({ changes: { from: best, to: best + find.length, insert: replacement }, userEvent: 'input' });
      return true;
    },
    // ---- comments ----
    setComments(list, active = null) { view.dispatch({ effects: setCommentsFx.of({ list, active }) }); },
    // Current positions of the comment marks: [{ id, from, to }].
    comments() {
      const out = [];
      const cur = view.state.field(commentField).deco.iter();
      for (; cur.value; cur.next()) out.push({ id: cur.value.spec.cid, from: cur.from, to: cur.to });
      return out;
    },
    selection() {
      const r = view.state.selection.main;
      return { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to), empty: r.empty, focused: view.hasFocus };
    },
    // Screen position of a document position ({ left, top, bottom }), or null if it's scrolled out of view.
    coordsAt: (pos) => view.coordsAtPos(pos),
    slice: (from, to) => view.state.sliceDoc(from, to),
    // Replace a range as a normal (undoable) user edit.
    replaceRange(from, to, text) {
      if (readOnly) return false;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length }, userEvent: 'input' });
      return true;
    },
    select(from, to) {
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    },
    run(cmd) {
      if (readOnly) return false;
      const ok = cmd(view);
      view.focus();
      return ok;
    },
    gotoLine(n) {
      const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 16 }) });
      view.focus();
    },
    applySettings(s) {
      settings = s;
      view.dispatch({
        effects: [
          comps.vim.reconfigure(vimExt()),
          comps.gutter.reconfigure(gutterExt()),
          comps.spell.reconfigure(spellExt()),
        ],
      });
      view.requestMeasure();
    },
    // Flip the i-th "- [ ]" task marker (outside fenced code) in the document.
    toggleTask(i) {
      if (readOnly) return;
      const doc = view.state.doc;
      let fence = false;
      let n = 0;
      for (let ln = 1; ln <= doc.lines; ln++) {
        const line = doc.line(ln);
        if (/^\s*(```|~~~)/.test(line.text)) { fence = !fence; continue; }
        if (fence) continue;
        const m = TASK_RE.exec(line.text);
        if (!m) continue;
        if (n++ === i) {
          const pos = line.from + m[1].length;
          view.dispatch({ changes: { from: pos, to: pos + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
          return;
        }
      }
    },
  };
}
