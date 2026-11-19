/** Reversible legacy memory repair. Dry-run by default; raw archives/business objects are never deleted. */
import { loadConfig } from '../src/server/config.js';
import { Db } from '../src/server/db.js';
import { enqueueMemoryJob } from '../src/server/memory-jobs.js';
const db = new Db(loadConfig()),
  apply = process.argv.includes('--apply');
try {
  const users = (
    await db.query(`SELECT DISTINCT user_id FROM facts WHERE status='active' AND raw_extraction='{}'::jsonb
    UNION SELECT DISTINCT user_id FROM memory_candidates WHERE status='ignored' AND comparison->>'reason'='抽取值需要更直接的原文支持'`)
  ).rows;
  const report = [];
  for (const { user_id } of users) {
    const facts = (
      await db.query(
        "SELECT id FROM facts WHERE user_id=$1 AND status='active' AND raw_extraction='{}'::jsonb ORDER BY created_at,id",
        [user_id],
      )
    ).rows.map((r) => r.id);
    const candidates = (
      await db.query(
        "SELECT id FROM memory_candidates WHERE user_id=$1 AND status='ignored' AND comparison->>'reason'='抽取值需要更直接的原文支持' ORDER BY created_at,id",
        [user_id],
      )
    ).rows.map((r) => r.id);
    const batches = [];
    for (let i = 0; i < facts.length; i += 4) batches.push({ fact_ids: facts.slice(i, i + 4) });
    for (let i = 0; i < candidates.length; i += 4)
      batches.push({ candidate_ids: candidates.slice(i, i + 4) });
    if (apply)
      for (const batch of batches)
        await db.tx((c) =>
          enqueueMemoryJob(
            c,
            user_id,
            'reclassify',
            `generic-memory-v2:${JSON.stringify(batch)}`,
            batch,
          ),
        );
    report.push({
      user_id,
      legacy_facts: facts.length,
      repairable_candidates: candidates.length,
      jobs: batches.length,
    });
  }
  console.log(JSON.stringify({ mode: apply ? 'queued' : 'dry_run', users: report }, null, 2));
} finally {
  await db.close();
}
