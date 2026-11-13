// Twilio voice: inbound webhook (caller authorization), outbound calls (callbacks/briefings) with answering-machine
// detection, call status tracking, and the Media Stream WebSocket that hands audio to the Realtime bridge.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import twilio from "twilio";
import type WebSocket from "ws";
import { audit } from "./audit.js";
import { config, configStatus } from "./config.js";
import { safeEqual, sign, verify } from "./crypto.js";
import { CallSession } from "./realtime.js";
import * as store from "./store.js";
import { handleCallbackMissed } from "./scheduler.js";
import type { CallPurpose } from "./context.js";
import { rateLimit } from "./ratelimit.js";

// ---------- Twilio REST client (replaceable in tests) ----------
export type OutboundClient = {
  createCall(p: { to: string; from: string; url: string; statusCallback: string; machineDetection: string; timeout: number }): Promise<{ sid: string }>;
};

let client: OutboundClient | null = null;
export function setTwilioClient(c: OutboundClient | null) {
  client = c;
}
function twilioClient(): OutboundClient {
  if (client) return client;
  if (!configStatus().twilio) throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)");
  const t = twilio(config.twilioAccountSid, config.twilioAuthToken);
  client = {
    createCall: async (p) => {
      const c = await t.calls.create({
        to: p.to,
        from: p.from,
        url: p.url,
        method: "POST",
        statusCallback: p.statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: p.machineDetection as "Enable",
        timeout: p.timeout,
      });
      return { sid: c.sid };
    },
  };
  return client;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const say = (text: string) => `<Say voice="Polly.Joanna-Neural">${xml(text)}</Say>`;
const twiml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

function streamTwiml(callId: string) {
  const wsUrl = config.publicBaseUrl.replace(/^http/, "ws") + "/twilio/media";
  const token = sign(callId, 600);
  return twiml(`<Connect><Stream url="${xml(wsUrl)}"><Parameter name="callId" value="${xml(callId)}"/><Parameter name="token" value="${xml(token)}"/></Stream></Connect>`);
}

function normalizePhone(p: string | undefined) {
  return (p ?? "").replace(/[^\d+]/g, "");
}

export function isOwnerNumber(from: string | undefined) {
  return !!config.ownerPhone && normalizePhone(from) === normalizePhone(config.ownerPhone);
}

/** Reject any webhook not signed by Twilio with our auth token. */
function validTwilioRequest(req: FastifyRequest): boolean {
  if (!config.validateTwilioSignature) return true;
  if (!config.twilioAuthToken || !config.publicBaseUrl) return false;
  const sig = String(req.headers["x-twilio-signature"] ?? "");
  const url = config.publicBaseUrl + req.url;
  return twilio.validateRequest(config.twilioAuthToken, sig, url, (req.body ?? {}) as Record<string, string>);
}

async function guard(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!rateLimit(`twilio:${req.ip}`, 120, 60_000)) {
    reply.code(429).send("rate limited");
    return false;
  }
  if (!validTwilioRequest(req)) {
    await audit("twilio", "webhook.bad_signature", { detail: { url: req.url, ip: req.ip } });
    reply.code(403).send("invalid signature");
    return false;
  }
  return true;
}

// ---------- outbound ----------
export async function placeOutboundCall(p: { purpose: "callback" | "briefing"; callbackId?: string; briefingKind?: "morning" | "evening" }) {
  if (!configStatus().ownerPhone) throw new Error("JANET_OWNER_PHONE is not set");
  const call = await store.createCall({
    direction: "outbound",
    purpose: p.purpose,
    from: config.twilioNumber,
    to: config.ownerPhone,
    authorized: true,
    callbackId: p.callbackId ?? null,
    briefingKind: p.briefingKind ?? null,
  });
  try {
    const r = await twilioClient().createCall({
      to: config.ownerPhone,
      from: config.twilioNumber,
      url: `${config.publicBaseUrl}/twilio/outbound/answer?callId=${call.id}`,
      statusCallback: `${config.publicBaseUrl}/twilio/status?callId=${call.id}`,
      machineDetection: "Enable",
      timeout: 25,
    });
    await store.updateCall(call.id, { call_sid: r.sid });
    await audit("system", "call.outbound_placed", { target: call.id, detail: { purpose: p.purpose, callbackId: p.callbackId, sid: r.sid } });
    return { callId: call.id, sid: r.sid };
  } catch (e) {
    await store.updateCall(call.id, { status: "failed", error: (e as Error).message, ended_at: new Date() });
    throw Object.assign(new Error((e as Error).message), { callId: call.id });
  }
}

const FINAL: Record<string, string> = {
  completed: "completed",
  "no-answer": "no_answer",
  busy: "busy",
  failed: "failed",
  canceled: "canceled",
};

