import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { testDatabase, wav } from './helpers.js';
import { Operations, quotaDay, isPro } from '../src/server/quota.js';
import { AppError, emit } from '../src/server/db.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';
import { createApp } from '../src/server/app.js';
import { Billing } from '../src/server/billing.js';
import { deliverReminders, activateSchedules } from '../src/server/scheduler.js';
import { Runtime } from '../src/server/runtime.js';
import { Transcriber } from '../src/server/transcribe.js';
import { Storage } from '../src/server/storage.js';
import { createServer } from 'node:http';
import { LEGACY_UPLOAD_INSTRUCTION } from '../src/shared/notes.js';
import { readExecutionProcess } from '../src/server/execution.js';
import { agenda, createArrangement, updateEvent } from '../src/server/domain.js';
const fixture = await testDatabase(),
  { db, config, user } = fixture,
  ops = new Operations(db, config);
const results: { name: string; ms: number; ok: boolean }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ms: Date.now() - start, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ms: Date.now() - start, ok: false });
    throw e;
  }
}
const count = async (table: string, where: string, args: unknown[]) =>
  Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args)).rows[0].n);
async function running(u: string, key = randomUUID()) {
  const op = await ops.create(u, key, 'chat', { text: 'integration fixture' });
  const token = randomUUID();
  await db.query(
    "UPDATE operations SET status='running',attempts=1,cycle_attempts=1,lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
    [op.id, token],
  );
  const ctx: ToolContext = {
    db,
    userId: u,
    operationId: op.id,
    leaseToken: token,
    attempt: 1,
    signal: new AbortController().signal,
  };
  return { op, ctx, tools: buildTools(ctx) };
}
let app: any, runtime: Runtime | undefined;
try {
  await check(
    'Event tools read and patch every business field on the original object without resetting unrelated data',
    async () => {
      const u = await user(),
        r = await running(u.id);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await r.tools
          .find((tool) => tool.name === name)!
          .execute(randomUUID(), args);
        assert.notEqual(result.details.completed, false, result.details.error);
        return result.details;
      };
      const people = [randomUUID(), randomUUID()],
        recordings = [randomUUID(), randomUUID()];
      for (const id of people)
        await db.query('INSERT INTO people(id,user_id,name) VALUES($1,$2,$3)', [
          id,
          u.id,
          `人物-${id}`,
        ]);
      for (const id of recordings)
        await db.query(
          "INSERT INTO recordings(id,user_id,title,storage_key,filename,mime,size_bytes,duration_seconds,status) VALUES($1,$2,'日程来源',$3,'source.wav','audio/wav',32044,1,'ready')",
          [id, u.id, `${u.id}/${id}.wav`],
        );
      const event = await call('create_event', {
        title: '面谈',
        starts_at: '2031-03-14T10:00:00-04:00',
        ends_at: '2031-03-14T11:00:00-04:00',
        timezone: 'America/New_York',
        location: '原地点',
        notes: '原备注',
        person_id: people[0],
        recording_id: recordings[0],
      });
      const reminder = await call('create_reminder', {
        title: '出发',
        event_id: event.id,
        before_minutes: 30,
      });
      const before = await call('get_event', { event_id: event.id });
      assert.equal(before.reminders[0].id, reminder.id);
      const patched = await call('update_event', {
        event_id: event.id,
        location: '科苑地铁站附近',
      });
      assert.equal(patched.id, event.id);
      assert.equal(patched.notes, '原备注');
      assert.equal(patched.timezone, 'America/New_York');
      assert.equal(patched.person_id, people[0]);
      assert.equal(patched.recording_id, recordings[0]);
      const fresh = await call('get_event', { event_id: event.id });
      assert.equal(fresh.location, '科苑地铁站附近');
      assert.equal(+new Date(fresh.reminders[0].remind_at), +new Date(reminder.remind_at));
      await call('update_event', {
        event_id: event.id,
        title: '新的面谈标题',
        starts_at: '2031-03-14T11:00:00-04:00',
        ends_at: '2031-03-14T12:00:00-04:00',
        timezone: 'Europe/London',
        location: '',
        notes: '新的备注',
        person_id: people[1],
        recording_id: recordings[1],
      });
      const changed = await call('get_event', { event_id: event.id });
      assert.equal(changed.title, '新的面谈标题');
      assert.equal(changed.location, '');
      assert.equal(changed.notes, '新的备注');
      assert.equal(changed.timezone, 'Europe/London');
      assert.equal(changed.person_id, people[1]);
      assert.equal(changed.recording_id, recordings[1]);
      assert.equal(
        +new Date(changed.reminders[0].remind_at),
        +new Date(reminder.remind_at) + 3600000,
      );
      const cleared = await call('update_event', {
        event_id: event.id,
        notes: '',
        person_id: null,
        recording_id: null,
      });
      assert.equal(cleared.notes, '');
      assert.equal(cleared.person_id, null);
      assert.equal(cleared.recording_id, null);
      await call('update_event', { event_id: event.id, notes: '暂时补充' });
      assert.equal((await call('update_event', { event_id: event.id, notes: '' })).notes, '');
      await Promise.all([
        db.tx((c) => updateEvent(c, u.id, event.id, { location: '并发补充地点' })),
        db.tx((c) => updateEvent(c, u.id, event.id, { notes: '并发补充备注' })),
      ]);
      const cancelled = await call('cancel_event', { event_id: event.id });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.location, '并发补充地点');
      assert.equal(cancelled.notes, '并发补充备注');
      assert.equal(cancelled.timezone, 'Europe/London');
      const history = await call('get_event', { event_id: event.id });
      assert.equal(history.reminders[0].status, 'cancelled');
      assert.equal((await call('get_reminder', { reminder_id: reminder.id })).status, 'cancelled');
      assert.equal(await count('calendar_events', 'user_id=$1', [u.id]), 1);
      assert.equal(
        await count(
          'action_receipts',
          "operation_id=$1 AND (key LIKE 'get_event:%' OR key LIKE 'get_reminder:%')",
          [r.op.id],
        ),
        0,
      );
    },
  );
  await check(
    'Reminder tools update relative offsets and add or clear owned associations without recreating a reminder',
    async () => {
      const u = await user(),
        r = await running(u.id);
      const call = async (name: string, args: Record<string, unknown>) =>
        r.tools.find((tool) => tool.name === name)!.execute(randomUUID(), args);
      const a = (
        await call('create_event', {
          title: '上午安排',
          starts_at: '2031-03-14T09:00:00+08:00',
          ends_at: '2031-03-14T10:00:00+08:00',
        })
      ).details;
      const b = (
        await call('create_event', {
          title: '下午安排',
          starts_at: '2031-03-14T14:00:00+08:00',
          ends_at: '2031-03-14T15:00:00+08:00',
        })
      ).details;
      const todo = (await call('create_todo', { title: '准备材料' })).details;
      const reminder = (
        await call('create_reminder', { title: '原提醒', event_id: a.id, before_minutes: 15 })
      ).details;
      const earlier = (
        await call('update_reminder', { reminder_id: reminder.id, before_minutes: 30 })
      ).details;
      assert.equal(earlier.id, reminder.id);
      assert.equal(+new Date(earlier.remind_at), +new Date(a.starts_at) - 30 * 60000);
      const ambiguous = await call('update_reminder', {
        reminder_id: reminder.id,
        event_id: b.id,
        todo_id: todo.id,
        before_minutes: 60,
      });
      assert.equal(ambiguous.details.completed, false);
      const linked = (
        await call('update_reminder', {
          reminder_id: reminder.id,
          title: '新提醒',
          event_id: b.id,
          todo_id: null,
          before_minutes: 60,
        })
      ).details;
      assert.equal(linked.event_id, b.id);
      assert.equal(linked.todo_id, null);
      assert.equal(+new Date(linked.remind_at), +new Date(b.starts_at) - 60 * 60000);
      const bad = await call('update_reminder', {
        reminder_id: reminder.id,
        before_minutes: 30,
        remind_at: '2031-03-14T12:00:00+08:00',
      });
      assert.equal(bad.details.completed, false);
      const cleared = (
        await call('update_reminder', { reminder_id: reminder.id, event_id: null, todo_id: null })
      ).details;
      assert.equal(cleared.event_id, null);
      assert.equal(cleared.todo_id, null);
      assert.equal(+new Date(cleared.remind_at), +new Date(linked.remind_at));
      assert.equal(
        (await call('update_reminder', { reminder_id: reminder.id, before_minutes: 30 })).details
          .completed,
        false,
      );
      assert.equal(await count('reminders', 'user_id=$1', [u.id]), 1);
    },
  );
  await check(
    'Calendar HTTP read, partial update and delete preserve data and enforce ownership for all new tool operations',
    async () => {
      const { app: service } = await createApp(config, db);
      try {
        const registered = await service.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            name: '日程字段验收',
            email: `${randomUUID()}@nota.test`,
            password: randomUUID(),
          },
        });
        assert.equal(registered.statusCode, 200);
        const u = registered.json().user.id,
          cookie = String(registered.headers['set-cookie']).split(';')[0];
        const request = (
          method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
          url: string,
          payload?: Record<string, unknown>,
        ) => service.inject({ method, url, headers: { cookie }, payload });
        const created = await request('POST', '/api/calendar', {
          title: 'HTTP 日程',
          starts_at: '2031-03-14T09:00:00+08:00',
          ends_at: '2031-03-14T10:00:00+08:00',
          timezone: 'Asia/Tokyo',
          location: '旧地点',
          notes: '保留备注',
        });
        assert.equal(created.statusCode, 200);
        const id = created.json().id;
        const reminder = (
          await request('POST', '/api/reminders', {
            title: 'HTTP 提醒',
            event_id: id,
            before_minutes: 30,
          })
        ).json();
        assert.equal(
          (await request('GET', `/api/calendar/${id}`)).json().reminders[0].id,
          reminder.id,
        );
        assert.equal((await request('GET', `/api/reminders/${reminder.id}`)).json().event_id, id);
        const patched = await request('PATCH', `/api/calendar/${id}`, { location: '新地点' });
        assert.equal(patched.statusCode, 200);
        assert.equal(patched.json().notes, '保留备注');
        assert.equal(patched.json().timezone, 'Asia/Tokyo');
        const other = await user(),
          foreign = await running(other.id);
        for (const [name, args] of [
          ['get_event', { event_id: id }],
          ['update_event', { event_id: id, location: '越权修改' }],
          ['cancel_event', { event_id: id }],
          ['get_reminder', { reminder_id: reminder.id }],
          ['update_reminder', { reminder_id: reminder.id, before_minutes: 5 }],
        ] as const)
          assert.equal(
            (await foreign.tools.find((tool) => tool.name === name)!.execute(randomUUID(), args))
              .details.completed,
            false,
          );
        assert.equal((await request('DELETE', `/api/calendar/${id}`)).json().status, 'cancelled');
        const deleted = (await request('GET', `/api/calendar/${id}`)).json();
        assert.equal(deleted.location, '新地点');
        assert.equal(deleted.notes, '保留备注');
        assert.equal(deleted.timezone, 'Asia/Tokyo');
        assert.equal(deleted.reminders[0].status, 'cancelled');
        assert.equal(await count('calendar_events', 'user_id=$1', [u]), 1);
      } finally {
        await service.close();
      }
    },
  );
  await check(
    'Tavily tools fetch outside transactions, refresh repeated searches and persist success and failure events',
    async () => {
      const u = await user(),
        r = await running(u.id),
        originalFetch = globalThis.fetch;
      const tools = buildTools({
        ...r.ctx,
        config: { ...config, TAVILY_API_KEY: 'tvly-integration-private' },
      });
      let searches = 0,
        fail = false;
      globalThis.fetch = async (url, init) => {
        await db.tx(async (c) => {
          await c.query("SET LOCAL lock_timeout='250ms'");
          await c.query('SELECT id FROM operations WHERE id=$1 FOR UPDATE', [r.op.id]);
        });
        assert.equal((init?.headers as any).Authorization, 'Bearer tvly-integration-private');
        if (fail) return Response.json({ error: 'tvly-integration-private' }, { status: 429 });
        if (String(url).endsWith('/extract'))
          return Response.json({
            results: [{ url: 'https://example.com/source', raw_content: '# 公开网页正文' }],
          });
        return Response.json({
          results: [
            {
              title: `结果 ${++searches}`,
              url: 'https://example.com/source',
              content: '带有来源的片段',
            },
          ],
        });
      };
      try {
        const search = tools.find((t) => t.name === 'search_web')!,
          read = tools.find((t) => t.name === 'read_webpage')!;
        const first = await search.execute('web-search-1', { query: '公开资料' });
        const second = await search.execute('web-search-2', { query: '公开资料' });
        assert.equal(first.details.results[0].title, '结果 1');
        assert.equal(second.details.results[0].title, '结果 2');
        const page = await read.execute('web-read', { url: first.details.results[0].url });
        assert.equal(page.details.content, '# 公开网页正文');
        assert.equal(await count('action_receipts', 'operation_id=$1', [r.op.id]), 0);
        assert.equal(
          await count('tool_calls', "operation_id=$1 AND status='succeeded'", [r.op.id]),
          3,
        );
        const events = (
          await db.query(
            "SELECT data FROM user_events WHERE operation_id=$1 AND type='tool' AND data->>'status'='succeeded' ORDER BY id",
            [r.op.id],
          )
        ).rows;
        assert.equal(events.length, 3);
        assert.equal(events[0].data.result.results[0].url, 'https://example.com/source');
        fail = true;
        const failure = await search.execute('web-search-failed', { query: '另一条查询' });
        assert.equal(failure.details.completed, false);
        assert.match(failure.details.error, /稍后重试/);
        const trace = (
          await db.query("SELECT error FROM tool_calls WHERE operation_id=$1 AND status='failed'", [
            r.op.id,
          ])
        ).rows[0];
        assert.ok(trace);
        assert.ok(!trace.error.includes('tvly-integration-private'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
  await check('A user correction during web retrieval supersedes the old tool result', async () => {
    const u = await user(),
      r = await running(u.id),
      originalFetch = globalThis.fetch;
    const tools = buildTools({
      ...r.ctx,
      requestVersion: 0,
      config: { ...config, TAVILY_API_KEY: 'tvly-integration-private' },
    });
    globalThis.fetch = async () => {
      await db.query('UPDATE operations SET input_version=input_version+1 WHERE id=$1', [r.op.id]);
      return Response.json({ results: [] });
    };
    try {
      const response = await tools
        .find((t) => t.name === 'search_web')!
        .execute('web-corrected', { query: '旧查询' });
      assert.equal(response.details.superseded, true);
      assert.equal(
        await count('tool_calls', "operation_id=$1 AND status='superseded'", [r.op.id]),
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  await check(
    'Calendar arrangements create one object and roll back event plus notification together',
    async () => {
      const u = await user();
      const point = await db.tx((c) =>
        createArrangement(c, u.id, {
          title: '独立时间点',
          kind: 'reminder',
          starts_at: '2031-03-14T06:00:00+08:00',
          timezone: 'Asia/Shanghai',
        }),
      );
      assert.equal(point.event, null);
      assert.equal(point.reminder.title, '独立时间点');
      const duration = await db.tx((c) =>
        createArrangement(c, u.id, {
          title: '有提前提醒的安排',
          starts_at: '2031-03-14T09:00:00+08:00',
          ends_at: '2031-03-14T10:00:00+08:00',
          before_minutes: 30,
        }),
      );
      assert.equal(duration.reminder.event_id, duration.event.id);
      assert.equal(
        +new Date(duration.event.starts_at) - +new Date(duration.reminder.remind_at),
        30 * 60000,
      );
      const before = await count('calendar_events', 'user_id=$1', [u.id]);
      await assert.rejects(() =>
        db.tx((c) =>
          createArrangement(c, u.id, {
            title: '不能留下半条安排',
            starts_at: new Date(Date.now() + 3600000).toISOString(),
            ends_at: new Date(Date.now() + 7200000).toISOString(),
            before_minutes: 1440,
          }),
        ),
      );
      assert.equal(await count('calendar_events', 'user_id=$1', [u.id]), before);
      assert.equal((await ops.usage(u.id)).used, 0);
    },
  );
  await check(
    'Calendar ranges are complete, isolate users, exclude the end boundary and include linked notification settings',
    async () => {
      const u = await user(),
        other = await user();
      const from = '2031-03-01T00:00:00Z',
        to = '2031-04-01T00:00:00Z';
      await db.query(
        "INSERT INTO calendar_events(id,user_id,title,starts_at,ends_at,timezone,dedupe_key) SELECT gen_random_uuid(),$1,'密集安排 '||n,$2::timestamptz+n*interval '10 minutes',$2::timestamptz+(n+1)*interval '10 minutes','UTC','dense-'||n FROM generate_series(1,201) AS n",
        [u.id, from],
      );
      const linked = await db.tx((c) =>
        createArrangement(c, u.id, {
          title: '通知位于上个月',
          starts_at: '2031-03-01T01:00:00Z',
          ends_at: '2031-03-01T02:00:00Z',
          before_minutes: 1440,
        }),
      );
      await db.tx((c) =>
        createArrangement(c, u.id, { kind: 'reminder', title: '范围起点', starts_at: from }),
      );
      await db.tx((c) =>
        createArrangement(c, u.id, { kind: 'reminder', title: '范围终点', starts_at: to }),
      );
      await db.tx((c) =>
        createArrangement(c, other.id, { kind: 'reminder', title: '其他账号', starts_at: from }),
      );
      const result = await agenda(db, u.id, from, to);
      assert.equal(result.events.length, 202);
      assert.deepEqual(
        result.reminders.map((r) => r.title),
        ['范围起点'],
      );
      assert.deepEqual(
        result.event_reminders.map((r) => r.id),
        [linked.reminder.id],
      );
      assert.ok(result.events.every((e) => e.user_id === u.id));
    },
  );
  await check('50 parallel Free requests accept exactly 10', async () => {
    const u = await user();
    const all = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        ops.create(u.id, `parallel-${i}`, 'chat', { text: `request ${i}` }),
      ),
    );
    const accepted = all.filter((x) => x.status === 'fulfilled');
    assert.equal(accepted.length, 10);
    for (const r of all)
      if (r.status === 'rejected') assert.equal((r.reason as AppError).code, 'quota_exhausted');
    await Promise.all(
      accepted.map(async (r) => {
        if (r.status === 'fulfilled')
          for (let i = 0; i < 2; i++)
            await db.tx((c) => ops.settle(c, u.id, r.value.id, 'committed'));
      }),
    );
    const q = await ops.usage(u.id);
    assert.equal(q.used, 10);
    assert.equal(q.reserved, 0);
  });
  await check('Last available credit is claimed once under concurrency', async () => {
    const u = await user();
    await db.query('INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,$2,9)', [
      u.id,
      quotaDay(),
    ]);
    const r = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        ops.create(u.id, `last-credit-${i}`, 'chat', { text: String(i) }),
      ),
    );
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  });
  await check('100 identical retries create one operation and one reservation', async () => {
    const u = await user();
    const r = await Promise.all(
      Array.from({ length: 100 }, () =>
        ops.create(u.id, 'same-key-100', 'chat', { text: 'same body' }),
      ),
    );
    assert.equal(new Set(r.map((x) => x.id)).size, 1);
    assert.equal(await count('operations', 'user_id=$1', [u.id]), 1);
    assert.equal((await ops.usage(u.id)).reserved, 1);
    await assert.rejects(
      () => ops.create(u.id, 'same-key-100', 'chat', { text: 'different body' }),
      (e: any) => e.status === 409,
    );
  });
  await check(
    'Legacy accepted uploads replay without identity flags or duplicate credits',
    async () => {
      const u = await user();
      for (const diarize of [false, true]) {
        const key = randomUUID();
        const input = {
          recording_id: randomUUID(),
          content_hash: 'same-audio',
          title: '旧版本机便签',
          instruction: LEGACY_UPLOAD_INSTRUCTION,
          source: 'web_upload',
        };
        const first = await ops.create(u.id, key, 'recording', { ...input, diarize });
        const replay = await ops.create(u.id, key, 'recording', input);
        assert.equal(replay.id, first.id);
        assert.equal(replay.replayed, true);
        assert.equal(replay.payload_hash, first.payload_hash);
        assert.equal(replay.input.diarize, diarize);
        for (const changed of [
          { ...input, content_hash: 'different-audio' },
          { ...input, instruction: 'different-instruction' },
        ])
          await assert.rejects(
            () => ops.create(u.id, key, 'recording', changed),
            (e: any) => e.code === 'idempotency_conflict',
          );
      }
      assert.equal(await count('operations', 'user_id=$1', [u.id]), 2);
      assert.equal((await ops.usage(u.id)).reserved, 2);
    },
  );
  await check(
    'Final failure and cross-midnight release settle the original bucket once',
    async () => {
      const u = await user(),
        old = new Date('2026-11-11T15:59:59Z');
      const op = await ops.create(
        u.id,
        'cross-day-failure',
        'chat',
        { text: 'fixture' },
        undefined,
        old,
      );
      await db.tx(async (c) => {
        await ops.settle(c, u.id, op.id, 'released');
        await ops.settle(c, u.id, op.id, 'released');
        await ops.settle(c, u.id, op.id, 'committed');
      });
      const q = (
        await db.query('SELECT quota_day::text,used,reserved FROM quota_buckets WHERE user_id=$1', [
          u.id,
        ])
      ).rows;
      assert.deepEqual(q, [{ quota_day: '2026-11-11', used: 0, reserved: 0 }]);
    },
  );
  await check('Pro is decided by server-side period and entitlement', async () => {
    const u = await user();
    await db.query(
      "UPDATE subscriptions SET plan='pro',status='active',period_end=now()+interval '1 day' WHERE user_id=$1",
      [u.id],
    );
    const r = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        ops.create(u.id, `pro-operation-${i}`, 'chat', { text: String(i) }),
      ),
    );
    assert.equal(r.length, 25);
    assert.equal(await isPro(db, u.id), true);
    await db.query(
      "UPDATE subscriptions SET period_end=now()-interval '1 second' WHERE user_id=$1",
      [u.id],
    );
    assert.equal(await isPro(db, u.id), false);
    await assert.rejects(
      () => ops.create(u.id, 'expired-pro-op', 'chat', { text: 'extra' }),
      (e: any) => e.code === 'quota_exhausted',
    );
  });
  await check('Tool receipts replay business writes without duplicate events', async () => {
    const u = await user(),
      r = await running(u.id);
    const tool = r.tools.find((t) => t.name === 'create_event')!;
    const args = {
      title: '验收评审',
      starts_at: '2026-11-20T15:00:00+08:00',
      ends_at: '2026-11-20T16:00:00+08:00',
    };
    const a = await tool.execute('call-first', args),
      b = await tool.execute('call-after-crash', args);
    assert.equal(a.details.id, b.details.id);
    assert.equal(await count('calendar_events', 'user_id=$1', [u.id]), 1);
    assert.equal(
      await count('tool_calls', 'operation_id=$1 AND status=$2', [r.op.id, 'succeeded']),
      2,
    );
  });
  await check('Business write and receipt roll back together on a crash boundary', async () => {
    const u = await user(),
      r = await running(u.id);
    await db.query(
      `CREATE FUNCTION fixture_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='${r.op.id}'::uuid THEN RAISE EXCEPTION 'fixture receipt write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_crash_trigger BEFORE INSERT ON action_receipts FOR EACH ROW EXECUTE FUNCTION fixture_crash()`,
    );
    const tool = r.tools.find((t) => t.name === 'create_todo')!;
    const a = await tool.execute('crash-boundary', { title: 'cannot be orphaned' });
    assert.equal(a.details.completed, false);
    assert.equal(await count('todos', 'user_id=$1', [u.id]), 0);
    await db.query(
      'DROP TRIGGER fixture_crash_trigger ON action_receipts; DROP FUNCTION fixture_crash()',
    );
    await tool.execute('after-restart', { title: 'cannot be orphaned' });
    assert.equal(await count('todos', 'user_id=$1', [u.id]), 1);
  });
  await check('Lease fencing rejects expired or cancelled writers', async () => {
    const u = await user(),
      r = await running(u.id);
    await db.query("UPDATE operations SET lease_until=now()-interval '1 second' WHERE id=$1", [
      r.op.id,
    ]);
    await assert.rejects(
      () => r.tools.find((t) => t.name === 'create_todo')!.execute('late', { title: 'late write' }),
      (e: any) => e.code === 'lease_lost',
    );
    assert.equal(await count('todos', 'user_id=$1', [u.id]), 0);
  });
  await check('Browser MediaRecorder WebM without duration is accepted and bounded', async () => {
    const u = await user(),
      storage = new Storage(config);
    const audio = await storage.put(
      u.id,
      'browser.webm',
      await readFile('tests/fixtures/browser-capture.webm'),
    );
    assert.ok(audio.duration > 3 && audio.duration < 4);
    await storage.remove(audio.key);
  });
  await check('Relations reject invented evidence and retain original quotations', async () => {
    const u = await user(),
      r = await running(u.id);
    const tool = r.tools.find((t) => t.name === 'remember_fact')!;
    const falseFact = await tool.execute('fabricated', {
      subject: '项目',
      predicate: '报价',
      value: '128000',
      evidence: '这段话并不存在',
    });
    assert.equal(falseFact.details.completed, false);
    assert.equal(await count('facts', 'user_id=$1', [u.id]), 0);
    await db.query(
      "UPDATE messages SET content='王经理说，星河项目报价是12.8万元。' WHERE operation_id=$1",
      [r.op.id],
    );
    const saved = await tool.execute('valid-evidence', {
      person_name: '王经理',
      subject: '星河项目',
      predicate: '报价',
      value: '12.8万元',
      evidence: '王经理说，星河项目报价是12.8万元。',
    });
    assert.equal(saved.details.memory_status, 'requires_review');
    const committed = await tool.execute('commit-valid-evidence', {
      proposal_id: saved.details.proposal_id,
      action: 'ADD',
      target_ids: [],
      classification: 'durable',
      evidence_supported: true,
      reason: 'The quoted material explicitly states the fact',
    });
    assert.ok(committed.details.fact);
    assert.equal(await count('people', 'user_id=$1', [u.id]), 1);
  });
  await check('Reminder delivery is deterministic and exactly once, without AI quota', async () => {
    const u = await user(),
      id = randomUUID();
    await db.query(
      "INSERT INTO reminders(id,user_id,title,remind_at,dedupe_key) VALUES($1,$2,$3,now()-interval '1 second',$4)",
      [id, u.id, '到点提醒', id],
    );
    await Promise.all(Array.from({ length: 10 }, () => deliverReminders(db)));
    assert.equal(await count('notifications', 'user_id=$1', [u.id]), 1);
    assert.equal(await count('messages', 'user_id=$1', [u.id]), 1);
    assert.equal(await count('operations', 'user_id=$1', [u.id]), 0);
  });
  await check('Scheduled activation deduplicates and reports quota exhaustion', async () => {
    const u = await user(),
      id = randomUUID();
    await db.query(
      "INSERT INTO schedules(id,user_id,title,prompt,next_run_at) VALUES($1,$2,$3,$4,now()-interval '1 second')",
      [id, u.id, '定时测试', '查看今天的待办'],
    );
    await Promise.all(Array.from({ length: 5 }, () => activateSchedules(db, ops)));
    assert.equal(await count('operations', 'user_id=$1', [u.id]), 1);
    assert.equal(
      (await db.query('SELECT active FROM schedules WHERE id=$1', [id])).rows[0].active,
      false,
    );
    const full = await user();
    await db.query('INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,$2,10)', [
      full.id,
      quotaDay(),
    ]);
    const second = randomUUID();
    await db.query(
      "INSERT INTO schedules(id,user_id,title,prompt,next_run_at) VALUES($1,$2,$3,$4,now()-interval '1 second')",
      [second, full.id, '额度耗尽测试', '整理今日安排'],
    );
    await activateSchedules(db, ops);
    assert.equal(await count('operations', 'user_id=$1', [full.id]), 0);
    assert.equal(await count('notifications', 'user_id=$1', [full.id]), 1);
  });
  const service = await createApp(config, db);
  app = service.app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const register = async (name: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name, email: `api-${randomUUID()}@nota.test`, password: 'fixture-password-123' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return { user: r.json().user, cookie: r.headers['set-cookie'].split(';')[0] };
  };
  const a = await register('用户甲'),
    b = await register('用户乙');
  const request = (who: any, method: any, url: string, payload?: any) =>
    app.inject({ method, url, headers: { cookie: who.cookie }, payload });
  let recordingId: string, operationId: string;
  await check(
    'API authentication, origin checks, upload idempotency and private byte ranges',
    async () => {
      assert.equal((await app.inject({ url: '/api/bootstrap' })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/chat',
            headers: { cookie: a.cookie, origin: 'https://attacker.invalid' },
            payload: { text: 'bad', idempotency_key: randomUUID() },
          })
        ).statusCode,
        403,
      );
      const key = randomUUID();
      const upload = async () => {
        const form = new FormData();
        form.set('idempotency_key', key);
        form.set('title', '仅甲可见的录音');
        form.set('file', new Blob([new Uint8Array(wav())], { type: 'audio/wav' }), 'fixture.wav');
        const res = await fetch(`${base}/api/recordings`, {
          method: 'POST',
          headers: { cookie: a.cookie },
          body: form,
        });
        const body = (await res.json()) as any;
        assert.equal(res.status, 200, JSON.stringify(body));
        return body;
      };
      const first = await upload(),
        second = await upload();
      recordingId = first.id;
      operationId = first.operation_id;
      assert.equal(first.id, second.id);
      assert.equal(await count('recordings', 'user_id=$1', [a.user.id]), 1);
      const range = await app.inject({
        url: `/api/recordings/${recordingId}/audio`,
        headers: { cookie: a.cookie, range: 'bytes=0-15' },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.rawPayload.length, 16);
      assert.equal(range.rawPayload.toString('ascii', 0, 4), 'RIFF');
    },
  );
  await check(
    'A/B isolation covers files, objects, context, search, events and mutations',
    async () => {
      const todo = (await request(a, 'POST', '/api/todos', { title: '甲的保密待办' })).json();
      for (const path of [
        `/api/recordings/${recordingId}`,
        `/api/recordings/${recordingId}/audio`,
        `/api/operations/${operationId}`,
      ])
        assert.equal((await request(b, 'GET', path)).statusCode, 404, path);
      assert.equal(
        (await request(b, 'PATCH', `/api/todos/${todo.id}`, { status: 'done' })).statusCode,
        404,
      );
      assert.equal(
        (
          await request(b, 'POST', '/api/calendar', {
            title: '越权关联',
            starts_at: '2026-11-20T15:00:00+08:00',
            ends_at: '2026-11-20T16:00:00+08:00',
            recording_id: recordingId,
          })
        ).statusCode,
        404,
      );
      const found = (await request(b, 'GET', '/api/search?q=甲')).json();
      assert.equal(found.recordings.length, 0);
      assert.equal(found.messages.length, 0);
      assert.equal((await request(b, 'GET', '/api/todos')).json().todos.length, 0);
      const dir = resolve(config.DATA_DIR, 'sessions', a.user.id);
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'fixture.jsonl');
      await writeFile(
        path,
        JSON.stringify({
          type: 'message',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'PRIVATE_INTERNAL_CONTENT' },
              { type: 'text', text: '甲的可见输出' },
            ],
          },
        }) + '\n',
      );
      await db.query('UPDATE bot_state SET session_path=$2 WHERE user_id=$1', [a.user.id, path]);
      assert.ok((await request(a, 'GET', '/api/context/history')).body.includes('甲的可见输出'));
      assert.ok(
        !(await request(a, 'GET', '/api/context/history')).body.includes(
          'PRIVATE_INTERNAL_CONTENT',
        ),
      );
      assert.equal((await request(b, 'GET', '/api/context/history')).json().entries.length, 0);
      await emit(db, a.user.id, 'fixture', { marker: 'A_SECRET_EVENT' });
      const cursor = await emit(db, b.user.id, 'fixture', { marker: 'B_VISIBLE_EVENT' });
      const control = new AbortController();
      const response = await fetch(`${base}/api/events?after=0`, {
        headers: { cookie: b.cookie },
        signal: control.signal,
      });
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('B_VISIBLE_EVENT')) {
        const chunk = await reader.read();
        text += new TextDecoder().decode(chunk.value);
        if (text.length > 100000) throw new Error('unexpected event volume');
      }
      control.abort();
      assert.ok(!text.includes('A_SECRET_EVENT'));
      const second = new AbortController();
      const resumed = await fetch(`${base}/api/events?after=0`, {
        headers: { cookie: b.cookie, 'Last-Event-ID': String(cursor) },
        signal: second.signal,
      });
      const resumedReader = resumed.body!.getReader();
      await emit(db, b.user.id, 'fixture', { marker: 'B_NEW_EVENT' });
      let text2 = '';
      while (!text2.includes('B_NEW_EVENT')) {
        const chunk = await resumedReader.read();
        text2 += new TextDecoder().decode(chunk.value);
      }
      second.abort();
      assert.ok(!text2.includes('B_VISIBLE_EVENT'));
    },
  );
  await check(
    'Transcript edits preserve source versions and reject editing an active job',
    async () => {
      const blocked = await request(a, 'PATCH', `/api/recordings/${recordingId}`, {
        transcript: '应当等待当前任务结束',
      });
      assert.equal(blocked.statusCode, 409);
      await db.tx(async (c) => {
        await c.query("UPDATE operations SET status='failed' WHERE id=$1", [operationId]);
        await ops.settle(c, a.user.id, operationId, 'released');
      });
      const original = '王经理说，星河项目报价是12.8万元。';
      assert.equal(
        (await request(a, 'PATCH', `/api/recordings/${recordingId}`, { transcript: original }))
          .statusCode,
        200,
      );
      const run = await running(a.user.id);
      const fact = await run.tools
        .find((t) => t.name === 'remember_fact')!
        .execute('source-version', {
          recording_id: recordingId,
          person_name: '王经理',
          subject: '星河项目',
          predicate: '报价',
          value: '12.8万元',
          evidence: original,
        });
      const commit = await run.tools
        .find((t) => t.name === 'remember_fact')!
        .execute('commit-source-version', {
          proposal_id: fact.details.proposal_id,
          action: 'ADD',
          target_ids: [],
          classification: 'durable',
          evidence_supported: true,
          reason: 'Explicit sourced statement',
        });
      assert.equal((commit.details as any).fact.recording_version, 1);
      assert.equal(
        (
          await request(a, 'PATCH', `/api/recordings/${recordingId}`, {
            transcript: '修订为12.9万元。',
          })
        ).statusCode,
        200,
      );
      const prior = (await request(a, 'GET', `/api/recordings/${recordingId}/revisions/1`)).json();
      assert.equal(prior.revision.transcript, original);
      assert.equal(
        (await request(b, 'GET', `/api/recordings/${recordingId}/revisions/1`)).statusCode,
        404,
      );
      assert.equal(
        (await request(a, 'GET', `/api/recordings/${recordingId}`)).json().recording.version,
        2,
      );
    },
  );
  await check(
    'Retired voice APIs are absent; legacy notes keep source text across API and tools',
    async () => {
      for (const [method, path] of [
        ['GET', '/api/voices'],
        ['POST', '/api/voices'],
        ['POST', '/api/voices/from-recording'],
        ['GET', `/api/voices/${randomUUID()}/audio`],
        ['DELETE', `/api/voices/${randomUUID()}`],
      ])
        assert.equal(
          (await request(a, method, path, method === 'POST' ? {} : undefined)).statusCode,
          404,
        );
      assert.ok(!('diarization' in (await request(a, 'GET', '/api/me')).json().capabilities));
      const metadata = [
        {
          start: 0,
          end: 2,
          text: '我记得项目报价。',
          speaker: 'retired-label',
          is_self: true,
          person_id: randomUUID(),
          identity_source: 'reference_audio',
        },
      ];
      await db.query('UPDATE recordings SET segments=$2 WHERE id=$1', [
        recordingId,
        JSON.stringify(metadata),
      ]);
      await db.query(
        'UPDATE recording_revisions SET segments=$2 WHERE recording_id=$1 AND version=1',
        [recordingId, JSON.stringify(metadata)],
      );
      const detail = (await request(a, 'GET', `/api/recordings/${recordingId}`)).json().recording;
      assert.ok(!('diarize' in detail));
      assert.deepEqual(detail.segments, [{ start: 0, end: 2, text: '我记得项目报价。' }]);
      assert.deepEqual(
        (await request(a, 'GET', `/api/recordings/${recordingId}/revisions/1`)).json().revision
          .segments,
        detail.segments,
      );
      const r = await running(a.user.id);
      const read = await r.tools
        .find((t) => t.name === 'read_recording')!
        .execute('legacy-source-read', { recording_id: recordingId });
      assert.deepEqual((read.details as any).segments, detail.segments);
      const found = await r.tools
        .find((t) => t.name === 'search_history')!
        .execute('legacy-source-search', { query: '修订为12.9万元' });
      assert.deepEqual((found.details as any).recordings[0].segments, detail.segments);
      assert.deepEqual(
        (await db.query('SELECT segments FROM recordings WHERE id=$1', [recordingId])).rows[0]
          .segments,
        metadata,
      );
      assert.equal(
        (await db.query("SELECT to_regclass('public.voice_profiles') AS retired")).rows[0].retired,
        null,
      );
      const columns = (
        await db.query(
          "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='recordings' AND column_name='diarize') OR (table_name='people' AND column_name='is_self'))",
        )
      ).rows;
      assert.equal(columns.length, 0);
    },
  );
  await check('Clarification continues the same operation and reservation', async () => {
    const u = await user(),
      op = await ops.create(u.id, 'clarification-fixture', 'chat', { text: '安排见面' });
    await db.query("UPDATE operations SET status='waiting' WHERE id=$1", [op.id]);
    await ops.continue(u.id, op.id, '11月20日15点到16点');
    assert.equal(await count('operations', 'user_id=$1', [u.id]), 1);
    assert.equal((await ops.usage(u.id)).reserved, 1);
    await assert.rejects(
      () => ops.continue(u.id, op.id, '重复答复'),
      (e: any) => e.status === 409,
    );
  });
  await check(
    'Demo billing has no charge; signed webhooks are idempotent and ordered',
    async () => {
      const res = (await request(b, 'POST', '/api/billing/demo-upgrade')).json();
      assert.equal(res.charged, false);
      assert.equal(await isPro(db, b.user.id), true);
      await request(b, 'POST', '/api/billing/cancel');
      assert.equal(await isPro(db, b.user.id), true);
      const secret = 'integration-webhook-secret';
      const billing = new Billing(db, {
        ...config,
        BILLING_MODE: 'webhook',
        PAYMENT_WEBHOOK_SECRET: secret,
      });
      const body = {
        id: 'merchant-event-001',
        user_id: b.user.id,
        version: 100,
        plan: 'pro',
        status: 'active',
        period_end: new Date(Date.now() + 864e5).toISOString(),
        cancel_at_period_end: false,
        subscription_ref: 'sub-fixture',
      };
      const send = async (payload: object) => {
        const raw = Buffer.from(JSON.stringify(payload)),
          t = Math.floor(Date.now() / 1000),
          sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
        return billing.webhook(raw, sig);
      };
      assert.equal(((await send(body)) as any).applied, true);
      assert.equal(((await send(body)) as any).replayed, true);
      assert.equal(
        ((await send({ ...body, id: 'older-event', version: 99, plan: 'free' })) as any).applied,
        false,
      );
      assert.equal(await isPro(db, b.user.id), true);
      await assert.rejects(
        () => billing.webhook(Buffer.from('{}'), 'invalid'),
        (e: any) => e.status === 401,
      );
    },
  );
  await check(
    'External triggers authenticate, deduplicate, and stay in their owner account',
    async () => {
      const token = (await request(a, 'POST', '/api/triggers', { name: 'fixture-trigger' })).json();
      const fire = (text = '外部事件') =>
        app.inject({
          method: 'POST',
          url: '/api/triggers/fire',
          headers: { authorization: `Bearer ${token.token}` },
          payload: { text, event_id: 'external-event-001' },
        });
      const first = (await fire()).json(),
        second = (await fire()).json();
      assert.equal(first.id, second.id);
      assert.equal((await request(b, 'GET', `/api/operations/${first.id}`)).statusCode, 404);
      await request(a, 'DELETE', `/api/triggers/${token.id}`);
      assert.equal((await fire()).statusCode, 401);
    },
  );
  await check(
    'Personal memo ASR uses plain transcription even for a legacy capture flag',
    async () => {
      const bodies: string[] = [];
      const upstream = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk.toString('latin1');
        bodies.push(body);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            text: '我刚和王经理聊完，记得发送方案。',
            segments: [{ speaker: 'retired-label', start: 0, end: 2, text: '不应传播身份标签' }],
          }),
        );
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      try {
        const address = upstream.address() as any;
        const c = {
          ...config,
          OPENAI_BASE_URL: 'http://127.0.0.1:' + address.port,
          OPENAI_API_KEY: 'controlled-test-key',
        };
        const storage = new Storage(c),
          audio = await storage.put(a.user.id, 'asr.wav', wav(3));
        const asr = new Transcriber(c, storage);
        for (const legacy of [false, true]) {
          const result = await asr.transcribe(
            { storage_key: audio.key, mime: audio.mime, filename: 'asr.wav', diarize: legacy },
            new AbortController().signal,
          );
          assert.equal(result.text, '我刚和王经理聊完，记得发送方案。');
          assert.deepEqual(result.segments, []);
          assert.equal(result.model, config.ASR_MODEL);
        }
        assert.equal(bodies.length, 2);
        for (const body of bodies) {
          assert.ok(body.includes('name="file"'));
          assert.ok(body.includes(config.ASR_MODEL));
          assert.ok(!body.includes('diarized_json'));
          assert.ok(!body.includes('known_speaker'));
        }
      } finally {
        await new Promise<void>((r) => upstream.close(() => r()));
      }
    },
  );
  await check(
    'Durable text/tool process restores per delivery, isolates owners, and preserves clarification quota',
    async () => {
      const owner = await register('过程记录验收');
      const operation = await ops.create(owner.user.id, randomUUID(), 'chat', {
        text: '记录待办并确认时间',
      });
      const driver = new Runtime(db, config);
      await driver.queue.start();
      driver.agent.run = async (ctx) => {
        const text = async (value: string) => {
          ctx.currentTurnId = randomUUID();
          await emit(
            db,
            ctx.userId,
            'text_reset',
            { cycle: ctx.cycle, turn_id: ctx.currentTurnId },
            ctx.operationId,
          );
          await emit(
            db,
            ctx.userId,
            'text',
            { cycle: ctx.cycle, turn_id: ctx.currentTurnId, delta: value },
            ctx.operationId,
          );
          await emit(
            db,
            ctx.userId,
            'text_end',
            { cycle: ctx.cycle, turn_id: ctx.currentTurnId },
            ctx.operationId,
          );
        };
        const tools = buildTools(ctx);
        if (ctx.cycle === 0) {
          await text('先保存明确的待办，再确认碰面时间。');
          await tools
            .find((t) => t.name === 'create_todo')!
            .execute('process-create', { title: '整理需求附件' });
          await tools
            .find((t) => t.name === 'ask_user')!
            .execute('process-question', { question: '碰面安排在什么时候？' });
          await text('碰面安排在什么时候？');
          return {
            text: '碰面安排在什么时候？',
            usage: 2,
            sessionPath: null,
            waiting: ctx.waiting,
          };
        }
        await text('已收到补充，现在查询日程。');
        await tools
          .find((t) => t.name === 'get_agenda')!
          .execute('process-agenda', {
            from: '2026-11-20T00:00:00+08:00',
            to: '2026-11-21T00:00:00+08:00',
          });
        await text('已查询日程，待办已保留。');
        return {
          text: '已查询日程，待办已保留。',
          usage: 2,
          sessionPath: null,
          waiting: undefined,
        };
      };
      try {
        await driver.processUser(owner.user.id);
        const first = (await request(owner, 'GET', '/api/messages'))
          .json()
          .messages.find((m: any) => m.role === 'assistant');
        assert.equal(first.process.cycle, 0);
        assert.equal(first.process.tools, 2);
        assert.equal(first.process.notes, 1);
        const firstProcess = (
          await request(
            owner,
            'GET',
            `/api/operations/${operation.id}/process?message_id=${first.id}`,
          )
        ).json().process;
        assert.deepEqual(
          firstProcess.entries.map((e: any) => e.kind),
          ['text', 'tool', 'tool', 'text'],
        );
        assert.equal(firstProcess.entries[0].text, '先保存明确的待办，再确认碰面时间。');
        assert.equal(firstProcess.finalTurnId, firstProcess.entries.at(-1).id);
        assert.equal(
          (await request(b, 'GET', `/api/operations/${operation.id}/process`)).statusCode,
          404,
        );
        assert.equal((await ops.usage(owner.user.id)).reserved, 1);
        await ops.continue(owner.user.id, operation.id, '十一月二十日下午三点');
        await driver.processUser(owner.user.id);
        const messages = (await request(owner, 'GET', '/api/messages'))
          .json()
          .messages.filter((m: any) => m.role === 'assistant');
        assert.deepEqual(
          messages.map((m: any) => m.process_cycle),
          [0, 1],
        );
        const old = (
          await request(
            owner,
            'GET',
            `/api/operations/${operation.id}/process?message_id=${first.id}`,
          )
        ).json().process;
        assert.deepEqual(old, firstProcess);
        const second = await readExecutionProcess(
          db,
          owner.user.id,
          (await db.query('SELECT * FROM operations WHERE id=$1', [operation.id])).rows[0],
          { messageId: messages[1].id },
        );
        assert.equal(second.cycle, 1);
        assert.equal((second.entries[0] as any).text, '已收到补充，现在查询日程。');
        assert.ok(!JSON.stringify(second.entries).includes('先保存明确的待办'));
        const delivery = (
          await db.query(
            "SELECT data FROM user_events WHERE operation_id=$1 AND type='operation' AND data->>'status'='succeeded' ORDER BY id DESC LIMIT 1",
            [operation.id],
          )
        ).rows[0].data;
        assert.equal(delivery.message.id, messages[1].id);
        assert.equal(delivery.message.content, '已查询日程，待办已保留。');
        assert.equal((await ops.usage(owner.user.id)).used, 1);
        assert.equal((await ops.usage(owner.user.id)).reserved, 0);
      } finally {
        await driver.stop();
      }
    },
  );
  await check(
    'Worker restart recovers expired operations and reuses completed receipts',
    async () => {
      runtime = new Runtime(db, config);
      await runtime.queue.start();
      const u = await user(),
        op = await ops.create(u.id, 'worker-resume-fixture', 'chat', { text: '创建待办' });
      let invocations = 0;
      runtime.agent.run = async (ctx) => {
        invocations++;
        const t = buildTools(ctx).find((t) => t.name === 'create_todo')!;
        await t.execute(`call-${invocations}`, { title: '重启也只创建一次' });
        if (invocations === 1) throw new Error('fixture provider connection reset');
        return { text: '受控执行完成', usage: 10, sessionPath: null, waiting: undefined };
      };
      await runtime.processUser(u.id);
      assert.equal(
        (await db.query('SELECT status FROM operations WHERE id=$1', [op.id])).rows[0].status,
        'queued',
      );
      await db.query(
        "UPDATE operations SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",
        [op.id, randomUUID()],
      );
      await runtime.tick();
      assert.equal(
        (await db.query('SELECT status FROM operations WHERE id=$1', [op.id])).rows[0].status,
        'queued',
      );
      await runtime.processUser(u.id);
      const final = (await db.query('SELECT status FROM operations WHERE id=$1', [op.id])).rows[0];
      assert.equal(final.status, 'succeeded');
      assert.equal(await count('todos', 'user_id=$1', [u.id]), 1);
      assert.equal((await ops.usage(u.id)).used, 1);
      assert.equal((await ops.usage(u.id)).reserved, 0);
    },
  );
  await check(
    'User actor locks serialize one user while allowing two users concurrently',
    async () => {
      const a = await user(),
        b = await user();
      for (const u of [a, b])
        for (let i = 0; i < 3; i++)
          await ops.create(u.id, `actor-operation-${i}`, 'chat', { text: 'fixture' });
      const active = new Map<string, number>();
      let maxPerUser = 0,
        maxAll = 0,
        all = 0;
      runtime!.agent.run = async (ctx) => {
        active.set(ctx.userId, (active.get(ctx.userId) ?? 0) + 1);
        all++;
        maxAll = Math.max(maxAll, all);
        maxPerUser = Math.max(maxPerUser, active.get(ctx.userId)!);
        await new Promise((r) => setTimeout(r, 100));
        active.set(ctx.userId, active.get(ctx.userId)! - 1);
        all--;
        return { text: 'fixture actor response', usage: 1, sessionPath: null, waiting: undefined };
      };
      await Promise.all([
        runtime!.processUser(a.id),
        runtime!.processUser(a.id),
        runtime!.processUser(b.id),
        runtime!.processUser(b.id),
      ]);
      assert.equal(maxPerUser, 1);
      assert.equal(maxAll, 2);
    },
  );
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/integration.json',
    JSON.stringify(
      { at: new Date().toISOString(), database: 'isolated temporary PostgreSQL database', results },
      null,
      2,
    ),
  );
  console.log(`${results.length} integration scenarios passed`);
} finally {
  if (runtime) await runtime.stop();
  if (app) await app.close();
  await fixture.close();
}
