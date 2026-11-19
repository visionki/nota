import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';
import { AppError, type Client, type Db } from './db.js';
import type { Config } from './config.js';
import { memoryPermitted } from './memory-policy.js';
import { sourceRecallAllowed } from './memory-sql.js';

export interface SourceDocument {
  kind: 'recording' | 'message';
  id: string;
  version: number;
  text: string;
  title: string;
  recordedAt: string | null;
  timezone: string | null;
  uploadedAt: string;
  instruction?: string;
  memoryAllowed?: boolean;
}
export interface SourceRef {
  chunk_id: string;
  source_kind: string;
  source_id: string;
  source_version: number;
  start_char: number;
  end_char: number;
  quote: string;
  source_url: string;
}
export function stableId(value: string) {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function sourceDocument(
  c: Client,
  userId: string,
  kind: string,
  id: string,
  version?: number,
): Promise<SourceDocument> {
  if (kind === 'message') {
    const r = (
      await c.query(
        "SELECT m.id,m.content,m.created_at,u.timezone,mp.allowed FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN memory_source_policies mp ON mp.user_id=m.user_id AND mp.source_kind='message' AND mp.source_id=m.id WHERE m.user_id=$1 AND m.id=$2 AND m.role='user'",
        [userId, id],
      )
    ).rows[0];
    if (!r) throw new AppError(404, '来源消息不存在');
    return {
      kind: 'message',
      id,
      version: 1,
      text: r.content,
      title: '对话原文',
      recordedAt: r.created_at,
      timezone: r.timezone,
      uploadedAt: r.created_at,
      memoryAllowed: r.allowed !== false && memoryPermitted(r.content),
    };
  }
  const r = (
    await c.query(
      "SELECT r.*,o.input->>'instruction' AS instruction,mp.allowed FROM recordings r LEFT JOIN operations o ON o.id=r.operation_id AND o.user_id=r.user_id LEFT JOIN memory_source_policies mp ON mp.user_id=r.user_id AND mp.source_kind='recording' AND mp.source_id=r.id WHERE r.user_id=$1 AND r.id=$2",
      [userId, id],
    )
  ).rows[0];
  if (!r) throw new AppError(404, '来源录音不存在');
  const v = version ?? r.version;
  const revision =
    v === r.version
      ? r
      : (
          await c.query(
            'SELECT transcript FROM recording_revisions WHERE user_id=$1 AND recording_id=$2 AND version=$3',
            [userId, id, v],
          )
        ).rows[0];
  if (!revision) throw new AppError(404, '原文版本不存在');
  return {
    kind: 'recording',
    id,
    version: v,
    text: revision.transcript,
    title: r.title,
    recordedAt: r.recorded_at,
    timezone: r.recorded_timezone,
    uploadedAt: r.created_at,
    instruction: r.instruction ?? '',
    memoryAllowed: r.allowed !== false && memoryPermitted(revision.transcript, r.instruction ?? ''),
  };
}
export async function syncMemoryPolicy(c: Client, userId: string, source: SourceDocument) {
  const allowed =
    source.memoryAllowed !== false && memoryPermitted(source.text, source.instruction);
  if (!allowed) {
    await c.query(
      "INSERT INTO memory_source_policies(user_id,source_kind,source_id,allowed,reason) VALUES($1,$2,$3,false,'用户限定了记忆范围') ON CONFLICT(user_id,source_kind,source_id) DO UPDATE SET allowed=false",
      [userId, source.kind, source.id],
    );
    await c.query(
      'DELETE FROM chunk_embeddings e USING source_chunks ch WHERE e.chunk_id=ch.id AND ch.user_id=$1 AND ch.source_kind=$2 AND ch.source_id=$3',
      [userId, source.kind, source.id],
    );
  }
  return allowed;
}
// Character offsets are explicitly UTF-16 code units, matching browser String.slice.
export function splitSource(userId: string, source: SourceDocument) {
  const chunks: any[] = [];
  let start = 0;
  while (start < source.text.length) {
    let end = Math.min(source.text.length, start + 1200);
    if (end < source.text.length) {
      const window = source.text.slice(start + 600, end),
        boundary = Math.max(
          window.lastIndexOf('\n'),
          window.lastIndexOf('。'),
          window.lastIndexOf('！'),
          window.lastIndexOf('？'),
        );
      if (boundary >= 0) end = start + 600 + boundary + 1;
      const code = source.text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    const text = source.text.slice(start, end),
      ordinal = chunks.length;
    chunks.push({
      id: stableId(`${userId}:${source.kind}:${source.id}:${source.version}:${ordinal}`),
      user_id: userId,
      source_kind: source.kind,
      source_id: source.id,
      source_version: source.version,
      ordinal,
      start_char: start,
      end_char: end,
      start_line: 1 + (source.text.slice(0, start).match(/\n/g)?.length ?? 0),
      end_line: 1 + (source.text.slice(0, end).match(/\n/g)?.length ?? 0),
      text,
      content_hash: digest(text),
    });
    start = end;
  }
  return chunks;
}
export async function saveChunks(c: Client, userId: string, source: SourceDocument) {
  const chunks = splitSource(userId, source);
  for (const x of chunks)
    await c.query(
      'INSERT INTO source_chunks(id,user_id,source_kind,source_id,source_version,ordinal,start_char,end_char,start_line,end_line,text,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING',
      [
        x.id,
        userId,
        x.source_kind,
        x.source_id,
        x.source_version,
        x.ordinal,
        x.start_char,
        x.end_char,
        x.start_line,
        x.end_line,
        x.text,
        x.content_hash,
      ],
    );
  return chunks;
}
export function evidenceRefs(source: SourceDocument, chunks: any[], evidence: string): SourceRef[] {
  const target = evidence.replace(/\s/g, '');
  if (target.length < 2) throw new AppError(400, '证据过短');
  const positions: number[] = [],
    characters: string[] = [];
  for (let i = 0; i < source.text.length; i++)
    if (!/\s/.test(source.text[i])) {
      positions.push(i);
      characters.push(source.text[i]);
    }
  const position = characters.join('').indexOf(target);
  if (position < 0) throw new AppError(400, '证据不是来源中的连续原文');
  const from = positions[position],
    to = positions[position + target.length - 1] + 1;
  return chunks
    .filter((c) => c.start_char < to && c.end_char > from)
    .map((c) => ({
      chunk_id: c.id,
      source_kind: source.kind,
      source_id: source.id,
      source_version: source.version,
      start_char: Math.max(c.start_char, from),
      end_char: Math.min(c.end_char, to),
      quote: source.text.slice(Math.max(c.start_char, from), Math.min(c.end_char, to)),
      source_url:
        source.kind === 'recording'
          ? `/recordings/${source.id}?version=${source.version}&chunk=${c.id}`
          : `/sources/${c.id}`,
    }));
}
export async function verifyRefs(
  c: Client,
  userId: string,
  refs: SourceRef[],
  requireCurrent = false,
) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 30)
    throw new AppError(400, '需要有效的来源索引');
  for (const ref of refs) {
    const chunk = (
      await c.query('SELECT * FROM source_chunks WHERE id=$1 AND user_id=$2', [
        ref.chunk_id,
        userId,
      ])
    ).rows[0];
    if (!chunk) throw new AppError(404, '来源文段不存在');
    if (
      !Number.isInteger(ref.start_char) ||
      !Number.isInteger(ref.end_char) ||
      ref.end_char <= ref.start_char ||
      typeof ref.quote !== 'string' ||
      !ref.quote.length
    )
      throw new AppError(400, '来源范围无效');
    if (
      chunk.source_id !== ref.source_id ||
      chunk.source_kind !== ref.source_kind ||
      chunk.source_version !== ref.source_version ||
      ref.start_char < chunk.start_char ||
      ref.end_char > chunk.end_char ||
      chunk.text.slice(ref.start_char - chunk.start_char, ref.end_char - chunk.start_char) !==
        ref.quote
    )
      throw new AppError(400, '来源索引与原文不一致');
    if (requireCurrent && chunk.source_kind === 'recording') {
      const r = (
        await c.query('SELECT version FROM recordings WHERE id=$1 AND user_id=$2', [
          chunk.source_id,
          userId,
        ])
      ).rows[0];
      if (r?.version !== chunk.source_version)
        throw new AppError(409, '原文已经修订，请重新读取当前版本后确认行动', 'source_changed');
    }
    ref.source_url =
      chunk.source_kind === 'recording'
        ? `/recordings/${chunk.source_id}?version=${chunk.source_version}&chunk=${chunk.id}`
        : `/sources/${chunk.id}`;
  }
}
export async function readSource(
  c: Client,
  userId: string,
  chunkId: string,
  before = 1,
  after = 1,
) {
  const source = (
    await c.query('SELECT * FROM source_chunks WHERE id=$1 AND user_id=$2', [chunkId, userId])
  ).rows[0];
  if (!source) throw new AppError(404, '原文文段不存在');
  const chunks = (
    await c.query(
      'SELECT * FROM source_chunks WHERE user_id=$1 AND source_kind=$2 AND source_id=$3 AND source_version=$4 AND ordinal BETWEEN $5 AND $6 ORDER BY ordinal',
      [
        userId,
        source.source_kind,
        source.source_id,
        source.source_version,
        source.ordinal - Math.min(3, Math.max(0, before)),
        source.ordinal + Math.min(3, Math.max(0, after)),
      ],
    )
  ).rows;
  const document = await sourceDocument(
    c,
    userId,
    source.source_kind,
    source.source_id,
    source.source_version,
  );
  return {
    metadata: {
      title: document.title,
      recorded_at: document.recordedAt,
      timezone: document.timezone,
      uploaded_at: document.uploadedAt,
    },
    source_kind: source.source_kind,
    source_id: source.source_id,
    source_version: source.source_version,
    offset_unit: 'utf16',
    chunks,
  };
}
export async function enqueueIndex(
  c: Client,
  userId: string,
  kind: string,
  id: string,
  version: number,
  stage = kind === 'recording' ? 'prepare' : 'keyword',
) {
  await syncMemoryPolicy(c, userId, await sourceDocument(c, userId, kind, id, version));
  await c.query(
    `INSERT INTO source_index_jobs(id,user_id,source_kind,source_id,source_version,stage) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(user_id,source_kind,source_id,source_version) DO UPDATE SET stage='embedding',status='queued',lease_token=NULL,lease_until=NULL,available_at=now()
     WHERE EXCLUDED.stage='embedding' AND source_index_jobs.stage='keyword'`,
    [randomUUID(), userId, kind, id, version, stage],
  );
}