export function registerTwilioRoutes(app: FastifyInstance) {
  // Inbound call to JANET's number.
  app.post("/twilio/voice", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const b = req.body as Record<string, string>;
    reply.type("text/xml");
    const owner = isOwnerNumber(b.From);
    const call = await store.createCall({ callSid: b.CallSid, direction: "inbound", from: b.From ?? "", to: b.To ?? "", authorized: owner && !config.callerPin, status: "ringing" });
    if (!owner) {
      await store.updateCall(call.id, { status: "rejected_unauthorized", ended_at: new Date() });
      await audit("twilio", "call.rejected_unauthorized", { target: call.id, detail: { from_last4: (b.From ?? "").slice(-4) } });
      return twiml(say("Sorry, this line is private. Goodbye.") + "<Hangup/>");
    }
    if (!configStatus().openai || !configStatus().publicBaseUrl) {
      await store.updateCall(call.id, { status: "failed", error: "voice service not configured", ended_at: new Date() });
      return twiml(say("Hi, it's Janet. My voice service isn't configured yet, so I can't talk right now. Goodbye.") + "<Hangup/>");
    }
    if (config.callerPin) {
      return twiml(
        `<Gather input="dtmf" numDigits="${config.callerPin.length}" timeout="8" action="/twilio/voice/pin?callId=${call.id}" method="POST">${say("Please enter your code.")}</Gather>` +
          say("Goodbye.") +
          "<Hangup/>",
      );
    }
    const conv = await store.createConversation();
    await store.updateCall(call.id, { conversation_id: conv });
    return streamTwiml(call.id);
  });

  app.post("/twilio/voice/pin", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    reply.type("text/xml");
    const callId = String((req.query as any).callId ?? "");
    const call = await store.getCall(callId);
    const b = req.body as Record<string, string>;
    if (!call || call.call_sid !== b.CallSid || !isOwnerNumber(b.From)) return twiml("<Hangup/>");
    if (!safeEqual(String(b.Digits ?? ""), config.callerPin)) {
      await store.updateCall(call.id, { status: "rejected_unauthorized", ended_at: new Date() });
      await audit("twilio", "call.bad_pin", { target: call.id });
      return twiml(say("That code is not right. Goodbye.") + "<Hangup/>");
    }
    const conv = await store.createConversation();
    await store.q_markAuthorized(call.id, conv);
    return streamTwiml(call.id);
  });

  // Outbound call answered (or reached voicemail).
  app.post("/twilio/outbound/answer", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    reply.type("text/xml");
    const callId = String((req.query as any).callId ?? "");
    const call = await store.getCall(callId);
    const b = req.body as Record<string, string>;
    if (!call || call.direction !== "outbound") return twiml("<Hangup/>");
    const answeredBy = String(b.AnsweredBy ?? "");
    await store.updateCall(call.id, { answered_by: answeredBy || undefined, call_sid: b.CallSid || undefined });
    if (answeredBy.startsWith("machine") || answeredBy === "fax") {
      // Never leave private details on a voicemail.
      await store.updateCall(call.id, { status: "voicemail" });
      if (call.callback_id) await handleCallbackMissed(call.callback_id, "voicemail");
      await audit("twilio", "call.voicemail", { target: call.id });
      return twiml(say(`Hi ${config.ownerName}, it's Janet with the follow-up you asked for. I'll try you again shortly.`) + "<Hangup/>");
    }
    const conv = await store.createConversation();
    await store.updateCall(call.id, { conversation_id: conv });
    return streamTwiml(call.id);
  });

  // Call progress for every call we place or receive.
  app.post("/twilio/status", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const b = req.body as Record<string, string>;
    const callId = String((req.query as any).callId ?? "");
    const call = callId ? await store.getCall(callId) : await store.getCallBySid(b.CallSid);
    if (!call) return reply.code(204).send();
    const st = String(b.CallStatus ?? "");
    if (st === "ringing" && call.status === "initiated") await store.updateCall(call.id, { status: "ringing" });
    const final = FINAL[st];
    if (final) {
      const status = call.status === "voicemail" || call.status === "rejected_unauthorized" ? call.status : final;
      await store.updateCall(call.id, { status, ended_at: new Date(), duration_seconds: Number(b.CallDuration ?? 0) || undefined });
      await audit("twilio", "call.ended", { target: call.id, detail: { status: st, duration: b.CallDuration } });
      if (call.callback_id && ["no_answer", "busy", "failed", "canceled"].includes(final)) {
        await handleCallbackMissed(call.callback_id, final);
      }
      if (final === "completed" && call.conversation_id) {
        await store.enqueueJob("summarize_conversation", `summarize:${call.conversation_id}`, { conversationId: call.conversation_id }, new Date(Date.now() + 5000));
      }
    }
    return reply.code(204).send();
  });

  // Media stream: audio for an authorized call. The callId arrives in the 'start' message with a signed token.
  app.get("/twilio/media", { websocket: true }, (socket: WebSocket) => {
    let started = false;
    const timer = setTimeout(() => !started && socket.close(), 10_000);
    const onFirst = async (raw: WebSocket.RawData) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.event !== "start") return;
      socket.off("message", onFirst);
      started = true;
      clearTimeout(timer);
      const params = m.start?.customParameters ?? {};
      const callId = verify(params.token);
      const call = callId && callId === params.callId ? await store.getCall(callId) : null;
      if (!call || !call.authorized || !call.conversation_id) {
        await audit("twilio", "media.rejected", { detail: { callId: params.callId } });
        socket.close();
        return;
      }
      const purpose: CallPurpose =
        call.purpose === "callback" && call.callback_id
          ? { kind: "callback", callbackId: call.callback_id }
          : call.purpose === "briefing"
            ? { kind: "briefing", briefing: (call.briefing_kind as "morning" | "evening") ?? "morning" }
            : { kind: "inbound" };
      const session = new CallSession(socket, { callId: call.id, conversationId: call.conversation_id, purpose });
      session.setStream(m.start.streamSid);
      session.start().catch(async (e) => {
        console.error("session start failed", e);
        await audit("system", "call.session_failed", { target: call.id, detail: { error: e.message } });
        socket.close();
      });
    };
    socket.on("message", onFirst);
  });
}
