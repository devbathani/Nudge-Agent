// Tools the LLM can call. Each one executes on the server against the agent
// (via the NudgeService interface, to avoid a circular import) and returns a
// result object: failures come back as { ok: false, error } so the model can
// read the problem and recover instead of the whole turn blowing up.
//
// Schemas are deliberately forgiving: Llama on Workers AI often sends null,
// "" or "15" for optional fields, so those are normalised before validation.

import { tool } from "ai";
import { z } from "zod";
import type { Persistence, Repeat, TaskFilter } from "./lib/types";

export interface AddTaskInput {
  title: string;
  notes?: string;
  dueAt: string;
  repeat?: Repeat;
  persistence?: Persistence;
  maxNudges?: number;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  dueAt?: string;
  repeat?: Repeat;
  persistence?: Persistence;
  maxNudges?: number;
}

export interface PreferencesInput {
  timezone?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  briefingTime?: string;
}

/** Everything the tools need from the agent. Implemented by NudgeAgent. */
export interface NudgeService {
  addTask(input: AddTaskInput): Promise<unknown>;
  listTasks(filter: TaskFilter): unknown;
  updateTask(id: string, fields: UpdateTaskInput): Promise<unknown>;
  snoozeTask(
    id: string,
    opts: { minutes?: number; until?: string }
  ): Promise<unknown>;
  completeTask(id: string): Promise<unknown>;
  cancelTask(id: string): Promise<unknown>;
  getBriefing(): unknown;
  setPreferences(prefs: PreferencesInput): Promise<unknown>;
}

// ── lenient field helpers ───────────────────────────────────────────────

function blank(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t === "null" || t === "undefined" || t === "none")
      return undefined;
  }
  return v;
}

const optString = (description: string) =>
  z
    .preprocess(blank, z.string().max(2000).optional())
    .optional()
    .describe(description);

const optInt = (min: number, max: number, description: string) =>
  z
    .preprocess((v) => {
      const b = blank(v);
      if (b === undefined) return undefined;
      const n =
        typeof b === "number" ? b : Number(String(b).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? Math.round(n) : b;
    }, z.number().int().min(min).max(max).optional())
    .optional()
    .describe(description);

const optEnum = <T extends readonly [string, ...string[]]>(
  values: T,
  description: string
) =>
  z
    .preprocess((v) => {
      const b = blank(v);
      return typeof b === "string" ? b.trim().toLowerCase() : b;
    }, z.enum(values).optional())
    .optional()
    .describe(description);

const taskId = z
  .preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().min(1))
  .describe(
    "The task id from listTasks or the open-tasks list, e.g. k3m9xq (without #)."
  );

const REPEAT = ["none", "daily", "weekly", "monthly"] as const;
const PERSISTENCE = ["gentle", "firm", "urgent"] as const;
const FILTER = ["pending", "snoozed", "done", "all"] as const;

const DUE_AT_HELP =
  "When it's due, as ISO-8601 in the user's timezone WITH offset, e.g. 2026-10-18T09:00:00+05:30.";

export function createTools(svc: NudgeService) {
  return {
    addTask: tool({
      description:
        "Create a task and schedule reminders. Nudge will remind the user at dueAt and keep following up (with growing urgency) until it is completed or cancelled.",
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(200)
          .describe("Short imperative title, e.g. 'Pay rent'."),
        notes: optString("Optional extra details."),
        dueAt: z.string().describe(DUE_AT_HELP),
        repeat: optEnum(REPEAT, "Repeat schedule. Default none."),
        persistence: optEnum(
          PERSISTENCE,
          "How hard to push: gentle (default), firm (has consequences), urgent (user said keep nudging / important)."
        ),
        maxNudges: optInt(
          1,
          20,
          "Optional cap on reminders. Defaults: gentle 3, firm 5, urgent 8."
        )
      }),
      execute: async (input) => svc.addTask(input)
    }),

    listTasks: tool({
      description: "List the user's tasks.",
      inputSchema: z.object({
        filter: optEnum(
          FILTER,
          "pending (includes already-nudged), snoozed, done, or all. Default all."
        )
      }),
      execute: async ({ filter }) => svc.listTasks(filter ?? "all")
    }),

    updateTask: tool({
      description:
        "Change a task. Pass only the fields to change. Changing dueAt resets its reminders.",
      inputSchema: z.object({
        id: taskId,
        title: optString("New title."),
        notes: optString("New notes."),
        dueAt: optString(DUE_AT_HELP),
        repeat: optEnum(REPEAT, "New repeat schedule."),
        persistence: optEnum(PERSISTENCE, "New persistence."),
        maxNudges: optInt(1, 20, "New reminder cap.")
      }),
      execute: async ({ id, ...fields }) => svc.updateTask(id, fields)
    }),

    snoozeTask: tool({
      description:
        "Snooze a task: pause reminders for some minutes or until a specific time. If the user gives no duration, omit both and the learned default is used.",
      inputSchema: z.object({
        id: taskId,
        minutes: optInt(1, 60 * 24 * 30, "Snooze for this many minutes."),
        until: optString(`Or snooze until this time. ${DUE_AT_HELP}`)
      }),
      execute: async ({ id, minutes, until }) =>
        svc.snoozeTask(id, { minutes, until })
    }),

    completeTask: tool({
      description:
        "Mark a task done. Stops all reminders. Recurring tasks automatically get their next occurrence.",
      inputSchema: z.object({ id: taskId }),
      execute: async ({ id }) => svc.completeTask(id)
    }),

    cancelTask: tool({
      description:
        "Cancel a task the user no longer needs. Stops all reminders.",
      inputSchema: z.object({ id: taskId }),
      execute: async ({ id }) => svc.cancelTask(id)
    }),

    getBriefing: tool({
      description: "Summarise what is overdue, due today, and snoozed.",
      inputSchema: z.object({}),
      execute: async () => svc.getBriefing()
    }),

    setPreferences: tool({
      description:
        "Update the user's settings: timezone (IANA, e.g. Europe/Berlin), quiet hours (HH:MM 24h, local) and daily briefing time (HH:MM).",
      inputSchema: z.object({
        timezone: optString("IANA timezone name."),
        quietHoursStart: optString("Start of quiet hours, HH:MM 24h."),
        quietHoursEnd: optString("End of quiet hours, HH:MM 24h."),
        briefingTime: optString("Daily briefing time, HH:MM 24h.")
      }),
      execute: async (prefs) => svc.setPreferences(prefs)
    })
  };
}
