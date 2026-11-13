// Data access for JANET. Every write the voice model can trigger goes through these functions,
// which validate input and never accept raw SQL.
import type pg from "pg";
import { q, q1, tx } from "./db.js";

// ---------- settings ----------
export type Settings = {
  timezone: string;
  calls_paused: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  morning_briefing_enabled: boolean;
  morning_briefing_time: string;
  evening_briefing_enabled: boolean;
  evening_briefing_time: string;
  briefing_days: number[];
  callback_retry_minutes: number;
  callback_max_attempts: number;
  transcripts_enabled: boolean;
  transcript_retention_days: number;
};

export async function getSettings(): Promise<Settings> {
  const s = await q1<Settings>("SELECT * FROM janet_settings WHERE id = 1");
  if (!s) throw new Error("janet_settings row missing: run migrations");
  return s;
}

const SETTINGS_FIELDS: Record<keyof Settings, (v: unknown) => boolean> = {
  timezone: (v) => typeof v === "string" && v.length < 64,
  calls_paused: (v) => typeof v === "boolean",
  quiet_hours_start: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  quiet_hours_end: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  morning_briefing_enabled: (v) => typeof v === "boolean",
  morning_briefing_time: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  evening_briefing_enabled: (v) => typeof v === "boolean",
  evening_briefing_time: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  briefing_days: (v) => Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7),
  callback_retry_minutes: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 240,
  callback_max_attempts: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10,
  transcripts_enabled: (v) => typeof v === "boolean",
  transcript_retention_days: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
};

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const check = SETTINGS_FIELDS[k as keyof Settings];
    if (!check) throw new Error(`Unknown setting ${k}`);
    if (!check(v)) throw new Error(`Invalid value for ${k}`);
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length) await q(`UPDATE janet_settings SET ${sets.join(", ")}, updated_at = now() WHERE id = 1`, vals);
  return getSettings();
}

// ---------- conversations & transcripts ----------
export async function createConversation(title = ""): Promise<string> {
  const r = await q1<{ id: string }>("INSERT INTO janet_conversations (title) VALUES ($1) RETURNING id", [title]);
  return r!.id;
}

export async function addMessage(conversationId: string, role: "user" | "assistant" | "tool" | "system", content: string, toolName?: string) {
  if (!content.trim()) return;
  await q("INSERT INTO janet_messages (conversation_id, role, content, tool_name) VALUES ($1,$2,$3,$4)", [
    conversationId,
    role,
    content.slice(0, 20000),
    toolName ?? null,
  ]);
}

export async function endConversation(conversationId: string) {
  await q("UPDATE janet_conversations SET ended_at = coalesce(ended_at, now()) WHERE id = $1", [conversationId]);
}

export async function getTranscript(conversationId: string, limit = 400) {
  return q<{ role: string; content: string; tool_name: string | null; created_at: Date }>(
    `SELECT role, content, tool_name, created_at FROM (
       SELECT * FROM janet_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
     ) m ORDER BY id`,
    [conversationId, limit],
  );
}

export async function getConversation(id: string) {
  return q1("SELECT id, started_at, ended_at, title, summary, summary_status, topics, structured FROM janet_conversations WHERE id = $1", [id]);
}

export async function recentConversations(limit = 3, excludeId?: string) {
  return q(
    `SELECT id, started_at, title, summary, summary_status FROM janet_conversations
     WHERE ($2::uuid IS NULL OR id <> $2) AND (summary_status = 'done' OR ended_at IS NOT NULL)
     ORDER BY started_at DESC LIMIT $1`,
    [limit, excludeId ?? null],
  );
}

// ---------- calls ----------
export type CallRow = {
  id: string;
  call_sid: string | null;
  direction: "inbound" | "outbound";
  purpose: "conversation" | "callback" | "briefing";
  from_number: string;
  to_number: string;
  authorized: boolean;
  status: string;
  conversation_id: string | null;
  callback_id: string | null;
  briefing_kind: string | null;
  answered_by: string | null;
  created_at: Date;
};

