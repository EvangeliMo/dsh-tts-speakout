// Standalone verification of the host's preview path.
//
// Loads the real service class, invokes `testVoice` exactly as the settings page
// does, and reports what happened. This exists because a host-module change only
// takes effect after a DSH restart, so waiting for a restart to discover whether
// the preview works wastes the user's time.
//
//   node scripts/probe-preview.mjs [voiceId]
import { Context } from '@deepseek-ai/cordis';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Windows absolute paths must become file:// URLs before dynamic import.
const { default: Service, PLAYER_SCRIPT, WORKER_SCRIPT } = await import(
  pathToFileURL(join(root, 'lib', 'index.js')).href
);

console.log('[probe] service     :', Service?.name || '(class)');
console.log('[probe] worker      :', WORKER_SCRIPT);
console.log('[probe] player      :', PLAYER_SCRIPT);
console.log('[probe] player exists:', existsSync(PLAYER_SCRIPT));

const ctx = new Context();
const svc = new Service(ctx, {});

const voiceId = process.argv[2] || '';
console.log('\n=== testVoice(%s) ===', voiceId || '(default)');
const started = Date.now();
let res;
try {
  res = await svc.testVoice(voiceId, '这是一次试听，用于确认音色、音量与输出通道。');
} catch (err) {
  console.log('THREW:', err && err.message ? err.message : err);
  process.exit(1);
}
console.log(JSON.stringify(res, null, 2));
console.log('wall seconds:', ((Date.now() - started) / 1000).toFixed(1));

if (res && res.ok) {
  console.log('\nRESULT: 试听成功 ->', res.device, '| 音量', res.volume, '| 时长', res.durationSeconds);
} else {
  console.log('\nRESULT: 试听失败 ->', (res && res.message) || 'unknown');
}

try { await svc.shutdown(); } catch { /* noop */ }
process.exit(res && res.ok ? 0 : 2);
