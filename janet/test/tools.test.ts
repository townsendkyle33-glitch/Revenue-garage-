import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { q } from "../src/db.js";
import * as store from "../src/store.js";
import { executeTool, realtimeToolDefs, type ToolContext } from "../src/tools.js";
import { resetDb, truncateAll } from "./db.js";

beforeAll(resetDb);
beforeEach(truncateAll);

let turns = 0;
async function ctx(): Promise<ToolContext> {
  turns = 1;
  const conversationId = await store.createConversation();
  return {
    conversationId,
    userTurns: () => turns,
    lastUserText: () => "test utterance",
    now: () => DateTime.fromISO("2026-11-13T15:00:00", { zone: "America/New_York" }),
  };
}
const run = async (c: ToolContext, name: string, args: unknown) => {
  const r = await executeTool(name, JSON.stringify(args), c);
  return { ...r, json: JSON.parse(r.output) };
};

describe("tool engine", () => {
  it("exposes only allowlisted tools, with valid JSON schemas, and nothing dangerous", () => {
    const defs = realtimeToolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toContain("create_task");
    expect(names).toContain("schedule_callback");
    for (const bad of ["run_sql", "shell", "exec", "deploy", "send_sms", "send_email", "payment"]) expect(names).not.toContain(bad);
    for (const d of defs) expect((d.parameters as any).type).toBe("object");
  });

  it("rejects unknown tools and invalid arguments", async () => {
    const c = await ctx();
    expect((await run(c, "drop_database", {})).ok).toBe(false);
    const r = await run(c, "create_task", { title: "" });
    expect(r.ok).toBe(false);
    expect(r.json.error).toBe("Invalid arguments");
  });

  it("creates a task from speech, stored with all fields", async () => {
    const c = await ctx();
    const r = await run(c, "create_task", {
      title: "Check Field Intelligence transcription",
      priority: "high",
      owner: "me",
      due: { local_datetime: "2026-11-14T10:00" },
      required_integrations: ["rep_site"],
    });
    expect(r.ok).toBe(true);
    expect(r.json.task.due).toBe("tomorrow at 10:00 AM EST");
    const rows = await q("SELECT * FROM janet_tasks");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Check Field Intelligence transcription", priority: "high", status: "pending", source_conversation_id: c.conversationId, required_integrations: ["rep_site"] });
    expect(new Date(rows[0].due_at).toISOString()).toBe("2026-11-14T15:00:00.000Z");
    expect((await q("SELECT action FROM janet_audit WHERE action='task.create'"))).toHaveLength(1);
  });

  it("refuses to mark a task completed without evidence", async () => {
    const c = await ctx();
    const t = await run(c, "create_task", { title: "Fix library unlock" });
    const n = t.json.task.task_number;
    const bad = await run(c, "update_task", { task_number: n, status: "completed" });
    expect(bad.json.saved).toBe(false);
    const good = await run(c, "update_task", { task_number: n, status: "completed", completion_evidence: "Owner confirmed reps can open the library" });
    expect(good.json.task.status).toBe("completed");
  });

  it("schedules a callback with a durable job and reads back the time", async () => {
    const c = await ctx();
    const r = await run(c, "schedule_callback", { reason: "Discuss the Rep Site training issue", when: { delay_minutes: 5 } });
    expect(r.json.saved).toBe(true);
    expect(r.json.will_call_at).toBe("today at 3:05 PM EST");
    const [cb] = await q("SELECT * FROM janet_callbacks");
    expect(cb.source_conversation_id).toBe(c.conversationId);
    expect(cb.requested_text).toBe("test utterance");
    const jobs = await q("SELECT * FROM janet_jobs WHERE kind='place_callback'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotency_key).toBe(`callback:${cb.id}:attempt:1`);
  });

  it("asks before calling during quiet hours", async () => {
    const c = await ctx();
    const r = await run(c, "schedule_callback", { reason: "late check-in", when: { local_datetime: "2026-11-13T23:00" } });
    expect(r.json.saved).toBe(false);
    expect(r.json.needs_owner_decision).toMatch(/quiet hours/);
    const ok = await run(c, "schedule_callback", { reason: "late check-in", when: { local_datetime: "2026-11-13T23:00" }, override_quiet_hours: true });
    expect(ok.json.saved).toBe(true);
  });

  it("sensitive actions need a NEW spoken yes — the model cannot self-confirm", async () => {
    const c = await ctx();
    const m = await store.addMemory({ kind: "fact", subject: "test", content: "Marcus reported the training issue" });
    const req = await run(c, "forget_memory", { memory_id: m.id });
    expect(req.json.status).toBe("needs_confirmation");
    expect(req.json.summary).toMatch(/Marcus/);
    // Model tries to confirm in the same turn: refused, nothing erased.
    const early = await run(c, "confirm_action", { action_id: req.json.action_id });
    expect(early.json.done).toBe(false);
    expect((await q("SELECT status FROM janet_memories WHERE id=$1", [m.id]))[0].status).toBe("active");
    // Owner speaks ("yes") -> new committed turn -> allowed.
    turns++;
    const ok = await run(c, "confirm_action", { action_id: req.json.action_id });
    expect(ok.json.erased).toBe(true);
    const [row] = await q("SELECT status, content FROM janet_memories WHERE id=$1", [m.id]);
    expect(row).toEqual({ status: "deleted", content: "[deleted]" });
    // Can't be replayed.
    turns++;
    expect((await run(c, "confirm_action", { action_id: req.json.action_id })).json.done).toBe(false);
  });

  it("a pending action from another call cannot be confirmed here", async () => {
    const c1 = await ctx();
    const m = await store.addMemory({ kind: "fact", content: "x" });
    const req = await run(c1, "forget_memory", { memory_id: m.id });
    const c2 = await ctx();
    turns = 5;
    expect((await run(c2, "confirm_action", { action_id: req.json.action_id })).json.done).toBe(false);
  });

  it("dev tickets say plainly that work has not started", async () => {
    const c = await ctx();
    const r = await run(c, "create_dev_ticket", {
      title: "Training library not unlocking",
      problem: "Reps who finished module 1 can't open module 2",
      component: "University library",
      acceptance_criteria: ["A rep who completes module 1 can open module 2"],
      follow_up: { local_datetime: "2026-11-14T09:00" },
    });
    expect(r.json.status).toBe("created");
    expect(r.json.meaning).toMatch(/NOT started/);
  });

  it("integrations that aren't connected say so instead of inventing data", async () => {
    const c = await ctx();
    expect((await run(c, "rep_site_status", { topic: "training_progress" })).json).toMatchObject({ available: false });
    expect((await run(c, "calendar_agenda", {})).json.available).toBe(false);
  });

  it("memory: remember, search, correct", async () => {
    const c = await ctx();
    await run(c, "remember", { kind: "preference", subject: "Briefings", content: "Kyle prefers briefings under one minute" });
    const s = await run(c, "search_memory", { query: "briefings" });
    expect(s.json.memories[0].content).toMatch(/under one minute/);
    const fixed = await run(c, "correct_memory", { memory_id: s.json.memories[0].memory_id, corrected_content: "Kyle prefers briefings under two minutes" });
    expect(fixed.json.saved).toBe(true);
    const again = await run(c, "search_memory", { query: "briefings" });
    expect(again.json.memories).toHaveLength(1);
    expect(again.json.memories[0].content).toMatch(/two minutes/);
  });
});
