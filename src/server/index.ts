import { loadConfig, safeError } from './config.js';
import { createApp } from './app.js';
const config = loadConfig();
const { app, db } = await createApp(config);
await db.migrate();
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`Nota API ready on port ${config.PORT}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(
    sig,
    () =>
      void app
        .close()
        .then(() => db.close())
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(safeError(e, config));
          process.exit(1);
        }),
  );
