import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "./db.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(log = console.log): Promise<string[]> {
  const pool = getPool();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS janet_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  await pool.query("ALTER TABLE janet_schema_migrations ENABLE ROW LEVEL SECURITY");
  const done = new Set((await pool.query("SELECT name FROM janet_schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query("INSERT INTO janet_schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      applied.push(f);
      log(`applied ${f}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then((a) => {
      console.log(a.length ? `done (${a.length} applied)` : "up to date");
      return getPool().end();
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
