// Persistence for tasks, events and preferences on the agent's embedded
// SQLite (this.sql). The SQL tag is injected so this module stays free of
// Cloudflare imports; NudgeAgent passes `this.sql.bind(this)`.

import { EMPTY_LEARNINGS, DEFAULT_PREFS } from "./lib/types";
import type {
  EventType,
  Learnings,
  Persistence,
  Preferences,
  Repeat,
  Task,
  TaskEvent,
  TaskFilter,
  TaskStatus
} from "./lib/types";

type SqlValue = string | number | boolean | null;
export type SqlTag = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
) => T[];

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  repeat: string;
  persistence: string;
  status: string;
  nudge_count: number;
  max_nudges: number;
  snoozed_until: string | null;
  last_nudged_at: string | null;
  created_at: string;
  completed_at: string | null;
  next_nudge_at: string | null;
  schedule_id: string | null;
  sched_seq: number;
  anchor_at: string | null;
}

/** Task plus the internal scheduling columns the agent needs. */
export interface TaskRecord extends Task {
  scheduleId: string | null;
  schedSeq: number;
  /** First due date of a recurring series; keeps monthly repeats from drifting. */
  anchorAt: string | null;
}

/**
 * Ordered, append-only migrations. Each runs once; the applied version is
 * kept in prefs so re-running on every wake is a cheap no-op.
 */
const MIGRATIONS: ReadonlyArray<(sql: SqlTag) => void> = [
  (sql) => {
    sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT,
      due_at TEXT NOT NULL,
      repeat TEXT NOT NULL DEFAULT 'none',
      persistence TEXT NOT NULL DEFAULT 'gentle',
      status TEXT NOT NULL DEFAULT 'pending',
      nudge_count INTEGER NOT NULL DEFAULT 0,
      max_nudges INTEGER NOT NULL DEFAULT 3,
      snoozed_until TEXT,
      last_nudged_at TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`;
    sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}'
    )`;
    sql`CREATE INDEX IF NOT EXISTS events_at ON events (at)`;
  },
  (sql) => {
    // Scheduling bookkeeping: which agent schedule currently owns the task,
    // plus a sequence number that makes stale callbacks harmless.
    sql`ALTER TABLE tasks ADD COLUMN next_nudge_at TEXT`;
    sql`ALTER TABLE tasks ADD COLUMN schedule_id TEXT`;
    sql`ALTER TABLE tasks ADD COLUMN sched_seq INTEGER NOT NULL DEFAULT 0`;
    sql`ALTER TABLE tasks ADD COLUMN anchor_at TEXT`;
    sql`CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status)`;
  }
];

export class NudgeStore {
  constructor(private readonly sql: SqlTag) {}

