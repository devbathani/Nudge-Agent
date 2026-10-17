// Shared domain types. Pure TypeScript: imported by the Worker, the React
// client and the unit tests, so nothing here may depend on Cloudflare APIs.

/** Task lifecycle states. `done` and `cancelled` are terminal. */
export type TaskStatus =
  | "pending"
  | "nudged"
  | "snoozed"
  | "done"
  | "cancelled";

/** How hard Nudge pushes. Also the starting escalation level. */
export type Persistence = "gentle" | "firm" | "urgent";

/** Tone of an individual nudge. Same scale as Persistence. */
export type EscalationLevel = Persistence;

export type Repeat = "none" | "daily" | "weekly" | "monthly";

export type TaskFilter = "pending" | "snoozed" | "done" | "all";

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  /** UTC ISO-8601 instant. */
  dueAt: string;
  repeat: Repeat;
  persistence: Persistence;
  status: TaskStatus;
  nudgeCount: number;
  maxNudges: number;
  snoozedUntil: string | null;
  lastNudgedAt: string | null;
  /** When the next scheduled nudge will fire, if any. */
  nextNudgeAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type EventType =
  | "created"
  | "updated"
  | "nudged"
  | "deferred"
  | "snoozed"
  | "completed"
  | "cancelled"
  | "exhausted"
  | "briefing";

export interface TaskEvent {
  id: number;
  taskId: string | null;
  type: EventType;
  /** UTC ISO-8601 instant. */
  at: string;
  meta: Record<string, unknown>;
}

/** Coarse local time-of-day buckets used for habit learning. */
export type TimeBucket = "morning" | "afternoon" | "evening" | "night";

export interface Preferences {
  /** IANA zone, e.g. "Asia/Kolkata". Defaults to UTC until the browser reports it. */
  timezone: string;
  /** "HH:MM" local. Equal start/end disables quiet hours. */
  quietHoursStart: string;
  quietHoursEnd: string;
  /** "HH:MM" local time for the daily briefing. */
  briefingTime: string;
}

export interface Learnings {
  /** Median snooze length once there is enough data, rounded to 5 minutes. */
  preferredSnoozeMinutes: number | null;
  /** Median minutes from a nudge to completion. */
  typicalResponseMinutes: number | null;
  /** Buckets where nudges usually get snoozed. */
  snoozyBuckets: TimeBucket[];
  /** Human-readable observations for the UI and the system prompt. */
  insights: string[];
  /** Number of events the learnings were derived from. */
  sampleSize: number;
}

/** State synced to every connected client via the Agents SDK. */
export interface NudgeState {
  tasks: Task[];
  prefs: Preferences;
  learned: Learnings;
  /** Server clock at the time of the last sync (ISO). */
  syncedAt: string;
}

/** Result type returned by tools and RPC methods: errors are values, not throws. */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Custom (non-chat) messages broadcast over the agent WebSocket. Namespaced
 * with "nudge/" so they can never collide with SDK protocol frames.
 */
export type NudgeBroadcast =
  | {
      type: "nudge/fired";
      taskId: string;
      title: string;
      text: string;
      level: EscalationLevel;
      nudgeNumber: number;
    }
  | { type: "nudge/briefing"; text: string };

/** Metadata attached to assistant messages Nudge posts on its own. */
export interface AutonomousMessageMeta {
  kind: "nudge" | "briefing";
  at: string;
  taskId?: string;
  level?: EscalationLevel;
  nudgeNumber?: number;
  maxNudges?: number;
}

export const DEFAULT_PREFS: Preferences = {
  timezone: "UTC",
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  briefingTime: "08:00"
};

export const EMPTY_LEARNINGS: Learnings = {
  preferredSnoozeMinutes: null,
  typicalResponseMinutes: null,
  snoozyBuckets: [],
  insights: [],
  sampleSize: 0
};
