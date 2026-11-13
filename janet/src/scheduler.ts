// Durable background worker. All scheduled work lives in janet_jobs (Postgres), so it survives restarts:
// a job is claimed with a lease; if the process dies mid-job, the lease expires and the job is picked up again.
// Duplicate outbound calls are prevented twice over: unique job idempotency keys, and an atomic
// scheduled -> dialing transition on the callback row that only one worker can win.
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { q } from "./db.js";
import * as store from "./store.js";
import { inQuietHours, nextAllowed, validZone } from "./time.js";
import { summarizeConversation } from "./summarize.js";

type Dialer = (p: { purpose: "callback" | "briefing"; callbackId?: string; briefingKind?: "morning" | "evening" }) => Promise<{ callId: string; sid: string }>;

let dialer: Dialer | null = null;
/** Injected at startup (twilio.placeOutboundCall) and in tests. */
export function setDialer(d: Dialer) {
  dialer = d;
}

class Deferred {
  constructor(public until: Date, public why: string) {}
}

async function deferJob(job: store.JobRow, until: Date, why: string) {
  // Waiting is not a failed attempt.
  await q("UPDATE janet_jobs SET status='queued', run_at=$2, attempts=greatest(attempts-1,0), locked_until=NULL, last_error=$3, updated_at=now() WHERE id=$1", [
    job.id,
    until,
    `deferred: ${why}`,
  ]);
}

// ---------- callbacks ----------
async function runCallbackJob(job: store.JobRow) {
  const cb = await store.getCallback(job.payload.callbackId);
  if (!cb || !["scheduled", "retry_scheduled"].includes(cb.status)) return; // cancelled, done, or already dialing
  const s = await store.getSettings();
  if (s.calls_paused) throw new Deferred(new Date(Date.now() + 10 * 60_000), "outbound calls paused");
  const zone = validZone(cb.timezone, config.defaultTimezone);
  const now = new Date();
  if (!cb.override_quiet_hours && inQuietHours(now, zone, s.quiet_hours_start, s.quiet_hours_end)) {
    const until = nextAllowed(now, zone, s.quiet_hours_start, s.quiet_hours_end);
    await store.updateCallback(cb.id, { next_attempt_at: until });
    throw new Deferred(until, "quiet hours");
  }
  const claimed = await store.claimCallbackForDial(cb.id);
  if (!claimed) return; // another worker won the race
  if (!dialer) throw new Error("No dialer configured");
  try {
    const r = await dialer({ purpose: "callback", callbackId: cb.id });
    await store.updateCallback(cb.id, { last_call_id: r.callId, last_error: null, next_attempt_at: null });
  } catch (e) {
    const callId = (e as any).callId as string | undefined;
    if (callId) await store.updateCallback(cb.id, { last_call_id: callId });
    await handleCallbackMissed(cb.id, "failed", (e as Error).message);
  }
}

/** A callback attempt didn't connect (no answer, busy, voicemail, failed): retry or give up. */
export async function handleCallbackMissed(callbackId: string, outcome: string, error?: string) {
  const cb = await store.getCallback(callbackId);
  if (!cb || !["dialing", "in_progress"].includes(cb.status)) return; // already handled (status callbacks can repeat)
  const s = await store.getSettings();
  if (cb.attempts < cb.max_attempts) {
    const zone = validZone(cb.timezone, config.defaultTimezone);
    let next = new Date(Date.now() + s.callback_retry_minutes * 60_000);
    if (!cb.override_quiet_hours) next = nextAllowed(next, zone, s.quiet_hours_start, s.quiet_hours_end);
    const attempt = cb.attempts + 1;
    await store.updateCallback(cb.id, { status: "retry_scheduled", next_attempt_at: next, last_error: error ?? outcome });
    await store.enqueueJob("place_callback", `callback:${cb.id}:attempt:${attempt}`, { callbackId: cb.id, attempt }, next, 3);
    await audit("system", "callback.retry_scheduled", { target: cb.id, detail: { outcome, attempt, at: next, error } });
  } else {
    const final = outcome === "failed" ? "failed" : "no_answer";
    await store.updateCallback(cb.id, { status: final, next_attempt_at: null, last_error: error ?? outcome });
    await audit("system", "callback.gave_up", { target: cb.id, detail: { outcome, attempts: cb.attempts, error } });
  }
}

// ---------- briefings ----------
export function nextBriefingTime(localTime: string, days: number[], zone: string, now: DateTime): DateTime | null {
  const [h, m] = localTime.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const d = now.setZone(zone).plus({ days: i }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (d > now && days.includes(d.weekday)) return d;
  }
  return null;
}

