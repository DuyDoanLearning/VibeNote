// Swagger docs for OpenAPI specs: the official Swagger UI (dist/swagger, loaded lazily), live-updated from the editor.
// "Try it out" requests go through main.js (http:request), so browser CORS rules don't block them. Tokens entered
// under Authorize are kept in memory only (per spec, while VibeNote is open) — never saved to disk.
import { load as loadYaml } from 'js-yaml';

let swaggerP = null;
function loadSwagger() {
  return (swaggerP ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'dist/swagger/swagger-ui.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = 'dist/swagger/swagger-ui-bundle.js';
    s.onload = () => resolve(window.SwaggerUIBundle);
    s.onerror = () => reject(new Error('Could not load Swagger UI'));
    document.head.append(s);
  }));
}

// The Reference view (Scalar) runs in its own frame: Scalar picks its layout from the window width, so in a frame it
// sees the pane's real width (and its styles stay out of VibeNote). Same origin, so VibeNote passes it the fetch
// function that sends requests through the main process.
function scalarFrame(host) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.className = 'ref-frame';
    // System fonts, so Scalar never tries to download its own (fonts.scalar.com — blocked anyway).
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%}'
      + ':root{--scalar-font:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",sans-serif;--scalar-font-code:ui-monospace,"SF Mono",Menlo,monospace}</style>'
      + '<script src="dist/scalar/standalone.js"></script></head><body><div id="app"></div></body></html>';
    frame.addEventListener('load', () => (frame.contentWindow.Scalar ? resolve(frame) : reject(new Error('Could not load the Reference view'))), { once: true });
    host.append(frame);
  });
}

const VIEW_KEY = 'vibe.apiView';
const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === 'reference' ? 'reference' : 'swagger'; } catch { return 'swagger'; } };

/** Parse a spec (YAML or JSON) → { spec } or { error: { message, line } } (line is 1-based). */
export function parseSpec(text) {
  try {
    const spec = loadYaml(text);
    if (!spec || typeof spec !== 'object') return { error: { message: 'The spec is empty.', line: 1 } };
    if (!spec.openapi && !spec.swagger) return { error: { message: 'Missing “openapi: 3.x” (or “swagger: 2.0”) at the top.', line: 1 } };
    return { spec };
  } catch (e) {
    return { error: { message: e.reason || e.message, line: (e.mark?.line ?? 0) + 1 } };
  }
}

