import { describe, expect, it } from "vitest";
import {
  backoffMinutes,
  escalationLevel,
  generateTaskId,
  groupTasks,
  hasNudgesLeft,
  isActive,
  nextOccurrence,
  occurrenceAt,
  planNextNudge,
  resolveMaxNudges,
  resolveSnoozeUntil,
  transition,
  TRANSITIONS,
  type TaskAction
} from "../src/lib/tasks";
import { DEFAULT_PREFS, type Task, type TaskStatus } from "../src/lib/types";

const ACTIONS: TaskAction[] = [
  "nudge",
  "snooze",
  "complete",
  "cancel",
  "reschedule"
];

describe("state machine", () => {
  it("follows the documented lifecycle", () => {
    expect(transition("pending", "nudge")).toEqual({
      ok: true,
      status: "nudged"
    });
    expect(transition("nudged", "snooze")).toEqual({
      ok: true,
      status: "snoozed"
    });
    expect(transition("snoozed", "nudge")).toEqual({
      ok: true,
      status: "nudged"
    });
    expect(transition("nudged", "complete")).toEqual({
      ok: true,
      status: "done"
    });
    expect(transition("snoozed", "cancel")).toEqual({
      ok: true,
      status: "cancelled"
    });
    expect(transition("nudged", "reschedule")).toEqual({
      ok: true,
      status: "pending"
    });
  });

  it("treats done and cancelled as terminal", () => {
    for (const status of ["done", "cancelled"] as TaskStatus[]) {
      for (const action of ACTIONS) {
        const r = transition(status, action);
        expect(r.ok).toBe(false);
      }
      expect(isActive(status)).toBe(false);
    }
  });

  it("never lets a finished task be nudged again", () => {
    const r = transition("done", "nudge");
    expect(r).toEqual({
      ok: false,
      error: "Cannot nudge a task that is already done."
    });
  });

  it("allows every action from every active state", () => {
    for (const status of ["pending", "nudged", "snoozed"] as TaskStatus[]) {
      expect(isActive(status)).toBe(true);
      expect(Object.keys(TRANSITIONS[status]).sort()).toEqual(
        [...ACTIONS].sort()
      );
    }
  });
});

describe("escalation", () => {
  it("starts at the task's persistence and climbs every two nudges", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => escalationLevel("gentle", n))).toEqual(
      ["gentle", "gentle", "firm", "firm", "urgent", "urgent"]
    );
    expect(escalationLevel("firm", 1)).toBe("firm");
    expect(escalationLevel("firm", 3)).toBe("urgent");
    expect(escalationLevel("urgent", 1)).toBe("urgent");
    expect(escalationLevel("gentle", 50)).toBe("urgent");
  });

  it("uses persistence-based default caps, clamped to 1..20", () => {
    expect(resolveMaxNudges("gentle", undefined)).toBe(3);
    expect(resolveMaxNudges("firm", null)).toBe(5);
    expect(resolveMaxNudges("urgent", undefined)).toBe(8);
    expect(resolveMaxNudges("gentle", 0)).toBe(1);
    expect(resolveMaxNudges("gentle", 99)).toBe(20);
  });
});

