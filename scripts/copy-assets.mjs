import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/server', { recursive: true });
await cp('src/server/schema.sql', 'dist/server/schema.sql');
