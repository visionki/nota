import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { backgroundFixture } from './background-fixture.js';
import { buildTools } from '../src/server/tools.js';
import { joinWindow } from '../src/server/recording-windows.js';

const f = await backgroundFixture();
const { db, runtime } = f;
const results: { name: string; ok: boolean }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
}
const auth = async (userId: string) => ({
  cookie: `nota_session=${encodeURIComponent(f.app.signCookie(await f.auth.session(userId)))}`,
});
const get = async (userId: string, path: string) =>
  f.app.inject({ url: `/api${path}`, headers: await auth(userId) });
const post = async (userId: string, path: string) =>
  f.app.inject({ method: 'POST', url: `/api${path}`, payload: {}, headers: await auth(userId) });
const page = async (userId: string, query = '') => {
  const r = await get(userId, `/background-tasks${query}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const task = (userId: string, text: string, policy = 'always') =>
  runtime.ops.create(userId, randomUUID(), 'trigger', {
    source: 'schedule',
    schedule_title: text,
    text,
    notification_policy: policy,
  });
const report = async (id: string) =>
  (
    await db.query(
      "SELECT * FROM operations WHERE input->>'background_operation_id'=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
const detail = async (userId: string, id: string) => {
  const r = await get(userId, `/background-tasks/${id}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
async function outcome(
  id: string,
  values: { summary: string; has_update: boolean; needs_input: boolean },
) {
  const original = runtime.tasks.agent.run;
  runtime.tasks.agent.run = async (ctx) => {
    await buildTools(ctx)
      .find((tool) => tool.name === 'report_task_outcome')!
      .execute(randomUUID(), values);
    return { text: values.summary, usage: 0, sessionPath: 'controlled-task', waiting: undefined };
  };
  try {
    await runtime.tasks.process(id);
  } finally {
    runtime.tasks.agent.run = original;
  }
}

try {
  await check(
    'Task lists exclude ordinary chat, immediate tool work, recording processing and internal report turns',
    async () => {
      const u = await f.user();
      await runtime.ops.submit(u.id, randomUUID(), 'tool-history-before-report');
      await runtime.processUser(u.id);
      await runtime.ops.create(u.id, randomUUID(), 'recording', {
        source: 'web_upload',
        recording_id: randomUUID(),
      });
      const root = await task(u.id, '公告查询');
      await runtime.tasks.process(root.id);
      const rows = await page(u.id);
      assert.equal(rows.tasks.length, 1);
      assert.equal(rows.tasks[0].id, root.id);
      assert.equal(rows.counts.all, 1);
      assert.equal('lease_token' in rows.tasks[0], false);
      assert.equal('usage_tokens' in rows.tasks[0], false);
      const raw = (await get(u.id, '/operations')).json().operations;
      assert.ok(raw.some((op: any) => op.kind === 'chat'));
      assert.ok(raw.some((op: any) => op.kind === 'recording'));
      assert.ok(raw.some((op: any) => op.input.source === 'background_result'));
    },
  );

  await check(
    'One task stays active through result delivery and becomes one historical entry after Nota reports',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '公告汇总');
      let current = await page(u.id);
      assert.equal(current.tasks[0].status, 'queued');
      await runtime.tasks.process(root.id);
      current = await page(u.id);
      assert.equal(current.tasks.length, 1);
      assert.equal(current.tasks[0].status, 'running');
      assert.equal(current.tasks[0].stage, 'awaiting_report');
      assert.equal(current.counts.history, 0);
      await runtime.processUser(u.id);
      assert.equal((await page(u.id)).tasks.length, 0);
      const history = await page(u.id, '?scope=history');
      assert.equal(history.tasks.length, 1);
      assert.equal(history.tasks[0].id, root.id);
      assert.equal(history.tasks[0].status, 'succeeded');
      const delivery = await report(root.id),
        data = await detail(u.id, delivery.id);
      assert.equal(data.task.id, root.id);
      assert.equal(data.stages.length, 2);
      assert.equal(data.result, null);
      assert.ok(data.task.message_id);
      assert.equal(data.task.retry_operation_id, null);
    },
  );

  await check(
    'Unchanged checks have visible history without generating a second report or notification',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '只监控新公告', 'on_change');
      await outcome(root.id, {
        summary: '检查完成，没有新公告。',
        has_update: false,
        needs_input: false,
      });
      const history = await page(u.id, '?scope=history');
      assert.equal(history.tasks.length, 1);
      assert.equal(history.tasks[0].stage, 'unchanged');
      const data = await detail(u.id, root.id);
      assert.equal(data.stages.length, 1);
      assert.match(data.result, /没有新公告/);
      assert.equal(
        (await db.query('SELECT * FROM notifications WHERE user_id=$1', [u.id])).rowCount,
        0,
      );
    },
  );

  await check(
    'A failed delivery retries the saved report and leaves research and its quota untouched',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '交付重试');
      await runtime.tasks.process(root.id);
      const delivery = await report(root.id),
        original = runtime.agent.run;
      runtime.agent.run = async () => {
        throw new Error('尚未配置受控汇报服务');
      };
      try {
        await runtime.processUser(u.id);
      } finally {
        runtime.agent.run = original;
      }
      const current = await page(u.id);
      assert.equal(current.tasks.length, 1);
      assert.equal(current.tasks[0].stage, 'delivery_failed');
      assert.equal(current.tasks[0].status, 'failed');
      assert.equal(current.tasks[0].retry_operation_id, delivery.id);
      assert.equal(
        (await get(u.id, `/operations/${delivery.id}/destination`)).json().destination.target,
        root.id,
      );
      assert.equal((await post(u.id, `/operations/${delivery.id}/retry`)).statusCode, 200);
      await runtime.processUser(u.id);
      const data = await detail(u.id, root.id);
      assert.equal(data.task.status, 'succeeded');
      assert.equal(data.stages[0].attempts, 1);
      assert.equal((await runtime.ops.usage(u.id)).used, 1);
      assert.equal((await page(u.id, '?scope=all')).tasks.length, 1);
    },
  );

  await check(
    'A blocked report resumes the same task and hides its Agent continuation as a separate list item',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '需要补充的公告查询');
      await outcome(root.id, {
        summary: '请确认要查哪家公司。',
        has_update: true,
        needs_input: true,
      });
      await runtime.processUser(u.id);
      const data = await detail(u.id, root.id),
        delivery = await report(root.id);
      assert.equal(data.task.status, 'waiting');
      assert.equal(data.task.reply_operation_id, delivery.id);
      const destination = (await get(u.id, `/operations/${delivery.id}/destination`)).json()
        .destination;
      assert.equal(destination.view, 'chat');
      assert.equal(destination.target, data.task.message_id);
      await runtime.ops.submit(u.id, randomUUID(), '星河科技', { targetId: delivery.id });
      await runtime.processUser(u.id);
      const all = await page(u.id, '?scope=all');
      assert.equal(all.tasks.length, 1);
      assert.equal(all.tasks[0].status, 'succeeded');
    },
  );

  await check(
    'A new attempt with no changes cannot inherit an earlier failed report status',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '恢复后的监控', 'on_change'),
        original = runtime.tasks.agent.run;
      runtime.tasks.agent.run = async () => {
        throw new Error('尚未配置受控查询服务');
      };
      try {
        await runtime.tasks.process(root.id);
      } finally {
        runtime.tasks.agent.run = original;
      }
      assert.equal((await page(u.id)).tasks[0].status, 'failed');
      assert.equal((await post(u.id, `/operations/${root.id}/retry`)).statusCode, 200);
      await outcome(root.id, {
        summary: '已恢复检查，没有新变化。',
        has_update: false,
        needs_input: false,
      });
      const data = await detail(u.id, root.id);
      assert.equal(data.task.status, 'succeeded');
      assert.equal(data.task.stage, 'unchanged');
      assert.equal(data.stages.length, 1);
    },
  );

  await check(
    'Queued tasks can be cancelled and remain one historical task with no duplicate charge',
    async () => {
      const u = await f.user(),
        root = await task(u.id, '取消查询');
      assert.equal((await page(u.id)).tasks[0].cancel_operation_id, root.id);
      assert.equal((await post(u.id, `/operations/${root.id}/cancel`)).statusCode, 200);
      const history = await page(u.id, '?scope=history');
      assert.equal(history.tasks.length, 1);
      assert.equal(history.tasks[0].status, 'cancelled');
      assert.equal((await runtime.ops.usage(u.id)).reserved, 0);
      assert.equal((await runtime.ops.usage(u.id)).used, 0);
    },
  );

  await check(
    'Chat failures route to their actual message and expose retry state in chat',
    async () => {
      const u = await f.user(),
        op = await runtime.ops.submit(u.id, randomUUID(), '即时查询失败'),
        original = runtime.agent.run;
      runtime.agent.run = async () => {
        throw new Error('尚未配置受控聊天服务');
      };
      try {
        await runtime.processUser(u.id);
      } finally {
        runtime.agent.run = original;
      }
      assert.equal((await page(u.id, '?scope=all')).tasks.length, 0);
      const destination = (await get(u.id, `/operations/${op.id}/destination`)).json().destination;
      const state = (await get(u.id, `/operations/${op.id}/state`)).json().operation;
      assert.equal(destination.view, 'chat');
      assert.equal(destination.target, state.latest_message_id);
      assert.equal(state.retryable, true);
      assert.equal((await post(u.id, `/operations/${op.id}/retry`)).statusCode, 200);
      await runtime.processUser(u.id);
      assert.equal(
        (await get(u.id, `/operations/${op.id}/state`)).json().operation.retryable,
        false,
      );
    },
  );

  await check(
    'Recording and batch destinations stay in voice notes instead of the background task list',
    async () => {
      const u = await f.user(),
        recordingId = randomUUID();
      const file = await runtime.ops.create(u.id, randomUUID(), 'recording', {
        source: 'web_upload',
        recording_id: recordingId,
      });
      const batchId = await db.tx(async (c) => {
        await c.query(
          "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds) VALUES($1,$2,$3,'口述便签',$4,'memo.wav','audio/wav',44,1)",
          [recordingId, u.id, file.id, randomUUID()],
        );
        return joinWindow(c, u.id, file.id, recordingId);
      });
      const batch = await runtime.ops.create(u.id, randomUUID(), 'trigger', {
        source: 'recording_window',
        batch_id: batchId,
        text: '汇总录音',
      });
      for (const id of [file.id, batch.id]) {
        const dest = (await get(u.id, `/operations/${id}/destination`)).json().destination;
        assert.equal(dest.view, 'recordings');
        assert.equal(dest.target, recordingId);
      }
      const failedId = randomUUID();
      const failedFile = await runtime.ops.create(u.id, randomUUID(), 'recording', {
        source: 'web_upload',
        recording_id: failedId,
      });
      await db.tx(async (c) => {
        await c.query(
          "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,status) VALUES($1,$2,$3,'需要重试的便签',$4,'failed.wav','audio/wav',44,1,'needs_attention')",
          [failedId, u.id, failedFile.id, randomUUID()],
        );
        await joinWindow(c, u.id, failedFile.id, failedId);
        await c.query("UPDATE operations SET status='failed' WHERE id=$1", [failedFile.id]);
      });
      const failedDestination = (await get(u.id, `/operations/${batch.id}/destination`)).json()
        .destination;
      assert.equal(failedDestination.view, 'recordings');
      assert.equal(failedDestination.target, failedId);
      assert.equal((await page(u.id, '?scope=all')).tasks.length, 0);
    },
  );

  await check(
    'Pagination covers root tasks with equal timestamps despite hundreds of unrelated turns, and enforces owners',
    async () => {
      const u = await f.user(),
        other = await f.user(),
        roots: string[] = [];
      await db.tx(async (c) => {
        for (let n = 0; n < 160; n++) {
          const id = randomUUID(),
            isRoot = n < 31;
          if (isRoot) roots.push(id);
          await c.query(
            "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,executor,status) VALUES($1,$2,$7,'seed',$3,$4,$5,$6)",
            [
              id,
              u.id,
              isRoot ? 'trigger' : 'chat',
              JSON.stringify({ source: isRoot ? 'schedule' : 'web_text', text: `历史查询 ${n}` }),
              isRoot ? 'background' : 'agent',
              n % 2 ? 'succeeded' : 'queued',
              id,
            ],
          );
        }
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const current = await page(u.id, `?scope=all&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
        assert.equal(current.counts.all, 31);
        seen.push(...current.tasks.map((t: any) => t.id));
        cursor = current.next_cursor;
      } while (cursor);
      assert.equal(new Set(seen).size, 31);
      assert.equal(seen.length, 31);
      assert.deepEqual(new Set(seen), new Set(roots));
      for (const path of [
        `/background-tasks/${roots[0]}`,
        `/operations/${roots[0]}/destination`,
        `/operations/${roots[0]}/state`,
        `/background-tasks?cursor=${roots[0]}`,
      ])
        assert.equal((await get(other.id, path)).statusCode, 404);
      assert.equal((await page(other.id)).counts.all, 0);
      assert.equal((await get(u.id, '/background-tasks?scope=invalid')).statusCode, 400);
      assert.equal((await f.app.inject({ url: '/api/background-tasks' })).statusCode, 401);
    },
  );
  console.log(`${results.length} task view integration scenarios passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/tasks-integration.json', JSON.stringify(results, null, 2));
  await f.close();
}
