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
function proxyFetch(api) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    let body;
    const b = init.body;
    if (b == null) body = undefined;
    else if (typeof b === 'string') body = { type: 'text', data: b };
    else if (b instanceof URLSearchParams) body = { type: 'text', data: b.toString() };
    else if (b instanceof FormData) {
      const parts = [];
      for (const [name, value] of b.entries()) {
        if (value instanceof Blob) parts.push({ name, file: { name: value.name || 'file', type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) } });
        else parts.push({ name, value: String(value) });
      }
      body = { type: 'form', parts };
    } else if (b instanceof Blob) body = { type: 'bytes', data: new Uint8Array(await b.arrayBuffer()) };
    else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) body = { type: 'bytes', data: new Uint8Array(b.buffer || b) };
    else body = { type: 'text', data: String(b) };
    if (/^https:\/\/spec\.vibenote\.local\//.test(url)) throw new TypeError('This spec has no full server address. Add one under “servers”, e.g. “- url: https://api.example.com”.');
    const r = await api.http.request({ method: (init.method || 'GET').toUpperCase(), url, headers, body });
    if (r.error) throw new TypeError(r.error);
    const empty = [101, 204, 205, 304].includes(r.status) || /^HEAD$/i.test(init.method || '');
    return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
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
export function createApiDocs({ api, container, onJump = () => {} }) {
  const auths = new Map(); // key → authorized state (in memory only)
  let ui = null;
  let curKey = null;
  let lastText = null;
  let mounting = null;

  container.classList.add('apidocs');
  container.innerHTML = '<div class="api-error" hidden></div><div class="api-ui"></div>';
  const errBox = container.querySelector('.api-error');
  const host = container.querySelector('.api-ui');
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
    remember();
    host.textContent = '';
    errBox.hidden = true;
    ui = null;
    curKey = null;
    lastText = null;
  }

  // Expand and scroll to an endpoint ("GET /pet/{id}"). Swagger renders asynchronously, so retry for a moment.
  async function focus(frag) {
    const m = /^\s*([a-z]+)\s+(\/\S*)\s*$/i.exec(frag || '');
    if (!m) return false;
    const method = m[1].toLowerCase();
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
