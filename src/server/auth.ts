import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Db, AppError } from './db.js';
const scrypt = promisify(scryptCb);
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, hex] = hash.split(':');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export class Auth {
  constructor(readonly db: Db) {}
  async register(email: string, name: string, password: string) {
    const hash = await hashPassword(password);
    return this.db.tx(async (c) => {
      const id = randomUUID();
      try {
        await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
          id,
          email.toLowerCase(),
          name,
          hash,
        ]);
      } catch (e: any) {
        if (e.code === '23505') throw new AppError(409, '该邮箱已注册');
        throw e;
      }
      await c.query('INSERT INTO subscriptions(user_id) VALUES($1)', [id]);
      await c.query('INSERT INTO bot_state(user_id) VALUES($1)', [id]);
      return { id, email: email.toLowerCase(), name, timezone: 'Asia/Shanghai' };
    });
  }
  async login(email: string, password: string) {
    const r = await this.db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows[0]) {
      await hashPassword(password);
      throw new AppError(401, '邮箱或密码不正确', 'unauthorized');
    }
    const u = r.rows[0];
    if (!(await verifyPassword(password, u.password_hash)))
      throw new AppError(401, '邮箱或密码不正确', 'unauthorized');
    return { id: u.id, email: u.email, name: u.name, timezone: u.timezone };
  }
  async session(userId: string) {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
      [digest(token), userId],
    );
    return token;
  }
  async resolve(token?: string) {
    if (!token) return null;
    const { rows } = await this.db.query(
      'SELECT u.id,u.email,u.name,u.timezone FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [digest(token)],
    );
    return rows[0] ?? null;
  }
  async logout(token?: string) {
    if (token)
      await this.db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(token)]);
  }
}
