import type { Config } from './config.js';
import { Storage } from './storage.js';
import { AppError } from './db.js';
import { safeError } from './config.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export class Transcriber {
  constructor(
    readonly config: Config,
    readonly storage: Storage,
  ) {}
  private async audio(recording: any, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !recording.mime?.includes('webm') &&
      extname(recording.storage_key).toLowerCase() !== '.webm'
    )
      return {
        bytes: await this.storage.get(recording.storage_key),
        mime: recording.mime,
        filename: recording.filename,
      };
    // MediaRecorder WebM often omits duration. Send a seekable PCM WAV copy so
    // OpenAI-compatible gateways can measure and bill it; retain the original for playback.
    const folder = await mkdtemp(join(tmpdir(), 'nota-asr-'));
    const path = join(folder, 'recording.wav');
    try {
      await exec(
        this.config.FFMPEG_PATH,
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-i',
          this.storage.path(recording.storage_key),
          '-t',
          String(this.config.MAX_AUDIO_SECONDS + 1),
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          path,
        ],
        { signal, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const duration = await this.storage.duration(path);
      if (duration <= 0 || duration > this.config.MAX_AUDIO_SECONDS)
        throw new AppError(422, '录音超出允许的转写时长', 'asr_audio_invalid');
      return { bytes: await readFile(path), mime: 'audio/wav', filename: 'recording.wav' };
    } catch (error: any) {
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      if (error.code === 'ENOENT')
        throw new AppError(
          503,
          '转写服务缺少音频工具，请检查 FFMPEG_PATH',
          'asr_audio_unavailable',
        );
      throw new AppError(422, '无法准备录音转写，请重新录制或上传音频', 'asr_audio_invalid');
    } finally {
      await unlink(path).catch(() => {});
      await rmdir(folder).catch(() => {});
    }
  }
  async transcribe(recording: any, signal: AbortSignal) {
    if (!this.config.OPENAI_API_KEY)
      throw new AppError(
        503,
        '尚未配置转写服务 Key；可先通过文字交办使用 Nota，录音会保留待重试。',
        'asr_unconfigured',
      );
    const form = new FormData();
    const audio = await this.audio(recording, signal);
    form.set('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), audio.filename);
    form.set('model', this.config.ASR_MODEL);
    const response = await fetch(
      `${this.config.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      },
    );
    if (!response.ok) {
      const raw = await response.text();
      let message = '';
      try {
        message = JSON.parse(raw).error?.message ?? '';
      } catch {}
      throw new Error(
        `转写服务 ${response.status}：${safeError(message || '上游请求未成功', this.config)}`,
      );
    }
    const data = (await response.json()) as any;
    if (typeof data.text !== 'string' || !data.text.trim())
      throw new AppError(422, '未识别到有效语音，请检查录音后重试');
    return {
      text: data.text.trim(),
      segments: [],
      model: this.config.ASR_MODEL,
    };
  }
}
