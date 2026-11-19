import { hostname } from 'node:os';
import { loadConfig } from './config.js';
import { Db } from './db.js';
const db = new Db(loadConfig());
try {
  const r = await db.query(
    "SELECT 1 FROM worker_heartbeats WHERE id=$1 AND at>now()-interval '30 seconds'",
    [hostname()],
  );
  if (!r.rows[0]) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await db.close();
}
