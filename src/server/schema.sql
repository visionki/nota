CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL,
 timezone text NOT NULL DEFAULT 'Asia/Shanghai',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscriptions (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,plan text NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro')),
 status text NOT NULL DEFAULT 'inactive',period_end timestamptz,cancel_at_period_end boolean NOT NULL DEFAULT false,
 provider text NOT NULL DEFAULT 'demo',provider_ref text,version bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS billing_events (id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),provider text NOT NULL,event_type text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS quota_buckets (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,quota_day date NOT NULL,used integer NOT NULL DEFAULT 0 CHECK(used>=0),reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),PRIMARY KEY(user_id,quota_day)
);
CREATE TABLE IF NOT EXISTS operations (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,idempotency_key text NOT NULL,payload_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('chat','recording','trigger')),input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','succeeded','failed','cancelled')),
 stage text NOT NULL DEFAULT 'queued',attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,
 reply text NOT NULL DEFAULT '',last_error text,usage_tokens bigint NOT NULL DEFAULT 0,session_path text,input_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key),UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS operations_pending ON operations(user_id,created_at) WHERE status IN ('queued','running');
ALTER TABLE operations ADD COLUMN IF NOT EXISTS input_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS quota_reservations (
 operation_id uuid PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),quota_day date NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','committed','released')),created_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
 FOREIGN KEY(user_id,quota_day) REFERENCES quota_buckets(user_id,quota_day)
);
CREATE TABLE IF NOT EXISTS messages (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id uuid,
 seq bigint GENERATED ALWAYS AS IDENTITY,role text NOT NULL CHECK(role IN ('user','assistant','system')),
 kind text NOT NULL DEFAULT 'chat',content text NOT NULL,dedupe_key text NOT NULL,process jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,dedupe_key),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE INDEX IF NOT EXISTS messages_history ON messages(user_id,seq DESC);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(user_id,seq) WHERE role='assistant';
