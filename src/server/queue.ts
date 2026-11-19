import { PgBoss } from 'pg-boss';
import type { Config } from './config.js';
import { safeError } from './config.js';
export class Queue {
  readonly boss: PgBoss;
  constructor(readonly config: Config) {
    this.boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: 'nota_jobs' });
    this.boss.on('error', (e) => console.error('queue:', safeError(e, config)));
  }
  async start() {
    await this.boss.start();
    await this.boss.createQueue('nota-user', {
      retryLimit: 0,
      expireInSeconds: this.config.MAX_RUN_SECONDS + 90,
      retentionSeconds: 86400,
    });
    for (const name of ['nota-recording', 'nota-index', 'nota-background', 'nota-memory'])
      await this.boss.createQueue(name, {
        retryLimit: 0,
        expireInSeconds: this.config.MAX_RUN_SECONDS + 90,
        retentionSeconds: 86400,
      });
  }
  async send(userId: string) {
    return this.boss.send('nota-user', { userId }, { singletonKey: userId, retryLimit: 0 });
  }
  async work(fn: (userId: string) => Promise<void>) {
    await this.boss.work<{ userId: string }>(
      'nota-user',
      { localConcurrency: this.config.WORKER_CONCURRENCY, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await fn(job.data.userId);
      },
    );
  }
  async sendFile(id: string, index = false) {
    return this.boss.send(
      index ? 'nota-index' : 'nota-recording',
      { id },
      { singletonKey: id, retryLimit: 0 },
    );
  }
  async sendBackground(id: string) {
    return this.boss.send('nota-background', { id }, { singletonKey: id, retryLimit: 0 });
  }
  async workBackground(fn: (id: string) => Promise<void>) {
    await this.boss.work<{ id: string }>(
      'nota-background',
      { localConcurrency: this.config.BACKGROUND_WORKER_CONCURRENCY, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await fn(job.data.id);
      },
    );
  }
  async workFiles(fn: (id: string) => Promise<void>, index = false) {
    await this.boss.work<{ id: string }>(
      index ? 'nota-index' : 'nota-recording',
      { localConcurrency: this.config.FILE_WORKER_CONCURRENCY, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await fn(job.data.id);
      },
    );
  }
  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10000 });
  }
  async sendMemory(id: string) {
    return this.boss.send('nota-memory', { id }, { singletonKey: id, retryLimit: 0 });
  }
  async workMemory(fn: (id: string) => Promise<void>) {
    await this.boss.work<{ id: string }>(
      'nota-memory',
      { localConcurrency: this.config.FILE_WORKER_CONCURRENCY, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await fn(job.data.id);
      },
    );
  }
}
