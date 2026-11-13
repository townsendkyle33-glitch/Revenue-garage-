import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { q } from "../src/db.js";
import * as store from "../src/store.js";
import { handleCallbackMissed, nextBriefingTime, setDialer, tick, _internal } from "../src/scheduler.js";
import { resetDb, truncateAll } from "./db.js";

beforeAll(resetDb);
let dials: any[] = [];
beforeEach(async () => {
  await truncateAll();
  dials = [];
  // Quiet hours that never apply, unless a test sets them.
  await store.updateSettings({ quiet_hours_start: "00:00", quiet_hours_end: "00:00" });
  setDialer(async (p) => {
    dials.push(p);
    const call = await store.createCall({ direction: "outbound", purpose: p.purpose, from: "+1", to: "+2", authorized: true, callbackId: p.callbackId });
    return { callId: call.id, sid: `CA${dials.length}` };
  });
});

const due = async (reason = "Discuss the Rep Site training issue", extra: Partial<Parameters<typeof store.scheduleCallback>[0]> = {}) =>
  store.scheduleCallback({ reason, at: new Date(Date.now() - 1000), zone: "America/New_York", maxAttempts: 3, ...extra });

describe("callbacks", () => {
  it("dials exactly once at the scheduled time, even if ticked repeatedly or by parallel workers", async () => {
    const cb = await due();
    await Promise.all([tick("w1"), tick("w2"), tick("w3")]);
    await tick("w1");
    expect(dials).toHaveLength(1);
    expect(dials[0]).toEqual({ purpose: "callback", callbackId: cb.id });
    const row = await store.getCallback(cb.id);
    expect(row!.status).toBe("dialing");
    expect(row!.attempts).toBe(1);
  });

  it("does not dial before it's due", async () => {
    await store.scheduleCallback({ reason: "later", at: new Date(Date.now() + 60_000), zone: "America/New_York", maxAttempts: 3 });
    await tick("w");
    expect(dials).toHaveLength(0);
  });

  it("retries on no answer, then gives up after max attempts", async () => {
    const cb = await due();
    await tick("w");
    await handleCallbackMissed(cb.id, "no_answer");
    let row = await store.getCallback(cb.id);
    expect(row!.status).toBe("retry_scheduled");
    // A duplicate status webhook doesn't schedule a second retry.
    await handleCallbackMissed(cb.id, "no_answer");
    expect((await q("SELECT count(*)::int n FROM janet_jobs WHERE kind='place_callback'"))[0].n).toBe(2);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await q("UPDATE janet_jobs SET run_at = now() - interval '1 second' WHERE status='queued'");
      await tick("w");
      expect(dials).toHaveLength(attempt);
      await handleCallbackMissed(cb.id, "no_answer");
    }
    row = await store.getCallback(cb.id);
    expect(row!.status).toBe("no_answer");
    expect(row!.attempts).toBe(3);
  });

  it("a cancelled callback never rings", async () => {
    const cb = await due();
    expect(await store.cancelCallback(cb.id)).toBe(true);
    await tick("w");
    expect(dials).toHaveLength(0);
  });

  it("waits while calls are paused, without using up attempts", async () => {
    await due();
    await store.updateSettings({ calls_paused: true });
    await tick("w");
    expect(dials).toHaveLength(0);
    const [job] = await q("SELECT * FROM janet_jobs");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it("defers to the end of quiet hours", async () => {
    const zone = "America/New_York";
    const h = DateTime.now().setZone(zone);
    const start = h.minus({ hours: 1 }).toFormat("HH:00");
    const end = h.plus({ hours: 2 }).toFormat("HH:00");
    await store.updateSettings({ quiet_hours_start: start, quiet_hours_end: end });
    const cb = await due();
    await tick("w");
    expect(dials).toHaveLength(0);
    const row = await store.getCallback(cb.id);
    expect(DateTime.fromJSDate(row!.next_attempt_at!).setZone(zone).toFormat("HH:mm")).toBe(end);
    // An explicit override rings anyway.
    const urgent = await due("urgent", { overrideQuietHours: true });
    await tick("w");
    expect(dials.map((d) => d.callbackId)).toEqual([urgent.id]);
  });

  it("a Twilio API failure is retried as a missed attempt", async () => {
    setDialer(async () => {
      throw new Error("Twilio 503");
    });
    const cb = await due();
    await tick("w");
    const row = await store.getCallback(cb.id);
    expect(row!.status).toBe("retry_scheduled");
    expect(row!.last_error).toBe("Twilio 503");
  });

  it("a worker that died mid-dial is flagged, not silently re-dialled", async () => {
    const cb = await due();
    await store.claimCallbackForDial(cb.id);
    await q("UPDATE janet_callbacks SET updated_at = now() - interval '5 minutes' WHERE id=$1", [cb.id]);
    await _internal.sweep();
    const row = await store.getCallback(cb.id);
    expect(row!.status).toBe("failed");
    expect(row!.last_error).toMatch(/duplicate/);
  });
});

describe("briefing schedule", () => {
  it("finds the next allowed weekday at the local time", () => {
    const fri = DateTime.fromISO("2026-11-13T09:00", { zone: "America/New_York" }); // Friday
    expect(nextBriefingTime("08:15", [1, 2, 3, 4, 5], "America/New_York", fri)!.toISO()).toBe("2026-11-16T08:15:00.000-05:00");
    expect(nextBriefingTime("18:30", [1, 2, 3, 4, 5], "America/New_York", fri)!.toISO()).toBe("2026-11-13T18:30:00.000-05:00");
  });
  it("plans one job per briefing per day", async () => {
    await store.updateSettings({ morning_briefing_enabled: true, briefing_days: [1, 2, 3, 4, 5, 6, 7] });
    await _internal.planBriefings();
    await _internal.planBriefings();
    expect((await q("SELECT count(*)::int n FROM janet_jobs WHERE kind='place_briefing'"))[0].n).toBe(1);
  });
});
