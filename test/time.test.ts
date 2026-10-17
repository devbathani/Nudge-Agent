import { describe, expect, it } from "vitest";
import {
  deferOutOfQuietHours,
  isInQuietHours,
  isValidTimeZone,
  localDayKey,
  minutesFromLocalTime,
  nextLocalTime,
  normalizeHHMM,
  parseDurationMinutes,
  toLocalIso,
  tzOffsetMinutes,
  utcCronForLocalTime,
  validateDueAt,
  zonedTimeToUtc
} from "../src/lib/time";

const KOLKATA = "Asia/Kolkata"; // +05:30, no DST
const NEW_YORK = "America/New_York"; // DST

describe("zone conversion", () => {
  it("converts local wall time to UTC for a fixed-offset zone", () => {
    const d = zonedTimeToUtc(
      { year: 2026, month: 10, day: 18, hour: 9, minute: 0 },
      KOLKATA
    );
    expect(d.toISOString()).toBe("2026-10-18T03:30:00.000Z");
  });

  it("handles DST on both sides of the switch", () => {
    // EDT (UTC-4) before Nov 1 2026, EST (UTC-5) after.
    const before = zonedTimeToUtc(
      { year: 2026, month: 10, day: 31, hour: 9, minute: 0 },
      NEW_YORK
    );
    const after = zonedTimeToUtc(
      { year: 2026, month: 11, day: 2, hour: 9, minute: 0 },
      NEW_YORK
    );
    expect(before.toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(after.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(tzOffsetMinutes(before, NEW_YORK)).toBe(-240);
    expect(tzOffsetMinutes(after, NEW_YORK)).toBe(-300);
  });

  it("rolls over out-of-range days", () => {
    const d = zonedTimeToUtc(
      { year: 2026, month: 1, day: 32, hour: 0, minute: 0 },
      "UTC"
    );
    expect(d.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("formats local ISO with offset", () => {
    const d = new Date("2026-10-18T03:30:00Z");
    expect(toLocalIso(d, KOLKATA)).toBe("2026-10-18T09:00:00+05:30");
    expect(localDayKey(new Date("2026-10-17T20:00:00Z"), KOLKATA)).toBe(
      "2026-10-18"
    );
  });

  it("validates time zones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("nextLocalTime", () => {
  it("returns today if the time is still ahead, otherwise tomorrow", () => {
    const now = new Date("2026-10-17T02:00:00Z"); // 07:30 in Kolkata
    expect(nextLocalTime(now, KOLKATA, "08:00").toISOString()).toBe(
      "2026-10-17T02:30:00.000Z"
    );
    expect(nextLocalTime(now, KOLKATA, "07:00").toISOString()).toBe(
      "2026-10-18T01:30:00.000Z"
    );
  });
});

describe("quiet hours", () => {
  const start = "22:00";
  const end = "07:00";

  it("detects times inside a window that wraps midnight", () => {
    expect(
      isInQuietHours(new Date("2026-10-17T23:30:00Z"), "UTC", start, end)
    ).toBe(true);
    expect(
      isInQuietHours(new Date("2026-10-17T03:00:00Z"), "UTC", start, end)
    ).toBe(true);
    expect(
      isInQuietHours(new Date("2026-10-17T07:00:00Z"), "UTC", start, end)
    ).toBe(false);
    expect(
      isInQuietHours(new Date("2026-10-17T12:00:00Z"), "UTC", start, end)
    ).toBe(false);
  });

  it("supports same-day windows and disables equal start/end", () => {
    expect(
      isInQuietHours(new Date("2026-10-17T13:30:00Z"), "UTC", "13:00", "14:00")
    ).toBe(true);
    expect(
      isInQuietHours(new Date("2026-10-17T13:30:00Z"), "UTC", "09:00", "09:00")
    ).toBe(false);
  });

  it("defers late-evening times to tomorrow morning", () => {
    const d = deferOutOfQuietHours(
      new Date("2026-10-17T23:30:00Z"),
      "UTC",
      start,
      end
    );
    expect(d.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });

  it("defers early-morning times to the same morning", () => {
    const d = deferOutOfQuietHours(
      new Date("2026-10-18T02:15:00Z"),
      "UTC",
      start,
      end
    );
    expect(d.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });

  it("respects the user's zone, not UTC", () => {
    // 23:00 in Kolkata = 17:30Z; quiet until 07:00 IST = 01:30Z next day.
    const d = deferOutOfQuietHours(
      new Date("2026-10-17T17:30:00Z"),
      KOLKATA,
      start,
      end
    );
    expect(d.toISOString()).toBe("2026-10-18T01:30:00.000Z");
  });

  it("leaves times outside quiet hours untouched", () => {
    const t = new Date("2026-10-17T12:00:00Z");
    expect(deferOutOfQuietHours(t, "UTC", start, end)).toBe(t);
  });
});

describe("HH:MM helpers", () => {
  it("normalises valid times and rejects bad ones", () => {
    expect(normalizeHHMM("7:05")).toBe("07:05");
    expect(normalizeHHMM("23:59")).toBe("23:59");
    expect(normalizeHHMM("24:00")).toBeNull();
    expect(normalizeHHMM("noon")).toBeNull();
  });

  it("derives a UTC cron for a local briefing time", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    expect(utcCronForLocalTime("08:00", KOLKATA, now)).toBe("30 2 * * *");
    expect(utcCronForLocalTime("08:00", NEW_YORK, now)).toBe("0 12 * * *");
  });
});

describe("validateDueAt", () => {
  const now = new Date("2026-10-17T06:00:00Z"); // 11:30 IST

  it("accepts a future ISO datetime with offset", () => {
    const r = validateDueAt("2026-10-18T09:00:00+05:30", now, KOLKATA);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date.toISOString()).toBe("2026-10-18T03:30:00.000Z");
      expect(r.interpretedAsLocal).toBe(false);
    }
  });

  it("accepts Z and compact offsets", () => {
    expect(validateDueAt("2026-10-18T09:00:00Z", now, KOLKATA).ok).toBe(true);
    const compact = validateDueAt("2026-10-18T09:00+0530", now, KOLKATA);
    expect(compact.ok && compact.date.toISOString()).toBe(
      "2026-10-18T03:30:00.000Z"
    );
  });

  it("interprets a missing offset as the user's local time", () => {
    const r = validateDueAt("2026-10-18T09:00", now, KOLKATA);
    expect(r.ok && r.interpretedAsLocal).toBe(true);
    expect(r.ok && r.date.toISOString()).toBe("2026-10-18T03:30:00.000Z");
  });

  it("rejects past times with a recoverable message", () => {
    const r = validateDueAt("2026-10-16T09:00:00+05:30", now, KOLKATA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/in the past/);
  });

  it("allows a small grace window for 'right now'", () => {
    expect(validateDueAt("2026-10-17T11:29:00+05:30", now, KOLKATA).ok).toBe(
      true
    );
  });

  it("rejects garbage, impossible dates and far-future dates", () => {
    expect(validateDueAt("next friday", now, KOLKATA).ok).toBe(false);
    expect(validateDueAt("", now, KOLKATA).ok).toBe(false);
    expect(validateDueAt(undefined, now, KOLKATA).ok).toBe(false);
    expect(validateDueAt("2027-02-30T09:00:00Z", now, KOLKATA).ok).toBe(false);
    expect(validateDueAt("2026-10-18T25:00:00Z", now, KOLKATA).ok).toBe(false);
    expect(validateDueAt("2040-01-01T09:00:00Z", now, KOLKATA).ok).toBe(false);
  });

  it("puts a usable example in the error", () => {
    const r = validateDueAt("tomorrow", now, KOLKATA);
    expect(!r.ok && r.error).toMatch(/\+05:30/);
  });
});

describe("minutesFromLocalTime (briefing timing)", () => {
  it("is signed and wraps around midnight in both directions", () => {
    const at = (iso: string) => new Date(iso);
    expect(
      minutesFromLocalTime(at("2026-10-17T08:05:00Z"), "UTC", "08:00")
    ).toBe(5);
    expect(
      minutesFromLocalTime(at("2026-10-17T07:40:00Z"), "UTC", "08:00")
    ).toBe(-20);
    // Briefing at 23:55 delivered at 00:05 is 10 minutes late, not 1430 early.
    expect(
      minutesFromLocalTime(at("2026-10-18T00:05:00Z"), "UTC", "23:55")
    ).toBe(10);
    // Briefing at 00:05 fired at 23:50 is 15 minutes early.
    expect(
      minutesFromLocalTime(at("2026-10-17T23:50:00Z"), "UTC", "00:05")
    ).toBe(-15);
  });

  it("uses the user's zone", () => {
    // 02:30Z = 08:00 in Kolkata.
    expect(
      minutesFromLocalTime(
        new Date("2026-10-17T02:30:00Z"),
        "Asia/Kolkata",
        "08:00"
      )
    ).toBe(0);
  });
});

describe("parseDurationMinutes", () => {
  it("understands units", () => {
    expect(parseDurationMinutes(15)).toBe(15);
    expect(parseDurationMinutes("15")).toBe(15);
    expect(parseDurationMinutes("90 min")).toBe(90);
    expect(parseDurationMinutes("1h")).toBe(60);
    expect(parseDurationMinutes("1.5 hours")).toBe(90);
    expect(parseDurationMinutes("2d")).toBe(2880);
  });

  it("rejects things it can't read instead of guessing", () => {
    expect(parseDurationMinutes("abc")).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("1 month")).toBeNull();
    expect(parseDurationMinutes(Number.NaN)).toBeNull();
  });
});