describe("backoff", () => {
  it("is 15m, 1h, 3h, then daily", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([
      15, 60, 180, 1440, 1440, 1440
    ]);
  });

  const now = new Date("2026-10-17T10:00:00Z");
  const prefs = { ...DEFAULT_PREFS, timezone: "UTC" };

  it("plans the next nudge from the backoff schedule", () => {
    const at = planNextNudge({ nudgesSent: 2, maxNudges: 5, now, prefs });
    expect(at?.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  it("stops at the cap", () => {
    expect(
      planNextNudge({ nudgesSent: 3, maxNudges: 3, now, prefs })
    ).toBeNull();
  });

  it("adapts the first gap to the learned response time", () => {
    const at = planNextNudge({
      nudgesSent: 1,
      maxNudges: 5,
      now,
      prefs,
      typicalResponseMinutes: 40
    });
    expect(at?.toISOString()).toBe("2026-10-17T11:00:00.000Z"); // 40 * 1.5 = 60
  });

  it("pushes follow-ups out of quiet hours", () => {
    const late = new Date("2026-10-17T21:00:00Z");
    const at = planNextNudge({ nudgesSent: 3, maxNudges: 5, now: late, prefs }); // +3h = 00:00
    expect(at?.toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });
});

describe("recurrence", () => {
  it("adds days and weeks in local time across DST", () => {
    const tz = "America/New_York";
    const anchor = new Date("2026-10-31T13:00:00Z"); // Sat 09:00 EDT
    expect(occurrenceAt(anchor, "daily", tz, 2).toISOString()).toBe(
      "2026-11-02T14:00:00.000Z"
    ); // 09:00 EST
    expect(occurrenceAt(anchor, "weekly", tz, 1).toISOString()).toBe(
      "2026-11-07T14:00:00.000Z"
    );
  });

  it("clamps monthly repeats to short months without drifting", () => {
    const anchor = new Date("2026-01-31T09:00:00Z");
    expect(occurrenceAt(anchor, "monthly", "UTC", 1).toISOString()).toBe(
      "2026-02-28T09:00:00.000Z"
    );
    expect(occurrenceAt(anchor, "monthly", "UTC", 2).toISOString()).toBe(
      "2026-03-31T09:00:00.000Z"
    );
    expect(occurrenceAt(anchor, "monthly", "UTC", 13).toISOString()).toBe(
      "2027-02-28T09:00:00.000Z"
    );
  });

  it("handles leap years and year rollover", () => {
    const anchor = new Date("2027-12-29T09:00:00Z");
    expect(occurrenceAt(anchor, "monthly", "UTC", 2).toISOString()).toBe(
      "2028-02-29T09:00:00.000Z"
    );
  });

  it("finds the first occurrence strictly after a moment", () => {
    const anchor = new Date("2026-10-01T09:00:00Z"); // rent on the 1st
    const after = new Date("2026-12-15T00:00:00Z"); // completed late
    expect(nextOccurrence(anchor, "monthly", "UTC", after)?.toISOString()).toBe(
      "2027-01-01T09:00:00.000Z"
    );
    expect(
      nextOccurrence(anchor, "monthly", "UTC", anchor)?.toISOString()
    ).toBe("2026-11-01T09:00:00.000Z");
    expect(nextOccurrence(anchor, "none", "UTC", after)).toBeNull();
  });
});

describe("groupTasks", () => {
  const base: Task = {
    id: "a",
    title: "t",
    notes: null,
    dueAt: "2026-10-17T12:00:00Z",
    repeat: "none",
    persistence: "gentle",
    status: "pending",
    nudgeCount: 0,
    maxNudges: 3,
    snoozedUntil: null,
    lastNudgedAt: null,
    nextNudgeAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    completedAt: null
  };
  const now = new Date("2026-10-17T10:00:00Z");

  it("buckets tasks into overdue / today / upcoming / snoozed / done", () => {
    const tasks: Task[] = [
      { ...base, id: "over", dueAt: "2026-10-17T09:00:00Z", status: "nudged" },
      { ...base, id: "today", dueAt: "2026-10-17T18:00:00Z" },
      { ...base, id: "later", dueAt: "2026-10-19T09:00:00Z" },
      {
        ...base,
        id: "snz",
        status: "snoozed",
        snoozedUntil: "2026-10-17T11:00:00Z"
      },
      {
        ...base,
        id: "done",
        status: "done",
        completedAt: "2026-10-17T08:00:00Z"
      },
      { ...base, id: "gone", status: "cancelled" }
    ];
    const g = groupTasks(tasks, now, "UTC");
    expect(g.overdue.map((t) => t.id)).toEqual(["over"]);
    expect(g.today.map((t) => t.id)).toEqual(["today"]);
    expect(g.upcoming.map((t) => t.id)).toEqual(["later"]);
    expect(g.snoozed.map((t) => t.id)).toEqual(["snz"]);
    expect(g.done.map((t) => t.id)).toEqual(["done"]);
  });

  it("uses the user's calendar day for 'today'", () => {
    // 20:00Z is already tomorrow in Kolkata.
    const t = { ...base, dueAt: "2026-10-17T20:00:00Z" };
    expect(groupTasks([t], now, "UTC").today).toHaveLength(1);
    expect(groupTasks([t], now, "Asia/Kolkata").upcoming).toHaveLength(1);
  });
});

describe("generateTaskId", () => {
  it("produces 6 unambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTaskId()).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
    }
  });
});

describe("nudge allowance", () => {
  it("stops at the cap but always honours a snooze", () => {
    expect(hasNudgesLeft("nudged", 2, 3)).toBe(true);
    expect(hasNudgesLeft("nudged", 3, 3)).toBe(false);
    expect(hasNudgesLeft("snoozed", 3, 3)).toBe(true);
  });
});

describe("resolveSnoozeUntil", () => {
  const now = new Date("2026-10-17T10:00:00Z");

  it("counts from now once the task is due", () => {
    const r = resolveSnoozeUntil({
      status: "nudged",
      dueAt: new Date("2026-10-17T09:00:00Z"),
      now,
      minutes: 60
    });
    expect(r.ok && r.until.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  it("never pulls a not-yet-due task earlier", () => {
    const dueAt = new Date("2026-10-24T09:00:00Z"); // next week
    const r = resolveSnoozeUntil({
      status: "pending",
      dueAt,
      now,
      minutes: 60
    });
    expect(r.ok && r.until.toISOString()).toBe("2026-10-24T10:00:00.000Z");
    const early = resolveSnoozeUntil({
      status: "pending",
      dueAt,
      now,
      until: new Date("2026-10-18T09:00:00Z")
    });
    expect(early.ok).toBe(false);
  });

  it("accepts an explicit time and rejects non-positive lengths", () => {
    const until = new Date("2026-10-18T09:00:00Z");
    const r = resolveSnoozeUntil({ status: "nudged", dueAt: now, now, until });
    expect(r.ok && r.until).toBe(until);
    expect(
      resolveSnoozeUntil({ status: "nudged", dueAt: now, now, minutes: 0 }).ok
    ).toBe(false);
  });
});
