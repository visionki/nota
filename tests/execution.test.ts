import { describe, it, expect } from 'vitest';
import {
  applyExecutionEvent,
  emptyProcess,
  summarizeProcess,
  executionDuration,
  type ExecutionEvent,
} from '../src/shared/execution.js';

const event = (
  id: number,
  type: string,
  data: Record<string, unknown>,
  cycle = 0,
): ExecutionEvent => ({
  id: String(id),
  type,
  data: { ...data, cycle },
  created_at: '2026-11-12T10:00:00Z',
});
describe('Public execution timeline', () => {
  it('counts running intervals and excludes queues, clarification waits and later cancellation', () => {
    let state = emptyProcess();
    const base = Date.parse('2026-11-12T10:00:00Z');
    const at = (id: number, status: string, seconds: number) => ({
      ...event(id, 'operation', { status }),
      created_at: new Date(base + seconds * 1000).toISOString(),
    });
    for (const e of [
      at(1, 'queued', 0),
      at(2, 'running', 50),
      at(3, 'waiting', 53),
      at(4, 'cancelled', 1600),
    ])
      state = applyExecutionEvent(state, e);
    expect(executionDuration(state, new Date(base + 1600e3).toISOString())).toBe(3000);
    expect(summarizeProcess(state, '已停止', 'cancelled')).toMatchObject({
      duration_ms: 3000,
      stats_version: 2,
      tools: 0,
    });
  });
  it('adds retry execution intervals without counting the time between attempts', () => {
    let state = emptyProcess();
    const base = Date.parse('2026-11-12T10:00:00Z');
    for (const [index, status, seconds] of [
      [1, 'queued', 0],
      [2, 'running', 10],
      [3, 'queued', 12],
      [4, 'running', 30],
      [5, 'succeeded', 33],
    ] as const)
      state = applyExecutionEvent(state, {
        ...event(index, 'operation', { status }),
        created_at: new Date(base + seconds * 1000).toISOString(),
      });
    expect(executionDuration(state)).toBe(5000);
  });
  it('reports zero execution for cancellation before a worker starts, and leaves unrecorded timing unknown', () => {
    const queued = applyExecutionEvent(emptyProcess(), event(1, 'operation', { status: 'queued' }));
    expect(
      executionDuration(
        applyExecutionEvent(queued, event(2, 'operation', { status: 'cancelled' })),
      ),
    ).toBe(0);
    expect(executionDuration(emptyProcess())).toBeUndefined();
  });
  it('retains text before and after a tool, deduplicates receipts, and separates the final answer', () => {
    let state = emptyProcess();
    for (const e of [
      event(1, 'text_reset', { turn_id: 'first' }),
      event(2, 'text', { turn_id: 'first', delta: '先检查' }),
      event(3, 'text', { turn_id: 'first', delta: '已有安排。' }),
      event(4, 'text_end', { turn_id: 'first' }),
      event(5, 'tool', {
        id: 'agenda',
        name: 'get_agenda',
        label: '查询日程',
        status: 'running',
        input: { from: 'today' },
      }),
      event(6, 'tool', {
        id: 'agenda',
        name: 'get_agenda',
        status: 'succeeded',
        result: { events: [] },
      }),
      event(7, 'text_reset', { turn_id: 'middle' }),
      event(8, 'text', { turn_id: 'middle', delta: '没有冲突，现在保存。' }),
      event(9, 'text_reset', { turn_id: 'final' }),
      event(10, 'text', { turn_id: 'final', delta: '日程已保存。' }),
      event(11, 'text_end', { turn_id: 'final' }),
    ])
      state = applyExecutionEvent(state, e);
    expect(state.entries.map((e) => e.kind)).toEqual(['text', 'tool', 'text', 'text']);
    expect(state.entries.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual([
      '先检查已有安排。',
      '没有冲突，现在保存。',
      '日程已保存。',
    ]);
    expect(state.entries[1]).toMatchObject({
      input: { from: 'today' },
      result: { events: [] },
      status: 'succeeded',
    });
    expect(
      applyExecutionEvent(state, event(6, 'tool', { id: 'agenda', status: 'succeeded' })),
    ).toBe(state);
    expect(summarizeProcess(state, '日程已保存。', 'succeeded')).toMatchObject({
      cycle: 0,
      tools: 1,
      notes: 2,
      final_turn_id: 'final',
      from_event: '1',
      to_event: '11',
    });
  });
  it('isolates clarification cycles and does not treat cancellation as a successful streamed answer', () => {
    let state = emptyProcess(1);
    state = applyExecutionEvent(state, event(1, 'text', { turn_id: 'old', delta: '旧的提问' }, 0));
    expect(state.entries).toEqual([]);
    state = applyExecutionEvent(state, event(2, 'text_reset', { turn_id: 'new' }, 1));
    state = applyExecutionEvent(state, event(3, 'text', { turn_id: 'new', delta: '正在检查' }, 1));
    const summary = summarizeProcess(state, '本次任务已停止。', 'cancelled');
    expect(summary.final_turn_id).toBeUndefined();
    expect(summary.notes).toBe(1);
    expect(summary.cycle).toBe(1);
  });
});
