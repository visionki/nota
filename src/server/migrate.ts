import { loadConfig } from './config.js';
import { Db } from './db.js';
const db = new Db(loadConfig());
try {
  await db.migrate();
  console.log('Nota schema is ready');
} finally {
  await db.close();
}
