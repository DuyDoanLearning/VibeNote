// Turn a VS Code colour theme into VibeNote's CSS variables (UI, editor and preview all read these).

// TextMate scope lookup: the most specific rule whose selector is a prefix of the scope wins.
function scopeLookup(tokenColors = []) {
  const rules = [];
  tokenColors.forEach((tc, order) => {
    const fg = tc?.settings?.foreground;
    if (!fg) return;
    const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope ?? '').split(',');
    for (const raw of scopes) {
      const s = raw.trim();
      if (!s) continue;
      const parts = s.split(/\s+/);
      rules.push({ sel: parts[parts.length - 1], descendant: parts.length > 1, fg, order });
    }
  });
  return (candidates) => {
    for (const scope of candidates) {
      let best = null;
      for (const r of rules) {
        if (scope !== r.sel && !scope.startsWith(r.sel + '.')) continue;
        const score = r.sel.length * 4 - (r.descendant ? 2 : 0);
        if (!best || score > best.score || (score === best.score && r.order > best.order)) best = { ...r, score };
      }
      if (best) return best.fg;
    }
    return null;
  };
}

const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

export function themeVars(theme) {
  const c = theme.colors || {};
  const dark = theme.type === 'dark';
  const get = (...keys) => keys.map((k) => c[k]).find(Boolean);
  const tok = scopeLookup(theme.tokenColors);

  const bg = get('editor.background') || (dark ? '#1e1e1e' : '#ffffff');
  const fg = get('editor.foreground', 'foreground') || (dark ? '#d4d4d4' : '#333333');
  const accent = get('textLink.foreground', 'button.background', 'focusBorder', 'activityBarBadge.background') || (dark ? '#4fc1ff' : '#0066b8');

  const vars = {
    '--bg': bg,
    '--text': fg,
    '--sidebar': get('sideBar.background', 'activityBar.background') || mix(fg, bg, 4),
    '--list': get('sideBar.background', 'editorGroupHeader.tabsBackground') || mix(fg, bg, 2),
    '--panel': get('editorWidget.background', 'quickInput.background', 'dropdown.background') || mix(fg, bg, 6),
    '--border': get('editorGroup.border', 'sideBar.border', 'panel.border', 'contrastBorder') || mix(fg, bg, 12),
    '--muted': mix(fg, bg, 68),
    '--faint': get('editorLineNumber.foreground') || mix(fg, bg, 42),
    '--accent': accent,
    '--accent-soft': mix(accent, 'transparent', 16),
    '--selection': get('editor.selectionBackground') || mix(accent, 'transparent', 30),
    '--match': get('editor.findMatchHighlightBackground', 'editor.findMatchBackground') || mix('#ffc400', 'transparent', 35),
    '--hover': get('list.hoverBackground') || mix(fg, 'transparent', 6),
    '--code-bg': get('textCodeBlock.background') || mix(fg, bg, 6),
    '--shadow': dark ? '0 20px 60px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4)' : '0 20px 60px rgba(20,16,40,.25), 0 2px 8px rgba(20,16,40,.12)',
  };

  const syn = {
    '--code': ['markup.inline.raw.string.markdown', 'markup.inline.raw', 'markup.raw', 'string'],
    '--md-heading': ['markup.heading.markdown', 'markup.heading', 'entity.name.section'],
    '--md-bold': ['markup.bold'],
    '--md-italic': ['markup.italic'],
    '--md-link': ['markup.underline.link', 'string.other.link.title.markdown', 'string.other.link'],
    '--md-quote': ['markup.quote'],
    '--md-mark': ['punctuation.definition.list.begin.markdown', 'beginning.punctuation.definition.list.markdown', 'punctuation.definition.heading.markdown', 'punctuation.definition'],
    '--syn-keyword': ['keyword', 'storage.type', 'storage'],
    '--syn-string': ['string'],
    '--syn-number': ['constant.numeric', 'constant.language', 'constant'],
    '--syn-comment': ['comment'],
    '--syn-func': ['entity.name.function', 'support.function'],
    '--syn-type': ['entity.name.type', 'support.type', 'entity.name.class', 'support.class'],
    '--syn-attr': ['variable.other.property', 'support.type.property-name', 'entity.other.attribute-name', 'variable'],
    '--syn-tag': ['entity.name.tag', 'meta.tag'],
    '--syn-meta': ['meta.preprocessor', 'entity.name.function.preprocessor', 'keyword.control.directive'],
  };
  for (const [name, scopes] of Object.entries(syn)) {
    const color = tok(scopes);
    if (color) vars[name] = color;
  }
  vars['--list-1'] = vars['--syn-keyword'] || accent;
  vars['--list-2'] = vars['--syn-string'] || accent;
  vars['--list-3'] = vars['--syn-number'] || accent;
  return vars;
}

export function applyTheme(theme) {
  let el = document.getElementById('theme-vars');
  if (!theme) {
    el?.remove();
    document.documentElement.removeAttribute('data-vscode-theme');
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'theme-vars';
    document.head.append(el);
  }
  const vars = themeVars(theme);
  const body = Object.entries(vars).map(([k, val]) => `${k}: ${val};`).join('\n  ');
  el.textContent = `html:root {\n  ${body}\n  color-scheme: ${theme.type};\n}`;
  document.documentElement.setAttribute('data-vscode-theme', theme.label);
}
