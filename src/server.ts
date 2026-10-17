// NudgeAgent: one Durable Object per user (see README "Identity").
//
//   chat turn ──▶ Llama 3.3 (Workers AI) ──tools──▶ tasks/events/prefs (this.sql)
//                                                       │
//   this.schedule(Date) ──▶ onTaskDue ──▶ nudge message + next backoff
//   this.schedule(cron) ──▶ onBriefing ──▶ daily summary message
//
// Every state change is pushed to connected browsers with setState().

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { NudgeStore, toPublicTask, type SqlTag, type TaskRecord } from "./db";
import { deriveLearnings } from "./lib/habits";
import {
  buildBriefing,
  buildNudgePrompt,
  buildSystemPrompt,
  briefingHasContent,
  formatBriefingText,
  sanitizeNudgeText,
  templateNudge
} from "./lib/prompts";
import {
  backoffMinutes,
  DEFAULT_MAX_NUDGES,
  escalationLevel,
  generateTaskId,
  hasNudgesLeft,
  isActive,
  nextOccurrence,
  normalizeTaskId,
  planNextNudge,
  resolveMaxNudges,
  resolveSnoozeUntil,
  transition
} from "./lib/tasks";
import {
  addLocalDays,
  deferOutOfQuietHours,
  formatLocal,
  getZonedParts,
  isValidTimeZone,
  localDayKey,
  minutesFromLocalTime,
  normalizeHHMM,
  timeBucket,
  toLocalIso,
  utcCronForLocalTime,
  validateDueAt,
  zonedTimeToUtc
} from "./lib/time";
import {
  DEFAULT_PREFS,
  EMPTY_LEARNINGS,
  type AutonomousMessageMeta,
  type EscalationLevel,
  type NudgeBroadcast,
  type NudgeState,
  type Preferences,
  type TaskFilter
} from "./lib/types";
import {
  createTools,
  type AddTaskInput,
  type NudgeService,
  type PreferencesInput,
  type UpdateTaskInput
} from "./tools";

export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Messages sent to the model per turn; keeps us well inside the context window. */
const HISTORY_LIMIT = 24;
/** Fallback snooze length before Nudge has learned the user's preference. */
const DEFAULT_SNOOZE_MINUTES = 30;
const NUDGE_TEXT_TIMEOUT_MS = 10_000;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

interface TaskDuePayload {
  taskId: string;
  /** Must match tasks.sched_seq, otherwise the callback is stale and ignored. */
  seq: number;
}

