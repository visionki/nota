import {
  applyExecutionEvent,
  emptyProcess,
  operationCycle,
  summarizeProcess,
  executionDuration,
} from '../shared/execution.js';
import { AppError, type Client } from './db.js';

export function publicMessage(row: any) {
  const { dedupe_key, ...message } = row;
  return {
    ...message,
    process_cycle: row.process?.cycle ?? Number(dedupe_key?.match(/:response:(\d+)$/)?.[1] ?? 0),
  };
}

/** Batch only legacy header metadata; full text and tool payloads remain lazy. */
export async function publicMessages(db: Client, userId: string, rows: any[]) {
  const legacy = rows.filter(
    (row) => row.role === 'assistant' && row.operation_id && row.process?.stats_version !== 2,
  );
  if (!legacy.length) return rows.map(publicMessage);
  const ids = [...new Set(legacy.map((row) => row.operation_id))];
  const events = (
    await db.query(
      "SELECT id::text,operation_id,type,created_at,jsonb_strip_nulls(jsonb_build_object('cycle',data->'cycle','status',data->'status','id',CASE WHEN type='tool' THEN data->'id' END,'name',CASE WHEN type='tool' THEN data->'name' END)) AS data FROM user_events WHERE user_id=$1 AND operation_id=ANY($2::uuid[]) AND type IN ('operation','tool') ORDER BY user_events.id",
      [userId, ids],
    )
  ).rows;
  const messages = (
    await db.query(
      "SELECT id,operation_id,seq,created_at FROM messages WHERE user_id=$1 AND operation_id=ANY($2::uuid[]) AND role='assistant' ORDER BY seq",
      [userId, ids],
    )
  ).rows;
  const calls = (
    await db.query(
      'SELECT id,operation_id,started_at,finished_at FROM tool_calls WHERE user_id=$1 AND operation_id=ANY($2::uuid[])',
      [userId, ids],
    )
  ).rows;
  const rebuilt = new Map<string, any>(),
    time = (value: any) => new Date(value).getTime();
  for (const row of legacy) {
    const cycle = publicMessage(row).process_cycle,
      stored = row.process;
    const prior = messages
      .filter((m) => m.operation_id === row.operation_id && BigInt(m.seq) < BigInt(row.seq))
      .at(-1);
    const selected = events.filter((e) => {
      if (e.operation_id !== row.operation_id) return false;
      if (stored)
        return (
          (!stored.from_event || BigInt(e.id) >= BigInt(stored.from_event)) &&
          (!stored.to_event || BigInt(e.id) <= BigInt(stored.to_event)) &&
          (e.data.cycle ?? cycle) === cycle
        );
      return (
        (!prior || time(e.created_at) > time(prior.created_at)) &&
        time(e.created_at) <= time(row.created_at) &&
        (e.data.cycle ?? cycle) === cycle
      );
    });
    let state = emptyProcess(cycle);
    for (const event of selected)
      state = applyExecutionEvent(state, { ...event, data: { ...event.data, cycle } });
    const bounds = stored?.from_event ? selected[0]?.created_at : prior?.created_at;
    const end = stored?.finished_at ?? row.created_at;
    const fallback = calls.filter(
      (c) =>
        c.operation_id === row.operation_id &&
        (!bounds || time(c.started_at) >= (stored?.from_event ? time(bounds) : time(bounds) + 1)) &&
        time(c.started_at) <= time(end),
    );
    const count =
      stored?.tools ??
      Math.max(state.entries.filter((e) => e.kind === 'tool').length, fallback.length);
    const summary = summarizeProcess(
      state,
      '',
      stored?.status ?? state.status ?? 'succeeded',
      end,
      stored?.final_turn_id,
    );
    rebuilt.set(row.id, {
      ...row,
      process: {
        ...stored,
        ...summary,
        tools: count,
        tools_known: stored?.tools !== undefined || selected.length > 0 || fallback.length > 0,
        notes: stored?.notes ?? 0,
      },
    });
  }
  return rows.map((row) => publicMessage(rebuilt.get(row.id) ?? row));
}

/** Restore a bounded delivery, including text between tools, from the durable public event log. */
export async function readExecutionProcess(
  db: Client,
  userId: string,
  operation: any,
  selection: { cycle?: number; messageId?: string } = {},
) {
  let cycle = selection.cycle ?? operationCycle(operation),
    message: any;
  let afterDate: string | null = null,
    beforeDate: string | null = null;
  if (selection.messageId) {
    message = (
      await db.query(
        "SELECT id,seq,content,process,dedupe_key,created_at FROM messages WHERE id=$1 AND user_id=$2 AND operation_id=$3 AND role='assistant'",
        [selection.messageId, userId, operation.id],
      )
    ).rows[0];
    if (!message) throw new AppError(404, '这次答复不存在或无访问权限');
    cycle = publicMessage(message).process_cycle;
    if (!message.process) {
      const prior = (
        await db.query(
          "SELECT created_at FROM messages WHERE user_id=$1 AND operation_id=$2 AND role='assistant' AND seq<$3 ORDER BY seq DESC LIMIT 1",
          [userId, operation.id, message.seq],
        )
      ).rows[0];
      afterDate = prior?.created_at ?? null;
      beforeDate = message.created_at;
    }
  }
  const rows = (
    await db.query(
      `SELECT id::text,type,operation_id,data,created_at FROM user_events
     WHERE user_id=$1 AND operation_id=$2 AND type IN ('text','text_reset','text_end','tool','activity','operation','input')
       AND ($3::bigint IS NULL OR id >= $3) AND ($4::bigint IS NULL OR id <= $4)
       AND ($5::timestamptz IS NULL OR created_at>$5) AND ($6::timestamptz IS NULL OR created_at<=$6)
       AND ($7::boolean OR coalesce(data->>'cycle','0')=$8)
     ORDER BY user_events.id`,
      [
        userId,
        operation.id,
        message?.process?.from_event ?? null,
        message?.process?.to_event ?? null,
        afterDate,
        beforeDate,
        !!message && !message.process,
        String(cycle),
      ],
    )
  ).rows;
  let process = emptyProcess(cycle);
  for (const event of rows) {
    if (message && !message.process && event.data.cycle === undefined)
      event.data = { ...event.data, cycle };
    process = applyExecutionEvent(process, event);
  }
  const status = message?.process?.status ?? (message ? 'succeeded' : operation.status);
  const finalText = message?.content ?? operation.reply ?? '';
  if (!['queued', 'running'].includes(status)) {
    const summary =
      message?.process ??
      summarizeProcess(process, finalText, status, message?.created_at ?? operation.updated_at);
    process = {
      ...process,
      finalTurnId: summary.final_turn_id,
      finishedAt: summary.finished_at,
      durationMs:
        summary.stats_version === 2
          ? summary.duration_ms
          : executionDuration(process, summary.finished_at),
    };
  }
  return { ...process, status };
}
