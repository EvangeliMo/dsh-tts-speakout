/**
 * dsh-tts-speakout host service (TypertRemoteService, service key `tts`).
 *
 * The plugin's whole point: an agent that finished a long task can make the
 * machine *speak out loud through the speakers* with a cloned voice, so a user
 * who walked away from the desk still hears the notification.
 *
 * Layout of this file:
 *  1. `__esDecorate` / `__runInitializers` helpers — Node has no decorator
 *     syntax, so the class is hand-compiled exactly like dsh-flp-studio.
 *  2. Small helpers: ok()/err() result convention, base64 twins, device
 *     heuristics (autoPickSpeaker).
 *  3. `pickAudioDialog()` — native Win32 OpenFileDialog via a UTF-8 BOM .ps1
 *     (Windows PowerShell 5.1 needs the BOM to read non-ASCII).
 *  4. `TtsWorker` — the long-lived `python/tts_worker.py` child process:
 *     lazy spawn, NDJSON over stdout, one promise per request id, every
 *     request settles exactly once, crash => reject in-flight + restart on the
 *     next call, `shutdown()` on plugin dispose.
 *  5. `TtsSpeakoutService` — the 15 remote methods from CONTRACT.md §3 plus
 *     voice-preset persistence under `$DSH_HOME/tts-speakout/voices/<id>/`.
 *
 * Result convention (never throws, CONTRACT.md §3):
 *   { ok: true,  message: 'ok', messageB64, detail: null, ...payload }
 *   { ok: false, message: '<原因>', messageB64, detail: null|string }
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync,
  rmSync, readdirSync, statSync, renameSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `<pkg>/python/tts_worker.py` */
export const WORKER_SCRIPT = join(__dirname, '..', 'python', 'tts_worker.py');
/** `<pkg>/python/audio_out.py` — the short-lived standalone player. */
export const PLAYER_SCRIPT = join(__dirname, '..', 'python', 'audio_out.py');
/** Plugin data folder name under $DSH_HOME. */
const DATA_DIR_NAME = 'tts-speakout';
/** Audio extensions the native picker offers. */
const AUDIO_EXT = ['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac'];

/* ================================================================== *
 * Config defaults (CONTRACT.md §5)
 * ================================================================== */

export const DEFAULT_CONFIG = {
  pythonPath: 'D:\\miniconda3\\envs\\qwen3-tts\\python.exe',
  modelPath: 'D:\\qwen3tts\\models\\Qwen3-TTS-12Hz-0.6B-Base',
  /** '' = follow the system default endpoint (or the auto-picked speaker). */
  device: '',
  /** 0..1 */
  // 0.8 over-drove laptop loudspeakers in testing (piercing at that level, and
  // the endpoint's own system volume multiplies with this). 0.5 is loud enough
  // to be heard from across the room without the speaker distorting.
  volume: 0.5,
  language: 'Chinese',
  /** 0 = derive from text length inside the worker. */
  maxNewTokens: 0,
  /** Warm the model up as soon as the plugin activates. */
  preloadOnStart: false,
  /** Key default of this plugin: prefer "Speakers" over "Headphones". */
  autoPickSpeaker: true,
};

/* ================================================================== *
 * Helpers: result envelope, base64 twins, numeric coercion
 * ================================================================== */

export function b64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

export function unb64(value) {
  if (!value || typeof value !== 'string') return '';
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return ''; }
}

/** `{ ok:true, message:'ok', messageB64, detail:null, ...payload }` */
export function ok(payload = {}) {
  const message = typeof payload.message === 'string' && payload.message ? payload.message : 'ok';
  return { ok: true, detail: null, ...payload, message, messageB64: b64(message) };
}

/** `{ ok:false, message, messageB64, detail }` — never a thrown exception. */
export function err(message, detail = null) {
  const m = String(message ?? '未知错误');
  return {
    ok: false,
    message: m,
    messageB64: b64(m),
    detail: detail == null ? null : String(detail).slice(0, 4000),
  };
}

function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMessage(e) {
  if (e instanceof Error) return e.message;
  return String(e ?? '未知错误');
}

/** DSH data root: `$DSH_HOME` (falling back to `%USERPROFILE%/.dsh`). */
export function dshHome() {
  const home = process.env.DSH_HOME;
  if (home && home.trim()) return home.trim();
  const profile = process.env.USERPROFILE || process.env.HOME || '.';
  return join(profile, '.dsh');
}

/** `<DSH_HOME>/tts-speakout` */
export function dataRoot() {
  return join(dshHome(), DATA_DIR_NAME);
}

/* ================================================================== *
 * Device heuristics (autoPickSpeaker)
 * ================================================================== */

const VIRTUAL_HINTS = [
  'vb-audio', 'voicemeeter', 'virtual', 'cable input', 'cable output',
  'loopback', 'steam streaming', 'nvidia broadcast', 'obs ', 'dummy',
  'sound mapper', 'primary sound', 'wave out',
];
const SPEAKER_HINTS = ['扬声器', '喇叭', 'speaker', 'speakers', 'monitor', 'display audio'];
const HEADPHONE_HINTS = ['耳机', 'headphone', 'headset', 'earphone', 'earbuds', '蓝牙', 'bluetooth'];

export function isVirtualDevice(name) {
  const n = str(name).toLowerCase();
  return VIRTUAL_HINTS.some((k) => n.includes(k));
}
export function isSpeakerDevice(name) {
  const n = str(name).toLowerCase();
  return SPEAKER_HINTS.some((k) => n.includes(k));
}
export function isHeadphoneDevice(name) {
  const n = str(name).toLowerCase();
  return HEADPHONE_HINTS.some((k) => n.includes(k));
}

/**
 * Pick the endpoint to shout at an absent user: real devices only, loudspeakers
 * first, and among equals honour the OS default.
 */
export function pickSpeaker(devices) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && !isVirtualDevice(d.name)) : [];
  const pool = list.length ? list : (Array.isArray(devices) ? devices : []);
  if (!pool.length) return null;
  const speakers = pool.filter((d) => isSpeakerDevice(d.name));
  const candidates = speakers.length ? speakers : pool.filter((d) => !isHeadphoneDevice(d.name));
  const usable = candidates.length ? candidates : pool;
  return usable.find((d) => d.default === true) || usable[0] || null;
}

/* ================================================================== *
 * Native audio file picker (Windows PowerShell 5.1 + UTF-8 BOM .ps1)
 * ================================================================== */

function musicDir() {
  const profile = process.env.USERPROFILE || process.env.HOME || '';
  const music = profile ? join(profile, 'Music') : '';
  return music && existsSync(music) ? music : '';
}

