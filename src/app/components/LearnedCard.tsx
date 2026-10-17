import { BrainIcon } from "@phosphor-icons/react";
import type { Learnings, Preferences } from "../../lib/types";

export function LearnedCard({
  learned,
  prefs
}: {
  learned: Learnings;
  prefs: Preferences;
}) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-base p-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-kumo-default">
        <BrainIcon size={15} className="text-violet-500" />
        What Nudge has learned
      </h3>
      {learned.insights.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {learned.insights.map((insight) => (
            <li
              key={insight}
              className="text-xs leading-relaxed text-kumo-default"
            >
              • {insight}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-kumo-subtle">
          Nothing yet. Nudge watches how you respond (what you snooze, when you
          finish things) and adapts after a few reminders.
        </p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-kumo-line pt-2.5 text-[11px]">
        <div>
          <dt className="text-kumo-inactive">Quiet hours</dt>
          <dd className="text-kumo-default">
            {prefs.quietHoursStart === prefs.quietHoursEnd
              ? "Off"
              : `${prefs.quietHoursStart}–${prefs.quietHoursEnd}`}
          </dd>
        </div>
        <div>
          <dt className="text-kumo-inactive">Briefing</dt>
          <dd className="text-kumo-default">{prefs.briefingTime}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-kumo-inactive">Time zone</dt>
          <dd className="truncate text-kumo-default" title={prefs.timezone}>
            {prefs.timezone}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-kumo-inactive">
        Change these by asking, e.g. “quiet hours 23:00 to 6:30”.
      </p>
    </section>
  );
}
