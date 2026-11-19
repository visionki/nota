import { loadConfig, safeError } from './config.js';
import { Db } from './db.js';
import { Runtime } from './runtime.js';
const config = loadConfig(),
  db = new Db(config);
await db.migrate();
const runtime = new Runtime(db, config);
await runtime.start();
console.log('Nota worker ready');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
  await db.close();
};
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(
    sig,
    () =>
      void stop()
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(safeError(e, config));
          process.exit(1);
        }),
  );