CREATE TABLE IF NOT EXISTS conversation_reads (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,last_read_seq bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS process jsonb;
CREATE TABLE IF NOT EXISTS chat_inputs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,idempotency_key text NOT NULL,payload_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('initial','steering')),content text NOT NULL,input_version integer NOT NULL,cycle integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 UNIQUE(user_id,idempotency_key),UNIQUE(operation_id,input_version),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_inputs_pending ON chat_inputs(user_id,operation_id,input_version) WHERE status='pending';
CREATE TABLE IF NOT EXISTS recordings (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id uuid,
 title text NOT NULL,storage_key text NOT NULL UNIQUE,filename text NOT NULL,mime text NOT NULL,size_bytes integer NOT NULL,
 duration_seconds numeric NOT NULL,status text NOT NULL DEFAULT 'uploaded',
 transcript text NOT NULL DEFAULT '',segments jsonb NOT NULL DEFAULT '[]',summary text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 0,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id),
 FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE INDEX IF NOT EXISTS recordings_history ON recordings(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS recording_revisions (
 id uuid PRIMARY KEY,recording_id uuid NOT NULL,user_id uuid NOT NULL,version integer NOT NULL,transcript text NOT NULL,segments jsonb NOT NULL DEFAULT '[]',source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(recording_id,version),FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS people (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name text NOT NULL,aliases text[] NOT NULL DEFAULT '{}',organization text NOT NULL DEFAULT '',role text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id),UNIQUE(user_id,name,organization)
);
CREATE TABLE IF NOT EXISTS facts (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,person_id uuid,subject text NOT NULL,predicate text NOT NULL,value text NOT NULL,
 effective_at timestamptz,recording_id uuid,message_id uuid,evidence text NOT NULL,confidence numeric NOT NULL DEFAULT 0.8,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retracted')),dedupe_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,dedupe_key),FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id),FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id)
);
CREATE INDEX IF NOT EXISTS facts_lookup ON facts(user_id,person_id,effective_at DESC);
CREATE TABLE IF NOT EXISTS todos (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,notes text NOT NULL DEFAULT '',due_at timestamptz,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),recording_id uuid,operation_id uuid,dedupe_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id),UNIQUE(user_id,dedupe_key),
 FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE TABLE IF NOT EXISTS calendar_events (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 timezone text NOT NULL,location text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',person_id uuid,recording_id uuid,operation_id uuid,dedupe_key text NOT NULL,
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at),UNIQUE(id,user_id),UNIQUE(user_id,dedupe_key),FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id),
 FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE TABLE IF NOT EXISTS reminders (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,remind_at timestamptz NOT NULL,event_id uuid,todo_id uuid,operation_id uuid,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','delivered','cancelled')),dedupe_key text NOT NULL,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,dedupe_key),FOREIGN KEY(event_id,user_id) REFERENCES calendar_events(id,user_id),FOREIGN KEY(todo_id,user_id) REFERENCES todos(id,user_id),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(remind_at) WHERE status='scheduled';

-- Calendar subjects are events and tasks. Alerts are their delivery settings.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS planned_date date;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS planned_at timestamptz;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS planned_end_at timestamptz;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS due_date date;
UPDATE todos t SET timezone=u.timezone FROM users u WHERE t.user_id=u.id AND t.timezone IS NULL;
ALTER TABLE todos ALTER COLUMN timezone SET DEFAULT 'Asia/Shanghai';
ALTER TABLE todos ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE calendar_events ALTER COLUMN ends_at DROP NOT NULL;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS all_day boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS starts_on date;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS ends_on date;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'absolute';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS relative_to text;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS before_minutes integer;
-- Version 2 is the memory backfill; version 3 is notification boundaries.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=4) THEN
  -- Preserve historical event-alert rescheduling behaviour; dates and object IDs stay intact.
  UPDATE reminders r SET trigger_kind='relative',relative_to='start',
    before_minutes=round(extract(epoch FROM (e.starts_at-r.remind_at))/60)::integer
    FROM calendar_events e WHERE r.event_id=e.id AND r.user_id=e.user_id;
  -- Recover an unambiguous legacy task-alert association without matching or rewriting titles.
  WITH matches AS (
   SELECT r.id,array_agg(t.id) AS todo_ids FROM reminders r JOIN todos t
     ON t.user_id=r.user_id AND t.operation_id=r.operation_id AND t.due_at=r.remind_at
   WHERE r.event_id IS NULL AND r.todo_id IS NULL AND r.operation_id IS NOT NULL GROUP BY r.id
  ) UPDATE reminders r SET todo_id=m.todo_ids[1] FROM matches m WHERE r.id=m.id AND cardinality(m.todo_ids)=1;
  ALTER TABLE todos ADD CONSTRAINT todos_date_precision CHECK (
    (planned_date IS NULL OR planned_at IS NULL) AND (due_date IS NULL OR due_at IS NULL)
    AND (planned_end_at IS NULL OR (planned_at IS NOT NULL AND planned_end_at>planned_at)));
  ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_date_precision CHECK (
    (all_day AND starts_on IS NOT NULL AND ends_on IS NOT NULL AND ends_on>starts_on AND ends_at IS NOT NULL)
    OR (NOT all_day AND starts_on IS NULL AND ends_on IS NULL));
  ALTER TABLE reminders ADD CONSTRAINT reminders_trigger_kind CHECK (
    (trigger_kind='absolute' AND relative_to IS NULL AND before_minutes IS NULL)
    OR (trigger_kind='relative' AND relative_to IN ('start','end','planned','due') AND before_minutes IS NOT NULL));
  INSERT INTO schema_migrations(version) VALUES(4);
 END IF;
END $$;
-- Semantic memory review is separate from raw-source indexing and domain objects.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS memory_summary jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS facts_id_owner ON facts(id,user_id);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS certainty text NOT NULL DEFAULT 'stated';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS qualifiers text NOT NULL DEFAULT '';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'durable';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS raw_extraction jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS memory_proposals (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,
 draft jsonb NOT NULL,source_refs jsonb NOT NULL,related jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending',result jsonb,blocked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memory_proposals ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS memory_proposals_owner ON memory_proposals(user_id,id);
CREATE TABLE IF NOT EXISTS memory_links (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),fact_id uuid NOT NULL,
 object_kind text NOT NULL CHECK(object_kind IN ('event','todo','reminder')),object_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(fact_id,object_kind,object_id),
 FOREIGN KEY(fact_id,user_id) REFERENCES facts(id,user_id)
);
CREATE TABLE IF NOT EXISTS memory_jobs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),entrypoint text NOT NULL CHECK(entrypoint IN ('recording','compaction','reclassify')),
 dedupe_key text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',attempts integer NOT NULL DEFAULT 0,
 lease_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),last_error text,
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,dedupe_key)
);
CREATE TABLE IF NOT EXISTS memory_model_runs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),entrypoint text NOT NULL,phase text NOT NULL,
 input_tokens bigint NOT NULL DEFAULT 0,output_tokens bigint NOT NULL DEFAULT 0,requests integer NOT NULL DEFAULT 1,
 elapsed_ms integer NOT NULL,status text NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_scan_receipts (
 user_id uuid NOT NULL REFERENCES users(id),message_id uuid NOT NULL REFERENCES messages(id),job_id uuid NOT NULL REFERENCES memory_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,message_id)
);
CREATE INDEX IF NOT EXISTS todos_planned_at ON todos(user_id,planned_at);
CREATE INDEX IF NOT EXISTS todos_planned_date ON todos(user_id,planned_date);
CREATE INDEX IF NOT EXISTS todos_due_date ON todos(user_id,due_date);
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,body text NOT NULL,kind text NOT NULL,
 object_id uuid,dedupe_key text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,dedupe_key)
);
CREATE TABLE IF NOT EXISTS tool_calls (
 id uuid PRIMARY KEY,user_id uuid NOT NULL,operation_id uuid NOT NULL,attempt integer NOT NULL,model_call_id text NOT NULL,name text NOT NULL,label text NOT NULL,
 input jsonb NOT NULL,status text NOT NULL DEFAULT 'running',result jsonb,error text,input_version integer NOT NULL DEFAULT 0,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id),UNIQUE(operation_id,attempt,model_call_id)
);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS input_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS action_receipts (
 user_id uuid NOT NULL,operation_id uuid NOT NULL,key text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_id,key),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE TABLE IF NOT EXISTS user_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,type text NOT NULL,operation_id uuid,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_events_cursor ON user_events(user_id,id);
