/**
 * dsh-tts-speakout agent tools (Cordis plugin entry).
 *
 * The model gets exactly TWO tools, and only one of them acts:
 *
 *  - `dsh_speak`      — say a sentence out loud (the only action)
 *  - `dsh_tts_status` — read-only self-check (voice, volume, channel, readiness)
 *
 * Everything else is deliberately withheld from the model:
 *
 *  - **No `voice` argument.** The voice always follows the user's own setting.
 *    A model must not be able to speak in a voice the user did not select.
 *  - **No `wait` argument.** Playback always blocks until it has finished, so a
 *    returned success genuinely means the sentence was heard.
 *  - **No device argument, no device switching, no voice import/rename/delete.**
 *    The model can report what the channel is; only the user changes it.
 *
 * The self-check tool never mutates anything: a user asking "why didn't I hear
 * it?" gets an answer without the model changing a single setting.
 *
 * Error policy: `dsh_speak` throws on failure so the model cannot silently
 * believe a sentence was spoken; `dsh_tts_status` returns `ok:false` with the
 * exact reason instead of throwing, because a thrown error would discard the
 * very payload needed to explain the problem.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'tts-speakout-tools';
export const inject = ['tools', 'tts'];

const DESCRIPTION_SPEAK =
  'Speak a short sentence OUT LOUD through the computer\'s speakers (扬声器) using the user\'s own cloned voice. '
  + 'Use this when the user may not be sitting at the computer — typically right after finishing a long task '
  + '(build, training run, download, long analysis) — so they hear by voice that the work is done or that their '
  + 'input is needed. The output channel and the voice come from the user\'s own settings and cannot be changed '
  + 'here: it never uses the system default device, but the SPEAKERS endpoint the user configured, so someone '
  + 'away from the desk still hears it. '
  + 'Write 1-2 short, natural spoken sentences in the user\'s own language (plain Chinese for a Chinese user), '
  + 'no markdown, no code, no URLs. '
  + 'VOLUME: leave the `volume` argument UNSET in every normal case — the user\'s configured volume is used, and '
  + 'that is almost always what they want. Only set it when the user explicitly asks for a different loudness in '
  + 'this conversation, for example "提醒我时大声点" / "shout it" (about 0.9-1.0), or "小声说" / "quietly" '
  + '(about 0.2-0.3). It applies to this one call only and is never persisted. '
  + 'The call returns only after playback has finished. If it fails, call dsh_tts_status to see the exact reason.';

const DESCRIPTION_STATUS =
  'Read-only self-check of the speak-out (text-to-speech) subsystem: the voice that will be used, the current '
  + 'volume, the output channel it will speak through, and whether the model/worker is ready. '
  + 'It also reports why the user might not hear anything (endpoint muted or at 0% system volume). '
  + 'Call this when the user reports a problem such as "I did not hear it" — it never changes any setting.';

function apply(ctx) {
  const disposers = [];

  const speakTool = defineTool({
    name: 'dsh_speak',
    description: DESCRIPTION_SPEAK,
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'What to say out loud. Natural spoken language, 1-2 short sentences (Chinese for a Chinese user). No markdown or code.',
      },
      volume: {
        type: 'number',
        description: 'Leave UNSET unless the user explicitly asked for a different loudness in this conversation '
          + '(e.g. a very loud reminder ~0.9-1, or a quiet one ~0.2-0.3). Unset means the volume the user '
          + 'configured is used, which is the normal choice. Applies to this call only; never persisted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string' },
          durationSeconds: { type: 'number' },
          device: { type: 'string' },
          voiceId: { type: 'string' },
          file: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `🔊 已喊话完毕（音色 ${value.voiceId || '用户设置的音色'}，通道 ${value.device || '用户设置的通道'}）`,
          value.durationSeconds ? `语音时长 ${value.durationSeconds.toFixed(2)}s` : '',
        ].filter(Boolean).join('\n'),
      }],
    },
    // Playback always waits, so the timeout must cover a real utterance plus a
    // cold model load (about 10 s) and synthesis (RTF ~2.2 here).
    timeoutMs: 300000,
    async execute(args) {
      if (!ctx.tts) throw new Error('TTS 服务未加载（dsh-tts-speakout 宿主插件未启用）');
      // voice = null -> the worker resolves the user's default voice itself.
      // wait  = true -> return only once playback has actually finished.
      const res = await ctx.tts.speak(args.text, null, args.volume, true);
      if (!res.ok) {
        // Never swallow: the model must know the sentence was NOT spoken.
        throw new Error(`喊话失败: ${res.message || 'unknown error'}（可用 dsh_tts_status 自查原因）`);
      }
      const duration = typeof res.durationSeconds === 'number' && Number.isFinite(res.durationSeconds)
        ? res.durationSeconds
        : 0;
      return {
        ok: true,
        message: res.message || 'ok',
        durationSeconds: duration,
        device: res.device || '',
        voiceId: res.voiceId || '',
        file: res.file || '',
      };
    },
    presentCall(args) {
      const preview = String(args.text ?? '').replace(/\s+/g, ' ').slice(0, 30);
      return { card: 'generic', title: `喊话: ${preview}`, kind: 'other', rawInput: preview };
    },
  });

  const statusTool = defineTool({
    name: 'dsh_tts_status',
    description: DESCRIPTION_STATUS,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string' },
          ready: { type: 'boolean' },
          loading: { type: 'boolean' },
          error: { type: 'string' },
          voiceId: { type: 'string' },
          voiceTitle: { type: 'string' },
          voiceCount: { type: 'number' },
          volume: { type: 'number' },
          device: { type: 'string' },
          workerRunning: { type: 'boolean' },
          audibleWarning: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [];
        // `message` is the envelope's generic "ok" string, not an error: only
        // `error` (or ok=false) means the subsystem is unusable.
        if (value.ok !== true) {
          lines.push(`❌ TTS 不可用: ${value.error || value.message || 'unknown'}`);
        } else if (value.error) {
          lines.push(`❌ TTS 不可用: ${value.error}`);
        } else if (value.ready) {
          lines.push('✅ TTS 就绪');
        } else if (value.loading) {
          lines.push('⏳ 正在加载模型…');
        } else if (!(value.voiceCount > 0)) {
          lines.push('⚠️ TTS 可用，但用户还没有导入任何音色：请让用户在插件设置页导入母本音频。');
        } else {
          lines.push('✅ TTS 就绪（模型将在首次喊话时加载，约 10 秒）');
        }
        lines.push(`当前音色: ${value.voiceTitle || value.voiceId || '（未设置）'}`);
        lines.push(`音量: ${Math.round((value.volume ?? 0) * 100)}%`);
        lines.push(`将使用的输出通道: ${value.device || '（用户未指定，将自动挑选扬声器）'}`);
        lines.push(`worker: ${value.workerRunning ? '运行中' : '未启动'}`);
        if (value.audibleWarning) lines.push(`⚠️ 听不到的风险: ${value.audibleWarning}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: 90000,
    async execute() {
      if (!ctx.tts) throw new Error('TTS 服务未加载（dsh-tts-speakout 宿主插件未启用）');
      const res = await ctx.tts.status();
      const voices = Array.isArray(res.voices) ? res.voices : [];
      const defaultId = res.defaultVoice || '';
      const hit = voices.find((v) => v.id === defaultId) || voices[0] || null;
      return {
        ok: res.ok === true,
        message: res.message || '',
        ready: res.ready === true,
        loading: res.loading === true,
        error: typeof res.error === 'string' ? res.error : '',
        voiceId: hit ? String(hit.id ?? '') : '',
        voiceTitle: hit ? String(hit.title ?? '') : '',
        voiceCount: Number.isFinite(res.voiceCount) ? res.voiceCount : voices.length,
        volume: typeof res.volume === 'number' && Number.isFinite(res.volume) ? res.volume : 0,
        device: res.device || '',
        workerRunning: res.workerRunning === true,
        audibleWarning: typeof res.audibleWarning === 'string' ? res.audibleWarning : '',
      };
    },
    presentCall() {
      return { card: 'generic', title: '喊话自检', kind: 'read' };
    },
  });

  try {
    disposers.push(ctx.tools.register(speakTool));
    disposers.push(ctx.tools.register(statusTool));
  } catch (e) {
    // A second load of the same tools plugin would collide; first wins.
    console.warn('[dsh-tts-speakout] tools registration issue:', e?.message ?? e);
  }
  return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
}

export default { name, inject, apply };
