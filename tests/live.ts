/** Opt-in acceptance suite. Uses real GMI and official OpenAI APIs and incurs usage. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig, safeError } from '../src/server/config.js';
const config = loadConfig(),
  base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
type Identity = { email: string; password: string; cookie: string; userId: string };
const report: any = {
  at: new Date().toISOString(),
  base,
  models: { agent: config.GMI_MODEL, asr: config.ASR_MODEL },
  audio: 'Windows SAPI synthetic first-person Chinese voice memo',
  checks: [],
};
const day = (offset: number) => {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${local}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const eventDay = day(8),
  priorDay = day(7),
  clarifyDay = day(9);
await mkdir('test-results', { recursive: true });
async function call(
  who: Identity | null,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = who.cookie;
  if (body !== undefined && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json';
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json()) as any;
  if (!r.ok) throw new Error(`${r.status}: ${data.error}`);
  return data;
}
async function register(name: string): Promise<Identity> {
  const email = `live-${Date.now()}-${randomUUID().slice(0, 8)}@nota.local`,
    password = randomBytes(18).toString('base64url');
  const r = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const d = (await r.json()) as any;
  if (!r.ok) throw new Error(JSON.stringify(d));
  return { email, password, cookie: r.headers.get('set-cookie')!.split(';')[0], userId: d.user.id };
}
async function wait(who: Identity, id: string) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const d = await call(who, `/operations/${id}`);
    if (
      d.operation.executor === 'recording' &&
      !['failed', 'cancelled'].includes(d.operation.status)
    ) {
      if (d.batch?.agent_operation_id) id = d.batch.agent_operation_id;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (['succeeded', 'failed', 'cancelled', 'waiting'].includes(d.operation.status)) return d;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`operation ${id} timed out`);
}
async function check(name: string, fn: () => Promise<any>) {
  const at = Date.now();
  try {
    const details = await fn();
    report.checks.push({ name, ok: true, ms: Date.now() - at, details });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, ok: false, ms: Date.now() - at, error: safeError(e, config) });
    throw e;
  } finally {
    await writeFile('test-results/live-report.json', JSON.stringify(report, null, 2));
  }
}
const a = await register('完整链路验收'),
  b = await register('隔离验收');
await writeFile('test-results/live-access.json', JSON.stringify({ ...a, base }, null, 2));
let recording: any, result: any, historyBefore: number;
try {
  await check('Real audio → independent analysis → one sourced GMI Agent delivery', async () => {
    const form = new FormData();
    form.set('idempotency_key', `live-audio-${randomUUID()}`);
    form.set('title', '个人便签 · 星河项目备忘');
    form.set(
      'instruction',
      `请整理我的个人语音便签并执行明确交办。此为固定验收音频，本次待办截止日和评审日统一使用 ${eventDay}（北京时间），其余时刻与提醒提前一天的要求保持原样。保留报价与人物原文证据。`,
    );
    form.set(
      'file',
      new Blob([new Uint8Array(await readFile('tests/fixtures/nota-chinese.wav'))], {
        type: 'audio/wav',
      }),
      'nota-chinese.wav',
    );
    recording = await call(a, '/recordings', form);
    result = await wait(a, recording.operation_id);
    recording.preparation_operation_id = recording.operation_id;
    recording.operation_id = result.operation.id;
    assert.equal(
      result.operation.status,
      'succeeded',
      result.operation.last_error ?? result.operation.reply,
    );
    const names = new Set(
      result.tools.filter((t: any) => t.status === 'succeeded').map((t: any) => t.name),
    );
    for (const name of ['create_todo', 'create_event', 'create_reminder'])
      assert.ok(names.has(name), `Missing tool: ${name}`);
    const rec = (await call(a, `/recordings/${recording.id}`)).recording;
    const response = (await call(a, '/messages')).messages.find(
      (m: any) => m.operation_id === recording.operation_id && m.role === 'assistant',
    );
    assert.ok(response.process?.tools >= 3);
    const process = (
      await call(a, `/operations/${recording.operation_id}/process?message_id=${response.id}`)
    ).process;
    assert.equal(process.finalTurnId, response.process.final_turn_id);
    assert.ok(
      process.entries.some(
        (entry: any) =>
          entry.kind === 'text' &&
          entry.id === process.finalTurnId &&
          entry.text.trim() === result.operation.reply.trim(),
      ),
    );
    assert.match(rec.transcript, /12\.8|十二点八/);
    assert.ok(rec.summary.length > 50);
    const agenda = await call(
      a,
      `/agenda?from=${encodeURIComponent(`${priorDay}T00:00:00+08:00`)}&to=${encodeURIComponent(`${clarifyDay}T23:59:59+08:00`)}`,
    );
    assert.equal(agenda.events.length, 1);
    assert.equal(
      new Date(agenda.events[0].starts_at).toISOString(),
      new Date(`${eventDay}T15:00:00+08:00`).toISOString(),
    );
    assert.equal(
      new Date(agenda.todos[0].due_at).toISOString(),
      new Date(`${eventDay}T10:00:00+08:00`).toISOString(),
    );
    assert.equal(
      new Date(agenda.reminders[0].remind_at).toISOString(),
      new Date(`${priorDay}T15:00:00+08:00`).toISOString(),
    );
    const facts = (await call(a, '/facts')).facts;
    assert.ok(
      facts.some(
        (f: any) =>
          /12\.8|十二点八/.test(f.value) &&
          f.recording_id === recording.id &&
          rec.transcript.includes(f.evidence),
      ),
    );
    historyBefore = (await call(a, '/context/history')).total;
    assert.equal((await call(a, '/usage')).used, 1);
    return {
      recording: recording.id,
      operation: recording.operation_id,
      tools: [...names],
      transcript: rec.transcript,
      event: agenda.events[0].starts_at,
      reminder: agenda.reminders[0].remind_at,
      sourceEvidenceVerified: true,
      publicProcess: {
        tools: response.process.tools,
        notes: response.process.notes,
        finalTurnSeparated: true,
      },
    };
  });
  await check(
    'Persistent SDK conversation grows; history question retrieves and cites recording',
    async () => {
      const op = await call(a, '/chat', {
        text: '我之前记下的星河项目是谁的报价？金额是多少？请检索我的便签确认，并给出便签出处。',
        idempotency_key: randomUUID(),
      });
      const d = await wait(a, op.id);
      assert.equal(d.operation.status, 'succeeded', d.operation.last_error);
      assert.ok(d.tools.some((t: any) => t.name === 'search_history' && t.status === 'succeeded'));
      assert.match(d.operation.reply, /12\.8|十二点八/);
      assert.ok(d.operation.reply.includes(`/recordings/${recording.id}`));
      const after = await call(a, '/context/history');
      assert.ok(after.total > historyBefore);
      const context = await call(a, '/context');
      assert.equal(context.context_window, 1048576);
      return {
        historyBefore,
        historyAfter: after.total,
        window: context.context_window,
        contextEstimate: context.state.context_tokens,
        reply: d.operation.reply,
      };
    },
  );
  await check(
    'Missing time asks for clarification; reply continues the same billed operation',
    async () => {
      const used = (await call(a, '/usage')).used;
      const op = await call(a, '/chat', {
        text: '另外帮我安排一次和李工的碰面，时间还没定。先问我具体时间再创建。',
        idempotency_key: randomUUID(),
      });
      const first = await wait(a, op.id);
      assert.equal(first.operation.status, 'waiting');
      assert.ok(first.tools.some((t: any) => t.name === 'ask_user'));
      assert.equal((await call(a, '/usage')).used, used);
      await call(a, `/operations/${op.id}/continue`, {
        text: `请安排在 ${clarifyDay} 北京时间 14:00 到 15:00，地点线上。`,
      });
      const final = await wait(a, op.id);
      assert.equal(final.operation.status, 'succeeded', final.operation.last_error);
      assert.equal((await call(a, '/usage')).used, used + 1);
      const replies = (await call(a, '/messages')).messages.filter(
        (m: any) => m.operation_id === op.id && m.role === 'assistant',
      );
      assert.deepEqual(
        replies.map((m: any) => m.process_cycle),
        [0, 1],
      );
      return {
        operation: op.id,
        question: first.operation.reply,
        answer: final.operation.reply,
        chargedOnce: true,
      };
    },
  );
  await check('Another user cannot read the recording, tools, or private memory', async () => {
    const denied = await fetch(`${base}/api/recordings/${recording.id}`, {
      headers: { cookie: b.cookie },
    });
    assert.equal(denied.status, 404);
    assert.equal((await call(b, '/search?q=星河')).recordings.length, 0);
    const op = await call(b, '/chat', {
      text: '请搜索我的历史：星河项目的报价是多少？没有依据就明确说没有找到，不要猜。',
      idempotency_key: randomUUID(),
    });
    const d = await wait(b, op.id);
    assert.equal(d.operation.status, 'succeeded', d.operation.last_error);
    assert.ok(!/12\.8/.test(d.operation.reply));
    assert.equal(
      (await call(b, '/context/history')).entries.some((e: any) =>
        JSON.stringify(e).includes(recording.id),
      ),
      false,
    );
    return { fileStatus: denied.status, reply: d.operation.reply };
  });
  await check(
    'A reminder reaches notifications and chat while no browser is connected',
    async () => {
      const before = (await call(a, '/usage')).used;
      const reminder = await call(a, '/reminders', {
        title: '验收到点提醒 · 无需打开页面',
        remind_at: new Date(Date.now() + 4000).toISOString(),
      });
      let found: any;
      const end = Date.now() + 18000;
      while (Date.now() < end) {
        found = (await call(a, '/notifications')).notifications.find(
          (n: any) => n.object_id === reminder.id,
        );
        if (found) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.ok(found);
      assert.ok(
        (await call(a, '/messages')).messages.some(
          (m: any) => m.kind === 'reminder' && m.content.includes(reminder.title),
        ),
      );
      assert.equal((await call(a, '/usage')).used, before);
      return { reminder: reminder.id, delivered: true, aiCharge: 0 };
    },
  );
  await check(
    'External trigger activates the same bot, deduplicates and reports back',
    async () => {
      const token = await call(a, '/triggers', { name: '真实验收触发器' }),
        eventId = randomUUID();
      const fire = async () => {
        const r = await fetch(`${base}/api/triggers/fire`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: eventId,
            text: '这是外部验收事件。请查询我未来两周的日程，简短告诉我有哪些安排，不做新增或修改。',
          }),
        });
        assert.equal(r.status, 200);
        return r.json() as any;
      };
      const first = await fire(),
        second = await fire();
      assert.equal(first.id, second.id);
      const d = await wait(a, first.id);
      assert.equal(d.operation.status, 'succeeded', d.operation.last_error);
      assert.ok(d.tools.some((t: any) => t.name === 'get_agenda'));
      await call(a, `/triggers/${token.id}`, undefined, 'DELETE');
      return { operation: first.id, deduplicated: true, reply: d.operation.reply };
    },
  );
  await check('Personal memo separates my task from a mentioned person’s promise', async () => {
    const before = (await call(a, '/todos')).todos;
    const used = (await call(a, '/usage')).used;
    const text =
      '保存这条个人便签：我刚和陈总聊完，青禾项目报价是8.6万元。陈总答应发送合同，这是他的安排，不用给我创建发送合同的待办。我的待办是核对青禾项目附件，无需截止时间。请把这条消息的项目报价保存为陈总相关的记忆，保留原文证据。';
    const op = await call(a, '/chat', { text, idempotency_key: randomUUID() });
    const d = await wait(a, op.id);
    assert.equal(d.operation.status, 'succeeded', d.operation.last_error ?? d.operation.reply);
    const created = (await call(a, '/todos')).todos.filter(
      (todo: any) => !before.some((old: any) => old.id === todo.id),
    );
    assert.equal(created.length, 1);
    assert.match(created[0].title, /核对.*附件/);
    assert.equal(created[0].due_at, null);
    const facts = (await call(a, '/facts?q=青禾')).facts;
    const quote = facts.find((f: any) => /8\.6|八点六/.test(f.value));
    assert.ok(quote);
    assert.ok(text.includes(quote.evidence));
    assert.equal(quote.recording_id, null);
    assert.ok(quote.message_id);
    assert.equal((await call(a, '/usage')).used, used + 1);
    return {
      todo: created[0].title,
      thirdPartyPromiseNotAssigned: true,
      evidence: quote.evidence,
      reply: d.operation.reply,
    };
  });
  await check(
    'A live GMI task accepts a steering correction without a second operation or charge',
    async () => {
      const before = (await call(a, '/usage')).used;
      const op = await call(a, '/chat', {
        text: `请先查询 ${day(2)} 的安排，再设置当天上午3:00提醒我核对引导验收材料。请直接执行。`,
        mode: 'queue',
        idempotency_key: randomUUID(),
      });
      const deadline = Date.now() + 30000;
      let running = false;
      while (Date.now() < deadline) {
        const state = await call(a, `/operations/${op.id}`);
        if (state.operation.status === 'running' && state.operation.stage === 'agent') {
          running = true;
          break;
        }
        if (['failed', 'succeeded', 'waiting'].includes(state.operation.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(running, true, 'Did not observe an in-flight model turn');
      const correction = await call(a, '/chat', {
        text: '不，改成同一天上午6点吧，只保留一条提醒。',
        mode: 'steer',
        target_operation_id: op.id,
        idempotency_key: randomUUID(),
      });
      assert.equal(correction.id, op.id);
      assert.equal(correction.steered, true);
      const result = await wait(a, op.id);
      assert.equal(
        result.operation.status,
        'succeeded',
        result.operation.last_error ?? result.operation.reply,
      );
      const ids = new Set(
        result.tools
          .filter((tool: any) => tool.name === 'create_reminder' && tool.status === 'succeeded')
          .map((tool: any) => tool.result.id),
      );
      const agenda = await call(
        a,
        `/agenda?from=${encodeURIComponent(day(2) + 'T00:00:00+08:00')}&to=${encodeURIComponent(day(2) + 'T23:59:59+08:00')}`,
      );
      const reminders = agenda.reminders.filter((reminder: any) => ids.has(reminder.id));
      assert.equal(reminders.length, 1);
      assert.equal(
        new Date(reminders[0].remind_at).toISOString(),
        new Date(day(2) + 'T06:00:00+08:00').toISOString(),
      );
      assert.equal((await call(a, '/usage')).used, before + 1);
      assert.equal((await call(a, '/usage')).reserved, 0);
      return {
        operation: op.id,
        steeredIntoSameOperation: true,
        scheduledReminders: 1,
        remindAt: reminders[0].remind_at,
        chargedOnce: true,
        reply: result.operation.reply,
      };
    },
  );
  await check('Demo Pro changes entitlements and cancellation preserves the period', async () => {
    const activation = await call(a, '/billing/demo-upgrade', {});
    assert.equal(activation.charged, false);
    assert.equal((await call(a, '/usage')).pro, true);
    await call(a, '/billing/cancel', {});
    const usage = await call(a, '/usage');
    assert.equal(usage.pro, true);
    assert.equal(usage.subscription.cancel_at_period_end, true);
    return { charged: false, periodEnd: usage.subscription.period_end, cancelAtPeriodEnd: true };
  });
  report.complete = true;
  console.log(`${report.checks.length} real-provider acceptance scenarios passed`);
} catch (e) {
  report.complete = false;
  console.error(safeError(e, config));
  process.exitCode = 1;
} finally {
  await writeFile('test-results/live-report.json', JSON.stringify(report, null, 2));
}
