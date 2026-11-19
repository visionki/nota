import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { quotaDay } from '../src/server/quota.js';
import { compactionSettings } from '../src/server/agent.js';
import { verifyWebhook } from '../src/server/billing.js';
import { Storage } from '../src/server/storage.js';
import { loadConfig } from '../src/server/config.js';
import { ics } from '../src/server/domain.js';
import { localInput, zonedISO } from '../src/web/api.js';
import { plainTranscriptSegments } from '../src/shared/notes.js';

describe('Historical note source compatibility', () => {
  it('preserves text and timestamps without reusing retired identity metadata', () => {
    const original = [
      {
        start: 1,
        end: 3,
        text: '记得发送方案',
        speaker: '旧标签',
        is_self: true,
        person_id: 'old-person',
        identity_source: 'reference_audio',
      },
    ];
    expect(plainTranscriptSegments(original)).toEqual([{ start: 1, end: 3, text: '记得发送方案' }]);
    expect(original[0].speaker).toBe('旧标签');
  });
  it('ignores malformed historical timestamps without breaking source viewing', () => {
    expect(plainTranscriptSegments(null)).toEqual([]);
    expect(
      plainTranscriptSegments([
        null,
        { start: -1, end: 2, text: 'bad' },
        { start: 3, end: 1, text: 'bad' },
        { start: 0, end: 'invalid', text: 'bad' },
        { start: 0, end: 2, text: '便签' },
      ]),
    ).toEqual([{ start: 0, end: 2, text: '便签' }]);
  });
});
describe('Quota business day', () => {
  it('changes exactly at midnight in Shanghai', () => {
    expect(quotaDay(new Date('2026-11-11T15:59:59Z'))).toBe('2026-11-11');
    expect(quotaDay(new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-12');
  });
});
describe('Persistent context configuration', () => {
  it('uses a million-token window and an 85% threshold, retaining a substantial recent tail', () => {
    const c = compactionSettings({
      LLM_CONTEXT_WINDOW: 1048576,
      LLM_MAX_OUTPUT_TOKENS: 8192,
      LLM_COMPACT_RATIO: 0.85,
    });
    expect(c.enabled).toBe(true);
    expect(1048576 - c.reserveTokens).toBeGreaterThan(890000);
    expect(c.keepRecentTokens).toBe(65536);
    expect(c.reserveTokens).toBeGreaterThan(8192 + 8192);
  });
  it('leaves response space on smaller explicitly configured models', () => {
    const c = compactionSettings({
      LLM_CONTEXT_WINDOW: 32768,
      LLM_MAX_OUTPUT_TOKENS: 4096,
      LLM_COMPACT_RATIO: 0.85,
    });
    expect(c.reserveTokens).toBeLessThan(32768);
    expect(c.keepRecentTokens).toBeGreaterThan(0);
  });
});
describe('Private storage', () => {
  const storage = new Storage(loadConfig({ COOKIE_SECRET: 'a'.repeat(32) }));
  it('rejects traversal and absolute outside paths', () => {
    expect(() => storage.path('../../.env')).toThrow();
    expect(() => storage.path('C:/Windows/system.ini')).toThrow();
    expect(() => storage.path('')).toThrow();
  });
  it('accepts an owned generated key', () => {
    expect(storage.path('user-id/file.wav')).toContain('file.wav');
  });
});
describe('Signed subscription events', () => {
  const secret = 'not-a-real-merchant-secret',
    now = 1800000000000,
    raw = Buffer.from('{"id":"event-1"}'),
    t = now / 1000;
  const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
  it('accepts the original raw body', () =>
    expect(verifyWebhook(raw, signature, secret, now)).toBe(true));
  it('rejects modified bodies, bad signatures and stale events', () => {
    expect(verifyWebhook(Buffer.from('{}'), signature, secret, now)).toBe(false);
    expect(verifyWebhook(raw, 't=1,v1=abc', secret, now)).toBe(false);
    expect(verifyWebhook(raw, signature, secret, now + 301000)).toBe(false);
  });
});
describe('Calendar export and time zones', () => {
  it('round-trips Shanghai and New York local dates', () => {
    for (const tz of ['Asia/Shanghai', 'America/New_York'])
      expect(localInput(zonedISO('2026-11-20T15:30', tz), tz)).toBe('2026-11-20T15:30');
  });
  it('rejects nonexistent DST local time', () =>
    expect(() => zonedISO('2026-03-08T02:30', 'America/New_York')).toThrow());
  it('escapes calendar text and emits UTC instants', () => {
    const out = ics([
      {
        id: 'test',
        title: 'a,b;c\nd',
        notes: 'line1\nline2',
        starts_at: '2026-11-20T15:00:00+08:00',
        ends_at: '2026-11-20T16:00:00+08:00',
      },
    ]);
    expect(out).toContain('DTSTART:20261120T070000Z');
    expect(out).toContain('SUMMARY:a\\,b\\;c\\nd');
    expect(out).toContain('END:VCALENDAR\r\n');
  });
  it('escapes carriage returns and folds Unicode lines by octet length', () => {
    const out = ics([
      {
        id: 'test',
        title: '中文日程'.repeat(30) + '\rATTENDEE:unexpected',
        starts_at: '2026-11-20T15:00:00+08:00',
        ends_at: '2026-11-20T16:00:00+08:00',
      },
    ]);
    expect(out).not.toContain('\rATTENDEE:');
    expect(out.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });
});
