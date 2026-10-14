/**
 * dsh-tts-speakout browser half.
 *
 * One Settings page, registered into the `settings.section` list slot
 * (kind = list), with three stacked blocks:
 *
 *   1. 输出通道 — output-endpoint <select> fed by `remote.tts.devices()`,
 *      a 「重新枚举」 button, the effective endpoint, and the
 *      `autoPickSpeaker` switch (the key default of this plugin: on Windows
 *      the default endpoint is often the headphones, which are useless when
 *      the user is away from the desk — speakers must win).
 *   2. 音量 — 0–100% slider persisted through `saveConfig({ volume })` plus a
 *      「试听」 button that speaks one short line with the default voice.
 *   3. 音色（克隆母本）— 「导入母本音频」 (`pickAudio()` → small form →
 *      `importVoice`) and the voice list, where each row can be set as
 *      default, renamed, given a ref-text/mode, deleted, or previewed.
 *
 * Deliberately does NOT require `@deepseek-ai/dsh-client-ui-primitives` or
 * any other Harness Client package (docs/practices forbid it); the controls
 * are written here and styled with `--dsw-alias-*` theme tokens only.
 *
 * The whole page is wrapped in a React error boundary: without one, a throw
 * during render blanks the slot entry silently and the user loses the page.
 */
const React = require('react');
/** Shared wire contracts: bundled so the client can `$mount(TYPERT_REMOTE)`. */
const contracts = require('../../lib/contracts.js');
const TYPERT_REMOTE = contracts.TYPERT_REMOTE || contracts.default;

export const name = 'dsh-tts-speakout';
export const inject = ['slots', 'locale', 'remote'];

const NS = 'dsh-tts-speakout';

const zh = {
  sectionTitle: '扬声器喊话',
  heading: '扬声器喊话',
  intro: '你离开电脑时，agent 会用克隆音色通过扬声器喊话。',
  crash: '设置页渲染失败',
  loading: '正在读取状态…',
  reload: '刷新',
  reloading: '刷新中…',
  ready: '就绪',
  modelLoading: '模型加载中',
  notReady: '模型尚未就绪',
  workerRunning: 'worker 运行中',
  workerStopped: 'worker 未启动',
  audibleTitle: '可能听不到声音',
  sysVolume: '系统通道音量',
  muted: '已静音',
  endpointError: '通道状态读取失败',
  channelTitle: '输出通道',
  deviceLabel: '设备',
  deviceAuto: '跟随系统默认',
  deviceAutoHint: '由「自动优先扬声器」挑一个扬声器端点',
  deviceRecommended: '（推荐）',
  deviceDefault: '（系统默认）',
  deviceNone: '没有枚举到输出设备',
  deviceUnreachable: '（未插/不可用）',
  // The four names the agent is allowed to use. `primary`/`backup` are the two
  // slots used for ordinary announcements; `speakers`/`headphones` name the two
  // kinds of output. Each is bound by the user, independently.
  slot_primary: '默认输出（primary）',
  slot_backup: '备用输出（backup）',
  slot_speakers: '扬声器（speakers）',
  slot_headphones: '耳机（headphones）',
  slotDesc_primary: '用户没指定输出口时，喊话走这里',
  slotDesc_backup: '默认输出不可用时改用它；两个都不可用则放弃喊话',
  slotDesc_speakers: '用户明确要求「用扬声器」时走这里',
  slotDesc_headphones: '用户明确要求「用耳机」时走这里',
  slotDefault: '未绑定（按类型自动判断）',
  slotDefaultHint: '由插件按名称推断：扬声器槽找音箱类端点，耳机槽找耳机类端点',
  bindingOk: '可用',
  bindingUnreachable: '当前不可用',
  bindingMissing: '未找到该设备',
  rescan: '重新枚举',
  rescanning: '枚举中…',
  rescanDone: '已重新枚举，共 {count} 个输出设备',
  effective: '喊话输出通道',
  effectiveAuto: '（自动选择）',
  effectiveHint: '这是 worker 实际打开的端点：agent 喊话与上方「试听」都走它。',
  autoPick: '自动优先扬声器（避免选中耳机）',
  autoPickHint: '兜底用：仅在四个槽位都没绑定时生效。',
  volumeTitle: '音量',
  volumeLabel: '音量',
  volumeSaved: '音量已保存为 {percent}%',
  preview: '试听',
  previewing: '正在试听…',
  previewText: '这是一次试听，用于确认音色、音量与输出通道。',
  previewHint: '点「试听」会用当前音色、当前音量、当前喊话输出通道念一句，一次验证三项设置。',
  previewDone: '试听完成，用时 {seconds} 秒',
  voiceTitle: '音色（克隆母本）',
  voiceIntro: '导入一段母本音频，之后喊话就用这个音色。',
  importAudio: '导入母本音频',
  importPicking: '等待选择文件…',
  importFormTitle: '登记音色',
  importSource: '母本',
  importTitleLabel: '标题',
  importRefTextLabel: '参考文本',
  importRefTextHint: '母本里念的内容。填得越准，克隆越像；留空则用纯音频克隆。',
  importModeLabel: '模式',
  modeIcl: 'icl — 参考音频 + 参考文本',
  modeXvec: 'xvec — 仅参考音频',
  importConfirm: '确定导入',
  importCancel: '取消',
  importing: '导入中…',
  importDone: '已导入音色：{title}',
  noVoices: '还没有音色。导入一段母本音频即可开始。',
  voiceCount: '共 {count} 个音色',
  voiceDefault: '默认',
  defaultVoiceLabel: '当前默认音色',
  setDefault: '设为默认',
  setDefaultDone: '已设为默认音色：{title}',
  edit: '编辑',
  renameLabel: '标题',
  editRefTextLabel: '参考文本',
  editModeLabel: '模式',
  save: '保存',
  cancel: '取消',
  saved: '已保存：{title}',
  remove: '删除',
  removeConfirm: '删除音色「{title}」？此操作不可撤销。',
  removed: '已删除音色：{title}',
  hasRefText: '已填参考文本',
  noRefText: '未填参考文本',
  language: '语言',
  none: '无',
  unknownError: '操作失败',
  needTitle: '请先填写标题',
};

