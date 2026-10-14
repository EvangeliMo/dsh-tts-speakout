/**
 * dsh-tts-speakout shared wire contracts (zod v4).
 *
 * Compiled twice:
 *  - host  : loaded through the package's `./typert` export (TYPERT face = 'host')
 *  - client: bundled by scripts/build-client.mjs and mounted with
 *            `ctx.remote.$mount(TYPERT_REMOTE)`
 *
 * Shape is copied verbatim from dsh-flp-studio/lib/contracts.js (the frozen
 * reference implementation) so the two plugins stay byte-compatible with the
 * Typert gateway:
 *   - descriptor ids  : `dsh-tts-speakout#tts/<method>`
 *   - service/namespace: `tts`  (client reaches them as `ctx.remote.tts.*`)
 *   - codec           : `strict(typeSymbol, schema)` = { mode, typeSymbol, create, decode }
 *
 * Host result convention (never throws, see CONTRACT.md §3):
 *   { ok: true,  message: 'ok', detail: null, ...payload }
 *   { ok: false, message: '<原因>', detail: null|string }
 * All Chinese payloads additionally carry a `*B64` twin (device name / voice
 * title / file path / message) so the gateway cannot mangle non-ASCII text.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitive payload types
 * ------------------------------------------------------------------ */

export const deviceInfo = z.object({
  index: z.number(),
  name: z.string(),
  /** UTF-8 base64 twin of `name` (Chinese device names). */
  nameB64: z.string().optional(),
  hostapi: z.string().optional(),
  /** True when the OS reports this as the default output endpoint. */
  default: z.boolean().optional(),
  /** True when autoPickSpeaker would choose this endpoint. */
  suggested: z.boolean().optional(),
  /** Name looks like loudspeakers rather than headphones. */
  isSpeaker: z.boolean().optional(),
  /** Name looks like a virtual/loopback device. */
  isVirtual: z.boolean().optional(),
  /**
   * False when Windows reports the endpoint as inactive — a jack with nothing
   * plugged in. PortAudio still lists such devices, so presence is not
   * availability: the settings page greys them out and the worker refuses to
   * speak through them.
   */
  reachable: z.boolean().optional(),
}).readonly();

export const voiceInfo = z.object({
  id: z.string(),
  title: z.string(),
  /** UTF-8 base64 twin of `title`. */
  titleB64: z.string().optional(),
  mode: z.string().optional(),
  language: z.string().optional(),
  hasRefText: z.boolean().optional(),
  refText: z.string().optional(),
  createdAt: z.string().optional(),
  refSha256: z.string().optional(),
  /**
   * True when the mother-tone audio actually exists on disk
   * (`<voices>/<id>/ref.wav`). `hasRefText` only says whether a reference
   * TRANSCRIPT was filled in — a preset can have text but a missing file.
   */
  hasRef: z.boolean().optional(),
  /** True for the persisted default voice. */
  default: z.boolean().optional(),
  /** 'host' = persisted preset, 'worker' = reported by the python worker. */
  source: z.string().optional(),
}).readonly();

/* ------------------------------------------------------------------ *
 * Result envelopes
 * ------------------------------------------------------------------ */

export const statusResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  ready: z.boolean().optional(),
  loading: z.boolean().optional(),
  error: z.string().nullable().optional(),
  modelPath: z.string().optional(),
  modelB64: z.string().optional(),
  pythonPath: z.string().optional(),
  samplerate: z.number().nullable().optional(),
  /** Effective output endpoint currently used by the worker. */
  device: z.string().optional(),
  deviceB64: z.string().optional(),
  /**
   * Which slot of the routing chain actually won ('' = auto-pick or a pin).
   * Surfaced so "using backup because primary is unplugged" is visible instead
   * of being a silent switch.
   */
  deviceSource: z.string().optional(),
  deviceSourceB64: z.string().optional(),
  /** User binding for each of the four slots the agent may name. */
  slotBindings: z.object({
    primary: z.string().optional(),
    backup: z.string().optional(),
    speakers: z.string().optional(),
    headphones: z.string().optional(),
  }).optional(),
  /** The order the routing decision walks, for display in Settings. */
  routeChain: z.array(z.string()).optional(),
  /** True when `device` was auto-picked by autoPickSpeaker. */
  autoPicked: z.boolean().optional(),
  volume: z.number().optional(),
  language: z.string().optional(),
  maxNewTokens: z.number().optional(),
  autoPickSpeaker: z.boolean().optional(),
  defaultVoice: z.string().nullable().optional(),
  voiceCount: z.number().optional(),
  workerRunning: z.boolean().optional(),
  /**
   * Human-readable warning when the chosen endpoint cannot actually be heard
   * (muted, or system volume at 0%). Without this the failure mode is a
   * perfectly successful render that nobody hears.
   */
  audibleWarning: z.string().nullable().optional(),
  /** UTF-8 base64 twin of `audibleWarning`. */
  audibleWarningB64: z.string().optional(),
  /** Windows endpoint gain/mute for the chosen device, when readable. */
  endpoint: z.object({
    name: z.string().optional(),
    volume: z.number().optional(),
    muted: z.boolean().optional(),
    error: z.string().optional(),
  }).nullable().optional(),
  voices: z.array(voiceInfo).optional().readonly(),
  devices: z.array(deviceInfo).optional().readonly(),
}).readonly();

export const devicesResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  devices: z.array(deviceInfo).optional().readonly(),
  /** Name of the endpoint autoPickSpeaker would select (null when none). */
  suggested: z.string().nullable().optional(),
  suggestedB64: z.string().optional(),
  effective: z.string().optional(),
  effectiveB64: z.string().optional(),
  volume: z.number().optional(),
}).readonly();

