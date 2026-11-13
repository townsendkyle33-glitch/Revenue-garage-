// Runs against a local copy of Rep Site's real schema (built with rep-site/tests/db/supabase-shim.sql + all
// drizzle migrations + fixtures). Skipped unless REPSITE_TEST_DB is set. See README "Testing".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { config } from "../src/config.js";
import { getPool, setPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { repSite } from "../src/integrations/repSite.js";

const url = process.env.REPSITE_TEST_DB;
const OWNER = "a0000000-0000-0000-0000-000000000001"; // fixtures: first admin
const REP = "a0000000-0000-0000-0000-000000000002";

describe.skipIf(!url)("Rep Site database integration", () => {
  let original: pg.Pool;
  beforeAll(async () => {
    original = getPool();
    setPool(new pg.Pool({ connectionString: url }));
    await migrate(() => {});
    config.repSiteReadEnabled = true;
  });
  afterAll(async () => {
    config.repSiteReadEnabled = false;
    await getPool().end();
    setPool(original);
  });

  async function as(user: string, sql: string) {
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
      return (await c.query(sql)).rows;
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("migrations apply on top of Rep Site and seed the first admin as JANET owner", async () => {
    const rows = (await getPool().query("SELECT user_id FROM janet_owners")).rows;
    expect(rows.map((r) => r.user_id)).toEqual([OWNER]);
  });

  it("only the JANET owner can read JANET data from a browser; nobody can read the Google token", async () => {
    await getPool().query("INSERT INTO janet_tasks (title) VALUES ('secret plan')");
    expect(await as(OWNER, "SELECT title FROM janet_tasks")).toHaveLength(1);
    expect(await as(REP, "SELECT title FROM janet_tasks")).toHaveLength(0);
    await expect(as(OWNER, "SELECT * FROM janet_integrations")).rejects.toThrow(/permission denied/);
    await expect(as(OWNER, "INSERT INTO janet_tasks (title) VALUES ('x')")).rejects.toThrow(/permission denied/);
  });

  it("every Rep Site read query runs against the real schema", async () => {
    for (const [name, fn] of Object.entries(repSite)) {
      const r = await fn();
      expect(r, name).toMatchObject({ available: true });
    }
    const t: any = await repSite.trainingProgress();
    expect(t.data.approved_reps).toBeGreaterThan(0); // fixtures include approved reps
  });

  it("Rep Site reads are read-only", async () => {
    const c = await getPool().connect();
    try {
      await c.query("BEGIN READ ONLY");
      await expect(c.query("INSERT INTO janet_tasks (title) VALUES ('x')")).rejects.toThrow(/read-only/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
