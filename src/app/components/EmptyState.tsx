import { BellRingingIcon } from "@phosphor-icons/react";

export const EXAMPLE_PROMPTS = [
  "Remind me to pay rent on the 1st of every month and keep nudging until I confirm",
  "Follow up with Priya on Friday at 3pm if I haven't heard back",
  "Remind me in 2 minutes to drink a glass of water"
];

export function EmptyState({
  disabled,
  onPick
}: {
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/30">
        <BellRingingIcon size={28} weight="fill" className="text-amber-500" />
      </div>
      <h2 className="mt-4 text-xl font-semibold text-kumo-default">
        Hi, I'm Nudge.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-kumo-subtle">
        Tell me what you need to remember in plain words. I'll remind you when
        it's due and keep following up, a little more firmly each time, until
        it's done.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onPick(prompt)}
            className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-left text-sm text-kumo-default transition-colors hover:border-amber-500/50 hover:bg-amber-500/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            “{prompt}”
          </button>
        ))}
      </div>
    </div>
  );
}
