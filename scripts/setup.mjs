import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url),
  path = fileURLToPath(new URL('.env', root));
if (existsSync(path)) {
  console.log('.env already exists; preserved.');
  process.exit(0);
}
const password = randomBytes(24).toString('hex');
let env = await readFile(new URL('.env.example', root), 'utf8');
env = env
  .replace('POSTGRES_PASSWORD=CHANGE_ME', `POSTGRES_PASSWORD=${password}`)
  .replace('COOKIE_SECRET=CHANGE_ME', `COOKIE_SECRET=${randomBytes(32).toString('hex')}`)
  .replace(
    'postgresql://nota:CHANGE_ME@127.0.0.1:54330/nota',
    `postgresql://nota:${password}@127.0.0.1:54330/nota`,
  );
await writeFile(path, env, { mode: 0o600, flag: 'wx' });
console.log(
  'Created private .env with random database/cookie secrets. Configure GMI_API_KEY and OPENAI_API_KEY before starting.',
);
