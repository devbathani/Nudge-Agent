import { describe, expect, it } from "vitest";
import { deriveLearnings, median } from "../src/lib/habits";
import {
  buildBriefing,
  buildNudgePrompt,
  buildSystemPrompt,
  formatBriefingText,
  sanitizeNudgeText,
  templateNudge
} from "../src/lib/prompts";
import {
  DEFAULT_PREFS,
  EMPTY_LEARNINGS,
  type Task,
  type TaskEvent
} from "../src/lib/types";

let nextId = 1;
function ev(
  type: TaskEvent["type"],
  at: string,
  meta: Record<string, unknown> = {}
): TaskEvent {
  return { id: nextId++, taskId: "x", type, at, meta };
}

describe("deriveLearnings", () => {
  it("learns nothing from too little data", () => {
    const l = deriveLearnings(
      [ev("snoozed", "2026-10-17T09:00:00Z", { minutes: 60 })],
      "UTC"
    );
    expect(l.preferredSnoozeMinutes).toBeNull();
    expect(l.insights).toEqual([]);
  });

  it("derives a preferred snooze length from the median", () => {
    const events = [20, 30, 30, 120].map((m) =>
      ev("snoozed", "2026-10-17T15:00:00Z", { minutes: m })
    );
    expect(deriveLearnings(events, "UTC").preferredSnoozeMinutes).toBe(30);
  });

  it("flags time-of-day buckets that usually get snoozed", () => {
    const morning = "2026-10-17T08:00:00Z";
    const events = [
      ...Array.from({ length: 4 }, () =>
        ev("nudged", morning, { bucket: "morning" })
      ),
      ...Array.from({ length: 3 }, () =>
        ev("snoozed", morning, {
          minutes: 60,
          afterNudge: true,
          nudgeBucket: "morning"
        })
      ),
      ...Array.from({ length: 3 }, () =>
        ev("nudged", "2026-10-17T14:00:00Z", { bucket: "afternoon" })
      )
    ];
    const l = deriveLearnings(events, "UTC");
    expect(l.snoozyBuckets).toEqual(["morning"]);
    expect(
      l.insights.some((i) =>
        i.startsWith("Morning nudges usually get snoozed (3 of 4)")
      )
    ).toBe(true);
  });

  it("learns typical response time and 'one nudge is enough'", () => {
    const events = [10, 12, 20].map((m) =>
      ev("completed", "2026-10-17T12:00:00Z", {
        minutesSinceNudge: m,
        nudgeCount: 1
      })
    );
    const l = deriveLearnings(events, "UTC");
    expect(l.typicalResponseMinutes).toBe(12);
    expect(
      l.insights.some((i) => i.includes("One nudge is usually enough"))
    ).toBe(true);
  });

  it("computes medians", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

const task: Task = {
  id: "k3m9xq",
  title: "Pay rent",
  notes: null,
  dueAt: "2026-11-01T03:30:00Z",
  repeat: "monthly",
  persistence: "firm",
  status: "pending",
  nudgeCount: 0,
  maxNudges: 5,
  snoozedUntil: null,
  lastNudgedAt: null,
  nextNudgeAt: null,
  createdAt: "2026-10-17T06:00:00Z",
  completedAt: null
};

describe("system prompt", () => {
  const prompt = buildSystemPrompt({
    now: new Date("2026-10-17T06:00:00Z"),
    prefs: { ...DEFAULT_PREFS, timezone: "Asia/Kolkata" },
    learned: {
      ...EMPTY_LEARNINGS,
      preferredSnoozeMinutes: 45,
      snoozyBuckets: ["morning"]
    },
    tasks: [task, { ...task, id: "zzzzzz", status: "done" }]
  });

  it("injects the local date, time and zone", () => {
    expect(prompt).toContain("Saturday, October 17, 2026");
    expect(prompt).toContain("Asia/Kolkata, UTC+05:30");
    expect(prompt).toContain("2026-10-17T11:30:00+05:30");
    expect(prompt).toContain("Friday = 2026-10-23");
  });

  it("lists open tasks with ids and applies learnings", () => {
    expect(prompt).toContain('#k3m9xq, "Pay rent"');
    expect(prompt).not.toContain("zzzzzz");
    expect(prompt).toContain("snooze for 45 minutes");
    expect(prompt).toContain("morning nudges");
  });
});

describe("nudge text", () => {
  it("builds a prompt with tone and count", () => {
    const { prompt } = buildNudgePrompt({
      task,
      level: "urgent",
      nudgeNumber: 5,
      isLast: true,
      now: new Date("2026-11-01T06:00:00Z"),
      timeZone: "Asia/Kolkata"
    });
    expect(prompt).toContain("reminder 5 of 5");
    expect(prompt).toContain("Tone: urgent");
    expect(prompt).toContain("the last one");
  });

  it("has a template for every tone", () => {
    for (const level of ["gentle", "firm", "urgent"] as const) {
      const text = templateNudge({
        task,
        level,
        nudgeNumber: 2,
        isLast: false
      });
      expect(text).toContain("Pay rent");
    }
    expect(
      templateNudge({ task, level: "firm", nudgeNumber: 5, isLast: true })
    ).toContain("last reminder");
  });

  it("sanitises model output and rejects empties", () => {
    expect(sanitizeNudgeText('"Hey, rent is due!"')).toBe("Hey, rent is due!");
    expect(sanitizeNudgeText("Message: Pay it now.")).toBe("Pay it now.");
    expect(sanitizeNudgeText("  ")).toBeNull();
    expect(sanitizeNudgeText(null)).toBeNull();
    expect(sanitizeNudgeText("x".repeat(400))?.length).toBe(318);
  });
});

describe("briefing", () => {
  it("summarises overdue, today and snoozed tasks", () => {
    const now = new Date("2026-11-01T06:00:00Z");
    const b = buildBriefing(
      [
        { ...task, status: "nudged" },
        { ...task, id: "b", title: "Call mom", dueAt: "2026-11-01T12:00:00Z" },
        {
          ...task,
          id: "c",
          title: "Gym",
          status: "snoozed",
          snoozedUntil: "2026-11-01T08:00:00Z"
        }
      ],
      now,
      "UTC"
    );
    expect(b.overdue).toHaveLength(1);
    expect(b.dueToday).toHaveLength(1);
    expect(b.snoozed).toHaveLength(1);
    const text = formatBriefingText(b);
    expect(text).toContain("Overdue (1)");
    expect(text).toContain("Call mom");
    expect(text).toContain("Snoozed (1)");
  });
});
