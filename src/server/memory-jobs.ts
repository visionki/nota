import { randomUUID } from 'node:crypto';
import { Db, AppError, emit, type Client } from './db.js';
import { safeError, type Config } from './config.js';
import { MemoryReview, type MemoryProposal } from './memory-review.js';
import { RecordingAnalyzer } from './recording-analysis.js';
import { sourceDocument, saveChunks, evidenceRefs, enqueueIndex } from './sources.js';
import { readInputEnvelope } from './steering.js';

export async function enqueueMemoryJob(
  c: Client,
  userId: string,
  entrypoint: 'recording' | 'compaction' | 'reclassify',
  key: string,
  payload: any,
) {
  return (
    await c.query(
      'INSERT INTO memory_jobs(id,user_id,entrypoint,dedupe_key,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,dedupe_key) DO NOTHING RETURNING id',
      [randomUUID(), userId, entrypoint, key, JSON.stringify(payload)],
    )
  ).rows[0]?.id;
}

/** Reuse SDK boundaries; only the extraction job status is new business state. */
export async function enqueueCompactionMemory(
  c: Client,
  userId: string,
  sessionPath: string,
  branch: any[],
  epoch: number,
) {
  const current = (await c.query('SELECT memory_epoch FROM bot_state WHERE user_id=$1', [userId]))
    .rows[0];
  if (!current || current.memory_epoch !== epoch) return;
  for (let end = 0; end < branch.length; end++) {
    const comp = branch[end];
    if (comp.type !== 'compaction') continue;
    const key = `compaction:${sessionPath}:${comp.id}`;
    if (
      (await c.query('SELECT 1 FROM memory_jobs WHERE user_id=$1 AND dedupe_key=$2', [userId, key]))
        .rowCount
    )
      continue;
    let previous: any;
    for (let i = 0; i < end; i++) if (branch[i].type === 'compaction') previous = branch[i];
    let start = previous ? branch.findIndex((e) => e.id === previous.firstKeptEntryId) : 0;
    if (start < 0) start = branch.findIndex((e) => e.id === previous.id) + 1;
    let cut =
      comp.firstKeptEntryId === comp.id
        ? end
        : branch.findIndex((e) => e.id === comp.firstKeptEntryId);
    if (cut < start || cut > end) throw new AppError(409, 'SDK压缩边界不完整，未猜测抽取范围');
    const ids = new Set<string>();
    for (const entry of branch.slice(start, cut)) {
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const envelope = readInputEnvelope(entry.message.content);
      if (!envelope) continue;
      for (const source of envelope.source_messages ?? []) if (source.id) ids.add(source.id);
      if (envelope.event?.operation_id) {
        const rows = (
          await c.query(
            "SELECT id FROM messages WHERE user_id=$1 AND operation_id=$2 AND role='user' AND content=$3",
            [userId, envelope.event.operation_id, envelope.user_request ?? ''],
          )
        ).rows;
        rows.forEach((r) => ids.add(r.id));
      }
      const inputs = [
        ...(envelope.nota_input ? [envelope.input_id] : []),
        ...(envelope.user_updates ?? []).map((i: any) => i.id),
      ];
      if (inputs.length) {
        const rows = (
          await c.query(
            'SELECT message_id FROM chat_inputs WHERE user_id=$1 AND id=ANY($2::uuid[])',
            [userId, inputs],
          )
        ).rows;
        rows.forEach((r) => ids.add(r.message_id));
      }
    }
    if (!ids.size) continue;
    const sourceIds = (
      await c.query(
        "SELECT id FROM messages m WHERE user_id=$1 AND id=ANY($2::uuid[]) AND role='user' AND NOT EXISTS(SELECT 1 FROM memory_scan_receipts r WHERE r.user_id=m.user_id AND r.message_id=m.id) ORDER BY seq",
        [userId, [...ids]],
      )
    ).rows.map((r) => r.id);
    await enqueueMemoryJob(c, userId, 'compaction', key, {
      session_path: sessionPath,
      compaction_id: comp.id,
      previous_compaction_id: previous?.id ?? null,
      first_kept_entry_id: comp.firstKeptEntryId,
      source_ids: sourceIds,
      memory_epoch: epoch,
    });
  }
}

