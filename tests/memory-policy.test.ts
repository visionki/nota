import { describe, expect, it } from 'vitest';
import {
  activity,
  amounts,
  canonicalPredicate,
  canonicalScope,
  groundedScope,
  conciseValue,
  explicitReplacement,
  factTime,
  memoryInputSchema,
  memoryPermitted,
  unsupportedReason,
  valueKey,
} from '../src/server/memory-policy.js';
import type { SourceDocument } from '../src/server/sources.js';
import { analysisSchema } from '../src/server/recording-analysis.js';
const source: SourceDocument = {
  kind: 'recording',
  id: 'source',
  version: 1,
  title: '测试',
  text: '昨天李工加入项目',
  recordedAt: '2026-11-10T16:30:00+08:00',
  timezone: 'Asia/Shanghai',
  uploadedAt: '2026-11-13T00:00:00Z',
};
const item = (args: object = {}) =>
  memoryInputSchema.parse({ subject: '青禾项目', predicate: '报价', value: '8.6万元', ...args });
describe('Long-term memory policy', () => {
  it('accepts a null optional model description without weakening business-field validation', () => {
    const candidate = {
      kind: 'todo',
      title: '核对附件',
      evidence: '我的待办是核对附件。',
      actor: 'self',
      explicit: true,
      details: null,
    };
    const parsed = analysisSchema.parse({ summary: '核对附件', facts: [], actions: [candidate] });
    expect(parsed.actions[0].details).toBeUndefined();
    expect(
      analysisSchema.safeParse({
        summary: '核对附件',
        actions: [{ ...candidate, actor: 'invented' }],
      }).success,
    ).toBe(false);
  });
  it('normalizes equivalent amounts and currency while retaining scope distinctions', () => {
    expect(amounts('十二点八万元')).toEqual(['CNY:128000']);
    expect(valueKey('8.6 万元', '报价')).toBe(valueKey('86000元', '价格'));
    expect(valueKey('8.6万美元', '报价')).not.toBe(valueKey('8.6万元', '报价'));
    expect(canonicalPredicate('项目报价')).toBe('报价');
  });
  it.each([
    '不要提取或保存人物记忆，只用于本轮回答。',
    '不要记住陈总的报价',
    '不保存人物记忆',
    '无需保存记忆',
    '别记住这条信息',
    '仅用于本轮回答',
  ])('honors an explicit memory opt-out: %s', (text) => {
    expect(memoryPermitted(text)).toBe(false);
  });
  it('preserves action restrictions without treating a third-party promise as a memory opt-out', () => {
    expect(memoryPermitted('陈总会发合同，不要给我创建发送合同的待办。')).toBe(true);
    expect(memoryPermitted('报价8.6万元', '仅转写')).toBe(false);
    expect(memoryPermitted('报价8.6万元', '仅摘要，不创建任何提醒')).toBe(false);
    expect(memoryPermitted('请只摘要：报价8.6万元')).toBe(false);
  });
  it('rejects unsupported amounts, people, hypotheses and uncertain statements', () => {
    expect(unsupportedReason(item({ value: '86万元' }), '报价8.6万元', '报价8.6万元')).toMatch(
      /金额/,
    );
    expect(
      unsupportedReason(item({ person_name: '李四' }), '张三负责招标', '张三负责招标'),
    ).toMatch(/人物/);
    expect(
      unsupportedReason(
        item({ assertion: 'hypothetical' }),
        '如果以后加入公司',
        '如果以后加入公司',
      ),
    ).toMatch(/假设/);
    expect(unsupportedReason(item(), '报价8.6万元', '报价可能会是8.6万元')).toMatch(/不确定/);
  });
  it('resolves relative fact dates against recording time without inventing clock time', () => {
    expect(factTime(source, item(), '昨天李工加入项目')).toMatchObject({
      effective_at: null,
      effective_date: '2026-11-09',
      time_precision: 'day',
    });
    expect(
      factTime({ ...source, recordedAt: '2026-11-10T23:30:00Z' }, item(), '昨天李工加入项目')
        .effective_date,
    ).toBe('2026-11-10');
  });
  it('leaves unknown dates unknown even when an upload timestamp is available', () => {
    expect(
      factTime(
        { ...source, recordedAt: null },
        item({ effective_at: '2026-11-12T00:00:00Z' }),
        '昨天李工加入项目',
      ),
    ).toMatchObject({ effective_at: null, effective_date: null, time_precision: 'unknown' });
    expect(factTime(source, item(), '青禾报价8.6万元').effective_at).toBeNull();
  });
  it('decays activity without changing truth and keeps pinned memories stable', () => {
    const f = { created_at: '2026-01-01T00:00:00Z', strength: 1, half_life_days: 180 };
    expect(activity(f, new Date('2026-06-30T00:00:00Z'))).toBeCloseTo(0.5);
    expect(activity({ ...f, pinned: true }, new Date('2030-01-01'))).toBe(1);
  });
  it('requires original date and clock evidence before accepting model-supplied fact times', () => {
    expect(
      factTime(source, item({ effective_date: '2026-11-10' }), '青禾项目预算8.6万元')
        .time_precision,
    ).toBe('unknown');
    expect(
      factTime(source, item({ effective_at: '2026-11-10T09:00:00+08:00' }), '11月10日李工加入项目')
        .time_precision,
    ).toBe('unknown');
    expect(
      factTime(source, item({ effective_date: '2026-11-10' }), '2026年11月10日李工加入项目')
        .effective_date,
    ).toBe('2026-11-10');
  });
  it('requires concrete change language before automatic replacement', () => {
    expect(explicitReplacement(item({ operation: 'replace' }), '青禾项目报价8.6万元')).toBe(false);
    expect(explicitReplacement(item(), '现在改为9万元，之前的作废')).toBe(true);
  });
  it('keeps preference aliases in one stable domain while preserving distinct domains', () => {
    expect(canonicalPredicate('喜欢喝')).toBe('偏好');
    expect(canonicalPredicate('喝茶偏好')).toBe('偏好');
    expect(canonicalScope(item({ predicate: '喜欢喝', value: '红茶' }))).toBe('饮品');
    expect(canonicalScope(item({ predicate: '喝茶偏好', value: '绿茶' }))).toBe('饮品');
    expect(canonicalScope(item({ predicate: '偏好', value: 'Python' }))).toBe('开发技术');
    expect(conciseValue({ predicate: '喝茶偏好', value: '绿茶，不再选红茶' })).toBe('绿茶');
  });
  it('does not turn current-state labels or invented scope into separate facts', () => {
    expect(groundedScope(item({ scope: '当前报价' }), '青禾项目现在报价8.6万元')).toBe('');
    expect(groundedScope(item({ scope: '青禾项目' }), '青禾项目报价8.6万元')).toBe('');
    expect(groundedScope(item({ scope: '含税、人民币' }), '青禾项目含税报价8.6万元')).toBe('含税');
  });
});
