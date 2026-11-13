// End-to-end: the MVP acceptance flow against the real server, real Postgres, fake Twilio and fake OpenAI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { q } from "../src/db.js";
import { buildServer } from "../src/server.js";
import { setDialer, tick } from "../src/scheduler.js";
import { placeOutboundCall, setTwilioClient } from "../src/twilio.js";
import * as store from "../src/store.js";
import { resetDb } from "./db.js";
import { FakeTwilioStream, startFakeOpenAI, streamParams, twilioSign, waitFor } from "./fakes.js";

let app: FastifyInstance;
let port: number;
let oa: Awaited<ReturnType<typeof startFakeOpenAI>>;
const placed: any[] = [];
const OWNER = "+15615550100";

async function webhook(path: string, params: Record<string, string>, signed = true) {
  const r = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signed ? twilioSign(path, params) : "bogus" },
    payload: new URLSearchParams(params).toString(),
  });
  return r;
}

beforeAll(async () => {
  await resetDb();
  await store.updateSettings({ quiet_hours_start: "00:00", quiet_hours_end: "00:00" });
  oa = await startFakeOpenAI();
  setTwilioClient({
    createCall: async (p) => {
      placed.push(p);
      return { sid: `CAout${placed.length}` };
    },
  });
  setDialer(placeOutboundCall);
  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  await oa.close();
});

