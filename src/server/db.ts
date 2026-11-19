import { Pool, types, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
export type Client = Pick<PoolClient, 'query'>;
// A calendar date has no timezone and must never be deserialized as local midnight.
types.setTypeParser(1082, (value) => value);
export class Db {
  pool: Pool;
  constructor(c: Pick<Config, 'DATABASE_URL'>) {
    this.pool = new Pool({
      connectionString: c.DATABASE_URL,
      max: 18,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (e) => console.error('database connection:', e.message));
  }
  query: Pool['query'] = ((...args: any[]) => (this.pool.query as any)(...args)) as Pool['query'];
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(918275421)');
      await c.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      await c.query('INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING');
    });
  }
  async close() {
    await this.pool.end();
  }
}
export async function emit(
  c: Client,
  userId: string,
  type: string,
  data: object = {},
  operationId?: string,
) {
  const { rows } = await c.query(
    'INSERT INTO user_events(user_id,type,data,operation_id) VALUES($1,$2,$3,$4) RETURNING id',
    [userId, type, JSON.stringify(data), operationId ?? null],
  );
  return rows[0].id;
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}
export async function owned(
  c: Client,
  table:
    | 'recordings'
    | 'todos'
    | 'calendar_events'
    | 'reminders'
    | 'people'
    | 'operations'
    | 'schedules',
  id: string,
  userId: string,
) {
  const { rows } = await c.query(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, '内容不存在或无访问权限', 'not_found');
  return rows[0];
}
