import { getPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";

/** Fresh schema for each test file. */
export async function resetDb() {
  const pool = getPool();
  await pool.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'janet_%' LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
    END LOOP; END $$;`);
  await migrate(() => {});
}

export async function truncateAll() {
  await getPool().query(`TRUNCATE janet_messages, janet_calls, janet_memories, janet_tasks, janet_callbacks, janet_jobs,
    janet_dev_tickets, janet_pending_actions, janet_integrations, janet_conversations CASCADE`);
  await getPool().query(`UPDATE janet_settings SET calls_paused=false, quiet_hours_start='21:00', quiet_hours_end='08:00',
    callback_retry_minutes=5, callback_max_attempts=3, transcripts_enabled=true, morning_briefing_enabled=false, evening_briefing_enabled=false`);
}