describe("MVP acceptance flow", () => {
  let firstConversation: string;
  let callbackId: string;

  it("1. owner calls JANET, holds a conversation, creates a task and a memory, and barges in", async () => {
    const r = await webhook("/twilio/voice", { CallSid: "CAin1", From: OWNER, To: "+15615550199" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<Connect><Stream");
    const p = streamParams(r.body);

    const tw = new FakeTwilioStream(port);
    await tw.start(p, "CAin1");
    const conn = await waitFor(() => oa.latest(), 3000, "openai connection");
    expect(oa.headers[0].authorization).toBe("Bearer sk-test");
    const session = await waitFor(() => conn.session, 3000, "session.update");
    expect(session.audio.input.format.type).toBe("audio/pcmu");
    expect(session.audio.output.voice).toBe("marin");
    expect(session.instructions).toContain("You are JANET");
    expect(session.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["create_task", "schedule_callback", "remember"]));
    // JANET greets first.
    await waitFor(() => conn.of("response.create").length, 2000, "greeting");

    // Audio flows Twilio -> OpenAI.
    tw.media(100);
    await waitFor(() => conn.of("input_audio_buffer.append").length, 2000, "audio append");

    conn.ownerSays("Janet, remind me to check the Field Intelligence transcription tomorrow at 10. And remember the objection trainer launches December 1st.");
    conn.callTools([
      { name: "create_task", args: { title: "Check the Field Intelligence transcription", priority: "high", due: { delay_minutes: 1080 } } },
      { name: "remember", args: { kind: "deadline", subject: "Objection Trainer launch", content: "The objection trainer launches December 1st" } },
    ]);
    await waitFor(() => conn.of("conversation.item.create").filter((m) => m.item.type === "function_call_output").length === 2, 3000, "tool outputs");
    const outputs = conn.of("conversation.item.create").filter((m) => m.item.type === "function_call_output").map((m) => JSON.parse(m.item.output));
    expect(outputs[0].saved).toBe(true);
    expect(outputs[0].task.task_number).toBeGreaterThan(0);
    expect(outputs[1].saved).toBe(true);

    // The task is in persistent storage.
    const tasks = await q("SELECT * FROM janet_tasks");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Check the Field Intelligence transcription");

    // JANET speaks: audio flows OpenAI -> Twilio.
    conn.janetSays("Done. Task one, check the Field Intelligence transcription, tomorrow at 10, high priority.", "item_speech_1");
    await waitFor(() => tw.of("media").length, 2000, "audio to twilio");

    // Owner interrupts: Twilio playback cleared and the model's reply truncated.
    tw.media(1600);
    await new Promise((r) => setTimeout(r, 50));
    conn.send({ type: "input_audio_buffer.speech_started" });
    await waitFor(() => tw.of("clear").length, 2000, "clear");
    const trunc = await waitFor(() => conn.of("conversation.item.truncate")[0], 2000, "truncate");
    expect(trunc.item_id).toBe("item_speech_1");

    // Owner asks for a callback in five minutes.
    conn.ownerSays("Call me back in five minutes so we can discuss the Rep Site training issue Marcus reported.");
    conn.callTools([{ name: "schedule_callback", args: { reason: "Discuss the Rep Site training issue Marcus reported", when: { delay_minutes: 5 } } }]);
    const cb = await waitFor(async () => (await q("SELECT * FROM janet_callbacks"))[0], 3000, "callback row");
    callbackId = cb.id;
    const call = await store.getCall(p.callId);
    firstConversation = call!.conversation_id!;
    expect(cb.source_conversation_id).toBe(firstConversation);
    expect(cb.requested_text).toContain("Call me back in five minutes");
    const delay = new Date(cb.scheduled_for).getTime() - Date.now();
    expect(delay).toBeGreaterThan(4 * 60_000);
    expect(delay).toBeLessThanOrEqual(5 * 60_000);
    conn.janetSays("Got it, I'll call you back today at 3:05 PM about the training issue.");

    // Hang up.
    tw.stop();
    await waitFor(async () => (await store.getConversation(firstConversation))?.ended_at, 3000, "conversation ended");
    const r2 = await webhook(`/twilio/status`, { CallSid: "CAin1", CallStatus: "completed", CallDuration: "95" });
    expect(r2.statusCode).toBe(204);
    expect((await store.getCall(p.callId))!.status).toBe("completed");

    // Transcript saved in order.
    const t = await store.getTranscript(firstConversation);
    expect(t.filter((m) => m.role === "user").map((m) => m.content)[0]).toContain("Field Intelligence");
    expect(t.some((m) => m.role === "assistant")).toBe(true);
    expect(t.some((m) => m.role === "tool" && m.tool_name === "create_task")).toBe(true);
  });

  it("2. after the call, a structured summary and memories are saved", async () => {
    oa.setSummary({
      title: "Field Intelligence check and training issue",
      summary: "Kyle asked JANET to create a task to check Field Intelligence transcription and to call back in five minutes about the Rep Site training issue Marcus reported.",
      topics: ["Field Intelligence", "Rep Site training"],
      decisions: [],
      follow_ups: ["JANET calls Kyle back in five minutes about the training issue"],
      open_questions: ["What exactly is broken in the training library for Marcus?"],
      memories: [{ kind: "project", subject: "Rep Site training", content: "Marcus reported a Rep Site training issue" }],
    });
    await q("UPDATE janet_jobs SET run_at = now() WHERE kind = 'summarize_conversation'");
    await tick("test");
    const c: any = await store.getConversation(firstConversation);
    expect(c.summary_status).toBe("done");
    expect(c.summary).toContain("Marcus");
    const mems = await store.listMemories();
    expect(mems.map((m: any) => m.content)).toEqual(expect.arrayContaining(["Marcus reported a Rep Site training issue", "The objection trainer launches December 1st"]));
  });

  it("3. at the scheduled time JANET calls the owner — exactly once", async () => {
    expect(placed).toHaveLength(0);
    await q("UPDATE janet_jobs SET run_at = now() - interval '1 second' WHERE kind='place_callback'");
    await Promise.all([tick("w1"), tick("w2")]);
    expect(placed).toHaveLength(1);
    expect(placed[0].to).toBe(OWNER);
    expect(placed[0].machineDetection).toBe("Enable");
    expect(placed[0].url).toMatch(/^https:\/\/janet\.test\/twilio\/outbound\/answer\?callId=/);
    expect((await store.getCallback(callbackId))!.status).toBe("dialing");
  });

  it("4. the callback opens with the context of the earlier conversation", async () => {
    const callId = new URL(placed[0].url).searchParams.get("callId")!;
    await webhook(`/twilio/status?callId=${callId}`, { CallSid: "CAout1", CallStatus: "ringing" });
    const r = await webhook(`/twilio/outbound/answer?callId=${callId}`, { CallSid: "CAout1", AnsweredBy: "human" });
    expect(r.body).toContain("<Connect><Stream");
    const before = oa.conns.length;
    const tw = new FakeTwilioStream(port);
    await tw.start(streamParams(r.body), "CAout1");
    const conn = await waitFor(() => (oa.conns.length > before ? oa.latest() : undefined), 3000, "callback openai connection");
    const session = await waitFor(() => conn.session, 3000, "callback session");
    // Retrieved BEFORE speaking: the reason, the source conversation, and memory from the previous call.
    expect(session.instructions).toContain("OUTBOUND CALLBACK");
    expect(session.instructions).toContain("Discuss the Rep Site training issue Marcus reported");
    expect(session.instructions).toContain("What exactly is broken in the training library for Marcus?");
    expect(session.instructions).toContain("The objection trainer launches December 1st");
    expect(session.instructions).toContain("Task 1: Check the Field Intelligence transcription");
    const opening = await waitFor(() => conn.of("conversation.item.create").find((m) => m.item.role === "system"), 2000, "opening");
    expect(opening.item.content[0].text).toContain("following up on");
    expect(conn.of("response.create").length).toBe(1);
    expect((await store.getCallback(callbackId))!.status).toBe("in_progress");

    tw.stop();
    await webhook(`/twilio/status?callId=${callId}`, { CallSid: "CAout1", CallStatus: "completed", CallDuration: "40" });
    await waitFor(async () => (await store.getCallback(callbackId))!.status === "completed", 3000, "callback completed");
  });

  it("5. the callback and calls show up for the dashboard", async () => {
    const login = await app.inject({ method: "POST", url: "/admin/login", payload: { password: "correct horse battery" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const cbs = (await app.inject({ method: "GET", url: "/admin/api/callbacks", headers: { cookie } })).json();
    expect(cbs[0]).toMatchObject({ id: callbackId, status: "completed", attempts: 1 });
    const calls = (await app.inject({ method: "GET", url: "/admin/api/calls", headers: { cookie } })).json();
    expect(calls.map((c: any) => c.purpose).sort()).toEqual(["callback", "conversation"]);
  });
});

describe("failures and security", () => {
  it("unauthorized callers are refused and learn nothing", async () => {
    const r = await webhook("/twilio/voice", { CallSid: "CAstranger", From: "+13055550123", To: "+15615550199" });
    expect(r.body).toContain("this line is private");
    expect(r.body).not.toContain("<Stream");
    const call = await store.getCallBySid("CAstranger");
    expect(call!.status).toBe("rejected_unauthorized");
    expect(call!.conversation_id).toBeNull();
  });

  it("webhooks without a valid Twilio signature are rejected (caller ID can't be forged through us)", async () => {
    const r = await webhook("/twilio/voice", { CallSid: "CAforged", From: OWNER, To: "+15615550199" }, false);
    expect(r.statusCode).toBe(403);
    expect(await store.getCallBySid("CAforged")).toBeNull();
  });

  it("a media stream with a forged token is closed before reaching OpenAI", async () => {
    const before = oa.conns.length;
    const tw = new FakeTwilioStream(port);
    const call = await store.createCall({ direction: "inbound", from: OWNER, to: "+1", authorized: true });
    await tw.start({ callId: call.id, token: "forged.0.token" });
    await waitFor(() => tw.closed, 3000, "socket closed");
    expect(oa.conns.length).toBe(before);
  });

  it("voicemail: no private details are left, and a retry is scheduled", async () => {
    const cb = await store.scheduleCallback({ reason: "Confidential: recruiting plan for Q1", at: new Date(Date.now() - 1000), zone: "America/New_York", maxAttempts: 3 });
    const n = placed.length;
    await tick("w");
    expect(placed.length).toBe(n + 1);
    const callId = new URL(placed[n].url).searchParams.get("callId")!;
    const r = await webhook(`/twilio/outbound/answer?callId=${callId}`, { CallSid: `CAout${n + 1}`, AnsweredBy: "machine_end_beep" });
    expect(r.body).not.toContain("recruiting");
    expect(r.body).not.toContain("<Stream");
    expect((await store.getCallback(cb.id))!.status).toBe("retry_scheduled");
    await webhook(`/twilio/status?callId=${callId}`, { CallSid: `CAout${n + 1}`, CallStatus: "completed" });
    expect((await store.getCall(callId))!.status).toBe("voicemail");
  });

  it("a missed call (no answer) is logged and retried", async () => {
    const cb = await store.scheduleCallback({ reason: "check-in", at: new Date(Date.now() - 1000), zone: "America/New_York", maxAttempts: 2 });
    const n = placed.length;
    await tick("w");
    const callId = new URL(placed[n].url).searchParams.get("callId")!;
    await webhook(`/twilio/status?callId=${callId}`, { CallSid: `CAout${n + 1}`, CallStatus: "no-answer" });
    expect((await store.getCall(callId))!.status).toBe("no_answer");
    expect((await store.getCallback(cb.id))!.status).toBe("retry_scheduled");
    expect((await q("SELECT 1 FROM janet_audit WHERE action='callback.retry_scheduled' AND target=$1", [cb.id])).length).toBe(1);
  });

  it("if the OpenAI connection drops mid-call, JANET reconnects with the call so far", async () => {
    const r = await webhook("/twilio/voice", { CallSid: "CAdrop", From: OWNER, To: "+15615550199" });
    const tw = new FakeTwilioStream(port);
    const before = oa.conns.length;
    await tw.start(streamParams(r.body), "CAdrop");
    const first = await waitFor(() => (oa.conns.length > before ? oa.latest() : undefined), 3000, "first connection");
    await waitFor(() => first.session, 2000, "first session");
    first.ownerSays("What's on my plate for the recruiting plan?");
    await new Promise((res) => setTimeout(res, 150));
    first.ws.close(1011);
    const second = await waitFor(() => (oa.conns.length > before + 1 ? oa.latest() : undefined), 3000, "reconnection");
    const s = await waitFor(() => second.session, 2000, "second session");
    expect(s.instructions).toContain("LINE BRIEFLY DROPPED");
    expect(s.instructions).toContain("recruiting plan");
    tw.stop();
  });

  it("dashboard requires login and a CSRF header for changes", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/api/tasks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/login", payload: { password: "wrong" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/admin/login", payload: { password: "correct horse battery" } });
    expect(String(login.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const noCsrf = await app.inject({ method: "POST", url: "/admin/api/tasks", headers: { cookie }, payload: { title: "x" } });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/admin/api/tasks", headers: { cookie, "x-janet-csrf": "1" }, payload: { title: "From the dashboard" } });
    expect(ok.statusCode).toBe(200);
    const done = await app.inject({ method: "PATCH", url: `/admin/api/tasks/${ok.json().id}`, headers: { cookie, "x-janet-csrf": "1" }, payload: { status: "completed" } });
    expect(done.statusCode).toBe(400); // evidence required
    const page = await app.inject({ method: "GET", url: "/admin" });
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });
});
