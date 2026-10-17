// Prompt construction and deterministic text fallbacks. Pure functions so the
// exact wording the model sees is easy to review and test.

import { groupTasks, type TaskGroups } from "./tasks";
import {
  addLocalDays,
  describeMinutes,
  formatLocal,
  localDayKey,
  offsetString,
  toLocalIso
} from "./time";
import type { EscalationLevel, Learnings, Preferences, Task } from "./types";

const MAX_TASKS_IN_PROMPT = 25;

function weekdayName(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(
    date
  );
}

/** A 7-day lookup table so the model never has to do calendar math itself. */
export function calendarHint(now: Date, timeZone: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    const day = addLocalDays(now, timeZone, i);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    lines.push(
      `- ${weekdayName(day, timeZone)} = ${localDayKey(day, timeZone)}${label}`
    );
  }
  return lines.join("\n");
}

function taskLine(task: Task, timeZone: string): string {
  const due = formatLocal(new Date(task.dueAt), timeZone);
  const bits = [
    `#${task.id}`,
    `"${task.title}"`,
    `status=${task.status}`,
    `due ${due}`,
    `persistence=${task.persistence}`,
    `nudges ${task.nudgeCount}/${task.maxNudges}`
  ];
  if (task.repeat !== "none") bits.push(`repeats ${task.repeat}`);
  if (task.snoozedUntil) {
    bits.push(
      `snoozed until ${formatLocal(new Date(task.snoozedUntil), timeZone)}`
    );
  }
  return `- ${bits.join(", ")}`;
}

export function buildSystemPrompt(args: {
  now: Date;
  prefs: Preferences;
  learned: Learnings;
  tasks: readonly Task[];
}): string {
  const { now, prefs, learned } = args;
  const tz = prefs.timezone;
  const active = args.tasks
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .slice(0, MAX_TASKS_IN_PROMPT);

  const learnedLines: string[] = [];
  if (learned.preferredSnoozeMinutes) {
    learnedLines.push(
      `- When the user says "snooze" or "later" without a duration, snooze for ${learned.preferredSnoozeMinutes} minutes.`
    );
  }
  if (learned.snoozyBuckets.length > 0) {
    learnedLines.push(
      `- The user tends to snooze ${learned.snoozyBuckets.join(" and ")} nudges. If they schedule something then, briefly suggest a different time of day (but do what they ask).`
    );
  }
  if (learned.typicalResponseMinutes) {
    learnedLines.push(
      `- The user typically finishes about ${describeMinutes(learned.typicalResponseMinutes)} after a nudge.`
    );
  }

  return `You are Nudge, a warm, concise personal follow-up assistant. You turn plain-language requests into tracked tasks and you keep following up on your own until each task is done.

## Current time (authoritative)
- Now: ${formatLocal(now, tz, "full")} (${tz}, UTC${offsetString(now, tz)})
- Now as ISO-8601: ${toLocalIso(now, tz)}
- Calendar for resolving relative dates:
${calendarHint(now, tz)}

## Rules
- ALWAYS use tools to read or change tasks. Never claim a task was created, changed, snoozed or completed unless the tool returned ok=true.
- dueAt / until must be ISO-8601 in the user's timezone with its offset, e.g. ${toLocalIso(new Date(now.getTime() + 3600_000), tz).replace(/:\d{2}([+-])/, ":00$1")}. Resolve "tomorrow", "Friday", "on the 1st" with the calendar above. If no time is given, use 09:00. "On the 1st" means the next 1st of a month that is still in the future.
- If a tool returns ok=false, read the error, fix the arguments and try again once; if it still fails, tell the user plainly what went wrong.
- persistence: "gentle" by default; "firm" for things with consequences (bills, deadlines); "urgent" when the user says keep nudging / don't let me forget / it's important.
- "Keep nudging until I confirm" means persistence firm or urgent. Recurring phrases ("every Monday", "monthly", "on the 1st of each month") map to repeat.
- "Follow up with <person> if I haven't heard back" is a task titled like "Follow up with <person>", due at that time.
- When the user says they did something ("paid it", "done", "sent it"), complete the matching task. Refer to tasks by title; use the #id only in tool calls.
- Messages that start with a bell are reminders you (Nudge) sent automatically. If the user replies "done", "snooze 1h" etc. right after one, it refers to that task.
- Quiet hours are ${prefs.quietHoursStart}-${prefs.quietHoursEnd}; nudges that fall inside are delayed until they end. Mention this if a requested time falls inside.
- Keep replies short: one or two sentences confirming what you did, including the local due time in plain words.
${learnedLines.length ? `\n## What you've learned about this user\n${learnedLines.join("\n")}\n` : ""}
## Open tasks (${active.length})
${active.length ? active.map((t) => taskLine(t, tz)).join("\n") : "- none"}`;
}

// ── Nudges ──────────────────────────────────────────────────────────────

const TONE_GUIDE: Record<EscalationLevel, string> = {
  gentle: "friendly and light, one short sentence, maybe one emoji",
  firm: "direct and matter-of-fact, one or two short sentences, no emoji",
  urgent: "short and insistent, under 15 words, no emoji, no pleasantries"
};

export interface NudgeContext {
  task: Task;
  level: EscalationLevel;
  nudgeNumber: number;
  isLast: boolean;
  now: Date;
  timeZone: string;
}

export function buildNudgePrompt(ctx: NudgeContext): {
  system: string;
  prompt: string;
} {
  const { task, level, nudgeNumber, isLast, now, timeZone } = ctx;
  const overdueMin = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(task.dueAt)) / 60_000)
  );
  return {
    system:
      "You write a single reminder message for a personal follow-up app. Output only the message text: no quotes, no preamble, no markdown headings, never more than 2 sentences.",
    prompt: [
      `Task: ${task.title}`,
      task.notes ? `Notes: ${task.notes}` : null,
      `Was due: ${formatLocal(new Date(task.dueAt), timeZone)}${overdueMin > 1 ? ` (${describeMinutes(overdueMin)} ago)` : ""}`,
      `This is reminder ${nudgeNumber} of ${task.maxNudges}${isLast ? " (the last one; say so)" : ""}.`,
      `Tone: ${level}: ${TONE_GUIDE[level]}.`,
      `End by inviting a quick reply like "done" or "snooze 1h".`
    ]
      .filter(Boolean)
      .join("\n")
  };
}

/** Deterministic fallback used when the model is unavailable or misbehaves. */
export function templateNudge(
  ctx: Omit<NudgeContext, "now" | "timeZone">
): string {
  const { task, level, nudgeNumber, isLast } = ctx;
  const t = task.title;
  const tail = isLast
    ? " This is my last reminder for it."
    : ' Reply "done" or "snooze 1h".';
  switch (level) {
    case "gentle":
      return nudgeNumber === 1
        ? `Hey! Just a friendly reminder: ${t}.${tail}`
        : `Circling back on "${t}". Whenever you get a moment!${tail}`;
    case "firm":
      return `Reminder #${nudgeNumber}: "${t}" is still open. Please take care of it.${tail}`;
    case "urgent":
      return `Still not done: "${t}". Do it now.${tail}`;
  }
}

