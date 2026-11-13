import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { configStatus } from "./config.js";
import { registerTwilioRoutes } from "./twilio.js";
import { registerAdminRoutes } from "./admin/routes.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.authorization"] }, trustProxy: true, bodyLimit: 256 * 1024 });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Liveness/readiness without secrets.
  app.get("/health", async () => ({ ok: true, configured: configStatus() }));

  registerTwilioRoutes(app);
  registerAdminRoutes(app);
  return app;
}
