// Bundles the renderer and copies runtime assets (KaTeX, Mermaid) into dist/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist/katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', 'dist/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'dist/katex/fonts', { recursive: true });
writeFileSync('dist/katex/version.txt', JSON.parse(readFileSync('node_modules/katex/package.json', 'utf8')).version);
cpSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/mermaid.min.js');

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
