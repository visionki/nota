import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join, extname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { AppError } from './db.js';
const exec = promisify(execFile);
const formats: Record<string, string> = {
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
};
export class Storage {
  readonly root: string;
  constructor(readonly config: Config) {
    this.root = resolve(config.DATA_DIR, 'audio');
  }
  path(key: string) {
    const p = resolve(this.root, key),
      rel = relative(this.root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AppError(400, '存储路径无效');
    return p;
  }
  async put(userId: string, filename: string, bytes: Buffer) {
    const ext = extname(filename).toLowerCase();
    if (!formats[ext]) throw new AppError(400, '支持 webm、mp3、m4a、mp4、wav、ogg、flac 录音');
    if (bytes.length > this.config.MAX_UPLOAD_MB * 1024 * 1024)
      throw new AppError(413, `录音不能超过 ${this.config.MAX_UPLOAD_MB} MB`);
    const key = `${userId}/${randomUUID()}${ext}`;
    const path = this.path(key);
    await mkdir(join(this.root, userId), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
    try {
      const duration = await this.duration(path);
      if (duration <= 0 || duration > this.config.MAX_AUDIO_SECONDS)
        throw new AppError(400, `录音需在 ${this.config.MAX_AUDIO_SECONDS / 60} 分钟以内`);
      return { key, mime: formats[ext], duration, size: bytes.length };
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
  }
  async duration(path: string) {
    try {
      const { stdout } = await exec(
        this.config.FFPROBE_PATH,
        [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'format=duration:stream=codec_type',
          '-of',
          'json',
          path,
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const info = JSON.parse(stdout);
      if (!info.streams?.some((s: any) => s.codec_type === 'audio'))
        throw new Error('no audio stream');
      const n = Number(info.format?.duration);
      if (!Number.isFinite(n)) throw new Error('duration unavailable');
      return n;
    } catch (e: any) {
      // PCM WAV is also supported in local environments without ffprobe.
      if (extname(path) === '.wav') {
        const b = await readFile(path);
        if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') {
          let byteRate = 0,
            dataSize = 0;
          for (let i = 12; i + 8 <= b.length;) {
            const type = b.toString('ascii', i, i + 4),
              len = b.readUInt32LE(i + 4);
            if (type === 'fmt ' && i + 20 < b.length) byteRate = b.readUInt32LE(i + 16);
            if (type === 'data') dataSize = Math.min(len, b.length - i - 8);
            i += 8 + len + (len % 2);
          }
          if (byteRate && dataSize) return dataSize / byteRate;
        }
      }
      // MediaRecorder WebM usually has no container duration. Decode a bounded
      // amount instead of rejecting a valid browser recording as corrupt.
      try {
        const { stdout } = await exec(
          this.config.FFMPEG_PATH,
          [
            '-v',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-progress',
            'pipe:1',
            '-nostats',
            '-i',
            path,
            '-t',
            String(this.config.MAX_AUDIO_SECONDS + 1),
            '-vn',
            '-f',
            'null',
            '-',
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
        );
        const times = [...stdout.matchAll(/out_time_us=(\d+)/g)];
        const seconds = Number(times.at(-1)?.[1]) / 1e6;
        if (Number.isFinite(seconds) && seconds > 0) return seconds;
      } catch (decoderError: any) {
        if (decoderError.code === 'ENOENT')
          throw new AppError(
            503,
            '本地缺少音频工具，请设置 FFMPEG_PATH / FFPROBE_PATH 或使用 Docker 部署',
          );
      }
      if (e.code === 'ENOENT')
        throw new AppError(
          503,
          '本地缺少音频工具，请设置 FFMPEG_PATH / FFPROBE_PATH 或使用 Docker 部署',
        );
      throw new AppError(400, '无法读取音频，请重新导出录音文件');
    }
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch(() => {});
  }
}