export async function createCall(c: {
  callSid?: string | null;
  direction: "inbound" | "outbound";
  purpose?: "conversation" | "callback" | "briefing";
  from: string;
  to: string;
  authorized: boolean;
  status?: string;
  callbackId?: string | null;
  briefingKind?: string | null;
}): Promise<CallRow> {
  const r = await q1<CallRow>(
    `INSERT INTO janet_calls (call_sid, direction, purpose, from_number, to_number, authorized, status, callback_id, briefing_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (call_sid) DO UPDATE SET call_sid = EXCLUDED.call_sid
     RETURNING *`,
    [c.callSid ?? null, c.direction, c.purpose ?? "conversation", c.from, c.to, c.authorized, c.status ?? "initiated", c.callbackId ?? null, c.briefingKind ?? null],
  );
  return r!;
}

export async function getCall(id: string) {
  return q1<CallRow>("SELECT * FROM janet_calls WHERE id = $1", [id]);
}
export async function getCallBySid(sid: string) {
  return q1<CallRow>("SELECT * FROM janet_calls WHERE call_sid = $1", [sid]);
}

export async function updateCall(id: string, patch: Partial<{ call_sid: string; status: string; conversation_id: string; answered_by: string; error: string; answered_at: Date; ended_at: Date; duration_seconds: number }>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(id);
  await q(`UPDATE janet_calls SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

// ---------- tasks ----------
export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked", "failed", "cancelled"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskRow = {
  id: string;
  ref: number;
  title: string;
  description: string;
  owner: string;
  priority: string;
  due_at: Date | null;
  due_timezone: string;
  status: TaskStatus;
  required_integrations: string[];
  next_follow_up_at: Date | null;
  completion_evidence: string;
  source_conversation_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function createTask(t: {
  title: string;
  description?: string;
  owner?: string;
  priority?: string;
  dueAt?: Date | null;
  dueTimezone?: string;
  requiredIntegrations?: string[];
  nextFollowUpAt?: Date | null;
  conversationId?: string | null;
  createdVia?: "voice" | "dashboard" | "system";
}): Promise<TaskRow> {
  const r = await q1<TaskRow>(
    `INSERT INTO janet_tasks (title, description, owner, priority, due_at, due_timezone, required_integrations, next_follow_up_at, source_conversation_id, created_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      t.title.trim().slice(0, 200),
      (t.description ?? "").slice(0, 4000),
      (t.owner ?? "me").slice(0, 80),
      PRIORITIES.includes(t.priority as any) ? t.priority : "normal",
      t.dueAt ?? null,
      t.dueTimezone ?? "America/New_York",
      t.requiredIntegrations ?? [],
      t.nextFollowUpAt ?? null,
      t.conversationId ?? null,
      t.createdVia ?? "voice",
    ],
  );
  return r!;
}

export async function findTask(idOrRef: string | number): Promise<TaskRow | null> {
  if (typeof idOrRef === "number" || /^\d+$/.test(String(idOrRef))) {
    return q1<TaskRow>("SELECT * FROM janet_tasks WHERE ref = $1", [Number(idOrRef)]);
  }
  if (/^[0-9a-f-]{36}$/i.test(String(idOrRef))) return q1<TaskRow>("SELECT * FROM janet_tasks WHERE id = $1", [idOrRef]);
  return null;
}

