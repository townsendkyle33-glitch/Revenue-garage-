// Bridges a Twilio Media Stream (μ-law 8 kHz audio over WebSocket) to the OpenAI Realtime API.
// - Streams audio both ways with no transcoding (both sides speak G.711 μ-law).
// - Barge-in: when the owner starts talking, queued audio is cleared on Twilio and the model's reply is truncated
//   at what was actually heard.
// - Tool calls are executed server-side through the allowlisted tool engine.
// - Text transcripts are saved as the call happens (audio is never stored).
// - If the OpenAI connection drops mid-call, it reconnects and resumes with the transcript so far.
import WebSocket from "ws";
import { config } from "./config.js";
import * as store from "./store.js";
import { audit } from "./audit.js";
import { buildInstructions, type CallPurpose } from "./context.js";
import { executeTool, realtimeToolDefs, type ToolContext } from "./tools.js";

type TwilioMsg =
  | { event: "connected" }
  | { event: "start"; start: { streamSid: string; callSid: string; customParameters?: Record<string, string> } }
  | { event: "media"; media: { payload: string; timestamp: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "stop" };

export type SessionInit = { callId: string; conversationId: string; purpose: CallPurpose };

const MAX_RECONNECTS = 2;

export class CallSession {
  private oa: WebSocket | null = null;
  private streamSid = "";
  private closed = false;
  private reconnects = 0;
  private userTurns = 0; // committed owner utterances (used to gate sensitive confirmations)
  private lastUserText = "";
  private latestMediaTs = 0;
  private responseStartTs: number | null = null;
  private lastAssistantItem: string | null = null;
  private marks: string[] = [];
  private pendingCalls = new Set<string>();
  private transcriptsEnabled = true;
  private toolCtx: ToolContext;

  constructor(private twilio: WebSocket, private init: SessionInit) {
    this.toolCtx = {
      conversationId: init.conversationId,
      callId: init.callId,
      userTurns: () => this.userTurns,
      lastUserText: () => this.lastUserText,
      hangup: () => this.hangup(),
    };
    twilio.on("message", (raw) => this.onTwilio(raw.toString()));
    twilio.on("close", () => this.finish("twilio_closed"));
    twilio.on("error", (e) => console.error("twilio ws error", e.message));
  }

  /** Called with the Twilio 'start' message that carried the verified parameters. */
  setStream(streamSid: string) {
    this.streamSid = streamSid;
  }

  async start() {
    const s = await store.getSettings();
    this.transcriptsEnabled = s.transcripts_enabled;
    await store.updateCall(this.init.callId, { status: "in_progress", conversation_id: this.init.conversationId, answered_at: new Date() });
    if (this.init.purpose.kind === "callback") {
      await store.updateCallback(this.init.purpose.callbackId, { status: "in_progress" });
    }
    await this.connectOpenAI(false);
  }

  private async connectOpenAI(resuming: boolean) {
    const { instructions, opening } = await buildInstructions(this.init.purpose, this.init.conversationId);
    let fullInstructions = instructions;
    if (resuming) {
      const t = await store.getTranscript(this.init.conversationId, 40);
      fullInstructions +=
        "\n\nTHE LINE BRIEFLY DROPPED. Transcript of this call so far:\n<data source=\"this_call\">\n" +
        t.filter((m) => m.role !== "tool").map((m) => `${m.role === "user" ? "Owner" : "JANET"}: ${m.content}`).join("\n") +
        "\n</data>";
    }
    const url = `${config.realtimeUrl}?model=${encodeURIComponent(config.realtimeModel)}`;
    const oa = new WebSocket(url, { headers: { Authorization: `Bearer ${config.openaiApiKey}` } });
    this.oa = oa;

    oa.on("open", () => {
      this.sendOA({
        type: "session.update",
        session: {
          type: "realtime",
          model: config.realtimeModel,
          instructions: fullInstructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: { model: config.transcriptionModel },
              turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true },
              noise_reduction: { type: "near_field" },
            },
            output: { format: { type: "audio/pcmu" }, voice: config.voice },
          },
          tools: realtimeToolDefs(),
          tool_choice: "auto",
        },
      });
      const kickoff = resuming
        ? "The line dropped for a moment. Briefly apologize, say where you were, and continue."
        : opening;
      if (kickoff) {
        this.sendOA({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: kickoff }] } });
        this.sendOA({ type: "response.create" });
      }
    });
    oa.on("message", (raw) => this.onOpenAI(raw.toString()).catch((e) => console.error("realtime handler error", e)));
    oa.on("close", (code) => {
      if (this.closed || this.oa !== oa) return;
      if (this.reconnects < MAX_RECONNECTS) {
        this.reconnects++;
        audit("system", "realtime.reconnect", { target: this.init.callId, conversationId: this.init.conversationId, detail: { code, attempt: this.reconnects } });
        setTimeout(() => this.connectOpenAI(true).catch((e) => this.fatal(`reconnect failed: ${e.message}`)), 300);
      } else {
        this.fatal(`OpenAI connection closed (${code})`);
      }
    });
    oa.on("error", (e) => console.error("openai ws error", e.message));
  }

  private sendOA(msg: unknown) {
    if (this.oa?.readyState === WebSocket.OPEN) this.oa.send(JSON.stringify(msg));
  }
  private sendTwilio(msg: unknown) {
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify(msg));
  }

  private onTwilio(raw: string) {
    let m: TwilioMsg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.event) {
      case "start":
        this.streamSid = m.start.streamSid;
        break;
      case "media":
        this.latestMediaTs = Number(m.media.timestamp) || this.latestMediaTs;
        this.sendOA({ type: "input_audio_buffer.append", audio: m.media.payload });
        break;
      case "mark":
        if (this.marks.length) this.marks.shift();
        break;
      case "stop":
        this.finish("stream_stopped");
        break;
    }
  }

  private async onOpenAI(raw: string) {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta": {
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        if (this.responseStartTs === null) this.responseStartTs = this.latestMediaTs;
        if (ev.item_id) this.lastAssistantItem = ev.item_id;
        const name = `r${Date.now()}`;
        this.sendTwilio({ event: "mark", streamSid: this.streamSid, mark: { name } });
        this.marks.push(name);
        break;
      }
      case "input_audio_buffer.speech_started":
        this.handleBargeIn();
        break;
      case "input_audio_buffer.committed":
        this.userTurns++;
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(ev.transcript ?? "").trim();
        if (text) {
          this.lastUserText = text;
          if (this.transcriptsEnabled) await store.addMessage(this.init.conversationId, "user", text);
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const text = String(ev.transcript ?? "").trim();
        if (text && this.transcriptsEnabled) await store.addMessage(this.init.conversationId, "assistant", text);
        break;
      }
      case "response.done":
        this.responseStartTs = null;
        await this.handleFunctionCalls(ev.response);
        break;
      case "error":
        console.error("realtime error", ev.error);
        audit("system", "realtime.error", { target: this.init.callId, conversationId: this.init.conversationId, detail: { error: ev.error } });
        break;
    }
  }

  /** Owner started talking over JANET: stop playback and cut her reply at what was heard. */
  private handleBargeIn() {
    if (!this.marks.length || this.responseStartTs === null) return;
    const elapsed = Math.max(0, this.latestMediaTs - this.responseStartTs);
    if (this.lastAssistantItem) {
      this.sendOA({ type: "conversation.item.truncate", item_id: this.lastAssistantItem, content_index: 0, audio_end_ms: elapsed });
    }
    this.sendTwilio({ event: "clear", streamSid: this.streamSid });
    this.marks = [];
    this.lastAssistantItem = null;
    this.responseStartTs = null;
  }

  private async handleFunctionCalls(response: any) {
    const calls = (response?.output ?? []).filter((o: any) => o.type === "function_call" && !this.pendingCalls.has(o.call_id));
    if (!calls.length) return;
    for (const c of calls) {
      this.pendingCalls.add(c.call_id);
      const r = await executeTool(c.name, c.arguments ?? "{}", this.toolCtx);
      await store.addMessage(this.init.conversationId, "tool", `${c.name}(${(c.arguments ?? "").slice(0, 500)}) -> ${r.output.slice(0, 1500)}`, c.name);
      this.sendOA({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: r.output } });
    }
    this.sendOA({ type: "response.create" });
  }

  private hangup() {
    this.finish("janet_hung_up");
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.close(); // ends <Connect>; with no more TwiML, Twilio hangs up
  }

  private fatal(reason: string) {
    console.error("call session fatal:", reason);
    audit("system", "call.fatal", { target: this.init.callId, conversationId: this.init.conversationId, detail: { reason } });
    store.updateCall(this.init.callId, { error: reason }).catch(() => {});
    this.hangup();
  }

  private finishing = false;
  private async finish(reason: string) {
    if (this.finishing) return;
    this.finishing = true;
    this.closed = true;
    try {
      this.oa?.close();
    } catch {}
    await store.endConversation(this.init.conversationId).catch(() => {});
    if (this.init.purpose.kind === "callback") {
      await store.updateCallback(this.init.purpose.callbackId, { status: "completed" }).catch(() => {});
    }
    // Summarize durably, shortly after the call (gives late transcription events a moment to land).
    await store
      .enqueueJob("summarize_conversation", `summarize:${this.init.conversationId}`, { conversationId: this.init.conversationId }, new Date(Date.now() + 5000))
      .catch((e) => console.error("could not queue summary", e));
    audit("system", "call.stream_ended", { target: this.init.callId, conversationId: this.init.conversationId, detail: { reason } });
  }

  /** For tests. */
  get state() {
    return { userTurns: this.userTurns, closed: this.closed, reconnects: this.reconnects };
  }
}
