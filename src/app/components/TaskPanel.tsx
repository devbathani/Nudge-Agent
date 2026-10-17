import { CheckCircleIcon } from "@phosphor-icons/react";
import { groupTasks, type TaskGroups } from "../../lib/tasks";
import type { NudgeState, Task } from "../../lib/types";
import { LearnedCard } from "./LearnedCard";
import { TaskItem, type TaskAction } from "./TaskItem";

const SECTIONS: { key: keyof TaskGroups; label: string; tone: string }[] = [
  { key: "overdue", label: "Overdue", tone: "text-red-600 dark:text-red-400" },
  { key: "today", label: "Today", tone: "text-kumo-default" },
  { key: "upcoming", label: "Upcoming", tone: "text-kumo-default" },
  {
    key: "snoozed",
    label: "Snoozed",
    tone: "text-violet-600 dark:text-violet-400"
  },
  { key: "done", label: "Done", tone: "text-kumo-subtle" }
];

export function TaskPanel({
  state,
  now,
  timeZone,
  busyIds,
  onAction
}: {
  state: NudgeState;
  now: Date;
  timeZone: string;
  busyIds: ReadonlySet<string>;
  onAction: (task: Task, action: TaskAction) => void;
}) {
  const groups = groupTasks(state.tasks, now, timeZone);
  const openCount =
    groups.overdue.length +
    groups.today.length +
    groups.upcoming.length +
    groups.snoozed.length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-kumo-default">Tasks</h2>
        <span className="text-xs text-kumo-subtle">{openCount} open</span>
      </div>

      {state.tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-kumo-line p-6 text-center">
          <CheckCircleIcon size={28} className="mx-auto text-kumo-inactive" />
          <p className="mt-2 text-sm text-kumo-subtle">
            No tasks yet. Tell Nudge what to remember in the chat.
          </p>
        </div>
      ) : (
        SECTIONS.map(({ key, label, tone }) => {
          const items = key === "done" ? groups.done.slice(0, 8) : groups[key];
          if (items.length === 0) return null;
          return (
            <section key={key} aria-label={label}>
              <h3
                className={`mb-2 text-xs font-semibold uppercase tracking-wide ${tone}`}
              >
                {label}{" "}
                <span className="font-normal text-kumo-inactive">
                  ({groups[key].length})
                </span>
              </h3>
              <ul className="space-y-2">
                {items.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    now={now}
                    busy={busyIds.has(task.id)}
                    onAction={onAction}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}

      <LearnedCard learned={state.learned} prefs={state.prefs} />
    </div>
  );
}
