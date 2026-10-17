// Pure task logic: the lifecycle state machine, escalation, backoff,
// recurrence and grouping. No I/O and no Cloudflare imports, so every rule
// here is covered by unit tests in test/tasks.test.ts.

import {
  daysInMonth,
  deferOutOfQuietHours,
  getZonedParts,
  localDayKey,
  zonedTimeToUtc
} from "./time";
import type {
  EscalationLevel,
  Persistence,
  Preferences,
  Repeat,
  Task,
  TaskStatus
} from "./types";

// ── State machine ───────────────────────────────────────────────────────
//
//   pending ──nudge──▶ nudged ──snooze──▶ snoozed ──nudge──▶ nudged …
//      │                 │                   │
//      └──complete/cancel┴───────────────────┴──▶ done | cancelled (terminal)
//
// `reschedule` (new dueAt) sends any active task back to `pending`.

export type TaskAction =
  | "nudge"
  | "snooze"
  | "complete"
  | "cancel"
  | "reschedule";

const ACTIVE_TRANSITIONS: Record<TaskAction, TaskStatus> = {
  nudge: "nudged",
  snooze: "snoozed",
  complete: "done",
  cancel: "cancelled",
  reschedule: "pending"
};

export const TRANSITIONS: Record<
  TaskStatus,
  Partial<Record<TaskAction, TaskStatus>>
> = {
  pending: ACTIVE_TRANSITIONS,
  nudged: ACTIVE_TRANSITIONS,
  snoozed: ACTIVE_TRANSITIONS,
  done: {},
  cancelled: {}
};

export type TransitionResult =
  | { ok: true; status: TaskStatus }
  | { ok: false; error: string };

export function transition(
  status: TaskStatus,
  action: TaskAction
): TransitionResult {
  const next = TRANSITIONS[status]?.[action];
  if (!next) {
    return {
      ok: false,
      error: `Cannot ${action} a task that is already ${status}.`
    };
  }
  return { ok: true, status: next };
}

export function isActive(status: TaskStatus): boolean {
  return status === "pending" || status === "nudged" || status === "snoozed";
}

// ── Escalation & backoff ────────────────────────────────────────────────

export const LEVELS: readonly EscalationLevel[] = ["gentle", "firm", "urgent"];

/** Default number of nudges before Nudge stops on its own. */
export const DEFAULT_MAX_NUDGES: Record<Persistence, number> = {
  gentle: 3,
  firm: 5,
  urgent: 8
};

export const MAX_NUDGES_LIMIT = 20;

/**
 * Tone for the Nth nudge (1-based). Starts at the task's persistence and
 * climbs one level every two nudges, capped at `urgent`.
 */
export function escalationLevel(
  persistence: Persistence,
  nudgeNumber: number
): EscalationLevel {
  const base = LEVELS.indexOf(persistence);
  const bump = Math.floor(Math.max(0, nudgeNumber - 1) / 2);
  return LEVELS[Math.min(LEVELS.length - 1, base + bump)];
}

/** Gap after the Nth nudge: 15m, 1h, 3h, then daily. */
export const BACKOFF_MINUTES: readonly number[] = [15, 60, 180, 1440];

export function backoffMinutes(nudgesSent: number): number {
  const i = Math.min(Math.max(nudgesSent, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i];
}

/**
 * When to follow up after a nudge, or null if the cap is reached. The first
 * gap adapts to the user's learned response time (if known) so Nudge doesn't
 * re-ping someone who typically needs 40 minutes after 15. The result is
 * pushed out of quiet hours.
 */
export function planNextNudge(args: {
  nudgesSent: number;
  maxNudges: number;
  now: Date;
  prefs: Preferences;
  typicalResponseMinutes?: number | null;
}): Date | null {
  const { nudgesSent, maxNudges, now, prefs } = args;
  if (nudgesSent >= maxNudges) return null;
  let gap = backoffMinutes(nudgesSent);
  if (nudgesSent === 1 && args.typicalResponseMinutes) {
    gap = clamp(Math.round(args.typicalResponseMinutes * 1.5), 15, 180);
  }
  const at = new Date(now.getTime() + gap * 60_000);
  return deferOutOfQuietHours(
    at,
    prefs.timezone,
    prefs.quietHoursStart,
    prefs.quietHoursEnd
  );
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ── Recurrence ──────────────────────────────────────────────────────────

/**
 * The `step`-th repetition of `anchor`, computed in local wall-clock time so
 * "every day at 9am" stays at 9am across DST changes. Monthly repeats keep
 * the anchor's day-of-month, clamped to short months (Jan 31 → Feb 28 →
 * Mar 31), and never drift because each step is computed from the anchor.
 */
export function occurrenceAt(
  anchor: Date,
  repeat: Exclude<Repeat, "none">,
  timeZone: string,
  step: number
): Date {
  const p = getZonedParts(anchor, timeZone);
  if (repeat === "daily" || repeat === "weekly") {
    const days = (repeat === "daily" ? 1 : 7) * step;
    return zonedTimeToUtc({ ...p, day: p.day + days }, timeZone);
  }
  const total = p.month - 1 + step;
  const year = p.year + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(p.day, daysInMonth(year, month));
  return zonedTimeToUtc({ ...p, year, month, day }, timeZone);
}

/** First repetition of `anchor` strictly after `after`, or null for "none". */
export function nextOccurrence(
  anchor: Date,
  repeat: Repeat,
  timeZone: string,
  after: Date
): Date | null {
  if (repeat === "none") return null;
  for (let step = 1; step <= 5000; step++) {
    const candidate = occurrenceAt(anchor, repeat, timeZone, step);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

// ── Grouping for the side panel ─────────────────────────────────────────

export interface TaskGroups {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  snoozed: Task[];
  done: Task[];
}

export function groupTasks(
  tasks: readonly Task[],
  now: Date,
  timeZone: string
): TaskGroups {
  const groups: TaskGroups = {
    overdue: [],
    today: [],
    upcoming: [],
    snoozed: [],
    done: []
  };
  const todayKey = localDayKey(now, timeZone);
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    if (task.status === "done") {
      groups.done.push(task);
    } else if (task.status === "snoozed") {
      groups.snoozed.push(task);
    } else if (Date.parse(task.dueAt) <= now.getTime()) {
      groups.overdue.push(task);
    } else if (localDayKey(new Date(task.dueAt), timeZone) === todayKey) {
      groups.today.push(task);
    } else {
      groups.upcoming.push(task);
    }
  }
  const byDue = (a: Task, b: Task) => Date.parse(a.dueAt) - Date.parse(b.dueAt);
  groups.overdue.sort(byDue);
  groups.today.sort(byDue);
  groups.upcoming.sort(byDue);
  groups.snoozed.sort(
    (a, b) =>
      Date.parse(a.snoozedUntil ?? a.dueAt) -
      Date.parse(b.snoozedUntil ?? b.dueAt)
  );
  groups.done.sort(
    (a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? "")
  );
  return groups;
}

// ── Input coercion helpers (shared by tools and RPC) ────────────────────

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Short, unambiguous ids: LLMs copy 6 characters far more reliably than UUIDs. */
export function generateTaskId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

export function normalizeTaskId(id: unknown): string {
  return String(id ?? "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
}

export function resolveMaxNudges(
  persistence: Persistence,
  requested: number | null | undefined
): number {
  if (
    requested === null ||
    requested === undefined ||
    !Number.isFinite(requested)
  ) {
    return DEFAULT_MAX_NUDGES[persistence];
  }
  return clamp(Math.round(requested), 1, MAX_NUDGES_LIMIT);
}
