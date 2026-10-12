// Generator: src/client/index.jsx → lib/client.js (bundle artifact shipped
// with the plugin). Wraps the esbuild CJS output in the official
// __ModuleLoader__.load contract; only 'react' stays external.
//
// Deliberately NOT external: '@deepseek-ai/dsh-client-ui-primitives' or any
// other Harness Client package (docs/practices forbid requiring them).
// lib/contracts.js is bundled in, because the client mounts its descriptor
// list through ctx.remote.$mount(TYPERT_REMOTE); that pulls zod in as well.
//
// Usage:
//   node scripts/build-client.mjs           # write lib/client.js
//   node scripts/build-client.mjs --check    # fail when committed artifact is stale
import { buildSync } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'src', 'client', 'index.jsx');
const OUTPUT = resolve(ROOT, 'lib', 'client.js');
const PLUGIN_ID = 'dsh-tts-speakout';

export function generate({ check = false } = {}) {
  for (const [path, hint] of [
    [ENTRY, 'src/client/index.jsx is missing'],
    [resolve(ROOT, 'lib', 'contracts.js'), 'the host wire contracts (lib/contracts.js) must exist and export TYPERT_REMOTE'],
  ]) {
    if (!existsSync(path)) {
      console.error(`[build-client] ${hint} — cannot bundle ${path}`);
      process.exit(1);
    }
  }
  let result;
  try {
    result = buildSync({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      // React comes from the browser module table. Everything else (the zod
      // contracts) is bundled, so no Harness Client package is imported.
      external: ['react'],
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      write: false,
      logLevel: 'silent',
    });
  } catch (e) {
    const text = String((e && e.message) || e);
    console.error('[build-client] esbuild failed:\n' + text);
    if (/Could not resolve "(esbuild|zod)"/.test(text)) {
      console.error('[build-client] install the build deps first: npm install --no-save esbuild zod');
    }
    process.exit(1);
  }
  const body = result.outputFiles[0].text.replace(/\n$/, '');
  const code = 'window.__ModuleLoader__.load({\n'
    + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
    + '\tfactory: (require) => {\n'
    + '\t\tvar module = { exports: {} };\n'
    + '\t\tvar exports = module.exports;\n'
    + body
    + '\n\t\treturn module.exports;\n'
    + '\t}\n'
    + '});\n';
  if (check) {
    if (!existsSync(OUTPUT)) {
      console.error('[build-client] lib/client.js is missing — run: node scripts/build-client.mjs');
      process.exit(1);
    }
    const committed = readFileSync(OUTPUT, 'utf8');
    if (committed !== code) {
      console.error('[build-client] lib/client.js is stale — run: node scripts/build-client.mjs');
      process.exit(1);
    }
    console.log('[build-client] lib/client.js is fresh (--check OK)');
    return;
  }
  writeFileSync(OUTPUT, code);
  console.log('[build-client] lib/client.js generated (' + code.length + ' bytes)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generate({ check: process.argv.includes('--check') });
}
