import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, Db, type Client } from './db.js';
import { safeError, loadConfig, type Config } from './config.js';
import { MemoryService } from './memory.js';
import { memoryInputSchema, memoryPermitted, normalized, subjectKey } from './memory-policy.js';
import {
  decisionSchema,
  memoryDecisionInstructions,
  type MemoryDecision,
  type ReviewedMemory,
} from './memory-contract.js';
import {
  Embeddings,
  sourceDocument,
  saveChunks,
  evidenceRefs,
  verifyRefs,
  enqueueIndex,
  type SourceDocument,
  type SourceRef,
} from './sources.js';
import { currentEvidence, sourceRecallAllowed, memoryVersion } from './memory-sql.js';

export const supportSchema = z.object({
  source_kind: z.enum(['message', 'recording']).default('message'),
  source_id: z.uuid().optional(),
  source_version: z.number().int().positive().optional(),
  quote: z.string().min(2).max(2000),
});
export type MemoryProposal = {
  id: string;
  source: SourceDocument;
  draft: any;
  source_refs: SourceRef[];
  related: any[];
  business_objects: any[];
  blocked: boolean;
};

/** Retrieval and model requests run outside the short, fenced write transaction. */
export class MemoryReview {
  readonly memory = new MemoryService();
  readonly embeddings: Embeddings;
  constructor(
    readonly db: Db,
    readonly config: Config = loadConfig({
      GMI_API_KEY: '',
      OPENAI_API_KEY: '',
      TAVILY_API_KEY: '',
      EMBEDDING_ENABLED: 'false',
    }),
  ) {
    this.embeddings = new Embeddings(config, db);
  }