CREATE INDEX IF NOT EXISTS user_events_operation ON user_events(user_id,operation_id,id);
CREATE TABLE IF NOT EXISTS bot_state (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,session_path text,compactions integer NOT NULL DEFAULT 0,context_tokens bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_checkpoints (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id uuid,tokens_before bigint,tokens_after bigint,session_path text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedules (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,prompt text NOT NULL,cron text,timezone text NOT NULL DEFAULT 'Asia/Shanghai',
 next_run_at timestamptz NOT NULL,active boolean NOT NULL DEFAULT true,last_run_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS trigger_tokens (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name text NOT NULL,token_hash text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id text PRIMARY KEY,at timestamptz NOT NULL DEFAULT now());
ALTER TABLE facts ADD COLUMN IF NOT EXISTS recording_version integer;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS cycle_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE facts ALTER COLUMN confidence DROP NOT NULL;
ALTER TABLE facts ALTER COLUMN confidence DROP DEFAULT;

-- Recording preparation and conversational execution have independent leases and queues.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS executor text NOT NULL DEFAULT 'agent';
ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'all';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recorded_timezone text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recording_time_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE people ADD COLUMN IF NOT EXISTS identity_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_user_id_name_organization_key;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS recording_batches (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','sealed','dispatched')),
 close_reason text,agent_operation_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),drained_at timestamptz,
 UNIQUE(id,user_id),FOREIGN KEY(agent_operation_id,user_id) REFERENCES operations(id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS recording_window_open ON recording_batches(user_id) WHERE state='open';
CREATE TABLE IF NOT EXISTS recording_artifacts (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),recording_id uuid NOT NULL,recording_version integer NOT NULL,pipeline_version integer NOT NULL DEFAULT 1,
 summary text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),UNIQUE(recording_id,recording_version,pipeline_version),FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id)
);
CREATE TABLE IF NOT EXISTS recording_batch_items (
 batch_id uuid NOT NULL,user_id uuid NOT NULL,operation_id uuid NOT NULL,recording_id uuid NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed','cancelled')),
 artifact_id uuid,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 PRIMARY KEY(batch_id,operation_id),FOREIGN KEY(batch_id,user_id) REFERENCES recording_batches(id,user_id),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id),
 FOREIGN KEY(recording_id,user_id) REFERENCES recordings(id,user_id),FOREIGN KEY(artifact_id,user_id) REFERENCES recording_artifacts(id,user_id)
);
CREATE TABLE IF NOT EXISTS agent_inbox (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),event_key text NOT NULL,event_type text NOT NULL,batch_id uuid NOT NULL,operation_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','waiting','failed')),created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,
 UNIQUE(user_id,event_key),FOREIGN KEY(batch_id,user_id) REFERENCES recording_batches(id,user_id),FOREIGN KEY(operation_id,user_id) REFERENCES operations(id,user_id)
);
-- Research tasks return durable results to the conversational actor without sharing its session.
ALTER TABLE agent_inbox ALTER COLUMN batch_id DROP NOT NULL;
ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS source_chunks (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL CHECK(source_kind IN ('recording','message')),source_id uuid NOT NULL,source_version integer NOT NULL,
 ordinal integer NOT NULL,start_char integer NOT NULL,end_char integer NOT NULL,start_line integer NOT NULL,end_line integer NOT NULL,text text NOT NULL,content_hash text NOT NULL,
 start_seconds numeric,end_seconds numeric,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),UNIQUE(user_id,source_kind,source_id,source_version,ordinal)
);
CREATE INDEX IF NOT EXISTS source_chunks_lookup ON source_chunks(user_id,source_kind,source_id,source_version,ordinal);
CREATE TABLE IF NOT EXISTS chunk_embeddings (
 chunk_id uuid NOT NULL,user_id uuid NOT NULL,model text NOT NULL,dimensions integer NOT NULL,embedding double precision[] NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chunk_id,model,dimensions),FOREIGN KEY(chunk_id,user_id) REFERENCES source_chunks(id,user_id) ON DELETE CASCADE
);
-- Keep an array copy for portability/recovery; use pgvector whenever the extension is installed.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') THEN
  CREATE EXTENSION IF NOT EXISTS vector;
  EXECUTE 'ALTER TABLE chunk_embeddings ADD COLUMN IF NOT EXISTS vector_data vector';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS source_index_jobs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,
 status text NOT NULL DEFAULT 'queued',stage text NOT NULL DEFAULT 'prepare',attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,last_error text,
 available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,source_kind,source_id,source_version)
);
CREATE TABLE IF NOT EXISTS memory_candidates (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,
 subject text NOT NULL,predicate text NOT NULL,value text NOT NULL,evidence text NOT NULL,source_refs jsonb NOT NULL,person_name text,organization text,
 effective_at timestamptz,person_id uuid,fact_id uuid,status text NOT NULL,comparison jsonb NOT NULL DEFAULT '{}',dedupe_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,dedupe_key),FOREIGN KEY(person_id,user_id) REFERENCES people(id,user_id),FOREIGN KEY(fact_id) REFERENCES facts(id)
);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_refs jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS candidate_actions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),artifact_id uuid NOT NULL,candidate_key text NOT NULL,payload jsonb NOT NULL,source_refs jsonb NOT NULL,
 result_type text,result_id uuid,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(artifact_id,candidate_key),FOREIGN KEY(artifact_id,user_id) REFERENCES recording_artifacts(id,user_id)
);

