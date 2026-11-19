import { randomUUID } from 'node:crypto';
import { type Client, type Db, emit } from './db.js';

export const WINDOW_LIMIT = 10;
const lock = (c: Client, userId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,713))', [userId]);

export async function revisePendingItem(c: Client, userId: string, operationId: string) {
  await lock(c, userId);
  const items = (
    await c.query(
      "UPDATE recording_batch_items i SET state='pending',artifact_id=NULL,error=NULL,finished_at=NULL FROM recording_batches b WHERE b.id=i.batch_id AND b.user_id=i.user_id AND b.state IN ('open','sealed') AND i.operation_id=$1 AND i.user_id=$2 AND i.state='ready' RETURNING i.batch_id",
      [operationId, userId],
    )
  ).rows;
  if (!items.length) return false;
  await c.query(
    "UPDATE operations SET status='queued',stage='revising',cycle_attempts=0,lease_token=NULL,lease_until=NULL WHERE id=$1 AND user_id=$2 AND executor='recording'",
    [operationId, userId],
  );
  await c.query(
    "UPDATE recordings SET status='organizing',last_error=NULL WHERE operation_id=$1 AND user_id=$2",
    [operationId, userId],
  );
  for (const item of items) {
    await c.query('UPDATE recording_batches SET drained_at=NULL,updated_at=now() WHERE id=$1', [
      item.batch_id,
    ]);
    await emit(c, userId, 'recording_batch', { id: item.batch_id, status: 'revising' });
  }
  return true;
}

export async function joinWindow(
  c: Client,
  userId: string,
  operationId: string,
  recordingId: string,
) {
  await lock(c, userId);
  let window = (
    await c.query("SELECT * FROM recording_batches WHERE user_id=$1 AND state='open' FOR UPDATE", [
      userId,
    ])
  ).rows[0];
  if (!window)
    window = (
      await c.query('INSERT INTO recording_batches(id,user_id) VALUES($1,$2) RETURNING *', [
        randomUUID(),
        userId,
      ])
    ).rows[0];
  await c.query(
    "INSERT INTO recording_batch_items(batch_id,user_id,operation_id,recording_id) VALUES($1,$2,$3,$4) ON CONFLICT(batch_id,operation_id) DO UPDATE SET state='pending',artifact_id=NULL,error=NULL,finished_at=NULL",
    [window.id, userId, operationId, recordingId],
  );
  const count = (
    await c.query('SELECT count(*)::int AS n FROM recording_batch_items WHERE batch_id=$1', [
      window.id,
    ])
  ).rows[0].n;
  await c.query(
    "UPDATE recording_batches SET drained_at=NULL,updated_at=now(),state=CASE WHEN $2>=10 THEN 'sealed' ELSE 'open' END,close_reason=CASE WHEN $2>=10 THEN 'limit' ELSE NULL END WHERE id=$1",
    [window.id, count],
  );
  await c.query('UPDATE recordings SET batch_id=$3 WHERE id=$1 AND user_id=$2', [
    recordingId,
    userId,
    window.id,
  ]);
  await emit(c, userId, 'recording_batch', {
    id: window.id,
    state: count >= 10 ? 'sealed' : 'open',
    total: count,
  });
  return window.id as string;
}

export async function finishWindowItem(
  c: Client,
  userId: string,
  operationId: string,
  state: 'ready' | 'failed' | 'cancelled',
  artifactId?: string,
  error?: string,
) {
  await lock(c, userId);
  const item = (
    await c.query(
      "UPDATE recording_batch_items SET state=$3,artifact_id=$4,error=$5,finished_at=now() WHERE user_id=$1 AND operation_id=$2 AND state='pending' RETURNING batch_id",
      [userId, operationId, state, artifactId ?? null, error ?? null],
    )
  ).rows;
  for (const row of item) {
    await c.query(
      "UPDATE recording_batches b SET updated_at=now(),drained_at=CASE WHEN NOT EXISTS(SELECT 1 FROM recording_batch_items i WHERE i.batch_id=b.id AND i.state='pending') THEN now() ELSE NULL END WHERE id=$1",
      [row.batch_id],
    );
    await emit(c, userId, 'recording_batch', {
      id: row.batch_id,
      item: operationId,
      status: state,
    });
  }
}

