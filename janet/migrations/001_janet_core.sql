-- JANET core schema: calls, conversations, transcripts, memory, tasks, callbacks, durable jobs,
-- development tickets, sensitive-action confirmations, integrations and an append-only audit log.
--
-- Access model: the JANET server connects with a privileged database role and is the only writer.
-- Row-level security is enabled on every table with NO policies here, so Supabase's anon/authenticated
-- roles can read nothing. Migration 002 adds owner-only read policies when run inside Rep Site's database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Settings (one row) =====
CREATE TABLE IF NOT EXISTS janet_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  timezone text NOT NULL DEFAULT 'America/New_York',
  calls_paused boolean NOT NULL DEFAULT false,              -- stops every outbound call JANET initiates
  quiet_hours_start text NOT NULL DEFAULT '21:00' CHECK (quiet_hours_start ~ '^\d{2}:\d{2}$'),
  quiet_hours_end text NOT NULL DEFAULT '08:00' CHECK (quiet_hours_end ~ '^\d{2}:\d{2}$'),
  morning_briefing_enabled boolean NOT NULL DEFAULT false,
  morning_briefing_time text NOT NULL DEFAULT '08:15' CHECK (morning_briefing_time ~ '^\d{2}:\d{2}$'),
  evening_briefing_enabled boolean NOT NULL DEFAULT false,
  evening_briefing_time text NOT NULL DEFAULT '18:30' CHECK (evening_briefing_time ~ '^\d{2}:\d{2}$'),
  briefing_days integer[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO weekday, 1 = Monday
  callback_retry_minutes integer NOT NULL DEFAULT 5 CHECK (callback_retry_minutes BETWEEN 1 AND 240),
  callback_max_attempts integer NOT NULL DEFAULT 3 CHECK (callback_max_attempts BETWEEN 1 AND 10),
  transcripts_enabled boolean NOT NULL DEFAULT true,        -- text transcripts only; audio is never stored
  transcript_retention_days integer NOT NULL DEFAULT 365 CHECK (transcript_retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO janet_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ===== Conversations and transcripts =====
CREATE TABLE IF NOT EXISTS janet_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  summary_status text NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','done','failed','skipped')),
  topics text[] NOT NULL DEFAULT '{}',
  structured jsonb NOT NULL DEFAULT '{}'::jsonb,          -- decisions, follow_ups, open_questions
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS janet_conversations_recent ON janet_conversations (started_at DESC);
CREATE INDEX IF NOT EXISTS janet_conversations_search ON janet_conversations USING gin (search);

CREATE TABLE IF NOT EXISTS janet_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES janet_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content text NOT NULL,
  tool_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS janet_messages_conv ON janet_messages (conversation_id, id);

-- ===== Calls =====
CREATE TABLE IF NOT EXISTS janet_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  purpose text NOT NULL DEFAULT 'conversation' CHECK (purpose IN ('conversation','callback','briefing')),
  from_number text NOT NULL DEFAULT '',
  to_number text NOT NULL DEFAULT '',
  authorized boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN (
    'initiated','ringing','in_progress','completed','no_answer','busy','failed','canceled','rejected_unauthorized','voicemail')),
  answered_by text,
  conversation_id uuid REFERENCES janet_conversations(id) ON DELETE SET NULL,
  callback_id uuid,
  briefing_kind text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer
);
CREATE INDEX IF NOT EXISTS janet_calls_recent ON janet_calls (created_at DESC);

-- ===== Memory =====
CREATE TABLE IF NOT EXISTS janet_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('preference','project','decision','fact','milestone','person','commitment','deadline','meeting')),
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  source text NOT NULL DEFAULT 'conversation' CHECK (source IN ('conversation','voice_explicit','dashboard')),
  source_conversation_id uuid REFERENCES janet_conversations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  superseded_by uuid REFERENCES janet_memories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject,'') || ' ' || content)) STORED
);
CREATE INDEX IF NOT EXISTS janet_memories_search ON janet_memories USING gin (search);
CREATE INDEX IF NOT EXISTS janet_memories_active ON janet_memories (kind, updated_at DESC) WHERE status = 'active';

