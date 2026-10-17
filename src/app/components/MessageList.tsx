import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  BellRingingIcon,
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  SunHorizonIcon,
  WarningIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { AutonomousMessageMeta, Task } from "../../lib/types";
import { clockTime } from "../format";
import { ToneBadge } from "./chips";
import type { TaskAction } from "./TaskItem";

const TOOL_LABELS: Record<string, string> = {
  addTask: "Created a task",
  listTasks: "Checked your tasks",
  updateTask: "Updated a task",
  snoozeTask: "Snoozed a task",
  completeTask: "Marked done",
  cancelTask: "Cancelled a task",
  getBriefing: "Looked at today",
  setPreferences: "Updated settings"
};

function autonomousMeta(message: UIMessage): AutonomousMessageMeta | null {
  const meta = message.metadata as Partial<AutonomousMessageMeta> | undefined;
  return meta && (meta.kind === "nudge" || meta.kind === "briefing")
    ? (meta as AutonomousMessageMeta)
    : null;
}

function ToolChip({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;
  const output =
    part.state === "output-available"
      ? (part.output as { ok?: boolean; error?: string })
      : null;
  const failed = part.state === "output-error" || output?.ok === false;
  const running =
    part.state === "input-streaming" || part.state === "input-available";

  return (
    <details className="group max-w-[85%] text-xs">
      <summary
        className={`inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset ${
          failed
            ? "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300"
            : "bg-kumo-control text-kumo-subtle ring-kumo-line"
        }`}
      >
        {running ? (
          <CircleNotchIcon size={12} className="animate-spin" />
        ) : failed ? (
          <WarningIcon size={12} />
        ) : (
          <CheckIcon
            size={12}
            weight="bold"
            className="text-emerald-600 dark:text-emerald-400"
          />
        )}
        {running ? `${label}…` : failed ? `${label}: retrying` : label}
        <CaretRightIcon
          size={10}
          className="transition-transform group-open:rotate-90"
        />
      </summary>
      <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-kumo-control p-2.5 font-mono text-[11px] text-kumo-subtle">
        {JSON.stringify(
          {
            input: part.input,
            ...(output ? { output } : {}),
            ...(part.state === "output-error" ? { error: part.errorText } : {})
          },
          null,
          2
        )}
      </pre>
    </details>
  );
}

function AutonomousCard({
  message,
  meta,
  task,
  busy,
  onAction
}: {
  message: UIMessage;
  meta: AutonomousMessageMeta;
  task: Task | undefined;
  busy: boolean;
  onAction: (task: Task, action: TaskAction) => void;
}) {
  const text = message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .replace(/^🔔\s*/, "");
  const isNudge = meta.kind === "nudge";
  const active =
    task &&
    (task.status === "pending" ||
      task.status === "nudged" ||
      task.status === "snoozed");

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[85%] rounded-2xl rounded-bl-md border p-3.5 ${
          isNudge
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-sky-500/30 bg-sky-500/5"
        }`}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
          {isNudge ? (
            <BellRingingIcon
              size={15}
              weight="fill"
              className="nudge-ring text-amber-500"
            />
          ) : (
            <SunHorizonIcon size={15} weight="fill" className="text-sky-500" />
          )}
          <span className="font-semibold text-kumo-default">
            {isNudge ? "Nudge" : "Daily briefing"}
          </span>
          {isNudge && meta.level && <ToneBadge level={meta.level} />}
          {isNudge && meta.nudgeNumber && (
            <span>
              reminder {meta.nudgeNumber}
              {meta.maxNudges ? ` of ${meta.maxNudges}` : ""}
            </span>
          )}
          <span className="ml-auto">{clockTime(meta.at)}</span>
        </div>
        <Streamdown
          className="sd-theme text-sm leading-relaxed text-kumo-default"
          plugins={{ code }}
          controls={false}
        >
          {text}
        </Streamdown>
        {isNudge && task && active && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(task, "done")}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300"
            >
              <CheckIcon size={12} weight="bold" /> Done
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(task, "snooze-1h")}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-kumo-default ring-1 ring-inset ring-kumo-line hover:bg-kumo-control disabled:cursor-not-allowed disabled:opacity-50"
            >
              Snooze 1h
            </button>
          </div>
        )}
        {isNudge && task?.status === "done" && (
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            ✓ Done
          </p>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  tasks,
  isStreaming,
  busyIds,
  onAction
}: {
  messages: UIMessage[];
  tasks: readonly Task[];
  isStreaming: boolean;
  busyIds: ReadonlySet<string>;
  onAction: (task: Task, action: TaskAction) => void;
}) {
  return (
    <>
      {messages.map((message, index) => {
        const meta =
          message.role === "assistant" ? autonomousMeta(message) : null;
        if (meta) {
          return (
            <AutonomousCard
              key={message.id}
              message={message}
              meta={meta}
              task={
                meta.taskId
                  ? tasks.find((t) => t.id === meta.taskId)
                  : undefined
              }
              busy={meta.taskId ? busyIds.has(meta.taskId) : false}
              onAction={onAction}
            />
          );
        }
        const isUser = message.role === "user";
        const isLastAssistant = !isUser && index === messages.length - 1;
        return (
          <div key={message.id} className="space-y-2">
            {message.parts.map((part, i) => {
              const key = `${message.id}-${i}`;
              if (isToolUIPart(part)) return <ToolChip key={key} part={part} />;
              if (part.type !== "text" || !part.text) return null;
              if (isUser) {
                return (
                  <div key={key} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 leading-relaxed text-kumo-inverse">
                      {part.text}
                    </div>
                  </div>
                );
              }
              return (
                <div key={key} className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base leading-relaxed text-kumo-default">
                    <Streamdown
                      className="sd-theme p-3"
                      plugins={{ code }}
                      controls={false}
                      isAnimating={isLastAssistant && isStreaming}
                    >
                      {part.text}
                    </Streamdown>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export function ChatError({
  message,
  onDismiss
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300"
    >
      <XCircleIcon size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onDismiss} className="text-xs underline">
        Dismiss
      </button>
    </div>
  );
}
