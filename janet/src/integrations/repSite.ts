// Rep Site read-only adapter. Runs fixed queries (no model-written SQL) against Rep Site's Supabase database inside
// a READ ONLY transaction with a short timeout. Results are labelled with their source and time so JANET can say
// exactly where a number came from. Rows contain names only, never emails or phone numbers.
import { config } from "../config.js";
import { getPool } from "../db.js";

export type RepSiteResult = { available: true; source: string; as_of: string; data: unknown } | { available: false; reason: string };

async function readOnly(source: string, fn: (run: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<unknown>): Promise<RepSiteResult> {
  if (!config.repSiteReadEnabled) return { available: false, reason: "Rep Site access is not enabled (REP_SITE_READ_ENABLED is off)" };
  const c = await getPool().connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '8s'");
    const data = await fn(async (sql, p = []) => (await c.query(sql, p)).rows);
    await c.query("COMMIT");
    return { available: true, source, as_of: new Date().toISOString(), data };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    return { available: false, reason: `Rep Site query failed: ${(e as Error).message}` };
  } finally {
    c.release();
  }
}

export const repSite = {
  /** Reps who have not finished required University training, least recently active first. */
  trainingProgress: () =>
    readOnly("Rep Site University (profiles, lesson_progress, university_graduated)", async (run) => {
      const reps = await run(`
        SELECT p.full_name AS name,
               public.university_graduated(p.id) AS graduated,
               (SELECT count(*) FROM public.lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at IS NOT NULL) AS lessons_completed,
               (SELECT max(lp.last_watched_at) FROM public.lesson_progress lp WHERE lp.user_id = p.id) AS last_activity
        FROM public.profiles p
        WHERE p.status = 'approved' AND NOT public.has_role(p.id, 'admin')
        ORDER BY last_activity NULLS FIRST LIMIT 200`);
      const notGraduated = reps.filter((r) => !r.graduated);
      const weekAgo = Date.now() - 7 * 864e5;
      return {
        approved_reps: reps.length,
        graduated: reps.length - notGraduated.length,
        not_graduated: notGraduated.length,
        falling_behind: notGraduated
          .filter((r) => !r.last_activity || new Date(r.last_activity).getTime() < weekAgo)
          .slice(0, 15)
          .map((r) => ({ name: r.name, lessons_completed: r.lessons_completed, last_activity: r.last_activity })),
        definition: "falling_behind = approved rep, required training not finished, no lesson activity in 7 days",
      };
    }),

  /** Field Intelligence processing: are recordings being transcribed? */
  fieldIntelligence: () =>
    readOnly("Rep Site Field Intelligence (fi_recordings, fi_processing_jobs)", async (run) => {
      const recordings = await run(`
        SELECT processing_status, count(*)::int AS n FROM public.fi_recordings
        WHERE status = 'uploaded' AND created_at > now() - interval '7 days' GROUP BY 1`);
      const jobs = await run(`
        SELECT stage, status, count(*)::int AS n FROM public.fi_processing_jobs
        WHERE created_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 1, 2`);
      const stuck = await run(`
        SELECT stage, count(*)::int AS n, min(created_at) AS oldest FROM public.fi_processing_jobs
        WHERE status IN ('queued','running') AND created_at < now() - interval '1 hour' GROUP BY 1`);
      const errors = await run(`
        SELECT stage, left(last_error, 200) AS error, count(*)::int AS n FROM public.fi_processing_jobs
        WHERE status IN ('failed','dead') AND updated_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY n DESC LIMIT 5`);
      return { window: "last 7 days", recordings_by_processing_status: recordings, jobs_by_stage_and_status: jobs, stuck_over_1_hour: stuck, top_errors: errors };
    }),

  /** Objection Trainer activity and failures. */
  objectionTrainer: () =>
    readOnly("Rep Site Objection Trainer (objection_attempts)", async (run) => {
      const byStatus = await run(`
        SELECT status, count(*)::int AS n FROM public.objection_attempts
        WHERE created_at > now() - interval '7 days' GROUP BY 1`);
      const active = await run(`
        SELECT count(DISTINCT user_id)::int AS reps FROM public.objection_attempts WHERE created_at > now() - interval '7 days'`);
      const errors = await run(`
        SELECT left(error, 200) AS error, count(*)::int AS n FROM public.objection_attempts
        WHERE status = 'failed' AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY n DESC LIMIT 5`);
      return { window: "last 7 days", attempts_by_status: byStatus, active_reps: active[0]?.reps ?? 0, top_errors: errors };
    }),

  /** Latest University health check and recent device-reported issues (library access, video errors, save failures). */
  universityHealth: () =>
    readOnly("Rep Site University health (university_health_runs, university_client_issues)", async (run) => {
      const last = await run(`SELECT started_at, status, problems, checks FROM public.university_health_runs ORDER BY started_at DESC LIMIT 1`);
      const issues = await run(`
        SELECT kind, count(*)::int AS n, count(DISTINCT user_id)::int AS reps FROM public.university_client_issues
        WHERE created_at > now() - interval '48 hours' GROUP BY 1`);
      const run0 = last[0];
      return {
        latest_check: run0
          ? {
              at: run0.started_at,
              status: run0.status,
              problems: run0.problems,
              failing_checks: (run0.checks ?? [])
                .filter((c: any) => c.status !== "ok")
                .map((c: any) => ({ label: c.label, status: c.status, summary: c.summary, items: (c.items ?? []).length })),
            }
          : null,
        device_issues_last_48h: issues,
      };
    }),
};

export type RepSiteTopic = keyof typeof repSite;
