// Drag the borders between the sidebar, note list, editor, preview and the right-hand panel to resize them.
// Double-click a border to reset it. Sizes are remembered (per Mac, in localStorage) as CSS variables on <html>.
const MIN_MAIN = 380; // the editor column never gets narrower than this while dragging

const EDGES = [
  { key: 'side', host: '#sidebar', side: 'right', cssVar: '--side-w', min: 170, max: 440 },
  { key: 'list', host: '#list', side: 'right', cssVar: '--list-w', min: 220, max: 600 },
  { key: 'comments', host: '#comments', side: 'left', cssVar: '--comments-w', min: 280, max: 760 },
  { key: 'claude', host: '#agent', side: 'left', cssVar: '--claude-w', min: 300, max: 860 },
  { key: 'split', host: '#editor', side: 'right', split: true },
];

export function setupResizers({ load, store, onResized = () => {} }) {
  const root = document.documentElement;
  const sizes = load('sizes', {});

  const apply = (e, value) => {
    if (e.split) {
      if (value == null) { root.style.removeProperty('--split-l'); root.style.removeProperty('--split-r'); return; }
      root.style.setProperty('--split-l', `${value}fr`);
      root.style.setProperty('--split-r', `${1 - value}fr`);
    } else if (value == null) root.style.removeProperty(e.cssVar);
    else root.style.setProperty(e.cssVar, `${Math.round(value)}px`);
  };
  for (const e of EDGES) if (sizes[e.key] != null) apply(e, sizes[e.key]);

  for (const e of EDGES) {
    const host = document.querySelector(e.host);
    if (!host) continue;
    const handle = document.createElement('div');
    handle.className = `resizer ${e.side}`;
    handle.title = 'Drag to resize · double-click to reset';
    host.append(handle);

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const rect = host.getBoundingClientRect();
      const panes = document.querySelector('#panes').getBoundingClientRect();
      const mainW = document.querySelector('#main').getBoundingClientRect().width;
      document.body.classList.add('resizing');
      handle.classList.add('drag');
      let value = null;
      const move = (m) => {
        if (e.split) {
          const lo = Math.max(0.2, 160 / panes.width), hi = Math.min(0.8, 1 - 160 / panes.width); // each half ≥ 160px
          value = Math.min(hi, Math.max(lo, (m.clientX - panes.left) / panes.width));
        } else {
          const w = e.side === 'right' ? m.clientX - rect.left : rect.right - m.clientX;
          const roomy = rect.width + Math.max(0, mainW - MIN_MAIN); // don't squeeze the editor below MIN_MAIN
          value = Math.min(e.max, roomy, Math.max(e.min, w));
        }
        apply(e, value);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        handle.classList.remove('drag');
        if (value != null) { sizes[e.key] = e.split ? +value.toFixed(3) : Math.round(value); store('sizes', sizes); }
        onResized();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      delete sizes[e.key];
      store('sizes', sizes);
      apply(e, null);
      onResized();
    });
  }
}