-- Long-term memory lifecycle. Additive, repeatable migrations preserve old facts and citations.
ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_status_check;
ALTER TABLE facts ADD CONSTRAINT facts_status_check CHECK(status IN ('active','pending','superseded','retracted'));
ALTER TABLE facts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS subject_key text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS predicate_key text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS value_key text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS slot_key text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS claim_key text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS person_label text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS organization text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS effective_date date;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS effective_timezone text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS time_precision text NOT NULL DEFAULT 'unknown';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS time_expression text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_to timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_from timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES facts(id);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES facts(id);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES facts(id);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'warm';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS strength numeric NOT NULL DEFAULT 1;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS half_life_days numeric NOT NULL DEFAULT 180 CHECK(half_life_days>0);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_reinforced_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS facts_memory_slot ON facts(user_id,slot_key,status);
CREATE INDEX IF NOT EXISTS facts_memory_claim ON facts(user_id,claim_key);
CREATE UNIQUE INDEX IF NOT EXISTS facts_id_owner ON facts(id,user_id);
CREATE TABLE IF NOT EXISTS memory_evidence (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),fact_id uuid NOT NULL REFERENCES facts(id),
 source_kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,source_refs jsonb NOT NULL,evidence text NOT NULL,
 observed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(fact_id,source_kind,source_id,source_version),FOREIGN KEY(fact_id,user_id) REFERENCES facts(id,user_id)
);
CREATE INDEX IF NOT EXISTS memory_evidence_source ON memory_evidence(user_id,source_kind,source_id,source_version);
CREATE TABLE IF NOT EXISTS memory_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),fact_id uuid,
 action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_events_owner ON memory_events(user_id,fact_id,id);