export const voicesResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  voices: z.array(voiceInfo).optional().readonly(),
  defaultVoice: z.string().nullable().optional(),
  voiceCount: z.number().optional(),
}).readonly();

export const voiceResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  voice: voiceInfo.nullable().optional(),
  voices: z.array(voiceInfo).optional().readonly(),
  defaultVoice: z.string().nullable().optional(),
  voiceCount: z.number().optional(),
}).readonly();

export const pickResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  pathB64: z.string().optional(),
  name: z.string().optional(),
  nameB64: z.string().optional(),
  cancelled: z.boolean().optional(),
}).readonly();

export const speakResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** UTF-8 base64 twin of `message` (Chinese status/error text). */
  messageB64: z.string().optional(),
  detail: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  device: z.string().optional(),
  deviceB64: z.string().optional(),
  voiceId: z.string().optional(),
  file: z.string().optional(),
  fileB64: z.string().optional(),
  sampleRate: z.number().nullable().optional(),
  genSeconds: z.number().nullable().optional(),
  rtf: z.number().nullable().optional(),
  /** True when playback was reported as finished before returning. */
  played: z.boolean().optional(),
  stopped: z.boolean().optional(),
  /** Echo of the text that was spoken (helps the UI label the call). */
  text: z.string().optional(),
  /** Resolved endpoint index actually opened. */
  deviceIndex: z.number().nullable().optional(),

}).readonly();

export const saveConfigPatch = z.object({
  device: z.string().optional(),
  volume: z.number().optional(),
  language: z.string().optional(),
  maxNewTokens: z.number().optional(),
  /** 未指定 device 时是否自动优先挑「扬声器」而非「耳机」 */
  autoPickSpeaker: z.boolean().optional(),
  /** User binding for each of the four slots the agent may name. */
  slotBindings: z.object({
    primary: z.string().optional(),
    backup: z.string().optional(),
    speakers: z.string().optional(),
    headphones: z.string().optional(),
  }).optional(),
}).readonly();

/** The four names the agent may pass as `device`; each is bound by the user. */
export const slotBindingsSchema = z.object({
  primary: z.string(),
  backup: z.string(),
  speakers: z.string(),
  headphones: z.string(),
}).readonly();

/* ------------------------------------------------------------------ *
 * Descriptors
 * ------------------------------------------------------------------ */

// dsh >= 0.2.0 strict codecs expose create() returning the schema (the typert
// registry materialises it lazily) plus optional decode/encode. The old shape
// carried the schema inline as `schema`, which the 0.2 runtime ignores.
const strict = (typeSymbol, schema) => ({
  mode: 'strict',
  typeSymbol,
  create: () => schema,
  decode: (value) => schema.parse(value),
});
const parameter = (name, schema) => ({ name, wire: name, source: 'json', codec: strict(`dsh-tts-speakout/types#${name}`, schema) });

const descriptor = (method, parameters, result, resultSymbol) => ({
  id: `dsh-tts-speakout#tts/${method}`,
  service: 'tts',
  namespace: 'tts',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: strict(`dsh-tts-speakout/types#${resultSymbol}`, result),
});

export const descriptors = [
  descriptor('status', [], statusResult, 'StatusResult'),
  descriptor('devices', [parameter('refresh', z.boolean().optional())], devicesResult, 'DevicesResult'),
  descriptor('voices', [], voicesResult, 'VoicesResult'),
  descriptor('importVoice', [
    parameter('title', z.string()),
    parameter('filePath', z.string()),
    parameter('refText', z.string().optional()),
    parameter('mode', z.string().optional()),
    parameter('language', z.string().optional()),
  ], voiceResult, 'VoiceResult'),
  descriptor('pickAudio', [], pickResult, 'PickResult'),
  descriptor('deleteVoice', [parameter('id', z.string())], voiceResult, 'VoiceResult'),
  descriptor('renameVoice', [parameter('id', z.string()), parameter('title', z.string())], voiceResult, 'VoiceResult'),
  descriptor('setVoiceText', [parameter('id', z.string()), parameter('refText', z.string()), parameter('mode', z.string().optional())], voiceResult, 'VoiceResult'),
  descriptor('setDefaultVoice', [parameter('id', z.string())], voiceResult, 'VoiceResult'),
  descriptor('testVoice', [parameter('id', z.string()), parameter('text', z.string().optional())], speakResult, 'SpeakResult'),
  descriptor('speak', [parameter('text', z.string()), parameter('voiceId', z.string().optional()), parameter('volume', z.number().optional()), parameter('device', z.string().optional())], speakResult, 'SpeakResult'),
  descriptor('stop', [], speakResult, 'SpeakResult'),
  descriptor('setDevice', [parameter('device', z.string()), parameter('volume', z.number().optional())], statusResult, 'StatusResult'),
  descriptor('setVolume', [parameter('volume', z.number())], statusResult, 'StatusResult'),
  descriptor('saveConfig', [parameter('patch', saveConfigPatch)], statusResult, 'StatusResult'),
  descriptor('setSlotBindings', [parameter('bindings', saveConfigPatch)], statusResult, 'StatusResult'),
];

/** Client Typert artifact mounted via ctx.remote.$mount. */
export const TYPERT_REMOTE = { package: 'dsh-tts-speakout', descriptors };

/** Host Typert artifact loaded from the package's `./typert` export. */
export const TYPERT = {
  package: 'dsh-tts-speakout',
  face: 'host',
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export default TYPERT_REMOTE;