export async function updateTask(
  id: string,
  patch: Partial<{ title: string; description: string; status: TaskStatus; priority: string; due_at: Date | null; owner: string; completion_evidence: string; next_follow_up_at: Date | null }>,
): Promise<TaskRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "status" && !TASK_STATUSES.includes(v as TaskStatus)) throw new Error(`Invalid status ${v}`);
    if (k === "priority" && !PRIORITIES.includes(v as any)) throw new Error(`Invalid priority ${v}`);
    if (!["title", "description", "status", "priority", "due_at", "owner", "completion_evidence", "next_follow_up_at"].includes(k)) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return findTask(id);
  if (patch.status === "completed") sets.push("completed_at = now()");
  else if (patch.status) sets.push("completed_at = NULL");
  vals.push(id);
  return q1<TaskRow>(`UPDATE janet_tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
}

export async function listTasks(opts: { status?: string[]; search?: string; limit?: number } = {}) {
  return q<TaskRow>(
    `SELECT * FROM janet_tasks
     WHERE ($1::text[] IS NULL OR status = ANY($1))
       AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
              CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              due_at NULLS LAST, created_at DESC
     LIMIT $3`,
    [opts.status ?? null, opts.search ?? null, Math.min(opts.limit ?? 20, 200)],
  );
}

// ---------- memory ----------
export const MEMORY_KINDS = ["preference", "project", "decision", "fact", "milestone", "person", "commitment", "deadline", "meeting"] as const;

export async function addMemory(m: { kind: string; subject?: string; content: string; source?: "conversation" | "voice_explicit" | "dashboard"; conversationId?: string | null }) {
  const kind = MEMORY_KINDS.includes(m.kind as any) ? m.kind : "fact";
  return q1(
    `INSERT INTO janet_memories (kind, subject, content, source, source_conversation_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [kind, (m.subject ?? "").slice(0, 200), m.content.slice(0, 4000), m.source ?? "conversation", m.conversationId ?? null],
  );
}

export async function searchMemory(query: string, limit = 8) {
  const memories = await q(
    `SELECT id, kind, subject, content, updated_at, ts_rank(search, websearch_to_tsquery('english', $1)) AS rank
     FROM janet_memories
     WHERE status = 'active' AND (search @@ websearch_to_tsquery('english', $1) OR subject ILIKE '%' || $1 || '%')
     ORDER BY rank DESC, updated_at DESC LIMIT $2`,
    [query, limit],
  );
  const conversations = await q(
    `SELECT id, started_at, title, summary FROM janet_conversations
     WHERE summary_status = 'done' AND search @@ websearch_to_tsquery('english', $1)
     ORDER BY ts_rank(search, websearch_to_tsquery('english', $1)) DESC, started_at DESC LIMIT 4`,
    [query],
  );
  return { memories, conversations };
}

export async function listMemories(opts: { kinds?: string[]; limit?: number; includeInactive?: boolean } = {}) {
  return q(
    `SELECT id, kind, subject, content, source, status, created_at, updated_at FROM janet_memories
     WHERE ($1::text[] IS NULL OR kind = ANY($1)) AND ($3 OR status = 'active')
     ORDER BY updated_at DESC LIMIT $2`,
    [opts.kinds ?? null, Math.min(opts.limit ?? 30, 500), !!opts.includeInactive],
  );
}

/** Correct a memory: the old one is kept as superseded history, the new one becomes active. */
export async function correctMemory(id: string, newContent: string) {
  return tx(async (c) => {
    const old = (await c.query("SELECT * FROM janet_memories WHERE id = $1 AND status = 'active' FOR UPDATE", [id])).rows[0];
    if (!old) return null;
    const fresh = (
      await c.query(
        `INSERT INTO janet_memories (kind, subject, content, source, source_conversation_id) VALUES ($1,$2,$3,'voice_explicit',$4) RETURNING *`,
        [old.kind, old.subject, newContent.slice(0, 4000), old.source_conversation_id],
      )
    ).rows[0];
    await c.query("UPDATE janet_memories SET status = 'superseded', superseded_by = $2, updated_at = now() WHERE id = $1", [id, fresh.id]);
    return fresh;
  });
}

/** Delete a memory: content is erased, not just hidden. */
export async function deleteMemory(id: string) {
  const r = await q1(
    "UPDATE janet_memories SET status = 'deleted', content = '[deleted]', subject = '', updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING id",
    [id],
  );
  return !!r;
}

