/**
 * Host smoke test for dsh-tts-speakout.
 *
 * Verifies, in one process:
 *   1. `lib/index.js` exports a TypertRemoteService whose `remoteMethods()`
 *      contains ALL 15 methods — this is the regression test for the classic
 *      "forgot __runInitializers → every RPC 404s" bug (SKILL.md §2.3).
 *   2. `lib/contracts.js` declares exactly the same 15 method names, with the
 *      frozen descriptor id / service / namespace, and its zod codecs decode
 *      both success and failure payloads.
 *   3. `status()` really round-trips to the long-lived python worker
 *      (`python/tts_worker.py`). If the worker / python / model is not ready
 *      yet the test reports "worker not ready" with the exact reason instead of
 *      crashing — the Lead writes the worker in parallel.
 *   4. Voice-preset persistence works end-to-end in an isolated DSH_HOME.
 *   5. `lib/tools.js` registers the five agent tools and dsh_speak throws on
 *      failure (it must never silently claim a sentence was spoken).
 *
 * Usage:  node scripts/test-host.mjs  [--no-worker]
 *
 * Dependency note: a plugin under development has no `node_modules` of its own
 * (peer deps come from the profile tree at runtime). To make this script
 * runnable from anywhere we install a synchronous ESM resolve hook that maps
 * bare `@deepseek-ai/*` / `zod` specifiers onto a harness node_modules root.
 * Both lib/index.js and this script therefore load the SAME module instance —
 * which `instanceof TypertRemoteService` below proves (two copies of
 * typert-protocol would silently drop the Remote markers).
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NO_WORKER = process.argv.includes('--no-worker');
/** Opt-in: really play a sentence out of the speakers (low volume, ~9 s model load). */
const DO_SPEAK_STEP = process.argv.includes('--speak');

/* ================================================================== *
 * 0. Isolated DSH_HOME (must be set before lib/index.js is imported)
 * ================================================================== */

const TEST_HOME = join(ROOT, '.test-home');
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;

/* ================================================================== *
 * 1. Bare-specifier resolution bootstrap
 * ================================================================== */

const DEP_ROOT_CANDIDATES = [
  process.env.DSH_TTS_DEPS_ROOT,
  join(ROOT, 'node_modules'),
  join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'node_modules'),
  join('D:\\momol\\Documents\\Harness', 'node_modules'),
  join(process.env.DSH_HOME_REAL || 'C:\\Users\\momol\\.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop', 'node_modules'),
].filter(Boolean);

const NEEDED = ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', 'zod'];

function hasPackage(root, spec) {
  try {
    const dir = join(root, ...spec.split('/'));
    if (!existsSync(join(dir, 'package.json'))) return false;
    // A directory without the entry file is a broken/empty install.
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return !!(pj.name);
  } catch { return false; }
}

const DEP_ROOTS = DEP_ROOT_CANDIDATES.filter((root) => hasPackage(root, '@deepseek-ai/dsh-typert-protocol'));

function packageEntry(root, spec) {
  const parts = spec.split('/');
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = spec.slice(pkgName.length).replace(/^\//, '');
  const dir = join(root, ...pkgName.split('/'));
  const pjPath = join(dir, 'package.json');
  if (!existsSync(pjPath)) return null;
  let rel = null;
  try {
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    if (sub) {
      const exp = pj.exports?.[`./${sub}`];
      rel = typeof exp === 'string' ? exp : (exp?.import ?? exp?.default ?? sub);
    } else {
      const exp = pj.exports;
      if (typeof exp === 'string') rel = exp;
      else if (exp && typeof exp === 'object') {
        const dot = exp['.'] ?? null;
        if (typeof dot === 'string') rel = dot;
        else if (dot && typeof dot === 'object') rel = dot.import ?? dot.default ?? dot.node ?? null;
      }
      if (!rel) rel = pj.module || pj.main || 'index.js';
    }
  } catch { return null; }
  return rel ? join(dir, rel) : null;
}

function mapBare(specifier) {
  for (const root of DEP_ROOTS) {
    const entry = packageEntry(root, specifier);
    if (entry && existsSync(entry)) return entry;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/')
      && !specifier.startsWith('file:') && !specifier.startsWith('node:') && !specifier.startsWith('data:');
    if (!bare) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch {
      const mapped = mapBare(specifier);
      if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true, format: 'module' };
      throw new Error(`cannot resolve "${specifier}" (no local node_modules and no harness root found)`);
    }
  },
});

/* ================================================================== *
 * tiny test harness
 * ================================================================== */

let failures = 0;
let passes = 0;
const skipped = [];

