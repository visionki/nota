import { NOTE_INSTRUCTION, plainTranscriptSegments } from '../shared/notes.js';
import { publicMessage, publicMessages, readExecutionProcess } from './execution.js';
import { conversationRead, markConversationRead, messagePage } from './conversation.js';
import { notifications as listNotifications, resolveNotifications } from './notifications.js';
import {
  backgroundTask,
  listBackgroundTasks,
  operationDestination,
  operationState,
} from './task-view.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { Db, AppError, emit, owned } from './db.js';
import type { Config } from './config.js';
import { safeError } from './config.js';
import { Auth, digest } from './auth.js';
import { Operations, isPro, quotaDay } from './quota.js';
import { Storage } from './storage.js';
import { Billing } from './billing.js';
import { joinWindow, windowResults, revisePendingItem } from './recording-windows.js';
import { Embeddings, enqueueIndex, readSource } from './sources.js';
import { MemoryService } from './memory.js';
import {
  agenda,
  ics,
  searchHistory,
  createTodo,
  createEvent,
  createArrangement,
  createReminder,
  createSchedule,
  updateTodo,
  updateEvent,
  getEvent,
  getTodo,
  listTodos,
  updateReminder,
  cancelReminder,
  validTimezone,
} from './domain.js';
declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string; timezone: string } | null;
  }
}
const authBody = z.object({ email: z.email().max(200), password: z.string().min(8).max(128) });
const uuid = (value: unknown) => z.uuid().parse(value);
const deterministicId = (s: string) => {
  const h = digest(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export async function createApp(config: Config, db = new Db(config)) {
  const app = Fastify({
    logger: false,
    trustProxy: (_address, hop) => hop === 0,
    bodyLimit: 1024 * 1024,
    requestTimeout: 180000,
  });
  const auth = new Auth(db),
    ops = new Operations(db, config),
    storage = new Storage(config),
    billing = new Billing(db, config);
  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(rateLimit, { max: 300, timeWindow: 60000 });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 },
  });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      .header('Permissions-Policy', 'microphone=(self)')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      const allowed = new Set([new URL(config.APP_URL).origin]);
      if (config.NODE_ENV !== 'production')
        for (const host of ['localhost', '127.0.0.1'])
          for (const port of [3031, 5179, 8088]) allowed.add(`http://${host}:${port}`);
      if (!allowed.has(req.headers.origin)) throw new AppError(403, '请求来源不被允许', 'csrf');
    }
    const publicRoute = [
      '/api/health',
      '/api/auth/login',
      '/api/auth/register',
      '/api/billing/webhook',
      '/api/triggers/fire',
    ].includes(req.url.split('?')[0]);
    if (!req.url.startsWith('/api/') || publicRoute) return;
    const signed = req.cookies.nota_session;
    const token = signed ? req.unsignCookie(signed) : null;
    req.user = await auth.resolve(token?.valid ? token.value : undefined);
    if (!req.user) throw new AppError(401, '请先登录', 'unauthorized');
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof z.ZodError)
      return reply.code(400).send({
        error: '输入内容不符合要求',
        code: 'validation_error',
        details: e.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    if (e.code === '23505')
      return reply
        .code(409)
        .send({ error: '存在相同名称或标识的内容，请检查后重试', code: 'conflict' });
    if (e.code === '23503' || e.code === '23514')
      return reply
        .code(400)
        .send({ error: '关联内容或数据范围不符合要求', code: 'invalid_reference' });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply
        .code(413)
        .send({ error: `录音不能超过 ${config.MAX_UPLOAD_MB} MB`, code: 'file_too_large' });
    const status =
      e instanceof AppError
        ? e.status
        : e.statusCode >= 400 && e.statusCode < 500
          ? e.statusCode
          : 500;
    if (status === 500) console.error('api:', safeError(e, config));
    return reply.code(status).send({
      error: status === 500 ? '服务暂时无法处理，请稍后重试' : safeError(e, config),
      code: e instanceof AppError ? e.code : 'request_error',
    });
  });
  const setSession = async (reply: any, u: any) => {
    const token = await auth.session(u.id);
    reply.setCookie('nota_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(config.APP_URL).protocol === 'https:',
      path: '/',
      signed: true,
      maxAge: 30 * 86400,
    });
    return { user: u };
  };
  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    const r = await db.query(
      "SELECT role FROM worker_heartbeats WHERE at>now()-interval '30 seconds'",
    );
    return {
      ok: true,
      workerReady: r.rows.some((x) => ['all', 'agent'].includes(x.role)),
      fileWorkerReady: r.rows.some((x) => ['all', 'files'].includes(x.role)),
      backgroundWorkerReady: r.rows.some((x) => ['all', 'tasks'].includes(x.role)),
    };
  });
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: 600000 } } },
    async (req, reply) => {
      if (!config.ALLOW_REGISTRATION) throw new AppError(403, '暂未开放注册');
      const a = authBody.extend({ name: z.string().trim().min(1).max(60) }).parse(req.body);
      return setSession(reply, await auth.register(a.email, a.name, a.password));
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: 600000 } } },
    async (req, reply) => {
      const a = authBody.parse(req.body);
      return setSession(reply, await auth.login(a.email, a.password));
    },
  );
  app.post('/api/auth/logout', async (req, reply) => {
    const c = req.cookies.nota_session;
    const signed = c ? req.unsignCookie(c) : null;
    await auth.logout(signed?.valid ? signed.value : undefined);
    reply.clearCookie('nota_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({
    user: req.user,
    capabilities: {
      asrConfigured: !!config.OPENAI_API_KEY,
      asrModel: config.ASR_MODEL,
      agentConfigured: !!config.GMI_API_KEY,
      maxUploadMB: config.MAX_UPLOAD_MB,
      maxAudioSeconds: config.MAX_AUDIO_SECONDS,
      billingMode: config.BILLING_MODE,
    },
  }));
  app.patch('/api/me', async (req) => {
    const a = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        timezone: z.string().optional(),
      })
      .parse(req.body);
    if (a.timezone) validTimezone(a.timezone);
    const r = await db.query(
      'UPDATE users SET name=coalesce($2,name),timezone=coalesce($3,timezone) WHERE id=$1 RETURNING id,name,email,timezone',
      [req.user!.id, a.name ?? null, a.timezone ?? null],
    );
    return { user: r.rows[0] };
  });
  app.get('/api/usage', async (req) => ops.usage(req.user!.id));
  app.get('/api/bootstrap', async (req) =>
    db.tx(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const u = req.user!.id;
      const [messages, operations, notifications, counts, eventCursor, context, usage] =
        await Promise.all([
          messagePage(c, u, { limit: 100 }),
          c.query(
            "SELECT id,kind,executor,status,stage,reply,last_error,attempts,usage_tokens,created_at,updated_at,input FROM operations WHERE user_id=$1 AND executor='agent' ORDER BY updated_at DESC,created_at DESC LIMIT 60",
            [u],
          ),
          c.query(
            'SELECT * FROM notifications WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 50',
            [u],
          ),
          c.query(
            "SELECT (SELECT count(*)::int FROM recordings WHERE user_id=$1) AS recordings,(SELECT count(*)::int FROM todos WHERE user_id=$1 AND status='open') AS todos,(SELECT count(*)::int FROM people WHERE user_id=$1) AS people,(SELECT count(*)::int FROM notifications WHERE user_id=$1 AND read_at IS NULL AND archived_at IS NULL) AS unread",
            [u],
          ),
          c.query('SELECT coalesce(max(id),0)::text AS cursor FROM user_events WHERE user_id=$1', [
            u,
          ]),
          c.query('SELECT compactions,context_tokens,updated_at FROM bot_state WHERE user_id=$1', [
            u,
          ]),
          ops.usage(u, c),
        ]);
      return {
        user: req.user,
        recording_batches: (
          await c.query(
            "SELECT b.*,count(i.operation_id)::int AS total,count(*) FILTER(WHERE i.state='pending')::int AS pending,count(*) FILTER(WHERE i.state='ready')::int AS ready,count(*) FILTER(WHERE i.state='failed')::int AS failed FROM recording_batches b JOIN recording_batch_items i ON i.batch_id=b.id AND i.user_id=b.user_id WHERE b.user_id=$1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 20",
            [u],
          )
        ).rows,
        pending_inputs: (
          await c.query(
            "SELECT i.id,i.operation_id,i.content,i.input_version,i.created_at FROM chat_inputs i JOIN operations o ON o.id=i.operation_id AND o.user_id=i.user_id WHERE i.user_id=$1 AND i.kind='steering' AND i.status='pending' AND o.status IN ('queued','running') ORDER BY i.created_at LIMIT 50",
            [u],
          )
        ).rows,
        messages: await publicMessages(c, u, messages.rows),
        has_older_messages: messages.has_before,
        read_state: await conversationRead(c, u),
        operations: operations.rows,
        notifications: notifications.rows,
        counts: counts.rows[0],
        cursor: eventCursor.rows[0].cursor,
        context: {
          ...context.rows[0],
          contextWindow: config.LLM_CONTEXT_WINDOW,
          compactAt: Math.floor(config.LLM_CONTEXT_WINDOW * config.LLM_COMPACT_RATIO),
        },
        usage,
      };
    }),
  );
  app.get('/api/messages', async (req) => {
    const a = z
      .object({
        before: z
          .string()
          .regex(/^[1-9]\d{0,18}$/)
          .optional(),
        after: z
          .string()
          .regex(/^[1-9]\d{0,18}$/)
          .optional(),
        around: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        q: z.string().max(200).optional(),
      })
      .refine(
        (a) => [a.before, a.after, a.around].filter(Boolean).length <= 1,
        '只能选择一个消息位置',
      )
      .parse(req.query);
    const page = await messagePage(db, req.user!.id, a);
    return {
      messages: await publicMessages(db, req.user!.id, page.rows),
      has_before: page.has_before,
      has_after: page.has_after,
    };
  });
  app.post('/api/chat/read', async (req) => {
    const a = z.object({ message_id: z.uuid() }).parse(req.body);
    return { read_state: await markConversationRead(db, req.user!.id, a.message_id) };
  });
  app.post('/api/chat', async (req) => {
    const a = z
      .object({
        text: z.string().trim().min(1).max(20000),
        idempotency_key: z.string().min(8).max(160),
        mode: z.enum(['steer', 'queue']).default('steer'),
        target_operation_id: z.uuid().optional(),
      })
      .parse(req.body);
    return ops.submit(req.user!.id, a.idempotency_key, a.text, {
      mode: a.mode,
      targetId: a.target_operation_id,
    });
  });
  app.get('/api/background-tasks', async (req) => {
    const query = z
      .object({
        scope: z.enum(['current', 'history', 'all']).default('current'),
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    return listBackgroundTasks(db, req.user!.id, query);
  });
  app.get('/api/background-tasks/:id', async (req) =>
    backgroundTask(db, req.user!.id, uuid((req.params as any).id)),
  );
  app.get('/api/operations/:id/destination', async (req) => ({
    destination: await operationDestination(db, req.user!.id, uuid((req.params as any).id)),
  }));
  app.get('/api/operations/:id/state', async (req) => ({
    operation: await operationState(db, req.user!.id, uuid((req.params as any).id)),
  }));
  app.get('/api/operations', async (req) => ({
    operations: (
      await db.query(
        'SELECT id,kind,executor,status,stage,reply,last_error,attempts,usage_tokens,created_at,updated_at,input FROM operations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
        [req.user!.id],
      )
    ).rows,
  }));
  app.get('/api/operations/:id', async (req) => {
    const { id } = req.params as any;
    const op = await owned(db, 'operations', uuid(id), req.user!.id);
    const calls = (
      await db.query(
        'SELECT id,attempt,name,label,input,status,result,error,started_at,finished_at FROM tool_calls WHERE operation_id=$1 AND user_id=$2 ORDER BY started_at',
        [id, req.user!.id],
      )
    ).rows;
    const { lease_token, lease_until, session_path, payload_hash, ...safe } = op;
    const batch =
      op.executor === 'recording'
        ? (
            await db.query(
              'SELECT b.id,b.state,b.agent_operation_id FROM recording_batch_items i JOIN recording_batches b ON b.id=i.batch_id AND b.user_id=i.user_id WHERE i.operation_id=$1 AND i.user_id=$2 ORDER BY i.created_at DESC LIMIT 1',
              [id, req.user!.id],
            )
          ).rows[0]
        : undefined;
    return { operation: safe, tools: calls, ...(batch ? { batch } : {}) };
  });
  app.get('/api/operations/:id/process', async (req) => {
    const operation = await owned(db, 'operations', uuid((req.params as any).id), req.user!.id);
    const selection = z
      .object({ cycle: z.coerce.number().int().min(0).optional(), message_id: z.uuid().optional() })
      .parse(req.query);
    return {
      process: await readExecutionProcess(db, req.user!.id, operation, {
        cycle: selection.cycle,
        messageId: selection.message_id,
      }),
    };
  });
  app.post('/api/operations/:id/continue', async (req) => {
    const { id } = req.params as any;
    const a = z.object({ text: z.string().trim().min(1).max(10000) }).parse(req.body);
    return ops.continue(req.user!.id, uuid(id), a.text);
  });
  app.post('/api/operations/:id/cancel', async (req) =>
    ops.cancel(req.user!.id, uuid((req.params as any).id)),
  );
  app.post('/api/operations/:id/retry', async (req) =>
    db.tx(async (c) => {
      const u = req.user!.id,
        id = uuid((req.params as any).id);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,711))', [u]);
      const old = (
        await c.query('SELECT * FROM operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, u])
      ).rows[0];
      if (!old) throw new AppError(404, '任务不存在');
      if (['queued', 'running'].includes(old.status))
        return { id, status: old.status, replayed: true };
      if (old.status !== 'failed') throw new AppError(409, '只能重试失败的任务');
      await resolveNotifications(c, u, id);
      if (['background_result', 'background_followup'].includes(old.input.source)) {
        await c.query(
          "UPDATE operations SET status='queued',stage='recovering',cycle_attempts=0,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
          [id, u],
        );
        if (old.input.source === 'background_result')
          await c.query(
            "UPDATE agent_inbox SET status='pending' WHERE operation_id=$1 AND user_id=$2",
            [id, u],
          );
        await emit(c, u, 'operation', { id, executor: 'agent', status: 'queued' }, id);
        return { id, status: 'queued' };
      }
      if (old.input.batch_id) {
        const roots = (
          await c.query(
            "SELECT q.operation_id FROM quota_reservations q JOIN recording_batch_items i ON i.operation_id=q.operation_id AND i.user_id=q.user_id WHERE i.batch_id=$1 AND i.user_id=$2 AND i.state='ready' AND q.status='released'",
            [old.input.batch_id, u],
          )
        ).rows;
        const day = quotaDay();
        await c.query(
          'INSERT INTO quota_buckets(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [u, day],
        );
        const quota = (
          await c.query(
            'SELECT * FROM quota_buckets WHERE user_id=$1 AND quota_day=$2 FOR UPDATE',
            [u, day],
          )
        ).rows[0];
        if (
          !(await isPro(c, u, config.BILLING_MODE)) &&
          quota.used + quota.reserved + roots.length > config.FREE_DAILY_LIMIT
        )
          throw new AppError(429, '免费额度不足以重试这个整理窗口', 'quota_exhausted');
        for (const root of roots)
          await c.query(
            "UPDATE quota_reservations SET quota_day=$2,status='reserved',settled_at=NULL WHERE operation_id=$1",
            [root.operation_id, day],
          );
        await c.query(
          'UPDATE quota_buckets SET reserved=reserved+$3 WHERE user_id=$1 AND quota_day=$2',
          [u, day, roots.length],
        );
        await c.query(
          "UPDATE operations SET status='queued',stage='recovering',cycle_attempts=0,last_error=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
        await c.query(
          "UPDATE agent_inbox SET status='pending' WHERE operation_id=$1 AND user_id=$2",
          [id, u],
        );
        await emit(c, u, 'operation', { id, status: 'queued' }, id);
        return { id, status: 'queued' };
      }
      const day = quotaDay();
      await c.query(
        'INSERT INTO quota_buckets(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [u, day],
      );
      const q = (
        await c.query('SELECT * FROM quota_buckets WHERE user_id=$1 AND quota_day=$2 FOR UPDATE', [
          u,
          day,
        ])
      ).rows[0];
      if (
        !(await isPro(c, u, config.BILLING_MODE)) &&
        q.used + q.reserved >= config.FREE_DAILY_LIMIT
      )
        throw new AppError(429, '今日免费额度已用完', 'quota_exhausted');
      const reserved = await c.query(
        "UPDATE quota_reservations SET quota_day=$3,status='reserved',settled_at=NULL WHERE operation_id=$1 AND user_id=$2 AND status='released' RETURNING operation_id",
        [id, u, day],
      );
      if (reserved.rows[0])
        await c.query(
          'UPDATE quota_buckets SET reserved=reserved+1 WHERE user_id=$1 AND quota_day=$2',
          [u, day],
        );
      await c.query(
        "UPDATE operations SET status='queued',stage='recovering',cycle_attempts=0,last_error=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      if (old.executor === 'recording') await joinWindow(c, u, id, old.input.recording_id);
      await emit(c, u, 'operation', { id, status: 'queued' }, id);
      return { id, status: 'queued' };
    }),
  );
  async function audioResponse(req: any, reply: any, path: string, mime: string) {
    const info = await stat(path);
    const range = req.headers.range;
    reply.type(mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-store');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) throw new AppError(416, '音频范围无效');
      let start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
      let end = m[1]
        ? m[2]
          ? Math.min(Number(m[2]), info.size - 1)
          : info.size - 1
        : info.size - 1;
      if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= info.size) {
        reply.header('Content-Range', `bytes */${info.size}`);
        throw new AppError(416, '音频范围无效');
      }
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${info.size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(path, { start, end }));
    }
    return reply.header('Content-Length', info.size).send(createReadStream(path));
  }
  async function parseUpload(req: any) {
    let file: Buffer | undefined,
      filename = '',
      fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        filename = part.filename;
        file = await part.toBuffer();
        if (part.file.truncated) throw new AppError(413, '音频文件过大');
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw new AppError(400, '请上传录音文件');
    return { file, filename, fields };
  }
  app.post('/api/recordings', async (req) => {
    const { file, filename, fields } = await parseUpload(req);
    const u = req.user!.id;
    const a = z
      .object({
        idempotency_key: z.string().min(8).max(160),
        title: z.string().trim().max(200).default('新录音'),
        instruction: z.string().max(3000).default(NOTE_INSTRUCTION),
        recorded_at: z.string().datetime({ offset: true }).optional(),
        recorded_timezone: z.string().max(100).optional(),
      })
      .parse(fields);
    if (a.recorded_timezone) validTimezone(a.recorded_timezone);
    if (a.recorded_at && Date.parse(a.recorded_at) > Date.now() + 300000)
      throw new AppError(400, '录制时间不能晚于当前时间');
    const recordId = deterministicId(`${u}:${a.idempotency_key}`);
    const audio = await storage.put(u, filename, file);
    try {
      const result = await db.tx(async (c) => {
        const op = await ops.create(
          u,
          a.idempotency_key,
          'recording',
          {
            recording_id: recordId,
            content_hash: digest(file.toString('base64')),
            title: a.title,
            instruction: a.instruction,
            source: 'web_upload',
            ...(a.recorded_at
              ? {
                  recorded_at: a.recorded_at,
                  recorded_timezone: a.recorded_timezone ?? req.user!.timezone,
                }
              : {}),
          },
          c,
        );
        if (op.replayed) {
          const recording = await owned(c, 'recordings', recordId, u);
          return { id: recordId, operation_id: op.id, status: recording.status, replayed: true };
        }
        const pending = op.status === 'waiting';
        await c.query(
          'INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            recordId,
            u,
            op.id,
            a.title || '新录音',
            audio.key,
            filename,
            audio.mime,
            audio.size,
            audio.duration,
            pending ? 'pending' : 'uploaded',
          ],
        );
        await c.query(
          'UPDATE recordings SET recorded_at=$3,recorded_timezone=$4,recording_time_source=$5 WHERE id=$1 AND user_id=$2',
          [
            recordId,
            u,
            a.recorded_at ?? null,
            a.recorded_timezone ?? req.user!.timezone,
            a.recorded_at ? 'provided' : 'unknown',
          ],
        );
        const batchId = pending ? null : await joinWindow(c, u, op.id, recordId);
        await emit(c, u, 'changed', { entity: 'recording', id: recordId }, op.id);
        return {
          id: recordId,
          operation_id: op.id,
          batch_id: batchId,
          status: pending ? 'pending' : 'uploaded',
          replayed: false,
        };
      });
      if (result.replayed) await storage.remove(audio.key);
      return result;
    } catch (e) {
      await storage.remove(audio.key);
      throw e;
    }
  });
  app.get('/api/recordings', async (req) => {
    const a = z
      .object({
        q: z.string().max(200).default(''),
        before: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const r = await db.query(
      'SELECT id,operation_id,batch_id,title,filename,mime,size_bytes,duration_seconds,status,left(transcript,180) AS excerpt,left(summary,600) AS summary,version,last_error,recorded_at,recorded_timezone,recording_time_source,created_at FROM recordings WHERE user_id=$1 AND (title ILIKE $2 OR transcript ILIKE $2) AND ($3::timestamptz IS NULL OR created_at<$3) ORDER BY created_at DESC LIMIT 100',
      [req.user!.id, `%${a.q}%`, a.before ?? null],
    );
    return { recordings: r.rows };
  });
  app.get('/api/recordings/:id', async (req) => {
    const r = await owned(db, 'recordings', uuid((req.params as any).id), req.user!.id);
    const { storage_key, diarize: retiredOption, ...safe } = r;
    safe.segments = plainTranscriptSegments(safe.segments);
    const revisions = (
      await db.query(
        'SELECT id,version,source,created_at FROM recording_revisions WHERE recording_id=$1 AND user_id=$2 ORDER BY version DESC',
        [r.id, req.user!.id],
      )
    ).rows;
    const batch = (
      await db.query(
        'SELECT b.agent_operation_id,o.status FROM recording_batches b JOIN operations o ON o.id=b.agent_operation_id AND o.user_id=b.user_id WHERE b.id=$1 AND b.user_id=$2',
        [r.batch_id, req.user!.id],
      )
    ).rows[0];
    return {
      recording: {
        ...safe,
        agent_operation_id: batch?.agent_operation_id ?? null,
        retry_operation_id: batch?.status === 'failed' ? batch.agent_operation_id : r.operation_id,
      },
      revisions,
    };
  });
  app.get('/api/recordings/:id/audio', async (req, reply) => {
    const r = await owned(db, 'recordings', uuid((req.params as any).id), req.user!.id);
    return audioResponse(req, reply, storage.path(r.storage_key), r.mime);
  });
  app.get('/api/recordings/:id/revisions/:version', async (req) => {
    const a = req.params as any;
    const r = await db.query(
      'SELECT version,transcript,segments,source,created_at FROM recording_revisions WHERE recording_id=$1 AND user_id=$2 AND version=$3',
      [uuid(a.id), req.user!.id, z.coerce.number().int().positive().parse(a.version)],
    );
    if (!r.rows[0]) throw new AppError(404, '该版本不存在');
    return { revision: { ...r.rows[0], segments: plainTranscriptSegments(r.rows[0].segments) } };
  });
  app.patch('/api/recordings/:id', async (req) => {
    const id = uuid((req.params as any).id),
      u = req.user!.id;
    const a = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        transcript: z.string().max(200000).optional(),
      })
      .strict()
      .parse(req.body);
    return db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,711))', [u]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,713))', [u]);
      const current = await owned(c, 'recordings', id, u);
      const busy = (
        await c.query(
          "SELECT 1 FROM operations WHERE user_id=$2 AND status IN ('queued','running') AND (id=$1 OR id IN (SELECT b.agent_operation_id FROM recording_batch_items i JOIN recording_batches b ON b.id=i.batch_id AND b.user_id=i.user_id WHERE i.operation_id=$1 AND i.user_id=$2))",
          [current.operation_id, u],
        )
      ).rows[0];
      if (busy) throw new AppError(409, '录音正在处理中，请等待本轮完成后再修订');
      const r = await c.query(
        "UPDATE recordings SET title=coalesce($3,title),transcript=coalesce($4,transcript),summary=CASE WHEN $4::text IS NULL THEN summary ELSE '' END,segments=CASE WHEN $4::text IS NULL THEN segments ELSE jsonb_build_array() END,version=version+CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,title,version",
        [id, u, a.title ?? null, a.transcript ?? null],
      );
      if (a.transcript !== undefined)
        await c.query(
          "INSERT INTO recording_revisions(id,recording_id,user_id,version,transcript,segments,source) SELECT $1,id,user_id,version,transcript,segments,'user_edit' FROM recordings WHERE id=$2 AND user_id=$3",
          [randomUUID(), id, u],
        );
      if (a.transcript !== undefined) {
        const requeued = await revisePendingItem(c, u, current.operation_id);
        if (!requeued) await enqueueIndex(c, u, 'recording', id, r.rows[0].version);
      }
      await emit(c, u, 'changed', { entity: 'recording', id });
      return { recording: r.rows[0] };
    });
  });
  app.get('/api/agenda', async (req) => {
    const a = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .parse(req.query);
    return agenda(db, req.user!.id, a.from, a.to);
  });
  app.get('/api/calendar.ics', async (req, reply) => {
    const rows = (
      await db.query(
        "SELECT * FROM calendar_events WHERE user_id=$1 AND status='confirmed' ORDER BY starts_at LIMIT 1000",
        [req.user!.id],
      )
    ).rows;
    return reply
      .type('text/calendar; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="nota-calendar.ics"')
      .send(
        ics(
          rows,
          await listTodos(db, req.user!.id),
          (
            await db.query(
              "SELECT * FROM reminders WHERE user_id=$1 AND status='scheduled' ORDER BY remind_at",
              [req.user!.id],
            )
          ).rows,
        ),
      );
  });
  app.get('/api/todos', async (req) => ({ todos: await listTodos(db, req.user!.id) }));
  app.get('/api/todos/:id', async (req) => getTodo(db, req.user!.id, uuid((req.params as any).id)));
  app.post('/api/todos', async (req) => db.tx((c) => createTodo(c, req.user!.id, req.body)));
  app.patch('/api/todos/:id', async (req) =>
    db.tx((c) => updateTodo(c, req.user!.id, uuid((req.params as any).id), req.body)),
  );
  app.post('/api/calendar', async (req) => db.tx((c) => createEvent(c, req.user!.id, req.body)));
  app.get('/api/calendar/:id', async (req) =>
    getEvent(db, req.user!.id, uuid((req.params as any).id)),
  );
  app.post('/api/arrangements', async (req) =>
    db.tx((c) => createArrangement(c, req.user!.id, req.body)),
  );
  app.patch('/api/calendar/:id', async (req) =>
    db.tx((c) => updateEvent(c, req.user!.id, uuid((req.params as any).id), req.body)),
  );
  app.delete('/api/calendar/:id', async (req) =>
    db.tx((c) =>
      updateEvent(c, req.user!.id, uuid((req.params as any).id), { status: 'cancelled' }),
    ),
  );
  app.post('/api/reminders', async (req) =>
    db.tx((c) => createReminder(c, req.user!.id, req.body)),
  );
  app.get('/api/reminders/:id', async (req) =>
    owned(db, 'reminders', uuid((req.params as any).id), req.user!.id),
  );
  app.patch('/api/reminders/:id', async (req) =>
    db.tx((c) => updateReminder(c, req.user!.id, uuid((req.params as any).id), req.body)),
  );
  app.delete('/api/reminders/:id', async (req) =>
    db.tx((c) => cancelReminder(c, req.user!.id, uuid((req.params as any).id))),
  );
  app.get('/api/people', async (req) => ({
    people: (
      await db.query(
        "SELECT p.id,p.user_id,p.name,p.aliases,p.organization,p.role,p.created_at,(SELECT count(*)::int FROM facts f WHERE f.user_id=p.user_id AND f.person_id=p.id AND f.status=$2 AND f.purpose NOT IN ('business','transient') AND f.tier<>'archive' AND (f.expires_at IS NULL OR f.expires_at>now())) AS facts_count FROM people p WHERE p.user_id=$1 ORDER BY name",
        [req.user!.id, 'active'],
      )
    ).rows,
  }));
  app.patch('/api/people/:id', async (req) => {
    const a = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        aliases: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        organization: z.string().max(200).optional(),
        role: z.string().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    const id = uuid((req.params as any).id),
      u = req.user!.id;
    return db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,714))', [u]);
      const old = await owned(c, 'people', id, u);
      const r = await c.query(
        'UPDATE people SET name=$3,aliases=$4,organization=$5,role=$6,identity_confirmed=true WHERE id=$1 AND user_id=$2 RETURNING *',
        [
          id,
          u,
          a.name ?? old.name,
          a.aliases ?? old.aliases,
          a.organization ?? old.organization,
          a.role ?? old.role,
        ],
      );
      await c.query('INSERT INTO memory_events(user_id,action,details) VALUES($1,$2,$3)', [
        u,
        'EDIT_PERSON',
        JSON.stringify({ person_id: id, before: old, after: r.rows[0] }),
      ]);
      await emit(c, u, 'changed', { entity: 'person', id });
      return { person: r.rows[0] };
    });
  });
  app.get('/api/facts', async (req) => {
    const a = z
      .object({
        person_id: z.uuid().optional(),
        q: z.string().max(200).default(''),
        mode: z.enum(['current', 'history', 'timeline']).default('current'),
      })
      .parse(req.query);
    return {
      facts: await new MemoryService().list(db, req.user!.id, {
        query: a.q,
        person_id: a.person_id,
        mode: a.mode,
      }),
    };
  });
  app.get(
    '/api/memory/status',
    async (req) =>
      (
        await db.query(
          `SELECT count(*) FILTER(WHERE j.status IN ('queued','running'))::int AS pending,
     count(*) FILTER(WHERE j.status='failed')::int AS failed,
     max(j.updated_at) FILTER(WHERE j.status='succeeded') AS last_completed_at
     FROM memory_jobs j LEFT JOIN bot_state s ON s.user_id=j.user_id
     WHERE j.user_id=$1 AND (j.entrypoint<>'compaction' OR (j.payload->>'memory_epoch')::int=s.memory_epoch)`,
          [req.user!.id],
        )
      ).rows[0],
  );
  app.post('/api/memory/retry', async (req) =>
    db.tx(async (c) => {
      const rows = (
        await c.query(
          `UPDATE memory_jobs j SET status='queued',attempts=0,available_at=now(),last_error=NULL,updated_at=now()
       WHERE j.user_id=$1 AND j.status='failed' AND (j.entrypoint<>'compaction' OR (j.payload->>'memory_epoch')::int=(SELECT memory_epoch FROM bot_state WHERE user_id=$1)) RETURNING id`,
          [req.user!.id],
        )
      ).rows;
      await emit(c, req.user!.id, 'changed', { entity: 'fact' });
      return { queued: rows.length };
    }),
  );
  app.delete('/api/facts/:id', async (req) => {
    const id = uuid((req.params as any).id);
    return db.tx((c) => new MemoryService().forget(c, req.user!.id, id));
  });
  app.patch('/api/facts/:id', async (req) => {
    const a = z.object({ pinned: z.boolean() }).strict().parse(req.body);
    return db.tx((c) =>
      new MemoryService().pin(c, req.user!.id, uuid((req.params as any).id), a.pinned),
    );
  });
  app.post('/api/facts/:id/confirm', async (req) =>
    db.tx((c) => new MemoryService().confirm(c, req.user!.id, uuid((req.params as any).id))),
  );
  app.get('/api/facts/:id/history', async (req) => {
    const id = uuid((req.params as any).id),
      u = req.user!.id;
    const f = (
      await db.query(
        "SELECT slot_key FROM facts WHERE id=$1 AND user_id=$2 AND status<>'retracted'",
        [id, u],
      )
    ).rows[0];
    if (!f) throw new AppError(404, '记忆不存在');
    return {
      evidence: (
        await db.query(
          "SELECT e.* FROM memory_evidence e JOIN facts f ON f.id=e.fact_id AND f.user_id=e.user_id WHERE e.user_id=$1 AND f.slot_key=$2 AND f.status<>'retracted' ORDER BY e.observed_at,e.created_at",
          [u, f.slot_key],
        )
      ).rows,
      events: (
        await db.query(
          'SELECT e.* FROM memory_events e JOIN facts f ON f.id=e.fact_id AND f.user_id=e.user_id WHERE e.user_id=$1 AND f.slot_key=$2 ORDER BY e.id',
          [u, f.slot_key],
        )
      ).rows,
    };
  });
  app.get('/api/search', async (req) => {
    const a = z
      .object({
        q: z.string().max(200).default(''),
        person: z.string().max(100).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        mode: z.enum(['current', 'history', 'timeline']).optional(),
        as_of: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const filters = {
      query: a.q,
      person: a.person,
      from: a.from,
      to: a.to,
      mode: a.mode,
      as_of: a.as_of,
    };
    return {
      ...(await searchHistory(db, req.user!.id, filters)),
      ...(await new Embeddings(config, db).search(req.user!.id, filters.query, filters)),
    };
  });
  app.get('/api/sources/:id', async (req) => {
    const a = z
      .object({
        before: z.coerce.number().int().min(0).max(3).default(1),
        after: z.coerce.number().int().min(0).max(3).default(1),
      })
      .parse(req.query);
    return readSource(db, req.user!.id, uuid((req.params as any).id), a.before, a.after);
  });
  app.get('/api/recording-batches/:id', async (req) => {
    const id = uuid((req.params as any).id),
      userId = req.user!.id;
    const batch = (
      await db.query('SELECT * FROM recording_batches WHERE id=$1 AND user_id=$2', [id, userId])
    ).rows[0];
    if (!batch) throw new AppError(404, '整理窗口不存在');
    return { batch, items: await windowResults(db, userId, id) };
  });
  app.get('/api/memory/candidates', async (req) => ({
    candidates: (
      await db.query(
        "SELECT m.* FROM memory_candidates m LEFT JOIN recordings r ON m.source_kind='recording' AND r.id=m.source_id AND r.user_id=m.user_id WHERE m.user_id=$1 AND m.status IN ('needs_identity','needs_confirmation') AND (m.source_kind='message' OR r.version=m.source_version) AND NOT EXISTS(SELECT 1 FROM memory_source_policies mp WHERE mp.user_id=m.user_id AND mp.source_kind=m.source_kind AND mp.source_id=m.source_id AND NOT mp.allowed) ORDER BY m.created_at DESC LIMIT 100",
        [req.user!.id],
      )
    ).rows,
  }));
  app.post('/api/memory/candidates/:id/resolve', async (req) => {
    const a = z
      .object({
        person_id: z.uuid().optional(),
        new_person: z
          .object({
            name: z.string().trim().min(1).max(100),
            organization: z.string().max(200).default(''),
            role: z.string().max(200).default(''),
          })
          .optional(),
      })
      .refine((a) => !!a.person_id !== !!a.new_person)
      .parse(req.body);
    return db.tx((c) =>
      new MemoryService().resolve(
        c,
        req.user!.id,
        uuid((req.params as any).id),
        a.person_id,
        a.new_person,
      ),
    );
  });
  app.get('/api/notifications', async (req) => ({
    notifications: await listNotifications(db, req.user!.id),
  }));
  app.post('/api/notifications/read', async (req) => {
    const a = z.object({ ids: z.array(z.uuid()).max(100).optional() }).parse(req.body ?? {});
    await db.query(
      'UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND archived_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2))',
      [req.user!.id, a.ids ?? null],
    );
    await emit(db, req.user!.id, 'changed', { entity: 'notification' });
    return { ok: true };
  });
  app.get('/api/schedules', async (req) => ({
    schedules: (
      await db.query('SELECT * FROM schedules WHERE user_id=$1 ORDER BY next_run_at', [
        req.user!.id,
      ])
    ).rows,
  }));
  app.post('/api/schedules', async (req) =>
    db.tx((c) => createSchedule(c, req.user!.id, req.body)),
  );
  app.patch('/api/schedules/:id', async (req) => {
    const a = z
      .object({
        active: z.boolean().optional(),
        notification_policy: z.enum(['always', 'on_change']).optional(),
      })
      .refine((a) => a.active !== undefined || a.notification_policy !== undefined)
      .parse(req.body);
    const id = uuid((req.params as any).id);
    return db.tx(async (c) => {
      await owned(c, 'schedules', id, req.user!.id);
      const r = await c.query(
        'UPDATE schedules SET active=coalesce($3,active),notification_policy=coalesce($4,notification_policy) WHERE id=$1 AND user_id=$2 RETURNING *',
        [id, req.user!.id, a.active ?? null, a.notification_policy ?? null],
      );
      if (a.active === false) await resolveNotifications(c, req.user!.id, id, 'schedule');
      await emit(c, req.user!.id, 'changed', { entity: 'schedule', id });
      return { schedule: r.rows[0] };
    });
  });
  app.get('/api/triggers', async (req) => ({
    tokens: (
      await db.query(
        'SELECT id,name,created_at,last_used_at FROM trigger_tokens WHERE user_id=$1 ORDER BY created_at DESC',
        [req.user!.id],
      )
    ).rows,
  }));
  app.post('/api/triggers', async (req) => {
    const a = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const token = `nota_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await db.query('INSERT INTO trigger_tokens(id,user_id,name,token_hash) VALUES($1,$2,$3,$4)', [
      id,
      req.user!.id,
      a.name,
      digest(token),
    ]);
    return {
      id,
      name: a.name,
      token,
      endpoint: '/api/triggers/fire',
      warning: '此密钥只显示一次；持有者可激活你的 Nota 并消耗你的 AI 额度。',
    };
  });
  app.delete('/api/triggers/:id', async (req) => {
    await db.query('DELETE FROM trigger_tokens WHERE id=$1 AND user_id=$2', [
      uuid((req.params as any).id),
      req.user!.id,
    ]);
    return { ok: true };
  });
  app.post(
    '/api/triggers/fire',
    { config: { rateLimit: { max: 30, timeWindow: 60000 } } },
    async (req) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const t = (
        await db.query('SELECT * FROM trigger_tokens WHERE token_hash=$1', [digest(token)])
      ).rows[0];
      if (!t) throw new AppError(401, '触发器密钥无效');
      const a = z
        .object({ text: z.string().trim().min(1).max(10000), event_id: z.string().min(8).max(100) })
        .parse(req.body);
      const op = await ops.create(t.user_id, `webhook:${t.id}:${a.event_id}`, 'trigger', {
        text: a.text,
        source: 'webhook',
        trigger_name: t.name,
      });
      await db.query('UPDATE trigger_tokens SET last_used_at=now() WHERE id=$1', [t.id]);
      return { id: op.id, status: op.status, replayed: !!op.replayed };
    },
  );
  app.post('/api/billing/demo-upgrade', async (req) => billing.demoUpgrade(req.user!.id));
  app.post('/api/billing/cancel', async (req) => billing.cancel(req.user!.id));
  await app.register(async (sub) => {
    sub.removeContentTypeParser('application/json');
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    sub.post('/api/billing/webhook', async (req) =>
      billing.webhook(req.body as Buffer, req.headers['x-nota-signature'] as string | undefined),
    );
  });
  app.get('/api/context', async (req) => {
    const u = req.user!.id;
    const state = (
      await db.query(
        'SELECT compactions,context_tokens,updated_at FROM bot_state WHERE user_id=$1',
        [u],
      )
    ).rows[0];
    const checkpoints = (
      await db.query(
        'SELECT id,tokens_before,tokens_after,created_at FROM agent_checkpoints WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
        [u],
      )
    ).rows;
    return {
      state,
      checkpoints,
      model: config.GMI_MODEL,
      context_window: config.LLM_CONTEXT_WINDOW,
      compact_at: Math.floor(config.LLM_CONTEXT_WINDOW * config.LLM_COMPACT_RATIO),
      strategy: '累加 SDK 上下文；阈值压缩；原始历史保留并可检索。',
    };
  });
  app.get('/api/context/history', async (req) => {
    const a = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const u = req.user!.id;
    const state = (await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [u]))
      .rows[0];
    const sessionPath = state?.session_path
      ? resolve(config.DATA_DIR, state.session_path.replaceAll('\\', '/'))
      : null;
    if (!sessionPath || !existsSync(sessionPath)) return { entries: [], next: null };
    const base = resolve(config.DATA_DIR, 'sessions', u),
      rel = relative(base, sessionPath);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new AppError(403, '会话文件不属于当前用户');
    const rows = (await readFile(sessionPath, 'utf8')).split('\n').filter(Boolean);
    const entries: any[] = [];
    let index = 0,
      total = 0;
    for (const line of rows) {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== 'message' && e.type !== 'compaction') continue;
      total++;
      if (index++ < a.offset || entries.length >= a.limit) continue;
      if (e.type === 'compaction')
        entries.push({
          type: 'compaction',
          timestamp: e.timestamp,
          summary: e.summary,
          tokensBefore: e.tokensBefore,
        });
      else {
        const m = e.message;
        const content =
          typeof m?.content === 'string'
            ? m.content
            : (m?.content ?? [])
                .filter((p: any) => p.type === 'text' || p.type === 'toolCall')
                .map((p: any) =>
                  p.type === 'text'
                    ? { type: 'text', text: p.text }
                    : { type: 'toolCall', name: p.name, arguments: p.arguments },
                );
        entries.push({
          type: 'message',
          timestamp: e.timestamp,
          role: m?.role,
          toolName: m?.toolName,
          content,
        });
      }
    }
    return {
      entries,
      next: a.offset + a.limit < total ? a.offset + a.limit : null,
      total,
      note: '私有推理不展示；原始用户消息、工具交互与压缩摘要可复查。',
    };
  });
  const connections = new Map<string, number>();
  app.get('/api/events', async (req, reply) => {
    const u = req.user!.id;
    if ((connections.get(u) ?? 0) >= 5) throw new AppError(429, '实时连接过多，请关闭其他页面');
    let cursor = z.coerce
      .bigint()
      .min(0n)
      .parse(req.headers['last-event-id'] ?? (req.query as any).after ?? '0')
      .toString();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': nota connected\n\n');
    connections.set(u, (connections.get(u) ?? 0) + 1);
    let closed = false,
      busy = false,
      lastAuth = Date.now();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      connections.set(u, Math.max(0, (connections.get(u) ?? 1) - 1));
      res.end();
    };
    const poll = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        if (Date.now() - lastAuth > 15000) {
          const signed = req.unsignCookie(req.cookies.nota_session ?? '');
          if (!signed.valid || !(await auth.resolve(signed.value))) {
            close();
            return;
          }
          lastAuth = Date.now();
        }
        const events = (
          await db.query(
            'SELECT id::text,type,operation_id,data,created_at FROM user_events WHERE user_id=$1 AND id>$2 ORDER BY user_events.id LIMIT 200',
            [u, cursor],
          )
        ).rows;
        for (const e of events) {
          if (res.writableLength > 1024 * 1024) {
            close();
            return;
          }
          res.write(`id: ${e.id}\nevent: update\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = e.id;
        }
        if (!events.length) res.write(': heartbeat\n\n');
      } catch {
        close();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void poll(), 800);
    res.on('close', close);
    await poll();
  });
  const web = resolve('dist/web');
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web, prefix: '/', cacheControl: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return { app, db, ops, auth, storage, billing };
}