/** Trim model output into a single safe chat line; null means "use the template". */
export function sanitizeNudgeText(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  let out = text
    .replace(/<\/?[^>]+>/g, "")
    .replace(/^\s*(?:message|reminder)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  if (out.length < 4) return null;
  if (out.length > 320) out = `${out.slice(0, 317).trimEnd()}…`;
  return out;
}

// ── Briefing ────────────────────────────────────────────────────────────

export interface Briefing {
  date: string;
  timezone: string;
  overdue: Task[];
  dueToday: Task[];
  snoozed: Task[];
  upcomingCount: number;
}

export function buildBriefing(
  tasks: readonly Task[],
  now: Date,
  timeZone: string
): Briefing {
  const g: TaskGroups = groupTasks(tasks, now, timeZone);
  return {
    date: localDayKey(now, timeZone),
    timezone: timeZone,
    overdue: g.overdue,
    dueToday: g.today,
    snoozed: g.snoozed,
    upcomingCount: g.upcoming.length
  };
}

export function briefingHasContent(b: Briefing): boolean {
  return b.overdue.length + b.dueToday.length + b.snoozed.length > 0;
}

export function formatBriefingText(b: Briefing): string {
  const tz = b.timezone;
  const line = (t: Task) =>
    `- **${t.title}**: ${formatLocal(new Date(t.dueAt), tz, "time")}`;
  const parts: string[] = ["**Your daily briefing**"];
  if (b.overdue.length) {
    parts.push(
      `\n**Overdue (${b.overdue.length})**\n${b.overdue
        .map(
          (t) =>
            `- **${t.title}**: was due ${formatLocal(new Date(t.dueAt), tz)}`
        )
        .join("\n")}`
    );
  }
  if (b.dueToday.length) {
    parts.push(
      `\n**Due today (${b.dueToday.length})**\n${b.dueToday.map(line).join("\n")}`
    );
  }
  if (b.snoozed.length) {
    parts.push(
      `\n**Snoozed (${b.snoozed.length})**\n${b.snoozed
        .map(
          (t) =>
            `- **${t.title}**: back ${t.snoozedUntil ? formatLocal(new Date(t.snoozedUntil), tz) : "soon"}`
        )
        .join("\n")}`
    );
  }
  if (!briefingHasContent(b)) parts.push("\nNothing due today. Enjoy it!");
  if (b.upcomingCount) parts.push(`\n${b.upcomingCount} more coming up later.`);
  return parts.join("\n");
}
