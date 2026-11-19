import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db, AppError, emit } from './db.js';
import type { Config } from './config.js';
export function verifyWebhook(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
) {
  if (!secret || !header) return false;
  const fields = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(fields.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300 || !fields.v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const actual = Buffer.from(fields.v1, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export class Billing {
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {}
  async demoUpgrade(userId: string) {
    if (this.config.BILLING_MODE !== 'demo')
      throw new AppError(503, '当前没有配置支付商户，请配置收款服务后开通');
    return this.db.tx(async (c) => {
      const old = (
        await c.query('SELECT * FROM subscriptions WHERE user_id=$1 FOR UPDATE', [userId])
      ).rows[0];
      if (old.plan === 'pro' && new Date(old.period_end) > new Date())
        return { demo: true, charged: false, subscription: old };
      const end = new Date(Date.now() + 30 * 864e5);
      const r = await c.query(
        "UPDATE subscriptions SET plan='pro',status='active',period_end=$2,cancel_at_period_end=false,provider='demo',version=version+1,updated_at=now() WHERE user_id=$1 RETURNING plan,status,period_end,cancel_at_period_end,provider",
        [userId, end],
      );
      await c.query(
        'INSERT INTO billing_events(id,user_id,provider,event_type,data) VALUES($1,$2,$3,$4,$5)',
        [
          `demo:${randomUUID()}`,
          userId,
          'demo',
          'activated',
          JSON.stringify({ charged: false, period_end: end }),
        ],
      );
      await emit(c, userId, 'changed', { entity: 'subscription' });
      return { demo: true, charged: false, subscription: r.rows[0] };
    });
  }
  async cancel(userId: string) {
    return this.db.tx(async (c) => {
      const r = await c.query(
        "UPDATE subscriptions SET cancel_at_period_end=true,version=version+1,updated_at=now() WHERE user_id=$1 AND plan='pro' RETURNING plan,status,period_end,cancel_at_period_end,provider",
        [userId],
      );
      if (!r.rows[0]) throw new AppError(409, '当前没有有效订阅');
      await emit(c, userId, 'changed', { entity: 'subscription' });
      return { subscription: r.rows[0], message: '已取消续订，本周期权益保留至到期。' };
    });
  }
  async webhook(raw: Buffer, signature?: string) {
    if (this.config.BILLING_MODE !== 'webhook') throw new AppError(404, '支付 Webhook 未启用');
    if (!verifyWebhook(raw, signature, this.config.PAYMENT_WEBHOOK_SECRET))
      throw new AppError(401, '支付回调签名无效');
    let input;
    try {
      input = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, '回调 JSON 无效');
    }
    const a = z
      .object({
        id: z.string().min(1).max(200),
        user_id: z.uuid(),
        version: z.number().int().positive(),
        plan: z.enum(['free', 'pro']),
        status: z.enum(['active', 'trialing', 'inactive', 'past_due', 'cancelled', 'expired']),
        period_end: z.string().datetime({ offset: true }).nullable(),
        cancel_at_period_end: z.boolean().default(false),
        subscription_ref: z.string().max(200),
      })
      .parse(input);
    return this.db.tx(async (c) => {
      await c.query('SELECT user_id FROM subscriptions WHERE user_id=$1 FOR UPDATE', [a.user_id]);
      const inserted = await c.query(
        'INSERT INTO billing_events(id,user_id,provider,event_type,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',
        [a.id, a.user_id, 'webhook', a.status, JSON.stringify(a)],
      );
      if (!inserted.rows[0]) return { ok: true, replayed: true };
      const r = await c.query(
        'UPDATE subscriptions SET plan=$2,status=$3,period_end=$4,cancel_at_period_end=$5,provider=$6,provider_ref=$7,version=$8,updated_at=now() WHERE user_id=$1 AND version<$8 RETURNING user_id',
        [
          a.user_id,
          a.plan,
          a.status,
          a.period_end,
          a.cancel_at_period_end,
          'webhook',
          a.subscription_ref,
          a.version,
        ],
      );
      if (r.rows[0]) await emit(c, a.user_id, 'changed', { entity: 'subscription' });
      return { ok: true, applied: !!r.rows[0] };
    });
  }
}