/** Open a native Win32 OpenFileDialog filtered to audio files. */
function pickAudioDialog(initialDir = '') {
  return new Promise((resolve) => {
    const init = (initialDir || musicDir() || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class TtsFgWin {',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
      '}',
      '"@',
      // Unlock the Windows foreground lock (classic ALT press/release trick) so
      // a background-spawned process may raise the dialog.
      '[TtsFgWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
      '[TtsFgWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
      '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
      '$dlg.Title = "选择音色母本音频 (wav / mp3 / flac)"',
      '$dlg.Filter = "音频文件 (*.wav;*.mp3;*.flac;*.m4a;*.ogg;*.aac)|*.wav;*.mp3;*.flac;*.m4a;*.ogg;*.aac|WAV (*.wav)|*.wav|所有文件 (*.*)|*.*"',
      `$dlg.InitialDirectory = "${init}"`,
      '$dlg.Multiselect = $false',
      '$script:attempts = 0',
      '$timer = New-Object System.Windows.Forms.Timer',
      '$timer.Interval = 500',
      '$timer.Add_Tick({',
      '  $script:attempts++',
      '  try {',
      '    $h = $dlg.Handle',
      '    [TtsFgWin]::ShowWindow($h, 9) | Out-Null',
      '    [TtsFgWin]::SetForegroundWindow($h) | Out-Null',
      '  } catch {}',
      '  if ($script:attempts -ge 4) { $timer.Stop() }',
      '})',
      '$timer.Start()',
      'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.FileName } else { "" }',
    ].join('\n');

    const tmpFile = join(tmpdir(), `dsh-tts-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    try {
      // UTF-8 BOM: Windows PowerShell 5.1 otherwise reads the file as ANSI and
      // mangles the Chinese dialog title / filter.
      writeFileSync(tmpFile, '\ufeff' + script, 'utf8');
    } catch (e) {
      resolve(err(`无法写入文件选择器脚本: ${toMessage(e)}`));
      return;
    }

    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      try { unlinkSync(tmpFile); } catch { /* noop */ }
      resolve(err(`无法打开文件选择器: ${toMessage(e)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    const cleanup = () => { try { unlinkSync(tmpFile); } catch { /* noop */ } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 180000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolve(err(`无法打开文件选择器: ${toMessage(e)}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      cleanup();
      const picked = stdout.trim();
      if (picked) {
        resolve(ok({
          message: 'ok',
          path: picked,
          pathB64: b64(picked),
          name: basename(picked),
          nameB64: b64(basename(picked)),
          cancelled: false,
        }));
      } else {
        resolve(ok({
          message: 'user cancelled',
          path: null,
          pathB64: '',
          name: '',
          nameB64: '',
          cancelled: true,
        }));
      }
    });
  });
}

/* ================================================================== *
 * TtsWorker: long-lived python child process, NDJSON request/response
 * ================================================================== */

/**
 * One in-flight request. Every entry MUST settle exactly once — via the
 * worker's `result`/`error` line, a timeout, or a process crash.
 */
class TtsWorker {
  constructor(options) {
    // A getter, not a snapshot: `ensureBootstrap()` may resolve a different
    // interpreter (a venv it created) AFTER this object exists, and the worker
    // must pick that up on its next spawn.
    this.pythonPath = options.pythonPath;
    Object.defineProperty(this, 'pythonPath', {
      configurable: true,
      enumerable: true,
      get: () => options.resolvePython() || options.pythonPath,
    });
    this.modelPath = options.modelPath;
    this.workerScript = options.workerScript;
    this.cwd = options.cwd;
    this.extraEnv = options.extraEnv ?? {};
    /** () => { args: string[], sig: string } — evaluated at spawn time so a
     *  config change takes effect on the next (re)start. */
    this.buildArgs = options.buildArgs ?? null;
    /** Config signature the live child was started with. */
    this.spawnSig = null;

    this.child = null;
    this.generation = 0;
    this.disposed = false;
    this.starting = null;

    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.statusSeen = false;
    this.statusCache = {};
    this.statusWaiters = [];
    this.playing = false;
    this.playedSeq = 0;
    this.lastPlayed = null;
    this.playWaiters = [];
  }

  get running() {
    return !!(this.child && !this.child.killed);
  }

  /** Lazy, race-free spawn. Resolves `ok({pid})` / `err(...)`, never rejects. */
  ensure() {
    if (this.disposed) return Promise.resolve(err('TTS worker 已关闭（插件已卸载）'));
    if (this.running) return Promise.resolve(ok({ pid: this.child.pid }));
    if (this.starting) return this.starting;

    const finishStop = () => { this.starting = null; };

    if (!existsSync(this.workerScript)) {
      return Promise.resolve(err(`找不到 worker 脚本: ${this.workerScript}`));
    }
    if (looksLikePath(this.pythonPath) && !existsSync(this.pythonPath)) {
      return Promise.resolve(err(`Python 解释器不存在: ${this.pythonPath}（请修正 Config.pythonPath）`));
    }
    if (this.modelPath && !existsSync(this.modelPath)) {
      return Promise.resolve(err(`模型目录不存在: ${this.modelPath}（请修正 Config.modelPath）`));
    }

    const promise = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

      let child;
      let spec = null;
      try {
        // NOTE: `--voices-dir` / `--data-dir` are mandatory — the worker reads
        // its presets from there, not from $DSH_HOME on its own.
        spec = this.buildArgs
          ? this.buildArgs()
          : { args: [this.workerScript, '--model', this.modelPath], sig: '' };
        this.spawnSig = spec.sig;
        child = spawn(this.pythonPath, spec.args, {
          cwd: this.cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Python's stdout defaults to the local codepage (GBK on zh-CN
          // Windows): force UTF-8 on both the stream and the filesystem codec.
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            DSH_HOME: dshHome(),
            ...this.extraEnv,
          },
        });
      } catch (e) {
        finish(err(`无法启动 Python: ${toMessage(e)}`));
        return;
      }

      this.child = child;
      this.generation += 1;
      this.buffer = '';
      this.stderrTail = '';
      this.statusSeen = false;
      this.playing = false;

      child.once('spawn', () => {
        finish(ok({ pid: child.pid }));
      });
      child.once('error', (e) => {
        const msg = `无法启动 Python: ${toMessage(e)}。请确认 Config.pythonPath 指向存在的解释器：${this.pythonPath}`;
        finish(err(msg));
        if (this.child === child) this.child = null;
        this.failAllPending(err(msg));
      });
      child.once('exit', (code, signal) => {
        this.onExit(child, code, signal);
      });

      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        this.stderrTail = (this.stderrTail + text).slice(-2000);
        if (process.env.DSH_TTS_SPEAKOUT_VERBOSE) process.stderr.write(`[tts-worker] ${text}`);
      });
      // Swallow EPIPE when the child dies mid-write.
      child.stdin.on('error', () => { /* handled by the exit path */ });
    });

    this.starting = promise.then(
      (value) => { finishStop(); return value; },
      (e) => { finishStop(); return err(toMessage(e)); },
    );
    return this.starting;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    // Paranoia: a stuck pipe must not grow without bound.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = '';
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn('[dsh-tts-speakout] worker 输出无法解析:', line.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const type = typeof msg.type === 'string' ? msg.type : '';
    // Final protocol (CONTRACT.md §2 as fixed): every response — including the
    // startup frame, which carries no id — is a `result`/`error` envelope, and
    // a status snapshot travels INSIDE it as `msg.status`.
    // The two extra shapes below are deliberate back-compat tolerance for the
    // worker's first draft (bare snapshot / `type:"status"` frame): a missed
    // terminal frame would otherwise surface as a 60 s user-visible timeout.
    if (type === 'status' || (type === '' && isStatusPayload(msg))) {
      this.mergeStatus(msg);
      // Back-compat: a legacy worker replied to a status request with a
      // `type:"status"` frame carrying the request id. Settle it too.
      if (msg.id != null) {
        this.settle(msg.id, { ...msg, ok: msg.ok !== false, message: msg.message ?? 'ok', detail: null });
      }
      return;
    }

    switch (type) {
      case 'result': {
        if (msg.status && typeof msg.status === 'object') this.mergeStatus(msg.status);
        this.settle(msg.id, { ...msg, ok: msg.ok !== false, message: msg.message ?? 'ok', detail: msg.detail ?? null });
        break;
      }
      case 'error': {
        if (msg.id == null) {
          // Worker-level failure not tied to a request (e.g. bad JSON on stdin).
          console.warn('[dsh-tts-speakout] worker 报错:', str(msg.message));
          break;
        }
        this.settle(msg.id, err(msg.message ?? 'worker 执行失败', msg.detail ?? null));
        break;
      }
      case 'log': {
        const level = str(msg.level) || 'info';
        console.log(`[tts-worker:${level}] ${str(msg.message)}`);
        break;
      }
      case 'playing': {
        this.playing = msg.started !== false;
        break;
      }
      case 'played': {
        this.playing = false;
        this.playedSeq += 1;
        this.lastPlayed = msg;
        this.flushPlayWaiters(true);
        break;
      }
      default: {
        console.log('[dsh-tts-speakout] 未知 worker 消息:', line.slice(0, 200));
        break;
      }
    }
  }

  /** Cache an unsolicited/status snapshot and wake `waitStatus()` callers. */
  mergeStatus(payload) {
    if (!payload || typeof payload !== 'object') return;
    const { type: _ignored, ...rest } = payload;
    this.statusCache = { ...this.statusCache, ...rest, __seen: true };
    this.statusSeen = true;
    this.flushStatusWaiters(true);
  }

  /** Settle exactly one request; stray ids are ignored. */
  settle(id, value) {
    if (id == null) return;
    const entry = this.pending.get(Number(id));
    if (!entry) return;
    this.pending.delete(Number(id));
    clearTimeout(entry.timer);
    entry.resolve(value);
  }

  failAllPending(reason) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.resolve(reason);
    }
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.buffer = '';
    this.playing = false;
    this.statusSeen = false;
    this.spawnSig = null;
    this.statusCache = { ...this.statusCache, ready: false, loading: false, __seen: false };
    const tail = this.stderrTail.trim();
    const reason = `TTS worker 已退出（code=${code}${signal ? `, signal=${signal}` : ''}）${tail ? '：' + tail.slice(-400) : ''}`;
    // An exit we asked for (shutdown/dispose) is expected, not a crash.
    if (!this.disposed) console.warn('[dsh-tts-speakout]', reason);
    this.failAllPending(err(reason));
    this.flushStatusWaiters(false);
    this.flushPlayWaiters(false);
  }

  flushStatusWaiters(value) {
    const waiters = this.statusWaiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(value); }
  }

  flushPlayWaiters(value) {
    const waiters = this.playWaiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(value); }
  }

  /** Resolve once the worker's startup status snapshot has arrived. */
  waitStatus(timeoutMs = 25000) {
    if (this.statusSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.statusWaiters.indexOf(waiter);
        if (i >= 0) this.statusWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.statusWaiters.push(waiter);
    });
  }

  /** Resolve once a `played` event newer than `sinceSeq` has arrived. */
  waitPlayed(sinceSeq, durationSec) {
    if (this.playedSeq > sinceSeq) return Promise.resolve(true);
    const timeoutMs = Math.max(5000, Math.round(num(durationSec) * 1000) + 30000);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.playWaiters.indexOf(waiter);
        if (i >= 0) this.playWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.playWaiters.push(waiter);
    });
  }

  /**
   * Send one request and wait for its terminal line.
   * Always resolves (never rejects) with `{ok:true,...}` or `err(...)`.
   */
  async request(op, payload = {}, options = {}) {
    const timeoutMs = num(options.timeoutMs, 120000);
    const spawned = await this.ensure();
    if (!spawned.ok) return spawned;

    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return err('TTS worker 未运行');

    const id = this.nextId++;
    const message = { op, id, ...payload };

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err(`请求超时（${timeoutMs}ms）: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, op });
      try {
        // stdout of the worker is UTF-8; write UTF-8 bytes explicitly.
        child.stdin.write(Buffer.from(JSON.stringify(message) + '\n', 'utf8'));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(err(`写入 worker stdin 失败: ${toMessage(e)}`));
      }
    });
  }

  /** Best-effort graceful shutdown, then SIGKILL the child. */
  async shutdown() {
    const child = this.child;
    this.disposed = true;
    this.flushStatusWaiters(false);
    this.flushPlayWaiters(false);
    if (!child) return;
    try {
      child.stdin.write(Buffer.from(JSON.stringify({ op: 'shutdown', id: this.nextId++ }) + '\n', 'utf8'));
    } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 300));
    try { if (!child.killed) child.kill(); } catch { /* noop */ }
    if (this.child === child) this.child = null;
    this.failAllPending(err('TTS worker 已关闭'));
  }
}

function looksLikePath(value) {
  const s = str(value);
  return s.includes('\\') || s.includes('/') || /\.exe$/i.test(s);
}

/**
 * `worker.status()` snapshots arrive in three shapes:
 *   - status op     : `{ type:'result', id, ok, status:{ ...snapshot } }`
 *   - set_device op : `{ type:'result', id, ok, ready, device, ... }` (flat)
 *   - startup frame : `{ type:'result', ok, status:{ ...snapshot } }` (no id)
 * `statusOf()` flattens the nested form so callers can read either one.
 */
function isStatusPayload(value) {
  return !!value && typeof value === 'object'
    && typeof value.type !== 'string'
    && ('ready' in value || 'loading' in value || 'devices' in value || 'voiceCount' in value);
}

function statusOf(res) {
  if (res && typeof res === 'object' && res.status && typeof res.status === 'object') return res.status;
  return res && typeof res === 'object' ? res : {};
}

/* ================================================================== *
 * The service
 * ================================================================== */

let TtsSpeakoutService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _status_decorators;
  let _devices_decorators;
  let _voices_decorators;
  let _importVoice_decorators;
  let _pickAudio_decorators;
  let _deleteVoice_decorators;
  let _renameVoice_decorators;
  let _setVoiceText_decorators;
  let _setDefaultVoice_decorators;
  let _testVoice_decorators;
  let _speak_decorators;
  let _stop_decorators;
  let _setDevice_decorators;
  let _setVolume_decorators;
  let _saveConfig_decorators;
  return class TtsSpeakoutService extends _classSuper {
    static {
      const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _status_decorators = [Remote('status')];
      _devices_decorators = [Remote('devices')];
      _voices_decorators = [Remote('voices')];
      _importVoice_decorators = [Remote('importVoice')];
      _pickAudio_decorators = [Remote('pickAudio')];
      _deleteVoice_decorators = [Remote('deleteVoice')];
      _renameVoice_decorators = [Remote('renameVoice')];
      _setVoiceText_decorators = [Remote('setVoiceText')];
      _setDefaultVoice_decorators = [Remote('setDefaultVoice')];
      _testVoice_decorators = [Remote('testVoice')];
      _speak_decorators = [Remote('speak')];
      _stop_decorators = [Remote('stop')];
      _setDevice_decorators = [Remote('setDevice')];
      _setVolume_decorators = [Remote('setVolume')];
      _saveConfig_decorators = [Remote('saveConfig')];
      __esDecorate(this, null, _status_decorators, { kind: "method", name: "status", static: false, private: false, access: { has: obj => "status" in obj, get: obj => obj.status }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _devices_decorators, { kind: "method", name: "devices", static: false, private: false, access: { has: obj => "devices" in obj, get: obj => obj.devices }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _voices_decorators, { kind: "method", name: "voices", static: false, private: false, access: { has: obj => "voices" in obj, get: obj => obj.voices }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _importVoice_decorators, { kind: "method", name: "importVoice", static: false, private: false, access: { has: obj => "importVoice" in obj, get: obj => obj.importVoice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _pickAudio_decorators, { kind: "method", name: "pickAudio", static: false, private: false, access: { has: obj => "pickAudio" in obj, get: obj => obj.pickAudio }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _deleteVoice_decorators, { kind: "method", name: "deleteVoice", static: false, private: false, access: { has: obj => "deleteVoice" in obj, get: obj => obj.deleteVoice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _renameVoice_decorators, { kind: "method", name: "renameVoice", static: false, private: false, access: { has: obj => "renameVoice" in obj, get: obj => obj.renameVoice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setVoiceText_decorators, { kind: "method", name: "setVoiceText", static: false, private: false, access: { has: obj => "setVoiceText" in obj, get: obj => obj.setVoiceText }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setDefaultVoice_decorators, { kind: "method", name: "setDefaultVoice", static: false, private: false, access: { has: obj => "setDefaultVoice" in obj, get: obj => obj.setDefaultVoice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _testVoice_decorators, { kind: "method", name: "testVoice", static: false, private: false, access: { has: obj => "testVoice" in obj, get: obj => obj.testVoice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _speak_decorators, { kind: "method", name: "speak", static: false, private: false, access: { has: obj => "speak" in obj, get: obj => obj.speak }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _stop_decorators, { kind: "method", name: "stop", static: false, private: false, access: { has: obj => "stop" in obj, get: obj => obj.stop }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setDevice_decorators, { kind: "method", name: "setDevice", static: false, private: false, access: { has: obj => "setDevice" in obj, get: obj => obj.setDevice }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _setVolume_decorators, { kind: "method", name: "setVolume", static: false, private: false, access: { has: obj => "setVolume" in obj, get: obj => obj.setVolume }, metadata: _metadata }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _saveConfig_decorators, { kind: "method", name: "saveConfig", static: false, private: false, access: { has: obj => "saveConfig" in obj, get: obj => obj.saveConfig }, metadata: _metadata }, null, _instanceExtraInitializers);
    }

    static inject = [];

    /**
     * Cordis class-plugin teardown hook.
     *
     * For a constructor plugin the loader does
     *   `instance[Symbol.for('cordis.init')]()`
     * after construction and treats its RETURN VALUE as the disposer.
     * `ctx.on('dispose', …)` is a Koishi-3 habit that NEVER fires in
     * @deepseek-ai/cordis 4.x (verified against the bundled runtime) — relying
     * on it would leak a python process holding ~2.4 GB of VRAM on every
     * plugin unload/reload. Returning the promise lets unload await the kill.
     */
    [Symbol.for('cordis.init')]() {
      return () => this.shutdown();
    }

    constructor(ctx, config = {}) {
      super(ctx, 'tts');
      // ⚠️ Mandatory: without this the Remote markers never reach the prototype
      // and every `tts/*` gateway call 404s. See SKILL.md §2.3.
      __runInitializers(this, _instanceExtraInitializers);

      this.pluginConfig = config && typeof config === 'object' ? config : {};
      /** Set by `ensureBootstrap()` when it resolves a different interpreter. */
      this.resolvedPython = null;
      /** Set by `ensureBootstrap()` when the model was found or downloaded. */
      this.resolvedModelPath = null;
      this.bootstrapResult = null;
      this.bootstrapRunning = null;
      this.worker = new TtsWorker({
        pythonPath: this.config().pythonPath,
        modelPath: this.config().modelPath,
        workerScript: WORKER_SCRIPT,
        cwd: join(__dirname, '..'),
        resolvePython: () => this.resolvedPython,
        buildArgs: () => this.workerSpec(),
      });
      /** Signature of the last `set_device` we pushed to the current worker. */
      this.appliedSig = null;

      if (this.config().preloadOnStart === true) {
        // Fire and forget: warm the model up as soon as the plugin activates.
        void (async () => {
          const ready = await this.ensureReady();
          if (!ready.ok) { console.warn('[dsh-tts-speakout] 预热失败:', ready.message); return; }
          const res = await this.worker.request('preload', {}, { timeoutMs: 300000 });
          if (!res.ok) console.warn('[dsh-tts-speakout] 预热失败:', res.message);
        })();
      }
    }

    /**
     * Exact argv for `python/tts_worker.py`.
     * `--voices-dir` is NOT optional: the worker locates its presets there and
     * cannot speak at all without it. The returned `sig` lets us skip the
     * `set_device` round-trip when the running child already matches config.
     */
    workerSpec() {
      const cfg = this.config();
      const data = this.dataDir();
      const args = [
        WORKER_SCRIPT,
        // The bootstrap may have resolved a DIFFERENT interpreter (a private
        // venv it just created) than the configured one; prefer it so a fresh
        // install actually runs.
        '--model', this.resolvedModelPath || cfg.modelPath,
        '--voices-dir', join(data, 'voices'),
        '--data-dir', data,
        '--volume', String(cfg.volume),
        '--language', cfg.language,
        '--auto-pick-speaker', cfg.autoPickSpeaker ? 'true' : 'false',
      ];
      if (str(cfg.device).trim()) args.push('--device', str(cfg.device));
      if (cfg.maxNewTokens > 0) args.push('--max-new-tokens', String(cfg.maxNewTokens));
      return { args, sig: configSig(cfg) };
    }

    /* ---------------- config & paths ---------------- */

    /** DEFAULTS < plugin config < persisted `<data>/config.json`. */
    config() {
      const merged = { ...DEFAULT_CONFIG };
      for (const [key, value] of Object.entries(this.pluginConfig ?? {})) {
        if (value !== undefined && value !== null) merged[key] = value;
      }
      for (const [key, value] of Object.entries(this.readStoredConfig())) {
        if (value !== undefined && value !== null) merged[key] = value;
      }
      merged.volume = clamp01(merged.volume, 0.8);
      merged.maxNewTokens = Math.max(0, Math.trunc(num(merged.maxNewTokens, 0)));
      merged.device = str(merged.device);
      merged.language = str(merged.language) || 'Chinese';
      merged.autoPickSpeaker = merged.autoPickSpeaker !== false;
      return merged;
    }

    dataDir() { return dataRoot(); }
    configFile() { return join(this.dataDir(), 'config.json'); }
    voicesDir() { return join(this.dataDir(), 'voices'); }
    voiceDir(id) { return join(this.voicesDir(), safeId(id)); }

    readStoredConfig() {
      const file = this.configFile();
      try {
        if (!existsSync(file)) return {};
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
      } catch (e) {
        console.warn('[dsh-tts-speakout] config.json 读取失败:', toMessage(e));
        return {};
      }
    }

    writeStoredConfig(patch) {
      const next = { ...this.readStoredConfig() };
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      const dir = this.dataDir();
      mkdirSync(dir, { recursive: true });
      const file = this.configFile();
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, file);
      return next;
    }

    /* ---------------- voice presets (host-side, no worker needed) ---------------- */

    /** Read every `<voices>/<id>/voice.json`; sorted oldest-first. */
    readVoices() {
      const dir = this.voicesDir();
      if (!existsSync(dir)) return [];
      const out = [];
      let entries = [];
      try { entries = readdirSync(dir); } catch { return []; }
      for (const name of entries) {
        const voiceJson = join(dir, name, 'voice.json');
        try {
          if (!existsSync(voiceJson)) continue;
          const raw = JSON.parse(readFileSync(voiceJson, 'utf8'));
          const title = str(raw.title) || name;
          out.push({
            id: safeId(str(raw.id) || name),
            title,
            titleB64: b64(title),
            mode: str(raw.mode) || 'icl',
            language: str(raw.language) || 'Chinese',
            hasRefText: !!(raw.refText && String(raw.refText).trim()),
            refText: str(raw.refText),
            createdAt: str(raw.createdAt),
            refSha256: str(raw.refSha256),
            hasRef: existsSync(join(dir, name, 'ref.wav')),
            source: 'host',
          });
        } catch (e) {
          console.warn('[dsh-tts-speakout] 音色读取失败:', name, toMessage(e));
        }
      }
      out.sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)) || a.id.localeCompare(b.id));
      return out;
    }

    /** Persisted default voice id, falling back to the first preset. */
    defaultVoiceId() {
      const stored = str(this.readStoredConfig().defaultVoice);
      const list = this.readVoices();
      if (stored && list.some((v) => v.id === stored)) return stored;
      return list.length ? list[0].id : null;
    }

    /** Persisted presets + anything the worker reports (e.g. a builtin). */
    allVoices() {
      const list = this.readVoices();
      const defaultId = this.defaultVoiceId();
      const known = new Set(list.map((v) => v.id));
      for (const raw of Array.isArray(this.worker.statusCache?.voices) ? this.worker.statusCache.voices : []) {
        const id = str(raw?.id);
        if (!id || known.has(id)) continue;
        known.add(id);
        const title = unb64(raw.title_b64) || str(raw.title) || id;
        list.push({
          id,
          title,
          titleB64: b64(title),
          mode: str(raw.mode) || 'icl',
          language: str(raw.language) || 'Chinese',
          hasRefText: false,
          refText: '',
          createdAt: '',
          refSha256: '',
          hasRef: false,
          source: 'worker',
        });
      }
      return list.map((v) => ({ ...v, default: defaultId != null && v.id === defaultId }));
    }

    writeVoiceJson(id, patch) {
      const dir = this.voiceDir(id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'voice.json');
      let current = {};
      try { if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { current = {}; }
      const next = { ...current, ...patch };
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, file);
      return next;
    }

    findVoice(id) {
      const wanted = safeId(id);
      return this.readVoices().find((v) => v.id === wanted) ?? null;
    }

    /* ---------------- worker plumbing ---------------- */

    /* ---------------- first-run bootstrap ---------------- */

    /**
     * Find a *system* interpreter to run the bootstrap with.
     *
     * The bootstrap is stdlib-only Python on purpose: it has to run before any
     * dependency exists. It then locates (or creates) the real environment and
     * prepares the model.
     */
    bootstrapPython() {
      const candidates = [];
      const configured = str(this.config().pythonPath);
      if (configured) candidates.push(configured);
      candidates.push('python', 'python3', 'py');
      for (const candidate of candidates) {
        if (candidate.includes('\\') || candidate.includes('/')) {
          if (existsSync(candidate)) return candidate;
          continue;
        }
        return candidate; // bare name: let the OS resolve it
      }
      return 'python';
    }

    /**
     * Where the model should live. Prefer the configured path when it already
     * holds weights; otherwise download into the plugin data dir (never into the
     * user's own project folders).
     */
    modelTarget() {
      const configured = str(this.config().modelPath);
      if (configured && existsSync(configured)) return configured;
      return join(this.dataDir(), 'models', 'Qwen3-TTS-12Hz-0.6B-Base');
    }

    /**
     * Run `python/env_bootstrap.py`, which:
     *   1. reuses an interpreter that already has every dependency, else creates
     *      a private venv in the plugin data dir and installs them;
     *   2. reuses an existing model checkout, else downloads the weights
     *      (ModelScope, then the HF mirror) with resume support.
     *
     * Returns `{ ok, python, modelPath }` on success. Progress lines are
     * forwarded to the log so a long download is not a silent black box.
     */
    runBootstrap(strategy) {
      return new Promise((resolve) => {
        const script = join(__dirname, '..', 'python', 'env_bootstrap.py');
        if (!existsSync(script)) {
          finish({ ok: false, message: `找不到自举脚本: ${script}` });
          return;
        }
        const payload = {
          pythonPath: str(this.config().pythonPath),
          modelPath: strategy.modelPath,
          modelSource: 'auto',
          venvDir: join(this.dataDir(), 'venv'),
        };

        let child;
        try {
          child = spawn(this.bootstrapPython(), [script, JSON.stringify(payload)], {
            cwd: this.cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          });
        } catch (e) {
          finish({ ok: false, message: `无法启动自举进程: ${toMessage(e)}` });
          return;
        }

        let settled = false;
        const finish = (value) => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(value); }
        };
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* noop */ }
          finish({ ok: false, message: '环境准备超时（首次下载模型可能需要更久，可稍后重试）' });
        }, 30 * 60 * 1000);

        let buffer = '';
        let lastReport = '';
        if (child.stdout) {
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
              if (frame.message && frame.message !== lastReport
                  && (frame.level === 'info' || frame.level === 'progress' || frame.level === 'warn')) {
                lastReport = frame.message;
                console.log(`[dsh-tts-speakout] 准备中: ${frame.message}`);
              }
            }
          });
        }
        let stderrTail = '';
        if (child.stderr) {
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + String(chunk)).slice(-1500);
          });
        }
        child.on('error', (e) => finish({ ok: false, message: `自举进程启动失败: ${toMessage(e)}` }));
        child.on('exit', (code) => {
          if (settled) return;
          if (code === 0) {
            // The final stdout line is the JSON verdict.
            const lines = buffer.split('\n').map((s) => s.trim()).filter(Boolean);
            let verdict = null;
            for (let i = lines.length - 1; i >= 0; i -= 1) {
              try { verdict = JSON.parse(lines[i]); break; } catch { /* keep looking */ }
            }
            if (verdict && verdict.ok) {
              finish(ok({ python: verdict.python || '', modelPath: strategy.modelPath }));
            } else {
              finish(err(`环境准备未完成: ${(verdict && verdict.message) || '未知原因'}`));
            }
          } else {
            finish(err(`环境准备失败（退出码 ${code}）${stderrTail ? ': ' + stderrTail.trim().slice(-400) : ''}`));
          }
        });
      });
    }

    /**
     * Make the runtime usable before the worker is spawned.
     *
     * A fresh install has neither a Python environment nor model weights, so the
     * bootstrap runs once and its results are remembered for this process.
     * Skipped entirely when the configured interpreter and model are both present
     * (the normal case for the machine that developed the plugin).
     */
    async ensureBootstrap() {
      if (this.bootstrapResult) return this.bootstrapResult;
      if (this.bootstrapRunning) return this.bootstrapRunning;

      const cfg = this.config();
      const interpreterReady = !looksLikePath(cfg.pythonPath) || existsSync(cfg.pythonPath);
      const modelReady = !cfg.modelPath || existsSync(cfg.modelPath);
      if (interpreterReady && modelReady) {
        this.bootstrapResult = ok({ python: cfg.pythonPath, modelPath: cfg.modelPath, skipped: true });
        return this.bootstrapResult;
      }

      console.log('[dsh-tts-speakout] 首次运行：正在准备 Python 环境与模型（可能需要几分钟）…');
      const target = this.modelTarget();
      this.bootstrapRunning = (async () => {
        const res = await this.runBootstrap({ modelPath: target });
        this.bootstrapRunning = null;
        if (res.ok) {
          if (res.python) this.resolvedPython = res.python;
          this.resolvedModelPath = res.modelPath || target;
          this.bootstrapResult = ok({ python: res.python, modelPath: this.resolvedModelPath });
          console.log(`[dsh-tts-speakout] 环境就绪: ${res.python} | 模型: ${this.resolvedModelPath}`);
        }
        return res;
      })();
      return this.bootstrapRunning;
    }

    /** Spawn if needed, wait for the startup status line, push device/volume. */
    async ensureReady() {
      const boot = await this.ensureBootstrap();
      if (!boot.ok) return err(boot.message, boot.detail);
      const spawned = await this.worker.ensure();
      if (!spawned.ok) return spawned;
      await this.worker.waitStatus(25000);
      await this.applySettings(false);
      return ok({ pid: this.worker.child?.pid ?? null });
    }

    /**
     * Push `set_device` when the live child was NOT started with the current
     * config (or when explicitly forced). Device resolution itself lives in the
     * worker: it receives the raw friendly-name spec ('' = auto, and then
     * `--auto-pick-speaker` makes it prefer the loudspeakers — the whole reason
     * this plugin exists).
     */
    async applySettings(force = false) {
      const worker = this.worker;
      if (!worker.running) return err('TTS worker 未运行');
      const cfg = this.config();
      const sig = configSig(cfg);
      if (!force && (this.appliedSig === sig || worker.spawnSig === sig)) {
        return ok({ message: 'unchanged' });
      }

      const res = await worker.request('set_device', {
        device: str(cfg.device),
        volume: cfg.volume,
        autoPickSpeaker: cfg.autoPickSpeaker,
        language: cfg.language,
        maxNewTokens: cfg.maxNewTokens,
      }, { timeoutMs: 60000 });
      if (res.ok) {
        this.appliedSig = sig;
        worker.mergeStatus(statusOf(res));
      }
      return res;
    }

    /** Normalize worker device records + annotate the auto-pick target. */
    normalizeDevices(rawList) {
      const list = Array.isArray(rawList) ? rawList : [];
      const devices = list.map((raw, i) => {
        const name = unb64(raw?.name_b64) || str(raw?.name) || `Device ${i}`;
        const index = Number(raw?.index);
        return {
          index: Number.isFinite(index) ? index : i,
          name,
          nameB64: b64(name),
          hostapi: str(raw?.hostapi),
          default: raw?.default === true,
          isSpeaker: isSpeakerDevice(name),
          isVirtual: raw?.virtual === true || isVirtualDevice(name),
          // The worker marks its own choice (it is the side that opens the
          // device); fall back to the host heuristic when it reported none.
          suggested: raw?.suggested === true,
        };
      });
      if (!devices.some((d) => d.suggested)) {
        const pick = pickSpeaker(devices);
        if (pick) {
          const hit = devices.find((d) => d.index === pick.index);
          if (hit) hit.suggested = true;
        }
      }
      return devices;
    }

    workerDevices(extra) {
      const fromResult = Array.isArray(extra) ? extra : null;
      const fromStatus = Array.isArray(this.worker.statusCache?.devices) ? this.worker.statusCache.devices : [];
      return this.normalizeDevices(fromResult ?? fromStatus);
    }

    /** StatusResult-shaped error payload so the UI still shows the config. */
    statusError(message, detail = null) {
      const cfg = this.config();
      const base = err(message, detail);
      const voices = this.safeVoices();
      return {
        ...base,
        ready: false,
        loading: false,
        error: base.message,
        modelPath: cfg.modelPath,
        modelB64: b64(cfg.modelPath),
        pythonPath: cfg.pythonPath,
        samplerate: null,
        device: '',
        deviceB64: '',
        autoPicked: false,
        volume: cfg.volume,
        language: cfg.language,
        maxNewTokens: cfg.maxNewTokens,
        autoPickSpeaker: cfg.autoPickSpeaker,
        defaultVoice: this.defaultVoiceId(),
        voiceCount: voices.length,
        workerRunning: this.worker.running,
        voices,
        devices: this.workerDevices(null),
      };
    }

    safeVoices() {
      try { return this.allVoices(); } catch (e) { console.warn('[dsh-tts-speakout] 音色枚举失败:', toMessage(e)); return []; }
    }

    /* ================= remote methods (CONTRACT.md §3) ================= */

    /** Readiness, effective device, volume, voices and devices. */
    async status() {
      try {
        const ready = await this.ensureReady();
        if (!ready.ok) return this.statusError(ready.message, ready.detail);

        const res = await this.worker.request('status', {}, { timeoutMs: 60000 });
        if (!res.ok) return this.statusError(res.message, res.detail);

        // `status` / `list_devices` / `set_device` replies nest the snapshot
        // under `status` (the worker's own `status()` carries no `type` key any
        // more, precisely so it cannot clobber the envelope).
        const st = statusOf(res);
        const cfg = this.config();
        const voices = this.safeVoices();
        const devices = this.workerDevices(st.devices);
        const device = str(st.device) || str(st.deviceSpec) || '';
        const samplerate = Number(st.samplerate);
        return ok({
          ready: st.ready === true,
          loading: st.loading === true,
          error: st.error == null ? null : str(st.error),
          modelPath: cfg.modelPath,
          modelB64: b64(cfg.modelPath),
          pythonPath: cfg.pythonPath,
          samplerate: Number.isFinite(samplerate) && samplerate > 0 ? samplerate : null,
          device,
          deviceB64: b64(device),
          autoPicked: !str(cfg.device).trim() && !!device,
          volume: clamp01(st.volume, cfg.volume),
          language: str(st.language) || cfg.language,
          maxNewTokens: cfg.maxNewTokens,
          autoPickSpeaker: cfg.autoPickSpeaker,
          defaultVoice: this.defaultVoiceId(),
          voiceCount: voices.length,
          workerRunning: this.worker.running,
          voices,
          devices,
          // Pass the worker's audibility self-check straight through: "rendered
          // fine, nobody heard it" is invisible otherwise (endpoint muted or at
          // 0 % system volume).
          audibleWarning: st.audibleWarning == null ? null : str(st.audibleWarning),
          audibleWarningB64: st.audibleWarning == null ? '' : b64(str(st.audibleWarning)),
          endpoint: st.endpoint && typeof st.endpoint === 'object' ? st.endpoint : null,
        });
      } catch (e) {
        return this.statusError(toMessage(e));
      }
    }

    /** Enumerate output endpoints (`refresh` re-probes the OS). */
    async devices(refresh) {
      try {
        const ready = await this.ensureReady();
        if (!ready.ok) return { ...err(ready.message, ready.detail), devices: [] };

        const res = await this.worker.request('list_devices', { refresh: refresh === true }, { timeoutMs: 60000 });
        if (!res.ok) return { ...err(res.message, res.detail), devices: this.workerDevices(null) };

        const st = statusOf(res);
        const devices = this.workerDevices(st.devices);
        const pick = devices.find((d) => d.suggested) ?? pickSpeaker(devices);
        const cfg = this.config();
        // What will actually be used: the worker's resolved endpoint.
        const effective = str(st.device) || str(pick?.name) || '';
        return ok({
          devices,
          suggested: pick ? pick.name : null,
          suggestedB64: pick ? b64(pick.name) : '',
          effective,
          effectiveB64: b64(effective),
          volume: cfg.volume,
        });
      } catch (e) {
        return { ...err(toMessage(e)), devices: [] };
      }
    }

    /** Persisted voice presets (host-side only; no python needed). */
    async voices() {
      try {
        const voices = this.safeVoices();
        return ok({ voices, defaultVoice: this.defaultVoiceId(), voiceCount: voices.length });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /**
     * Copy a user audio file into the plugin data dir (the original is never
     * touched) and register it as a voice preset. The first preset becomes the
     * default automatically.
     */
    async importVoice(title, filePath, refText, mode, language) {
      try {
        const niceTitle = str(title).trim();
        if (!niceTitle) return err('音色标题不能为空');
        const source = str(filePath).trim();
        if (!source) return err('未指定母本音频路径');
        if (!existsSync(source)) return err(`母本音频不存在: ${source}`);
        let stat;
        try { stat = statSync(source); } catch (e) { return err(`无法读取母本音频: ${toMessage(e)}`); }
        if (!stat.isFile()) return err(`母本音频不是文件: ${source}`);

        mkdirSync(this.voicesDir(), { recursive: true });
        const id = this.allocateVoiceId(niceTitle);
        const dir = this.voiceDir(id);
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, 'ref.wav');
        const sourceExt = extname(source).toLowerCase();
        try {
          copyFileSync(source, dest);
        } catch (e) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
          return err(`复制母本音频失败: ${toMessage(e)}`);
        }

        let sha = '';
        try { sha = createHash('sha256').update(readFileSync(dest)).digest('hex'); } catch { sha = ''; }
        const cfg = this.config();
        const useMode = normalizeMode(mode);
        const useLanguage = str(language).trim() || cfg.language;
        this.writeVoiceJson(id, {
          id,
          title: niceTitle,
          refText: str(refText),
          mode: useMode,
          language: useLanguage,
          createdAt: new Date().toISOString(),
          refSha256: sha,
          refSourceName: basename(source),
          refSourceExt: sourceExt,
        });

        const stored = this.readStoredConfig();
        let message = `已导入音色「${niceTitle}」`;
        if (!str(stored.defaultVoice) || !this.findVoice(stored.defaultVoice)) {
          this.writeStoredConfig({ defaultVoice: id });
          message += '，并设为默认音色';
        }
        if (sourceExt && sourceExt !== '.wav') {
          message += `；源文件是 ${sourceExt}，已按契约存为 ref.wav，若合成失败请先转成 16-bit wav`;
        }

        const voices = this.safeVoices();
        return ok({
          message,
          voice: voices.find((v) => v.id === id) ?? null,
          voices,
          defaultVoice: this.defaultVoiceId(),
          voiceCount: voices.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /** Native file chooser filtered to audio files. */
    async pickAudio() {
      try {
        return await pickAudioDialog('');
      } catch (e) {
        return err(toMessage(e));
      }
    }

    async deleteVoice(id) {
      try {
        const voice = this.findVoice(id);
        if (!voice) return err(`音色不存在: ${str(id)}`);
        try {
          rmSync(this.voiceDir(voice.id), { recursive: true, force: true });
        } catch (e) {
          return err(`删除音色失败: ${toMessage(e)}`);
        }
        let defaultVoice = this.defaultVoiceId();
        if (defaultVoice === voice.id) {
          const rest = this.readVoices();
          defaultVoice = rest.length ? rest[0].id : null;
          this.writeStoredConfig({ defaultVoice });
        }
        const voices = this.safeVoices();
        return ok({
          message: `已删除音色「${voice.title}」`,
          voice: null,
          voices,
          defaultVoice,
          voiceCount: voices.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    async renameVoice(id, title) {
      try {
        const voice = this.findVoice(id);
        if (!voice) return err(`音色不存在: ${str(id)}`);
        const niceTitle = str(title).trim();
        if (!niceTitle) return err('音色标题不能为空');
        this.writeVoiceJson(voice.id, { title: niceTitle });
        const voices = this.safeVoices();
        return ok({
          message: `已重命名为「${niceTitle}」`,
          voice: voices.find((v) => v.id === voice.id) ?? null,
          voices,
          defaultVoice: this.defaultVoiceId(),
          voiceCount: voices.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /** Set the reference transcript / mode used for ICL cloning. */
    async setVoiceText(id, refText, mode) {
      try {
        const voice = this.findVoice(id);
        if (!voice) return err(`音色不存在: ${str(id)}`);
        const patch = { refText: str(refText) };
        if (mode !== undefined && mode !== null && str(mode).trim()) patch.mode = normalizeMode(mode);
        this.writeVoiceJson(voice.id, patch);
        const voices = this.safeVoices();
        return ok({
          message: '已保存音色文本',
          voice: voices.find((v) => v.id === voice.id) ?? null,
          voices,
          defaultVoice: this.defaultVoiceId(),
          voiceCount: voices.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    async setDefaultVoice(id) {
      try {
        const voice = this.findVoice(id);
        if (!voice) return err(`音色不存在: ${str(id)}`);
        this.writeStoredConfig({ defaultVoice: voice.id });
        const voices = this.safeVoices();
        return ok({
          message: `已将「${voice.title}」设为默认音色`,
          voice: voices.find((v) => v.id === voice.id) ?? null,
          voices,
          defaultVoice: voice.id,
          voiceCount: voices.length,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /** Speak a short sample with one voice (waits for playback to finish). */
    async testVoice(id, text) {
      const sample = str(text).trim() || '这是一段音色试听，用于确认音量与输出通道。';
      // Synthesize in the resident worker, then play from a short-lived process.
      //
      // Why not just call speak(): the resident worker can keep reporting a
      // successful playback while the endpoint renders silence — a long-lived
      // process opening and closing streams on these Realtek endpoints
      // eventually goes mute, whereas a freshly started process playing the very
      // same file to the very same endpoint is audible every time. The preview
      // is the user's sanity check for voice/volume/channel, so it must be the
      // reliable path.
      try {
        const ready = await this.ensureReady();
        if (!ready.ok) return err(ready.message, ready.detail);

        const cfg = this.config();
        const explicit = str(id).trim();
        const voice = explicit || this.defaultVoiceId() || '';
        const payload = {
          text_b64: b64(sample),
          volume: clamp01(null, cfg.volume),
          language: cfg.language,
          no_play: true,
        };
        if (voice) payload.voice_id = voice;
        if (cfg.maxNewTokens > 0) payload.max_new_tokens = cfg.maxNewTokens;

        const res = await this.worker.request('speak', payload, { timeoutMs: 300000 });
        if (!res.ok) return err(res.message, res.detail);

        const file = str(res.file_b64) ? unb64(res.file_b64) : str(res.file);
        if (!file) return err('合成成功但未返回音频文件路径');

        // The worker's own resolved endpoint is what the agent's speak-outs use,
        // so the preview must target exactly that — never the system default.
        const effective = await this.effectiveDevice(voice);
        const played = await this.playStandalone(file, effective, clamp01(null, cfg.volume));
        if (!played.ok) return err(played.message || '试听播放失败');

        return ok({
          voiceId: str(res.voiceId) || voice,
          text: sample,
          file,
          fileB64: b64(file),
          durationSeconds: num(res.duration, 0),
          device: played.device || effective,
          deviceB64: b64(played.device || effective),
          volume: played.volume,
          viaSubprocess: true,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /** The endpoint the worker actually opened (falls back to config). */
    async effectiveDevice(fallbackVoice) {
      try {
        const st = await this.status();
        const name = str(st && st.device);
        if (name) return name;
      } catch { /* fall through */ }
      void fallbackVoice;
      return str(this.config().device);
    }

    /**
     * Play one wav through a short-lived Python process (`audio_out.py --play`).
     * Returns `{ ok, device, volume, message }`; never throws.
     */
    playStandalone(file, device, volume) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        let child;
        try {
          child = spawn(this.config().pythonPath, [
            PLAYER_SCRIPT,
            '--play', file,
            '--device', str(device),
            '--volume', String(clamp01(volume, 0.5)),
          ], {
            cwd: this.cwd,
            windowsHide: true,
            // stdout is intentionally ignored: this call is fire-and-forget, and
            // capturing piped stdio is unavailable under some sandboxes.
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          });
        } catch (e) {
          finish({ ok: false, message: toMessage(e) });
          return;
        }
        let stderr = '';
        if (child.stderr) {
          child.stderr.on('data', (chunk) => {
            stderr = (stderr + String(chunk)).slice(-800);
          });
        }
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* noop */ }
          finish({ ok: false, message: '试听播放超时' });
        }, 120000);
        child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, message: toMessage(e) }); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) finish({ ok: true, device: str(device), volume: clamp01(volume, 0.5) });
          else finish({ ok: false, message: `播放进程退出码 ${code}${stderr ? ': ' + stderr.trim() : ''}` });
        });
      });
    }

    /**
     * Synthesize + play through the speakers.
     * `wait === true` additionally waits for the `played` event before
     * returning (the tool's `wait` flag; default false = return right after the
     * worker reports the utterance).
     */
    async speak(text, voiceId, volume, wait) {
      try {
        const content = str(text).trim();
        if (!content) return err('未指定要朗读的文本');
        const ready = await this.ensureReady();
        if (!ready.ok) return err(ready.message, ready.detail);

        const cfg = this.config();
        // Voice validation/fallback lives in the worker: it re-reads
        // `<data-dir>/config.json`'s `defaultVoice` on every call and can also
        // see presets this host has not enumerated yet. We only pre-resolve the
        // default so the returned `voiceId` is meaningful; when we don't know
        // one we omit `voice_id` and let the worker decide.
        const explicit = str(voiceId).trim();
        const voice = explicit || this.defaultVoiceId() || '';
        const vol = clamp01(volume, cfg.volume);

        const payload = {
          text_b64: b64(content),
          volume: vol,
          language: cfg.language,
        };
        if (voice) payload.voice_id = voice;
        if (cfg.maxNewTokens > 0) payload.max_new_tokens = cfg.maxNewTokens;

        const seqAtSend = this.worker.playedSeq;
        const res = await this.worker.request('speak', payload, { timeoutMs: 300000 });
        if (!res.ok) return err(res.message, res.detail);

        // The worker emits `played` before the result frame, so this typically
        // returns immediately; it still covers a worker that replies earlier.
        let played = false;
        const duration = Number(res.duration);
        const spokenVoice = str(res.voiceId) || voice;
        if (wait === true) {
          played = await this.worker.waitPlayed(seqAtSend, Number.isFinite(duration) ? duration : 0);
        }

        const file = str(res.file_b64) ? unb64(res.file_b64) : str(res.file);
        const device = str(res.device) || '';
        const sampleRate = Number(res.sampleRate ?? res.sample_rate);
        const genSeconds = Number(res.genSeconds ?? res.gen_seconds);
        return ok({
          message: `已通过扬声器喊话（音色 ${spokenVoice || 'worker 默认'}）`,
          durationSeconds: Number.isFinite(duration) ? duration : null,
          device,
          deviceB64: b64(device),
          voiceId: spokenVoice,
          file,
          fileB64: file ? b64(file) : '',
          sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null,
          genSeconds: Number.isFinite(genSeconds) ? genSeconds : null,
          rtf: Number.isFinite(Number(res.rtf)) ? Number(res.rtf) : null,
          played,
          text: content,
        });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /** Stop the current playback immediately. */
    async stop() {
      try {
        if (!this.worker.running) {
          return ok({ message: '当前没有正在播放的语音', stopped: true });
        }
        const res = await this.worker.request('stop', {}, { timeoutMs: 20000 });
        if (!res.ok) return err(res.message, res.detail);
        return ok({ message: '已停止播放', stopped: true });
      } catch (e) {
        return err(toMessage(e));
      }
    }

    /**
     * Set the output endpoint. `device === ''` means "follow the system
     * default", which — with autoPickSpeaker — resolves to the loudspeakers.
     */
    async setDevice(device, volume) {
      try {
        const patch = { device: str(device) };
        if (volume !== undefined && volume !== null) patch.volume = clamp01(volume, this.config().volume);
        this.writeStoredConfig(patch);
        if (this.worker.running) {
          await this.applySettings(true);
        }
        return await this.status();
      } catch (e) {
        return this.statusError(toMessage(e));
      }
    }

    async setVolume(volume) {
      return await this.setDevice(this.config().device, clamp01(volume, this.config().volume));
    }

    /** Persist a partial config update and re-apply it to the worker. */
    async saveConfig(patch) {
      try {
        const input = patch && typeof patch === 'object' ? patch : {};
        const next = {};
        if (input.device !== undefined) next.device = str(input.device);
        if (input.volume !== undefined) next.volume = clamp01(input.volume, this.config().volume);
        if (input.language !== undefined && str(input.language).trim()) next.language = str(input.language).trim();
        if (input.maxNewTokens !== undefined) next.maxNewTokens = Math.max(0, Math.trunc(num(input.maxNewTokens, 0)));
        if (input.autoPickSpeaker !== undefined) next.autoPickSpeaker = input.autoPickSpeaker !== false;
        if (Object.keys(next).length) this.writeStoredConfig(next);
        if (this.worker.running) await this.applySettings(true);
        return await this.status();
      } catch (e) {
        return this.statusError(toMessage(e));
      }
    }

    /* ---------------- internal ---------------- */

    /** `voice-<ascii-slug>` with a numeric suffix on collision. */
    allocateVoiceId(title) {
      const slug = slugifyAscii(title);
      const seed = slug.length >= 2 ? slug.slice(0, 40) : 'voice';
      let id = seed;
      let n = 2;
      while (existsSync(this.voiceDir(id))) {
        id = `${seed}-${n++}`;
        if (n > 9999) { id = `voice-${Date.now().toString(36)}`; break; }
      }
      return id;
    }

    /** Kill the python worker (plugin unload). */
    async shutdown() {
      try {
        await this.worker.shutdown();
      } catch (e) {
        console.warn('[dsh-tts-speakout] shutdown 失败:', toMessage(e));
      }
    }
  };
})();

/* ================================================================== *
 * small utilities
 * ================================================================== */

function clamp01(value, fallback = 0.8) {
  // `null` / `undefined` / `''` mean "not specified, use the fallback".
  // Relying on Number() alone was a real bug: Number(null) is 0, which is
  // finite, so an unspecified volume silently became MUTE (the preview called
  // clamp01(null, cfg.volume) and returned 0 instead of the configured level).
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Config fingerprint used to decide whether the worker needs `set_device`. */
function configSig(cfg) {
  return JSON.stringify([
    cfg.device, cfg.volume, cfg.language, cfg.maxNewTokens, cfg.autoPickSpeaker,
  ]);
}

function normalizeMode(mode) {
  const m = str(mode).trim().toLowerCase();
  return m === 'xvec' ? 'xvec' : 'icl';
}

/** Keep ids ASCII-safe: they travel over the wire and name a directory. */
function slugifyAscii(title) {
  const base = str(title)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^0-9a-z\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base;
}

/** Never let a caller-supplied id escape the voices directory. */
function safeId(id) {
  return str(id).replace(/[\\/]/g, '').replace(/\.\.+/g, '').trim();
}

export { TtsSpeakoutService, TtsWorker };
export default TtsSpeakoutService;
