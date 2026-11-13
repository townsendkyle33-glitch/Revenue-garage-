// The complete set of actions the voice model may take. Anything not listed here cannot be executed.
// Risk levels:
//   read      - looks things up; runs immediately.
//   low       - creates or updates JANET's own records (tasks, callbacks, memory, tickets); runs immediately, audited.
//   sensitive - changes something outside JANET or destroys data; only creates a pending action that runs after
//               the owner says yes in a NEW utterance (enforced server-side, not by the model).
// There is deliberately no shell, SQL, deploy, payment or customer-messaging tool.
import { z } from "zod";
import { DateTime } from "luxon";
import { audit } from "./audit.js";
import { config } from "./config.js";
import * as store from "./store.js";
import { describe, inQuietHours, nowContext, resolveTime, TimeError, validZone } from "./time.js";
import * as gcal from "./integrations/googleCalendar.js";
import { repSite } from "./integrations/repSite.js";

export type ToolContext = {
  conversationId: string;
  callId?: string | null;
  /** Number of completed owner utterances in this conversation so far. */
  userTurns: () => number;
  /** Last thing the owner said (for audit of requests). */
  lastUserText: () => string;
  hangup?: () => void;
  now?: () => DateTime;
};

type Risk = "read" | "low" | "sensitive";

type ToolDef<S extends z.ZodTypeAny> = {
  description: string;
  risk: Risk;
  schema: S;
  /** For sensitive tools: what will be read back to the owner for confirmation. */
  confirmSummary?: (args: z.infer<S>, ctx: ToolContext) => Promise<string> | string;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
};

function def<S extends z.ZodTypeAny>(d: ToolDef<S>) {
  return d;
}

const when = z
  .object({
    delay_minutes: z.number().int().min(1).max(86400).optional().describe("Minutes from now, for relative requests like 'in five minutes'"),
    local_datetime: z
      .string()
      .optional()
      .describe("Local wall-clock time 'YYYY-MM-DDTHH:mm' in the timezone, for absolute requests like 'tomorrow at 9'"),
    timezone: z.string().optional().describe("IANA timezone; omit to use the owner's default"),
  })
  .describe("Exactly one of delay_minutes or local_datetime");

const priority = z.enum(store.PRIORITIES);

async function settingsZone() {
  const s = await store.getSettings();
  return { s, zone: validZone(s.timezone, config.defaultTimezone) };
}

function now(ctx: ToolContext) {
  return ctx.now ? ctx.now() : DateTime.now();
}

function taskView(t: store.TaskRow) {
  return {
    task_number: t.ref,
    title: t.title,
    description: t.description || undefined,
    status: t.status,
    priority: t.priority,
    owner: t.owner,
    due: t.due_at ? describe(t.due_at, t.due_timezone) : null,
    completion_evidence: t.completion_evidence || undefined,
    updated: t.updated_at,
  };
}

/** Typed lookup used by confirm_action (filled after TOOLS is defined, avoiding a circular type). */
const registry: Record<string, ToolDef<any>> = {};