const en = {
  sectionTitle: 'Speaker Speak-out',
  heading: 'Speaker Speak-out',
  intro: 'When you are away from the computer, the agent speaks through the speakers with a cloned voice.',
  crash: 'This settings page failed to render',
  loading: 'Reading state…',
  reload: 'Refresh',
  reloading: 'Refreshing…',
  ready: 'Ready',
  modelLoading: 'Loading model',
  notReady: 'Model not ready',
  workerRunning: 'worker running',
  workerStopped: 'worker not started',
  audibleTitle: 'You may not hear anything',
  sysVolume: 'Endpoint volume',
  muted: 'muted',
  endpointError: 'Could not read the endpoint state',
  channelTitle: 'Output channel',
  deviceLabel: 'Device',
  deviceAuto: 'Follow the system default',
  deviceAutoHint: 'let "prefer speakers" pick a loudspeaker endpoint',
  deviceNone: 'No output devices were enumerated',
  deviceUnreachable: ' (unplugged/unavailable)',
  slot_primary: 'Default output (primary)',
  slot_backup: 'Backup output (backup)',
  slot_speakers: 'Speakers (speakers)',
  slot_headphones: 'Headphones (headphones)',
  slotDesc_primary: 'where speak-outs go when the user named no output',
  slotDesc_backup: 'used when the default output is unusable; if both fail, give up',
  slotDesc_speakers: 'used when the user explicitly asks for "the speakers"',
  slotDesc_headphones: 'used when the user explicitly asks for "my headphones"',
  slotDefault: 'Not bound (inferred by kind)',
  slotDefaultHint: 'inferred from the name: the speakers slot looks for loudspeaker-like endpoints, headphones for headset-like ones',
  bindingOk: 'available',
  bindingUnreachable: 'currently unavailable',
  bindingMissing: 'device not found',
  deviceRecommended: ' (recommended)',
  deviceDefault: ' (system default)',
  rescan: 'Re-enumerate',
  rescanning: 'Enumerating…',
  rescanDone: 'Re-enumerated: {count} output devices',
  effective: 'Speak-out channel',
  effectiveAuto: ' (auto-picked)',
  effectiveHint: 'The endpoint the worker actually opened: both the agent speak-outs and the preview above use it.',
  autoPick: 'Prefer loudspeakers over headphones',
  autoPickHint: 'Fallback only: applies when none of the four slots is bound.',
  volumeTitle: 'Volume',
  volumeLabel: 'Volume',
  volumeSaved: 'Volume saved as {percent}%',
  preview: 'Preview',
  previewing: 'Previewing…',
  previewText: '这是一次试听，用于确认音色、音量与输出通道。',
  previewHint: 'The single preview: it speaks a short line with the current voice, the current volume, and the current speak-out channel, verifying all three at once.',
  previewDone: 'Preview finished in {seconds}s',
  voiceTitle: 'Voices (clone references)',
  voiceIntro: 'Import a reference recording and speak-out will use that voice.',
  importAudio: 'Import reference audio',
  importPicking: 'Waiting for the file chooser…',
  importFormTitle: 'Register voice',
  importSource: 'Reference',
  importTitleLabel: 'Title',
  importRefTextLabel: 'Reference text',
  importRefTextHint: 'What is spoken in the recording. The more accurate, the closer the clone; leave empty for audio-only cloning.',
  importModeLabel: 'Mode',
  modeIcl: 'icl — reference audio + reference text',
  modeXvec: 'xvec — reference audio only',
  importConfirm: 'Import',
  importCancel: 'Cancel',
  importing: 'Importing…',
  importDone: 'Imported voice: {title}',
  noVoices: 'No voices yet. Import a reference recording to get started.',
  voiceCount: '{count} voices',
  voiceDefault: 'default',
  defaultVoiceLabel: 'Default voice',
  setDefault: 'Set as default',
  setDefaultDone: 'Default voice is now {title}',
  edit: 'Edit',
  renameLabel: 'Title',
  editRefTextLabel: 'Reference text',
  editModeLabel: 'Mode',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'Saved: {title}',
  remove: 'Delete',
  removeConfirm: 'Delete the voice "{title}"? This cannot be undone.',
  removed: 'Deleted voice: {title}',
  hasRefText: 'has reference text',
  noRefText: 'no reference text',
  language: 'Language',
  none: 'none',
  unknownError: 'Operation failed',
  needTitle: 'Enter a title first',
};

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

