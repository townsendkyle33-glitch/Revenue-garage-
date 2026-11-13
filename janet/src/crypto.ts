import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

function key(): Buffer {
  if (config.encryptionKey.length < 32) throw new Error("JANET_ENCRYPTION_KEY must be at least 32 characters");
  return createHash("sha256").update(`janet-aes:${config.encryptionKey}`).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${Buffer.concat([ct, c.getAuthTag()]).toString("base64url")}`;
}

export function decrypt(token: string): string {
  const [v, ivB, ctB] = token.split(".");
  if (v !== "v1" || !ivB || !ctB) throw new Error("bad ciphertext");
  const buf = Buffer.from(ctB, "base64url");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
}

function secret(): string {
  if (config.sessionSecret.length < 32) throw new Error("JANET_SESSION_SECRET must be at least 32 characters");
  return config.sessionSecret;
}

/** Signed, expiring token: payload.expiry.signature */
export function sign(payload: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${Buffer.from(payload).toString("base64url")}.${exp}`;
  return `${body}.${createHmac("sha256", secret()).update(body).digest("base64url")}`;
}

export function verify(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(parts[1]) < Date.now() / 1000) return null;
  return Buffer.from(parts[0], "base64url").toString();
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