export const TOOLS = {
  get_current_time: def({
    description: "Get the current date and time in the owner's timezone.",
    risk: "read",
    schema: z.object({}),
    run: async (_a, ctx) => {
      const { zone } = await settingsZone();
      return { now: nowContext(zone, now(ctx)) };
    },
  }),

  create_task: def({
    description:
      "Create a task from something the owner asked for. Confirm the title, owner, priority and due time back to them afterwards.",
    risk: "low",
    schema: z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      owner: z.string().max(80).optional().describe("Who will do it: 'me' (the owner), 'JANET', 'Claude', or a person's name"),
      priority: priority.optional(),
      due: when.optional(),
      required_integrations: z.array(z.enum(["google_calendar", "rep_site", "twilio", "claude_code"])).optional(),
      follow_up: when.optional().describe("When JANET should check on this task"),
    }),
    run: async (a, ctx) => {
      const { zone } = await settingsZone();
      const due = a.due ? resolveTime(a.due, zone, now(ctx)) : null;
      const fu = a.follow_up ? resolveTime(a.follow_up, zone, now(ctx)) : null;
      const t = await store.createTask({
        title: a.title,
        description: a.description,
        owner: a.owner,
        priority: a.priority,
        dueAt: due?.at ?? null,
        dueTimezone: due?.zone ?? zone,
        requiredIntegrations: a.required_integrations,
        nextFollowUpAt: fu?.at ?? null,
        conversationId: ctx.conversationId,
      });
      await audit("voice", "task.create", { target: t.id, conversationId: ctx.conversationId, detail: { ref: t.ref, title: t.title } });
      return { saved: true, task: taskView(t), follow_up: fu ? describe(fu.at, fu.zone, now(ctx)) : null };
    },
  }),

  update_task: def({
    description:
      "Change a task's status, priority, owner or due time, or add notes. Marking 'completed' requires completion_evidence: what actually shows it is done (e.g. 'Owner confirmed the fix is live'). Never mark something completed on assumption.",
    risk: "low",
    schema: z.object({
      task_number: z.number().int().positive(),
      status: z.enum(store.TASK_STATUSES).optional(),
      priority: priority.optional(),
      owner: z.string().max(80).optional(),
      due: when.optional(),
      completion_evidence: z.string().max(2000).optional(),
      note: z.string().max(1000).optional().describe("Appended to the description"),
    }),
    run: async (a, ctx) => {
      const t = await store.findTask(a.task_number);
      if (!t) return { saved: false, error: `There is no task number ${a.task_number}` };
      if (a.status === "completed" && !a.completion_evidence?.trim())
        return { saved: false, error: "completion_evidence is required to mark a task completed. Ask the owner how we know it is done." };
      const { zone } = await settingsZone();
      const due = a.due ? resolveTime(a.due, zone, now(ctx)) : undefined;
      const u = await store.updateTask(t.id, {
        status: a.status,
        priority: a.priority,
        owner: a.owner,
        due_at: due?.at,
        completion_evidence: a.completion_evidence,
        description: a.note ? `${t.description}${t.description ? "\n" : ""}[${new Date().toISOString().slice(0, 10)}] ${a.note}` : undefined,
      });
      await audit("voice", "task.update", { target: t.id, conversationId: ctx.conversationId, detail: { ref: t.ref, ...a } });
      return { saved: true, task: taskView(u!) };
    },
  }),

  list_tasks: def({
    description: "List tasks. Defaults to open tasks (pending, in_progress, blocked).",
    risk: "read",
    schema: z.object({
      status: z.array(z.enum(store.TASK_STATUSES)).optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    run: async (a) => {
      const rows = await store.listTasks({ status: a.status ?? ["pending", "in_progress", "blocked"], search: a.search, limit: a.limit ?? 10 });
      return { count: rows.length, tasks: rows.map(taskView) };
    },
  }),

  schedule_callback: def({
    description:
      "Schedule JANET to call the owner back. Always include a specific reason so the callback can open with it. After saving, read back the resolved time.",
    risk: "low",
    schema: z.object({
      reason: z.string().min(3).max(500).describe("What the callback is about, e.g. 'Discuss the Rep Site training library unlock issue'"),
      when,
      override_quiet_hours: z
        .boolean()
        .optional()
        .describe("Only true if the owner explicitly confirmed they want a call during quiet hours"),
    }),
    run: async (a, ctx) => {
      const { s, zone } = await settingsZone();
      let r;
      try {
        r = resolveTime(a.when, zone, now(ctx));
      } catch (e) {
        if (e instanceof TimeError) return { saved: false, error: e.message };
        throw e;
      }
      if (inQuietHours(r.at, r.zone, s.quiet_hours_start, s.quiet_hours_end) && !a.override_quiet_hours) {
        return {
          saved: false,
          needs_owner_decision: `That time (${describe(r.at, r.zone, now(ctx))}) is inside quiet hours (${s.quiet_hours_start}–${s.quiet_hours_end}). Ask whether to call anyway (then retry with override_quiet_hours true) or pick another time.`,
        };
      }
      const cb = await store.scheduleCallback({
        reason: a.reason,
        requestedText: ctx.lastUserText(),
        conversationId: ctx.conversationId,
        at: r.at,
        zone: r.zone,
        overrideQuietHours: a.override_quiet_hours,
        maxAttempts: s.callback_max_attempts,
      });
      await audit("voice", "callback.schedule", { target: cb.id, conversationId: ctx.conversationId, detail: { reason: a.reason, at: r.at } });
      const warn = s.calls_paused ? "Outbound calls are currently PAUSED in settings, so this callback will not ring until calls are resumed. Tell the owner." : undefined;
      return { saved: true, callback_id: cb.id, will_call_at: describe(r.at, r.zone, now(ctx)), reason: cb.reason, warning: warn };
    },
  }),

  list_callbacks: def({
    description: "List upcoming scheduled callbacks.",
    risk: "read",
    schema: z.object({}),
    run: async (_a, ctx) => {
      const rows = await store.listCallbacks({ upcomingOnly: true, limit: 10 });
      return {
        callbacks: rows.map((c) => ({
          callback_id: c.id,
          reason: c.reason,
          when: describe(c.next_attempt_at ?? c.scheduled_for, c.timezone, now(ctx)),
          status: c.status,
          attempts: c.attempts,
        })),
      };
    },
  }),

  cancel_callback: def({
    description: "Cancel a scheduled callback by its callback_id (from list_callbacks).",
    risk: "low",
    schema: z.object({ callback_id: z.string().uuid() }),
    run: async (a, ctx) => {
      const ok = await store.cancelCallback(a.callback_id);
      if (ok) await audit("voice", "callback.cancel", { target: a.callback_id, conversationId: ctx.conversationId });
      return ok ? { cancelled: true } : { cancelled: false, error: "No scheduled callback with that id (it may have already happened)" };
    },
  }),

  remember: def({
    description:
      "Save something the owner wants remembered long-term: a preference, decision, project fact, deadline, person, or commitment. Use when they say 'remember', or state a durable preference or decision.",
    risk: "low",
    schema: z.object({
      kind: z.enum(store.MEMORY_KINDS),
      subject: z.string().max(200).describe("Short label, e.g. 'Rep Site objection trainer'"),
      content: z.string().min(1).max(2000),
    }),
    run: async (a, ctx) => {
      const m = await store.addMemory({ ...a, source: "voice_explicit", conversationId: ctx.conversationId });
      await audit("voice", "memory.add", { target: m.id, conversationId: ctx.conversationId, detail: { kind: a.kind, subject: a.subject } });
      return { saved: true, memory_id: m.id };
    },
  }),

  search_memory: def({
    description: "Search long-term memory and past conversation summaries. Use before answering questions about past discussions.",
    risk: "read",
    schema: z.object({ query: z.string().min(2).max(200) }),
    run: async (a) => {
      const r = await store.searchMemory(a.query);
      return {
        memories: r.memories.map((m: any) => ({ memory_id: m.id, kind: m.kind, subject: m.subject, content: m.content, updated: m.updated_at })),
        past_conversations: r.conversations.map((c: any) => ({ when: c.started_at, title: c.title, summary: c.summary })),
      };
    },
  }),

  correct_memory: def({
    description: "Replace a remembered item with corrected information (the old version is kept as history).",
    risk: "low",
    schema: z.object({ memory_id: z.string().uuid(), corrected_content: z.string().min(1).max(2000) }),
    run: async (a, ctx) => {
      const m = await store.correctMemory(a.memory_id, a.corrected_content);
      if (!m) return { saved: false, error: "No active memory with that id" };
      await audit("voice", "memory.correct", { target: a.memory_id, conversationId: ctx.conversationId, detail: { new_id: m.id } });
      return { saved: true, memory_id: m.id };
    },
  }),

  forget_memory: def({
    description: "Permanently erase a remembered item. Requires the owner's confirmation.",
    risk: "sensitive",
    schema: z.object({ memory_id: z.string().uuid() }),
    confirmSummary: async (a) => {
      const r = await store.listMemories({ limit: 500 });
      const m: any = r.find((x: any) => x.id === a.memory_id);
      return m ? `Permanently erase the memory "${m.subject ? m.subject + ": " : ""}${m.content.slice(0, 160)}"` : "Erase a memory (not found)";
    },
    run: async (a, ctx) => {
      const ok = await store.deleteMemory(a.memory_id);
      await audit("voice", "memory.delete", { target: a.memory_id, conversationId: ctx.conversationId });
      return { erased: ok };
    },
  }),

  create_dev_ticket: def({
    description:
      "Create a development ticket for Claude Code (e.g. 'tell Claude to investigate…'). This only WRITES the ticket; it does not start development. Say so.",
    risk: "low",
    schema: z.object({
      title: z.string().min(3).max(200),
      problem: z.string().min(3).max(6000),
      component: z.string().max(200).optional().describe("Rep Site area, e.g. 'University library', 'Objection Trainer', 'Field Intelligence'"),
      reproduction: z.string().max(4000).optional(),
      priority: priority.optional(),
      acceptance_criteria: z.array(z.string().max(500)).max(10).optional(),
      follow_up: when.optional().describe("When the owner wants an update"),
    }),
    run: async (a, ctx) => {
      const { zone } = await settingsZone();
      const fu = a.follow_up ? resolveTime(a.follow_up, zone, now(ctx)) : null;
      const t: any = await store.createDevTicket({
        title: a.title,
        problem: a.problem,
        component: a.component,
        reproduction: a.reproduction,
        priority: a.priority,
        acceptanceCriteria: a.acceptance_criteria,
        followUpAt: fu?.at ?? null,
        conversationId: ctx.conversationId,
      });
      await audit("voice", "dev_ticket.create", { target: t.id, conversationId: ctx.conversationId, detail: { ref: t.ref, title: t.title } });
      return {
        saved: true,
        ticket_number: t.ref,
        status: "created",
        meaning: "The ticket is written down. No development runner is connected, so work has NOT started and nothing is fixed.",
        follow_up: fu ? describe(fu.at, fu.zone, now(ctx)) : null,
      };
    },
  }),

  list_dev_tickets: def({
    description: "List development tickets and their real status (created / submitted / in_progress / fix_proposed / verified / closed).",
    risk: "read",
    schema: z.object({}),
    run: async () => {
      const rows: any[] = await store.listDevTickets(10);
      return { tickets: rows.map((t) => ({ ticket_number: t.ref, title: t.title, component: t.component, priority: t.priority, status: t.status, created: t.created_at })) };
    },
  }),

  calendar_agenda: def({
    description: "Read the owner's Google Calendar for a day or range.",
    risk: "read",
    schema: z.object({
      local_date: z.string().optional().describe("YYYY-MM-DD; default today"),
      days: z.number().int().min(1).max(14).optional(),
    }),
    run: async (a, ctx) => {
      if (!gcal.isConfigured()) return { available: false, reason: "Google Calendar is not set up yet" };
      const { zone } = await settingsZone();
      const start = (a.local_date ? DateTime.fromISO(a.local_date, { zone }) : now(ctx).setZone(zone)).startOf("day");
      try {
        const events = await gcal.listEvents(start.toJSDate(), start.plus({ days: a.days ?? 1 }).toJSDate());
        return {
          source: "Google Calendar",
          range: `${start.toFormat("cccc LLL d")}${(a.days ?? 1) > 1 ? ` + ${(a.days ?? 1) - 1} days` : ""}`,
          events: events.map((e) => ({ ...e, start_local: e.all_day ? e.start : DateTime.fromISO(e.start).setZone(zone).toFormat("ccc h:mm a") })),
        };
      } catch (e) {
        return { available: false, reason: (e as Error).message };
      }
    },
  }),

  calendar_check_availability: def({
    description: "Check whether the owner is free in a time window and list conflicts.",
    risk: "read",
    schema: z.object({ local_start: z.string(), local_end: z.string(), timezone: z.string().optional() }),
    run: async (a) => {
      if (!gcal.isConfigured()) return { available: false, reason: "Google Calendar is not set up yet" };
      const { zone: dz } = await settingsZone();
      const zone = validZone(a.timezone, dz);
      const s = DateTime.fromISO(a.local_start, { zone });
      const e = DateTime.fromISO(a.local_end, { zone });
      if (!s.isValid || !e.isValid || e <= s) return { error: "Invalid time window" };
      try {
        const busy = await gcal.freeBusy(s.toJSDate(), e.toJSDate());
        return { free: busy.length === 0, conflicts: busy.map((b) => `${DateTime.fromISO(b.start).setZone(zone).toFormat("h:mm a")}–${DateTime.fromISO(b.end).setZone(zone).toFormat("h:mm a")}`) };
      } catch (err) {
        return { available: false, reason: (err as Error).message };
      }
    },
  }),

  calendar_create_event: def({
    description: "Create a Google Calendar event. Requires the owner's spoken confirmation; check availability first.",
    risk: "sensitive",
    schema: z.object({
      title: z.string().min(1).max(200),
      local_start: z.string().describe("YYYY-MM-DDTHH:mm"),
      duration_minutes: z.number().int().min(5).max(600),
      timezone: z.string().optional(),
      location: z.string().max(300).optional(),
      description: z.string().max(2000).optional(),
    }),
    confirmSummary: async (a) => {
      const { zone: dz } = await settingsZone();
      const zone = validZone(a.timezone, dz);
      const s = DateTime.fromISO(a.local_start, { zone });
      return `Add "${a.title}" to your calendar ${describe(s.toJSDate(), zone)} for ${a.duration_minutes} minutes${a.location ? ` at ${a.location}` : ""}`;
    },
    run: async (a, ctx) => {
      if (!gcal.isConfigured()) return { done: false, reason: "Google Calendar is not set up yet" };
      const { zone: dz } = await settingsZone();
      const zone = validZone(a.timezone, dz);
      const s = DateTime.fromISO(a.local_start, { zone });
      if (!s.isValid) return { done: false, error: "Invalid start time" };
      const ev = await gcal.createEvent({ title: a.title, start: s.toJSDate(), end: s.plus({ minutes: a.duration_minutes }).toJSDate(), timezone: zone, location: a.location, description: a.description });
      await audit("voice", "calendar.create", { target: ev.id, conversationId: ctx.conversationId, detail: { title: a.title, start: a.local_start } });
      return { done: true, event_id: ev.id, confirmed_by: "Google Calendar" };
    },
  }),

  calendar_move_event: def({
    description: "Reschedule an existing Google Calendar event (event_id from calendar_agenda). Requires the owner's spoken confirmation.",
    risk: "sensitive",
    schema: z.object({ event_id: z.string().min(1).max(300), new_local_start: z.string(), duration_minutes: z.number().int().min(5).max(600), timezone: z.string().optional() }),
    confirmSummary: async (a) => {
      const { zone: dz } = await settingsZone();
      const zone = validZone(a.timezone, dz);
      return `Move that event to ${describe(DateTime.fromISO(a.new_local_start, { zone }).toJSDate(), zone)} for ${a.duration_minutes} minutes`;
    },
    run: async (a, ctx) => {
      if (!gcal.isConfigured()) return { done: false, reason: "Google Calendar is not set up yet" };
      const { zone: dz } = await settingsZone();
      const zone = validZone(a.timezone, dz);
      const s = DateTime.fromISO(a.new_local_start, { zone });
      const r = await gcal.moveEvent(a.event_id, s.toJSDate(), s.plus({ minutes: a.duration_minutes }).toJSDate(), zone);
      await audit("voice", "calendar.move", { target: r.id, conversationId: ctx.conversationId, detail: a });
      return { done: true, confirmed_by: "Google Calendar" };
    },
  }),

  rep_site_status: def({
    description:
      "Read live Rep Site data. Topics: training_progress (who is behind), field_intelligence (are recordings transcribing), objection_trainer (activity and failures), university_health (library access, video errors, latest health check). Report only what the data says.",
    risk: "read",
    schema: z.object({ topic: z.enum(["training_progress", "field_intelligence", "objection_trainer", "university_health"]) }),
    run: async (a) => {
      const map = {
        training_progress: repSite.trainingProgress,
        field_intelligence: repSite.fieldIntelligence,
        objection_trainer: repSite.objectionTrainer,
        university_health: repSite.universityHealth,
      } as const;
      return map[a.topic]();
    },
  }),

  set_call_preferences: def({
    description: "Pause or resume JANET's outbound calls, turn briefings on or off, or change quiet hours.",
    risk: "low",
    schema: z.object({
      calls_paused: z.boolean().optional(),
      morning_briefing_enabled: z.boolean().optional(),
      morning_briefing_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      evening_briefing_enabled: z.boolean().optional(),
      evening_briefing_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      quiet_hours_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      quiet_hours_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    run: async (a, ctx) => {
      const s = await store.updateSettings(a);
      await audit("voice", "settings.update", { conversationId: ctx.conversationId, detail: a });
      return {
        saved: true,
        calls_paused: s.calls_paused,
        morning_briefing: s.morning_briefing_enabled ? s.morning_briefing_time : "off",
        evening_briefing: s.evening_briefing_enabled ? s.evening_briefing_time : "off",
        quiet_hours: `${s.quiet_hours_start}–${s.quiet_hours_end}`,
      };
    },
  }),

  confirm_action: def({
    description:
      "Execute a sensitive action the owner has just explicitly approved. Only call this after the owner says yes to the exact summary you read back.",
    risk: "read", // the gate is inside
    schema: z.object({ action_id: z.string().uuid() }),
    run: async (a, ctx): Promise<unknown> => {
      const p = await store.getPendingAction(a.action_id);
      if (!p || p.conversation_id !== ctx.conversationId) return { done: false, error: "No such pending action in this call" };
      if (p.status !== "awaiting_confirmation") return { done: false, error: `That action is already ${p.status}` };
      if (Date.now() - new Date(p.created_at).getTime() > 10 * 60_000) {
        await store.decidePendingAction(p.id, "expired");
        return { done: false, error: "That request expired; ask again if still wanted" };
      }
      if (ctx.userTurns() <= p.user_turns_at_creation) {
        return { done: false, error: "The owner has not answered yet. Read the summary and wait for their yes." };
      }
      const tool = registry[p.tool_name];
      if (!tool || tool.risk !== "sensitive") return { done: false, error: "Not a confirmable action" };
      try {
        const result = await tool.run(p.args, ctx);
        await store.decidePendingAction(p.id, "executed", result);
        await audit("voice", "sensitive.executed", { target: p.id, conversationId: ctx.conversationId, detail: { tool: p.tool_name, confirmed_after: ctx.lastUserText().slice(0, 200) } });
        return result;
      } catch (e) {
        await store.decidePendingAction(p.id, "failed", { error: (e as Error).message });
        return { done: false, error: (e as Error).message };
      }
    },
  }),

  cancel_action: def({
    description: "Discard a pending sensitive action the owner declined.",
    risk: "read",
    schema: z.object({ action_id: z.string().uuid() }),
    run: async (a, ctx) => {
      const r = await store.decidePendingAction(a.action_id, "rejected");
      if (r) await audit("voice", "sensitive.rejected", { target: a.action_id, conversationId: ctx.conversationId });
      return { cancelled: !!r };
    },
  }),

  end_call: def({
    description: "Hang up after saying goodbye, when the owner is done.",
    risk: "read",
    schema: z.object({}),
    run: async (_a, ctx) => {
      setTimeout(() => ctx.hangup?.(), 2500); // let the goodbye finish playing
      return { ending: true };
    },
  }),
} satisfies Record<string, ToolDef<any>>;
Object.assign(registry, TOOLS);

export type ToolName = keyof typeof TOOLS;

/** Tool definitions in the Realtime API's function format. */
export function realtimeToolDefs() {
  return Object.entries(registry).map(([name, t]) => {
    const schema = z.toJSONSchema(t.schema as z.ZodTypeAny, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    return { type: "function" as const, name, description: t.description, parameters: schema };
  });
}

const MAX_OUTPUT = 6000;

/** Execute a tool call from the model. Never throws; returns a JSON string for the model. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<{ output: string; ok: boolean }> {
  const tool = registry[name];
  if (!tool) {
    await audit("voice", "tool.rejected_unknown", { conversationId: ctx.conversationId, detail: { name } });
    return { ok: false, output: JSON.stringify({ error: `Unknown tool ${name}. Only listed tools exist.` }) };
  }
  let args: unknown;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, output: JSON.stringify({ error: "Arguments were not valid JSON" }) };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, output: JSON.stringify({ error: "Invalid arguments", issues: parsed.error.issues.slice(0, 5).map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".")}: ${i.message}`) }) };
  }
  try {
    let result: unknown;
    if (tool.risk === "sensitive") {
      const summary = tool.confirmSummary ? await tool.confirmSummary(parsed.data, ctx) : name;
      const p = await store.createPendingAction(ctx.conversationId, name, parsed.data, summary, ctx.userTurns());
      await audit("voice", "sensitive.requested", { target: p!.id, conversationId: ctx.conversationId, detail: { tool: name, summary } });
      result = {
        status: "needs_confirmation",
        action_id: p!.id,
        summary,
        instruction: "Nothing has happened yet. Read this summary to the owner and ask for a clear yes. Only after they say yes, call confirm_action with this action_id.",
      };
    } else {
      result = await tool.run(parsed.data, ctx);
    }
    let out = JSON.stringify(result);
    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '…(truncated)"';
    return { ok: true, output: out };
  } catch (e) {
    const msg = e instanceof TimeError ? e.message : `Tool failed: ${(e as Error).message}`;
    await audit("voice", "tool.error", { conversationId: ctx.conversationId, detail: { name, error: (e as Error).message } });
    return { ok: false, output: JSON.stringify({ error: msg, note: "Tell the owner this did not work. Do not claim it succeeded." }) };
  }
}