// Decode a UTF-8 base64 string. Paths, device names, voice titles and
// messages travel b64-encoded because the gateway can mangle non-ASCII text.
function b64ToStr(b64) {
  if (!b64 || typeof b64 !== 'string') return '';
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

/**
 * Read a text field that may have a `*B64` twin (the host sends both, b64 as a
 * fallback against gateway corruption; the python worker emits snake_case).
 * Both twins are tried as a *pair*: an empty-string camelCase twin must not
 * short-circuit the snake_case one, or a rename on either side fails silently.
 */
function txt(obj, field) {
  if (!obj) return '';
  for (const twin of [obj[field + 'B64'], obj[field + '_b64']]) {
    if (typeof twin === 'string' && twin) {
      const decoded = b64ToStr(twin);
      if (decoded) return decoded;
    }
  }
  const raw = obj[field];
  if (raw === null || raw === undefined) return '';
  return typeof raw === 'string' ? raw : String(raw);
}

function errText(e) {
  if (!e) return 'unknown';
  return String((e && e.message) || e);
}

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Choice list rendered as explicit rows instead of a native <select>.
 *
 * The native control is unusable here: its popup inherits system colours, and
 * unselected options rendered the same colour as the panel background, so the
 * list looked like it held a single entry. Explicit rows are visible, themeable
 * with the host tokens, and keyboard reachable.
 */
function RowChoice({ options, value, onChange, disabled }) {
  return React.createElement('div', { className: 'dshtts-devlist', role: 'radiogroup' },
    (options || []).map((opt, i) => React.createElement('button', {
      key: opt.value || String(i),
      type: 'button',
      role: 'radio',
      'aria-checked': value === opt.value ? 'true' : 'false',
      disabled: disabled === true,
      className: 'dshtts-devrow' + (value === opt.value ? ' dshtts-devrow-on' : ''),
      onClick: () => onChange(opt.value),
    },
      React.createElement('span', { className: 'dshtts-devrow-name' }, opt.label),
      opt.tag ? React.createElement('span', { className: 'dshtts-devrow-tag' }, opt.tag) : null,
    )));
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/* ------------------------------------------------------------------ *
 * remote facade
 * ------------------------------------------------------------------ */

/**
 * Wrap `ctx.remote.tts`. The gateway answers with an envelope
 * `{ ok, value }` (failure: `{ ok:false, error:{ message } }`), while the
 * host service itself never throws and reports its own outcome as
 * `value.ok === false` + `value.message`. Both shapes are handled so the
 * component only ever sees the service payload or a thrown transport error.
 */
function makeApi(remote) {
  const r = remote.tts;
  const call = async (promise) => {
    let res;
    try {
      res = await promise;
    } catch (e) {
      const err = new Error(errText(e));
      err.transport = true;
      throw err;
    }
    if (!res || typeof res !== 'object') throw new Error('remote returned no result');
    if (res.ok === true) {
      // Envelope with a service payload inside, or a directly-returned payload.
      if (res.value && typeof res.value === 'object' && 'ok' in res.value) return res.value;
      return res;
    }
    const err = new Error(txt(res, 'message') || (res.error && res.error.message) || 'rpc failed');
    err.detail = res.detail ?? (res.error && res.error.detail) ?? null;
    throw err;
  };
  return {
    status: () => call(r.status()),
    devices: (refresh) => call(r.devices(!!refresh)),
    voices: () => call(r.voices()),
    saveConfig: (patch) => call(r.saveConfig(patch)),
    testVoice: (id, text) => call(r.testVoice(id, text)),
    pickAudio: () => call(r.pickAudio()),
    importVoice: (title, filePath, refText, mode, language) =>
      call(r.importVoice(title, filePath, refText, mode, language)),
    deleteVoice: (id) => call(r.deleteVoice(id)),
    renameVoice: (id, title) => call(r.renameVoice(id, title)),
    setVoiceText: (id, refText, mode) => call(r.setVoiceText(id, refText, mode)),
    setDefaultVoice: (id) => call(r.setDefaultVoice(id)),
  };
}

/* ------------------------------------------------------------------ *
 * error boundary
 * ------------------------------------------------------------------ */

class SafeSection extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[dsh-tts-speakout] render error:', error, info);
  }
  render() {
    if (this.state.error !== null) {
      const detail = String((this.state.error && this.state.error.message) || this.state.error).slice(0, 160);
      return React.createElement('div', { className: 'dshtts-crash', role: 'alert' },
        (this.props.crashTitle || 'Error') + '：' + detail);
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ *
 * the settings page
 * ------------------------------------------------------------------ */

function TtsSection({ api, t }) {
  const [status, setStatus] = React.useState(null);
  const [devices, setDevices] = React.useState(null);
  // Diagnostics for "the dropdown only shows 跟随系统默认": record how many
  // endpoints each source reported, so the page can state where the list came
  // from instead of silently rendering one option.
  const [deviceDiag, setDeviceDiag] = React.useState(null);
  const [voices, setVoices] = React.useState(null);
  const [deviceChoice, setDeviceChoice] = React.useState('');
  /**
   * The user's binding for each of the four slots the agent may name. Kept as an
   * object because they are independent: `primary` / `backup` are the two slots
   * used for ordinary announcements and `speakers` / `headphones` name the two
   * kinds of output, but nothing is derived from anything else.
   */
  const [bindings, setBindings] = React.useState({ primary: '', backup: '', speakers: '', headphones: '' });
  /** Which slot's device list is currently expanded ('' = none). */
  const [editingSlot, setEditingSlot] = React.useState('');
  const [volume, setVolume] = React.useState(null);
  const [autoPick, setAutoPick] = React.useState(true);
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState(null);
  const [importForm, setImportForm] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState({ title: '', refText: '', mode: 'icl' });

  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const guard = React.useCallback((fn) => async (...args) => {
    if (!alive.current) return;
    try { await fn(...args); }
    catch (e) {
      if (alive.current) setNotice({ kind: 'err', text: errText(e) });
    }
  }, []);

  const applyStatus = React.useCallback((st) => {
    if (!st || typeof st !== 'object') return;
    setStatus(st);
    if (typeof st.volume === 'number') setVolume(clamp01(st.volume));
    else if (st.volume === undefined) setVolume((v) => (v === null ? 0.8 : v));
    if (typeof st.autoPickSpeaker === 'boolean') setAutoPick(st.autoPickSpeaker);
    if (Array.isArray(st.voices)) setVoices(st.voices);
    if (Array.isArray(st.devices) && st.devices.length) setDevices(st.devices);
    // `status().device` is the *effective* endpoint. When autoPickSpeaker
    // chose it, the persisted choice is still "follow the system default".
    setDeviceChoice(st.autoPicked ? '' : (st.device || ''));
    if (st.slotBindings && typeof st.slotBindings === 'object') {
      setBindings({
        primary: String(st.slotBindings.primary || ''),
        backup: String(st.slotBindings.backup || ''),
        speakers: String(st.slotBindings.speakers || ''),
        headphones: String(st.slotBindings.headphones || ''),
      });
    }
  }, []);

  const load = React.useCallback(async (opts) => {
    setBusy((opts && opts.busy) || 'load');
    try {
      const st = await api.status();
      if (!alive.current) return;
      applyStatus(st);
      const fromStatus = Array.isArray(st && st.devices) ? st.devices.length : -1;
      const dv = await api.devices(false);
      if (!alive.current) return;
      const fromDevices = dv && Array.isArray(dv.devices) ? dv.devices.length : -1;
      // Merge both sources rather than letting a shorter/later response win: a
      // successful `devices()` that yields nothing must not blank the dropdown.
      const merged = [];
      const seen = new Set();
      for (const src of [dv && dv.devices, st && st.devices]) {
        if (!Array.isArray(src)) continue;
        for (const d of src) {
          const name = txt(d, 'name');
          if (!name || seen.has(name)) continue;
          seen.add(name);
          merged.push(typeof d === 'object' && d !== null ? d : { name });
        }
      }
      if (merged.length) setDevices(merged);
      setDeviceDiag({ status: fromStatus, devices: fromDevices, merged: merged.length });
      const vv = await api.voices();
      if (!alive.current) return;
      if (vv && Array.isArray(vv.voices)) setVoices(vv.voices);
      setNotice(null);
    } catch (e) {
      if (alive.current) setNotice({ kind: 'err', text: errText(e) });
    } finally {
      if (alive.current) setBusy('');
    }
  }, [api, applyStatus]);

  React.useEffect(() => { load(); }, [load]);

  const applyVoices = React.useCallback((res) => {
    if (!res) return;
    if (Array.isArray(res.voices)) setVoices(res.voices);
    if (res.defaultVoice !== undefined) {
      setStatus((s) => (s ? Object.assign({}, s, { defaultVoice: res.defaultVoice }) : s));
    }
  }, []);

  /* ---- block 1: output channel ---- */

  const rescan = guard(async () => {
    setBusy('rescan');
    try {
      const res = await api.devices(true);
      if (!alive.current) return;
      if (Array.isArray(res.devices)) setDevices(res.devices);
      setNotice({
        kind: res.ok === false ? 'err' : 'ok',
        text: res.ok === false
          ? (txt(res, 'message') || t('unknownError'))
          : t('rescanDone', { count: (res.devices || []).length }),
      });
    } finally {
      if (alive.current) setBusy('');
    }
  });

  const chooseDevice = guard(async (value) => {
    setDeviceChoice(value);
    const res = await api.saveConfig({ device: value });
    if (!alive.current) return;
    applyStatus(res);
    if (res.ok === false) setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
  });

  const toggleAutoPick = guard(async (next) => {
    setAutoPick(next);
    const res = await api.saveConfig({ autoPickSpeaker: next });
    if (!alive.current) return;
    applyStatus(res);
    if (res.ok === false) {
      setAutoPick(!next);
      setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
    }
  });

  /* ---- slot bindings (the only names the agent may use) ---- */

  const SLOTS = ['primary', 'backup', 'speakers', 'headphones'];

  /** Persist one slot's binding, leaving the other three alone. */
  const changeBinding = guard(async (slot, deviceName) => {
    const next = { ...bindings, [slot]: deviceName };
    setBindings(next);
    const res = await api.saveConfig({ slotBindings: next });
    if (!alive.current) return;
    applyStatus(res);
    if (res.ok === false) setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
  });

  /**
   * What a binding currently resolves to. Mirrors the worker's rule: a binding
   * is a device-name substring, and an empty binding means "use this slot's
   * default" (speaker-like for `speakers`, headset-like for `headphones`, the
   * automatic pick for `primary`/`backup`).
   */
  const resolvedFor = React.useCallback((bound) => {
    if (!bound) return '';
    const needle = String(bound).toLowerCase();
    const hit = (rows || []).find((d) => txt(d, 'name').toLowerCase().includes(needle));
    if (!hit) return t('bindingMissing');
    if (hit.reachable === false) return t('bindingUnreachable');
    return t('bindingOk');
  }, [rows, t]);

  /* ---- block 2: volume ---- */

  const commitVolume = React.useCallback(async (v) => {
    const res = await api.saveConfig({ volume: clamp01(v) });
    if (!alive.current) return;
    applyStatus(res);
    if (res.ok === false) setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
  }, [api, applyStatus, t]);

  // Persist 350ms after the slider settles; skip while it already matches.
  React.useEffect(() => {
    if (volume === null || !status || typeof status.volume !== 'number') return;
    if (Math.abs(status.volume - volume) < 0.005) return;
    const id = window.setTimeout(() => { commitVolume(volume).catch(() => {}); }, 350);
    return () => window.clearTimeout(id);
  }, [volume, status, commitVolume]);

  const defaultVoiceId = status && status.defaultVoice
    ? status.defaultVoice
    : ((voices || []).find((v) => v && v.default) || {}).id || null;

  const preview = guard(async (voiceId) => {
    setBusy('preview');
    try {
      const res = await api.testVoice(voiceId || defaultVoiceId || '', t('previewText'));
      if (!alive.current) return;
      if (res.ok === false) {
        setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
        return;
      }
      const secs = typeof res.durationSeconds === 'number' ? res.durationSeconds.toFixed(1) : '–';
      setNotice({ kind: 'ok', text: t('previewDone', { seconds: secs }) });
    } finally {
      if (alive.current) setBusy('');
    }
  });

  /* ---- block 3: voices ---- */

  const pickAudio = guard(async () => {
    setBusy('pick');
    try {
      const res = await api.pickAudio();
      if (!alive.current) return;
      if (res.ok === false) {
        setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
        return;
      }
      if (res.cancelled) return;
      const path = txt(res, 'path');
      if (!path) {
        setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
        return;
      }
      // Suggested title: the host's file name without its extension, else the
      // base name of the path. Users rename it anyway.
      const suggested = (txt(res, 'name') || basename(path)).replace(/\.[^.\\/]+$/, '');
      setImportForm({ path, title: suggested, refText: '', mode: 'icl' });
      setNotice(null);
    } finally {
      if (alive.current) setBusy('');
    }
  });

  const doImport = guard(async () => {
    const form = importForm;
    if (!form || !form.path) return;
    const title = (form.title || '').trim();
    if (!title) {
      setNotice({ kind: 'err', text: t('needTitle') });
      return;
    }
    setBusy('import');
    try {
      const language = (status && status.language) || 'Chinese';
      const res = await api.importVoice(title, form.path, form.refText || '', form.mode || 'icl', language);
      if (!alive.current) return;
      applyVoices(res);
      if (res.ok === false) {
        setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
        return;
      }
      setImportForm(null);
      setNotice({ kind: 'ok', text: t('importDone', { title }) });
    } finally {
      if (alive.current) setBusy('');
    }
  });

  const setDefault = guard(async (voice) => {
    const res = await api.setDefaultVoice(voice.id);
    if (!alive.current) return;
    applyVoices(res);
    setNotice(res.ok === false
      ? { kind: 'err', text: txt(res, 'message') || t('unknownError') }
      : { kind: 'ok', text: t('setDefaultDone', { title: txt(voice, 'title') || voice.id }) });
  });

  const startEdit = (voice) => {
    setEditing(voice.id);
    setDraft({
      title: txt(voice, 'title') || voice.id,
      refText: typeof voice.refText === 'string' ? voice.refText : '',
      mode: voice.mode === 'xvec' ? 'xvec' : 'icl',
    });
  };

  const saveEdit = guard(async (voice) => {
    let res = await api.renameVoice(voice.id, (draft.title || '').trim() || voice.id);
    if (!alive.current) return;
    applyVoices(res);
    if (res.ok === false) {
      setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
      return;
    }
    res = await api.setVoiceText(voice.id, draft.refText || '', draft.mode || 'icl');
    if (!alive.current) return;
    applyVoices(res);
    if (res.ok === false) {
      setNotice({ kind: 'err', text: txt(res, 'message') || t('unknownError') });
      return;
    }
    setEditing(null);
    setNotice({ kind: 'ok', text: t('saved', { title: (draft.title || '').trim() || voice.id }) });
  });

  const removeVoice = guard(async (voice) => {
    const title = txt(voice, 'title') || voice.id;
    if (typeof window.confirm === 'function' && !window.confirm(t('removeConfirm', { title }))) return;
    const res = await api.deleteVoice(voice.id);
    if (!alive.current) return;
    applyVoices(res);
    if (editing === voice.id) setEditing(null);
    setNotice(res.ok === false
      ? { kind: 'err', text: txt(res, 'message') || t('unknownError') }
      : { kind: 'ok', text: t('removed', { title }) });
  });

  /* ---- render ---- */

  // The endpoint rows are derived BEFORE the early return below: `resolvedFor`
  // (a hook) already depends on them, and deriving them past the return would
  // make the hook read a stale/undefined value on the loading render.
  const deviceList = devices || [];
  const list = voices || [];
  const effective = status ? txt(status, 'device') : '';
  const configured = deviceChoice || '';
  // A configured endpoint the enumeration did not report still needs a row, or
  // the user cannot see (or keep) the current choice.
  const rows = deviceList.slice();
  if (configured && !rows.some((d) => txt(d, 'name') === configured)) {
    rows.push({ name: configured, hostapi: '', suggested: false, default: false });
  }

  // NOTE: no hooks may appear past this point — there is an early return below,
  // and calling a hook after it makes the hook count vary between renders
  // (React error #300, "rendered fewer hooks than expected").

  if (status === null && busy === 'load') {
    return React.createElement('div', { className: 'dshtts-section' },
      React.createElement('h2', { className: 'dshtts-heading' }, t('heading')),
      React.createElement('p', { className: 'dshtts-intro' }, t('loading')));
  }

  const percent = volume === null ? 80 : Math.round(clamp01(volume) * 100);

  const statusText = status
    ? (status.ready ? t('ready') : (status.loading ? t('modelLoading') : t('notReady')))
    : t('loading');

  // The one signal that explains "the agent says it spoke but I heard nothing":
  // the endpoint is muted / at 0% system gain. Without surfacing it, that looks
  // exactly like a successful render.
  const audibleWarning = status ? txt(status, 'audibleWarning') : '';
  const endpoint = status && status.endpoint ? status.endpoint : null;

  return React.createElement('div', { className: 'dshtts-section' },
    React.createElement('h2', { className: 'dshtts-heading' }, t('heading')),
    React.createElement('p', { className: 'dshtts-intro' }, t('intro')),

    React.createElement('div', { className: 'dshtts-statusline' },
      React.createElement('span', {
        className: 'dshtts-pill' + (status && status.ready ? ' dshtts-pill-ok' : ''),
      }, statusText),
      status && status.workerRunning !== undefined
        ? React.createElement('span', { className: 'dshtts-pill' },
            status.workerRunning ? t('workerRunning') : t('workerStopped'))
        : null,
      React.createElement('button', {
        type: 'button', className: 'dshtts-btn dshtts-btn-ghost dshtts-btn-sm',
        disabled: busy !== '',
        onClick: () => { load({ busy: 'load' }); },
      }, busy === 'load' ? t('reloading') : t('reload')),
    ),

    status && status.error
      ? React.createElement('div', { className: 'dshtts-err dshtts-nowrap' }, String(status.error))
      : null,

    /* Audible-risk banner: the only signal that distinguishes "spoke fine but
       the endpoint is muted / at 0% system gain" from a real success. */
    audibleWarning
      ? React.createElement('div', { className: 'dshtts-warn', role: 'alert' },
          React.createElement('div', { className: 'dshtts-warn-title' },
            '⚠ ' + t('audibleTitle')),
          React.createElement('div', { className: 'dshtts-warn-body' }, audibleWarning),
          endpoint && (typeof endpoint.volume === 'number' || endpoint.muted)
            ? React.createElement('div', { className: 'dshtts-warn-meta' },
                t('sysVolume') + '：'
                + (typeof endpoint.volume === 'number' ? Math.round(clamp01(endpoint.volume) * 100) + '%' : '—')
                + (endpoint.muted ? ' · ' + t('muted') : ''),
                endpoint.name ? ' · ' + String(endpoint.name) : '')
            : null,
          endpoint && endpoint.error
            ? React.createElement('div', { className: 'dshtts-warn-meta' },
                t('endpointError') + '：' + String(endpoint.error))
            : null,
        )
      : null,

    notice
      ? React.createElement('div', {
          className: notice.kind === 'ok' ? 'dshtts-ok' : 'dshtts-err',
          role: notice.kind === 'ok' ? 'status' : 'alert',
        }, notice.text)
      : null,

    /* ---------------- block 1: output channel ---------------- */
    React.createElement('section', { className: 'dshtts-card' },
      React.createElement('div', { className: 'dshtts-card-title' }, t('channelTitle')),

      React.createElement('div', { className: 'dshtts-row' },
        React.createElement('span', { className: 'dshtts-label' }, t('deviceLabel')),
        React.createElement('button', {
          type: 'button', className: 'dshtts-btn dshtts-btn-ghost',
          disabled: busy !== '',
          onClick: () => { rescan(); },
        }, busy === 'rescan' ? t('rescanning') : t('rescan')),
      ),

      // Four slot bindings. Each is bound INDEPENDENTLY: `primary`/`backup` are
      // the two slots used for ordinary announcements, `speakers`/`headphones`
      // name the two kinds of output. The agent may only ever name these four,
      // so this is where the user decides what each one actually points at.
      React.createElement('div', { className: 'dshtts-slots' },
        slots.map((slot) => {
          const bound = bindings[slot] || '';
          const open = editingSlot === slot;
          const resolved = resolvedFor(bound);
          return React.createElement('div', { key: slot, className: 'dshtts-slot' },
            React.createElement('div', { className: 'dshtts-slot-head' },
              React.createElement('span', { className: 'dshtts-slot-name' }, t('slot_' + slot)),
              React.createElement('span', { className: 'dshtts-slot-desc' }, t('slotDesc_' + slot)),
            ),
            React.createElement('button', {
              type: 'button',
              className: 'dshtts-devrow' + (bound ? ' dshtts-devrow-on' : ''),
              onClick: () => setEditingSlot(open ? '' : slot),
            },
              React.createElement('span', { className: 'dshtts-devrow-name' },
                bound || t('slotDefault')),
              React.createElement('span', { className: 'dshtts-devrow-tag' },
                resolved ? resolved : ''),
            ),
            open
              ? React.createElement('div', { className: 'dshtts-devlist' },
                  React.createElement('button', {
                    type: 'button',
                    className: 'dshtts-devrow' + (bound === '' ? ' dshtts-devrow-on' : ''),
                    onClick: () => { changeBinding(slot, ''); setEditingSlot(''); },
                  },
                    React.createElement('span', { className: 'dshtts-devrow-name' }, t('slotDefault')),
                    React.createElement('span', { className: 'dshtts-devrow-tag' }, t('slotDefaultHint')),
                  ),
                  rows.length === 0
                    ? React.createElement('div', { className: 'dshtts-hint' }, t('deviceNone'))
                    : rows.map((d, i) => {
                        const name = txt(d, 'name');
                        const host = d.hostapi ? d.hostapi : '';
                        const dead = d.reachable === false;
                        return React.createElement('button', {
                          key: name || String(i),
                          type: 'button',
                          className: 'dshtts-devrow' + (bound === name ? ' dshtts-devrow-on' : '')
                            + (dead ? ' dshtts-devrow-dead' : ''),
                          onClick: () => { changeBinding(slot, name); setEditingSlot(''); },
                        },
                          React.createElement('span', { className: 'dshtts-devrow-name' }, name),
                          React.createElement('span', { className: 'dshtts-devrow-tag' },
                            (dead ? t('deviceUnreachable') : '') + host),
                        );
                      }),
                )
              : null,
          );
        }),
      ),
      deviceDiag ? React.createElement('div', { className: 'dshtts-hint' },
        `设备来源诊断: status=${deviceDiag.status} / devices=${deviceDiag.devices} / 下拉选项=${deviceDiag.merged}`
      ) : null,

      // What the worker actually opened. This is the endpoint BOTH the agent's
      // speak-outs and this page's preview go to, so it must never be inferred
      // from the host's guess — that is how the panel ended up claiming
      // "扬声器" while the worker had resolved "耳机".
      React.createElement('div', { className: 'dshtts-row' },
        React.createElement('span', { className: 'dshtts-label' }, t('effective')),
        React.createElement('span', { className: 'dshtts-value' },
          effective || t('deviceAuto'),
          status && status.autoPicked ? React.createElement('span', { className: 'dshtts-dim' }, t('effectiveAuto')) : null),
      ),
      React.createElement('div', { className: 'dshtts-hint' }, t('effectiveHint')),

      React.createElement('div', { className: 'dshtts-row dshtts-switchrow' },
        React.createElement('button', {
          type: 'button', role: 'switch', 'aria-checked': autoPick ? 'true' : 'false',
          className: 'dshtts-switch' + (autoPick ? ' dshtts-switch-on' : ''),
          onClick: () => { toggleAutoPick(!autoPick); },
        }, React.createElement('span', { className: 'dshtts-knob' })),
        React.createElement('span', { className: 'dshtts-switchlabel' }, t('autoPick')),
      ),
      React.createElement('div', { className: 'dshtts-hint' }, t('autoPickHint')),
    ),

    /* ---------------- block 2: volume ---------------- */
    React.createElement('section', { className: 'dshtts-card' },
      React.createElement('div', { className: 'dshtts-card-title' }, t('volumeTitle')),
      React.createElement('div', { className: 'dshtts-row' },
        React.createElement('label', { className: 'dshtts-label', htmlFor: 'dshtts-volume' }, t('volumeLabel')),
        React.createElement('input', {
          id: 'dshtts-volume',
          className: 'dshtts-range',
          type: 'range', min: 0, max: 100, step: 1,
          value: percent,
          'aria-valuetext': percent + '%',
          onChange: (e) => setVolume(clamp01(Number(e.target.value) / 100)),
        }),
        React.createElement('span', { className: 'dshtts-percent' }, percent + '%'),
        // The one preview in the plugin: it speaks a short line through the
        // SELECTED endpoint, at the current volume, with the current voice — so
        // a single click verifies all three settings at once.
        React.createElement('button', {
          type: 'button', className: 'dshtts-btn dshtts-btn-ghost',
          disabled: busy !== '' || !defaultVoiceId,
          onClick: () => { preview(defaultVoiceId); },
        }, busy === 'preview' ? t('previewing') : t('preview')),
      ),
      React.createElement('div', { className: 'dshtts-hint' }, t('previewHint')),
      React.createElement('div', { className: 'dshtts-hint' },
        t('defaultVoiceLabel') + '：' + (defaultVoiceId || t('none'))),
    ),

    /* ---------------- block 3: voices ---------------- */
    React.createElement('section', { className: 'dshtts-card' },
      React.createElement('div', { className: 'dshtts-card-title' }, t('voiceTitle')),
      React.createElement('div', { className: 'dshtts-hint' }, t('voiceIntro')),

      React.createElement('div', { className: 'dshtts-row' },
        React.createElement('button', {
          type: 'button', className: 'dshtts-btn dshtts-btn-primary',
          disabled: busy !== '',
          onClick: () => { pickAudio(); },
        }, busy === 'pick' ? t('importPicking') : t('importAudio')),
        React.createElement('span', { className: 'dshtts-dim' }, t('voiceCount', { count: list.length })),
      ),

      importForm
        ? React.createElement('div', { className: 'dshtts-form' },
            React.createElement('div', { className: 'dshtts-form-title' }, t('importFormTitle')),
            React.createElement('div', { className: 'dshtts-hint dshtts-nowrap' },
              t('importSource') + '：' + importForm.path),
            React.createElement('label', { className: 'dshtts-field' },
              React.createElement('span', { className: 'dshtts-field-label' }, t('importTitleLabel')),
              React.createElement('input', {
                className: 'dshtts-input', type: 'text', value: importForm.title,
                onChange: (e) => setImportForm(Object.assign({}, importForm, { title: e.target.value })),
              }),
            ),
            React.createElement('label', { className: 'dshtts-field' },
              React.createElement('span', { className: 'dshtts-field-label' }, t('importRefTextLabel')),
              React.createElement('textarea', {
                className: 'dshtts-input dshtts-textarea', rows: 3, value: importForm.refText,
                onChange: (e) => setImportForm(Object.assign({}, importForm, { refText: e.target.value })),
              }),
            ),
            React.createElement('div', { className: 'dshtts-hint' }, t('importRefTextHint')),
            React.createElement('label', { className: 'dshtts-field' },
              React.createElement('span', { className: 'dshtts-field-label' }, t('importModeLabel')),
              React.createElement(RowChoice, {
                options: [
                  { value: 'icl', label: t('modeIcl') },
                  { value: 'xvec', label: t('modeXvec') },
                ],
                value: importForm.mode,
                onChange: (v) => setImportForm(Object.assign({}, importForm, { mode: v })),
                disabled: busy !== '',
              }),
            ),
            React.createElement('div', { className: 'dshtts-row' },
              React.createElement('button', {
                type: 'button', className: 'dshtts-btn dshtts-btn-primary',
                disabled: busy !== '',
                onClick: () => { doImport(); },
              }, busy === 'import' ? t('importing') : t('importConfirm')),
              React.createElement('button', {
                type: 'button', className: 'dshtts-btn dshtts-btn-ghost',
                disabled: busy !== '',
                onClick: () => setImportForm(null),
              }, t('importCancel')),
            ),
          )
        : null,

      list.length === 0
        ? React.createElement('div', { className: 'dshtts-hint' },
            voices === null ? t('loading') : t('noVoices'))
        : React.createElement('ul', { className: 'dshtts-voicelist' },
            list.map((voice) => {
              const title = txt(voice, 'title') || voice.id;
              const isDefault = voice.id === defaultVoiceId || voice.default === true;
              const open = editing === voice.id;
              return React.createElement('li', { key: voice.id, className: 'dshtts-voice' },
                React.createElement('div', { className: 'dshtts-voice-head' },
                  React.createElement('span', { className: 'dshtts-voice-title' }, title),
                  isDefault ? React.createElement('span', { className: 'dshtts-badge' }, t('voiceDefault')) : null,
                  React.createElement('span', { className: 'dshtts-dim dshtts-voice-meta' },
                    (voice.mode === 'xvec' ? 'xvec' : 'icl')
                    + ' · ' + (voice.language || '—')
                    + ' · ' + (voice.hasRefText === false ? t('noRefText') : t('hasRefText'))),
                ),
                React.createElement('div', { className: 'dshtts-row dshtts-voice-actions' },
                  React.createElement('button', {
                    type: 'button', className: 'dshtts-btn dshtts-btn-ghost dshtts-btn-sm',
                    disabled: busy !== '' || isDefault, onClick: () => { setDefault(voice); },
                  }, t('setDefault')),
                  React.createElement('button', {
                    type: 'button', className: 'dshtts-btn dshtts-btn-ghost dshtts-btn-sm',
                    disabled: busy !== '',
                    onClick: () => { if (open) setEditing(null); else startEdit(voice); },
                  }, open ? t('cancel') : t('edit')),
                  React.createElement('button', {
                    type: 'button', className: 'dshtts-btn dshtts-btn-danger dshtts-btn-sm',
                    disabled: busy !== '', onClick: () => { removeVoice(voice); },
                  }, t('remove')),
                ),
                open
                  ? React.createElement('div', { className: 'dshtts-form' },
                      React.createElement('label', { className: 'dshtts-field' },
                        React.createElement('span', { className: 'dshtts-field-label' }, t('renameLabel')),
                        React.createElement('input', {
                          className: 'dshtts-input', type: 'text', value: draft.title,
                          onChange: (e) => setDraft(Object.assign({}, draft, { title: e.target.value })),
                        }),
                      ),
                      React.createElement('label', { className: 'dshtts-field' },
                        React.createElement('span', { className: 'dshtts-field-label' }, t('editRefTextLabel')),
                        React.createElement('textarea', {
                          className: 'dshtts-input dshtts-textarea', rows: 3, value: draft.refText,
                          onChange: (e) => setDraft(Object.assign({}, draft, { refText: e.target.value })),
                        }),
                      ),
                      React.createElement('label', { className: 'dshtts-field' },
                        React.createElement('span', { className: 'dshtts-field-label' }, t('editModeLabel')),
                        React.createElement(RowChoice, {
                          options: [
                            { value: 'icl', label: t('modeIcl') },
                            { value: 'xvec', label: t('modeXvec') },
                          ],
                          value: draft.mode,
                          onChange: (v) => setDraft(Object.assign({}, draft, { mode: v })),
                          disabled: busy !== '',
                        }),
                      ),
                      React.createElement('div', { className: 'dshtts-row' },
                        React.createElement('button', {
                          type: 'button', className: 'dshtts-btn dshtts-btn-primary',
                          disabled: busy !== '', onClick: () => { saveEdit(voice); },
                        }, t('save')),
                        React.createElement('button', {
                          type: 'button', className: 'dshtts-btn dshtts-btn-ghost',
                          disabled: busy !== '', onClick: () => setEditing(null),
                        }, t('cancel')),
                      ),
                    )
                  : null,
              );
            }),
          ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * css — theme tokens only
 * ------------------------------------------------------------------ */

const CSS = `
.dshtts-section{max-width:760px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e6e6e6);
  display:flex;flex-direction:column;gap:12px;font-size:13px}
.dshtts-heading{margin:0;font-size:18px;font-weight:600}
.dshtts-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9))}
.dshtts-statusline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dshtts-pill{padding:2px 8px;border-radius:999px;font-size:11px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dshtts-pill-ok{color:var(--dsw-alias-state-business-primary,#2f6df6);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2f6df6) 14%,transparent)}
.dshtts-card{display:flex;flex-direction:column;gap:9px;padding:12px 14px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28))}
.dshtts-card-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshtts-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshtts-label{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));min-width:52px}
.dshtts-value{color:var(--dsw-alias-label-primary,#e6e6e6);word-break:break-all}
.dshtts-dim{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9))}
.dshtts-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));line-height:1.5}
.dshtts-nowrap{word-break:break-all}
.dshtts-warn{display:flex;flex-direction:column;gap:3px;padding:9px 11px;border-radius:9px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6a700) 50%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e6a700) 13%,transparent);
  color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-primary,#e6e6e6))}
.dshtts-warn-title{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#e6a700)}
.dshtts-warn-body{font-size:12px;line-height:1.55}
.dshtts-warn-meta{font-size:11px;line-height:1.5;
  color:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-label-secondary,rgba(128,128,128,.95)))}
.dshtts-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff3b30)}
.dshtts-ok{font-size:12px;color:var(--dsw-alias-state-business-primary,#2f6df6)}
.dshtts-crash{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;
  color:var(--dsw-alias-state-error-primary,#ff3b30);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff3b30) 45%,transparent)}
.dshtts-input{min-height:28px;padding:3px 8px;box-sizing:border-box;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));
  color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;font-family:inherit}
.dshtts-devlist{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto;
  border:1px solid var(--dsw-alias-line-secondary, rgba(128,128,128,.18));border-radius:8px;padding:4px}
.dshtts-devrow{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;
  padding:4px 8px;border-radius:6px;border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-primary,#fff);font-size:12px;font-family:inherit}
.dshtts-devrow:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))}
.dshtts-devrow-on{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18));
  border-color:var(--dsw-alias-state-success-primary, rgba(120,120,120,.5))}
.dshtts-devrow-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshtts-devrow-tag{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))}
/* An endpoint Windows reports as inactive (unplugged jack). Dimmed, not hidden:
   the user still needs to see that it exists to understand why it is skipped. */
.dshtts-devrow-dead{opacity:.55}
/* The four slots the agent may name. Stacked cards rather than one list, because
   each is an independent decision and some are described in one line. */
.dshtts-slots{display:flex;flex-direction:column;gap:10px}
.dshtts-slot{display:flex;flex-direction:column;gap:4px;
  padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-line-secondary, rgba(128,128,128,.18))}
.dshtts-slot-head{display:flex;flex-direction:column;gap:1px}
.dshtts-slot-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#fff)}
.dshtts-slot-desc{font-size:11px;color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))}
.dshtts-input{width:100%}
.dshtts-textarea{resize:vertical;min-height:56px;line-height:1.5}
.dshtts-input:focus-visible,.dshtts-btn:focus-visible,.dshtts-range:focus-visible,
.dshtts-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2f6df6));outline-offset:2px}
.dshtts-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;
  padding:0 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));
  color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshtts-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,#888) 12%,var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1)))}
.dshtts-btn:disabled{opacity:.45;cursor:default}
.dshtts-btn-sm{min-height:24px;padding:0 8px;font-size:11px}
.dshtts-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#2f6df6);color:#fff}
.dshtts-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.dshtts-btn-danger{color:var(--dsw-alias-state-error-primary,#ff3b30)}
.dshtts-switchrow{gap:8px}
.dshtts-switch{position:relative;flex:0 0 auto;width:34px;height:20px;padding:0;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));transition:background .15s ease}
.dshtts-switch-on{border-color:transparent;background:var(--dsw-alias-state-business-primary,#2f6df6)}
.dshtts-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;
  transition:transform .15s ease}
.dshtts-switch-on .dshtts-knob{transform:translateX(14px)}
.dshtts-switchlabel{font-size:12px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshtts-range{flex:1;min-width:140px;max-width:320px;accent-color:var(--dsw-alias-state-business-primary,#2f6df6)}
.dshtts-percent{font-size:12px;min-width:38px;text-align:right;
  color:var(--dsw-alias-label-primary,#e6e6e6);font-variant-numeric:tabular-nums}
.dshtts-form{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:9px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}
.dshtts-form-title{font-size:12px;font-weight:600}
.dshtts-field{display:flex;flex-direction:column;gap:4px}
.dshtts-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95))}
.dshtts-voicelist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.dshtts-voice{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}
.dshtts-voice-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dshtts-voice-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshtts-voice-meta{margin-left:auto}
.dshtts-voice-actions{gap:6px}
.dshtts-badge{padding:1px 6px;border-radius:999px;font-size:10px;
  color:var(--dsw-alias-state-business-primary,#2f6df6);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2f6df6) 14%,transparent)}
`;

function installCss() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector('style[data-plugin-css="dsh-tts-speakout/section.css"]');
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-tts-speakout';
  style.dataset.pluginCss = 'dsh-tts-speakout/section.css';
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

/* ------------------------------------------------------------------ *
 * plugin entry
 * ------------------------------------------------------------------ */

async function apply(ctx) {
  const t = ctx.locale.bind(NS);
  const disposeLocale = ctx.locale.register(NS, { zh, en });
  const removeCss = installCss();

  // Mount this plugin's Typert client artifact so `ctx.remote.tts` resolves.
  let disposeRemote = null;
  try {
    disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  } catch (e) {
    console.error('[dsh-tts-speakout] remote $mount failed:', e);
  }

  const feature = ctx.inject(['remote.tts'], (scope) => {
    const api = makeApi(scope.remote);
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'dsh-tts-speakout',
      order: 25,
      label: () => t('sectionTitle'),
      locale: NS,
    }, (props) => React.createElement(
      SafeSection,
      { crashTitle: t('crash') },
      React.createElement(TtsSection, Object.assign({}, props, { api, t })),
    )));
    return () => {};
  });

  return async () => {
    await feature.dispose();
    disposeLocale();
    if (disposeRemote) await disposeRemote();
    removeCss();
  };
}

export default { apply, inject };
