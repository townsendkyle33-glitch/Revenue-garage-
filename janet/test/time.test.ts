import { describe as d, expect, it } from "vitest";
import { DateTime } from "luxon";
import { describe, inQuietHours, nextAllowed, resolveTime } from "../src/time.js";

const NY = "America/New_York";
const now = DateTime.fromISO("2026-11-13T15:00:00", { zone: NY });

d("time resolution", () => {
  it("resolves a relative delay", () => {
    const r = resolveTime({ delay_minutes: 5 }, NY, now);
    expect(r.at.toISOString()).toBe(now.plus({ minutes: 5 }).toJSDate().toISOString());
  });
  it("resolves a local wall-clock time in the owner's timezone", () => {
    const r = resolveTime({ local_datetime: "2026-11-14T09:00" }, NY, now);
    expect(r.at.toISOString()).toBe("2026-11-14T14:00:00.000Z"); // EST = UTC-5
  });
  it("honours an explicit timezone", () => {
    const r = resolveTime({ local_datetime: "2026-11-14T09:00", timezone: "America/Los_Angeles" }, NY, now);
    expect(r.at.toISOString()).toBe("2026-11-14T17:00:00.000Z");
  });
  it("rejects past times, both forms at once, and nonsense", () => {
    expect(() => resolveTime({ local_datetime: "2026-11-13T09:00" }, NY, now)).toThrow(/past/);
    expect(() => resolveTime({ delay_minutes: 5, local_datetime: "2026-11-14T09:00" }, NY, now)).toThrow();
    expect(() => resolveTime({ local_datetime: "tomorrowish" }, NY, now)).toThrow();
    expect(() => resolveTime({}, NY, now)).toThrow();
  });
  it("detects quiet hours that wrap midnight", () => {
    const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toJSDate();
    expect(inQuietHours(at("2026-11-13T22:00"), NY, "21:00", "08:00")).toBe(true);
    expect(inQuietHours(at("2026-11-14T07:59"), NY, "21:00", "08:00")).toBe(true);
    expect(inQuietHours(at("2026-11-14T08:00"), NY, "21:00", "08:00")).toBe(false);
    expect(inQuietHours(at("2026-11-13T15:00"), NY, "21:00", "08:00")).toBe(false);
    expect(nextAllowed(at("2026-11-13T23:30"), NY, "21:00", "08:00").toISOString()).toBe(at("2026-11-14T08:00").toISOString());
  });
  it("describes times naturally", () => {
    expect(describe(now.plus({ minutes: 5 }).toJSDate(), NY, now)).toBe("today at 3:05 PM EST");
    expect(describe(DateTime.fromISO("2026-11-14T09:00", { zone: NY }).toJSDate(), NY, now)).toBe("tomorrow at 9:00 AM EST");
  });
});