export class NudgeAgent
  extends AIChatAgent<Env, NudgeState>
  implements NudgeService
{
  maxPersistedMessages = 200;

  initialState: NudgeState = {
    tasks: [],
    prefs: DEFAULT_PREFS,
    learned: EMPTY_LEARNINGS,
    syncedAt: new Date(0).toISOString()
  };

  private _store: NudgeStore | null = null;

  /** Lazily opens the store and runs idempotent migrations in one transaction. */
  private get store(): NudgeStore {
    if (!this._store) {
      const store = new NudgeStore(this.sql.bind(this) as SqlTag);
      this.ctx.storage.transactionSync(() => store.migrate());
      this._store = store;
    }
    return this._store;
  }

  private get prefs(): Preferences {
    return this.store.getPreferences();
  }

  async onStart() {
    await this.repairSchedules();
    await this.ensureBriefingSchedule();
    this.syncState();
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // The client sends its zone with every message, so even the very first
    // turn resolves "tomorrow 9am" correctly.
    const tz = options?.body?.timezone;
    if (isValidTimeZone(tz)) await this.applyTimezone(tz);

    const now = new Date();
    const system = buildSystemPrompt({
      now,
      prefs: this.prefs,
      learned: this.store.getLearnings(),
      tasks: this.store.listForPanel().map(toPublicTask)
    });

    let model;
    try {
      if (!this.env.AI) throw new Error("AI binding is not configured");
      model = createWorkersAI({ binding: this.env.AI })(MODEL_ID, {
        sessionAffinity: this.sessionAffinity
      });
    } catch (error) {
      console.error("Workers AI unavailable", error);
      return textResponse(friendlyModelError(error));
    }

    const result = streamText({
      model,
      system,
      messages: pruneMessages({
        messages: await convertToModelMessages(
          this.messages.slice(-HISTORY_LIMIT)
        ),
        toolCalls: "before-last-2-messages"
      }),
      tools: createTools(this),
      temperature: 0.2,
      stopWhen: stepCountIs(6),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("Chat turn failed", error);
        return friendlyModelError(error);
      }
    });
  }

  // ── Callable RPC (used by the side panel and on connect) ───────────────

  /** Called by the client on every (re)connect with its IANA timezone. */
  @callable()
  async hello(timezone: string) {
    if (isValidTimeZone(timezone)) await this.applyTimezone(timezone);
    await this.ensureBriefingSchedule();
    this.syncState();
    return { ok: true as const, prefs: this.prefs };
  }

  /**
   * Create a task without going through the model. Same validation as the
   * addTask tool; used by scripts/smoke.mjs and available to other clients.
   */
  @callable()
  async rpcAddTask(input: AddTaskInput) {
    if (!input || typeof input !== "object")
      return fail("Expected a task object.");
    return this.addTask({
      title: String(input.title ?? ""),
      dueAt: String(input.dueAt ?? ""),
      notes: typeof input.notes === "string" ? input.notes : undefined,
      repeat: ["none", "daily", "weekly", "monthly"].includes(
        String(input.repeat)
      )
        ? input.repeat
        : undefined,
      persistence: ["gentle", "firm", "urgent"].includes(
        String(input.persistence)
      )
        ? input.persistence
        : undefined,
      maxNudges:
        typeof input.maxNudges === "number" ? input.maxNudges : undefined
    });
  }

  @callable()
  async rpcComplete(id: string) {
    return this.completeTask(String(id));
  }

  @callable()
  async rpcCancel(id: string) {
    return this.cancelTask(String(id));
  }

  @callable()
  async rpcSnooze(id: string, preset: "15m" | "1h" | "tomorrow") {
    if (preset === "15m") return this.snoozeTask(String(id), { minutes: 15 });
    if (preset === "1h") return this.snoozeTask(String(id), { minutes: 60 });
    if (preset === "tomorrow") {
      const tz = this.prefs.timezone;
      const p = getZonedParts(addLocalDays(new Date(), tz, 1), tz);
      const at = zonedTimeToUtc({ ...p, hour: 9, minute: 0, second: 0 }, tz);
      return this.snoozeTask(String(id), { until: toLocalIso(at, tz) });
    }
    return fail(`Unknown snooze preset "${String(preset)}".`);
  }

  @callable()
  async rpcSetPreferences(prefs: PreferencesInput) {
    return this.setPreferences(prefs ?? {});
  }

  /** Delete every task, event, preference and pending schedule for this user. */
  @callable()
  async resetMyData(timezone?: string) {
    try {
      for (const s of await this.listSchedules()) {
        if (s.callback === "onTaskDue" || s.callback === "onBriefing") {
          await this.safeCancel(s.id);
        }
      }
      this.store.resetAll();
      if (isValidTimeZone(timezone)) this.store.setPref("timezone", timezone);
      await this.ensureBriefingSchedule();
      this.syncState();
      return { ok: true as const };
    } catch (error) {
      console.error("Reset failed", error);
      return fail("Couldn't reset your data. Please try again.");
    }
  }

  // ── Service methods (shared by LLM tools and RPC) ──────────────────────

  async addTask(input: AddTaskInput) {
    const now = new Date();
    const prefs = this.prefs;
    const title = input.title?.trim();
    if (!title) return fail("title is required.");
    const due = validateDueAt(input.dueAt, now, prefs.timezone);
    if (!due.ok) return fail(due.error);

    const persistence = input.persistence ?? "gentle";
    const repeat = input.repeat ?? "none";
    const id = this.newTaskId();
    const dueAt = due.date.toISOString();
    this.store.insertTask({
      id,
      title: title.slice(0, 200),
      notes: input.notes?.trim() || null,
      dueAt,
      repeat,
      persistence,
      maxNudges: resolveMaxNudges(persistence, input.maxNudges),
      createdAt: now.toISOString(),
      anchorAt: repeat === "none" ? null : dueAt
    });
    this.store.logEvent("created", id, now, { dueAt, persistence, repeat });

    const fireAt = this.deferForQuiet(due.date, prefs);
    const scheduled = await this.scheduleTaskAt(id, fireAt);
    this.syncState();
    return {
      ok: true as const,
      task: this.present(this.mustGet(id)),
      firstReminder: formatLocal(fireAt, prefs.timezone),
      deferredForQuietHours: fireAt.getTime() > due.date.getTime(),
      ...(due.interpretedAsLocal
        ? {
            note: `dueAt had no offset; interpreted as ${prefs.timezone} local time.`
          }
        : {}),
      ...(scheduled.ok ? {} : { warning: scheduled.error })
    };
  }

  listTasks(filter: TaskFilter) {
    const tasks = this.store.listTasks(filter, 50);
    return {
      ok: true as const,
      count: tasks.length,
      tasks: tasks.map((t) => this.present(t))
    };
  }

  async updateTask(id: string, fields: UpdateTaskInput) {
    const task = this.findTask(id);
    if (!task) return this.notFound(id);
    const now = new Date();
    const prefs = this.prefs;
    const patch: Parameters<NudgeStore["updateTask"]>[1] = {};

    if (fields.title !== undefined) {
      const title = fields.title.trim();
      if (!title) return fail("title cannot be empty.");
      patch.title = title.slice(0, 200);
    }
    if (fields.notes !== undefined) patch.notes = fields.notes.trim() || null;

    const schedulingChange =
      fields.dueAt !== undefined ||
      fields.repeat !== undefined ||
      fields.persistence !== undefined ||
      fields.maxNudges !== undefined;
    if (schedulingChange && !isActive(task.status)) {
      return fail(
        `Task "${task.title}" is ${task.status}; only its title and notes can change. Create a new task instead.`
      );
    }

    const persistence = fields.persistence ?? task.persistence;
    if (fields.persistence) patch.persistence = fields.persistence;
    if (fields.maxNudges !== undefined) {
      patch.maxNudges = resolveMaxNudges(persistence, fields.maxNudges);
    } else if (
      fields.persistence &&
      task.maxNudges === DEFAULT_MAX_NUDGES[task.persistence]
    ) {
      // Still on the old persistence's default cap: follow the new default.
      patch.maxNudges = DEFAULT_MAX_NUDGES[fields.persistence];
    }

    let rescheduleAt: Date | null = null;
    let dueAt = task.dueAt;
    if (fields.dueAt !== undefined) {
      const due = validateDueAt(fields.dueAt, now, prefs.timezone);
      if (!due.ok) return fail(due.error);
      const next = transition(task.status, "reschedule");
      if (!next.ok) return fail(next.error);
      dueAt = due.date.toISOString();
      Object.assign(patch, {
        dueAt,
        status: next.status,
        nudgeCount: 0,
        snoozedUntil: null
      });
      rescheduleAt = this.deferForQuiet(due.date, prefs);
    }

    const repeat = fields.repeat ?? task.repeat;
    if (fields.repeat !== undefined) patch.repeat = fields.repeat;
    if (fields.repeat !== undefined || fields.dueAt !== undefined) {
      patch.anchorAt = repeat === "none" ? null : dueAt;
    }

    this.store.updateTask(task.id, patch);
    if (rescheduleAt) await this.scheduleTaskAt(task.id, rescheduleAt);
    // e.g. a raised maxNudges on a task whose reminders had already stopped.
    else await this.resumeIfStalled(task.id);
    this.store.logEvent("updated", task.id, now, {
      fields: Object.keys(fields)
    });
    this.syncState();
    return { ok: true as const, task: this.present(this.mustGet(task.id)) };
  }

  async snoozeTask(id: string, opts: { minutes?: number; until?: string }) {
    const task = this.findTask(id);
    if (!task) return this.notFound(id);
    const next = transition(task.status, "snooze");
    if (!next.ok) return fail(next.error);

    const now = new Date();
    const prefs = this.prefs;
    let untilInput: Date | undefined;
    if (opts.until) {
      const v = validateDueAt(opts.until, now, prefs.timezone);
      if (!v.ok) return fail(v.error);
      untilInput = v.date;
    }
    const snooze = resolveSnoozeUntil({
      status: task.status,
      dueAt: new Date(task.dueAt),
      now,
      until: untilInput,
      minutes:
        opts.minutes ??
        this.store.getLearnings().preferredSnoozeMinutes ??
        DEFAULT_SNOOZE_MINUTES
    });
    if (!snooze.ok) return fail(snooze.error);
    const until = snooze.until;
    const fireAt = this.deferForQuiet(until, prefs);

    // A snoozed task always gets its reminder, even at the cap (hasNudgesLeft).
    this.store.updateTask(task.id, {
      status: next.status,
      snoozedUntil: until.toISOString()
    });
    this.store.logEvent("snoozed", task.id, now, {
      minutes: Math.round((until.getTime() - now.getTime()) / 60_000),
      afterNudge: task.status === "nudged",
      nudgeBucket: task.lastNudgedAt
        ? timeBucket(new Date(task.lastNudgedAt), prefs.timezone)
        : null,
      bucket: timeBucket(now, prefs.timezone)
    });
    const scheduled = await this.scheduleTaskAt(task.id, fireAt);
    this.refreshLearnings();
    this.syncState();
    return {
      ok: true as const,
      task: this.present(this.mustGet(task.id)),
      remindAgainAt: formatLocal(fireAt, prefs.timezone),
      deferredForQuietHours: fireAt.getTime() > until.getTime(),
      ...(scheduled.ok ? {} : { warning: scheduled.error })
    };
  }

  async completeTask(id: string) {
    const task = this.findTask(id);
    if (!task) return this.notFound(id);
    const next = transition(task.status, "complete");
    if (!next.ok) return fail(next.error);

    const now = new Date();
    const prefs = this.prefs;
    // Write the new status before the first await: a concurrent second
    // completion (chat + panel) then fails the transition check instead of
    // creating a duplicate next occurrence.
    this.store.updateTask(task.id, {
      status: next.status,
      completedAt: now.toISOString(),
      snoozedUntil: null
    });
    await this.clearSchedule(task.id);
    this.store.logEvent("completed", task.id, now, {
      nudgeCount: task.nudgeCount,
      minutesSinceNudge: task.lastNudgedAt
        ? Math.round((now.getTime() - Date.parse(task.lastNudgedAt)) / 60_000)
        : null,
      bucket: timeBucket(now, prefs.timezone)
    });

    let nextTask: ReturnType<NudgeAgent["present"]> | undefined;
    if (task.repeat !== "none") {
      const anchor = new Date(task.anchorAt ?? task.dueAt);
      const after = new Date(Math.max(now.getTime(), Date.parse(task.dueAt)));
      const nextDue = nextOccurrence(
        anchor,
        task.repeat,
        prefs.timezone,
        after
      );
      if (nextDue) {
        const nextId = this.newTaskId();
        this.store.insertTask({
          id: nextId,
          title: task.title,
          notes: task.notes,
          dueAt: nextDue.toISOString(),
          repeat: task.repeat,
          persistence: task.persistence,
          maxNudges: task.maxNudges,
          createdAt: now.toISOString(),
          anchorAt: anchor.toISOString()
        });
        this.store.logEvent("created", nextId, now, { recurrenceOf: task.id });
        await this.scheduleTaskAt(nextId, this.deferForQuiet(nextDue, prefs));
        nextTask = this.present(this.mustGet(nextId));
      }
    }

    this.refreshLearnings();
    this.syncState();
    return {
      ok: true as const,
      task: this.present(this.mustGet(task.id)),
      ...(nextTask ? { nextOccurrence: nextTask } : {})
    };
  }

  async cancelTask(id: string) {
    const task = this.findTask(id);
    if (!task) return this.notFound(id);
    const next = transition(task.status, "cancel");
    if (!next.ok) return fail(next.error);
    this.store.updateTask(task.id, { status: next.status, snoozedUntil: null });
    await this.clearSchedule(task.id);
    this.store.logEvent("cancelled", task.id, new Date());
    this.syncState();
    return { ok: true as const, task: this.present(this.mustGet(task.id)) };
  }

  getBriefing() {
    const tz = this.prefs.timezone;
    const b = buildBriefing(
      this.store.listForPanel().map(toPublicTask),
      new Date(),
      tz
    );
    const brief = (t: (typeof b.overdue)[number]) => ({
      id: t.id,
      title: t.title,
      due: formatLocal(new Date(t.dueAt), tz),
      status: t.status,
      ...(t.snoozedUntil
        ? { snoozedUntil: formatLocal(new Date(t.snoozedUntil), tz) }
        : {})
    });
    return {
      ok: true as const,
      date: b.date,
      overdue: b.overdue.map(brief),
      dueToday: b.dueToday.map(brief),
      snoozed: b.snoozed.map(brief),
      upcomingCount: b.upcomingCount
    };
  }

  async setPreferences(input: PreferencesInput) {
    const errors: string[] = [];
    const changes: Partial<Preferences> = {};
    if (input.timezone !== undefined) {
      if (isValidTimeZone(input.timezone)) changes.timezone = input.timezone;
      else
        errors.push(
          `"${input.timezone}" is not a valid IANA timezone (e.g. America/New_York).`
        );
    }
    for (const key of [
      "quietHoursStart",
      "quietHoursEnd",
      "briefingTime"
    ] as const) {
      if (input[key] === undefined) continue;
      const value = normalizeHHMM(input[key]);
      if (value) changes[key] = value;
      else
        errors.push(`${key} must be HH:MM in 24h time, got "${input[key]}".`);
    }
    if (Object.keys(changes).length === 0) {
      return fail(errors.join(" ") || "No preferences were provided.");
    }
    for (const [key, value] of Object.entries(changes)) {
      this.store.setPref(key, value);
    }
    if (changes.timezone) this.refreshLearnings();
    if (changes.timezone || changes.briefingTime)
      await this.ensureBriefingSchedule();
    this.syncState();
    return {
      ok: true as const,
      prefs: this.prefs,
      ...(errors.length ? { warnings: errors } : {})
    };
  }

  // ── Scheduled callbacks ────────────────────────────────────────────────

  /**
   * Fires when a task is due, a snooze ends, or a follow-up is due. Fully
   * idempotent: it re-reads the task and bails out unless the payload's seq
   * still matches and the task is still active, so a late, duplicated or
   * superseded alarm can never nudge a finished task.
   */
  async onTaskDue(payload: TaskDuePayload) {
    const task = this.store.getTask(payload?.taskId ?? "");
    if (!task || task.schedSeq !== payload.seq || !isActive(task.status))
      return;

    // This schedule row is the one executing; forget it rather than cancel it.
    this.store.updateTask(task.id, { scheduleId: null, nextNudgeAt: null });
    const now = new Date();
    const prefs = this.prefs;

    if (task.status === "snoozed" && task.snoozedUntil) {
      const until = Date.parse(task.snoozedUntil);
      if (until > now.getTime() + 30_000) {
        await this.scheduleTaskAt(
          task.id,
          this.deferForQuiet(new Date(until), prefs)
        );
        this.syncState();
        return;
      }
    }

    const quietEnd = this.deferForQuiet(now, prefs);
    if (quietEnd.getTime() > now.getTime()) {
      this.store.logEvent("deferred", task.id, now, {
        until: quietEnd.toISOString()
      });
      await this.scheduleTaskAt(task.id, quietEnd);
      this.syncState();
      return;
    }

    if (!hasNudgesLeft(task.status, task.nudgeCount, task.maxNudges)) {
      this.store.logEvent("exhausted", task.id, now, {
        nudgeCount: task.nudgeCount
      });
      this.syncState();
      return;
    }

    const nudgeNumber = task.nudgeCount + 1;
    const level = escalationLevel(task.persistence, nudgeNumber);
    const isLast = nudgeNumber >= task.maxNudges;
    const text = await this.composeNudge(task, level, nudgeNumber, isLast);

    // The model call took a while: re-check that nothing changed meanwhile.
    const fresh = this.store.getTask(task.id);
    if (!fresh || fresh.schedSeq !== payload.seq || !isActive(fresh.status))
      return;
    const next = transition(fresh.status, "nudge");
    if (!next.ok) return;

    const at = new Date();
    this.store.updateTask(fresh.id, {
      status: next.status,
      nudgeCount: nudgeNumber,
      lastNudgedAt: at.toISOString(),
      snoozedUntil: null
    });
    this.store.logEvent("nudged", fresh.id, at, {
      level,
      nudgeNumber,
      bucket: timeBucket(at, prefs.timezone)
    });

    const followUp = isLast
      ? null
      : planNextNudge({
          nudgesSent: nudgeNumber,
          maxNudges: fresh.maxNudges,
          now: at,
          prefs,
          typicalResponseMinutes:
            this.store.getLearnings().typicalResponseMinutes
        });
    if (followUp) await this.scheduleTaskAt(fresh.id, followUp);

    this.refreshLearnings();
    this.syncState();
    // The scheduler swallows callback errors, so never let a failed chat write
    // also suppress the toast / system notification below.
    try {
      await this.postAutonomousMessage(`🔔 ${text}`, {
        kind: "nudge",
        at: at.toISOString(),
        taskId: fresh.id,
        level,
        nudgeNumber,
        // A snoozed task may get one reminder past its cap.
        maxNudges: Math.max(fresh.maxNudges, nudgeNumber)
      });
    } catch (error) {
      console.error("Couldn't add the nudge to the chat", error);
    }
    this.broadcastEvent({
      type: "nudge/fired",
      taskId: fresh.id,
      title: fresh.title,
      text,
      level,
      nudgeNumber
    });
  }

  /** Daily briefing, driven by a cron schedule derived from local briefingTime. */
  async onBriefing() {
    const now = new Date();
    const prefs = this.prefs;
    // Re-derive the UTC cron in case the zone's offset changed (DST).
    await this.ensureBriefingSchedule();

    // Fired well before the local briefing time (the UTC offset changed): the
    // re-derived cron runs later today. Late firings still post.
    if (minutesFromLocalTime(now, prefs.timezone, prefs.briefingTime) < -10) {
      return;
    }

    const today = localDayKey(now, prefs.timezone);
    if (this.store.getPref("lastBriefingDay") === today) return;
    this.store.setPref("lastBriefingDay", today);

    const b = buildBriefing(
      this.store.listForPanel().map(toPublicTask),
      now,
      prefs.timezone
    );
    if (!briefingHasContent(b)) return;
    const text = formatBriefingText(b);
    this.store.logEvent("briefing", null, now, {
      overdue: b.overdue.length,
      today: b.dueToday.length,
      snoozed: b.snoozed.length
    });
    try {
      await this.postAutonomousMessage(text, {
        kind: "briefing",
        at: now.toISOString()
      });
    } catch (error) {
      console.error("Couldn't add the briefing to the chat", error);
    }
    this.broadcastEvent({ type: "nudge/briefing", text });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async composeNudge(
    task: TaskRecord,
    level: EscalationLevel,
    nudgeNumber: number,
    isLast: boolean
  ): Promise<string> {
    const ctx = { task, level, nudgeNumber, isLast };
    try {
      if (!this.env.AI) throw new Error("AI binding is not configured");
      const { system, prompt } = buildNudgePrompt({
        ...ctx,
        now: new Date(),
        timeZone: this.prefs.timezone
      });
      const { text } = await generateText({
        model: createWorkersAI({ binding: this.env.AI })(MODEL_ID),
        system,
        prompt,
        temperature: 0.7,
        maxOutputTokens: 120,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(NUDGE_TEXT_TIMEOUT_MS)
      });
      const clean = sanitizeNudgeText(text);
      if (clean) return clean;
    } catch (error) {
      console.warn("Nudge text generation failed; using template", error);
    }
    return templateNudge(ctx);
  }

  /** Append an assistant message to the persisted chat without triggering a model turn. */
  private async postAutonomousMessage(
    text: string,
    metadata: AutonomousMessageMeta
  ) {
    // Don't splice a message into the middle of a reply that is streaming.
    await this.waitUntilStable({ timeout: 20_000 }).catch(() => false);
    const message: UIMessage = {
      id: `${metadata.kind}-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text }],
      metadata
    };
    await this.persistMessages([...this.messages, message]);
  }

  private broadcastEvent(event: NudgeBroadcast) {
    this.broadcast(JSON.stringify(event));
  }

  /**
   * Point a task's single reminder at `at`.
   *
   * The seq bump happens synchronously, before any await, so concurrent calls
   * (a chat tool and a panel click) always get distinct seqs and only the
   * newest alarm can ever fire. Older alarms become no-ops even if
   * cancelling them fails; a schedule created by a superseded call is
   * cancelled as soon as we notice.
   */
  private async scheduleTaskAt(
    id: string,
    at: Date
  ): Promise<{ ok: true } | Fail> {
    const task = this.store.getTask(id);
    if (!task) return fail(`Task ${id} not found.`);
    const previous = task.scheduleId;
    const seq = task.schedSeq + 1;
    this.store.updateTask(id, {
      schedSeq: seq,
      scheduleId: null,
      nextNudgeAt: at.toISOString()
    });
    if (previous) await this.safeCancel(previous);
    try {
      const schedule = await this.schedule<TaskDuePayload>(at, "onTaskDue", {
        taskId: id,
        seq
      });
      if (this.store.getTask(id)?.schedSeq === seq) {
        this.store.updateTask(id, { scheduleId: schedule.id });
      } else {
        await this.safeCancel(schedule.id);
      }
      return { ok: true };
    } catch (error) {
      console.error("Scheduling failed", error);
      return fail(
        "The task is saved, but the reminder couldn't be scheduled just now. Nudge will retry automatically."
      );
    }
  }

  /** Stop a task's reminders. Invalidates synchronously, then cancels. */
  private async clearSchedule(id: string) {
    const task = this.store.getTask(id);
    if (!task) return;
    this.store.updateTask(id, {
      schedSeq: task.schedSeq + 1,
      scheduleId: null,
      nextNudgeAt: null
    });
    if (task.scheduleId) await this.safeCancel(task.scheduleId);
  }

  private async safeCancel(scheduleId: string) {
    try {
      await this.cancelSchedule(scheduleId);
    } catch (error) {
      console.warn("cancelSchedule failed", scheduleId, error);
    }
  }

  /**
   * Self-healing: any active task whose reminder schedule is missing (e.g. a
   * scheduling call failed) gets one again. Runs whenever the agent wakes.
   */
  private async repairSchedules() {
    const live = new Set((await this.listSchedules()).map((s) => s.id));
    for (const task of this.store.listActive()) {
      if (!hasNudgesLeft(task.status, task.nudgeCount, task.maxNudges)) continue;
      if (task.scheduleId && live.has(task.scheduleId)) continue;
      await this.scheduleTaskAt(task.id, this.nextReminderFor(task));
    }
  }

  /** Re-arm an active task that has nudges left but no pending reminder. */
  private async resumeIfStalled(id: string) {
    const task = this.store.getTask(id);
    if (!task || !isActive(task.status) || task.scheduleId) return;
    if (!hasNudgesLeft(task.status, task.nudgeCount, task.maxNudges)) return;
    await this.scheduleTaskAt(task.id, this.nextReminderFor(task));
  }

  /** When a task's next reminder should fire, never in the past or in quiet hours. */
  private nextReminderFor(task: TaskRecord): Date {
    const now = Date.now();
    const explicit = task.nextNudgeAt ?? task.snoozedUntil;
    const wanted = explicit
      ? Date.parse(explicit)
      : task.nudgeCount === 0
        ? Date.parse(task.dueAt)
        : now + backoffMinutes(task.nudgeCount) * 60_000;
    return this.deferForQuiet(new Date(Math.max(now, wanted)), this.prefs);
  }

  private async ensureBriefingSchedule() {
    const prefs = this.prefs;
    const cron = utcCronForLocalTime(
      prefs.briefingTime,
      prefs.timezone,
      new Date()
    );
    const existingId = this.store.getPref("briefingScheduleId");
    if (existingId && this.store.getPref("briefingCron") === cron) {
      if (await this.getScheduleById(existingId)) return;
    }
    if (existingId) await this.safeCancel(existingId);
    try {
      const schedule = await this.schedule(cron, "onBriefing");
      this.store.setPref("briefingScheduleId", schedule.id);
      this.store.setPref("briefingCron", cron);
    } catch (error) {
      console.error("Couldn't schedule the daily briefing", error);
    }
  }

  private async applyTimezone(timezone: string) {
    if (timezone === this.prefs.timezone) return;
    this.store.setPref("timezone", timezone);
    await this.ensureBriefingSchedule();
    this.syncState();
  }

  private refreshLearnings() {
    const learned = deriveLearnings(
      this.store.recentEvents(300),
      this.prefs.timezone
    );
    this.store.setLearnings(learned);
  }

  private syncState() {
    this.setState({
      tasks: this.store.listForPanel().map(toPublicTask),
      prefs: this.prefs,
      learned: this.store.getLearnings(),
      syncedAt: new Date().toISOString()
    });
  }

  private deferForQuiet(date: Date, prefs: Preferences): Date {
    return deferOutOfQuietHours(
      date,
      prefs.timezone,
      prefs.quietHoursStart,
      prefs.quietHoursEnd
    );
  }

  private newTaskId(): string {
    let id = generateTaskId();
    while (this.store.taskExists(id)) id = generateTaskId();
    return id;
  }

  private mustGet(id: string): TaskRecord {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task ${id} disappeared`);
    return task;
  }

  /** Look up by id; if the model passed a title instead, accept a unique match. */
  private findTask(idOrTitle: string): TaskRecord | null {
    const byId = this.store.getTask(normalizeTaskId(idOrTitle));
    if (byId) return byId;
    const needle = String(idOrTitle ?? "")
      .trim()
      .toLowerCase();
    if (needle.length < 3) return null;
    const matches = this.store
      .listActive()
      .filter((t) => t.title.toLowerCase().includes(needle));
    return matches.length === 1 ? matches[0] : null;
  }

  private notFound(id: string): Fail {
    return fail(`No task with id "${id}". Call listTasks to see current ids.`);
  }

  /** Compact, model-friendly view of a task with local times. */
  private present(t: TaskRecord) {
    const tz = this.prefs.timezone;
    return {
      id: t.id,
      title: t.title,
      ...(t.notes ? { notes: t.notes } : {}),
      status: t.status,
      due: formatLocal(new Date(t.dueAt), tz),
      dueIso: toLocalIso(new Date(t.dueAt), tz),
      repeat: t.repeat,
      persistence: t.persistence,
      reminders: `${t.nudgeCount}/${t.maxNudges}`,
      ...(t.snoozedUntil
        ? { snoozedUntil: formatLocal(new Date(t.snoozedUntil), tz) }
        : {}),
      ...(t.nextNudgeAt
        ? { nextReminder: formatLocal(new Date(t.nextNudgeAt), tz) }
        : {})
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function friendlyModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /binding|not configured|remote|authenticat|unauthori[sz]ed|\b10000\b/i.test(
      message
    )
  ) {
    return "I can't reach the AI model right now (Workers AI isn't available in this environment). Your tasks and reminders still work from the side panel.";
  }
  if (/429|rate|capacity|overloaded|3040/i.test(message)) {
    return "The AI model is busy right now. Please try again in a moment.";
  }
  if (/abort|timeout/i.test(message)) {
    return "That took too long, so I stopped. Please try again.";
  }
  return "Sorry, something went wrong while I was thinking. Please try again.";
}

/** A one-off assistant text reply, streamed in the normal UI message format. */
function textResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
