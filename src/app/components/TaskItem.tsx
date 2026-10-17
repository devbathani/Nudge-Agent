import {
  ArrowsClockwiseIcon,
  BellRingingIcon,
  CheckIcon,
  ClockIcon,
  XIcon
} from "@phosphor-icons/react";
import type { Task } from "../../lib/types";
import { relativeTime, shortDateTime } from "../format";
import { StatusChip } from "./chips";

export type TaskAction =
  | "done"
  | "snooze-15m"
  | "snooze-1h"
  | "snooze-tomorrow"
  | "cancel";

const actionBtn =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-kumo-default ring-1 ring-inset ring-kumo-line hover:bg-kumo-control disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

export function TaskItem({
  task,
  now,
  busy,
  onAction
}: {
  task: Task;
  now: Date;
  busy: boolean;
  onAction: (task: Task, action: TaskAction) => void;
}) {
  const finished = task.status === "done" || task.status === "cancelled";
  const overdue =
    !finished &&
    task.status !== "snoozed" &&
    Date.parse(task.dueAt) <= now.getTime();

  let when: string;
  if (task.status === "done" && task.completedAt) {
    when = `Done ${relativeTime(task.completedAt, now)}`;
  } else if (task.status === "snoozed" && task.snoozedUntil) {
    when = `Back ${relativeTime(task.snoozedUntil, now)} · ${shortDateTime(task.snoozedUntil, now)}`;
  } else {
    when = `${overdue ? "Was due" : "Due"} ${relativeTime(task.dueAt, now)} · ${shortDateTime(task.dueAt, now)}`;
  }

  return (
    <li
      className={`rounded-xl border border-kumo-line bg-kumo-base p-3 ${finished ? "opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`text-sm font-medium text-kumo-default break-words ${task.status === "done" ? "line-through decoration-kumo-inactive" : ""}`}
          >
            {task.title}
          </p>
          <p
            className={`mt-0.5 text-xs ${overdue ? "text-red-600 dark:text-red-400" : "text-kumo-subtle"}`}
          >
            <ClockIcon size={11} className="inline mr-1 -mt-0.5" />
            {when}
          </p>
        </div>
        <StatusChip status={task.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-kumo-subtle">
        <span title="Reminders sent / maximum">
          <BellRingingIcon size={11} className="inline mr-1 -mt-0.5" />
          {task.nudgeCount}/{task.maxNudges} nudges · {task.persistence}
        </span>
        {task.repeat !== "none" && (
          <span>
            <ArrowsClockwiseIcon size={11} className="inline mr-1 -mt-0.5" />
            {task.repeat}
          </span>
        )}
        {!finished && task.nextNudgeAt && (
          <span>Next nudge {relativeTime(task.nextNudgeAt, now)}</span>
        )}
      </div>

      {!finished && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(task, "done")}
            className={`${actionBtn} bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 hover:bg-emerald-500/20 dark:text-emerald-300`}
          >
            <CheckIcon size={12} weight="bold" /> Done
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(task, "snooze-15m")}
            className={actionBtn}
          >
            15m
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(task, "snooze-1h")}
            className={actionBtn}
          >
            1h
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(task, "snooze-tomorrow")}
            className={actionBtn}
          >
            Tomorrow
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(task, "cancel")}
            className={`${actionBtn} ml-auto`}
            aria-label={`Cancel ${task.title}`}
            title="Cancel task"
          >
            <XIcon size={12} />
          </button>
        </div>
      )}
    </li>
  );
}