export class MemoryJobs {
  readonly review: MemoryReview;
  readonly controllers = new Set<AbortController>();
  constructor(
    readonly db: Db,
    readonly config: Config,
  ) {
    this.review = new MemoryReview(db, config);
  }
  async recover() {
    await this.db.query(
      "UPDATE memory_jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<now()",
    );
  }
  async fence(c: Client, job: any) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM memory_jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND status='running' AND lease_until>now() FOR UPDATE",
          [job.id, job.user_id, job.lease_token],
        )
      ).rowCount
    )
      throw new AppError(409, '记忆任务租约失效');
  }

  async process(id: string) {
    const job = (
      await this.db.query(
        "UPDATE memory_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '6 minutes',updated_at=now() WHERE id=$1 AND status='queued' AND available_at<=now() RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
    if (!job) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('记忆任务超时')),
      this.config.MAX_RUN_SECONDS * 1000,
    );
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          "UPDATE memory_jobs SET lease_until=now()+interval '6 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'",
          [job.id, job.lease_token],
        )
        .catch(() => controller.abort());
    }, 30000);
    try {
      let results: any[] = [];
      if (job.entrypoint === 'compaction') results = await this.compaction(job, controller.signal);
      else if (job.entrypoint === 'recording') {
        const source = await sourceDocument(
          this.db,
          job.user_id,
          'recording',
          job.payload.source_id,
          job.payload.source_version,
        );
        const current = await sourceDocument(this.db, job.user_id, 'recording', source.id);
        if (current.version !== source.version) throw new AppError(409, '录音版本已经变化');
        results = await this.runItems(job, source, job.payload.items, controller.signal);
      } else results = await this.reclassify(job, controller.signal);
      await this.db.tx(async (c) => {
        await this.fence(c, job);
        await c.query(
          "UPDATE memory_jobs SET status='succeeded',result=$3,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
          [job.id, job.user_id, JSON.stringify(results)],
        );
        await emit(c, job.user_id, 'changed', { entity: 'fact' });
      });
    } catch (error) {
      const permanent = error instanceof AppError && [400, 403, 404, 409].includes(error.status);
      await this.db.query(
        "UPDATE memory_jobs SET status=$3,last_error=$4,lease_token=NULL,lease_until=NULL,available_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2",
        [
          job.id,
          job.lease_token,
          permanent || job.attempts >= 3 ? 'failed' : 'queued',
          safeError(error, this.config),
        ],
      );
      await this.db.tx((c) => emit(c, job.user_id, 'changed', { entity: 'fact' }));
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.controllers.delete(controller);
    }
  }

  async runItems(job: any, source: any, items: any[], signal: AbortSignal) {
    const plans = await this.review.review(job.user_id, source, items, job.entrypoint, signal);
    return this.db.tx(async (c) => {
      await this.fence(c, job);
      const result = [];
      for (const plan of plans)
        result.push(await this.review.apply(c, job.user_id, plan.proposal_id, plan.decision));
      await emit(c, job.user_id, 'changed', { entity: 'fact' });
      return result;
    });
  }

  async compaction(job: any, signal: AbortSignal) {
    const state = (
      await this.db.query('SELECT memory_epoch FROM bot_state WHERE user_id=$1', [job.user_id])
    ).rows[0];
    if (state?.memory_epoch !== job.payload.memory_epoch)
      throw new AppError(409, '活动上下文已因遗忘而更新，旧任务不再提取');
    const documents = [];
    for (const id of job.payload.source_ids) {
      if (
        (
          await this.db.query(
            'SELECT 1 FROM memory_scan_receipts WHERE user_id=$1 AND message_id=$2',
            [job.user_id, id],
          )
        ).rowCount
      )
        continue;
      const source = await sourceDocument(this.db, job.user_id, 'message', id);
      if (source.memoryAllowed === false) continue;
      const chunks = await saveChunks(this.db, job.user_id, source);
      for (const chunk of chunks)
        documents.push({
          chunk_id: chunk.id,
          source_kind: 'message',
          source_id: id,
          recorded_at: source.recordedAt,
          timezone: source.timezone,
          text: chunk.text,
        });
    }
    let batches: any[][] = [];
    let batch: any[] = [],
      chars = 0;
    for (const part of documents) {
      if (batch.length && (chars + part.text.length > 18000 || batch.length >= 30)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(part);
      chars += part.text.length;
    }
    if (batch.length) batches.push(batch);
    // Freeze chunk boundaries before the first model call. Later successful
    // jobs/policy changes must not shift a resumed cursor to different messages.
    if (job.payload.batch_chunk_ids) {
      batches = [];
      for (const ids of job.payload.batch_chunk_ids) {
        const parts = [];
        for (const id of ids) {
          const chunk = (
            await this.db.query('SELECT * FROM source_chunks WHERE user_id=$1 AND id=$2', [
              job.user_id,
              id,
            ])
          ).rows[0];
          if (!chunk) throw new AppError(409, '压缩任务的原始文段已变化');
          const doc = await sourceDocument(this.db, job.user_id, 'message', chunk.source_id);
          if (doc.memoryAllowed === false) continue;
          parts.push({
            chunk_id: id,
            source_kind: 'message',
            source_id: doc.id,
            recorded_at: doc.recordedAt,
            timezone: doc.timezone,
            text: chunk.text,
          });
        }
        batches.push(parts);
      }
    } else
      await this.db.tx(async (c) => {
        await this.fence(c, job);
        await c.query(
          "UPDATE memory_jobs SET payload=jsonb_set(payload,'{batch_chunk_ids}',$3::jsonb) WHERE id=$1 AND lease_token=$2",
          [
            job.id,
            job.lease_token,
            JSON.stringify(batches.map((parts) => parts.map((p) => p.chunk_id))),
          ],
        );
      });
    const all = job.result ?? [];
    for (let cursor = job.payload.cursor ?? 0; cursor < batches.length; cursor++) {
      if (!batches[cursor].length) {
        await this.db.tx(async (c) => {
          await this.fence(c, job);
          await c.query(
            "UPDATE memory_jobs SET payload=jsonb_set(payload,'{cursor}',to_jsonb($3::int)) WHERE id=$1 AND lease_token=$2",
            [job.id, job.lease_token, cursor + 1],
          );
        });
        continue;
      }
      const first = batches[cursor][0];
      const source = await sourceDocument(this.db, job.user_id, 'message', first.source_id);
      let usage: any = {};
      const tracked = new RecordingAnalyzer(this.config, (u) => {
        usage.prompt_tokens = (usage.prompt_tokens ?? 0) + Number(u.prompt_tokens ?? 0);
        usage.completion_tokens = (usage.completion_tokens ?? 0) + Number(u.completion_tokens ?? 0);
      });
      const start = Date.now();
      let output;
      let errorText: string | null = null;
      try {
        output = await tracked.analyze(
          { ...source, text: JSON.stringify(batches[cursor]) },
          '这是本次SDK压缩新增退出活动上下文的原始用户消息。只补漏值得复用的记忆，不生成任何行动。facts每条必须增加supporting_evidence数组，每项{source_kind,source_id,quote}引用给定来源真实连续原文；第一项是主张的主要时间来源，其余用于解析指代。不能引用JSON标点或来源标记为证据。结合每项自己的recorded_at/timezone，不把摘要或助手转述当成新事实。',
          signal,
        );
      } catch (error) {
        errorText = safeError(error, this.config);
        throw error;
      } finally {
        await this.db.query(
          'INSERT INTO memory_model_runs(id,user_id,entrypoint,phase,input_tokens,output_tokens,requests,elapsed_ms,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            job.user_id,
            'compaction',
            'extract',
            usage.prompt_tokens ?? 0,
            usage.completion_tokens ?? 0,
            tracked.requestAttempts,
            Date.now() - start,
            errorText ? 'failed' : 'succeeded',
            errorText,
          ],
        );
      }
      for (const item of output.facts) {
        if (!item.supporting_evidence?.length)
          throw new AppError(400, '压缩抽取缺少原始消息证据链');
        if (item.supporting_evidence.some((r) => !job.payload.source_ids.includes(r.source_id)))
          throw new AppError(400, '压缩抽取引用不属于本次原始区间');
      }
      const proposals: MemoryProposal[] = [];
      for (const item of output.facts)
        proposals.push(await this.review.prepare(job.user_id, item, { entrypoint: 'compaction' }));
      const decisions = await this.review.decide(job.user_id, proposals, 'compaction', signal);
      await this.db.tx(async (c) => {
        await this.fence(c, job);
        if (
          (await c.query('SELECT memory_epoch FROM bot_state WHERE user_id=$1', [job.user_id]))
            .rows[0]?.memory_epoch !== job.payload.memory_epoch
        )
          throw new AppError(409, '任务期间发生遗忘，拒绝迟到记忆');
        for (let i = 0; i < proposals.length; i++)
          all.push(await this.review.apply(c, job.user_id, proposals[i].id, decisions[i]));
        await c.query(
          "UPDATE memory_jobs SET payload=jsonb_set(payload,'{cursor}',to_jsonb($3::int)),result=$4 WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token, cursor + 1, JSON.stringify(all)],
        );
      });
    }
    await this.db.tx(async (c) => {
      await this.fence(c, job);
      for (const id of job.payload.source_ids) {
        await c.query(
          'INSERT INTO memory_scan_receipts(user_id,message_id,job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [job.user_id, id, job.id],
        );
        await enqueueIndex(c, job.user_id, 'message', id, 1, 'embedding');
      }
    });
    return all;
  }

  async reclassify(job: any, signal: AbortSignal) {
    const results = [];
    for (const id of job.payload.fact_ids ?? []) {
      if (job.payload.done_fact_ids?.includes(id)) continue;
      const fact = (
        await this.db.query("SELECT * FROM facts WHERE id=$1 AND user_id=$2 AND status='active'", [
          id,
          job.user_id,
        ])
      ).rows[0];
      if (!fact) continue;
      const source = await sourceDocument(
        this.db,
        job.user_id,
        fact.recording_id ? 'recording' : 'message',
        fact.recording_id ?? fact.message_id,
        fact.recording_version ?? undefined,
      );
      const chunks = await saveChunks(this.db, job.user_id, source);
      const proposal = await this.review.prepare(
        job.user_id,
        {
          ...fact,
          person_name: fact.person_label,
          effective_at: fact.effective_at?.toISOString?.() ?? fact.effective_at,
          expires_at: fact.expires_at?.toISOString?.() ?? fact.expires_at,
          source_refs: fact.source_refs?.length
            ? fact.source_refs
            : evidenceRefs(source, chunks, fact.evidence),
        },
        { source },
      );
      const [decision] = await this.review.decide(job.user_id, [proposal], 'reclassify', signal);
      await this.db.tx(async (c) => {
        await this.fence(c, job);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,714))', [job.user_id]);
        const current = (
          await c.query('SELECT * FROM facts WHERE id=$1 AND user_id=$2 FOR UPDATE', [
            id,
            job.user_id,
          ])
        ).rows[0];
        if (
          !current ||
          current.status !== 'active' ||
          +new Date(current.updated_at) !== +new Date(fact.updated_at)
        )
          throw new AppError(409, '待整理记忆已经变化');
        if (
          decision.action === 'IGNORE' ||
          ['business', 'transient'].includes(decision.classification)
        ) {
          await c.query(
            "UPDATE facts SET purpose=$3,tier='archive',updated_at=now() WHERE id=$1 AND user_id=$2",
            [id, job.user_id, decision.classification === 'business' ? 'business' : 'transient'],
          );
        } else if (decision.canonical) {
          const changed = Object.entries(decision.canonical).some(
            ([key, value]) => value !== fact[key],
          );
          if (changed) {
            const result = await this.review.apply(
              c,
              job.user_id,
              proposal.id,
              {
                ...decision,
                action: 'SUPERSEDE',
                target_ids: [id],
              },
              { repair: true },
            );
            results.push(result);
          }
        }
        await c.query(
          'INSERT INTO memory_events(user_id,fact_id,action,details) VALUES($1,$2,$3,$4)',
          [job.user_id, id, 'RECLASSIFY', JSON.stringify({ before: fact, decision })],
        );
        await c.query(
          'UPDATE facts SET raw_extraction=raw_extraction||$3::jsonb WHERE id=$1 AND user_id=$2',
          [id, job.user_id, JSON.stringify({ legacy_review: decision, memory_review_version: 2 })],
        );
        await c.query(
          "UPDATE memory_jobs SET payload=jsonb_set(payload,'{done_fact_ids}',coalesce(payload->'done_fact_ids','[]'::jsonb)||to_jsonb($3::text)) WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token, id],
        );
      });
      results.push({ fact_id: id, decision });
    }
    for (const id of job.payload.candidate_ids ?? []) {
      const candidate = (
        await this.db.query(
          "SELECT * FROM memory_candidates WHERE id=$1 AND user_id=$2 AND status='ignored'",
          [id, job.user_id],
        )
      ).rows[0];
      if (!candidate) continue;
      const source = await sourceDocument(
        this.db,
        job.user_id,
        candidate.source_kind,
        candidate.source_id,
        candidate.source_version,
      );
      const proposal = await this.review.prepare(
        job.user_id,
        {
          ...candidate,
          effective_at: candidate.effective_at?.toISOString?.() ?? candidate.effective_at,
          source_refs: candidate.source_refs,
        },
        { source },
      );
      const [decision] = await this.review.decide(job.user_id, [proposal], 'reclassify', signal);
      results.push(
        await this.db.tx(async (c) => {
          await this.fence(c, job);
          return this.review.apply(c, job.user_id, proposal.id, decision);
        }),
      );
    }
    return results;
  }

  stop() {
    for (const c of this.controllers) c.abort(new Error('服务重启，记忆任务将恢复'));
  }
}