export class Embeddings {
  constructor(
    readonly config: Config,
    readonly db: Db,
  ) {}
  async encode(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.config.OPENAI_API_KEY || !this.config.EMBEDDING_ENABLED)
      throw new AppError(503, '向量索引等待配置', 'embedding_unconfigured');
    const response = await fetch(`${this.config.OPENAI_BASE_URL.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.EMBEDDING_MODEL,
        input: texts,
        dimensions: this.config.EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`向量服务 ${response.status}`);
    const data: any = await response.json();
    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
    if (
      rows.length !== texts.length ||
      rows.some(
        (r: any) =>
          !Array.isArray(r.embedding) ||
          r.embedding.length !== this.config.EMBEDDING_DIMENSIONS ||
          r.embedding.some((v: any) => typeof v !== 'number' || !Number.isFinite(v)),
      )
    )
      throw new Error('向量服务返回的维度或数量不正确');
    return rows.map((r) => r.embedding);
  }
  async index(userId: string, source: SourceDocument, signal: AbortSignal) {
    const chunks = (
      await this.db.query(
        `SELECT c.* FROM source_chunks c WHERE user_id=$1 AND source_kind=$2 AND source_id=$3 AND source_version=$4 AND ${sourceRecallAllowed('c.source_kind', 'c.source_id', 'c.source_version')} AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id=c.id AND e.model=$5 AND e.dimensions=$6) ORDER BY ordinal`,
        [
          userId,
          source.kind,
          source.id,
          source.version,
          this.config.EMBEDDING_MODEL,
          this.config.EMBEDDING_DIMENSIONS,
        ],
      )
    ).rows;
    const vector = (await this.db.query("SELECT 1 FROM pg_extension WHERE extname='vector'"))
      .rowCount;
    for (let i = 0; i < chunks.length; i += 32) {
      const part = chunks.slice(i, i + 32),
        values = await this.encode(
          part.map((x) => x.text),
          signal,
        );
      await this.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,714))', [userId]);
        for (let j = 0; j < part.length; j++) {
          if (
            !(
              await c.query(
                `SELECT 1 FROM source_chunks c WHERE c.user_id=$1 AND c.id=$2 AND ${sourceRecallAllowed('c.source_kind', 'c.source_id', 'c.source_version')}`,
                [userId, part[j].id],
              )
            ).rowCount
          )
            continue;
          await c.query(
            'INSERT INTO chunk_embeddings(chunk_id,user_id,model,dimensions,embedding) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [
              part[j].id,
              userId,
              this.config.EMBEDDING_MODEL,
              this.config.EMBEDDING_DIMENSIONS,
              values[j],
            ],
          );
          if (vector)
            await c.query(
              'UPDATE chunk_embeddings SET vector_data=$4::vector WHERE chunk_id=$1 AND model=$2 AND dimensions=$3',
              [
                part[j].id,
                this.config.EMBEDDING_MODEL,
                this.config.EMBEDDING_DIMENSIONS,
                JSON.stringify(values[j]),
              ],
            );
        }
      });
    }
  }
  async search(
    userId: string,
    query: string,
    filters: {
      from?: string;
      to?: string;
      person?: string;
      limit?: number;
      mode?: 'current' | 'history' | 'timeline';
    } = {},
  ) {
    const limit = Math.min(12, filters.limit ?? 8);
    const people = filters.person
      ? (
          await this.db.query(
            'SELECT name,aliases FROM people WHERE user_id=$1 AND (name=$2 OR $2=ANY(aliases))',
            [userId, filters.person],
          )
        ).rows
      : [];
    const names = filters.person
      ? [...new Set([filters.person, ...people.flatMap((p) => [p.name, ...p.aliases])])]
      : null;
    const mode = filters.mode ?? (filters.from || filters.to ? 'history' : 'current');
    const eligible = `c.user_id=$1 AND ${sourceRecallAllowed('c.source_kind', 'c.source_id', 'c.source_version')} AND (c.source_kind='message' OR EXISTS(SELECT 1 FROM recordings r WHERE r.id=c.source_id AND r.user_id=c.user_id AND r.version=c.source_version)) AND ($3::timestamptz IS NULL OR coalesce(r.recorded_at,m.created_at)>=$3) AND ($4::timestamptz IS NULL OR coalesce(r.recorded_at,m.created_at)<$4) AND ($5::text[] IS NULL OR EXISTS(SELECT 1 FROM unnest($5::text[]) AS p(name) WHERE c.text ILIKE '%'||p.name||'%'))${mode === 'current' ? " AND NOT EXISTS(SELECT 1 FROM memory_evidence me JOIN facts mf ON mf.id=me.fact_id AND mf.user_id=me.user_id WHERE me.user_id=c.user_id AND me.source_kind=c.source_kind AND me.source_id=c.source_id AND me.source_version=c.source_version AND mf.status IN ('superseded','pending'))" : ''}`;
    const joins =
      "FROM source_chunks c LEFT JOIN recordings r ON c.source_kind='recording' AND r.id=c.source_id AND r.user_id=c.user_id LEFT JOIN messages m ON c.source_kind='message' AND m.id=c.source_id AND m.user_id=c.user_id";
    const params = [
      userId,
      `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
      filters.from ?? null,
      filters.to ?? null,
      names,
    ];
    const lexical = (
      await this.db.query(
        `SELECT c.*,coalesce(r.title,'对话原文') AS title,r.recorded_at,r.recorded_timezone,r.created_at AS uploaded_at,m.created_at AS message_at ${joins} WHERE ${eligible} AND c.text ILIKE $2 ORDER BY coalesce(r.recorded_at,r.created_at,m.created_at) DESC LIMIT 24`,
        params,
      )
    ).rows;
    let semantic: any[] = [];
    let vectorAvailable = false;
    if (query.trim() && this.config.OPENAI_API_KEY && this.config.EMBEDDING_ENABLED) {
      try {
        // Upstream calls happen outside operation transactions and steering locks.
        const [queryVector] = await this.encode([query]);
        vectorAvailable = !!(
          await this.db.query("SELECT 1 FROM pg_extension WHERE extname='vector'")
        ).rowCount;
        if (vectorAvailable)
          semantic = (
            await this.db.query(
              `SELECT c.*,coalesce(r.title,'对话原文') AS title,r.recorded_at,r.recorded_timezone,r.created_at AS uploaded_at,m.created_at AS message_at ${joins} JOIN chunk_embeddings e ON e.chunk_id=c.id AND e.user_id=c.user_id WHERE ${eligible} AND $2::text IS NOT NULL AND e.model=$6 AND e.dimensions=$7 AND e.vector_data IS NOT NULL ORDER BY e.vector_data <=> $8::vector LIMIT 24`,
              [
                ...params,
                this.config.EMBEDDING_MODEL,
                this.config.EMBEDDING_DIMENSIONS,
                JSON.stringify(queryVector),
              ],
            )
          ).rows;
      } catch {
        /* Lexical retrieval remains available while indexing/provider recovers. */
      }
    }
    const ranked = new Map<string, any>();
    for (const list of [lexical, semantic])
      list.forEach((r, i) => {
        const old = ranked.get(r.id);
        ranked.set(r.id, { ...r, score: (old?.score ?? 0) + 1 / (60 + i + 1) });
      });
    return {
      mode: semantic.length ? 'hybrid' : 'keyword',
      vectorAvailable,
      chunks: [...ranked.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({
          ...r,
          source_url:
            r.source_kind === 'recording'
              ? `/recordings/${r.source_id}?version=${r.source_version}&chunk=${r.id}`
              : `/sources/${r.id}`,
        })),
    };
  }
}
