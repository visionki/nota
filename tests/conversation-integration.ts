import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { conversationRead } from '../src/server/conversation.js';

const fixture = await testDatabase(),
  { db, config } = fixture;
const { app } = await createApp(config, db);
const results: { name: string; ok: boolean }[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
};
try {
  const register = async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: '阅读进度验收', email: `${randomUUID()}@nota.test`, password: randomUUID() },
    });
    assert.equal(r.statusCode, 200);
    return { id: r.json().user.id, cookie: String(r.headers['set-cookie']).split(';')[0] };
  };
  const owner = await register(),
    other = await register();
  const req = (who: typeof owner, url: string, payload?: any) =>
    app.inject({ method: payload ? 'POST' : 'GET', url, headers: { cookie: who.cookie }, payload });
  const messages: any[] = [];
  await db.tx(async (c) => {
    for (let n = 0; n < 160; n++)
      messages.push(
        (
          await c.query(
            'INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,$3,$4,$5) RETURNING id,seq',
            [
              randomUUID(),
              owner.id,
              n % 2 ? 'assistant' : 'user',
              `历史消息 ${n + 1}`,
              `seed:${n}`,
            ],
          )
        ).rows[0],
      );
  });
  await check(
    'Bootstrap and history reads preserve unread progress and return exact history bounds',
    async () => {
      const boot = (await req(owner, '/api/bootstrap')).json();
      assert.equal(boot.messages.length, 100);
      assert.equal(boot.has_older_messages, true);
      assert.equal(boot.read_state.last_read_seq, '0');
      assert.equal(boot.read_state.unread_count, 80);
      assert.equal(boot.read_state.first_unread_id, messages[1].id);
      const page = (await req(owner, `/api/messages?before=${messages[50].seq}&limit=50`)).json();
      assert.equal(page.messages.length, 50);
      assert.equal(page.has_before, false);
      assert.equal(page.has_after, true);
      assert.equal((await conversationRead(db, owner.id)).last_read_seq, '0');
      const empty = (await req(owner, `/api/messages?before=${messages[0].seq}`)).json();
      assert.deepEqual(empty.messages, []);
      assert.equal(empty.has_before, false);
    },
  );
  await check(
    'Jumping to an unread UUID loads its actual page with no gap to later pages',
    async () => {
      const page = (await req(owner, `/api/messages?around=${messages[1].id}&limit=20`)).json();
      assert.equal(page.messages[1].id, messages[1].id);
      assert.equal(page.has_before, false);
      assert.equal(page.has_after, true);
      const next = (
        await req(owner, `/api/messages?after=${page.messages.at(-1).seq}&limit=20`)
      ).json();
      assert.equal(next.messages[0].id, messages[21].id);
      assert.equal(next.has_before, true);
    },
  );
  await check(
    'Concurrent and repeated read acknowledgements only move one account watermark forward',
    async () => {
      const responses = await Promise.all(
        [79, 11, 139, 31, 99, 139].map((n) =>
          req(owner, '/api/chat/read', { message_id: messages[n].id }),
        ),
      );
      assert(responses.every((r) => r.statusCode === 200));
      const state = await conversationRead(db, owner.id);
      assert.equal(state.last_read_message_id, messages[139].id);
      assert.equal(state.last_read_seq, messages[139].seq);
      assert.equal(state.unread_count, 10);
      assert.equal(state.first_unread_id, messages[141].id);
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM conversation_reads WHERE user_id=$1', [
            owner.id,
          ])
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'Read and jump endpoints reject other accounts, missing messages and mixed pagination',
    async () => {
      assert.equal(
        (await req(other, '/api/chat/read', { message_id: messages[159].id })).statusCode,
        404,
      );
      assert.equal((await req(other, `/api/messages?around=${messages[1].id}`)).statusCode, 404);
      assert.equal(
        (await req(owner, '/api/chat/read', { message_id: randomUUID() })).statusCode,
        404,
      );
      assert.equal((await req(owner, '/api/messages?before=10&after=20')).statusCode, 400);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/chat/read',
            payload: { message_id: messages[0].id },
          })
        ).statusCode,
        401,
      );
      assert.equal((await conversationRead(db, other.id)).last_read_seq, '0');
    },
  );
  await check(
    'Acknowledging a captured message never consumes a later arrival or an AI credit',
    async () => {
      await req(owner, '/api/chat/read', { message_id: messages.at(-1).id });
      const fresh = (
        await db.query(
          "INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,'assistant','trigger','新触发结果','fresh-result') RETURNING id",
          [randomUUID(), owner.id],
        )
      ).rows[0];
      await req(owner, '/api/chat/read', { message_id: messages.at(-1).id });
      const boot = (await req(owner, '/api/bootstrap')).json();
      assert.equal(boot.read_state.unread_count, 1);
      assert.equal(boot.read_state.first_unread_id, fresh.id);
      assert.equal(boot.usage.used, 0);
      assert.equal(boot.usage.reserved, 0);
      assert.equal(boot.operations.length, 0);
    },
  );
} finally {
  await app.close();
  await fixture.close();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/conversation-integration.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
}
