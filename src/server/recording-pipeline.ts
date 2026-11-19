import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppError, Db, emit, owned, type Client } from './db.js';
import { safeError, type Config } from './config.js';
import { Storage } from './storage.js';
import { Transcriber } from './transcribe.js';
import { RecordingAnalyzer, withEvidence, materialPolicy } from './recording-analysis.js';
import { MemoryService } from './memory.js';
import { MemoryReview } from './memory-review.js';
import { MemoryJobs, enqueueMemoryJob } from './memory-jobs.js';
import {
  Embeddings,
  enqueueIndex,
  saveChunks,
  sourceDocument,
  syncMemoryPolicy,
} from './sources.js';
import { dispatchWindows, finishWindowItem, joinWindow } from './recording-windows.js';
import { Operations } from './quota.js';
import { Queue } from './queue.js';

export class RecordingPipeline {
  readonly transcriber: Transcriber;
  readonly analyzer: RecordingAnalyzer;
  readonly memory = new MemoryService();
  readonly reviewer: MemoryReview;
  readonly memoryJobs: MemoryJobs;
  readonly embeddings: Embeddings;
  readonly ops: Operations;
  private controllers = new Set<AbortController>();
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.transcriber = new Transcriber(config, new Storage(config));
    this.analyzer = new RecordingAnalyzer(config);
    this.embeddings = new Embeddings(config, db);
    this.ops = new Operations(db, config);
    this.reviewer = new MemoryReview(db, config);
    this.memoryJobs = new MemoryJobs(db, config);
  }
  private async commitMemory(
    c: Client,
    userId: string,
    source: any,
    prepared: any,
    reviews?: any[],
  ) {
    if (reviews) {
      await c.query('SAVEPOINT recording_memory');
      try {
        for (const plan of reviews)
          await this.reviewer.apply(c, userId, plan.proposal_id, plan.decision);
        await c.query('RELEASE SAVEPOINT recording_memory');
        delete prepared.memory_error;
        return;
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT recording_memory');
        await c.query('RELEASE SAVEPOINT recording_memory');
        prepared.memory_error = safeError(error, this.config);
      }
    }
    await enqueueMemoryJob(c, userId, 'recording', `recording:${source.id}:${source.version}`, {
      source_id: source.id,
      source_version: source.version,
      items: prepared.facts,
    });
  }
  async tick(queue: Queue) {
    await this.memoryJobs.recover();
    for (const row of (
      await this.db.query(
        "SELECT id FROM memory_jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at LIMIT 30",
      )
    ).rows)
      await queue.sendMemory(row.id);
    const due = (
      await this.db.query(
        "SELECT DISTINCT f.user_id FROM facts f LEFT JOIN memory_maintenance m ON m.user_id=f.user_id WHERE m.last_run_at IS NULL OR m.last_run_at<now()-interval '1 day' LIMIT 20",
      )
    ).rows;
    for (const row of due) await this.db.tx((c) => this.memory.maintain(c, row.user_id));
    await this.ops.resumeRecordings();
    // Adopt only unfinished legacy uploads; historical replies and SDK sessions remain untouched.
    const legacy = (
      await this.db.query(
        "SELECT o.id,o.user_id,o.input->>'recording_id' AS recording_id FROM operations o JOIN recordings r ON r.operation_id=o.id WHERE o.kind='recording' AND o.executor='agent' AND o.status='queued'",
      )
    ).rows;
    for (const op of legacy)
      await this.db.tx(async (c) => {
        await c.query(
          "UPDATE operations SET executor='recording' WHERE id=$1 AND status='queued'",
          [op.id],
        );
        await joinWindow(c, op.user_id, op.id, op.recording_id);
      });
    // Cancellation and lost workers are durable item transitions, even with no browser present.
    const cancelled = (
      await this.db.query(
        "SELECT DISTINCT i.user_id,i.operation_id FROM recording_batch_items i JOIN operations o ON o.id=i.operation_id WHERE i.state='pending' AND o.status='cancelled'",
      )
    ).rows;
    for (const op of cancelled)
      await this.db.tx((c) => finishWindowItem(c, op.user_id, op.operation_id, 'cancelled'));
    await this.db.query(
      "UPDATE source_index_jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()",
    );
    for (const row of (
      await this.db.query(
        "SELECT id FROM operations WHERE executor='recording' AND status='queued' AND (stage<>'retrying' OR updated_at<now()-attempts*interval '3 seconds') ORDER BY created_at LIMIT 100",
      )
    ).rows)
      await queue.sendFile(row.id);
    for (const row of (
      await this.db.query(
        "SELECT id FROM source_index_jobs WHERE status='queued' AND available_at<=now() ORDER BY CASE WHEN stage='backfill' THEN 1 ELSE 0 END,created_at LIMIT 100",
      )
    ).rows)
      await queue.sendFile(row.id, true);
    await dispatchWindows(this.db, this.config.RECORDING_WINDOW_IDLE_MS);
  }
  async fence(c: Client, op: any) {
    if (
      !(
        await c.query(
          "SELECT id FROM operations WHERE id=$1 AND user_id=$2 AND executor='recording' AND status='running' AND lease_token=$3 AND lease_until>now() FOR UPDATE",
          [op.id, op.user_id, op.lease_token],
        )
      ).rowCount
    )
      throw new AppError(409, '文件任务已取消或租约失效', 'lease_lost');
  }
  async process(id: string) {
    const op = await this.db.tx(
      async (c) =>
        (
          await c.query(
            "UPDATE operations SET status='running',stage='transcribing',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_token=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND executor='recording' AND status='queued' RETURNING *",
            [id, randomUUID()],
          )
        ).rows[0],
    );
    if (!op) return;
    const control = new AbortController();
    this.controllers.add(control);
    const timeout = setTimeout(
      () => control.abort(new Error('录音处理超时')),
      this.config.MAX_RUN_SECONDS * 1000,
    );
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          "UPDATE operations SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
          [op.id, op.lease_token],
        )
        .then((r) => {
          if (!r.rowCount) control.abort();
        })
        .catch(() => control.abort());
    }, 5000);
    try {
      let record = await owned(this.db, 'recordings', op.input.recording_id, op.user_id);
      if (!record.transcript) {
        await this.db.tx(async (c) => {
          await this.fence(c, op);
          await c.query(
            "UPDATE recordings SET status='transcribing',last_error=NULL WHERE id=$1 AND user_id=$2",
            [record.id, op.user_id],
          );
          await emit(c, op.user_id, 'changed', { entity: 'recording', id: record.id });
        });
        const transcript = await this.transcriber.transcribe(record, control.signal);
        await this.db.tx(async (c) => {
          await this.fence(c, op);
          await c.query(
            "UPDATE recordings SET transcript=$3,segments=$4,version=version+1,status='organizing',updated_at=now() WHERE id=$1 AND user_id=$2",
            [record.id, op.user_id, transcript.text, JSON.stringify(transcript.segments)],
          );
          await c.query(
            'INSERT INTO recording_revisions(id,recording_id,user_id,version,transcript,segments,source) SELECT $1,id,user_id,version,transcript,segments,$4 FROM recordings WHERE id=$2 AND user_id=$3',
            [randomUUID(), record.id, op.user_id, transcript.model],
          );
        });
        record = await owned(this.db, 'recordings', record.id, op.user_id);
      }
      await this.db.tx(async (c) => {
        await this.fence(c, op);
        await c.query(
          "UPDATE recordings SET status='organizing',last_error=NULL WHERE id=$1 AND user_id=$2",
          [record.id, op.user_id],
        );
        await emit(c, op.user_id, 'changed', { entity: 'recording', id: record.id });
      });
      const source = await sourceDocument(
        this.db,
        op.user_id,
        'recording',
        record.id,
        record.version,
      );
      const chunks = await this.db.tx(async (c) => {
        await this.fence(c, op);
        await syncMemoryPolicy(c, op.user_id, source);
        return saveChunks(c, op.user_id, source);
      });
      await this.db.query(
        "UPDATE operations SET stage='analyzing' WHERE id=$1 AND lease_token=$2",
        [op.id, op.lease_token],
      );
      const existing = (
        await this.db.query(
          'SELECT * FROM recording_artifacts WHERE recording_id=$1 AND recording_version=$2 AND pipeline_version=1',
          [record.id, record.version],
        )
      ).rows[0];
      const policy = materialPolicy(op.input.instruction ?? '');
      const prepared = existing?.payload ?? {
        ...withEvidence(
          source,
          chunks,
          policy.transcribeOnly
            ? { summary: '转写已完成，可查看原文。', facts: [], actions: [], uncertainties: [] }
            : await this.analyzer.analyze(source, op.input.instruction ?? '', control.signal),
        ),
        policy,
      };
      if (!policy.memory) prepared.facts = [];
      let reviews: any[] | undefined;
      try {
        reviews = await this.reviewer.review(
          op.user_id,
          source,
          prepared.facts,
          'recording',
          control.signal,
        );
      } catch (error) {
        prepared.memory_error = safeError(error, this.config);
      }
      await this.db.tx(async (c) => {
        await this.fence(c, op);
        const current = await owned(c, 'recordings', record.id, op.user_id);
        if (current.version !== source.version)
          throw new AppError(409, '原文版本已变化', 'source_changed');
        const artifact =
          existing ??
          (
            await c.query(
              'INSERT INTO recording_artifacts(id,user_id,recording_id,recording_version,summary,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recording_id,recording_version,pipeline_version) DO UPDATE SET recording_id=EXCLUDED.recording_id RETURNING *',
              [
                randomUUID(),
                op.user_id,
                record.id,
                record.version,
                prepared.summary,
                JSON.stringify(prepared),
              ],
            )
          ).rows[0];
        for (let i = 0; i < prepared.actions.length; i++) {
          const action = {
            ...prepared.actions[i],
            execution_allowed:
              policy.kinds[prepared.actions[i].kind as 'todo' | 'event' | 'reminder'],
          };
          await c.query(
            'INSERT INTO candidate_actions(id,user_id,artifact_id,candidate_key,payload,source_refs) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [
              randomUUID(),
              op.user_id,
              artifact.id,
              String(i),
              JSON.stringify(action),
              JSON.stringify(action.source_refs),
            ],
          );
        }
        await this.commitMemory(c, op.user_id, source, prepared, reviews);
        await c.query('UPDATE recording_artifacts SET payload=$3 WHERE id=$1 AND user_id=$2', [
          artifact.id,
          op.user_id,
          JSON.stringify(prepared),
        ]);
        await c.query(
          "UPDATE recordings SET summary=$3,status='prepared',last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
          [record.id, op.user_id, prepared.summary],
        );
        await c.query(
          "UPDATE operations SET status='succeeded',stage='prepared',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1",
          [op.id],
        );
        await enqueueIndex(c, op.user_id, 'recording', record.id, record.version, 'embedding');
        await finishWindowItem(c, op.user_id, op.id, 'ready', artifact.id);
        await emit(c, op.user_id, 'changed', { entity: 'recording', id: record.id });
      });
    } catch (e) {
      const error = safeError(e, this.config);
      await this.db.tx(async (c) => {
        const current = (await c.query('SELECT * FROM operations WHERE id=$1 FOR UPDATE', [op.id]))
          .rows[0];
        if (current.lease_token !== op.lease_token || current.status !== 'running') return;
        const retry =
          current.cycle_attempts < 3 &&
          !['asr_unconfigured', 'source_changed'].includes((e as any).code);
        await c.query(
          'UPDATE operations SET status=$2,stage=$3,lease_token=NULL,lease_until=NULL,last_error=$4,updated_at=now() WHERE id=$1',
          [op.id, retry ? 'queued' : 'failed', retry ? 'retrying' : 'failed', error],
        );
        if (!retry) {
          await this.ops.settle(c, op.user_id, op.id, 'released');
          await finishWindowItem(c, op.user_id, op.id, 'failed', undefined, error);
        }
        await c.query('UPDATE recordings SET status=$3,last_error=$4 WHERE id=$1 AND user_id=$2', [
          op.input.recording_id,
          op.user_id,
          retry ? 'organizing' : 'needs_attention',
          error,
        ]);
        await emit(c, op.user_id, 'changed', { entity: 'recording', id: op.input.recording_id });
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.controllers.delete(control);
    }
  }
  async processIndex(id: string) {
    const job = (
      await this.db.query(
        "UPDATE source_index_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '6 minutes' WHERE id=$1 AND status='queued' RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
    if (!job) return;
    const control = new AbortController();
    this.controllers.add(control);
    const deadline = setTimeout(
      () => control.abort(new Error('索引处理超时')),
      this.config.MAX_RUN_SECONDS * 1000,
    );
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          "UPDATE source_index_jobs SET lease_until=now()+interval '6 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'",
          [job.id, job.lease_token],
        )
        .catch(() => control.abort());
    }, 30000);
    try {
      const source = await sourceDocument(
        this.db,
        job.user_id,
        job.source_kind,
        job.source_id,
        job.source_version,
      );
      const chunks = await this.db.tx(async (c) => {
        if (
          !(
            await c.query(
              "SELECT id FROM source_index_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
              [job.id, job.lease_token],
            )
          ).rowCount
        )
          throw new AppError(409, '索引任务租约已失效', 'lease_lost');
        await syncMemoryPolicy(c, job.user_id, source);
        return saveChunks(c, job.user_id, source);
      });
      // Legacy queued chat jobs must also remain indexing-only after upgrading.
      if (
        job.stage === 'prepare' &&
        source.kind === 'recording' &&
        source.memoryAllowed !== false
      ) {
        const cached = (
          await this.db.query(
            'SELECT payload FROM recording_artifacts WHERE user_id=$1 AND recording_id=$2 AND recording_version=$3',
            [job.user_id, source.id, source.version],
          )
        ).rows[0];
        const prepared =
          cached?.payload ??
          withEvidence(
            source,
            chunks,
            await this.analyzer.analyze(
              source,
              `${source.instruction ?? ''}\n整理来源记忆，遵守这份来源的记忆范围，保留原文证据；这不是新的执行指令。`,
              control.signal,
            ),
          );
        let reviews: any[] | undefined;
        try {
          reviews = await this.reviewer.review(
            job.user_id,
            source,
            prepared.facts,
            'recording',
            control.signal,
          );
        } catch (error) {
          prepared.memory_error = safeError(error, this.config);
        }
        await this.db.tx(async (c) => {
          if (
            !(
              await c.query(
                "SELECT id FROM source_index_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
                [job.id, job.lease_token],
              )
            ).rowCount
          )
            throw new AppError(409, '索引任务租约已失效', 'lease_lost');
          const current = await sourceDocument(c, job.user_id, job.source_kind, job.source_id);
          if (current.version !== source.version) return;
          await this.commitMemory(c, job.user_id, source, prepared, reviews);
          if (source.kind === 'recording') {
            await c.query(
              'INSERT INTO recording_artifacts(id,user_id,recording_id,recording_version,summary,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
              [
                randomUUID(),
                job.user_id,
                source.id,
                source.version,
                prepared.summary,
                JSON.stringify(prepared),
              ],
            );
            await c.query(
              "UPDATE recordings SET summary=$3,status='ready',updated_at=now() WHERE id=$1 AND user_id=$2 AND version=$4",
              [source.id, job.user_id, prepared.summary, source.version],
            );
            await emit(c, job.user_id, 'changed', { entity: 'recording', id: source.id });
          }
          await c.query(
            "UPDATE source_index_jobs SET stage='embedding' WHERE id=$1 AND lease_token=$2",
            [job.id, job.lease_token],
          );
        });
      }
      if (source.kind === 'recording' || job.stage === 'embedding' || job.stage === 'backfill')
        await this.embeddings.index(job.user_id, source, control.signal);
      else
        await this.db.query(
          "UPDATE source_index_jobs SET stage='keyword' WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token],
        );
      await this.db.query(
        "UPDATE source_index_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token],
      );
    } catch (e) {
      await this.db.query(
        "UPDATE source_index_jobs SET status='queued',lease_token=NULL,lease_until=NULL,last_error=$3,available_at=now()+least(3600,power(2,least(attempts,10))::int)*interval '5 seconds' WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, safeError(e, this.config)],
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.controllers.delete(control);
    }
  }
  async backfill() {
    await this.db.query(
      "INSERT INTO source_index_jobs(id,user_id,source_kind,source_id,source_version,stage) SELECT gen_random_uuid(),user_id,'recording',id,version,'backfill' FROM recordings WHERE transcript<>'' AND version>0 ON CONFLICT DO NOTHING",
    );
    await this.db.query(
      "INSERT INTO source_index_jobs(id,user_id,source_kind,source_id,source_version,stage) SELECT gen_random_uuid(),user_id,'message',id,1,'keyword' FROM messages WHERE role='user' AND kind IN ('chat','steering') ON CONFLICT DO NOTHING",
    );
  }
  stop() {
    this.memoryJobs.stop();
    for (const control of this.controllers) control.abort(new Error('服务重启，文件任务将恢复'));
  }
}
