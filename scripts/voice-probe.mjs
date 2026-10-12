// One-shot voice reproduction probe: create a preset from a reference clip and
// ask the worker to speak with it, so the Lead can judge the clone directly.
//
//   node scripts/voice-probe.mjs <refAudio> <title> <refText> <textToSpeak> [mode]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const [refAudio, title, refText, speakText, mode = 'icl'] = process.argv.slice(2);
if (!refAudio || !title || !speakText) {
  console.error('usage: node scripts/voice-probe.mjs <refAudio> <title> <refText> <text> [icl|xvec]');
  process.exit(2);
}

const PY = process.env.DSH_TTS_PYTHON || 'D:\\miniconda3\\envs\\qwen3-tts\\python.exe';
const HOME = join(homedir(), '.dsh', 'tts-speakout');
const VOICES = join(HOME, 'voices');

// Build the preset the same way the host's importVoice does, so the worker sees
// exactly what it would see after a real UI import.
const id = 'anjielina';
const dir = join(VOICES, id);
mkdirSync(dir, { recursive: true });
copyFileSync(refAudio, join(dir, 'ref.wav'));
writeFileSync(join(dir, 'voice.json'), JSON.stringify({
  id,
  title,
  refText,
  mode,
  language: 'Chinese',
  refFile: 'ref.wav',
  createdAt: new Date().toISOString(),
}, null, 2), 'utf8');
writeFileSync(join(HOME, 'config.json'), JSON.stringify({
  defaultVoice: id,
  volume: 0.7,
  device: '',
  autoPickSpeaker: true,
}, null, 2), 'utf8');
console.log(`[probe] preset "${title}" (${mode}) ->`, dir);

const child = spawn(PY, [
  join(root, 'python', 'tts_worker.py'),
  '--model', process.env.DSH_TTS_MODEL || 'D:\\qwen3tts\\models\\Qwen3-TTS-12Hz-0.6B-Base',
  '--voices-dir', VOICES,
  '--data-dir', HOME,
  '--volume', '0.7',
  '--language', 'Chinese',
  '--auto-pick-speaker', 'true',
], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });

let buffer = '';
const pending = new Map();
let nextId = 1;
const b64d = (v) => { try { return Buffer.from(v || '', 'base64').toString('utf8'); } catch { return ''; } };

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === 'log') { console.log(`[log:${frame.level}]`, frame.message); continue; }
    if (frame.type === 'playing') { console.log('[playing]', frame.duration, 's ->', frame.device); continue; }
    if (frame.type === 'played') { console.log('[played ]', frame.playedMs, 'ms'); continue; }
    if (frame.type === 'result' || frame.type === 'error') {
      const r = pending.get(frame.id);
      // The startup status frame has no id: keep it as a diagnostic.
      if (!r) { console.log('[startup]', frame.ok ? 'status frame received' : frame.message); continue; }
      pending.delete(frame.id);
      r(frame);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  const t = String(c).trim();
  if (t && !/SoX|sox|pad_token_id/.test(t)) console.log('[err ]', t.slice(0, 160));
});

const call = (op, extra = {}, timeoutMs = 900000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${op}`)); }, timeoutMs);
  pending.set(id, (f) => { clearTimeout(timer); resolve(f); });
  child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n', 'utf8');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

const st = await call('status');
if (st.ok) {
  console.log('[status] defaultVoice=%s voices=%d device=%s',
    st.status.defaultVoiceId, st.status.voiceCount, st.status.device);
  for (const v of st.status.voices || []) {
    console.log(`         voice ${v.id} "${b64d(v.title_b64)}" mode=${v.mode} lang=${v.language} hasRefText=${v.hasRefText}`);
  }
}

console.log('\n=== speak with the cloned voice ===');
const res = await call('speak', {
  text_b64: Buffer.from(speakText, 'utf8').toString('base64'),
  voice_id: id,
  volume: 0.7,
});
if (!res.ok) {
  console.log('FAILED:', res.message);
  console.log(String(res.detail || '').split('\n').slice(-8).join('\n'));
} else {
  console.log('ok duration=%ss rtf=%s voice=%s device=%s', res.duration, res.rtf, res.voiceId, res.device);
  console.log('file =', b64d(res.file_b64) || res.file);
}

await call('shutdown', {}, 15000).catch(() => {});
child.kill();
process.exit(0);
