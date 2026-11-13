// Google Calendar: OAuth (offline access, least-privilege scopes), event listing, free/busy, create and move.
// The refresh token is stored AES-256-GCM encrypted in janet_integrations and never leaves the server.
import { config } from "../config.js";
import { decrypt, encrypt } from "../crypto.js";
import { q, q1 } from "../db.js";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

const redirectUri = () => `${config.publicBaseUrl}/admin/google/callback`;

export function isConfigured() {
  return !!(config.googleClientId && config.googleClientSecret && config.encryptionKey.length >= 32 && config.publicBaseUrl);
}

export function authUrl(state: string) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return u.toString();
}

export async function exchangeCode(code: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const j: any = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`Google token exchange failed: ${j.error_description ?? j.error ?? r.status}`);
  let email: string | null = null;
  if (j.id_token) {
    try {
      email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email ?? null;
    } catch {}
  }
  await q(
    `INSERT INTO janet_integrations (provider, status, account_email, scopes, token_ciphertext, connected_at, last_ok_at, last_error)
     VALUES ('google_calendar','connected',$1,$2,$3,now(),now(),NULL)
     ON CONFLICT (provider) DO UPDATE SET status='connected', account_email=$1, scopes=$2, token_ciphertext=$3, connected_at=now(), last_ok_at=now(), last_error=NULL`,
    [email, String(j.scope ?? "").split(" "), encrypt(j.refresh_token)],
  );
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return { email };
}

export async function disconnect() {
  await q("UPDATE janet_integrations SET status='disconnected', token_ciphertext=NULL WHERE provider='google_calendar'");
  cached = null;
}

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now()) return cached.token;
  const row = await q1<{ token_ciphertext: string | null; status: string }>(
    "SELECT token_ciphertext, status FROM janet_integrations WHERE provider='google_calendar'",
  );
  if (!row?.token_ciphertext || row.status === "disconnected") throw new CalendarUnavailable("Google Calendar is not connected");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: decrypt(row.token_ciphertext),
      grant_type: "refresh_token",
    }),
  });
  const j: any = await r.json();
  if (!r.ok) {
    await q("UPDATE janet_integrations SET status='error', last_error=$1, last_error_at=now() WHERE provider='google_calendar'", [
      String(j.error_description ?? j.error ?? r.status),
    ]);
    throw new CalendarUnavailable(`Google refused the stored authorization (${j.error ?? r.status}); reconnect in the dashboard`);
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

export class CalendarUnavailable extends Error {}

async function gapi(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const j: any = r.status === 204 ? {} : await r.json();
  if (!r.ok) throw new Error(`Google Calendar error ${r.status}: ${j.error?.message ?? "unknown"}`);
  await q("UPDATE janet_integrations SET last_ok_at=now(), status='connected' WHERE provider='google_calendar'");
  return j;
}

export type CalEvent = { id: string; title: string; start: string; end: string; location?: string; attendees: number; all_day: boolean };

export async function listEvents(timeMin: Date, timeMax: Date, max = 25): Promise<CalEvent[]> {
  const p = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const j = await gapi(`/calendars/primary/events?${p}`);
  return (j.items ?? [])
    .filter((e: any) => e.status !== "cancelled")
    .map((e: any) => ({
      id: e.id,
      title: e.summary ?? "(no title)",
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location,
      attendees: (e.attendees ?? []).length,
      all_day: !e.start?.dateTime,
    }));
}

export async function freeBusy(timeMin: Date, timeMax: Date) {
  const j = await gapi("/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: "primary" }] }),
  });
  return (j.calendars?.primary?.busy ?? []) as { start: string; end: string }[];
}

export async function createEvent(e: { title: string; start: Date; end: Date; timezone: string; description?: string; location?: string }) {
  const j = await gapi("/calendars/primary/events?sendUpdates=none", {
    method: "POST",
    body: JSON.stringify({
      summary: e.title,
      description: e.description,
      location: e.location,
      start: { dateTime: e.start.toISOString(), timeZone: e.timezone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timezone },
    }),
  });
  return { id: j.id as string, link: j.htmlLink as string };
}

export async function moveEvent(id: string, start: Date, end: Date, timezone: string) {
  const j = await gapi(`/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: "PATCH",
    body: JSON.stringify({ start: { dateTime: start.toISOString(), timeZone: timezone }, end: { dateTime: end.toISOString(), timeZone: timezone } }),
  });
  return { id: j.id as string };
}

export async function status() {
  const row = await q1("SELECT status, account_email, scopes, connected_at, last_ok_at, last_error, last_error_at FROM janet_integrations WHERE provider='google_calendar'");
  return { configured: isConfigured(), ...(row ?? { status: "disconnected" }) };
}
