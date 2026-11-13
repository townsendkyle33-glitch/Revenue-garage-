import pg from "pg";
import { config } from "./config.js";

// Return timestamps/bigints as JS-friendly values.
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
    const ssl =
      config.databaseSsl === "disable" || (config.databaseSsl === "auto" && local)
        ? false
        : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 10 });
  }
  return pool;
}

export function setPool(p: pg.Pool | null) {
  pool = p;
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await getPool().query<T>(text, params);
  return r.rows;
}

export async function q1<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
