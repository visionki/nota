import { AppError, owned, type Client } from './db.js';
import { operationTitle } from './notifications.js';
import { notificationPreview } from '../shared/notifications.js';
import { operationCycle } from '../shared/execution.js';
import type { OperationDestination, TaskDetail, TaskPage, TaskSummary } from '../shared/tasks.js';

// A worker or an Agent turn is not itself a user-facing task.
const rootPredicate = "o.kind='trigger' AND o.input->>'source' IN ('schedule','webhook')";
const isTaskRoot = (op: any) =>
  op.kind === 'trigger' && ['schedule', 'webhook'].includes(op.input.source);
const active = (status: string) => ['queued', 'running', 'waiting'].includes(status);
const taskQuery = `WITH task_state AS (
  SELECT o.*,d.id AS delivery_id,d.status AS delivery_status,d.input AS delivery_input,
    d.last_error AS delivery_error,d.reply AS delivery_reply,d.attempts AS delivery_attempts,
    d.updated_at AS delivery_updated_at,m.id AS message_id,
    CASE WHEN o.status<>'succeeded' THEN o.status
      WHEN d.status IN ('queued','running') THEN 'running'
      ELSE coalesce(d.status,o.status) END AS task_status,
    CASE WHEN o.status<>'succeeded' THEN o.status
      WHEN d.status='queued' THEN 'awaiting_report' WHEN d.status='running' THEN 'reporting'
      WHEN d.status='failed' THEN 'delivery_failed' WHEN d.status='waiting' THEN 'needs_input'
      WHEN d.status='cancelled' THEN 'delivery_cancelled' WHEN d.id IS NOT NULL THEN 'delivered'
      WHEN o.input->>'notification_policy'='on_change' AND outcome.result->>'has_update'='false'
        AND outcome.result->>'needs_input'='false' THEN 'unchanged'
      ELSE 'completed' END AS task_stage
  FROM operations o
  LEFT JOIN LATERAL (
    SELECT r.* FROM operations r WHERE r.user_id=o.user_id AND r.input ? 'background_operation_id'
      AND r.input->>'background_operation_id'=o.id::text
      AND r.idempotency_key='background-result:'||o.id::text||':'||o.attempts::text
    ORDER BY r.created_at DESC,r.id DESC LIMIT 1
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT id FROM messages WHERE user_id=o.user_id AND operation_id=coalesce(d.id,o.id)
      AND role='assistant' ORDER BY seq DESC LIMIT 1
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT result FROM tool_calls WHERE user_id=o.user_id AND operation_id=o.id
      AND attempt=o.attempts AND name='report_task_outcome' AND status='succeeded'
    ORDER BY finished_at DESC,id DESC LIMIT 1
  ) outcome ON true
  WHERE o.user_id=$1 AND ${rootPredicate}
)`;

function summary(row: any): TaskSummary {
  const status = row.task_status;
  return {
    id: row.id,
    title: operationTitle(row),
    source: row.input.source,
    status,
    stage: row.task_stage,
    summary: notificationPreview(row.delivery_reply || row.reply || '', 160),
    created_at: row.created_at,
    updated_at:
      row.delivery_updated_at && row.status === 'succeeded'
        ? row.delivery_updated_at
        : row.updated_at,
    message_id: row.message_id ?? null,
    schedule_id: row.input.schedule_id ?? null,
    retry_operation_id:
      row.status === 'failed' ? row.id : row.delivery_status === 'failed' ? row.delivery_id : null,
    cancel_operation_id: active(row.status)
      ? row.id
      : active(row.delivery_status)
        ? row.delivery_id
        : null,
    reply_operation_id: status === 'waiting' ? (row.delivery_id ?? row.id) : null,
  };
}

