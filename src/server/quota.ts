import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { operationCycle, summarizeProcess } from '../shared/execution.js';
import { publicMessage, readExecutionProcess } from './execution.js';
import { AppError, Db, emit, type Client } from './db.js';
import { digest } from './auth.js';
import type { Config } from './config.js';
import { finishWindowItem, joinWindow, settleWindow } from './recording-windows.js';
import { sourceDocument, syncMemoryPolicy } from './sources.js';
import { resolveNotifications } from './notifications.js';
export function quotaDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
export async function isPro(
  c: Client,
  userId: string,
  billingMode: Config['BILLING_MODE'],
  now = new Date(),
) {
  if (billingMode === 'disabled') return false;
  const { rows } = await c.query(
    "SELECT * FROM subscriptions WHERE user_id=$1 AND plan='pro' AND status IN ('active','trialing') AND period_end>$2",
    [userId, now],
  );
  return !!rows[0];
}
export class Operations {
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {}
  async submit(
    userId: string,
    key: string,
    text: string,
    options: { mode?: 'steer' | 'queue'; targetId?: string } = {},
  ) {
    if (key.length < 8 || key.length > 160) throw new AppError(400, '需要 8–160 字符的幂等请求 ID');
    const mode = options.mode ?? 'steer',
      hash = digest(JSON.stringify({ text, mode, target: options.targetId ?? null }));
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,711))', [userId]);
      const previous = (
        await c.query(
          'SELECT i.*,o.status AS operation_status FROM chat_inputs i JOIN operations o ON o.id=i.operation_id AND o.user_id=i.user_id WHERE i.user_id=$1 AND i.idempotency_key=$2',
          [userId, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.payload_hash !== hash)
          throw new AppError(409, '同一请求 ID 不能用于不同内容', 'idempotency_conflict');
        return {
          id: previous.operation_id,
          status: previous.operation_status,
          replayed: true,
          steered: previous.kind === 'steering',
          input_id: previous.id,
        };
      }
      const legacy = (
        await c.query(
          'SELECT id,status,input,kind FROM operations WHERE user_id=$1 AND idempotency_key=$2',
          [userId, key],
        )
      ).rows[0];
      if (legacy) {
        if (legacy.kind !== 'chat' || legacy.input.text !== text)
          throw new AppError(409, '同一请求 ID 不能用于不同内容', 'idempotency_conflict');
        return { id: legacy.id, status: legacy.status, replayed: true, steered: false };
      }
      let target: any;
      if (mode === 'steer' && options.targetId) {
        target = (
          await c.query('SELECT * FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
            options.targetId,
            userId,
          ])
        ).rows[0];
        if (!target) throw new AppError(404, '这次交办不存在或无访问权限');
        if (
          target.executor !== 'agent' ||
          (target.input.source === 'background_result' && target.status !== 'waiting') ||
          !['queued', 'running', 'waiting'].includes(target.status) ||
          target.stage === 'finalizing'
        )
          throw new AppError(409, '这轮处理刚刚结束，将作为后续消息继续', 'turn_finished');
      } else if (mode === 'steer') {
        target = (
          await c.query(
            `SELECT * FROM operations o WHERE user_id=$1 AND executor='agent' AND (coalesce(input->>'source','')<>'background_result' OR status='waiting') AND status IN ('queued','running','waiting') AND stage<>'finalizing' AND (status='running' OR kind IN ('chat','recording') OR (status='waiting' AND input->>'source' IN ('recording_window','background_result','background_followup')))
          AND (status<>'waiting' OR id=(SELECT id FROM operations WHERE user_id=$1 AND executor='agent' AND (kind IN ('chat','recording') OR input->>'source' IN ('recording_window','background_result','background_followup')) ORDER BY updated_at DESC,created_at DESC LIMIT 1))
          ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,created_at ASC LIMIT 1 FOR UPDATE`,
            [userId],
          )
        ).rows[0];
      }
      let operation: any,
        message: any,
        version = 0,
        cycle = 0;
      if (target?.status === 'waiting') {
        const resumed = await this.continue(userId, target.id, text, c);
        operation = { id: target.id, status: 'queued' };
        message = resumed.message;
        version = resumed.input_version;
        cycle = resumed.cycle;
      } else if (target) {
        operation = (
          await c.query(
            'UPDATE operations SET input_version=input_version+1 WHERE id=$1 AND user_id=$2 RETURNING id,status,input_version',
            [target.id, userId],
          )
        ).rows[0];
        version = operation.input_version;
        cycle = operationCycle(target);
        message = (
          await c.query(
            "INSERT INTO messages(id,user_id,operation_id,role,kind,content,dedupe_key) VALUES($1,$2,$3,'user','steering',$4,$5) RETURNING id,operation_id,seq,role,kind,content,process,created_at",
            [randomUUID(), userId, target.id, text, `${target.id}:steer:${key}`],
          )
        ).rows[0];
      } else {
        operation = await this.create(userId, key, 'chat', { text, source: 'web_text' }, c);
        message = (
          await c.query(
            'SELECT id,operation_id,seq,role,kind,content,process,created_at FROM messages WHERE user_id=$1 AND dedupe_key=$2',
            [userId, `${operation.id}:request`],
          )
        ).rows[0];
      }
      const inputId = randomUUID(),
        steered = !!target;
      await syncMemoryPolicy(c, userId, await sourceDocument(c, userId, 'message', message.id));
      await c.query(
        'INSERT INTO chat_inputs(id,user_id,operation_id,message_id,idempotency_key,payload_hash,kind,content,input_version,cycle,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          inputId,
          userId,
          operation.id,
          message.id,
          key,
          hash,
          steered ? 'steering' : 'initial',
          text,
          version,
          cycle,
          steered ? 'pending' : 'applied',
        ],
      );
      if (steered)
        await emit(
          c,
          userId,
          'input',
          {
            id: inputId,
            status: 'pending',
            input_version: version,
            cycle,
            content: text,
            message: publicMessage(message),
          },
          operation.id,
        );
      return {
        id: operation.id,
        status: operation.status,
        replayed: false,
        steered,
        input_id: inputId,
      };
    });
  }
  async create(
    userId: string,
    key: string,
    kind: 'chat' | 'recording' | 'trigger',
    input: Record<string, unknown>,
    c?: Client,
    now = new Date(),
  ): Promise<any> {
    if (key.length < 8 || key.length > 160) throw new AppError(400, '需要 8–160 字符的幂等请求 ID');
    const hash = digest(JSON.stringify({ kind, input }));
    const run = async (c: Client) => {
      // Serialize creation per user, including duplicate-key checks and the final available credit.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,711))', [userId]);
      const old = (
        await c.query('SELECT * FROM operations WHERE user_id=$1 AND idempotency_key=$2', [
          userId,
          key,
        ])
      ).rows[0];
      if (old) {
        // Old uploads carried a retired capture option. Ignore only that field
        // when replaying an already accepted upload; all source bytes and
        // instructions must still match. The ledger/history are never rewritten.
        const { diarize: retiredOption, ...legacyInput } = old.input;
        const legacyReplay =
          kind === 'recording' &&
          old.kind === 'recording' &&
          'diarize' in old.input &&
          isDeepStrictEqual(legacyInput, input);
        if (old.payload_hash !== hash && !legacyReplay)
          throw new AppError(409, '同一请求 ID 不能用于不同内容', 'idempotency_conflict');
        return { ...old, replayed: true };
      }
      const day = quotaDay(now);
      await c.query(
        'INSERT INTO quota_buckets(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [userId, day],
      );
      const q = (
        await c.query('SELECT * FROM quota_buckets WHERE user_id=$1 AND quota_day=$2 FOR UPDATE', [
          userId,
          day,
        ])
      ).rows[0];
      const exhausted =
        !(await isPro(c, userId, this.config.BILLING_MODE, now)) &&
        q.used + q.reserved >= this.config.FREE_DAILY_LIMIT;
      if (exhausted && kind !== 'recording')
        throw new AppError(
          429,
          `今日 ${this.config.FREE_DAILY_LIMIT} 次免费额度已用完；北京时间 00:00 重置，可在订阅页查看。`,
          'quota_exhausted',
        );
      const id = randomUUID();
      const executor =
        kind === 'recording'
          ? 'recording'
          : kind === 'trigger' && ['schedule', 'webhook'].includes(String(input.source))
            ? 'background'
            : 'agent';
      const op = (
        await c.query(
          'INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,executor,status,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            id,
            userId,
            key,
            hash,
            kind,
            JSON.stringify(input),
            executor,
            exhausted ? 'waiting' : 'queued',
            exhausted ? 'quota_exhausted' : 'queued',
          ],
        )
      ).rows[0];
      if (!exhausted) {
        await c.query(
          'INSERT INTO quota_reservations(operation_id,user_id,quota_day) VALUES($1,$2,$3)',
          [id, userId, day],
        );
        await c.query(
          'UPDATE quota_buckets SET reserved=reserved+1 WHERE user_id=$1 AND quota_day=$2',
          [userId, day],
        );
      }
      if (executor === 'agent')
        await c.query(
          'INSERT INTO messages(id,user_id,operation_id,role,kind,content,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            userId,
            id,
            'user',
            kind,
            String(input.text ?? input.prompt ?? ''),
            `${id}:request`,
          ],
        );
      if (kind !== 'recording')
        await emit(c, userId, 'operation', { id, status: 'queued', kind, executor, cycle: 0 }, id);
      return op;
    };
    return c ? run(c) : this.db.tx(run);
  }
  async resumeRecordings() {
    const users = (
      await this.db.query(
        "SELECT DISTINCT user_id FROM operations WHERE executor='recording' AND status='waiting' AND stage='quota_exhausted'",
      )
    ).rows;
    for (const { user_id: userId } of users)
      await this.db.tx(async (c) => {
        // Share the submission lock so workers and new requests cannot claim the same credit.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,711))', [userId]);
        const day = quotaDay();
        await c.query(
          'INSERT INTO quota_buckets(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [userId, day],
        );
        const quota = (
          await c.query(
            'SELECT * FROM quota_buckets WHERE user_id=$1 AND quota_day=$2 FOR UPDATE',
            [userId, day],
          )
        ).rows[0];
        const available = (await isPro(c, userId, this.config.BILLING_MODE))
          ? 100
          : Math.max(0, this.config.FREE_DAILY_LIMIT - quota.used - quota.reserved);
        if (!available) return;
        const pending = (
          await c.query(
            "SELECT o.id,r.id AS recording_id FROM operations o JOIN recordings r ON r.operation_id=o.id AND r.user_id=o.user_id WHERE o.user_id=$1 AND o.executor='recording' AND o.status='waiting' AND o.stage='quota_exhausted' ORDER BY o.created_at,o.id LIMIT $2 FOR UPDATE OF o",
            [userId, available],
          )
        ).rows;
        for (const op of pending) {
          await c.query(
            'INSERT INTO quota_reservations(operation_id,user_id,quota_day) VALUES($1,$2,$3)',
            [op.id, userId, day],
          );
          await c.query(
            "UPDATE operations SET status='queued',stage='queued',updated_at=now() WHERE id=$1 AND user_id=$2",
            [op.id, userId],
          );
          await c.query(
            "UPDATE recordings SET status='uploaded',last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
            [op.recording_id, userId],
          );
          await joinWindow(c, userId, op.id, op.recording_id);
          await emit(c, userId, 'changed', { entity: 'recording', id: op.recording_id }, op.id);
        }
        await c.query(
          'UPDATE quota_buckets SET reserved=reserved+$3 WHERE user_id=$1 AND quota_day=$2',
          [userId, day, pending.length],
        );
      });
  }
  async settle(c: Client, userId: string, id: string, outcome: 'committed' | 'released') {
    const { rows } = await c.query(
      "UPDATE quota_reservations SET status=$3,settled_at=now() WHERE operation_id=$1 AND user_id=$2 AND status='reserved' RETURNING quota_day",
      [id, userId, outcome],
    );
    if (rows[0])
      await c.query(
        'UPDATE quota_buckets SET reserved=reserved-1,used=used+$3 WHERE user_id=$1 AND quota_day=$2',
        [userId, rows[0].quota_day, outcome === 'committed' ? 1 : 0],
      );
  }
  async usage(userId: string, c: Client = this.db) {
    const day = quotaDay();
    const q = (
      await c.query('SELECT used,reserved FROM quota_buckets WHERE user_id=$1 AND quota_day=$2', [
        userId,
        day,
      ])
    ).rows[0] ?? { used: 0, reserved: 0 };
    const billingMode = this.config.BILLING_MODE;
    const subscription =
      billingMode === 'disabled'
        ? null
        : (
            await c.query(
              'SELECT plan,status,period_end,cancel_at_period_end,provider FROM subscriptions WHERE user_id=$1',
              [userId],
            )
          ).rows[0];
    const pro = await isPro(c, userId, billingMode);
    return {
      ...q,
      day,
      timezone: 'Asia/Shanghai',
      limit: this.config.FREE_DAILY_LIMIT,
      remaining: pro ? null : Math.max(0, this.config.FREE_DAILY_LIMIT - q.used - q.reserved),
      pro,
      subscription,
      billingMode,
      price: '$6.99 / 月',
    };
  }
  async continue(userId: string, id: string, text: string, client?: Client) {
    const run = async (c: Client) => {
      const op = (
        await c.query('SELECT * FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
          id,
          userId,
        ])
      ).rows[0];
      if (!op) throw new AppError(404, '任务不存在');
      if (op.status !== 'waiting' || op.executor !== 'agent')
        throw new AppError(409, '该任务当前不等待补充信息');
      const input = {
        ...op.input,
        ...(op.input.source === 'background_result'
          ? {
              source: 'background_followup',
              text: op.input.background_request,
              title: op.input.background_title,
            }
          : {}),
        clarifications: [...(op.input.clarifications ?? []), text],
      };
      await resolveNotifications(c, userId, id);
      const updated = (
        await c.query(
          "UPDATE operations SET status='queued',stage='continuing',input=$3,input_version=input_version+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING input_version",
          [id, userId, JSON.stringify(input)],
        )
      ).rows[0];
      const message = (
        await c.query(
          "INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,kind) VALUES($1,$2,$3,$4,$5,$6,'steering') RETURNING id,operation_id,seq,role,kind,content,process,created_at",
          [
            randomUUID(),
            userId,
            id,
            'user',
            text,
            `${id}:clarification:${input.clarifications.length}`,
          ],
        )
      ).rows[0];
      await syncMemoryPolicy(c, userId, await sourceDocument(c, userId, 'message', message.id));
      await emit(
        c,
        userId,
        'operation',
        {
          id,
          status: 'queued',
          cycle: input.clarifications.length,
          input_version: updated.input_version,
          message: publicMessage(message),
        },
        id,
      );
      return {
        id,
        status: 'queued',
        input_version: updated.input_version,
        cycle: input.clarifications.length,
        message,
      };
    };
    return client ? run(client) : this.db.tx(run);
  }
  async cancel(userId: string, id: string) {
    return this.db.tx(async (c) => {
      const op = (
        await c.query(
          "UPDATE operations SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','running','waiting') RETURNING *",
          [id, userId],
        )
      ).rows[0];
      if (!op) throw new AppError(409, '任务已结束或不存在');
      await resolveNotifications(c, userId, id);
      if (op.executor === 'recording') {
        await this.settle(c, userId, id, 'released');
        await finishWindowItem(c, userId, id, 'cancelled');
        await c.query(
          "UPDATE recordings SET status='needs_attention',last_error='录音处理已停止' WHERE operation_id=$1 AND user_id=$2",
          [id, userId],
        );
        await emit(c, userId, 'changed', { entity: 'recording', id: op.input.recording_id });
        return { id, status: 'cancelled' };
      }
      await c.query(
        "UPDATE chat_inputs SET status='cancelled' WHERE operation_id=$1 AND user_id=$2 AND status='pending'",
        [id, userId],
      );
      const effects = (
        await c.query('SELECT count(*)::int AS n FROM action_receipts WHERE operation_id=$1', [id])
      ).rows[0].n;
      await this.settle(c, userId, id, effects ? 'committed' : 'released');
      if (op.input.batch_id)
        await settleWindow(c, userId, op.input.batch_id, effects ? 'committed' : 'released');
      if (op.input.batch_id)
        await c.query(
          "UPDATE recordings r SET status='ready',last_error=NULL FROM recording_batch_items i WHERE i.batch_id=$1 AND i.user_id=$2 AND i.state='ready' AND r.id=i.recording_id AND r.user_id=i.user_id",
          [op.input.batch_id, userId],
        );
      if (op.input.source === 'background_result')
        await c.query(
          "UPDATE agent_inbox SET status='failed' WHERE operation_id=$1 AND user_id=$2",
          [id, userId],
        );
      const content = '本次任务已停止。已完成的操作与保存的原文仍然保留。';
      const cycle = operationCycle(op);
      const process = summarizeProcess(
        await readExecutionProcess(c, userId, op, { cycle }),
        content,
        'cancelled',
      );
      const message = (
        await c.query(
          'INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,process) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET content=EXCLUDED.content,process=EXCLUDED.process RETURNING id,operation_id,seq,role,kind,content,process,created_at',
          [
            randomUUID(),
            userId,
            id,
            'assistant',
            content,
            `${id}:cancelled:${cycle}`,
            JSON.stringify(process),
          ],
        )
      ).rows[0];
      await emit(
        c,
        userId,
        'operation',
        { id, status: 'cancelled', cycle, process, message: publicMessage(message) },
        id,
      );
      return { id, status: 'cancelled' };
    });
  }
}
