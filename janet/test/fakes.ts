// Fake Twilio + fake OpenAI (Realtime WebSocket and Chat Completions HTTP) for end-to-end tests.
import http from "node:http";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "../src/config.js";

export async function waitFor<T>(fn: () => T | Promise<T>, timeout = 5000, label = "condition"): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export class FakeRealtimeConn {
  received: any[] = [];
  constructor(public ws: WebSocket) {
    ws.on("message", (m) => this.received.push(JSON.parse(m.toString())));
  }
  send(ev: unknown) {
    this.ws.send(JSON.stringify(ev));
  }
  of(type: string) {
    return this.received.filter((m) => m.type === type);
  }
  get session() {
    return this.of("session.update")[0]?.session;
  }
  /** Simulate the owner saying something (VAD commit + transcription). */
  ownerSays(text: string) {
    this.send({ type: "input_audio_buffer.committed", item_id: `u${Date.now()}` });
    this.send({ type: "conversation.item.input_audio_transcription.completed", transcript: text });
  }
  /** Simulate the model finishing a response that calls tools. */
  callTools(calls: { name: string; args: unknown }[]) {
    this.send({
      type: "response.done",
      response: { output: calls.map((c, i) => ({ type: "function_call", call_id: `call_${Date.now()}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })) },
    });
  }
  janetSays(text: string, itemId = `a${Date.now()}`) {
    this.send({ type: "response.output_audio.delta", item_id: itemId, delta: Buffer.from("fake-ulaw-audio").toString("base64") });
    this.send({ type: "response.output_audio_transcript.done", item_id: itemId, transcript: text });
  }
}

export async function startFakeOpenAI() {
  const conns: FakeRealtimeConn[] = [];
  const wss = new WebSocketServer({ port: 0 });
  const headers: any[] = [];
  wss.on("connection", (ws, req) => {
    headers.push(req.headers);
    conns.push(new FakeRealtimeConn(ws));
  });
  await new Promise((r) => wss.once("listening", r));
  config.realtimeUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/realtime`;

  // Chat Completions for post-call summaries.
  let summaryReply: any = null;
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(summaryReply) } }], _request: JSON.parse(body) }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  config.openaiBaseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1`;

  return {
    conns,
    headers,
    setSummary: (s: any) => (summaryReply = s),
    latest: () => conns[conns.length - 1],
    close: async () => {
      for (const c of conns) c.ws.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpServer.close(r));
    },
  };
}

/** Sign a Twilio webhook exactly like Twilio does. */
export function twilioSign(path: string, params: Record<string, string>) {
  return twilio.getExpectedTwilioSignature(config.twilioAuthToken, config.publicBaseUrl + path, params);
}

export function streamParams(twiml: string) {
  const callId = /name="callId" value="([^"]+)"/.exec(twiml)?.[1];
  const token = /name="token" value="([^"]+)"/.exec(twiml)?.[1];
  return { callId: callId!, token: token! };
}

/** A fake Twilio Media Stream client. */
export class FakeTwilioStream {
  ws: WebSocket;
  received: any[] = [];
  opened: Promise<void>;
  closed = false;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
    this.ws.on("message", (m) => this.received.push(JSON.parse(m.toString())));
    this.ws.on("close", () => (this.closed = true));
    this.opened = new Promise((r) => this.ws.once("open", () => r()));
  }
  async start(p: { callId: string; token: string }, callSid = "CAstream") {
    await this.opened;
    this.ws.send(JSON.stringify({ event: "connected" }));
    this.ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid, customParameters: p } }));
  }
  media(ts: number) {
    this.ws.send(JSON.stringify({ event: "media", media: { payload: Buffer.from("caller-audio").toString("base64"), timestamp: String(ts) } }));
  }
  stop() {
    this.ws.send(JSON.stringify({ event: "stop" }));
    this.ws.close();
  }
  of(event: string) {
    return this.received.filter((m) => m.event === event);
  }
}
