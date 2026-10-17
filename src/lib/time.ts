// Time-zone aware date helpers built only on Intl, so they run unchanged in
// Workers, the browser and Node (tests). All instants are plain `Date`s; "local"
// always means wall-clock time in an explicit IANA zone, never the host zone.

import type { TimeBucket } from "./types";

export interface LocalDateTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

export interface ZonedParts extends Required<LocalDateTime> {
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday ?? "Sun")
  };
}

/** Minutes the zone is ahead of UTC at `date` (e.g. +330 for Asia/Kolkata). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant. Out-of-range
 * fields roll over (day 32 becomes the next month), which makes "add N days
 * in local time" trivial. Times inside a DST gap resolve to a nearby instant.
 */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second ?? 0
  );
  const firstOffset = tzOffsetMinutes(new Date(guess), timeZone);
  let result = guess - firstOffset * 60_000;
  const secondOffset = tzOffsetMinutes(new Date(result), timeZone);
  if (secondOffset !== firstOffset) result = guess - secondOffset * 60_000;
  return new Date(result);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse "HH:MM" (24h) into minutes after midnight, or null if invalid. */
export function parseHHMM(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Normalise "7:5"-ish but valid input to "07:05". Returns null if invalid. */
export function normalizeHHMM(value: unknown): string | null {
  const minutes = parseHHMM(value);
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad(h)}:${pad(m)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function offsetString(date: Date, timeZone: string): string {
  const off = tzOffsetMinutes(date, timeZone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO-8601 with the zone's offset, e.g. 2026-10-17T09:00:00+05:30. */
export function toLocalIso(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    offsetString(date, timeZone)
  );
}

/** "YYYY-MM-DD" of the local calendar day. */
export function localDayKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addLocalDays(date: Date, timeZone: string, days: number): Date {
  const p = getZonedParts(date, timeZone);
  return zonedTimeToUtc({ ...p, day: p.day + days }, timeZone);
}

/** Next occurrence of local "HH:MM" strictly after `now`. */
export function nextLocalTime(now: Date, timeZone: string, hhmm: string): Date {
  const minutes = parseHHMM(hhmm) ?? 0;
  const p = getZonedParts(now, timeZone);
  const local = {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0
  };
  const today = zonedTimeToUtc(local, timeZone);
  if (today.getTime() > now.getTime()) return today;
  return zonedTimeToUtc({ ...local, day: local.day + 1 }, timeZone);
}

export function isInQuietHours(
  date: Date,
  timeZone: string,
  start: string,
  end: string
): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return false;
  const p = getZonedParts(date, timeZone);
  const m = p.hour * 60 + p.minute;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/**
 * If `date` falls inside the quiet window, move it to the end of that window
 * (handling windows that wrap past midnight). Otherwise return it unchanged.
 */
export function deferOutOfQuietHours(
  date: Date,
  timeZone: string,
  start: string,
  end: string
): Date {
  if (!isInQuietHours(date, timeZone, start, end)) return date;
  const s = parseHHMM(start) as number;
  const e = parseHHMM(end) as number;
  const p = getZonedParts(date, timeZone);
  const m = p.hour * 60 + p.minute;
  // In a wrapping window (22:00-07:00) the late-evening part ends tomorrow.
  const dayOffset = s > e && m >= s ? 1 : 0;
  return zonedTimeToUtc(
    {
      year: p.year,
      month: p.month,
      day: p.day + dayOffset,
      hour: Math.floor(e / 60),
      minute: e % 60,
      second: 0
    },
    timeZone
  );
}

export function timeBucket(date: Date, timeZone: string): TimeBucket {
  const { hour } = getZonedParts(date, timeZone);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * Cron expression (evaluated in UTC by the scheduler) that fires at local
 * `hhmm` for the zone's *current* UTC offset. Callers re-derive it when the
 * offset changes (DST) so the briefing stays on local time.
 */
export function utcCronForLocalTime(
  hhmm: string,
  timeZone: string,
  now: Date
): string {
  const next = nextLocalTime(now, timeZone, hhmm);
  return `${next.getUTCMinutes()} ${next.getUTCHours()} * * *`;
}

export function formatLocal(
  date: Date,
  timeZone: string,
  style: "full" | "short" | "time" = "short"
): string {
  const options: Intl.DateTimeFormatOptions =
    style === "full"
      ? {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }
      : style === "time"
        ? { hour: "numeric", minute: "2-digit" }
        : {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          };
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(
    date
  );
}

/**
 * Signed minutes between `date` (in local time) and local "HH:MM", wrapped
 * into (-720, 720]. Positive means `date` is after the target time, so
 * 23:55 vs 00:05 is +10, never -1430.
 */
export function minutesFromLocalTime(
  date: Date,
  timeZone: string,
  hhmm: string
): number {
  const target = parseHHMM(hhmm) ?? 0;
  const p = getZonedParts(date, timeZone);
  let diff = p.hour * 60 + p.minute - target;
  if (diff > 720) diff -= 1440;
  if (diff <= -720) diff += 1440;
  return diff;
}

/**
 * Parse a duration such as 15, "15", "15m", "90 min", "1h", "1.5 hours" or
 * "2d" into minutes. Bare numbers are minutes. Returns null if unparseable.
 */
export function parseDurationMinutes(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m =
    /^\s*(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)?\s*$/i.exec(
      value
    );
  if (!m) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const factor = unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 1;
  return Number(m[1]) * factor;
}

export function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 24) {
    const h = Math.round((minutes / 60) * 10) / 10;
    return `${h} h`;
  }
  const d = Math.round((minutes / 1440) * 10) / 10;
  return d === 1 ? "1 day" : `${d} days`;
}

// ── dueAt validation ────────────────────────────────────────────────────

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export type DueAtValidation =
  | { ok: true; date: Date; interpretedAsLocal: boolean }
  | { ok: false; error: string };

/**
 * Validate a model-supplied datetime. Accepts ISO-8601 with `Z` or an offset;
 * a bare local datetime (no offset) is interpreted in the user's zone, which
 * is the most common slip LLMs make. Rejects impossible dates, past times
 * (beyond a small grace window) and anything absurdly far in the future.
 */
export function validateDueAt(
  input: unknown,
  now: Date,
  timeZone: string,
  options: { graceMs?: number; maxYears?: number } = {}
): DueAtValidation {
  const graceMs = options.graceMs ?? 2 * 60_000;
  const maxYears = options.maxYears ?? 5;
  const example = toLocalIso(
    new Date(now.getTime() + 60 * 60_000),
    timeZone
  ).replace(/:\d{2}([+-])/, ":00$1");

  if (typeof input !== "string" || input.trim() === "") {
    return {
      ok: false,
      error: `dueAt is required as an ISO-8601 datetime with offset, e.g. ${example}.`
    };
  }
  const raw = input.trim();
  const m = ISO_RE.exec(raw);
  if (!m) {
    return {
      ok: false,
      error: `"${raw}" is not an ISO-8601 datetime. Use YYYY-MM-DDTHH:mm:ss±HH:MM, e.g. ${example}.`
    };
  }
  const [, y, mo, d, h, mi, s, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s ? Number(s) : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { ok: false, error: `"${raw}" is not a real calendar date/time.` };
  }

  let date: Date;
  let interpretedAsLocal = false;
  if (zone) {
    const normalizedZone =
      zone.toUpperCase() === "Z"
        ? "Z"
        : zone.includes(":")
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const base = `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}`;
    date = new Date(`${base}${normalizedZone}`);
  } else {
    date = zonedTimeToUtc({ year, month, day, hour, minute, second }, timeZone);
    interpretedAsLocal = true;
  }
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `"${raw}" could not be parsed as a datetime.` };
  }
  if (date.getTime() < now.getTime() - graceMs) {
    return {
      ok: false,
      error: `${raw} is in the past (it is now ${toLocalIso(now, timeZone)} in ${timeZone}). Ask the user for a future time or pick the next sensible one.`
    };
  }
  const max = new Date(now);
  max.setUTCFullYear(max.getUTCFullYear() + maxYears);
  if (date.getTime() > max.getTime()) {
    return {
      ok: false,
      error: `${raw} is more than ${maxYears} years away; that is probably a mistake.`
    };
  }
  return { ok: true, date, interpretedAsLocal };
}