async function planBriefings(now = DateTime.now()) {
  const s = await store.getSettings();
  const zone = validZone(s.timezone, config.defaultTimezone);
  for (const kind of ["morning", "evening"] as const) {
    const enabled = kind === "morning" ? s.morning_briefing_enabled : s.evening_briefing_enabled;
    if (!enabled) continue;
    const at = nextBriefingTime(kind === "morning" ? s.morning_briefing_time : s.evening_briefing_time, s.briefing_days, zone, now);
    if (at) await store.enqueueJob("place_briefing", `briefing:${kind}:${at.toISODate()}`, { kind, date: at.toISODate() }, at.toJSDate(), 2);
  }
}

async function runBriefingJob(job: store.JobRow) {
  const s = await store.getSettings();
  const kind = job.payload.kind as "morning" | "evening";
  const enabled = kind === "morning" ? s.morning_briefing_enabled : s.evening_briefing_enabled;
  if (!enabled || s.calls_paused) {
    await audit("system", "briefing.skipped", { detail: { kind, reason: !enabled ? "disabled" : "calls paused" } });
    return;
  }
  // Avoid unnecessary calls: skip when there's nothing to report.
  const [{ n }] = await q<{ n: number }>(
    `SELECT (SELECT count(*) FROM janet_tasks WHERE status IN ('pending','in_progress','blocked'))
          + (SELECT count(*) FROM janet_tasks WHERE completed_at > now() - interval '18 hours')
          + (SELECT count(*) FROM janet_dev_tickets WHERE status NOT IN ('verified','closed','rejected')) AS n`,
  );
  const calendarConnected = (await q("SELECT 1 FROM janet_integrations WHERE provider='google_calendar' AND status='connected'")).length > 0;
  if (Number(n) === 0 && !calendarConnected) {
    await audit("system", "briefing.skipped", { detail: { kind, reason: "nothing to report" } });
    return;
  }
  if (!dialer) throw new Error("No dialer configured");
  await dialer({ purpose: "briefing", briefingKind: kind });
}

// ---------- housekeeping ----------
async function sweep() {
  // A worker that died between "dialing" and reaching Twilio leaves a callback with no call. We do NOT redial
  // automatically (we can't prove Twilio didn't place it); it is marked failed and shown on the dashboard.
  const stuck = await q<{ id: string }>(
    "SELECT id FROM janet_callbacks WHERE status = 'dialing' AND last_call_id IS NULL AND updated_at < now() - interval '3 minutes'",
  );
  for (const c of stuck) {
    await store.updateCallback(c.id, { status: "failed", last_error: "Interrupted while dialing; not retried automatically to avoid a duplicate call" });
    await audit("system", "callback.interrupted", { target: c.id });
  }
  // Calls that never got a final status from Twilio.
  await q("UPDATE janet_calls SET status='failed', error=coalesce(error,'no final status from Twilio'), ended_at=now() WHERE status IN ('initiated','ringing') AND created_at < now() - interval '15 minutes'");
  await q("UPDATE janet_calls SET status='completed', ended_at=now() WHERE status='in_progress' AND answered_at < now() - interval '4 hours'");
  const today = DateTime.now().toISODate();
  await store.enqueueJob("retention", `retention:${today}`, {}, new Date(), 2);
}

async function runRetention() {
  const s = await store.getSettings();
  const r = await q("DELETE FROM janet_messages WHERE created_at < now() - make_interval(days => $1) RETURNING id", [s.transcript_retention_days]);
  if (r.length) await audit("system", "retention.transcripts_deleted", { detail: { rows: r.length, older_than_days: s.transcript_retention_days } });
}

// ---------- worker loop ----------
export async function runJob(job: store.JobRow) {
  switch (job.kind) {
    case "place_callback":
      return runCallbackJob(job);
    case "place_briefing":
      return runBriefingJob(job);
    case "summarize_conversation":
      return summarizeConversation(job.payload.conversationId);
    case "retention":
      return runRetention();
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

export async function tick(workerId: string) {
  const jobs = await store.claimJobs(workerId, 5, 120);
  for (const job of jobs) {
    try {
      await runJob(job);
      await store.finishJob(job.id);
    } catch (e) {
      if (e instanceof Deferred) {
        await deferJob(job, e.until, e.why);
        continue;
      }
      const dead = await store.failJob(job, (e as Error).message);
      console.error(`job ${job.kind} ${job.id} failed${dead ? " permanently" : ""}:`, (e as Error).message);
      if (dead) await audit("system", "job.dead", { target: job.id, detail: { kind: job.kind, error: (e as Error).message } });
    }
  }
  return jobs.length;
}

export function startWorker() {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let lastHousekeeping = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastHousekeeping > 60_000) {
          lastHousekeeping = Date.now();
          await planBriefings();
          await sweep();
        }
        await tick(workerId);
      } catch (e) {
        console.error("worker loop error", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, config.workerPollMs));
    }
  };
  loop();
  console.log(`JANET worker ${workerId} started`);
  return () => {
    stopped = true;
  };
}

export const _internal = { planBriefings, sweep };
