// Integration probe: drive the Python worker over NDJSON exactly the way the
// host service does, and report every frame it gets back.
//
//   node scripts/worker-probe.mjs ["要喊的话"]
//
// Env overrides: DSH_TTS_PYTHON, DSH_TTS_MODEL, DSH_TTS_HOME
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const PY = process.env.DSH_TTS_PYTHON || 'D:\\miniconda3\\envs\\qwen3-tts\\python.exe';
const WORKER = join(root, 'python', 'tts_worker.py');
const MODEL = process.env.DSH_TTS_MODEL || 'D:\\qwen3tts\\models\\Qwen3-TTS-12Hz-0.6B-Base';
const HOME = process.env.DSH_TTS_HOME || join(homedir(), '.dsh', 'tts-speakout');
const VOICES = join(HOME, 'voices');

const text = process.argv[2] || '任务已经全部完成了，快回来看看吧。';

console.log('[probe] worker =', WORKER);
console.log('[probe] model  =', MODEL);
console.log('[probe] voices =', VOICES);

const child = spawn(PY, [
  WORKER,
  '--model', MODEL,
  '--voices-dir', VOICES,
  '--data-dir', HOME,
  '--volume', '0.8',
  '--language', 'Chinese',
  '--auto-pick-speaker', 'true',
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      console.log('[RAW ]', line.slice(0, 200));
      continue;
    }
    onFrame(frame);
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  const raw = String(chunk).trim();
  if (raw) console.log('[err ]', raw.split('\n').slice(0, 2).join(' | ').slice(0, 200));
});

const b64d = (value) => {
  try { return Buffer.from(value || '', 'base64').toString('utf8'); } catch { return ''; }
};

const onFrame = (frame) => {
  switch (frame.type) {
    case 'log':
      console.log(`[log:${frame.level}]`, frame.message);
      return;
    case 'playing':
      console.log('[playing]', frame.duration, 's ->', frame.device);
      return;
    case 'played':
      console.log('[played ]', frame.playedMs, 'ms');
      return;
    case 'status':
      console.log('[status] ready=%s device=%s volume=%s voices=%d devices=%d',
        frame.ready, frame.device, frame.volume, frame.voiceCount, (frame.devices || []).length);
      return;
    case 'result':
    case 'error': {
      const resolver = pending.get(frame.id);
      if (resolver) {
        pending.delete(frame.id);
        resolver(frame);
      } else {
        console.log('[frame ]', JSON.stringify(frame).slice(0, 240));
      }
      return;
    }
    default:
      console.log('[frame ]', JSON.stringify(frame).slice(0, 240));
  }
};

function call(op, extra = {}, timeoutMs = 900000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${op}`));
    }, timeoutMs);
    pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n', 'utf8');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

await sleep(2000);

console.log('\n=== 1) status ===');
let res = await call('status');
if (res.ok) {
  const s = res.status;
  console.log('   ready=%s loading=%s devices=%d voices=%d volume=%s',
    s.ready, s.loading, (s.devices || []).length, s.voiceCount, s.volume);
  const pick = (s.devices || []).find((d) => d.suggested);
  if (pick) console.log('   auto-picked:', b64d(pick.name_b64), `[${pick.hostapi}]`);
  console.log('   voices:', (s.voices || []).map((v) => `${v.id}=${b64d(v.title_b64)}`).join(', '));
} else {
  console.log('   FAILED:', res.message);
}

console.log('\n=== 2) speak（合成 + 播放）===');
res = await call('speak', {
  text_b64: Buffer.from(text, 'utf8').toString('base64'),
  volume: 0.8,
});
if (!res.ok) {
  console.log('   FAILED:', res.message);
  console.log(String(res.detail || '').split('\n').slice(-6).join('\n'));
} else {
  console.log('   ok duration=%ss rtf=%s device=%s voice=%s',
    res.duration, res.rtf, res.device, res.voiceId);
  console.log('   file =', res.file_b64 ? b64d(res.file_b64) : res.file);
}

console.log('\n=== 3) 第二次 speak（热路径）===');
res = await call('speak', {
  text_b64: Buffer.from('第二条，验证连续喊话。', 'utf8').toString('base64'),
});
if (!res.ok) {
  console.log('   FAILED:', res.message, res.detail ? String(res.detail).split('\n').slice(-3).join(' ') : '');
} else {
  console.log('   ok duration=%ss rtf=%s playedMs=%s', res.duration, res.rtf, res.playedMs);
}

console.log(`\n=== 总墙钟 ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
await call('shutdown', {}, 15000).catch(() => {});
child.kill();
process.exit(0);
