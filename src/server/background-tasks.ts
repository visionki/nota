import { randomUUID } from 'node:crypto';
import { NotaAgent } from './agent.js';
import { safeError, type Config } from './config.js';
import { Db, emit, type Client } from './db.js';
import { Operations } from './quota.js';
import type { Queue } from './queue.js';
import { fence, type ToolContext } from './tools.js';

export interface BackgroundResult {
  operation_id: string;
  title: string;
  request: string;
  status: 'succeeded' | 'failed';
  has_update?: boolean;
  needs_input?: boolean;
  summary: string;
  error?: string;
  completed_at: string;
  sources: { url: string; title?: string; source_date?: string; retrieved_at?: string }[];
}

/** The result and its one conversational delivery are committed together. No second quota charge. */
export async function dispatchBackgroundResult(c: Client, op: any, result: BackgroundResult) {
  if (
    op.input?.notification_policy === 'on_change' &&
    result.status === 'succeeded' &&
    result.has_update === false &&
    !result.needs_input
  )
    return;
  const key = `background-result:${op.id}:${op.attempts}`;
  const input = {
    source: 'background_result',
    background_operation_id: op.id,
    background_title: result.title,
    background_request: result.request,
    text: `后台任务「${result.title}」已结束，请依据保存的结果向用户汇报。`,
  };
  const inserted = await c.query(
    "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,executor) VALUES($1,$2,$3,$3,'trigger',$4,'agent') ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id",
    [randomUUID(), op.user_id, key, JSON.stringify(input)],
  );
  if (!inserted.rows[0]) return;
  const id = inserted.rows[0].id;
  await c.query(
    "INSERT INTO agent_inbox(id,user_id,event_key,event_type,operation_id,payload) VALUES($1,$2,$3,'background_result',$4,$5)",
    [randomUUID(), op.user_id, key, id, JSON.stringify(result)],
  );
  await emit(
    c,
    op.user_id,
    'operation',
    { id, executor: 'agent', kind: 'trigger', input, status: 'queued', cycle: 0 },
    id,
  );
}

