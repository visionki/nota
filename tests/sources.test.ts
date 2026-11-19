import { describe, it, expect } from 'vitest';
import { splitSource, evidenceRefs, type SourceDocument } from '../src/server/sources.js';
import { materialPolicy, reminderOffset } from '../src/server/recording-analysis.js';
const source: SourceDocument = {
  kind: 'recording',
  id: '7c97e5ed-823e-42bc-9f81-6cabf97f507b',
  version: 1,
  title: '来源',
  recordedAt: null,
  timezone: null,
  uploadedAt: '2026-11-13T00:00:00Z',
  text: '',
};
describe('Versioned source references', () => {
  it('normalizes explicit relative reminder offsets while preserving separately specified clock times', () => {
    expect(reminderOffset('请提前一天提醒我参加评审。')).toBe(1440);
    expect(reminderOffset('提前30分钟提醒')).toBe(30);
    expect(reminderOffset('提前两天提醒')).toBe(2880);
    expect(reminderOffset('提前一天上午10点提醒')).toBeNull();
    expect(reminderOffset('明天上午9点提醒我')).toBeNull();
  });
  it('keeps Unicode text intact, bounds chunks and changes IDs only when source identity/version changes', () => {
    const document = { ...source, text: '第一段🪴记录。\n第二段关于项目的内容。'.repeat(240) };
    const chunks = splitSource('owner', document);
    expect(chunks.map((c) => c.text).join('')).toBe(document.text);
    expect(chunks.every((c) => c.text.length <= 1200)).toBe(true);
    expect(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c.text))).toBe(true);
    expect(splitSource('owner', document).map((c) => c.id)).toEqual(chunks.map((c) => c.id));
    expect(splitSource('owner', { ...document, version: 2 })[0].id).not.toBe(chunks[0].id);
    expect(splitSource('another', document)[0].id).not.toBe(chunks[0].id);
  });
  it('maps whitespace-normalized quotes back to exact original offsets, including emoji', () => {
    const document = {
      ...source,
      text: '个人想法🪴：陈总确认\n项目报价 8.6 万元；条件是月底签约。',
    };
    const refs = evidenceRefs(document, splitSource('owner', document), '陈总确认项目报价8.6万元');
    expect(refs.map((r) => r.quote).join('')).toBe('陈总确认\n项目报价 8.6 万元');
    for (const ref of refs)
      expect(document.text.slice(ref.start_char, ref.end_char)).toBe(ref.quote);
    expect(refs[0].source_url).toContain('version=1&chunk=');
  });
  it('rejects invented quotations instead of creating unverifiable citations', () => {
    const document = { ...source, text: '已记录项目原价八万元。' };
    expect(() =>
      evidenceRefs(document, splitSource('owner', document), '已确认报价三万元'),
    ).toThrow(/连续原文/);
  });
  it('preserves per-kind execution scope and keeps a summary-only request read-only', () => {
    expect(materialPolicy('请整理，不创建日程，但保留明确提醒。').kinds).toEqual({
      todo: true,
      event: false,
      reminder: true,
    });
    expect(materialPolicy('仅摘要，不提取人物记忆，不创建任何日程、待办或提醒。')).toMatchObject({
      actions: false,
      memory: false,
    });
    expect(materialPolicy('仅转写')).toMatchObject({
      actions: false,
      memory: false,
      transcribeOnly: true,
    });
  });
});