  migrate(): void {
    const sql = this.sql;
    sql`CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    const current = Number(this.getPref("schema_version") ?? "0");
    for (let v = current; v < MIGRATIONS.length; v++) {
      MIGRATIONS[v](sql);
      this.setPref("schema_version", String(v + 1));
    }
  }

  // ── prefs ──────────────────────────────────────────────────────────────

  getPref(key: string): string | null {
    const rows = this.sql<{
      value: string;
    }>`SELECT value FROM prefs WHERE key = ${key}`;
    return rows[0]?.value ?? null;
  }

  setPref(key: string, value: string): void {
    this.sql`INSERT INTO prefs (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  deletePref(key: string): void {
    this.sql`DELETE FROM prefs WHERE key = ${key}`;
  }

  getPreferences(): Preferences {
    return {
      timezone: this.getPref("timezone") ?? DEFAULT_PREFS.timezone,
      quietHoursStart:
        this.getPref("quietHoursStart") ?? DEFAULT_PREFS.quietHoursStart,
      quietHoursEnd:
        this.getPref("quietHoursEnd") ?? DEFAULT_PREFS.quietHoursEnd,
      briefingTime: this.getPref("briefingTime") ?? DEFAULT_PREFS.briefingTime
    };
  }

  getLearnings(): Learnings {
    const raw = this.getPref("learned");
    if (!raw) return EMPTY_LEARNINGS;
    try {
      return { ...EMPTY_LEARNINGS, ...(JSON.parse(raw) as Partial<Learnings>) };
    } catch {
      return EMPTY_LEARNINGS;
    }
  }

  setLearnings(learned: Learnings): void {
    this.setPref("learned", JSON.stringify(learned));
    // Also expose the headline value as its own preference row.
    if (learned.preferredSnoozeMinutes) {
      this.setPref(
        "preferredSnoozeMinutes",
        String(learned.preferredSnoozeMinutes)
      );
    } else {
      this.deletePref("preferredSnoozeMinutes");
    }
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  getTask(id: string): TaskRecord | null {
    const rows = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${id}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  taskExists(id: string): boolean {
    return this.sql`SELECT 1 FROM tasks WHERE id = ${id}`.length > 0;
  }

  listTasks(filter: TaskFilter = "all", limit = 200): TaskRecord[] {
    let rows: TaskRow[];
    switch (filter) {
      case "pending":
        rows = this.sql<TaskRow>`SELECT * FROM tasks
          WHERE status IN ('pending', 'nudged') ORDER BY due_at LIMIT ${limit}`;
        break;
      case "snoozed":
        rows = this.sql<TaskRow>`SELECT * FROM tasks
          WHERE status = 'snoozed' ORDER BY snoozed_until LIMIT ${limit}`;
        break;
      case "done":
        rows = this.sql<TaskRow>`SELECT * FROM tasks
          WHERE status = 'done' ORDER BY completed_at DESC LIMIT ${limit}`;
        break;
      default:
        rows = this.sql<TaskRow>`SELECT * FROM tasks
          WHERE status != 'cancelled' ORDER BY due_at LIMIT ${limit}`;
    }
    return rows.map(toRecord);
  }

  /** Active tasks plus the most recently finished ones, for the UI. */
  listForPanel(doneLimit = 20): TaskRecord[] {
    const active = this.sql<TaskRow>`SELECT * FROM tasks
      WHERE status IN ('pending', 'nudged', 'snoozed') ORDER BY due_at LIMIT 200`;
    const done = this.sql<TaskRow>`SELECT * FROM tasks
      WHERE status = 'done' ORDER BY completed_at DESC LIMIT ${doneLimit}`;
    return [...active, ...done].map(toRecord);
  }

  insertTask(task: {
    id: string;
    title: string;
    notes: string | null;
    dueAt: string;
    repeat: Repeat;
    persistence: Persistence;
    maxNudges: number;
    createdAt: string;
    anchorAt: string | null;
  }): void {
    this.sql`INSERT INTO tasks
      (id, title, notes, due_at, repeat, persistence, status, nudge_count,
       max_nudges, created_at, sched_seq, anchor_at)
      VALUES (${task.id}, ${task.title}, ${task.notes}, ${task.dueAt},
       ${task.repeat}, ${task.persistence}, 'pending', 0, ${task.maxNudges},
       ${task.createdAt}, 0, ${task.anchorAt})`;
  }

  /** Partial update; only keys present in `patch` are written. */
  updateTask(
    id: string,
    patch: Partial<{
      title: string;
      notes: string | null;
      dueAt: string;
      repeat: Repeat;
      persistence: Persistence;
      status: TaskStatus;
      nudgeCount: number;
      maxNudges: number;
      snoozedUntil: string | null;
      lastNudgedAt: string | null;
      completedAt: string | null;
      nextNudgeAt: string | null;
      scheduleId: string | null;
      schedSeq: number;
      anchorAt: string | null;
    }>
  ): void {
    const s = this.sql;
    const has = (k: keyof typeof patch) => Object.hasOwn(patch, k);
    if (has("title"))
      s`UPDATE tasks SET title = ${patch.title ?? ""} WHERE id = ${id}`;
    if (has("notes"))
      s`UPDATE tasks SET notes = ${patch.notes ?? null} WHERE id = ${id}`;
    if (has("dueAt"))
      s`UPDATE tasks SET due_at = ${patch.dueAt ?? ""} WHERE id = ${id}`;
    if (has("repeat"))
      s`UPDATE tasks SET repeat = ${patch.repeat ?? "none"} WHERE id = ${id}`;
    if (has("persistence"))
      s`UPDATE tasks SET persistence = ${patch.persistence ?? "gentle"} WHERE id = ${id}`;
    if (has("status"))
      s`UPDATE tasks SET status = ${patch.status ?? "pending"} WHERE id = ${id}`;
    if (has("nudgeCount"))
      s`UPDATE tasks SET nudge_count = ${patch.nudgeCount ?? 0} WHERE id = ${id}`;
    if (has("maxNudges"))
      s`UPDATE tasks SET max_nudges = ${patch.maxNudges ?? 3} WHERE id = ${id}`;
    if (has("snoozedUntil"))
      s`UPDATE tasks SET snoozed_until = ${patch.snoozedUntil ?? null} WHERE id = ${id}`;
    if (has("lastNudgedAt"))
      s`UPDATE tasks SET last_nudged_at = ${patch.lastNudgedAt ?? null} WHERE id = ${id}`;
    if (has("completedAt"))
      s`UPDATE tasks SET completed_at = ${patch.completedAt ?? null} WHERE id = ${id}`;
    if (has("nextNudgeAt"))
      s`UPDATE tasks SET next_nudge_at = ${patch.nextNudgeAt ?? null} WHERE id = ${id}`;
    if (has("scheduleId"))
      s`UPDATE tasks SET schedule_id = ${patch.scheduleId ?? null} WHERE id = ${id}`;
    if (has("schedSeq"))
      s`UPDATE tasks SET sched_seq = ${patch.schedSeq ?? 0} WHERE id = ${id}`;
    if (has("anchorAt"))
      s`UPDATE tasks SET anchor_at = ${patch.anchorAt ?? null} WHERE id = ${id}`;
  }

  // ── events ─────────────────────────────────────────────────────────────

  logEvent(
    type: EventType,
    taskId: string | null,
    at: Date,
    meta: Record<string, unknown> = {}
  ): void {
    this.sql`INSERT INTO events (task_id, type, at, meta)
      VALUES (${taskId}, ${type}, ${at.toISOString()}, ${JSON.stringify(meta)})`;
  }

  recentEvents(limit = 300): TaskEvent[] {
    const rows = this.sql<{
      id: number;
      task_id: string | null;
      type: string;
      at: string;
      meta: string;
    }>`SELECT * FROM events ORDER BY id DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      type: r.type as EventType,
      at: r.at,
      meta: safeJson(r.meta)
    }));
  }

  /** Wipe all user data. Keeps the prefs table itself and the schema version. */
  resetAll(): void {
    this.sql`DELETE FROM tasks`;
    this.sql`DELETE FROM events`;
    this.sql`DELETE FROM prefs WHERE key != 'schema_version'`;
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toRecord(r: TaskRow): TaskRecord {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueAt: r.due_at,
    repeat: r.repeat as Repeat,
    persistence: r.persistence as Persistence,
    status: r.status as TaskStatus,
    nudgeCount: Number(r.nudge_count),
    maxNudges: Number(r.max_nudges),
    snoozedUntil: r.snoozed_until,
    lastNudgedAt: r.last_nudged_at,
    nextNudgeAt: r.next_nudge_at,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    scheduleId: r.schedule_id,
    schedSeq: Number(r.sched_seq ?? 0),
    anchorAt: r.anchor_at
  };
}

/** Strip internal scheduling columns before sending a task to the client or model. */
export function toPublicTask(t: TaskRecord): Task {
  const { scheduleId: _s, schedSeq: _q, anchorAt: _a, ...task } = t;
  return task;
}
