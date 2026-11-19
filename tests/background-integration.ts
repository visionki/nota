import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backgroundFixture } from './background-fixture.js';
import { BackgroundTasks, dispatchBackgroundResult } from '../src/server/background-tasks.js';
import { Runtime } from '../src/server/runtime.js';
import { activateSchedules } from '../src/server/scheduler.js';
import { buildTools, fence, type ToolContext } from '../src/server/tools.js';

const f = await backgroundFixture();
const { db, config, runtime } = f;
const ops = runtime.ops;
const results: { name: string; ok: boolean }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  results.push({ name, ok: true });
  console.log('PASS ' + name);
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled task did not reach its boundary')),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
const task = (userId: string, text: string) =>
  ops.create(userId, randomUUID(), 'trigger', {
    source: 'schedule',
    schedule_title: text,
    text,
    triggered_at: new Date().toISOString(),
  });
const operation = async (id: string) =>
  (await db.query('SELECT * FROM operations WHERE id=$1', [id])).rows[0];
const delivery = async (id: string) =>
  (
    await db.query(
      "SELECT * FROM operations WHERE input->>'background_operation_id'=$1 ORDER BY created_at DESC LIMIT 1",
      [id],
    )
  ).rows[0];
const inbox = async (id: string) =>
  (await db.query('SELECT * FROM agent_inbox WHERE operation_id=$1', [id])).rows[0];