export async function dispatchWindows(db: Db, idleMs: number) {
  const users = (
    await db.query(
      "SELECT DISTINCT user_id FROM recording_batches WHERE state IN ('open','sealed') AND drained_at IS NOT NULL",
    )
  ).rows;
  for (const { user_id: userId } of users)
    await db.tx(async (c) => {
      await lock(c, userId);
      const rows = (
        await c.query(
          "SELECT * FROM recording_batches WHERE user_id=$1 AND state IN ('open','sealed') AND drained_at IS NOT NULL AND (state='sealed' OR drained_at<=now()-$2*interval '1 millisecond') ORDER BY created_at FOR UPDATE",
          [userId, idleMs],
        )
      ).rows;
      for (const batch of rows) {
        if (
          (
            await c.query(
              "SELECT 1 FROM recording_batch_items WHERE batch_id=$1 AND state='pending' LIMIT 1",
              [batch.id],
            )
          ).rows.length
        )
          continue;
        const operationId = randomUUID(),
          eventId = randomUUID();
        // This is a child of already reserved recording requests. Never call the billable webhook API.
        await c.query(
          "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,executor) VALUES($1,$2,$3,$3,'trigger',$4,'agent')",
          [
            operationId,
            userId,
            `recording-window:${batch.id}`,
            JSON.stringify({
              source: 'recording_window',
              batch_id: batch.id,
              text: '整批录音已完成预处理。依据各条摘要、候选和证据统一处理，给出一次汇总；尊重每条录音的整理范围。',
            }),
          ],
        );
        await c.query(
          "INSERT INTO agent_inbox(id,user_id,event_key,event_type,batch_id,operation_id) VALUES($1,$2,$3,'recordings_ready',$4,$5)",
          [eventId, userId, `recording-window:${batch.id}`, batch.id, operationId],
        );
        await c.query(
          "UPDATE recording_batches SET state='dispatched',close_reason=coalesce(close_reason,'drained'),agent_operation_id=$2,updated_at=now() WHERE id=$1",
          [batch.id, operationId],
        );
        await emit(
          c,
          userId,
          'operation',
          {
            id: operationId,
            status: 'queued',
            kind: 'trigger',
            executor: 'agent',
            source: 'recording_window',
            batch_id: batch.id,
          },
          operationId,
        );
        await emit(c, userId, 'recording_batch', {
          id: batch.id,
          state: 'dispatched',
          agent_operation_id: operationId,
        });
      }
    });
}

export async function windowResults(c: Client, userId: string, batchId: string) {
  return (
    await c.query(
      "SELECT i.state,i.error,i.operation_id,r.id AS recording_id,r.title,r.version AS current_version,r.recorded_at,r.recorded_timezone,r.recording_time_source,r.created_at AS uploaded_at,o.input->>'instruction' AS instruction,a.id AS artifact_id,a.recording_version,a.summary,a.payload FROM recording_batch_items i JOIN recordings r ON r.id=i.recording_id AND r.user_id=i.user_id JOIN operations o ON o.id=i.operation_id LEFT JOIN recording_artifacts a ON a.id=i.artifact_id AND a.user_id=i.user_id WHERE i.batch_id=$1 AND i.user_id=$2 ORDER BY i.created_at,i.operation_id",
      [batchId, userId],
    )
  ).rows;
}

export async function settleWindow(
  c: Client,
  userId: string,
  batchId: string,
  outcome: 'committed' | 'released',
) {
  const rows = (
    await c.query(
      "UPDATE quota_reservations q SET status=$3,settled_at=now() FROM recording_batch_items i WHERE i.batch_id=$1 AND i.user_id=$2 AND i.state='ready' AND q.operation_id=i.operation_id AND q.user_id=i.user_id AND q.status='reserved' RETURNING q.quota_day",
      [batchId, userId, outcome],
    )
  ).rows;
  for (const row of rows)
    await c.query(
      'UPDATE quota_buckets SET reserved=reserved-1,used=used+$3 WHERE user_id=$1 AND quota_day=$2',
      [userId, row.quota_day, outcome === 'committed' ? 1 : 0],
    );
}