CREATE TABLE IF NOT EXISTS memory_suppressions (
 user_id uuid NOT NULL REFERENCES users(id),claim_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,claim_key)
);
CREATE TABLE IF NOT EXISTS memory_source_policies (
 user_id uuid NOT NULL REFERENCES users(id),source_kind text NOT NULL,source_id uuid NOT NULL,allowed boolean NOT NULL,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,source_kind,source_id)
);
CREATE TABLE IF NOT EXISTS memory_maintenance (user_id uuid PRIMARY KEY REFERENCES users(id),last_run_at timestamptz NOT NULL);
ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS memory_epoch integer NOT NULL DEFAULT 0;
-- Composite key is required for tenant-safe evidence references, including upgraded databases.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=2) THEN
  UPDATE facts f SET observed_at=coalesce(r.recorded_at,m.created_at),person_label=p.name,organization=nullif(p.organization,''),
   time_precision=CASE WHEN f.effective_at IS NULL THEN 'unknown' ELSE 'legacy' END,last_reinforced_at=f.created_at
  FROM (SELECT id FROM facts) x LEFT JOIN recordings r ON r.id=(SELECT recording_id FROM facts WHERE id=x.id)
   LEFT JOIN messages m ON m.id=(SELECT message_id FROM facts WHERE id=x.id)
   LEFT JOIN people p ON p.id=(SELECT person_id FROM facts WHERE id=x.id) WHERE f.id=x.id;
  INSERT INTO memory_evidence(id,user_id,fact_id,source_kind,source_id,source_version,source_refs,evidence,observed_at)
   SELECT gen_random_uuid(),user_id,id,CASE WHEN recording_id IS NULL THEN 'message' ELSE 'recording' END,
    coalesce(recording_id,message_id),coalesce(recording_version,1),source_refs,evidence,observed_at FROM facts
    WHERE coalesce(recording_id,message_id) IS NOT NULL ON CONFLICT DO NOTHING;
  INSERT INTO schema_migrations(version) VALUES(2);
 END IF;
END $$;

-- Notifications are business events. Archive old conversational duplicates for audit.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS object_type text NOT NULL DEFAULT 'operation';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(user_id,created_at DESC) WHERE read_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_message ON notifications(user_id,message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(user_id,object_type,object_id) WHERE kind='attention' AND resolved_at IS NULL AND archived_at IS NULL;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS notification_policy text NOT NULL DEFAULT 'always' CHECK(notification_policy IN ('always','on_change'));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=3) THEN
  UPDATE notifications n SET archived_at=now() FROM operations o
   WHERE o.id=n.object_id AND o.user_id=n.user_id AND o.kind='chat' AND n.kind IN ('complete','question');
  UPDATE notifications n SET message_id=m.id FROM messages m
   WHERE m.user_id=n.user_id AND m.dedupe_key=CASE
    WHEN n.kind='reminder' THEN n.dedupe_key
    WHEN n.kind IN ('complete','question') THEN replace(n.dedupe_key,':result:',':response:') END;
  UPDATE notifications n SET message_id=(SELECT m.id FROM messages m WHERE m.user_id=n.user_id
   AND m.operation_id=n.object_id AND m.role='assistant' ORDER BY m.seq DESC LIMIT 1) WHERE n.kind='failure';
  UPDATE notifications n SET object_type=CASE WHEN r.event_id IS NOT NULL THEN 'event' WHEN r.todo_id IS NOT NULL THEN 'todo' ELSE 'reminder' END
   FROM reminders r WHERE n.user_id=r.user_id AND n.dedupe_key='reminder:'||r.id::text;
  UPDATE notifications SET object_type='schedule' WHERE kind='schedule';
  UPDATE notifications n SET title=CASE WHEN n.kind='question' THEN '需要补充信息：' ELSE '任务结果：' END||
   left(coalesce(o.input->>'schedule_title',o.input->>'title',o.input->>'text','语音便签整理'),48)
   FROM operations o WHERE o.id=n.object_id AND o.user_id=n.user_id AND n.kind IN ('complete','question');
  UPDATE notifications SET kind=CASE kind WHEN 'complete' THEN 'task_result' WHEN 'question' THEN 'attention'
   WHEN 'failure' THEN 'attention' WHEN 'schedule' THEN 'attention' ELSE kind END;
  UPDATE notifications n SET resolved_at=now() FROM operations o WHERE n.kind='attention'
   AND n.object_type='operation' AND o.id=n.object_id AND o.user_id=n.user_id AND o.status NOT IN ('waiting','failed');
  UPDATE notifications n SET read_at=now() FROM messages m,conversation_reads r
   WHERE n.message_id=m.id AND n.user_id=m.user_id AND r.user_id=n.user_id AND m.seq<=r.last_read_seq AND n.read_at IS NULL;
  INSERT INTO schema_migrations(version) VALUES(3);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS operations_background_roots ON operations(user_id,created_at DESC,id DESC)
 WHERE kind='trigger' AND input->>'source' IN ('schedule','webhook');
CREATE INDEX IF NOT EXISTS operations_background_delivery ON operations(user_id,(input->>'background_operation_id'))
 WHERE input ? 'background_operation_id';
