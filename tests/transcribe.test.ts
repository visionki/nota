import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/server/config.js';
import { Storage } from '../src/server/storage.js';
import { Transcriber } from '../src/server/transcribe.js';

describe('OpenAI-compatible file transcription', () => {
  it('sends duration-less browser WebM as measurable WAV and preserves the original bytes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nota-asr-test-'));
    const config = loadConfig({
      DATA_DIR: root,
      OPENAI_API_KEY: 'controlled-asr-key',
      OPENAI_BASE_URL: 'https://relay.example/v1',
    });
    const storage = new Storage(config);
    const original = await readFile('tests/fixtures/browser-capture.webm');
    const file = await storage.put(randomUUID(), 'browser.webm', original);
    let measuredDuration = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(url).toBe('https://relay.example/v1/audio/transcriptions');
      const form = options!.body as FormData;
      expect(form.get('model')).toBe(config.ASR_MODEL);
      const audio = form.get('file') as File;
      expect(audio.type).toBe('audio/wav');
      expect(audio.name).toBe('recording.wav');
      const bytes = Buffer.from(await audio.arrayBuffer());
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      const path = resolve(root, 'measured.wav');
      await writeFile(path, bytes);
      measuredDuration = await storage.duration(path);
      return Response.json({ text: '浏览器录音的转写结果。' });
    });
    try {
      const result = await new Transcriber(config, storage).transcribe(
        { storage_key: file.key, mime: file.mime, filename: 'browser.webm' },
        new AbortController().signal,
      );
      expect(result.text).toBe('浏览器录音的转写结果。');
      expect(measuredDuration).toBeGreaterThan(2);
      expect(Math.abs(measuredDuration - file.duration)).toBeLessThan(0.1);
      expect(await storage.get(file.key)).toEqual(original);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
        throw new Error('Unsafe test directory');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps existing WAV uploads and stops aborted requests before reading audio', async () => {
    const config = loadConfig({ OPENAI_API_KEY: 'controlled-asr-key' });
    const storage = new Storage(config);
    const bytes = await readFile('tests/fixtures/nota-chinese.wav');
    const get = vi.spyOn(storage, 'get').mockResolvedValue(bytes);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const file = (options!.body as FormData).get('file') as File;
      expect(file.name).toBe('original.wav');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      return Response.json({ text: '原音频正常转写。' });
    });
    try {
      const transcriber = new Transcriber(config, storage);
      const recording = {
        storage_key: 'fixture/original.wav',
        filename: 'original.wav',
        mime: 'audio/wav',
      };
      await transcriber.transcribe(recording, new AbortController().signal);
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await expect(transcriber.transcribe(recording, controller.signal)).rejects.toThrow(
        'cancelled',
      );
      expect(get).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
      get.mockRestore();
    }
  });
});