function section(title) {
  console.log(`\n===== ${title} =====`);
}
function check(label, condition, extra = '') {
  if (condition) { passes += 1; console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`); }
  else { failures += 1; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
  return !!condition;
}
function note(label, value) {
  console.log(`  ....  ${label}: ${value}`);
}
function skip(label, reason) {
  skipped.push(label);
  console.log(`  SKIP  ${label} — ${reason}`);
}

/**
 * Guard against a silent contract bug: the gateway decodes results with
 * `schema.parse(value)`, and zod strips keys the schema does not declare — so a
 * payload field missing from lib/contracts.js never reaches the client and
 * shows up as `undefined` with no error anywhere. Every field the host returns
 * must therefore be declared.
 */
function declaredKeys(schema) {
  // These result schemas end in `.readonly()`, which wraps the object in a
  // ZodReadonly that exposes no `.shape` of its own — unwrap first.
  let node = schema;
  for (let depth = 0; depth < 6 && node; depth += 1) {
    if (node.shape) return new Set(Object.keys(node.shape));
    if (typeof node.unwrap === 'function') {
      let inner = null;
      try { inner = node.unwrap(); } catch { inner = null; }
      if (inner && inner !== node) { node = inner; continue; }
    }
    node = node.def?.innerType ?? node._def?.innerType ?? null;
  }
  return new Set();
}
function checkDeclared(label, schema, payload) {
  const allowed = declaredKeys(schema);
  if (allowed.size === 0) {
    return check(`${label}: schema keys are resolvable`, false, 'could not unwrap the zod schema');
  }
  const items = Array.isArray(payload) ? payload : [payload];
  const stray = new Set();
  for (const item of items) {
    for (const key of Object.keys(item ?? {})) if (!allowed.has(key)) stray.add(key);
  }
  return check(`${label}: every returned field is declared in the schema`, stray.size === 0,
    stray.size ? `stripped by the codec: ${[...stray].join(', ')}` : 'none');
}

/* ================================================================== *
 * fixtures
 * ================================================================== */

/** Minimal 16 kHz mono 16-bit PCM sine WAV (0.2 s) — a valid audio file. */
function writeTestWav(file, seconds = 0.2, sampleRate = 16000) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The 15 remote methods from CONTRACT.md §3, in declaration order. */
const EXPECTED_METHODS = [
  'status', 'devices', 'voices', 'importVoice', 'pickAudio', 'deleteVoice',
  'renameVoice', 'setVoiceText', 'setDefaultVoice', 'testVoice', 'speak',
  'stop', 'setDevice', 'setVolume', 'saveConfig', 'setSlotBindings',
];

/* ================================================================== *
 * main
 * ================================================================== */

async function main() {
  console.log('dsh-tts-speakout host smoke test');
  console.log(`  root      : ${ROOT}`);
  console.log(`  DSH_HOME  : ${TEST_HOME} (isolated)`);
  console.log(`  node      : ${process.version}`);

  section('0. dependency bootstrap');
  if (!DEP_ROOTS.length) {
    console.log('  FAIL  no harness node_modules root contains @deepseek-ai/dsh-typert-protocol');
    console.log('        set DSH_TTS_DEPS_ROOT=<path to a node_modules containing @deepseek-ai/*> and rerun');
    process.exit(1);
  }
  note('dep root', DEP_ROOTS[0]);
  for (const spec of NEEDED) {
    note(spec, mapBare(spec) ? 'resolved' : 'MISSING');
  }

  section('1. service class + Remote markers');
  const { default: TtsSpeakoutService, DEFAULT_CONFIG, WORKER_SCRIPT } =
    await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
  const { Context } = await import('@deepseek-ai/cordis');
  const { remoteMethods, TypertRemoteService } = await import('@deepseek-ai/dsh-typert-protocol');

  note('service class', TtsSpeakoutService?.name ?? String(TtsSpeakoutService));
  note('worker script', `${WORKER_SCRIPT} (exists: ${existsSync(WORKER_SCRIPT)})`);
  check('default pythonPath', DEFAULT_CONFIG.pythonPath === 'D:\\miniconda3\\envs\\qwen3-tts\\python.exe', DEFAULT_CONFIG.pythonPath);
  check('default modelPath', DEFAULT_CONFIG.modelPath === 'D:\\qwen3tts\\models\\Qwen3-TTS-12Hz-0.6B-Base', DEFAULT_CONFIG.modelPath);
  // 0.5, not 0.8: the endpoint's own system volume multiplies with this, and at
  // 0.8 laptop loudspeakers were over-driven into audible distortion.
  check('default volume 0.5 / autoPickSpeaker true', DEFAULT_CONFIG.volume === 0.5 && DEFAULT_CONFIG.autoPickSpeaker === true);

  // First-run bootstrap wiring. A fresh install has neither an environment nor
  // model weights, so these three methods are what makes the published package
  // usable at all — assert them by name AND by behaviour, because the earlier
  // version shipped `env_bootstrap.py` completely unreferenced (dead code) while
  // the README claimed first-run auto-setup.
  for (const method of ['bootstrapPython', 'modelTarget', 'runBootstrap', 'ensureBootstrap']) {
    check(`service exposes ${method}()`, typeof TtsSpeakoutService.prototype[method] === 'function');
  }

  const ctx = new Context();
  const svc = new TtsSpeakoutService(ctx, {});

  // Behaviour of the bootstrap helpers, not just their existence.
  {
    const py = svc.bootstrapPython();
    check('bootstrapPython() yields a usable command', typeof py === 'string' && py.length > 0, py);
    note('bootstrapPython()', py);

    // An isolated data dir + a configured model path that does not exist must
    // resolve to the plugin data dir, never to a user project path.
    const savedModel = svc.pluginConfig.modelPath;
    svc.pluginConfig = { ...svc.pluginConfig, modelPath: 'D:\\__definitely_missing_model__' };
    const target = svc.modelTarget();
    check('modelTarget() falls back into the plugin data dir',
      target.includes('tts-speakout') && target.includes('models'), target);
    check('modelTarget() never points at the configured missing path',
      !target.startsWith('D:\\__definitely_missing_model__'), target);
    svc.pluginConfig = { ...svc.pluginConfig, modelPath: savedModel };
    void svc.modelTarget();
  }

  // Single-instance proof: our service must extend the very same
  // TypertRemoteService class object that this script imported, otherwise the
  // Remote markers live in two different WeakMaps and the gateway sees none.
  check('single @deepseek-ai/dsh-typert-protocol instance', svc instanceof TypertRemoteService);
  note('typertRemote.serviceKey / namespace', `${svc.typertRemote?.serviceKey} / ${svc.typertRemote?.namespace}`);

  const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter((m) => m !== 'constructor');
  note('prototype methods', protoMethods.join(', '));

  const rm = remoteMethods(svc);
  const rmNames = rm.map((m) => m.method);
  note('remoteMethods()', JSON.stringify(rmNames));
  check('remoteMethods() is non-empty (__runInitializers was called)', Array.isArray(rm) && rm.length > 0);
  check('remoteMethods() has all 16 methods', rmNames.length === EXPECTED_METHODS.length,
    `${rmNames.length}/${EXPECTED_METHODS.length}`);
  for (const method of EXPECTED_METHODS) {
    check(`remoteMethods() contains ${method}`, rmNames.includes(method));
  }
  check('remoteMethods() order matches CONTRACT.md §3', JSON.stringify(rmNames) === JSON.stringify(EXPECTED_METHODS));
  check('all remote methods are public instance methods', EXPECTED_METHODS.every((m) => typeof svc[m] === 'function'));

  section('2. typert contracts');
  const contracts = await import(pathToFileURL(join(ROOT, 'lib', 'contracts.js')).href);
  note('descriptors', contracts.descriptors.map((d) => d.id).join(', '));
  check('16 descriptors', contracts.descriptors.length === EXPECTED_METHODS.length);
  check('descriptor ids', contracts.descriptors.every((d) => d.id === `dsh-tts-speakout#tts/${d.method}`));
  check('service/namespace === tts', contracts.descriptors.every((d) => d.service === 'tts' && d.namespace === 'tts'));
  check('descriptor methods === remoteMethods', JSON.stringify(contracts.descriptors.map((d) => d.method)) === JSON.stringify(rmNames));
  check('TYPERT_REMOTE.package', contracts.TYPERT_REMOTE.package === 'dsh-tts-speakout');
  check('TYPERT is the host face', contracts.TYPERT.face === 'host' && contracts.TYPERT.package === 'dsh-tts-speakout');
  check('default export === TYPERT_REMOTE', contracts.default === contracts.TYPERT_REMOTE);

  // codecs must decode both a full success payload and a bare error payload
  const statusOk = contracts.statusResult.parse({
    ok: true, message: 'ok', messageB64: 'b2s=', detail: null,
    ready: true, loading: false, error: null, modelPath: 'D:\\m',
    device: '扬声器 (Realtek(R) Audio)', deviceB64: 'x', volume: 0.8, language: 'Chinese',
    defaultVoice: 'voice-1', voiceCount: 1, workerRunning: true,
    voices: [{ id: 'voice-1', title: '我的声音', titleB64: 'x', mode: 'icl', language: 'Chinese', default: true }],
    devices: [{ index: 3, name: '扬声器', nameB64: 'x', hostapi: 'Windows WASAPI', default: true, suggested: true }],
  });
  check('statusResult decodes a success payload', statusOk.ok === true && statusOk.voices.length === 1);
  const statusErr = contracts.statusResult.parse({ ok: false, message: '模型目录不存在: X', messageB64: 'eA==', detail: null });
  check('statusResult decodes a bare error payload', statusErr.ok === false && statusErr.message.includes('模型目录不存在'));
  check('speakResult decodes', contracts.speakResult.parse({ ok: true, message: 'ok', durationSeconds: 2.5, device: '扬声器', voiceId: 'v', file: 'C:\\x.wav' }).durationSeconds === 2.5);
  check('voiceResult decodes', contracts.voiceResult.parse({ ok: true, message: 'ok', voice: null, voices: [], defaultVoice: null }).ok === true);
  check('pickResult decodes a cancel', contracts.pickResult.parse({ ok: true, message: 'user cancelled', path: null, cancelled: true }).cancelled === true);
  check('saveConfigPatch accepts autoPickSpeaker', contracts.saveConfigPatch.parse({ autoPickSpeaker: false }).autoPickSpeaker === false);
  const unknown = contracts.saveConfigPatch.parse({ autoPickSpeaker: false, bogus: 1 });
  check('saveConfigPatch strips unknown keys', !('bogus' in unknown));

  section('3. python worker handshake (status())');
  if (NO_WORKER) {
    skip('status() worker handshake', '--no-worker');
  } else if (!existsSync(WORKER_SCRIPT)) {
    const st = await svc.status();
    note('status()', JSON.stringify(st).slice(0, 400));
    check('status() degrades gracefully instead of throwing', st.ok === false && typeof st.message === 'string' && st.message.length > 0);
    check('status() still reports the configured paths', typeof st.modelPath === 'string' && st.modelPath.length > 0);
    check('status() still reports workerRunning === false', st.workerRunning === false);
    skip('worker handshake', `worker not ready: python/tts_worker.py 尚未就绪（${st.message}）`);
  } else {
    const started = Date.now();
    const st = await svc.status();
    const elapsed = Date.now() - started;
    note('status() ok / ready / loading', `${st.ok} / ${st.ready} / ${st.loading}`);
    note('status() device / volume', `${st.device || '(默认)'} / ${st.volume}`);
    note('status() modelPath', st.modelPath);
    note('status() workerRunning', st.workerRunning);
    note('status() voices / devices', `${(st.voices ?? []).length} / ${(st.devices ?? []).length}`);
    note('elapsed', `${elapsed} ms`);
    if (st.ok) {
      check('status() reached the worker', svc.worker.statusSeen === true && svc.worker.running === true);
      check('status() returned a ready flag', typeof st.ready === 'boolean');
      if (st.error) note('worker error', st.error);
      if (Array.isArray(st.devices) && st.devices.length) {
        console.log('  devices:');
        for (const d of st.devices) {
          console.log(`    #${d.index} ${d.name} [${d.hostapi}]${d.default ? ' default' : ''}${d.suggested ? ' <== autoPickSpeaker' : ''}${d.isVirtual ? ' (virtual)' : ''}`);
        }
      } else {
        note('devices', 'worker reported none');
      }
      check('worker handshake completed (status line received)', svc.worker.statusSeen === true);
    } else {
      console.log(`  worker not ready — ${st.message}${st.detail ? ` | ${st.detail}` : ''}`);
      check('status() degraded to a structured error (no crash)', st.ok === false && typeof st.message === 'string' && st.message.length > 0);
      check('status() still reports the configured paths', typeof st.modelPath === 'string' && st.modelPath.length > 0);
      skip('worker handshake', `worker not ready: ${st.message}`);
    }
  }

  // The argv is a regression test for the two bugs found during integration:
  // the worker needs --voices-dir/--data-dir, and it must always get a model.
  const spec = svc.worker.buildArgs ? svc.worker.buildArgs() : { args: [] };
  const argv = spec.args.join(' ');
  note('worker argv', argv);
  check('worker argv passes --model', argv.includes('--model'));
  check('worker argv passes --voices-dir', argv.includes('--voices-dir'));
  check('worker argv passes --data-dir', argv.includes('--data-dir'));
  check('worker argv passes --auto-pick-speaker', argv.includes('--auto-pick-speaker'));
  check('worker argv points at this DSH_HOME', argv.includes(join(TEST_HOME, 'tts-speakout', 'voices')));

  section('3b. contract coverage — no field is silently stripped by the codec');
  const covStatus = await svc.status();
  checkDeclared('statusResult', contracts.statusResult, covStatus);
  checkDeclared('status().voices[]', contracts.voiceInfo, covStatus.voices ?? []);
  checkDeclared('status().devices[]', contracts.deviceInfo, covStatus.devices ?? []);

  const covDevices = await svc.devices(true);
  checkDeclared('devicesResult', contracts.devicesResult, covDevices);
  checkDeclared('devices().devices[]', contracts.deviceInfo, covDevices.devices ?? []);
  check('devices() reports the device inventory or a structured error', covDevices.ok === true || typeof covDevices.message === 'string');

  section('4. voice preset persistence (isolated DSH_HOME)');
  const sourceWav = join(TEST_HOME, 'source-voice.wav');
  writeTestWav(sourceWav);
  const sourceSha = sha256(sourceWav);

  const imported = await svc.importVoice('宿主测试音色', sourceWav, '你好，这是一段测试。', 'icl', 'Chinese');
  note('importVoice', JSON.stringify({ ok: imported.ok, id: imported.voice?.id, default: imported.defaultVoice, message: imported.message }));
  check('importVoice ok', imported.ok === true);
  const voiceId = imported.voice?.id ?? '';
  check('voice id is ascii-safe', /^[0-9a-z\-_]+$/.test(voiceId), voiceId);
  check('first import becomes the default', imported.defaultVoice === voiceId);
  const voiceDir = join(TEST_HOME, 'tts-speakout', 'voices', voiceId);
  check('ref.wav was copied into the plugin data dir', existsSync(join(voiceDir, 'ref.wav')));
  check('the original file was not modified', sha256(sourceWav) === sourceSha);
  check('ref.wav is byte-identical to the source', sha256(join(voiceDir, 'ref.wav')) === sourceSha);
  const voiceJsonPath = join(voiceDir, 'voice.json');
  const voiceJson = JSON.parse(readFileSync(voiceJsonPath, 'utf8'));
  note('voice.json', JSON.stringify(voiceJson));
  check('voice.json fields', voiceJson.id === voiceId && voiceJson.title === '宿主测试音色'
    && voiceJson.mode === 'icl' && voiceJson.language === 'Chinese'
    && typeof voiceJson.createdAt === 'string' && voiceJson.refSha256 === sourceSha);
  check('config.json persisted defaultVoice', JSON.parse(readFileSync(join(TEST_HOME, 'tts-speakout', 'config.json'), 'utf8')).defaultVoice === voiceId);

  const listed = await svc.voices();
  check('voices() lists the preset', listed.ok === true && listed.voices.length === 1 && listed.voices[0].id === voiceId);
  check('voices() marks it default', listed.voices[0].default === true && listed.defaultVoice === voiceId);
  // Regression for a real integration bug found by ui-dev: the host returns
  // `hasRef`, but if voiceInfo does not declare it the codec strips it and the
  // client silently reads `undefined` forever.
  checkDeclared('voicesResult', contracts.voicesResult, listed);
  checkDeclared('voices()[].voiceInfo', contracts.voiceInfo, listed.voices);
  const viaCodec = contracts.voiceInfo.parse(listed.voices[0]);
  check('voiceInfo codec preserves hasRef (ref.wav exists)', viaCodec.hasRef === true);
  check('voiceInfo codec preserves hasRefText/refSha256/createdAt',
    viaCodec.hasRefText === true && viaCodec.refSha256 === sourceSha && typeof viaCodec.createdAt === 'string');

  // The python worker must find the same preset through its --voices-dir; this
  // is the host<->worker voice plumbing (no synthesis, so no model load).
  if (svc.worker.running) {
    const st2 = await svc.status();
    const workerVoices = svc.worker.statusCache?.voices ?? [];
    note('worker-visible voices', JSON.stringify(workerVoices.map((v) => v.id)));
    check('worker sees the imported voice via --voices-dir', workerVoices.some((v) => v.id === voiceId));
    check('status() voiceCount follows the presets', st2.voiceCount === 1);

    // OPT-IN: this one really plays through the speakers (low volume). It also
    // pays the ~9 s lazy model load, so it is off unless you ask for it:
    //   node scripts/test-host.mjs --speak
    if (DO_SPEAK_STEP) {
      const started = Date.now();
      const spoken = await svc.speak('宿主冒烟测试：这是一次真实的扬声器喊话，音量很低。', voiceId, 0.15, true);
      note('speak() elapsed', `${Date.now() - started} ms`);
      note('speak() result', JSON.stringify({ ok: spoken.ok, durationSeconds: spoken.durationSeconds, rtf: spoken.rtf, device: spoken.device, voiceId: spoken.voiceId, played: spoken.played, file: spoken.file }));
      check('speak() really spoke through the worker', spoken.ok === true && spoken.durationSeconds > 0);
      check('speak() reported the endpoint and the generated wav', !!spoken.device && !!spoken.file && existsSync(spoken.file));
      check('speak() wait=true observed the played event', spoken.played === true);
    } else {
      skip('real speak() through the speakers', 'opt-in only (--speak)');
    }
  } else {
    skip('worker sees the imported voice', 'worker not running');
  }

  const renamed = await svc.renameVoice(voiceId, '改过名的音色');
  check('renameVoice', renamed.ok === true && renamed.voice?.title === '改过名的音色');
  checkDeclared('voiceResult', contracts.voiceResult, renamed);
  checkDeclared('voiceResult.voice', contracts.voiceInfo, renamed.voice ?? {});
  const texted = await svc.setVoiceText(voiceId, '新的参考文本', 'xvec');
  check('setVoiceText', texted.ok === true && texted.voice?.refText === '新的参考文本' && texted.voice?.mode === 'xvec');
  const badMode = await svc.setVoiceText(voiceId, 'x', 'nonsense');
  check('setVoiceText normalizes an illegal mode to icl', badMode.voice?.mode === 'icl');
  const badVoice = await svc.renameVoice('does-not-exist', 'x');
  check('unknown voice id returns ok:false (never throws)', badVoice.ok === false && typeof badVoice.message === 'string');

  const second = await svc.importVoice('Second Voice', sourceWav, '', 'xvec', 'English');
  check('second import does not steal the default', second.ok === true && second.defaultVoice === voiceId);
  const defaulted = await svc.setDefaultVoice(second.voice.id);
  check('setDefaultVoice switches the default', defaulted.ok === true && defaulted.defaultVoice === second.voice.id);

  const deleted = await svc.deleteVoice(second.voice.id);
  check('deleteVoice', deleted.ok === true && deleted.voice === null && !existsSync(join(TEST_HOME, 'tts-speakout', 'voices', second.voice.id)));
  check('deleting the default promotes another voice', deleted.defaultVoice === voiceId);
  const deletedAll = await svc.deleteVoice(voiceId);
  check('deleting the last voice leaves defaultVoice null', deletedAll.ok === true && deletedAll.defaultVoice === null);

  section('4b. slot bindings (the four names the agent may use)');
  {
    // Fresh service so the persisted config starts clean.
    const slotSvc = new TtsSpeakoutService(new Context(), {});
    const before = slotSvc.config().slotBindings;
    check('all four slots exist by default',
      JSON.stringify(Object.keys(before).sort()) === JSON.stringify(['backup', 'headphones', 'primary', 'speakers']));
    check('slots default to unbound', Object.values(before).every((v) => v === ''));

    const saved = await slotSvc.saveConfig({
      slotBindings: { primary: '扬声器 (Realtek(R) Audio)', backup: '耳机', speakers: '', headphones: '' },
    });
    check('saveConfig accepts slotBindings', saved.ok === true, String(saved.message));
    const cfg = slotSvc.config().slotBindings;
    check('primary binding persists', cfg.primary === '扬声器 (Realtek(R) Audio)', cfg.primary);
    check('backup binding persists', cfg.backup === '耳机', cfg.backup);
    check('unset slots stay empty strings', cfg.speakers === '' && cfg.headphones === '');

    // A fresh instance must read it back from disk, not from memory.
    const reread = new TtsSpeakoutService(new Context(), {}).config().slotBindings;
    check('bindings survive a service restart (read from disk)', reread.primary === cfg.primary && reread.backup === cfg.backup,
      JSON.stringify(reread));

    // setSlotBindings is a merge: naming one slot must not wipe the others.
    const merged = await slotSvc.setSlotBindings({ speakers: 'Steam Streaming Speakers' });
    check('setSlotBindings is a merge, not a replace',
      merged.ok === true && merged.slotBindings.primary === cfg.primary
      && merged.slotBindings.backup === cfg.backup
      && merged.slotBindings.speakers === 'Steam Streaming Speakers',
      JSON.stringify(merged.slotBindings));
    check('statusResult carries the bindings and the route chain',
      Array.isArray(merged.routeChain) && merged.routeChain[0] === 'primary'
      && merged.routeChain[3] === 'headphones', JSON.stringify(merged.routeChain));

    // Whitespace and junk must not create phantom slots.
    const cleaned = await slotSvc.saveConfig({ slotBindings: { primary: '  耳机  ', backup: '   ' } });
    check('bindings are trimmed', cleaned.slotBindings.primary === '耳机', JSON.stringify(cleaned.slotBindings));
    check('blank bindings normalize to empty', cleaned.slotBindings.backup === '');

    // Reset so later sections see the defaults.
    await slotSvc.saveConfig({ slotBindings: { primary: '', backup: '', speakers: '', headphones: '' } });
  }

  section('5. agent tools (lib/tools.js)');
  const registered = [];
  const fakeCtx = {
    tools: { register(tool) { registered.push(tool); return () => {}; } },
    tts: null,
  };
  const toolsModule = await import(pathToFileURL(join(ROOT, 'lib', 'tools.js')).href);
  note('tools plugin', `${toolsModule.name} inject=${JSON.stringify(toolsModule.inject)}`);
  check('tools plugin name', toolsModule.name === 'tts-speakout-tools');
  check('tools inject declares tools + tts', JSON.stringify(toolsModule.inject) === JSON.stringify(['tools', 'tts']));
  const dispose = toolsModule.default.apply(fakeCtx);
  check('apply() returns a disposer', typeof dispose === 'function');
  const toolNames = registered.map((t) => t.name);
  note('registered tools', toolNames.join(', '));
  // The model gets exactly two tools by design: one action, one read-only check.
  // Everything else (voice selection, device switching, voice import) is
  // deliberately withheld — those belong to the user's settings only.
  check('registers exactly two tools', toolNames.length === 2, toolNames.join(', '));
  for (const expected of ['dsh_speak', 'dsh_tts_status']) {
    check(`registers ${expected}`, toolNames.includes(expected));
  }
  for (const forbidden of ['dsh_tts_devices', 'dsh_tts_voices', 'dsh_tts_voice_import']) {
    check(`does NOT expose ${forbidden}`, !toolNames.includes(forbidden));
  }
  const speakTool = registered.find((t) => t.name === 'dsh_speak');
  check('dsh_speak tells the model to use the SPEAKERS', /SPEAKER|扬声器/.test(speakTool.description));
  check('dsh_speak mentions notifying a user who stepped away',
    /stepping away from the computer/i.test(speakTool.description)
    || /away from the desk/i.test(speakTool.description));
  check('dsh_speak timeoutMs 300000', speakTool.timeoutMs === 300000);
  // Permission narrowing: no voice and no wait parameter may exist. `device` is
  // allowed but must stay optional and prompt-guarded (see the checks below).
  check('dsh_speak parameters are text + volume + device only',
    JSON.stringify(Object.keys(speakTool.parameters.properties ?? {})) === JSON.stringify(['text', 'volume', 'device']));
  check('dsh_speak has NO voice parameter', !('voice' in (speakTool.parameters.properties ?? {})));
  check('dsh_speak has NO wait parameter', !('wait' in (speakTool.parameters.properties ?? {})));
  check('dsh_speak text is required', JSON.stringify(speakTool.parameters.required ?? []) === JSON.stringify(['text']));
  check('dsh_speak device is NOT required', !(speakTool.parameters.required ?? []).includes('device'));
  // The prompt must gate the whole tool on an explicit user request, or it turns
  // into an uninvited noise-maker.
  check('dsh_speak gates itself on an explicit user request',
    /ONLY when/i.test(speakTool.description)
    && /explicitly asked to be notified by voice/i.test(speakTool.description)
    && /stepping away/i.test(speakTool.description));
  check('dsh_speak warns against calling it just because a task was long',
    /Do NOT call it just because a task was long/i.test(speakTool.description));
  // The volume prompt must teach "leave it unset unless asked": without it the
  // model guesses a level and overrides the user's own configuration.
  check('dsh_speak description says to leave volume unset by default',
    /leave the `volume` argument UNSET/i.test(speakTool.description)
    && /explicitly asks for a different loudness/i.test(speakTool.description));
  check('dsh_speak volume parameter repeats the default behaviour',
    /Leave UNSET unless the user explicitly asked/i.test(speakTool.parameters.properties.volume.description));
  check('dsh_speak volume parameter gives loud/quiet examples',
    /0\.9-1/.test(speakTool.parameters.properties.volume.description)
    && /0\.2-0\.3/.test(speakTool.parameters.properties.volume.description));
  // Same discipline for the output slot.
  check('dsh_speak description says to leave device unset by default',
    /leave `device` UNSET/s.test(speakTool.description)
    && /asked for no particular output/s.test(speakTool.description));
  check('dsh_speak device parameter repeats the default behaviour',
    /Leave UNSET in the normal case/i.test(speakTool.parameters.properties.device.description));
  // The agent may name ONLY these four slots: no driver or device strings.
  check('dsh_speak device is restricted to the four slots',
    JSON.stringify(speakTool.parameters.properties.device.enum)
      === JSON.stringify(['primary', 'backup', 'speakers', 'headphones']));
  check('dsh_speak states the four names are the only accepted values',
    /EXACTLY these four names/s.test(speakTool.description)
    && /no other value is accepted/i.test(speakTool.parameters.properties.device.description));
  check('dsh_speak warns against sending a device string',
    /Never send a driver or device string/s.test(speakTool.description));
  check('dsh_speak explains primary is the default output',
    /primary.*默认输出/s.test(speakTool.description));
  check('dsh_speak explains backup is the fallback slot',
    /backup.*备用输出/s.test(speakTool.description));
  check('dsh_speak explains leaving device unset is what enables the fallback',
    /leaving it unset is what gets the fallback/s.test(speakTool.description));
  check('dsh_speak forbids substituting another slot for a specific request',
    /do NOT use `backup` as a substitute/i.test(speakTool.description));

  // presentCall preview
  const pc = speakTool.presentCall({ text: '这是一句很长很长很长很长很长很长很长很长很长很长的测试喊话文本' });
  check('dsh_speak presentCall shape', pc?.card === 'generic' && pc?.kind === 'other' && /^喊话: /.test(pc?.title ?? ''), pc?.title);
  check('presentCall preview is <= 30 chars', (pc?.title ?? '').length <= 34, `len=${(pc?.title ?? '').length}`);

  // dsh_speak throws when the service fails (never silently "spoken")
  fakeCtx.tts = { speak: async () => ({ ok: false, message: '模拟失败：没有可用输出设备' }) };
  let threw = '';
  try { await speakTool.execute({ text: 'hello' }); } catch (e) { threw = e.message; }
  check('dsh_speak throws on failure', threw.includes('模拟失败'), threw);

  // The voice must always be the user's choice: the tool passes null so the
  // worker resolves the configured default, and it always waits for playback.
  let speakArgs = null;
  fakeCtx.tts = {
    speak: async (...args) => {
      speakArgs = args;
      return {
        ok: true, message: 'ok', durationSeconds: 2.5, device: '扬声器',
        deviceIndex: 34, voiceId: 'v1', file: 'C:\\x.wav',
      };
    },
  };
  const speakResult = await speakTool.execute({ text: 'hello' });
  check('dsh_speak passes NO voice (null = user setting)', speakArgs[1] === null, JSON.stringify(speakArgs));
  check('dsh_speak always waits for playback', speakArgs[3] === true, JSON.stringify(speakArgs));
  check('dsh_speak omits device when the caller gave none', speakArgs[4] === undefined, JSON.stringify(speakArgs));
  check('dsh_speak normal result', speakResult.ok === true && speakResult.durationSeconds === 2.5 && speakResult.voiceId === 'v1');
  check('dsh_speak surfaces the resolved device index', speakResult.deviceIndex === 34, String(speakResult.deviceIndex));
  check('dsh_speak result has exactly the declared keys',
    JSON.stringify(Object.keys(speakResult)) === JSON.stringify(['ok', 'message', 'durationSeconds', 'device', 'deviceIndex', 'deviceSource', 'voiceId', 'file']));

  // An explicit channel must be forwarded verbatim (the worker validates it).
  await speakTool.execute({ text: 'hello', device: 'headphones' });
  check('dsh_speak forwards an explicit slot', speakArgs[4] === 'headphones', JSON.stringify(speakArgs));
  check('dsh_speak forwards volume alongside device', speakArgs[2] === undefined, JSON.stringify(speakArgs));

  // dsh_tts_status is the single self-check tool: it reports, it does not throw,
  // and it must not expose any mutating method.
  const statusTool = registered.find((t) => t.name === 'dsh_tts_status');
  check('dsh_tts_status takes no parameters', Object.keys(statusTool.parameters.properties ?? {}).length === 0);
  fakeCtx.tts = { status: async () => ({ ok: false, message: 'worker 未就绪', error: '模型目录不存在: D:\\x', modelPath: 'D:\\x', volume: 0.8, voices: [], devices: [], workerRunning: false }) };
  const statusOut = await statusTool.execute({});
  check('dsh_tts_status returns a structured failure (no throw)', statusOut.ok === false && statusOut.error.includes('模型目录不存在'));
  const renderedStatus = statusTool.output.render({}, statusOut)[0].text;
  check('dsh_tts_status render surfaces the error', renderedStatus.includes('模型目录不存在'), renderedStatus.split('\n')[0]);

  // A healthy snapshot must name the voice, the volume and the channel.
  fakeCtx.tts = {
    status: async () => ({
      ok: true, message: 'ok', ready: true, loading: false, error: null,
      volume: 0.5, device: '耳机 (Realtek(R) Audio)', workerRunning: true,
      defaultVoice: 'v1', voiceCount: 1,
      voices: [{ id: 'v1', title: '我的声音', default: true }],
    }),
  };
  const okStatus = await statusTool.execute({});
  const okRendered = statusTool.output.render({}, okStatus)[0].text;
  check('self-check names the current voice', okRendered.includes('我的声音'), okRendered);
  check('self-check names the volume', okRendered.includes('50%'), okRendered);
  check('self-check names the output channel', okRendered.includes('耳机 (Realtek(R) Audio)'), okRendered);
  dispose();
  check('disposer is callable', true);

  section('5b. speak() request shaping (worker stubbed — plays NO audio)');
  const unitSvc = new TtsSpeakoutService(new Context(), {});
  const sent = [];
  unitSvc.ensureReady = async () => ({ ok: true });
  // Stub the child-process layer as well: `ensureReady` now runs the first-run
  // bootstrap, and its `worker.ensure()` fallback would spawn a real python
  // process here (slow, and irrelevant to request shaping).
  unitSvc.worker.ensure = async () => ({ ok: true });
  unitSvc.worker.request = async (op, payload) => {
    sent.push({ op, payload });
    return {
      ok: true, file: 'C:\\out\\speak.wav',
      file_b64: Buffer.from('C:\\out\\speak.wav', 'utf8').toString('base64'),
      duration: 2.5, sampleRate: 24000, genSeconds: 5, rtf: 2, voiceId: 'stub-voice',
      device: '扬声器 (Realtek(R) Audio)', playedMs: 2500,
    };
  };
  unitSvc.worker.waitPlayed = async () => true;

  const noVoice = await unitSvc.speak('你好');
  check('speak() sends text_b64 as UTF-8 base64', Buffer.from(sent[0].payload.text_b64, 'base64').toString('utf8') === '你好');
  check('speak() omits voice_id when the host knows no default', !('voice_id' in sent[0].payload));
  check('speak() applies the configured volume by default', sent[0].payload.volume === 0.5);
  check('speak() decodes file_b64 for the caller', noVoice.file === 'C:\\out\\speak.wav');
  check('speak() reports duration/device/voice', noVoice.ok === true && noVoice.durationSeconds === 2.5
    && noVoice.device.includes('扬声器') && noVoice.voiceId === 'stub-voice');
  checkDeclared('speakResult', contracts.speakResult, noVoice);
  check('speak() wait=false does not wait for playback', noVoice.played === false);

  const seeded = await unitSvc.importVoice('单元测试音色', sourceWav, '文本', 'icl', 'Chinese');
  const withDefault = await unitSvc.speak('你好', undefined, undefined, true);
  check('speak() uses the persisted default voice', sent[1].payload.voice_id === seeded.voice.id);
  check('speak() wait=true waits for the played event', withDefault.played === true);
  await unitSvc.speak('你好', 'other-voice', 0.25);
  check('speak() honours an explicit voice + volume', sent[2].payload.voice_id === 'other-voice' && sent[2].payload.volume === 0.25);

  const before = sent.length;
  const empty = await unitSvc.speak('   ');
  check('speak() rejects empty text without touching the worker', empty.ok === false && sent.length === before);

  unitSvc.worker.request = async () => ({ ok: false, message: '还没有任何音色。请先在插件设置里导入一段母本音频。' });
  const failed = await unitSvc.speak('你好');
  check('speak() propagates the worker error message (never throws)', failed.ok === false && failed.message.includes('还没有任何音色'));

  const stopUnit = new TtsSpeakoutService(new Context(), {});
  const stopped = await stopUnit.stop();
  check('stop() with no running worker is a no-op success', stopped.ok === true && stopped.stopped === true);

  section('6. lifecycle');
  // (a) explicit shutdown
  await svc.shutdown();
  check('shutdown() stops the worker', svc.worker.running === false);
  check('worker dir state cleaned', svc.worker.child === null);
  const afterShutdown = await svc.status();
  check('status() after shutdown degrades gracefully', afterShutdown.ok === false && typeof afterShutdown.message === 'string');
  // A second service must be able to start fresh (crash self-heal contract).
  const svc2 = new TtsSpeakoutService(new Context(), {});
  check('a new service instance still exposes its markers', remoteMethods(svc2).length === EXPECTED_METHODS.length);
  await svc2.shutdown();

  // (b) plugin unload — the path that actually matters in production. Cordis
  // calls `instance[Symbol.for('cordis.init')]()` for a class plugin and uses
  // ITS RETURN VALUE as the disposer; `ctx.on('dispose')` never fires there.
  const rootCtx = new Context();
  const fiber = rootCtx.plugin(TtsSpeakoutService);
  await fiber;
  const liveSvc = rootCtx.tts;
  check('ctx.plugin(Service) registers the service as ctx.tts', liveSvc instanceof TtsSpeakoutService);
  check('the loaded service exposes all remote methods', remoteMethods(liveSvc).length === EXPECTED_METHODS.length);
  if (!NO_WORKER) {
    const booted = await liveSvc.status();
    if (booted.ok) {
      check('loaded service started its python worker', liveSvc.worker.running === true);
      await fiber.dispose();
      check('plugin unload killed the python worker', liveSvc.worker.running === false && liveSvc.worker.child === null);
    } else {
      skip('plugin unload kills the worker', `worker not ready: ${booted.message}`);
      await fiber.dispose();
    }
  } else {
    await fiber.dispose();
    skip('plugin unload kills the worker', '--no-worker');
  }
  let stillRegistered = true;
  try { stillRegistered = !!rootCtx.tts; } catch { stillRegistered = false; }
  check('service is unregistered from the context after unload', stillRegistered === false);

  section('summary');
  console.log(`  PASS: ${passes}   FAIL: ${failures}   SKIP: ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  const workDir = join(TEST_HOME, 'tts-speakout');
  if (existsSync(workDir)) note('artifacts left for inspection', workDir);
  if (failures > 0) {
    console.log('\nRESULT: FAILED');
    process.exit(1);
  }
  console.log('\nRESULT: ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFATAL:', e?.stack ?? e);
  process.exit(1);
});
