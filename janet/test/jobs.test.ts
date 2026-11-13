import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { q } from "../src/db.js";
import * as store from "../src/store.js";
import { resetDb, truncateAll } from "./db.js";

beforeAll(resetDb);
beforeEach(truncateAll);

describe("durable job queue", () => {
  it("never queues the same work twice", async () => {
    const a = await store.enqueueJob("retention", "k1", {});
    const b = await store.enqueueJob("retention", "k1", {});
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect((await q("SELECT count(*)::int n FROM janet_jobs"))[0].n).toBe(1);
  });

  it("concurrent workers claim disjoint jobs", async () => {
    for (let i = 0; i < 10; i++) await store.enqueueJob("retention", `k${i}`, {}, new Date(Date.now() - 1000));
    const [a, b, c] = await Promise.all([store.claimJobs("w1", 5), store.claimJobs("w2", 5), store.claimJobs("w3", 5)]);
    const ids = [...a, ...b, ...c].map((j) => j.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("re-claims a job whose worker died (lease expired) — survives restarts", async () => {
    await store.enqueueJob("retention", "lease", {}, new Date(Date.now() - 1000));
    const [j] = await store.claimJobs("crashed-worker", 1, 60);
    expect(await store.claimJobs("w2", 1)).toHaveLength(0); // still leased
    await q("UPDATE janet_jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [j.id]);
    const [again] = await store.claimJobs("w2", 1);
    expect(again.id).toBe(j.id);
    expect(again.attempts).toBe(2);
  });

  it("does not run future jobs, backs off on failure, and dead-letters", async () => {
    await store.enqueueJob("retention", "future", {}, new Date(Date.now() + 60_000));
    expect(await store.claimJobs("w", 5)).toHaveLength(0);
    await store.enqueueJob("retention", "flaky", {}, new Date(Date.now() - 1000), 2);
    let [j] = await store.claimJobs("w", 1);
    expect(await store.failJob(j, "boom")).toBe(false);
    await q("UPDATE janet_jobs SET run_at = now() WHERE id = $1", [j.id]);
    [j] = await store.claimJobs("w", 1);
    expect(await store.failJob(j, "boom again")).toBe(true);
    expect((await q("SELECT status FROM janet_jobs WHERE id=$1", [j.id]))[0].status).toBe("dead");
  });

  it("audit log is append-only", async () => {
    await q("INSERT INTO janet_audit (actor, action) VALUES ('system','x')");
    await expect(q("UPDATE janet_audit SET action='y'")).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM janet_audit")).rejects.toThrow(/append-only/);
  });
});
