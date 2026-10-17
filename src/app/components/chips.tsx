import type { EscalationLevel, TaskStatus } from "../../lib/types";

const TONE_STYLES: Record<EscalationLevel, string> = {
  gentle: "bg-sky-500/10 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  firm: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  urgent: "bg-red-500/10 text-red-700 ring-red-500/30 dark:text-red-300"
};

const STATUS_STYLES: Record<TaskStatus, string> = {
  pending: "bg-kumo-control text-kumo-subtle ring-kumo-line",
  nudged:
    "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  snoozed:
    "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300",
  done: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  cancelled: "bg-kumo-control text-kumo-inactive ring-kumo-line"
};

const chip =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap";

export function ToneBadge({ level }: { level: EscalationLevel }) {
  return <span className={`${chip} ${TONE_STYLES[level]}`}>{level}</span>;
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`${chip} ${STATUS_STYLES[status]}`}>{status}</span>;
}