// ---------- jobs (durable queue) ----------
export type JobRow = {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: any;
  run_at: Date;
  status: string;
  attempts: number;
  max_attempts: number;
};

export async function enqueueJob(
  kind: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  runAt: Date = new Date(),
  maxAttempts = 5,
  client?: pg.PoolClient,
): Promise<JobRow | null> {
  const sql = `INSERT INTO janet_jobs (kind, idempotency_key, payload, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`;
  const params = [kind, idempotencyKey, JSON.stringify(payload), runAt, maxAttempts];
  const rows = client ? (await client.query(sql, params)).rows : await q(sql, params);
  return (rows[0] as JobRow) ?? null;
}

/** Claim due jobs. A job whose lease expired (worker crashed) becomes claimable again. */
export async function claimJobs(workerId: string, limit = 5, leaseSeconds = 120): Promise<JobRow[]> {
  return q<JobRow>(
    `UPDATE janet_jobs SET status = 'running', attempts = attempts + 1, locked_by = $1,
            locked_until = now() + make_interval(secs => $3), updated_at = now()
     WHERE id IN (
       SELECT id FROM janet_jobs
       WHERE (status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_until < now())
       ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $2)
     RETURNING *`,
    [workerId, limit, leaseSeconds],
  );
}

export async function finishJob(id: string) {
  await q("UPDATE janet_jobs SET status = 'succeeded', locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [id]);
}

export async function failJob(job: JobRow, error: string) {
  const dead = job.attempts >= job.max_attempts;
  const backoffSec = Math.min(30 * 2 ** (job.attempts - 1), 1800);
  await q(
    `UPDATE janet_jobs SET status = $2, last_error = $3, locked_until = NULL,
            run_at = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4) ELSE run_at END, updated_at = now()
     WHERE id = $1`,
    [job.id, dead ? "dead" : "queued", error.slice(0, 2000), backoffSec],
  );
  return dead;
}

export async function cancelJobs(idempotencyKeyPrefix: string) {
  await q("UPDATE janet_jobs SET status = 'cancelled', updated_at = now() WHERE status = 'queued' AND idempotency_key LIKE $1 || '%'", [idempotencyKeyPrefix]);
}

// ---------- callbacks ----------
export type CallbackRow = {
  id: string;
  reason: string;
  requested_text: string;
  source_conversation_id: string | null;
  scheduled_for: Date;
  timezone: string;
  override_quiet_hours: boolean;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_call_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function scheduleCallback(c: {
  reason: string;
  requestedText?: string;
  conversationId?: string | null;
  at: Date;
  zone: string;
  overrideQuietHours?: boolean;
  maxAttempts: number;
}): Promise<CallbackRow> {
  return tx(async (client) => {
    const cb = (
      await client.query(
        `INSERT INTO janet_callbacks (reason, requested_text, source_conversation_id, scheduled_for, timezone, override_quiet_hours, max_attempts, next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$4) RETURNING *`,
        [c.reason.slice(0, 500), (c.requestedText ?? "").slice(0, 1000), c.conversationId ?? null, c.at, c.zone, !!c.overrideQuietHours, c.maxAttempts],
      )
    ).rows[0] as CallbackRow;
    await enqueueJob("place_callback", `callback:${cb.id}:attempt:1`, { callbackId: cb.id, attempt: 1 }, c.at, 3, client);
    return cb;
  });
}

export async function getCallback(id: string) {
  return q1<CallbackRow>("SELECT * FROM janet_callbacks WHERE id = $1", [id]);
}

/** Atomically move a callback into "dialing". Returns null if another worker already did, or it was cancelled. */
export async function claimCallbackForDial(id: string): Promise<CallbackRow | null> {
  return q1<CallbackRow>(
    `UPDATE janet_callbacks SET status = 'dialing', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('scheduled','retry_scheduled') RETURNING *`,
    [id],
  );
}

export async function updateCallback(id: string, patch: Partial<{ status: string; last_call_id: string; last_error: string | null; next_attempt_at: Date | null; scheduled_for: Date }>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(id);
  await q(`UPDATE janet_callbacks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
}

export async function cancelCallback(id: string): Promise<boolean> {
  const r = await q1(
    "UPDATE janet_callbacks SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('scheduled','retry_scheduled') RETURNING id",
    [id],
  );
  if (r) await cancelJobs(`callback:${id}:`);
  return !!r;
}

export async function listCallbacks(opts: { upcomingOnly?: boolean; limit?: number } = {}) {
  return q<CallbackRow>(
    `SELECT * FROM janet_callbacks
     WHERE NOT $1 OR status IN ('scheduled','retry_scheduled','dialing','in_progress')
     ORDER BY CASE WHEN status IN ('scheduled','retry_scheduled','dialing','in_progress') THEN 0 ELSE 1 END,
              coalesce(next_attempt_at, scheduled_for) ${opts.upcomingOnly ? "ASC" : "DESC"}
     LIMIT $2`,
    [!!opts.upcomingOnly, Math.min(opts.limit ?? 20, 200)],
  );
}

// ---------- dev tickets ----------
export async function createDevTicket(t: {
  title: string;
  problem: string;
  component?: string;
  reproduction?: string;
  priority?: string;
  acceptanceCriteria?: string[];
  followUpAt?: Date | null;
  conversationId?: string | null;
}) {
  return q1(
    `INSERT INTO janet_dev_tickets (title, problem, component, reproduction, priority, acceptance_criteria, follow_up_at, source_conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      t.title.slice(0, 200),
      t.problem.slice(0, 6000),
      (t.component ?? "").slice(0, 200),
      (t.reproduction ?? "").slice(0, 4000),
      PRIORITIES.includes(t.priority as any) ? t.priority : "normal",
      (t.acceptanceCriteria ?? []).slice(0, 20).map((s) => s.slice(0, 500)),
      t.followUpAt ?? null,
      t.conversationId ?? null,
    ],
  );
}

export async function listDevTickets(limit = 20) {
  return q("SELECT * FROM janet_dev_tickets ORDER BY created_at DESC LIMIT $1", [limit]);
}

// ---------- sensitive-action confirmations ----------
export async function createPendingAction(conversationId: string, toolName: string, args: unknown, summary: string, userTurns: number) {
  // Only one pending action per conversation at a time; a new request replaces an unanswered one.
  await q("UPDATE janet_pending_actions SET status = 'expired', decided_at = now() WHERE conversation_id = $1 AND status = 'awaiting_confirmation'", [conversationId]);
  return q1<{ id: string }>(
    "INSERT INTO janet_pending_actions (conversation_id, tool_name, args, summary, user_turns_at_creation) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [conversationId, toolName, JSON.stringify(args), summary, userTurns],
  );
}

export async function getPendingAction(id: string) {
  return q1<{ id: string; conversation_id: string; tool_name: string; args: any; summary: string; user_turns_at_creation: number; status: string; created_at: Date }>(
    "SELECT * FROM janet_pending_actions WHERE id = $1",
    [id],
  );
}

export async function decidePendingAction(id: string, status: "executed" | "rejected" | "expired" | "failed", result?: unknown) {
  return q1(
    "UPDATE janet_pending_actions SET status = $2, result = $3, decided_at = now() WHERE id = $1 AND status = 'awaiting_confirmation' RETURNING id",
    [id, status, result === undefined ? null : JSON.stringify(result)],
  );
}

export async function q_markAuthorized(callId: string, conversationId: string) {
  await q("UPDATE janet_calls SET authorized = true, conversation_id = $2 WHERE id = $1", [callId, conversationId]);
}