export async function listBackgroundTasks(
  c: Client,
  userId: string,
  options: { scope: 'current' | 'history' | 'all'; cursor?: string; limit: number },
): Promise<TaskPage> {
  if (options.cursor && !isTaskRoot(await owned(c, 'operations', options.cursor, userId)))
    throw new AppError(404, '后台任务不存在');
  const { rows } = await c.query(
    `${taskQuery}
    SELECT (SELECT coalesce(jsonb_agg(p),'[]') FROM (
      SELECT * FROM task_state t
      WHERE ($2='all' OR ($2='current' AND task_status IN ('queued','running','waiting','failed'))
        OR ($2='history' AND task_status IN ('succeeded','cancelled')))
        AND ($3::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM operations WHERE id=$3 AND user_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT $4
    ) p) AS items,
    (SELECT jsonb_build_object('all',count(*),
      'current',count(*) FILTER(WHERE task_status IN ('queued','running','waiting','failed')),
      'history',count(*) FILTER(WHERE task_status IN ('succeeded','cancelled'))) FROM task_state) AS counts`,
    [userId, options.scope, options.cursor ?? null, options.limit + 1],
  );
  const items = rows[0].items as any[];
  const more = items.length > options.limit;
  const page = items.slice(0, options.limit);
  return {
    tasks: page.map(summary),
    counts: rows[0].counts,
    next_cursor: more ? page.at(-1).id : null,
  };
}

export async function backgroundTask(c: Client, userId: string, id: string): Promise<TaskDetail> {
  const op = await owned(c, 'operations', id, userId);
  const root = op.input.background_operation_id
    ? await owned(c, 'operations', op.input.background_operation_id, userId)
    : op;
  if (!isTaskRoot(root)) throw new AppError(404, '这条记录不属于后台任务');
  const row = (
    await c.query(`${taskQuery} SELECT * FROM task_state WHERE id=$2`, [userId, root.id])
  ).rows[0];
  const stages = [
    {
      operation_id: row.id,
      label: '查询与整理',
      status: row.status,
      cycle: operationCycle(row),
      attempts: row.attempts,
    },
  ];
  if (row.delivery_id)
    stages.push({
      operation_id: row.delivery_id,
      label: '结果交付',
      status: row.delivery_status,
      cycle: row.delivery_input?.clarifications?.length ?? 0,
      attempts: row.delivery_attempts,
    });
  return {
    task: summary(row),
    request: row.input.text ?? '',
    result: row.message_id ? null : row.reply || null,
    error:
      row.status === 'failed'
        ? row.last_error
        : row.delivery_status === 'failed'
          ? row.delivery_error
          : null,
    stages,
  };
}

export async function operationState(c: Client, userId: string, id: string) {
  const op = await owned(c, 'operations', id, userId);
  const message = (
    await c.query(
      "SELECT id FROM messages WHERE user_id=$1 AND operation_id=$2 AND role='assistant' ORDER BY seq DESC LIMIT 1",
      [userId, id],
    )
  ).rows[0];
  return {
    id: op.id,
    status: op.status,
    latest_message_id: message?.id ?? null,
    retryable: op.status === 'failed',
  };
}

export async function operationDestination(
  c: Client,
  userId: string,
  id: string,
): Promise<OperationDestination> {
  const op = await owned(c, 'operations', id, userId);
  if (isTaskRoot(op)) return { view: 'tasks', target: op.id };
  if (op.input.background_operation_id && op.status !== 'waiting') {
    const root = await owned(c, 'operations', op.input.background_operation_id, userId);
    if (isTaskRoot(root)) return { view: 'tasks', target: root.id };
  }
  if (
    (op.kind === 'recording' || op.input.batch_id) &&
    !(op.executor === 'agent' && op.status === 'waiting')
  ) {
    const recording =
      op.input.recording_id ??
      (
        await c.query(
          "SELECT i.recording_id FROM recording_batch_items i JOIN operations o ON o.id=i.operation_id AND o.user_id=i.user_id WHERE i.user_id=$1 AND i.batch_id=$2 ORDER BY CASE WHEN o.status='failed' THEN 0 ELSE 1 END,i.created_at,i.operation_id LIMIT 1",
          [userId, op.input.batch_id],
        )
      ).rows[0]?.recording_id;
    if (recording) return { view: 'recordings', target: recording };
  }
  const message = (
    await c.query(
      "SELECT id FROM messages WHERE user_id=$1 AND operation_id=$2 ORDER BY CASE role WHEN 'assistant' THEN 0 ELSE 1 END,seq DESC LIMIT 1",
      [userId, op.id],
    )
  ).rows[0];
  return {
    view: 'chat',
    target: message?.id ?? null,
    ...(op.status === 'waiting' ? { reply_operation_id: op.id } : {}),
  };
}
