import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/server/config.js';
import { Db } from '../src/server/db.js';
import { Auth } from '../src/server/auth.js';
import { join } from 'node:path';
export async function testDatabase() {
  const source = loadConfig({
    NODE_ENV: 'test',
    OPENAI_API_KEY: '',
    GMI_API_KEY: '',
    TAVILY_API_KEY: '',
    DATA_DIR: '.data/tests',
  });
  const admin = new Db(source);
  const name = `nota_test_${Date.now()}_${process.pid}`;
  if (!/^nota_test_\d+_\d+$/.test(name)) throw new Error('Unsafe test database name');
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source.DATABASE_URL);
  url.pathname = `/${name}`;
  const config = { ...source, DATABASE_URL: url.toString(), DATA_DIR: join(source.DATA_DIR, name) };
  const db = new Db(config);
  await db.migrate();
  const auth = new Auth(db);
  const user = async (name = '测试用户') =>
    auth.register(`test-${randomUUID()}@nota.test`, name, randomUUID());
  return {
    config,
    db,
    auth,
    user,
    async close() {
      await db.close();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    },
  };
}
export function wav(seconds = 3) {
  const rate = 16000,
    samples = Math.floor(rate * seconds),
    bytes = samples * 2,
    b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++)
    b.writeInt16LE(Math.sin((i / rate) * 2 * Math.PI * 220) * 1800, 44 + i * 2);
  return b;
}
