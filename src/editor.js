// CodeMirror setup: Markdown editing, wiki-link autocomplete, image paste/drop, task toggling.
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { vim } from '@replit/codemirror-vim';
import { tags as t } from '@lezer/highlight';

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, color: 'var(--code)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--faint)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--editor-font)', fontSize: 'var(--editor-size)', lineHeight: '1.7' },
  '.cm-content': { maxWidth: 'var(--line-width)', margin: '0 auto', padding: '28px 32px 40vh', caretColor: 'var(--accent)' },
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
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important', fontFamily: 'var(--sans)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
});

const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;

export function createEditor({ parent, onChange, onFiles, onDropNote, onLinkClick, getTitles }) {
  const comps = { vim: new Compartment(), gutter: new Compartment(), spell: new Compartment(), ro: new Compartment() };
  let settings = {};
  let readOnly = false;
  let silent = false;

  // [[ → suggest note titles
  const wikiComplete = (ctx) => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!m) return null;
    return {
      from: m.from + 2,
      options: getTitles().map((title) => ({
        label: title,
        apply: (view, _c, from, to) => {
          const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
          const insert = title + ']]';
          view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
        },
      })),
    };
  };

  const imageFiles = (list) => [...(list || [])].filter((f) => f.type.startsWith('image/'));

  const vimExt = () => (settings.vim ? vim() : []);
  const gutterExt = () => (settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []);
  const spellExt = () => EditorView.contentAttributes.of({ spellcheck: settings.spellcheck ? 'true' : 'false', autocorrect: 'off' });
  const roExt = () => (readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

  const extensions = () => [
    comps.vim.of(vimExt()),
    comps.gutter.of(gutterExt()),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(mdHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [wikiComplete], icons: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    theme,
    comps.spell.of(spellExt()),
    comps.ro.of(roExt()),
    EditorView.updateListener.of((u) => { if (u.docChanged) onChange(!silent); }),
    EditorView.domEventHandlers({
      // ⌘-click a [[wiki link]] to follow it
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || !onLinkClick) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        for (const m of line.text.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g)) {
          const from = line.from + m.index;
          if (pos >= from && pos <= from + m[0].length) {
            e.preventDefault();
            onLinkClick(m[1].trim());
            return true;
          }
        }
        return false;
      },
      paste(e, view) {
        const files = imageFiles(e.clipboardData?.files);
        if (!files.length || readOnly) return false;
        e.preventDefault();
        onFiles(files, view.state.selection.main.head);
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
    setDoc(text, ro = false) {
      readOnly = ro;
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