async function retry(id: string, userId: string) {
  const cookie = `nota_session=${encodeURIComponent(f.app.signCookie(await f.auth.session(userId)))}`;
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/operations/${id}/retry`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
}

try {
  await check(
    'Scheduled and webhook tasks use the background executor, deduplicate, and keep internal requests out of chat',
    async () => {
      const u = await f.user();
      await db.query(
        "INSERT INTO schedules(id,user_id,title,prompt,next_run_at) VALUES($1,$2,'定时查询','activation-case',now()-interval '1 second')",
        [randomUUID(), u.id],
      );
      await Promise.all(Array.from({ length: 5 }, () => activateSchedules(db, ops)));
      const rows = (await db.query('SELECT * FROM operations WHERE user_id=$1', [u.id])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].executor, 'background');
      const hook = await ops.create(u.id, 'webhook:fixture-key', 'trigger', {
        source: 'webhook',
        text: 'webhook-case',
      });
      assert.equal(hook.executor, 'background');
      assert.equal(
        (
          await ops.create(u.id, 'webhook:fixture-key', 'trigger', {
            source: 'webhook',
            text: 'webhook-case',
          })
        ).id,
        hook.id,
      );
      assert.equal((await db.query('SELECT * FROM messages WHERE user_id=$1', [u.id])).rowCount, 0);
      assert.equal((await ops.usage(u.id)).reserved, 2);
      await ops.cancel(u.id, rows[0].id);
      await ops.cancel(u.id, hook.id);
    },
  );

  await check(
    'Real SDK task sessions do not lock or read the main session; chat completes while research is blocked',
    async () => {
      const u = await f.user();
      await ops.submit(u.id, randomUUID(), 'PRIVATE_FOREGROUND_MARKER');
      await runtime.processUser(u.id);
      const state = (await db.query('SELECT * FROM bot_state WHERE user_id=$1', [u.id])).rows[0];
      const bg = await task(u.id, 'parallel-case');
      const hold = f.hold('task:parallel-case');
      const run = runtime.tasks.process(bg.id);
      await bounded(hold.started.wait);
      const running = await operation(bg.id);
      assert.match(running.session_path, /task-sessions/);
      assert.notEqual(running.session_path, state.session_path);
      const chat = await ops.submit(u.id, randomUUID(), '研究期间继续聊天');
      assert.equal(chat.steered, false);
      await bounded(runtime.processUser(u.id));
      assert.equal((await operation(chat.id)).status, 'succeeded');
      assert.equal((await operation(bg.id)).status, 'running');
      assert.equal((await ops.usage(u.id)).reserved, 1);
      hold.release.open();
      await bounded(run);
      assert.equal((await operation(bg.id)).status, 'succeeded');
      assert.equal(
        (await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [u.id])).rows[0]
          .session_path,
        state.session_path,
      );
      const report = await delivery(bg.id);
      const artifact = await inbox(report.id);
      assert.equal(artifact.status, 'pending');
      assert.equal(artifact.payload.sources[0].url, 'https://example.com/notice');
      assert.equal(artifact.payload.sources.length, 1);
      assert.equal(artifact.payload.sources[0].source_date, '2026-11-13');
      assert.equal(artifact.payload.sources[0].title, '官方来源');
      assert.ok(artifact.payload.sources[0].retrieved_at);
      assert.equal(artifact.payload.status, 'succeeded');
      for (const request of f.requests.filter((r) => r.task)) {
        assert.ok(!JSON.stringify(request.payload).includes('PRIVATE_FOREGROUND_MARKER'));
        const names = request.payload.tools.map((tool: any) => tool.function.name);
        assert.ok(names.includes('search_web'));
        assert.ok(
          !names.some((name: string) => /^(create_|update_|cancel_|remember_|ask_user)/.test(name)),
        );
      }
      await Promise.all([runtime.processUser(u.id), runtime.processUser(u.id)]);
      assert.equal((await inbox(report.id)).status, 'delivered');
      assert.equal(
        (
          await db.query("SELECT * FROM messages WHERE operation_id=$1 AND role='assistant'", [
            report.id,
          ])
        ).rowCount,
        1,
      );
      assert.equal((await ops.usage(u.id)).used, 3);
      assert.equal((await ops.usage(u.id)).reserved, 0);
      const request = f.requests.findLast((r) => r.report)!;
      assert.equal(Object.hasOwn(request.payload, 'tools'), false);
      assert.ok(!JSON.stringify(request.payload).includes('RAW_SEARCH_ONLY'));
      assert.ok(JSON.stringify(request.payload).includes('PRIVATE_FOREGROUND_MARKER'));
      const mainHistory = await readFile(resolve(config.DATA_DIR, state.session_path), 'utf8');
      assert.ok(!mainHistory.includes('RAW_SEARCH_ONLY'));
      await db.tx((c) => dispatchBackgroundResult(c, { ...bg, attempts: 1 }, artifact.payload));
      assert.equal(
        (
          await db.query("SELECT * FROM operations WHERE input->>'background_operation_id'=$1", [
            bg.id,
          ])
        ).rowCount,
        1,
      );
    },
  );

  await check(
    'Reporting with prior tool calls omits empty tools for strict providers',
    async () => {
      const u = await f.user();
      const chat = await ops.submit(u.id, randomUUID(), 'tool-history-before-report');
      await runtime.processUser(u.id);
      assert.equal((await operation(chat.id)).status, 'succeeded');
      assert.equal(
        (
          await db.query(
            "SELECT id FROM tool_calls WHERE operation_id=$1 AND name='get_agenda' AND status='succeeded'",
            [chat.id],
          )
        ).rowCount,
        1,
      );
      const bg = await task(u.id, 'report-with-tool-history');
      await runtime.tasks.process(bg.id);
      const report = await delivery(bg.id);
      await runtime.processUser(u.id);
      const requests = f.requests.filter(
        (request) =>
          request.report && JSON.stringify(request.payload).includes('report-with-tool-history'),
      );
      assert.equal(requests.length, 1);
      assert.ok(requests[0].payload.messages.some((message: any) => message.role === 'tool'));
      assert.equal(Object.hasOwn(requests[0].payload, 'tools'), false);
      assert.equal((await operation(report.id)).status, 'succeeded');
      assert.equal((await inbox(report.id)).status, 'delivered');
      assert.equal((await operation(bg.id)).attempts, 1);
      assert.equal((await ops.usage(u.id)).used, 2);
      assert.equal((await ops.usage(u.id)).reserved, 0);
    },
  );

  await check(
    'Messages sent during final reporting remain separate chat requests and never steer the report',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'report-admission-case');
      await runtime.tasks.process(bg.id);
      const report = await delivery(bg.id);
      const hold = f.hold('report:report-admission-case');
      const run = runtime.processUser(u.id);
      await bounded(hold.started.wait);
      const chat = await ops.submit(u.id, randomUUID(), '独立的新问题');
      assert.equal(chat.steered, false);
      assert.notEqual(chat.id, report.id);
      await assert.rejects(
        ops.submit(u.id, randomUUID(), '不能补到报告', { targetId: report.id }),
        (e: any) => e.code === 'turn_finished',
      );
      assert.equal((await operation(report.id)).input_version, 0);
      hold.release.open();
      await bounded(run);
      await runtime.processUser(u.id);
      assert.equal((await operation(chat.id)).status, 'succeeded');
      assert.equal((await ops.usage(u.id)).used, 2);
    },
  );

  await check(
    'A restarted main worker delivers a persisted result once without executing research again',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'durable-delivery-case');
      await runtime.tasks.process(bg.id);
      const report = await delivery(bg.id);
      const attempts = (await operation(bg.id)).attempts;
      const restarted = new Runtime(db, config);
      await restarted.processUser(u.id);
      await runtime.processUser(u.id);
      assert.equal((await inbox(report.id)).status, 'delivered');
      assert.equal((await operation(bg.id)).attempts, attempts);
      assert.equal(
        (
          await db.query("SELECT * FROM notifications WHERE user_id=$1 AND kind='task_result'", [
            u.id,
          ])
        ).rowCount,
        1,
      );
      assert.equal((await ops.usage(u.id)).used, 1);
    },
  );

  await check(
    'Stopping a background worker preserves its isolated session and reservation; another worker resumes it',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'restart-case');
      const first = new BackgroundTasks(db, config);
      const hold = f.hold('task:restart-case');
      const run = first.process(bg.id);
      await bounded(hold.started.wait);
      const sessionPath = (await operation(bg.id)).session_path;
      first.stop();
      await bounded(run);
      hold.release.open();
      assert.equal((await operation(bg.id)).status, 'queued');
      assert.equal((await ops.usage(u.id)).reserved, 1);
      assert.equal(await delivery(bg.id), undefined);
      const restarted = new BackgroundTasks(db, config);
      await bounded(restarted.process(bg.id));
      const resumed = await operation(bg.id);
      assert.equal(resumed.status, 'succeeded', resumed.last_error);
      assert.equal(resumed.attempts, 2);
      assert.equal(resumed.session_path, sessionPath);
      assert.equal(
        (await db.query('SELECT * FROM bot_state WHERE user_id=$1', [u.id])).rows[0].session_path,
        null,
      );
      await runtime.processUser(u.id);
      assert.equal((await ops.usage(u.id)).used, 1);
    },
  );

  await check(
    'Expired leases recover through the new queue and reject stale tool writers',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'expired-case');
      const token = randomUUID();
      await db.query(
        "UPDATE operations SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",
        [bg.id, token],
      );
      const ctx: ToolContext = {
        db,
        userId: u.id,
        operationId: bg.id,
        leaseToken: token,
        attempt: 1,
        signal: new AbortController().signal,
      };
      await runtime.tick();
      assert.equal((await operation(bg.id)).status, 'queued');
      await assert.rejects(
        db.tx((c) => fence(c, ctx)),
        (e: any) => e.code === 'lease_lost',
      );
      await runtime.tasks.process(bg.id);
      assert.equal((await operation(bg.id)).status, 'succeeded');
      const reportTools = buildTools({ ...ctx, mode: 'report' });
      assert.equal(reportTools.length, 0);
    },
  );

  await check(
    'Cancellation fences late results, refunds once and preserves account isolation',
    async () => {
      const u = await f.user();
      const other = await f.user();
      const bg = await task(u.id, 'cancel-case');
      const hold = f.hold('task:cancel-case');
      const run = runtime.tasks.process(bg.id);
      await bounded(hold.started.wait);
      const cookie = `nota_session=${encodeURIComponent(f.app.signCookie(await f.auth.session(other.id)))}`;
      assert.equal(
        (await f.app.inject({ url: `/api/operations/${bg.id}`, headers: { cookie } })).statusCode,
        404,
      );
      await ops.cancel(u.id, bg.id);
      hold.release.open();
      await bounded(run);
      assert.equal((await operation(bg.id)).status, 'cancelled');
      assert.equal(await delivery(bg.id), undefined);
      assert.equal((await ops.usage(u.id)).reserved, 0);
      assert.equal((await ops.usage(u.id)).used, 0);
    },
  );

  await check(
    'Final research failure returns its credit and reaches Nota; retry uses the original task',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'failed-case');
      const failing = new BackgroundTasks(db, config);
      failing.agent.run = async () => {
        throw new Error('尚未配置测试供应商');
      };
      await failing.process(bg.id);
      assert.equal((await operation(bg.id)).status, 'failed');
      const report = await delivery(bg.id);
      assert.equal((await inbox(report.id)).payload.status, 'failed');
      assert.equal((await ops.usage(u.id)).reserved, 0);
      await runtime.processUser(u.id);
      assert.match((await operation(report.id)).reply, /未完整完成/);
      const notices = (await db.query('SELECT * FROM notifications WHERE user_id=$1', [u.id])).rows;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].kind, 'attention');
      assert.equal(notices[0].object_id, bg.id);
      await retry(bg.id, u.id);
      assert.ok(
        (await db.query('SELECT resolved_at FROM notifications WHERE id=$1', [notices[0].id]))
          .rows[0].resolved_at,
      );
      await runtime.tasks.process(bg.id);
      assert.equal((await operation(bg.id)).status, 'succeeded');
      assert.notEqual((await delivery(bg.id)).id, report.id);
      assert.equal((await ops.usage(u.id)).used, 1);
    },
  );

  await check(
    'Reporting retries work with exhausted quota and do not rerun or recharge completed research',
    async () => {
      const u = await f.user();
      const bg = await task(u.id, 'report-retry-case');
      await runtime.tasks.process(bg.id);
      const report = await delivery(bg.id);
      const original = runtime.agent.run;
      runtime.agent.run = async () => {
        throw new Error('尚未配置测试汇报供应商');
      };
      try {
        await runtime.processUser(u.id);
      } finally {
        runtime.agent.run = original;
      }
      assert.equal((await inbox(report.id)).status, 'failed');
      await db.query('UPDATE quota_buckets SET used=$2 WHERE user_id=$1', [
        u.id,
        config.FREE_DAILY_LIMIT,
      ]);
      await retry(report.id, u.id);
      await runtime.processUser(u.id);
      assert.equal((await inbox(report.id)).status, 'delivered');
      assert.equal((await operation(bg.id)).attempts, 1);
      assert.equal((await ops.usage(u.id)).used, config.FREE_DAILY_LIMIT);
      assert.equal((await ops.usage(u.id)).reserved, 0);
    },
  );
  assert.deepEqual(f.errors, []);
  console.log(`${results.length} background integration scenarios passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/background-integration.json', JSON.stringify(results, null, 2));
  await f.close();
}
