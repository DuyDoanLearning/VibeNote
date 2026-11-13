// Links between notes, Confluence pages and API specs: [[Title]], [[Title#Heading]], [[Spec#GET /path]].
// Helpers shared by the preview, the editor's [[ autocomplete, backlinks and the Swagger deep links.
import { load as loadYaml } from 'js-yaml';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/** "Title#fragment" → { title, frag } */
export function splitTarget(target) {
  const t = String(target);
  const i = t.indexOf('#');
  return i < 0 ? { title: t.trim(), frag: '' } : { title: t.slice(0, i).trim(), frag: t.slice(i + 1).trim() };
}

/** "GET /pet/{id}" → { method: 'get', path: '/pet/{id}' } (or null) */
export function parseOperation(frag) {
  const m = /^\s*([a-z]+)\s+(\/\S*)\s*$/i.exec(frag || '');
  return m && METHODS.includes(m[1].toLowerCase()) ? { method: m[1].toLowerCase(), path: m[2] } : null;
}

/** Endpoints of an OpenAPI spec (YAML or JSON text): [{ method: 'GET', path, summary }] */
export function apiOperations(text) {
  let spec;
  try { spec = loadYaml(text); } catch { return []; }
  const out = [];
  for (const [p, item] of Object.entries(spec?.paths || {})) {
    for (const m of METHODS) if (item && item[m]) out.push({ method: m.toUpperCase(), path: p, summary: item[m].summary || item[m].operationId || '' });
  }
  return out;
}

const OPENAPI_BLOCK = /```(?:ya?ml|json)[^\n]*\n([\s\S]*?)\n```/g;
const looksLikeOpenApi = (text) => /^\s*["']?(openapi|swagger)["']?\s*:/m.test(String(text).slice(0, 4000));

/** OpenAPI specs written as ```yaml / ```json blocks inside a Markdown note. */
export function embeddedSpecs(body) {
  const out = [];
  for (const m of String(body).matchAll(OPENAPI_BLOCK)) if (looksLikeOpenApi(m[1])) out.push(m[1]);
  return out;
}

/** Markdown headings (outside code fences): [{ level, text }] */
export function mdHeadings(body) {
  const out = [];
  let fence = false;
  for (const line of String(body).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, '') });
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `body` link to the note titled `title` (or a Confluence page id)? */
export function linksTo(body, title, confluenceId) {
  if (title && new RegExp(`\\[\\[\\s*${escRe(title)}\\s*(#[^\\]|\\n]*)?(\\|[^\\]\\n]*)?\\]\\]`, 'i').test(body)) return true;
  return !!confluenceId && new RegExp(`atlassian\\.net/wiki/[^\\s)]*/pages/${confluenceId}(?!\\d)`).test(body);
}