export const looksLikeOpenApi = (text) => /^\s*["']?(openapi|swagger)["']?\s*:/m.test(String(text).slice(0, 4000));

// fetch() replacement for Swagger's requests: hand them to the main process.
// What kind of object this is, also for objects made in another window (the Reference frame), where instanceof fails.
const kindOf = (x) => Object.prototype.toString.call(x).slice(8, -1);

// fetch() replacement for Swagger's / Scalar's requests: hand them to the main process. `realm` is the window whose
// Response type the caller expects (the Reference view runs in a frame).
function proxyFetch(api, realm = window) {
  return async (input, init = {}) => {
    if (input && typeof input === 'object' && kindOf(input) === 'Request') {
      init = { method: input.method, headers: input.headers, body: /^(GET|HEAD)$/i.test(input.method) ? undefined : await input.arrayBuffer(), ...init };
      input = input.url;
    }
    let url = String(input);
    // Scalar can route requests through its cloud proxy (?scalar_url=…). Never do that: call the real address.
    try { const u = new URL(url); if (u.searchParams.has('scalar_url')) url = u.searchParams.get('scalar_url'); } catch {}
    const h = init.headers;
    const headers = h && typeof h.forEach === 'function' && kindOf(h) === 'Headers'
      ? (() => { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; })()
      : Object.fromEntries(new Headers(h || {}).entries());
    let body;
    const b = init.body;
    const k = b == null ? '' : kindOf(b);
    if (b == null) body = undefined;
    else if (typeof b === 'string') body = { type: 'text', data: b };
    else if (k === 'URLSearchParams') body = { type: 'text', data: b.toString() };
    else if (k === 'FormData') {
      const parts = [];
      for (const [name, value] of b.entries()) {
        if (typeof value === 'object' && (kindOf(value) === 'File' || kindOf(value) === 'Blob')) parts.push({ name, file: { name: value.name || 'file', type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) } });
        else parts.push({ name, value: String(value) });
      }
      body = { type: 'form', parts };
    } else if (k === 'Blob' || k === 'File') body = { type: 'bytes', data: new Uint8Array(await b.arrayBuffer()) };
    else if (k === 'ArrayBuffer') body = { type: 'bytes', data: new Uint8Array(b) };
    else if (ArrayBuffer.isView(b) || /Array$/.test(k)) body = { type: 'bytes', data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
    else body = { type: 'text', data: String(b) };
    if (/^https:\/\/spec\.vibenote\.local\//.test(url)) throw new realm.TypeError('This spec has no full server address. Add one under “servers”, e.g. “- url: https://api.example.com”.');
    const r = await api.http.request({ method: (init.method || 'GET').toUpperCase(), url, headers, body });
    if (r.error) throw new realm.TypeError(r.error);
    const empty = [101, 204, 205, 304].includes(r.status) || /^HEAD$/i.test(init.method || '');
    return new realm.Response(empty ? null : new realm.Uint8Array(r.body), { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

// Swagger resolves $refs against the spec's address. Inside the app that would be a file:// page, which its resolver
// can't read ("Could not resolve reference … file:///…"). A web-style base keeps '#/components/…' refs inside the
// document. Relative server URLs would point here too, so the request proxy explains that case.
const SPEC_BASE = 'https://spec.vibenote.local/openapi.yaml';

/**
 * Swagger docs in `container`. show(key, text) renders/updates; key identifies the spec (e.g. the file path) so
 * authorizations survive edits and switching back and forth (memory only).
 */
export function createApiDocs({ api, container, onJump = () => {}, isDark = () => false }) {
  const auths = new Map(); // key → authorized state (in memory only)
  let ui = null;
  let curKey = null;
  let lastText = null;
  let mounting = null;
  let view = savedView();
  let ref = null; // Scalar app (Reference view)
  let refTimer = null;

  container.classList.add('apidocs');
  container.innerHTML = `<div class="api-viewbar"><div class="seg"><button data-v="swagger">Swagger</button><button data-v="reference">Reference</button></div></div>
    <div class="api-error" hidden></div><div class="api-ui"></div>`;
  const errBox = container.querySelector('.api-error');
  const host = container.querySelector('.api-ui');
  const markView = () => {
    container.classList.toggle('view-reference', view === 'reference');
    container.querySelectorAll('.api-viewbar button').forEach((b) => b.classList.toggle('active', b.dataset.v === view));
  };
  markView();
  container.querySelectorAll('.api-viewbar button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.v === view) return;
    view = b.dataset.v;
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
    markView();
    const key = curKey, text = lastText;
    unmount();
    if (text != null) show(key, text);
  }));

  // Private, offline settings: no Scalar cloud proxy, telemetry, AI agent, MCP or web fonts; requests go through VibeNote.
  const refConfig = (text) => ({
    content: text,
    proxyUrl: '',
    telemetry: false,
    agent: { disabled: true },
    mcp: { disabled: true },
    withDefaultFonts: false,
    documentDownloadType: 'none',
    hideDarkModeToggle: true,
    forceDarkModeState: isDark() ? 'dark' : 'light',
    darkMode: isDark(),
    layout: 'modern',
    defaultOpenAllTags: true,
  });

  let frame = null;
  // Plain settings re-created in the frame's realm; the fetch function is passed across as is.
  function inFrame(cfg) {
    const w = frame.contentWindow;
    const c = w.JSON.parse(JSON.stringify(cfg));
    c.customFetch = proxyFetch(api, w);
    return c;
  }

  function unmount() {
    remember();
    try { ref?.destroy?.(); } catch {}
    ref = null;
    frame = null;
    ui = null;
    host.textContent = '';
    curKey = null;
    lastText = null;
  }

  async function showReference(key, text) {
    if (ref && key === curKey) {
      clearTimeout(refTimer);
      refTimer = setTimeout(() => { try { ref.updateConfiguration(inFrame(refConfig(text))); } catch {} }, 350);
      return;
    }
    unmount();
    curKey = key;
    frame = await scalarFrame(host);
    ref = frame.contentWindow.Scalar.createApiReference(frame.contentDocument.getElementById('app'), inFrame(refConfig(text)));
  }
  errBox.addEventListener('click', () => { if (errBox.dataset.line) onJump(+errBox.dataset.line); });

  const plugin = () => ({
    statePlugins: {
      spec: { wrapActions: { executeRequest: (ori) => (req) => ori({ ...req, userFetch: proxyFetch(api) }) } },
    },
  });

  function remember() {
    try { if (ui && curKey != null) auths.set(curKey, ui.authSelectors.authorized().toJS()); } catch {}
  }

  async function mount(key, spec) {
    const SwaggerUIBundle = await loadSwagger();
    remember();
    host.textContent = '';
    const node = document.createElement('div');
    host.append(node);
    ui = SwaggerUIBundle({
      domNode: node,
      deepLinking: false,
      persistAuthorization: false,
      displayRequestDuration: true,
      tryItOutEnabled: false,
      defaultModelsExpandDepth: 1,
      docExpansion: 'list',
      filter: false,
      syntaxHighlight: { activated: true, theme: 'agate' },
      presets: [SwaggerUIBundle.presets.apis],
      plugins: [plugin],
      layout: 'BaseLayout',
    });
    ui.specActions.updateUrl(SPEC_BASE);
    ui.specActions.updateSpec(JSON.stringify(spec));
    curKey = key;
    const saved = auths.get(key);
    if (saved && Object.keys(saved).length) setTimeout(() => { try { ui.authActions.authorize(saved); } catch {} }, 0);
  }

  async function show(key, text) {
    if (key === curKey && text === lastText) return;
    if (view === 'reference') {
      const r = parseSpec(text);
      errBox.hidden = !r.error;
      if (r.error) {
        errBox.dataset.line = r.error.line;
        errBox.textContent = `⚠️ Line ${r.error.line}: ${r.error.message}  — click to jump there.`;
        lastText = text;
        return;
      }
      await showReference(key, text);
      lastText = text;
      return;
    }
    lastText = text;
    const r = parseSpec(text);
    if (r.error) {
      errBox.hidden = false;
      errBox.dataset.line = r.error.line;
      errBox.textContent = `⚠️ Line ${r.error.line}: ${r.error.message}  — click to jump there. The docs below show the last version that worked.`;
      if (key !== curKey) { host.textContent = ''; curKey = key; ui = null; }
      return;
    }
    errBox.hidden = true;
    if (key !== curKey || !ui) {
      mounting = mount(key, r.spec);
      return mounting;
    }
    await mounting;
    remember();
    ui.specActions.updateSpec(text);
    const saved = auths.get(key);
    if (saved && Object.keys(saved).length) try { ui.authActions.authorize(saved); } catch {}
  }

  function clear() {
    unmount();
    errBox.hidden = true;
  }

  // Expand and scroll to an endpoint ("GET /pet/{id}"). Swagger renders asynchronously, so retry for a moment.
  async function focus(frag) {
    const m = /^\s*([a-z]+)\s+(\/\S*)\s*$/i.exec(frag || '');
    if (!m) return false;
    const method = m[1].toLowerCase();
    if (view === 'reference') {
      for (let i = 0; i < 40; i++) {
        const doc = frame?.contentDocument;
        const id = doc && [...doc.querySelectorAll('[id]')].map((e) => e.id).find((x) => x.toLowerCase().includes(`/${method}${m[2].toLowerCase()}`));
        const target = id && doc.querySelector(`[id="${CSS.escape(id)}"]`);
        if (target) { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); return true; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }
    for (let i = 0; i < 40; i++) {
      await mounting;
      const block = [...container.querySelectorAll(`.opblock.opblock-${method}`)].find((b) => b.querySelector('.opblock-summary-path')?.getAttribute('data-path') === m[2]);
      if (block) {
        if (!block.classList.contains('is-open')) (block.querySelector('.opblock-summary-control') || block.querySelector('.opblock-summary'))?.click();
        // open its tag section if it was collapsed
        setTimeout(() => block.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
        block.classList.add('vn-flash');
        setTimeout(() => block.classList.remove('vn-flash'), 1600);
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  return { show, clear, focus };
}
