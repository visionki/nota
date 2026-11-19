import { loadConfig } from '../src/server/config.js';
import { Db } from '../src/server/db.js';
const db = new Db(loadConfig());
try {
  await db.migrate();
  console.log('Nota schema is ready');
} finally {
  await db.close();
}
