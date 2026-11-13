// Inline suggestions ("autocomplete for writing"): when you pause at the end of a line, Claude's suggestion appears as
// grey text after the cursor. Tab accepts it, Esc dismisses it; typing the same letters keeps the rest, anything else
// makes it disappear. The suggestion itself comes from main.js (suggest:get, a small warm Claude process).
import { StateField, StateEffect, Prec } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, ViewPlugin } from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';

const setGhost = StateEffect.define(); // { pos, text } | null

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-ghost';
    s.textContent = this.text;
    const k = document.createElement('span');
    k.className = 'cm-ghost-key';
    k.textContent = 'Tab';
    s.append(k);
    return s;
  }
  ignoreEvent() { return false; }
}

const ghostField = StateField.define({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!g) return null;
    if (tr.docChanged) {
      // Typing exactly what the suggestion shows keeps the rest of it.
      let typed = null;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
        typed = typed === null && fromA === g.pos && toA === g.pos ? ins.toString() : false;
      });
      if (typed && g.text.startsWith(typed) && typed.length < g.text.length) return { pos: g.pos + typed.length, text: g.text.slice(typed.length) };
      return null;
    }
    if (tr.selection && tr.state.selection.main.head !== g.pos) return null;
    return g;
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none)),
});

const accept = (view) => {
  const g = view.state.field(ghostField, false);
  if (!g) return false;
  view.dispatch({
    changes: { from: g.pos, insert: g.text },
    selection: { anchor: g.pos + g.text.length },
    effects: setGhost.of(null),
    userEvent: 'input.complete',
  });
  return true;
};
const dismiss = (view) => {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
};

/**
 * getSuggestion({ before, after }) → Promise<string|null>; canSuggest() → boolean (setting on, not an API spec…).
 */
export function ghostSuggestions({ getSuggestion, canSuggest, delay = 900 }) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.timer = null; this.seq = 0; }
    update(u) {
      const typed = u.transactions.some((tr) => tr.isUserEvent('input.type') || tr.isUserEvent('input.paste') || tr.isUserEvent('delete'));
      if (u.docChanged || u.selectionSet) { clearTimeout(this.timer); this.seq++; }
      if (typed && !u.state.field(ghostField, false)) this.timer = setTimeout(() => this.fire(), delay);
    }
    async fire() {
      const view = this.view;
      const st = view.state;
      const sel = st.selection.main;
      if (!view.hasFocus || !sel.empty || !canSuggest() || completionStatus(st)) return;
      const line = st.doc.lineAt(sel.head);
      if (line.text.slice(sel.head - line.from).trim()) return; // only at the end of a line
      const text = line.text.trim();
      if (text.length < 3 || text.startsWith('|') || /^```|^~~~/.test(text) || /^---\s*$/.test(text)) return;
      const before = st.sliceDoc(0, sel.head);
      if (before.replace(/\s/g, '').length < 25) return;
      if (/^---\n(?![\s\S]*\n---\s*\n)/.test(before)) return; // still inside the front matter
      if (((before.match(/^(```|~~~)/gm) || []).length) % 2 === 1) return; // inside a code block
      const seq = ++this.seq;
      let text2 = null;
      try { text2 = await getSuggestion({ before, after: st.sliceDoc(sel.head, Math.min(st.doc.length, sel.head + 400)) }); } catch {}
      if (seq !== this.seq || !text2 || view.state.selection.main.head !== sel.head || view.state.doc !== st.doc) return;
      view.dispatch({ effects: setGhost.of({ pos: sel.head, text: text2 }) });
    }
    destroy() { clearTimeout(this.timer); }
  });
  return [
    ghostField,
    plugin,
    Prec.highest(keymap.of([
      { key: 'Tab', run: accept },
      { key: 'Escape', run: dismiss },
    ])),
    EditorView.domEventHandlers({ blur: (_e, view) => { setTimeout(() => dismiss(view), 0); return false; } }),
  ];
}
