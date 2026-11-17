// HTML pages: a note saved as .html is shown as a real web page in the preview, live while you type.
// The page runs in a sandboxed frame served through vibe-html:// (main.js → serveHtmlPages). Its scripts run, but
// without allow-same-origin it gets a throw-away origin: it can't reach VibeNote (window.api), your notes or the app
// window. Links to websites open in the browser: the page hands them over (script appended in main.js) and
// window.open goes to the browser (main.js → setWindowOpenHandler).

const SANDBOX = 'allow-scripts allow-popups allow-modals allow-forms';
const pageUrl = (file) => 'vibe-html://page' + file.split('/').map(encodeURIComponent).join('/');

export function createHtmlView({ api, container }) {
  let frame = null;
  let shown = { path: '', text: null };
  let scrollY = 0;
  let seq = 0;
  let timer = null;

  // The page reports where it is scrolled to (a tiny script main.js appends), so a reload keeps the place,
  // and hands over clicked links to websites.
  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    if (typeof e.data?.vibeScroll === 'number') scrollY = e.data.vibeScroll;
    if (typeof e.data?.vibeOpen === 'string' && /^(https?|mailto):/i.test(e.data.vibeOpen)) window.open(e.data.vibeOpen, '_blank');
  });

  async function load(path, text) {
    const n = ++seq;
    try { await api.htmlPreview(path, text); } catch { return; }
    if (n !== seq) return;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'html-frame';
      frame.setAttribute('sandbox', SANDBOX);
      frame.title = 'HTML page preview';
      container.append(frame);
    }
    frame.src = `${pageUrl(path)}?v=${n}&y=${Math.round(scrollY)}`;
  }

  return {
    // Show the page; reloads only when the text changed. Typing reloads after a short pause (scripts start over).
    show(path, text) {
      if (path === shown.path && text === shown.text) return;
      const first = path !== shown.path;
      if (first) scrollY = 0;
      shown = { path, text };
      clearTimeout(timer);
      if (first) load(path, text);
      else timer = setTimeout(() => load(path, text), 400);
    },
    // Reload the page as it is now (e.g. after changing a picture or script file next to it).
    reload() { if (shown.path) load(shown.path, shown.text); },
    clear() {
      clearTimeout(timer);
      seq++;
      shown = { path: '', text: null };
      scrollY = 0;
      frame?.remove();
      frame = null;
    },
  };
}