  async prepare(
    userId: string,
    input: any,
    options: { source?: SourceDocument; operationId?: string; entrypoint?: string } = {},
  ): Promise<MemoryProposal> {
    const draft = memoryInputSchema.parse(input);
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,714))', [userId]);
      await this.memory.hydrate(c, userId);
    });
    let refs: SourceRef[] = input.source_refs ?? [];
    if (!refs.length) {
      const supports = input.supporting_evidence?.length
        ? z.array(supportSchema).min(1).max(20).parse(input.supporting_evidence)
        : [
            {
              source_kind: options.source?.kind ?? (input.recording_id ? 'recording' : 'message'),
              source_id: options.source?.id ?? input.recording_id,
              source_version: options.source?.version ?? input.recording_version,
              quote: input.evidence,
            },
          ];
      for (const support of supports) {
        if (typeof support.quote !== 'string') throw new AppError(400, '需要真实连续原文作为证据');
        let id = support.source_id;
        if (!id) {
          // Resolve quotations to owned original messages, never to an assistant's paraphrase.
          const rows = (
            await this.db.query(
              "SELECT id FROM messages WHERE user_id=$1 AND role='user' AND position($2 in content)>0 ORDER BY (operation_id=$3::uuid) DESC NULLS LAST,seq DESC LIMIT 2",
              [userId, support.quote, options.operationId ?? null],
            )
          ).rows;
          if (!rows.length) throw new AppError(400, '这段原文没有真实来源，请检索后引用原始消息');
          if (rows.length > 1)
            throw new AppError(400, '原文对应多条消息，请指定source_id避免猜测来源');
          id = rows[0].id;
        }
        const source = await sourceDocument(
          this.db,
          userId,
          support.source_kind,
          id!,
          support.source_version,
        );
        const chunks = await saveChunks(this.db, userId, source);
        refs.push(...evidenceRefs(source, chunks, support.quote));
      }
    }
    await verifyRefs(this.db, userId, refs, true);
    // A short quote can omit the antecedent of “她/我们”. Include nearby original
    // text when it contains a named entity used by the draft. The model still
    // judges whether that context actually supports the attribution.
    for (const name of [draft.person_name, draft.organization]) {
      if (!name || subjectKey(name) === 'self' || refs.some((r) => r.quote.includes(name)))
        continue;
      for (const ref of [...refs]) {
        const doc = await sourceDocument(
          this.db,
          userId,
          ref.source_kind,
          ref.source_id,
          ref.source_version,
        );
        const quote = doc.text.slice(Math.max(0, ref.start_char - 400), ref.end_char + 400);
        if (!quote.includes(name)) continue;
        const chunks = await saveChunks(this.db, userId, doc);
        const contextRefs = evidenceRefs(doc, chunks, quote);
        for (const extra of contextRefs)
          if (
            !refs.some(
              (r) =>
                r.chunk_id === extra.chunk_id &&
                r.start_char === extra.start_char &&
                r.end_char === extra.end_char,
            )
          )
            refs.push(extra);
        break;
      }
    }
    const source =
      options.source ??
      (await sourceDocument(
        this.db,
        userId,
        refs[0].source_kind,
        refs[0].source_id,
        refs[0].source_version,
      ));
    let blocked = false;
    for (const ref of refs) {
      const d = await sourceDocument(
        this.db,
        userId,
        ref.source_kind,
        ref.source_id,
        ref.source_version,
      );
      if (d.memoryAllowed === false || !memoryPermitted(d.text, d.instruction)) blocked = true;
      if (
        !(
          await this.db.query(
            `SELECT 1 WHERE ${sourceRecallAllowed('$2::text', '$3::uuid', '$4::int')}`,
            [userId, ref.source_kind, ref.source_id, ref.source_version],
          )
        ).rowCount
      )
        blocked = true;
    }
    let related: any[] = [],
      business_objects: any[] = [];
    if (!blocked) {
      const pool = await this.memory.list(this.db, userId, { mode: 'history', limit: 200 });
      const query = `${draft.subject} ${draft.predicate} ${draft.value}`.slice(0, 200);
      const found = await this.embeddings.search(userId, query, { mode: 'history', limit: 8 });
      const sourceIds = found.chunks.map((c: any) => c.source_id);
      const vectorFactIds = sourceIds.length
        ? (
            await this.db.query(
              'SELECT DISTINCT fact_id FROM memory_evidence WHERE user_id=$1 AND source_id=ANY($2::uuid[])',
              [userId, sourceIds],
            )
          ).rows.map((r) => r.fact_id)
        : [];
      if (vectorFactIds.length) {
        const old = (
          await this.db.query(
            `SELECT f.*,${memoryVersion} AS version_token,coalesce(p.name,f.person_label) person_name FROM facts f LEFT JOIN people p ON p.id=f.person_id AND p.user_id=f.user_id WHERE f.user_id=$1 AND f.id=ANY($2::uuid[]) AND f.status IN ('active','superseded') AND f.merged_into IS NULL AND f.purpose NOT IN ('business','transient') AND ${currentEvidence}`,
            [userId, vectorFactIds],
          )
        ).rows;
        for (const f of old) if (!pool.some((p) => p.id === f.id)) pool.push(f);
      }
      const score = (f: any) =>
        Number(subjectKey(f.subject) === subjectKey(draft.subject)) * 8 +
        Number(!!draft.person_name && f.person_name === draft.person_name) * 8 +
        Number(normalized(f.predicate) === normalized(draft.predicate)) * 4 +
        Number(vectorFactIds.includes(f.id)) * 5 +
        Number(normalized(f.evidence).includes(normalized(draft.subject))) * 2;
      related = pool
        .map((f) => ({ ...f, _score: score(f) }))
        .filter((f) => f._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 12)
        .map((f) => ({
          id: f.id,
          subject: f.subject,
          predicate: f.predicate,
          value: f.value,
          kind: f.kind,
          scope: f.scope,
          certainty: f.certainty,
          qualifiers: f.qualifiers,
          person_id: f.person_id,
          person_name: f.person_name,
          status: f.status,
          updated_at: f.updated_at,
          version_token: f.version_token,
          effective_at: f.effective_at,
          effective_date: f.effective_date,
          observed_at: f.observed_at,
          source_refs: f.source_refs,
          evidence: f.evidence.slice(0, 1800),
        }));
      if (options.operationId) {
        for (const [kind, table] of [
          ['event', 'calendar_events'],
          ['todo', 'todos'],
          ['reminder', 'reminders'],
        ] as const) {
          const rows = (
            await this.db.query(
              `SELECT * FROM ${table} WHERE user_id=$1 AND operation_id=$2 ORDER BY created_at DESC LIMIT 8`,
              [userId, options.operationId],
            )
          ).rows;
          business_objects.push(
            ...rows.map((r) => ({
              kind,
              id: r.id,
              title: r.title,
              status: r.status,
              notes: r.notes,
              starts_at: r.starts_at,
              starts_on: r.starts_on,
              ends_at: r.ends_at,
              remind_at: r.remind_at,
              event_id: r.event_id,
              todo_id: r.todo_id,
            })),
          );
        }
      }
      for (const link of draft.business_refs) {
        const table = { event: 'calendar_events', todo: 'todos', reminder: 'reminders' }[link.kind];
        const row = (
          await this.db.query(`SELECT * FROM ${table} WHERE user_id=$1 AND id=$2`, [
            userId,
            link.id,
          ])
        ).rows[0];
        if (!row) throw new AppError(404, '关联业务对象不存在');
        if (!business_objects.some((b) => b.kind === link.kind && b.id === link.id))
          business_objects.push({
            kind: link.kind,
            id: row.id,
            title: row.title,
            status: row.status,
            notes: row.notes,
          });
      }
    }
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO memory_proposals(id,user_id,source_kind,source_id,source_version,draft,source_refs,related,blocked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        userId,
        source.kind,
        source.id,
        source.version,
        JSON.stringify(draft),
        JSON.stringify(refs),
        JSON.stringify(related),
        blocked,
      ],
    );
    return { id, source, draft, source_refs: refs, related, business_objects, blocked };
  }

  async apply(
    c: Client,
    userId: string,
    proposalId: string,
    input: unknown,
    options: { repair?: boolean } = {},
  ) {
    const decision = decisionSchema.parse(input);
    const p = (
      await c.query('SELECT * FROM memory_proposals WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        proposalId,
        userId,
      ])
    ).rows[0];
    if (!p) throw new AppError(404, '记忆提案不存在');
    if (p.status === 'applied') {
      if (p.result?.fact?.id) {
        const current = (
          await c.query('SELECT status FROM facts WHERE user_id=$1 AND id=$2', [
            userId,
            p.result.fact.id,
          ])
        ).rows[0];
        if (!current || current.status === 'retracted')
          return {
            memory_status: 'forgotten',
            fact: null,
            comparison: { action: 'IGNORE', reason: '已遗忘，不重放过时成功结果' },
          };
      }
      return p.result;
    }
    const snapshots = p.related.filter((f: any) => decision.target_ids.includes(f.id));
    if (snapshots.length !== new Set(decision.target_ids).size)
      throw new AppError(400, '只能操作本次召回的真实记忆');
    const source = await sourceDocument(c, userId, p.source_kind, p.source_id, p.source_version);
    const draft = {
      ...p.draft,
      ...decision.canonical,
      purpose: decision.classification,
      source_refs: p.source_refs,
    };
    const reviewed: ReviewedMemory = {
      ...decision,
      snapshots,
      proposal_id: p.id,
      repair: options.repair,
    };
    if (p.blocked) {
      reviewed.action = 'IGNORE';
      reviewed.evidence_supported = false;
      reviewed.reason = '来源受记忆权限或遗忘限制';
    }
    const candidate = await this.memory.remember(c, userId, source, draft, reviewed);
    if (candidate.fact_id)
      for (const ref of p.source_refs)
        await enqueueIndex(
          c,
          userId,
          ref.source_kind,
          ref.source_id,
          ref.source_version,
          'embedding',
        );
    const fact = candidate.fact_id
      ? (
          await c.query('SELECT * FROM facts WHERE id=$1 AND user_id=$2', [
            candidate.fact_id,
            userId,
          ])
        ).rows[0]
      : null;
    const result = {
      candidate_id: candidate.id,
      fact,
      memory_status: candidate.status,
      comparison: candidate.comparison,
      source_refs: p.source_refs,
    };
    await c.query(
      "UPDATE memory_proposals SET status='applied',result=$3 WHERE id=$1 AND user_id=$2",
      [proposalId, userId, JSON.stringify(result)],
    );
    return result;
  }

  async decide(
    userId: string,
    proposals: MemoryProposal[],
    entrypoint: string,
    signal: AbortSignal,
  ): Promise<MemoryDecision[]> {
    if (!proposals.length) return [];
    if (proposals.every((p) => p.blocked))
      return proposals.map(() => ({
        action: 'IGNORE',
        target_ids: [],
        classification: 'transient',
        evidence_supported: false,
        reason: '用户不允许保存来源记忆',
      }));
    if (!this.config.GMI_API_KEY) throw new AppError(503, '记忆比较等待模型配置');
    const start = Date.now();
    let usage: any = {},
      requests = 0,
      success = false,
      errorText: string | undefined;
    try {
      const payload = {
        model: this.config.GMI_MODEL,
        temperature: 0.1,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${memoryDecisionInstructions}\n只输出JSON对象，例如 {"decisions":[{"index":0,"action":"ADD","target_ids":[],"classification":"durable","evidence_supported":true,"reason":"原文支持独立长期事实"}]}，每个输入index恰好一次。canonical是可省略的JSON对象，绝不是字符串、布尔值或null；仅在确需纠正或规范化时加入，例如 "canonical":{"subject":"主体","predicate":"关系","value":"值","scope":"适用条件","certainty":"tentative","qualifiers":"尚未确认"}。canonical中只放需要改动的字段，不能添加证据未支持的信息。classification为durable/event_context/business/transient；业务字段和操作指令必须IGNORE。确认状态用stated/tentative/confirmed/goal，限定条件写qualifiers。`,
          },
          {
            role: 'user',
            content: JSON.stringify(
              proposals.map((p, index) => ({
                index,
                draft: p.draft,
                source_context: p.source.text.slice(0, 9000),
                source_time: p.source.recordedAt,
                source_timezone: p.source.timezone,
                quotes: p.source_refs.map((r) => ({
                  source_kind: r.source_kind,
                  source_id: r.source_id,
                  quote: r.quote,
                })),
                related: p.related,
                business_objects: p.business_objects,
                blocked: p.blocked,
              })),
            ),
          },
        ],
      };
      let parsed: { decisions: (MemoryDecision & { index: number })[] } | undefined;
      // At most one retry, including transport errors and malformed structured
      // output. Both attempts are metered, and external cancellation always wins.
      for (let attempt = 0; attempt < 2; attempt++) {
        let content: unknown;
        requests++;
        try {
          const response = await fetch(
            `${this.config.GMI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.config.GMI_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            if (![408, 429, 500, 502, 503, 504, 524].includes(response.status))
              throw new AppError(response.status, `记忆比较服务 ${response.status}`);
            throw new Error(`记忆比较服务 ${response.status}`);
          }
          const body: any = await response.json();
          usage.prompt_tokens = (usage.prompt_tokens ?? 0) + Number(body.usage?.prompt_tokens ?? 0);
          usage.completion_tokens =
            (usage.completion_tokens ?? 0) + Number(body.usage?.completion_tokens ?? 0);
          content = body.choices?.[0]?.message?.content;
          parsed = z
            .object({
              decisions: z.array(decisionSchema.extend({ index: z.number().int().min(0) })),
            })
            .parse(
              JSON.parse(
                String(content)
                  .replace(/^\s*```(?:json)?\s*/, '')
                  .replace(/\s*```\s*$/, ''),
              ),
            );
          if (
            parsed.decisions.length !== proposals.length ||
            new Set(parsed.decisions.map((d) => d.index)).size !== proposals.length ||
            parsed.decisions.some((d) => d.index >= proposals.length)
          )
            throw new Error('记忆比较未完整返回每个候选');
          break;
        } catch (error) {
          parsed = undefined;
          if (attempt || signal.aborted || error instanceof AppError) throw error;
          if (content !== undefined)
            payload.messages.push(
              { role: 'assistant', content: String(content).slice(0, 30000) },
              {
                role: 'user',
                content: `请修正格式并重新输出全部decisions。canonical省略或提供JSON对象，每个index恰好一次，完整保留原始证据与语义。格式错误：${String(error).slice(0, 2400)}`,
              },
            );
        }
      }
      if (!parsed) throw new Error('记忆比较没有有效结构化结果');
      success = true;
      return proposals.map((p, index) =>
        p.blocked
          ? {
              action: 'IGNORE',
              target_ids: [],
              classification: 'transient',
              evidence_supported: false,
              reason: '用户不允许保存来源记忆',
            }
          : parsed.decisions.find((d) => d.index === index)!,
      );
    } catch (error) {
      errorText = safeError(error, this.config);
      throw error;
    } finally {
      await this.db.query(
        'INSERT INTO memory_model_runs(id,user_id,entrypoint,phase,input_tokens,output_tokens,requests,elapsed_ms,status,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          userId,
          entrypoint,
          'compare',
          usage.prompt_tokens ?? 0,
          usage.completion_tokens ?? 0,
          requests,
          Date.now() - start,
          success ? 'succeeded' : 'failed',
          errorText ?? null,
        ],
      );
    }
  }

  async review(
    userId: string,
    source: SourceDocument,
    items: any[],
    entrypoint: string,
    signal: AbortSignal,
  ) {
    const proposals = [];
    for (const item of items)
      proposals.push(await this.prepare(userId, item, { source, entrypoint }));
    if (!proposals.length) return [];
    const decisions = await this.decide(userId, proposals, entrypoint, signal);
    return proposals.map((p, i) => ({ proposal_id: p.id, decision: decisions[i] }));
  }
}