async function resultSources(c: Client, op: any): Promise<BackgroundResult['sources']> {
  const calls = (
    await c.query(
      "SELECT name,result FROM tool_calls WHERE operation_id=$1 AND user_id=$2 AND status='succeeded' AND name IN ('search_web','read_webpage') ORDER BY started_at",
      [op.id, op.user_id],
    )
  ).rows;
  const sources = new Map<string, BackgroundResult['sources'][number]>();
  for (const call of calls) {
    const items = call.name === 'search_web' ? call.result?.results : [call.result];
    for (const item of items ?? []) {
      if (typeof item?.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
      const previous = sources.get(item.url);
      sources.set(item.url, {
        url: item.url,
        title: item.title ?? previous?.title,
        source_date: item.source_date ?? previous?.source_date,
        retrieved_at: item.retrieved_at ?? call.result?.retrieved_at,
      });
    }
  }
  return [...sources.values()];
}

export class BackgroundTasks {
  readonly agent: NotaAgent;
  readonly ops: Operations;
  private stopping = false;
  private controllers = new Set<AbortController>();
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.agent = new NotaAgent(db, config);
    this.ops = new Operations(db, config);
  }
  async tick(queue: Queue) {
    const rows = (
      await this.db.query(
        "SELECT id FROM operations WHERE executor='background' AND status='queued' AND (stage<>'retrying' OR updated_at<now()-cycle_attempts*interval '3 seconds') ORDER BY created_at LIMIT 100",
      )
    ).rows;
    for (const row of rows) await queue.sendBackground(row.id);
  }
  async process(id: string) {
    if (this.stopping) return;
    // A task owns an independent lock and lease, never the account's conversational actor lock.
    const actor = await this.db.pool.connect();
    let locked = false;
    try {
      locked = (
        await actor.query('SELECT pg_try_advisory_lock(hashtextextended($1,714)) AS locked', [id])
      ).rows[0].locked;
      if (!locked) return;
      const op = (
        await this.db.query(
          "UPDATE operations SET status='running',stage='researching',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_token=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND executor='background' AND status='queued' RETURNING *",
          [id, randomUUID()],
        )
      ).rows[0];
      if (!op) return;
      const control = new AbortController();
      this.controllers.add(control);
      const ctx: ToolContext = {
        db: this.db,
        config: this.config,
        userId: op.user_id,
        operationId: op.id,
        leaseToken: op.lease_token,
        attempt: op.attempts,
        cycle: 0,
        mode: 'background',
        requestVersion: op.input_version,
        appliedInputVersion: op.input_version,
        originalRequestAt: op.input.triggered_at ?? new Date(op.created_at).toISOString(),
        signal: control.signal,
      };
      const timeout = setTimeout(
        () => control.abort(new Error('后台任务执行超时，进展已保存')),
        this.config.MAX_RUN_SECONDS * 1000,
      );
      const heartbeat = setInterval(() => {
        void this.db
          .query(
            "UPDATE operations SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND user_id=$2 AND status='running' AND lease_token=$3 RETURNING id",
            [id, op.user_id, op.lease_token],
          )
          .then((r) => {
            if (!r.rows[0]) control.abort(new Error('后台任务已取消或租约失效'));
          })
          .catch(() => control.abort(new Error('数据库连接中断')));
      }, 5000);
      const title = op.input.schedule_title ?? op.input.trigger_name ?? '自动任务';
      try {
        const previous = op.input.schedule_id
          ? (
              await this.db.query(
                "SELECT reply,updated_at FROM operations WHERE user_id=$1 AND executor='background' AND status='succeeded' AND input->>'schedule_id'=$2 AND id<>$3 AND created_at<$4 ORDER BY created_at DESC LIMIT 1",
                [op.user_id, op.input.schedule_id, op.id, op.created_at],
              )
            ).rows[0]
          : null;
        await emit(
          this.db,
          op.user_id,
          'operation',
          { id, executor: 'background', status: 'running', stage: 'researching', cycle: 0 },
          id,
        );
        const result = await this.agent.run(
          ctx,
          JSON.stringify({
            event: {
              source: op.input.source,
              triggered_at: ctx.originalRequestAt,
              current_time: new Date().toISOString(),
            },
            title,
            user_request: op.input.text,
            notification_policy: op.input.notification_policy ?? 'always',
            previous_result: previous ?? null,
            instruction:
              '独立完成查询或整理，输出简明结论、真实来源及日期。调用 report_task_outcome 保存结论：明确没有用户关心的新变化才 has_update=false；无法判断或首次发现相关结果用 true。缺少用户信息而无法继续用 needs_input=true，写清具体问题。on_change 的无变化结果只保留在后台任务历史；always 每次交付。',
          }),
        );
        await this.db.tx(async (c) => {
          await fence(c, ctx);
          const structured = (
            await c.query(
              "SELECT result FROM tool_calls WHERE user_id=$1 AND operation_id=$2 AND attempt=$3 AND name='report_task_outcome' AND status='succeeded' ORDER BY finished_at DESC LIMIT 1",
              [op.user_id, id, op.attempts],
            )
          ).rows[0]?.result;
          const outcome: BackgroundResult = {
            operation_id: id,
            title,
            request: op.input.text,
            status: 'succeeded',
            summary: structured?.summary ?? result.text,
            has_update: structured?.has_update,
            needs_input: structured?.needs_input,
            completed_at: new Date().toISOString(),
            sources: await resultSources(c, op),
          };
          await c.query(
            "UPDATE operations SET status='succeeded',stage='succeeded',reply=$3,last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
            [id, op.user_id, outcome.summary],
          );
          await this.ops.settle(c, op.user_id, id, 'committed');
          await dispatchBackgroundResult(c, op, outcome);
          await emit(
            c,
            op.user_id,
            'operation',
            { id, executor: 'background', status: 'succeeded', stage: 'succeeded' },
            id,
          );
        });
      } catch (e) {
        const error = safeError(e, this.config);
        await this.db.tx(async (c) => {
          const current = (
            await c.query('SELECT * FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [
              id,
              op.user_id,
            ])
          ).rows[0];
          if (
            current.status !== 'running' ||
            current.lease_token !== op.lease_token ||
            new Date(current.lease_until).getTime() <= Date.now()
          )
            return;
          const retry =
            this.stopping ||
            (op.cycle_attempts < 3 && !/未配置|尚未配置|401|403|无效|已退役/.test(error));
          await c.query(
            'UPDATE operations SET status=$3,stage=$4,last_error=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND user_id=$2',
            [id, op.user_id, retry ? 'queued' : 'failed', retry ? 'retrying' : 'failed', error],
          );
          await c.query(
            "UPDATE tool_calls SET status='interrupted',error=$2,finished_at=now() WHERE operation_id=$1 AND status='running'",
            [id, error],
          );
          if (!retry) {
            await this.ops.settle(c, op.user_id, id, 'released');
            await dispatchBackgroundResult(c, op, {
              operation_id: id,
              title,
              request: op.input.text,
              status: 'failed',
              summary:
                '后台任务未完整完成，本次预占额度已返还。已保存的查询记录可在后台任务中查看并重试。',
              error,
              completed_at: new Date().toISOString(),
              sources: await resultSources(c, op),
            });
          }
          await emit(
            c,
            op.user_id,
            'operation',
            { id, executor: 'background', status: retry ? 'queued' : 'failed', error },
            id,
          );
        });
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        this.controllers.delete(control);
      }
    } finally {
      if (locked)
        await actor
          .query('SELECT pg_advisory_unlock(hashtextextended($1,714))', [id])
          .catch(() => {});
      actor.release();
    }
  }
  stop() {
    this.stopping = true;
    for (const control of this.controllers) control.abort(new Error('服务重启，后台任务稍后恢复'));
  }
}
