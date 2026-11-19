// Shared predicates keep factual reads and raw-source recall consistent across API and tools.
export function sourceRecallAllowed(kind: string, id: string, version?: string) {
  return `NOT EXISTS(SELECT 1 FROM memory_source_policies mp WHERE mp.user_id=$1 AND mp.source_kind=${kind} AND mp.source_id=${id} AND NOT mp.allowed)
    AND NOT EXISTS(SELECT 1 FROM memory_evidence me JOIN facts mf ON mf.id=me.fact_id AND mf.user_id=me.user_id WHERE me.user_id=$1 AND me.source_kind=${kind} AND me.source_id=${id}${version ? ` AND me.source_version=${version}` : ''} AND mf.status='retracted')`;
}
export const currentEvidence = `EXISTS(SELECT 1 FROM memory_evidence me LEFT JOIN recordings mr ON me.source_kind='recording' AND mr.id=me.source_id AND mr.user_id=me.user_id WHERE me.fact_id=f.id AND me.user_id=f.user_id AND (me.source_kind='message' OR mr.version=me.source_version) AND NOT EXISTS(SELECT 1 FROM memory_source_policies mp WHERE mp.user_id=me.user_id AND mp.source_kind=me.source_kind AND mp.source_id=me.source_id AND NOT mp.allowed))`;
// Reinforcement and pinning do not change a claim's meaning. Compare the actual
// semantic version, retaining full PostgreSQL timestamp precision.
export const memoryVersion = `md5(jsonb_build_array(f.subject,f.predicate,f.value,f.person_id,f.scope,f.certainty,f.qualifiers,f.purpose,f.status,f.slot_key,f.claim_key,f.valid_from,f.valid_to,f.expires_at)::text)`;
