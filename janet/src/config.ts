// Configuration. The server starts with any subset of credentials; each integration reports itself
// as "not configured" instead of pretending to work.
import "dotenv/config";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  port: Number(env("PORT", "8080")),
  publicBaseUrl: env("PUBLIC_BASE_URL").replace(/\/+$/, ""), // e.g. https://janet.example.com (must be https in production)
  databaseUrl: env("DATABASE_URL"),
  databaseSsl: env("DATABASE_SSL", "auto"), // auto | require | disable

  ownerPhone: env("JANET_OWNER_PHONE"), // E.164, e.g. +15615550123. Only this caller is authorized.
  ownerName: env("JANET_OWNER_NAME", "Kyle"),
  callerPin: env("JANET_CALLER_PIN"), // optional keypad PIN required on inbound calls (caller ID can be spoofed)
  defaultTimezone: env("JANET_TIMEZONE", "America/New_York"),

  twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  twilioNumber: env("TWILIO_PHONE_NUMBER"), // JANET's dedicated number, E.164
  validateTwilioSignature: env("TWILIO_VALIDATE_SIGNATURE", "true") !== "false",

  openaiApiKey: env("OPENAI_API_KEY"),
  realtimeModel: env("OPENAI_REALTIME_MODEL", "gpt-realtime"),
  realtimeUrl: env("OPENAI_REALTIME_URL", "wss://api.openai.com/v1/realtime"),
  voice: env("JANET_VOICE", "marin"),
  transcriptionModel: env("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
  summaryModel: env("OPENAI_SUMMARY_MODEL", "gpt-4.1-mini"),
  openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),

  googleClientId: env("GOOGLE_CLIENT_ID"),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
  encryptionKey: env("JANET_ENCRYPTION_KEY"), // >= 32 chars; encrypts stored OAuth tokens

  repSiteReadEnabled: env("REP_SITE_READ_ENABLED", "false") === "true", // only when DATABASE_URL is Rep Site's Supabase

  adminPassword: env("JANET_ADMIN_PASSWORD"),
  sessionSecret: env("JANET_SESSION_SECRET"), // >= 32 chars; signs dashboard sessions and media-stream tokens

  workerEnabled: env("JANET_WORKER_ENABLED", "true") !== "false",
  workerPollMs: Number(env("JANET_WORKER_POLL_MS", "5000")),
};

export type Config = typeof config;

export function configStatus() {
  return {
    database: !!config.databaseUrl,
    twilio: !!(config.twilioAccountSid && config.twilioAuthToken && config.twilioNumber),
    publicBaseUrl: !!config.publicBaseUrl,
    ownerPhone: /^\+[1-9]\d{6,14}$/.test(config.ownerPhone),
    openai: !!config.openaiApiKey,
    googleCalendar: !!(config.googleClientId && config.googleClientSecret && config.encryptionKey.length >= 32),
    repSite: config.repSiteReadEnabled,
    dashboard: config.adminPassword.length >= 12 && config.sessionSecret.length >= 32,
  };
}
