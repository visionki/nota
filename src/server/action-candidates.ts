import { AppError, type Client } from './db.js';
import type { ToolContext } from './tools.js';
import type { SourceRef } from './sources.js';

export type ActionKind = 'todo' | 'event' | 'reminder';
const labels: Record<ActionKind, string> = { todo: '待办', event: '日程', reminder: '提醒' };
const subjectKind = (kind: string) => kind === 'todo' || kind === 'event';
const compatible = (from: string, to: ActionKind) =>
  from === to || (subjectKind(from) && subjectKind(to));
const overlaps = (a: SourceRef, b: SourceRef) =>
  a.source_kind === 'recording' &&
  b.source_kind === 'recording' &&
  a.source_id === b.source_id &&
  a.source_version === b.source_version &&
  a.start_char < b.end_char &&
  b.start_char < a.end_char;

/** Classification is provisional; actor, explicit intent, source policy and ownership are not. */
export async function resolveActionCandidate(
  c: Client,
  ctx: Pick<ToolContext, 'userId' | 'batchId'>,
  candidateId: string | undefined,
  refs: SourceRef[],
  kind: ActionKind,
) {
  let candidate: any;
  if (candidateId) {
    candidate = (
      await c.query('SELECT * FROM candidate_actions WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        candidateId,
        ctx.userId,
      ])
    ).rows[0];
    if (!candidate) throw new AppError(404, '行动候选不存在', 'candidate_not_found');
    if (
      ctx.batchId &&
      !(
        await c.query(
          'SELECT 1 FROM recording_batch_items WHERE batch_id=$1 AND user_id=$2 AND artifact_id=$3',
          [ctx.batchId, ctx.userId, candidate.artifact_id],
        )
      ).rowCount
    )
      throw new AppError(
        400,
        '该候选不属于当前录音批次，请使用本批次的候选 ID',
        'candidate_wrong_batch',
      );
  } else if (ctx.batchId && refs.some((ref) => ref.source_kind === 'recording')) {
    const rows = (
      await c.query(
        `SELECT ca.* FROM candidate_actions ca JOIN recording_batch_items i ON i.artifact_id=ca.artifact_id AND i.user_id=ca.user_id
       WHERE i.batch_id=$1 AND i.user_id=$2 ORDER BY ca.id FOR UPDATE OF ca`,
        [ctx.batchId, ctx.userId],
      )
    ).rows;
    const matching = [
      ...new Map(
        rows
          .filter((row) =>
            row.source_refs.some((ref: SourceRef) => refs.some((input) => overlaps(ref, input))),
          )
          .map((row) => [row.id, row]),
      ).values(),
    ];
    const exact = matching.filter((row) => row.payload.kind === kind);
    const options = exact.length
      ? exact
      : matching.filter((row) => compatible(row.payload.kind, kind));
    if (options.length > 1)
      throw new AppError(
        400,
        '这段原文对应多个行动候选，请保留具体 candidate_id 后重试，不要通过省略 ID 绕过校验',
        'candidate_ambiguous',
      );
    candidate = options[0];
    if (!candidate && matching.length)
      throw new AppError(
        400,
        `该来源候选不能直接作为${labels[kind]}执行，请核对事项与提醒的区别并保留 candidate_id`,
        'candidate_kind_mismatch',
      );
  }
  if (!candidate) return null;
  if (candidate.payload.actor !== 'self')
    throw new AppError(
      400,
      '该候选的执行主体不是用户本人或尚未确认，请先确认归属',
      'candidate_actor_unconfirmed',
    );
  if (!candidate.payload.explicit)
    throw new AppError(
      400,
      '该候选尚未构成用户的明确交办，请先确认是否需要创建',
      'candidate_not_explicit',
    );
  if (candidate.payload.execution_allowed === false)
    throw new AppError(
      400,
      '该候选被本次整理范围限制，不能自动创建；不要省略候选 ID 重试',
      'candidate_scope_denied',
    );
  if (!compatible(candidate.payload.kind, kind))
    throw new AppError(
      400,
      `候选类型为${labels[candidate.payload.kind as ActionKind] ?? candidate.payload.kind}，不能直接作为${labels[kind]}执行；提醒与事项主体不能互相替代`,
      'candidate_kind_mismatch',
    );
  const executedKind = candidate.result_type ?? candidate.payload.kind;
  if (candidate.result_id && executedKind !== kind)
    throw new AppError(
      409,
      `该候选已经创建为${labels[executedKind as ActionKind] ?? executedKind}，请读取或修改已有对象，不要再创建另一种主体`,
      'candidate_already_executed',
    );
  return candidate;
}
