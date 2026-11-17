// Full-window viewer for a diagram (Mermaid SVG): opens fitted to the window, then zoom with the trackpad pinch,
// ⌘-scroll, + / − keys or the buttons, drag (or two-finger scroll) to move around. Esc, × or a click outside closes.

let open = null;

export function zoomView(source) {
  if (open) open.close();
  const svg = source.querySelector('svg');
  if (!svg) return;
  const pic = svg.cloneNode(true);
  // Mermaid sizes its SVG to the note column (width="100%", max-width); give it its natural size instead.
  const vb = pic.viewBox?.baseVal;
  const w0 = vb?.width || svg.getBoundingClientRect().width || 400;
  const h0 = vb?.height || svg.getBoundingClientRect().height || 300;
  pic.removeAttribute('style');
  pic.setAttribute('width', w0);
  pic.setAttribute('height', h0);
  pic.style.width = `${w0}px`; // the app's CSS gives bare SVGs an icon size; the attributes alone lose to it
  pic.style.height = `${h0}px`;

  const ov = document.createElement('div');
  ov.className = 'zoom-view';
  ov.innerHTML = `<div class="zv-stage"></div>
    <div class="zv-bar">
      <button data-z="out" title="Zoom out (−)">−</button>
      <button data-z="fit" class="zv-pct" title="Fit to window (0)">100%</button>
      <button data-z="in" title="Zoom in (+)">+</button>
      <button data-z="close" title="Close (Esc)">×</button>
    </div>`;
  const stage = ov.querySelector('.zv-stage');
  const pct = ov.querySelector('.zv-pct');
  stage.append(pic);
  document.body.append(ov);

  let scale = 1, x = 0, y = 0;
  const apply = () => {
    pic.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    scale = Math.min((r.width - 48) / w0, (r.height - 48) / h0, 4);
    x = (r.width - w0 * scale) / 2;
    y = (r.height - h0 * scale) / 2;
    apply();
  };
  // Zoom keeping the point (cx, cy) of the stage under the pointer.
  const zoomAt = (factor, cx, cy) => {
    const s = Math.min(Math.max(scale * factor, 0.1), 20);
    x = cx - (cx - x) * (s / scale);
    y = cy - (cy - y) * (s / scale);
    scale = s;
    apply();
  };
  const center = (f) => { const r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { // trackpad pinch arrives as ctrl + wheel
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-Math.max(-25, Math.min(25, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else { x -= e.deltaX; y -= e.deltaY; apply(); }
  }, { passive: false });

  let drag = null, moved = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { px: e.clientX, py: e.clientY, x, y };
    moved = false;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    x = drag.x + dx; y = drag.y + dy;
    apply();
  });
  stage.addEventListener('pointerup', (e) => {
    stage.classList.remove('dragging');
    const wasDrag = moved;
    drag = null;
    // A plain click on the empty background closes; a click on the diagram does nothing.
    if (!wasDrag && !pic.contains(e.target)) close();
  });
  stage.addEventListener('dblclick', (e) => {
    const r = stage.getBoundingClientRect();
    zoomAt(2, e.clientX - r.left, e.clientY - r.top);
  });

  ov.querySelector('.zv-bar').addEventListener('click', (e) => {
    const z = e.target.closest('button')?.dataset.z;
    if (z === 'in') center(1.25);
    else if (z === 'out') center(0.8);
    else if (z === 'fit') fit();
    else if (z === 'close') close();
  });

  const onKey = (e) => {
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === '+' || k === '=') center(1.25);
    else if (k === '-') center(0.8);
    else if (k === '0') fit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);

  function close() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    ov.remove();
    open = null;
  }
  open = { close };
  fit();
}
