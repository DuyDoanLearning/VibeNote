// Bundles the renderer and copies runtime assets (KaTeX, Mermaid) into dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// ---------- draw.io editor (Apache-2.0, github.com/jgraph/drawio) ----------
// The web app is not in this repo: the pinned release is downloaded once into the user's cache folder, checked
// against its SHA-256, and unpacked into dist/drawio without the parts VibeNote doesn't use.
const DRAWIO = { version: 'v32.6.10', sha256: 'a57b06b3b6a876a351dacfe65d027d9509319cd030e9bacf6ae04a034d66a38f' };
async function bundleDrawio() {
  const out = 'dist/drawio';
  const marker = path.join(out, '.vibenote-version');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === DRAWIO.version) return;
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'VibeNote');
  const war = path.join(cacheDir, `drawio-${DRAWIO.version}.war`);
  const sum = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  if (!existsSync(war) || sum(war) !== DRAWIO.sha256) {
    mkdirSync(cacheDir, { recursive: true });
    console.log(`Downloading the draw.io editor ${DRAWIO.version} (about 50 MB, once)…`);
    const res = await fetch(`https://github.com/jgraph/drawio/releases/download/${DRAWIO.version}/draw.war`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(war, Buffer.from(await res.arrayBuffer()));
    if (sum(war) !== DRAWIO.sha256) { rmSync(war); throw new Error('the downloaded file does not match the expected checksum'); }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-q', '-o', war, '-d', out]);
  // Not needed for the embedded editor: server parts, dev sources, the stand-alone viewers, online integrations.
  for (const p of ['WEB-INF', 'META-INF', 'js/integrate.min.js', 'js/viewer.min.js', 'js/viewer-static.min.js', 'js/diagramly', 'js/grapheditor',
    'service-worker.js', 'service-worker.js.map', 'workbox-05b6c01b.js', 'workbox-05b6c01b.js.map', 'connect', 'teams.html', 'onedrive3.html',
    'monday-app-association.json']) rmSync(path.join(out, p), { recursive: true, force: true });
  for (const f of readdirSync(path.join(out, 'resources'))) {
    if (!/^dia(_vi|_en)?\.txt$/.test(f)) rmSync(path.join(out, 'resources', f), { force: true }); // keep English + Vietnamese
  }
  writeFileSync(marker, DRAWIO.version);
}
try { await bundleDrawio(); } catch (e) { console.warn(`⚠ draw.io editor not bundled (${e.message}). Diagrams will not open in this build.`); }

// ---------- PDF viewer (pdf.js, Apache-2.0, github.com/mozilla/pdf.js) ----------
// The full viewer (search, thumbnails, highlight / draw / comment tools) from the pinned release, checked against its
// SHA-256, cached like draw.io and unpacked into dist/pdfjs. Served by main.js through vibe-pdf://.
const PDFJS = { version: '6.5.438', sha256: 'fcbe9ba21d9911843e3502adc178a7f549a524a4055f887bedc942e5490c6ba1' };
async function bundlePdfjs() {
  const out = 'dist/pdfjs';
  const marker = path.join(out, '.vibenote-version');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === PDFJS.version) return;
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'VibeNote');
  const zip = path.join(cacheDir, `pdfjs-${PDFJS.version}-dist.zip`);
  const sum = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  if (!existsSync(zip) || sum(zip) !== PDFJS.sha256) {
    mkdirSync(cacheDir, { recursive: true });
    console.log(`Downloading the PDF viewer (pdf.js ${PDFJS.version}, about 7 MB, once)…`);
    const res = await fetch(`https://github.com/mozilla/pdf.js/releases/download/v${PDFJS.version}/pdfjs-${PDFJS.version}-dist.zip`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    if (sum(zip) !== PDFJS.sha256) { rmSync(zip); throw new Error('the downloaded file does not match the expected checksum'); }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', out]);
  // Not needed: source maps, the debugger, the sample PDF, and the engine for scripts inside PDFs (switched off).
  for (const p of ['web/debugger.mjs', 'web/debugger.css', 'web/compressed.tracemonkey-pldi-09.pdf', 'build/pdf.sandbox.mjs',
    'web/wasm/quickjs-eval.js', 'web/wasm/quickjs-eval.wasm']) rmSync(path.join(out, p), { force: true });
  for (const dir of ['web', 'build']) {
    for (const f of readdirSync(path.join(out, dir))) if (f.endsWith('.map')) rmSync(path.join(out, dir, f), { force: true });
  }
  writeFileSync(marker, PDFJS.version);
}
try { await bundlePdfjs(); } catch (e) { console.warn(`⚠ PDF viewer not bundled (${e.message}). PDFs will not open in this build.`); }


mkdirSync('dist/katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', 'dist/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'dist/katex/fonts', { recursive: true });
writeFileSync('dist/katex/version.txt', JSON.parse(readFileSync('node_modules/katex/package.json', 'utf8')).version);
cpSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/mermaid.min.js');
// Swagger UI (Apache-2.0) for API specs — loaded lazily like Mermaid.
mkdirSync('dist/swagger', { recursive: true });
cpSync('node_modules/swagger-ui-dist/swagger-ui-bundle.js', 'dist/swagger/swagger-ui-bundle.js');
cpSync('node_modules/swagger-ui-dist/swagger-ui.css', 'dist/swagger/swagger-ui.css');
cpSync('node_modules/swagger-ui-dist/LICENSE', 'dist/swagger/LICENSE');
// Scalar API reference (MIT) — the "Reference" view for API specs.
mkdirSync('dist/scalar', { recursive: true });
cpSync('node_modules/@scalar/api-reference/dist/browser/standalone.js', 'dist/scalar/standalone.js');
writeFileSync('dist/scalar/LICENSE.txt', 'Scalar API Reference (@scalar/api-reference): MIT License, https://github.com/scalar/scalar\n');

await build({
  entryPoints: ['src/renderer.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: 'dist/renderer.js',
  logLevel: 'info',
});

// Main-process agent host: the Claude Agent SDK bundled in (we use the user's installed Claude Code binary,
// so the SDK's own 300 MB platform binary is not shipped).
await build({
  entryPoints: ['src-main/agent.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/agent.mjs',
  external: ['electron'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// Main-process Atlassian connection (MCP client + OAuth), bundled the same way.
await build({
  entryPoints: ['src-main/atlassian.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/atlassian.mjs',
  external: ['electron'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
