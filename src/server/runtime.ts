import { NOTE_INSTRUCTION } from '../shared/notes.js';
import { operationCycle, summarizeProcess } from '../shared/execution.js';
import { publicMessage, readExecutionProcess } from './execution.js';
import { steeringInputs, sealInputs } from './steering.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Db, emit, owned, AppError } from './db.js';
import type { Config } from './config.js';
import { safeError } from './config.js';
import { Operations } from './quota.js';
import { NotaAgent } from './agent.js';
import { fence, type ToolContext } from './tools.js';
import { Queue } from './queue.js';
import { activateSchedules, deliverReminders } from './scheduler.js';
import { notify, operationTitle, resolveNotifications } from './notifications.js';
import { RecordingPipeline } from './recording-pipeline.js';
import { windowResults, settleWindow } from './recording-windows.js';
import { enqueueIndex } from './sources.js';
import { BackgroundTasks } from './background-tasks.js';
export class Runtime {
  readonly ops: Operations;
  readonly agent: NotaAgent;
  readonly queue: Queue;
  readonly files: RecordingPipeline;
  readonly tasks: BackgroundTasks;
  stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private controllers = new Set<AbortController>();
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.ops = new Operations(db, config);
    this.agent = new NotaAgent(db, config);
    this.queue = new Queue(config);
    this.files = new RecordingPipeline(db, config);
    this.tasks = new BackgroundTasks(db, config);
  }
  async start() {
    await this.queue.start();
    if (['all', 'agent'].includes(this.config.WORKER_ROLE))
      await this.queue.work((u) => this.processUser(u));
    if (['all', 'tasks'].includes(this.config.WORKER_ROLE))
      await this.queue.workBackground((id) => this.tasks.process(id));
    if (['all', 'files'].includes(this.config.WORKER_ROLE)) {
      await this.queue.workFiles((id) => this.files.process(id));
      await this.queue.workFiles((id) => this.files.processIndex(id), true);
      await this.queue.workMemory((id) => this.files.memoryJobs.process(id));
      await this.files.backfill();
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('worker tick:', safeError(e, this.config)));
    }, 2000);
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      await this.db.query(
        'INSERT INTO worker_heartbeats(id,at,role) VALUES($1,now(),$2) ON CONFLICT(id) DO UPDATE SET at=now(),role=EXCLUDED.role',
        [hostname(), this.config.WORKER_ROLE],
      );
      await this.db.tx(async (c) => {
        const stale = (
          await c.query(
            "UPDATE operations SET status='queued',stage='recovering',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() RETURNING id,user_id,executor",
          )
        ).rows;
        for (const r of stale) {
          await c.query(
            "UPDATE tool_calls SET status='interrupted',error='执行进程中断；重启后核对回执继续',finished_at=now() WHERE operation_id=$1 AND status='running'",
            [r.id],
          );
          await emit(
            c,
            r.user_id,
            'operation',
            { id: r.id, status: 'queued', stage: 'recovering', executor: r.executor },
            r.id,
          );
        }
        await c.query(
          "UPDATE subscriptions SET plan='free',status='expired',updated_at=now() WHERE plan='pro' AND period_end<=now()",
        );
      });
      // Adopt queued legacy triggers after an upgrade, preserving historical completed deliveries.
      await this.db.query(
        "UPDATE operations SET executor='background',session_path=NULL WHERE executor='agent' AND kind='trigger' AND input->>'source' IN ('schedule','webhook') AND status='queued'",
      );
      if (['all', 'files'].includes(this.config.WORKER_ROLE)) await this.files.tick(this.queue);
      if (['all', 'tasks'].includes(this.config.WORKER_ROLE)) await this.tasks.tick(this.queue);
      if (!['all', 'agent'].includes(this.config.WORKER_ROLE)) return;
      await deliverReminders(this.db);
      await activateSchedules(this.db, this.ops);
      const users = (
        await this.db.query(
          "SELECT DISTINCT user_id FROM operations WHERE executor='agent' AND status='queued' AND (stage<>'retrying' OR updated_at<now()-attempts*interval '3 seconds') LIMIT 100",
        )
      ).rows;
      for (const u of users) await this.queue.send(u.user_id);
    } finally {
      this.ticking = false;
    }
  }
  async processUser(userId: string) {
    if (this.stopping) return;
    // A dedicated PG connection owns the per-user actor lock across the entire SDK run.
    // It releases automatically on process/connection death; other users run concurrently.
    const actor = await this.db.pool.connect();
    let locked = false;
    try {
      locked = (
        await actor.query('SELECT pg_try_advisory_lock(hashtextextended($1,712)) AS locked', [
          userId,
        ])
      ).rows[0].locked;
      if (!locked) return;
      const op = await this.db.tx(async (c) => {
        const pending = (
          await c.query(
            "SELECT * FROM operations WHERE user_id=$1 AND executor='agent' AND status='queued' AND (stage<>'retrying' OR updated_at<now()-attempts*interval '3 seconds') ORDER BY CASE WHEN kind='chat' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1",
            [userId],
          )
        ).rows[0];
        if (!pending) return null;
        return (
          await c.query(
            "UPDATE operations SET status='running',stage='starting',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_token=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 RETURNING *",
            [pending.id, randomUUID()],
          )
        ).rows[0];
      });
      if (!op) return;
      const control = new AbortController();
      this.controllers.add(control);
      const timeout = setTimeout(
        () => control.abort(new Error('任务执行超时，进展已保存')),
        this.config.MAX_RUN_SECONDS * 1000,
      );
      const ctx: ToolContext = {
        db: this.db,
        userId,
        operationId: op.id,
        leaseToken: op.lease_token,
        attempt: op.attempts,
        cycle: operationCycle(op),
        recordingId: op.input.recording_id,
        mode: op.input.source === 'background_result' ? 'report' : undefined,
        signal: control.signal,
        requestVersion: op.input_version,
        appliedInputVersion: op.input_version,
        originalRequestAt: new Date(op.created_at).toISOString(),
        config: this.config,
        batchId: op.input.batch_id,
      };
      ctx.trySeal = (version) => sealInputs(this.db, ctx, version);
      const heartbeat = setInterval(() => {
        void this.db
          .query(
            "UPDATE operations SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND status='running' RETURNING id",
            [op.id, userId, op.lease_token],
          )
          .then((r) => {
            if (!r.rows[0]) control.abort(new Error('任务已取消或租约失效'));
          })
          .catch(() => control.abort(new Error('数据库连接中断')));
      }, 5000);
      try {
        await emit(
          this.db,
          userId,
          'operation',
          {
            id: op.id,
            status: 'running',
            stage: 'starting',
            attempt: op.attempts,
            cycle: ctx.cycle,
          },
          op.id,
        );
        let recording: any = null;
        if (op.kind === 'recording') {
          recording = await owned(this.db, 'recordings', op.input.recording_id, userId);
        }
        const backgroundResult =
          ctx.mode === 'report'
            ? (
                await this.db.query(
                  "SELECT payload FROM agent_inbox WHERE operation_id=$1 AND user_id=$2 AND event_type='background_result'",
                  [op.id, userId],
                )
              ).rows[0]?.payload
            : null;
        if (ctx.mode === 'report' && !backgroundResult)
          throw new Error('后台任务结果尚未保存，稍后重试汇报');
        if (backgroundResult)
          await this.db.query(
            "UPDATE agent_inbox SET status='processing' WHERE operation_id=$1 AND user_id=$2",
            [op.id, userId],
          );
        const batch = op.input.batch_id
          ? await windowResults(this.db, userId, op.input.batch_id)
          : null;
        if (batch) {
          await this.db.query(
            "UPDATE agent_inbox SET status='processing' WHERE operation_id=$1 AND user_id=$2",
            [op.id, userId],
          );
          for (const item of batch) {
            item.actions = item.artifact_id
              ? (
                  await this.db.query(
                    'SELECT id AS candidate_id,payload,source_refs,result_type,result_id FROM candidate_actions WHERE artifact_id=$1 AND user_id=$2 ORDER BY candidate_key',
                    [item.artifact_id, userId],
                  )
                ).rows
              : [];
            item.execution_policy = item.payload?.policy ?? null;
            item.memory = item.artifact_id
              ? (
                  await this.db.query(
                    "SELECT id,subject,predicate,value,status,person_id,source_refs,comparison FROM memory_candidates WHERE user_id=$1 AND source_kind='recording' AND source_id=$2 AND source_version=$3",
                    [userId, item.recording_id, item.recording_version],
                  )
                ).rows
              : [];
            item.memory_update = (
              await this.db.query(
                "SELECT status,last_error FROM memory_jobs WHERE user_id=$1 AND entrypoint='recording' AND dedupe_key=$2",
                [userId, `recording:${item.recording_id}:${item.recording_version}`],
              )
            ).rows[0] ?? { status: item.payload?.memory_error ? 'pending' : 'succeeded' };
            // Artifacts stay durable; only summaries, candidate actions and source pointers enter the bot.
            delete item.payload;
          }
        }
        const receipts = (
          await this.db.query(
            'SELECT key,result FROM action_receipts WHERE operation_id=$1 ORDER BY created_at LIMIT 40',
            [op.id],
          )
        ).rows;
        const updates = await steeringInputs(this.db, userId, op.id);
        const snapshotVersion = Math.max(
          op.input_version,
          ...updates.map((input) => input.input_version),
        );
        ctx.initialInputIds = updates.map((input) => input.id);
        ctx.requestVersion = snapshotVersion;
        ctx.appliedInputVersion = snapshotVersion;
        const prompt = JSON.stringify({
          source_messages: (
            await this.db.query(
              "SELECT id,created_at FROM messages WHERE user_id=$1 AND operation_id=$2 AND role='user' ORDER BY seq",
              [userId, op.id],
            )
          ).rows,
          event: {
            operation_id: op.id,
            kind: op.kind,
            current_time: new Date().toISOString(),
            original_request_at: op.created_at,
            source: op.input.source ?? 'web',
          },
          user_request: op.input.text ?? op.input.instruction ?? NOTE_INSTRUCTION,
          ...(backgroundResult ? { background_result: backgroundResult } : {}),
          ...(batch
            ? {
                recording_batch: {
                  id: op.input.batch_id,
                  items: batch,
                  instruction:
                    '材料已独立整理。使用摘要、行动候选和记忆变化，不重新总结全文。所有动作携带candidate_id或source_refs；只执行用户明确交办，身份与时间有歧义先澄清。按每条recorded_at和时区解释相对时间，未知则不拿上传日期冒充；单条instruction明确指定的验收/执行日期优先。一次汇总本窗口的成功和失败，来源带版本和文段。',
                },
              }
            : {}),
          input_snapshot: { input_version: snapshotVersion, input_ids: ctx.initialInputIds },
          ...(updates.length
            ? {
                user_updates: updates.map((input) => ({
                  id: input.id,
                  received_at: input.created_at,
                  request: input.content,
                  input_version: input.input_version,
                })),
              }
            : {}),
          ...(recording
            ? {
                recording: {
                  id: recording.id,
                  title: recording.title,
                  recorded_at: recording.recorded_at,
                  uploaded_at: recording.created_at,
                  source_version: recording.version,
                  summary: recording.summary,
                  instruction: '通过 read_recording 指定版本或 read_source 按需复查原文。',
                },
              }
            : {}),
          ...(op.input.clarifications?.length
            ? { user_clarifications: op.input.clarifications }
            : {}),
          ...(receipts.length
            ? {
                already_completed_receipts: receipts,
                resume_instruction: '这些是真实已完成结果，不要重复执行；核对并继续未完成的步骤。',
              }
            : {}),
        });
        await this.db.query("UPDATE operations SET stage='agent' WHERE id=$1 AND lease_token=$2", [
          op.id,
          op.lease_token,
        ]);
        const result = await this.agent.run(ctx, prompt);
        const waiting = result.waiting || (backgroundResult?.needs_input ? result.text : undefined);
        await this.db.tx(async (c) => {
          const current = await fence(c, ctx);
          if (current.input_version > (ctx.requestVersion ?? 0))
            throw new AppError(409, '完成前收到新的补充，继续当前任务', 'steering_pending');
          const status = waiting ? 'waiting' : 'succeeded';
          const process = summarizeProcess(
            await readExecutionProcess(c, userId, op, { cycle: ctx.cycle }),
            result.text,
            status,
            new Date().toISOString(),
            ctx.currentTurnId,
          );
          await c.query(
            'UPDATE operations SET status=$3,stage=$3,reply=$4,usage_tokens=usage_tokens+$5,session_path=$6,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2',
            [op.id, userId, status, result.text, 0, result.sessionPath],
          );
          const message = (
            await c.query(
              'INSERT INTO messages(id,user_id,operation_id,role,kind,content,dedupe_key,process) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET content=EXCLUDED.content,process=EXCLUDED.process RETURNING id,operation_id,seq,role,kind,content,process,created_at',
              [
                randomUUID(),
                userId,
                op.id,
                'assistant',
                op.kind,
                result.text,
                `${op.id}:response:${op.input.clarifications?.length ?? 0}`,
                JSON.stringify(process),
              ],
            )
          ).rows[0];
          if (!waiting) await this.ops.settle(c, userId, op.id, 'committed');
          if (op.input.batch_id) {
            if (!waiting) await settleWindow(c, userId, op.input.batch_id, 'committed');
            await c.query(
              "UPDATE agent_inbox SET status=$3,delivered_at=CASE WHEN $3='delivered' THEN now() ELSE NULL END WHERE operation_id=$1 AND user_id=$2",
              [op.id, userId, waiting ? 'waiting' : 'delivered'],
            );
            await c.query(
              "UPDATE recordings r SET status=$3,last_error=NULL FROM recording_batch_items i WHERE i.batch_id=$1 AND i.user_id=$2 AND i.state='ready' AND r.id=i.recording_id AND r.user_id=i.user_id AND r.version=(SELECT recording_version FROM recording_artifacts WHERE id=i.artifact_id)",
              [op.input.batch_id, userId, waiting ? 'needs_confirmation' : 'ready'],
            );
          }
          if (backgroundResult)
            await c.query(
              "UPDATE agent_inbox SET status='delivered',delivered_at=now() WHERE operation_id=$1 AND user_id=$2",
              [op.id, userId],
            );
          if (op.kind === 'chat')
            for (const message of (
              await c.query(
                "SELECT id FROM messages WHERE operation_id=$1 AND user_id=$2 AND role='user'",
                [op.id, userId],
              )
            ).rows)
              await enqueueIndex(c, userId, 'message', message.id, 1, 'keyword');
          const memoryCalls = (
            await c.query(
              "SELECT name,status,result FROM tool_calls WHERE user_id=$1 AND operation_id=$2 AND name IN ('prepare_memory','remember_fact')",
              [userId, op.id],
            )
          ).rows;
          await c.query('UPDATE operations SET memory_summary=$3 WHERE id=$1 AND user_id=$2', [
            op.id,
            userId,
            JSON.stringify({
              status: !memoryCalls.length
                ? 'not_requested'
                : memoryCalls.some((t) => t.status === 'failed')
                  ? 'failed'
                  : memoryCalls.some((t) => t.name === 'remember_fact' && t.result?.fact)
                    ? 'written'
                    : memoryCalls.some((t) => t.name === 'remember_fact')
                      ? 'reviewed'
                      : 'proposed_uncommitted',
              writes: memoryCalls.filter((t) => t.name === 'remember_fact' && t.result?.fact)
                .length,
              results: memoryCalls
                .filter((t) => t.name === 'remember_fact')
                .map((t) => t.result?.memory_status),
            }),
          ]);
          if (recording)
            await c.query(
              'UPDATE recordings SET status=$3,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2',
              [recording.id, userId, waiting ? 'needs_confirmation' : 'ready'],
            );
          await resolveNotifications(c, userId, op.id);
          if (op.kind === 'recording' || op.kind === 'trigger') {
            const failed = backgroundResult?.status === 'failed';
            const recordingFailures = batch?.some((item: any) => item.state === 'failed');
            const title = backgroundResult?.title ?? operationTitle(op, recording?.title);
            const originalTask = failed
              ? (
                  await c.query(
                    'SELECT status FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE',
                    [backgroundResult.operation_id, userId],
                  )
                ).rows[0]
              : null;
            const relevant = !failed || originalTask?.status === 'failed';
            if (relevant)
              await notify(c, userId, `${op.id}:result:${ctx.cycle}`, {
                kind: waiting || failed || recordingFailures ? 'attention' : 'task_result',
                title: `${waiting ? '需要补充信息' : failed || recordingFailures ? '任务需要处理' : '任务结果'}：${title}`,
                body: result.text,
                objectId: failed ? backgroundResult.operation_id : op.id,
                messageId: message.id,
              });
          }
          const totalUsage = (
            await c.query('SELECT usage_tokens FROM operations WHERE id=$1', [op.id])
          ).rows[0].usage_tokens;
          await emit(
            c,
            userId,
            'operation',
            {
              id: op.id,
              status,
              reply: result.text,
              usage_tokens: Number(totalUsage),
              cycle: ctx.cycle,
              process,
              message: publicMessage(message),
            },
            op.id,
          );
        });
      } catch (e) {
        const steeringPending = e instanceof AppError && e.code === 'steering_pending';
        const error = safeError(e, this.config);
        if (!steeringPending) console.error(`operation ${op.id}:`, error);
        await this.db.tx(async (c) => {
          const current = (
            await c.query('SELECT * FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
              op.id,
              userId,
            ])
          ).rows[0];
          if (current.status !== 'running' || current.lease_token !== op.lease_token) return;
          const retry =
            steeringPending ||
            this.stopping ||
            (op.cycle_attempts < 3 &&
              !/未配置|尚未配置|401|403|无效|已退役|未识别到有效语音/.test(error));
          await c.query(
            'UPDATE operations SET status=$3,stage=$4,last_error=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND user_id=$2',
            [
              op.id,
              userId,
              retry ? 'queued' : 'failed',
              steeringPending ? 'continuing' : retry ? 'retrying' : 'failed',
              error,
            ],
          );
          await c.query(
            "UPDATE tool_calls SET status='interrupted',error=$2,finished_at=now() WHERE operation_id=$1 AND status='running'",
            [op.id, error],
          );
          let message: any;
          if (!retry) {
            await this.ops.settle(c, userId, op.id, 'released');
            if (ctx.mode === 'report')
              await c.query(
                "UPDATE agent_inbox SET status='failed' WHERE operation_id=$1 AND user_id=$2",
                [op.id, userId],
              );
            if (op.input.batch_id) {
              await settleWindow(c, userId, op.input.batch_id, 'released');
              await c.query(
                "UPDATE recordings r SET status='needs_attention',last_error='摘要与原文已保存，后续行动处理失败，可重试本轮汇总。' FROM recording_batch_items i WHERE i.batch_id=$1 AND i.user_id=$2 AND i.state='ready' AND r.id=i.recording_id AND r.user_id=i.user_id",
                [op.input.batch_id, userId],
              );
              await c.query(
                "UPDATE agent_inbox SET status='failed' WHERE operation_id=$1 AND user_id=$2",
                [op.id, userId],
              );
            }
            if (op.input.recording_id)
              await c.query(
                "UPDATE recordings SET status='needs_attention',last_error=$3 WHERE id=$1 AND user_id=$2",
                [op.input.recording_id, userId, error],
              );
            const reply =
              ctx.mode === 'report'
                ? `后台结果已保存，汇报暂未完成：${error}\n\n可在后台任务中重试交付，不会重复执行查询或扣除处理次数。`
                : op.input.source === 'background_followup'
                  ? `补充处理暂未完成：${error}\n\n可在后台任务中重试，本次补充没有额外扣除处理次数。`
                  : `这次任务没有完整完成：${error}\n\n本次预占额度已返还。已保存的原文和工具结果仍可查看；可在${op.kind === 'chat' ? '当前对话' : op.input.batch_id || op.kind === 'recording' ? '语音便签' : '后台任务'}中重试。`;
            const process = summarizeProcess(
              await readExecutionProcess(c, userId, op, { cycle: ctx.cycle }),
              reply,
              'failed',
            );
            message = (
              await c.query(
                'INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,process) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET content=EXCLUDED.content,process=EXCLUDED.process RETURNING id,operation_id,seq,role,kind,content,process,created_at',
                [
                  randomUUID(),
                  userId,
                  op.id,
                  'assistant',
                  reply,
                  `${op.id}:failure:${ctx.cycle}:${op.attempts}`,
                  JSON.stringify(process),
                ],
              )
            ).rows[0];
            await notify(c, userId, `${op.id}:failure:${ctx.cycle}:${op.attempts}`, {
              kind: 'attention',
              title: `交办未完成：${operationTitle(op)}`,
              body: `${error}。可以回到${op.kind === 'chat' ? '对话' : op.input.batch_id || op.kind === 'recording' ? '语音便签' : '后台任务'}查看原因并重试。`,
              objectId: op.id,
              messageId: message.id,
            });
          }
          await emit(
            c,
            userId,
            'operation',
            {
              id: op.id,
              status: retry ? 'queued' : 'failed',
              stage: steeringPending ? 'continuing' : retry ? 'retrying' : 'failed',
              error,
              cycle: ctx.cycle,
              ...(message ? { message: publicMessage(message), process: message.process } : {}),
            },
            op.id,
          );
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        this.controllers.delete(control);
      }
    } finally {
      if (locked)
        await actor
          .query('SELECT pg_advisory_unlock(hashtextextended($1,712))', [userId])
          .catch(() => {});
      actor.release();
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.controllers) c.abort(new Error('服务重启，任务稍后恢复'));
    this.files.stop();
    this.tasks.stop();
    await this.queue.stop();
  }
}
