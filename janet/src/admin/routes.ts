// Private admin dashboard API. One owner, password login, signed HttpOnly session cookie, CSRF header on writes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { config, configStatus } from "../config.js";
import { safeEqual, sign, verify } from "../crypto.js";
import { q, q1 } from "../db.js";
import * as store from "../store.js";
import * as gcal from "../integrations/googleCalendar.js";
import { rateLimit } from "../ratelimit.js";
import { resolveTime, validZone } from "../time.js";

const COOKIE = "janet_session";
const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authed(req: FastifyRequest) {
  try {
    return verify(cookies(req)[COOKIE]) === "admin";
  } catch {
    return false;
  }
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!authed(req)) return reply.code(401).send({ error: "login required" });
  if (req.method !== "GET" && req.headers["x-janet-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });
}

const secure = () => config.publicBaseUrl.startsWith("https://");

export function registerAdminRoutes(app: FastifyInstance) {
  app.get("/admin", async (_req, reply) => {
    reply.header("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    return reply.type("text/html").send(await readFile(htmlPath, "utf8"));
  });

  app.post("/admin/login", async (req, reply) => {
    if (!rateLimit(`login:${req.ip}`, 8, 15 * 60_000)) return reply.code(429).send({ error: "Too many attempts. Try again later." });
    if (!configStatus().dashboard) return reply.code(503).send({ error: "Dashboard not configured: set JANET_ADMIN_PASSWORD (12+ chars) and JANET_SESSION_SECRET (32+ chars)" });
    const pw = String((req.body as any)?.password ?? "");
    if (!safeEqual(pw, config.adminPassword)) {
      await audit("dashboard", "login.failed", { detail: { ip: req.ip } });
      return reply.code(401).send({ error: "Wrong password" });
    }
    await audit("dashboard", "login.ok", { detail: { ip: req.ip } });
    reply.header("set-cookie", `${COOKIE}=${sign("admin", 12 * 3600)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}${secure() ? "; Secure" : ""}`);
    return { ok: true };
  });

  app.post("/admin/logout", async (_req, reply) => {
    reply.header("set-cookie", `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // Google OAuth (browser redirects, so cookie auth without CSRF header; state is signed).
  app.get("/admin/google/connect", async (req, reply) => {
    if (!authed(req)) return reply.redirect("/admin");
    if (!gcal.isConfigured()) return reply.code(400).send("Google is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JANET_ENCRYPTION_KEY, PUBLIC_BASE_URL");
    return reply.redirect(gcal.authUrl(sign("google-oauth", 600)));
  });

  app.get("/admin/google/callback", async (req, reply) => {
    if (!authed(req)) return reply.redirect("/admin");
    const qy = req.query as Record<string, string>;
    if (verify(qy.state) !== "google-oauth") return reply.code(400).send("Invalid or expired state. Start again from the dashboard.");
    if (qy.error) return reply.redirect("/admin#integrations");
    try {
      const r = await gcal.exchangeCode(qy.code);
      await audit("dashboard", "integration.google_connected", { detail: { email: r.email } });
    } catch (e) {
      await audit("dashboard", "integration.google_failed", { detail: { error: (e as Error).message } });
      return reply.code(502).send((e as Error).message);
    }
    return reply.redirect("/admin#integrations");
  });

  app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/admin/api/overview", async () => {
      const [counts] = await q(`SELECT
        (SELECT count(*) FROM janet_tasks WHERE status IN ('pending','in_progress','blocked')) AS open_tasks,
        (SELECT count(*) FROM janet_tasks WHERE status IN ('pending','in_progress','blocked') AND due_at < now()) AS overdue_tasks,
        (SELECT count(*) FROM janet_callbacks WHERE status IN ('scheduled','retry_scheduled','dialing','in_progress')) AS upcoming_callbacks,
        (SELECT count(*) FROM janet_calls WHERE created_at > now() - interval '7 days') AS calls_7d,
        (SELECT count(*) FROM janet_calls WHERE status IN ('failed','no_answer','busy') AND created_at > now() - interval '7 days') AS failed_calls_7d,
        (SELECT count(*) FROM janet_jobs WHERE status = 'dead') AS dead_jobs,
        (SELECT count(*) FROM janet_dev_tickets WHERE status NOT IN ('verified','closed','rejected')) AS open_tickets`);
      return {
        counts,
        config: configStatus(),
        settings: await store.getSettings(),
        callbacks: await store.listCallbacks({ upcomingOnly: true, limit: 5 }),
        calls: await q("SELECT id, direction, purpose, status, created_at, duration_seconds, error FROM janet_calls ORDER BY created_at DESC LIMIT 5"),
      };
    });

    api.get("/admin/api/calls", async () =>
      q(`SELECT c.id, c.direction, c.purpose, c.status, c.authorized, c.answered_by, c.error, c.created_at, c.ended_at, c.duration_seconds,
                c.conversation_id, c.callback_id, right(c.from_number, 4) AS from_last4, v.title
         FROM janet_calls c LEFT JOIN janet_conversations v ON v.id = c.conversation_id ORDER BY c.created_at DESC LIMIT 200`),
    );

    api.get("/admin/api/conversations", async () =>
      q("SELECT id, started_at, ended_at, title, summary, summary_status, topics FROM janet_conversations ORDER BY started_at DESC LIMIT 100"),
    );
    api.get("/admin/api/conversations/:id", async (req, reply) => {
      const id = (req.params as any).id;
      const c = await store.getConversation(id);
      if (!c) return reply.code(404).send({ error: "not found" });
      return { ...c, transcript: await store.getTranscript(id, 1000) };
    });

    api.get("/admin/api/tasks", async (req) => {
      const status = (req.query as any).status;
      return store.listTasks({ status: status ? String(status).split(",") : undefined, limit: 200 });
    });
    const taskBody = z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(store.TASK_STATUSES).optional(),
      priority: z.enum(store.PRIORITIES).optional(),
      owner: z.string().max(80).optional(),
      due_local: z.string().nullable().optional(),
      completion_evidence: z.string().max(2000).optional(),
    });
    api.post("/admin/api/tasks", async (req, reply) => {
      const b = taskBody.parse(req.body);
      if (!b.title) return reply.code(400).send({ error: "title required" });
      const s = await store.getSettings();
      const zone = validZone(s.timezone, config.defaultTimezone);
      const t = await store.createTask({ ...b, title: b.title, dueAt: b.due_local ? resolveTime({ local_datetime: b.due_local }, zone).at : null, dueTimezone: zone, createdVia: "dashboard" });
      await audit("dashboard", "task.create", { target: t.id, detail: { title: t.title } });
      return t;
    });
    api.patch("/admin/api/tasks/:id", async (req, reply) => {
      const b = taskBody.parse(req.body);
      const t = await store.findTask((req.params as any).id);
      if (!t) return reply.code(404).send({ error: "not found" });
      if (b.status === "completed" && !(b.completion_evidence ?? t.completion_evidence).trim())
        return reply.code(400).send({ error: "Completion evidence is required to mark a task completed" });
      const s = await store.getSettings();
      const zone = validZone(s.timezone, config.defaultTimezone);
      const due = b.due_local === null ? null : b.due_local ? resolveTime({ local_datetime: b.due_local }, zone).at : undefined;
      const u = await store.updateTask(t.id, { title: b.title, description: b.description, status: b.status, priority: b.priority, owner: b.owner, completion_evidence: b.completion_evidence, due_at: due });
      await audit("dashboard", "task.update", { target: t.id, detail: b });
      return u;
    });

    api.get("/admin/api/callbacks", async () => store.listCallbacks({ limit: 200 }));
    api.post("/admin/api/callbacks", async (req, reply) => {
      const b = z.object({ reason: z.string().min(3).max(500), delay_minutes: z.number().int().min(1).max(10080) }).parse(req.body);
      const s = await store.getSettings();
      const zone = validZone(s.timezone, config.defaultTimezone);
      const r = resolveTime({ delay_minutes: b.delay_minutes }, zone);
      const cb = await store.scheduleCallback({ reason: b.reason, requestedText: "(scheduled from dashboard)", at: r.at, zone, overrideQuietHours: true, maxAttempts: s.callback_max_attempts });
      await audit("dashboard", "callback.schedule", { target: cb.id, detail: b });
      return reply.send(cb);
    });
    api.post("/admin/api/callbacks/:id/cancel", async (req) => {
      const id = (req.params as any).id;
      const ok = await store.cancelCallback(id);
      if (ok) await audit("dashboard", "callback.cancel", { target: id });
      return { cancelled: ok };
    });

    api.get("/admin/api/memories", async () => store.listMemories({ limit: 500, includeInactive: false }));
    api.post("/admin/api/memories", async (req) => {
      const b = z.object({ kind: z.enum(store.MEMORY_KINDS), subject: z.string().max(200).optional(), content: z.string().min(1).max(4000) }).parse(req.body);
      const m = await store.addMemory({ ...b, source: "dashboard" });
      await audit("dashboard", "memory.add", { target: m.id });
      return m;
    });
    api.patch("/admin/api/memories/:id", async (req, reply) => {
      const b = z.object({ content: z.string().min(1).max(4000) }).parse(req.body);
      const m = await store.correctMemory((req.params as any).id, b.content);
      if (!m) return reply.code(404).send({ error: "not found" });
      await audit("dashboard", "memory.correct", { target: (req.params as any).id, detail: { new_id: m.id } });
      return m;
    });
    api.delete("/admin/api/memories/:id", async (req) => {
      const ok = await store.deleteMemory((req.params as any).id);
      if (ok) await audit("dashboard", "memory.delete", { target: (req.params as any).id });
      return { deleted: ok };
    });

    api.get("/admin/api/tickets", async () => store.listDevTickets(200));
    api.patch("/admin/api/tickets/:id", async (req) => {
      const b = z.object({ status: z.enum(["created", "submitted", "in_progress", "fix_proposed", "verified", "closed", "rejected"]), external_ref: z.string().max(300).optional() }).parse(req.body);
      const id = (req.params as any).id;
      const t = await q1("UPDATE janet_dev_tickets SET status=$2, external_ref=coalesce($3, external_ref), updated_at=now() WHERE id=$1 RETURNING *", [id, b.status, b.external_ref ?? null]);
      await audit("dashboard", "dev_ticket.update", { target: id, detail: b });
      return t;
    });

    api.get("/admin/api/jobs", async () =>
      q("SELECT id, kind, idempotency_key, payload, run_at, status, attempts, max_attempts, last_error, updated_at FROM janet_jobs ORDER BY (status IN ('queued','running')) DESC, run_at DESC LIMIT 100"),
    );

    api.get("/admin/api/integrations", async () => ({ config: configStatus(), google_calendar: await gcal.status(), rep_site: { enabled: config.repSiteReadEnabled } }));
    api.post("/admin/api/integrations/google/disconnect", async () => {
      await gcal.disconnect();
      await audit("dashboard", "integration.google_disconnected");
      return { ok: true };
    });

    api.get("/admin/api/settings", async () => store.getSettings());
    api.patch("/admin/api/settings", async (req, reply) => {
      try {
        const s = await store.updateSettings(req.body as Partial<store.Settings>);
        await audit("dashboard", "settings.update", { detail: req.body as Record<string, unknown> });
        return s;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    api.get("/admin/api/audit", async () => q("SELECT * FROM janet_audit ORDER BY at DESC LIMIT 300"));
  });
}
