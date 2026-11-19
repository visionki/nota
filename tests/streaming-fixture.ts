/** Controlled model driver; HTTP, SSE, persistence and business tools remain real. */
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { Runtime } from '../src/server/runtime.js';
import { emit } from '../src/server/db.js';
import { buildTools } from '../src/server/tools.js';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
export async function streamingFixture() {
  const fixture = await testDatabase(),
    { db, config } = fixture;
  const gates = { start: gate(), first: gate(), tool: gate(), second: gate(), final: gate() };
  const firstText =
    '我会先把你明确交办的事项保存为待办，再检查接下来的日程。每一步都会保留实际回执，完成后给你简短说明。你可以随时展开工具查看参数和结果，也可以在处理完成后重新展开整个过程，复查中途的说明。';
  const middleText = '待办已经保存。接下来查询日程，核对这两天的安排。';
  const finalText = '已保存待办，并查过接下来两天的安排。';
  const runtime = new Runtime(db, config);
  await runtime.queue.start();
  runtime.agent.run = async (ctx) => {
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
    };
    const end = () =>
      emit(
        db,
        ctx.userId,
        'text_end',
        { cycle: ctx.cycle, turn_id: ctx.currentTurnId },
        ctx.operationId,
      );
    const tools = buildTools(ctx);
    await gates.start.wait;
    await text(firstText);
    await gates.first.wait;
    await end();
    await tools
      .find((t) => t.name === 'create_todo')!
      .execute('controlled-todo', { title: '核对便签交办的事项' });
    await gates.tool.wait;
    await text(middleText);
    await end();
    await tools
      .find((t) => t.name === 'get_agenda')!
      .execute('controlled-agenda', {
        from: new Date().toISOString(),
        to: new Date(Date.now() + 2 * 864e5).toISOString(),
      });
    await gates.second.wait;
    await text(finalText);
    await end();
    await gates.final.wait;
    return { text: finalText, usage: 10, sessionPath: null, waiting: undefined };
  };
  const { app } = await createApp(config, db);
  let run: Promise<void> | undefined;
  app.addHook('onResponse', async (req) => {
    if (req.method === 'POST' && req.url === '/api/chat' && req.user)
      run = runtime.processUser(req.user.id);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  config.APP_URL = base;
  return {
    db,
    base,
    gates,
    firstText,
    middleText,
    finalText,
    async close() {
      for (const gate of Object.values(gates)) gate.open();
      await run;
      await runtime.stop();
      await app.close();
      await fixture.close();
    },
  };
}
