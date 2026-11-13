import { q } from "./db.js";

export type Actor = "voice" | "dashboard" | "system" | "twilio";

export async function audit(
  actor: Actor,
  action: string,
  opts: { target?: string | null; conversationId?: string | null; detail?: Record<string, unknown> } = {},
) {
  try {
    await q("INSERT INTO janet_audit (actor, action, target, conversation_id, detail) VALUES ($1,$2,$3,$4,$5)", [
      actor,
      action,
      opts.target ?? null,
      opts.conversationId ?? null,
      JSON.stringify(opts.detail ?? {}),
    ]);
  } catch (e) {
    console.error("audit write failed", action, (e as Error).message);
  }
}