-- ===== Tasks =====
CREATE TABLE IF NOT EXISTS janet_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref integer GENERATED ALWAYS AS IDENTITY UNIQUE,         -- short number you can say on the phone ("task 12")
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  source_conversation_id uuid REFERENCES janet_conversations(id) ON DELETE SET NULL,
  owner text NOT NULL DEFAULT 'me' CHECK (length(owner) <= 80),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at timestamptz,
  due_timezone text NOT NULL DEFAULT 'America/New_York',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','blocked','failed','cancelled')),
  required_integrations text[] NOT NULL DEFAULT '{}',
  next_follow_up_at timestamptz,
  completion_evidence text NOT NULL DEFAULT '' CHECK (length(completion_evidence) <= 2000),
  created_via text NOT NULL DEFAULT 'voice' CHECK (created_via IN ('voice','dashboard','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS janet_tasks_open ON janet_tasks (status, due_at);

-- ===== Callbacks =====
CREATE TABLE IF NOT EXISTS janet_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  requested_text text NOT NULL DEFAULT '',                 -- what you said, for audit
  source_conversation_id uuid REFERENCES janet_conversations(id) ON DELETE SET NULL,
  scheduled_for timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  override_quiet_hours boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled','dialing','in_progress','completed','retry_scheduled','no_answer','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz,
  last_call_id uuid REFERENCES janet_calls(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS janet_callbacks_upcoming ON janet_callbacks (status, scheduled_for);

-- ===== Durable job queue (callbacks, retries, summaries, briefings) =====
CREATE TABLE IF NOT EXISTS janet_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('place_callback','summarize_conversation','place_briefing','retention')),
  idempotency_key text NOT NULL UNIQUE,                    -- the same work can never be queued twice
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_until timestamptz,                                -- lease: a crashed worker's job becomes claimable again
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS janet_jobs_due ON janet_jobs (run_at) WHERE status IN ('queued','running');

-- ===== Development tickets for Claude Code =====
CREATE TABLE IF NOT EXISTS janet_dev_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  problem text NOT NULL CHECK (length(problem) <= 6000),
  component text NOT NULL DEFAULT '' CHECK (length(component) <= 200),
  reproduction text NOT NULL DEFAULT '' CHECK (length(reproduction) <= 4000),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  acceptance_criteria text[] NOT NULL DEFAULT '{}',
  follow_up_at timestamptz,
  -- created: written down only. submitted: handed to a runner. in_progress: a runner is working.
  -- fix_proposed: a change exists but is NOT verified. verified: confirmed working. closed/rejected.
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','submitted','in_progress','fix_proposed','verified','closed','rejected')),
  external_ref text,
  source_conversation_id uuid REFERENCES janet_conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Sensitive actions awaiting your spoken confirmation =====
CREATE TABLE IF NOT EXISTS janet_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES janet_conversations(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  summary text NOT NULL,
  user_turns_at_creation integer NOT NULL,                 -- confirmation needs a NEW utterance from you
  status text NOT NULL DEFAULT 'awaiting_confirmation' CHECK (status IN ('awaiting_confirmation','executed','rejected','expired','failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

-- ===== Integrations (secrets encrypted; never readable from a browser) =====
CREATE TABLE IF NOT EXISTS janet_integrations (
  provider text PRIMARY KEY CHECK (provider IN ('google_calendar')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  account_email text,
  scopes text[] NOT NULL DEFAULT '{}',
  token_ciphertext text,                                   -- AES-256-GCM, key from JANET_ENCRYPTION_KEY
  connected_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz
);

-- ===== Audit log (append-only) =====
CREATE TABLE IF NOT EXISTS janet_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor IN ('voice','dashboard','system','twilio')),
  action text NOT NULL,
  target text,
  conversation_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS janet_audit_recent ON janet_audit (at DESC);

CREATE OR REPLACE FUNCTION janet_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'janet_audit is append-only'; END $$;
DROP TRIGGER IF EXISTS janet_audit_no_change ON janet_audit;
CREATE TRIGGER janet_audit_no_change BEFORE UPDATE OR DELETE ON janet_audit
  FOR EACH ROW EXECUTE FUNCTION janet_audit_immutable();

-- ===== Lock everything down =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['janet_settings','janet_conversations','janet_messages','janet_calls','janet_memories',
    'janet_tasks','janet_callbacks','janet_jobs','janet_dev_tickets','janet_pending_actions','janet_integrations','janet_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
