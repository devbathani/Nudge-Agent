// Deterministic habit learning over the events log. No ML: just counts and
// medians with minimum-sample thresholds, so every learning is explainable
// ("4 of 5 morning nudges were snoozed") and reproducible in tests.

import { timeBucket } from "./time";
import type { Learnings, TaskEvent, TimeBucket } from "./types";

/** Don't claim a habit from fewer observations than this. */
export const MIN_SAMPLES = 3;
/** Share of nudges in a bucket that must be snoozed to call it "snoozy". */
export const SNOOZY_RATIO = 0.6;

const BUCKET_LABEL: Record<TimeBucket, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Late-night"
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bucketOf(event: TaskEvent, timeZone: string): TimeBucket {
  const stored = event.meta.bucket;
  if (
    stored === "morning" ||
    stored === "afternoon" ||
    stored === "evening" ||
    stored === "night"
  ) {
    return stored;
  }
  return timeBucket(new Date(event.at), timeZone);
}

/**
 * Derive learnings from recent events.
 *
 * - preferredSnoozeMinutes: median of explicit snooze lengths.
 * - snoozyBuckets: time-of-day buckets where most nudges get snoozed. A snooze
 *   counts against the bucket of the nudge it answered (meta.nudgeBucket).
 * - typicalResponseMinutes: median minutes from last nudge to completion.
 * - "one nudge is enough": most completions happen after ≤ 1 nudge.
 */
export function deriveLearnings(
  events: readonly TaskEvent[],
  timeZone: string
): Learnings {
  const insights: string[] = [];

  const snoozeLengths = events
    .filter((e) => e.type === "snoozed")
    .map((e) => num(e.meta.minutes))
    .filter((m): m is number => m !== null && m > 0);
  const medianSnooze = median(snoozeLengths);
  const preferredSnoozeMinutes =
    snoozeLengths.length >= MIN_SAMPLES && medianSnooze !== null
      ? Math.max(5, Math.round(medianSnooze / 5) * 5)
      : null;
  if (preferredSnoozeMinutes !== null) {
    insights.push(
      `When you snooze, it's usually for about ${formatMinutes(preferredSnoozeMinutes)}, so that's the default now.`
    );
  }

  const nudgesPerBucket = new Map<TimeBucket, number>();
  const snoozesPerBucket = new Map<TimeBucket, number>();
  for (const e of events) {
    if (e.type === "nudged") {
      const b = bucketOf(e, timeZone);
      nudgesPerBucket.set(b, (nudgesPerBucket.get(b) ?? 0) + 1);
    } else if (e.type === "snoozed" && e.meta.afterNudge === true) {
      const b =
        (e.meta.nudgeBucket as TimeBucket | undefined) ?? bucketOf(e, timeZone);
      snoozesPerBucket.set(b, (snoozesPerBucket.get(b) ?? 0) + 1);
    }
  }
  const snoozyBuckets: TimeBucket[] = [];
  for (const [bucket, nudges] of nudgesPerBucket) {
    const snoozes = Math.min(snoozesPerBucket.get(bucket) ?? 0, nudges);
    if (nudges >= MIN_SAMPLES && snoozes / nudges >= SNOOZY_RATIO) {
      snoozyBuckets.push(bucket);
      insights.push(
        `${BUCKET_LABEL[bucket]} nudges usually get snoozed (${snoozes} of ${nudges}). Nudge will suggest other times.`
      );
    }
  }
  snoozyBuckets.sort();

  const completions = events.filter((e) => e.type === "completed");
  const latencies = completions
    .map((e) => num(e.meta.minutesSinceNudge))
    .filter((m): m is number => m !== null && m >= 0);
  const medianLatency = median(latencies);
  const typicalResponseMinutes =
    latencies.length >= MIN_SAMPLES && medianLatency !== null
      ? Math.max(1, Math.round(medianLatency))
      : null;
  if (typicalResponseMinutes !== null) {
    insights.push(
      `You usually finish things about ${formatMinutes(typicalResponseMinutes)} after a nudge, so follow-ups are spaced to match.`
    );
  }

  const nudgeCounts = completions
    .map((e) => num(e.meta.nudgeCount))
    .filter((n): n is number => n !== null);
  if (nudgeCounts.length >= MIN_SAMPLES) {
    const quick = nudgeCounts.filter((n) => n <= 1).length;
    if (quick / nudgeCounts.length >= 0.7) {
      insights.push(
        `One nudge is usually enough for you (${quick} of ${nudgeCounts.length} tasks).`
      );
    } else if (quick / nudgeCounts.length <= 0.3) {
      insights.push(
        "Most tasks take a few follow-ups before they're done, so Nudge keeps at it."
      );
    }
  }

  return {
    preferredSnoozeMinutes,
    typicalResponseMinutes,
    snoozyBuckets,
    insights,
    sampleSize: events.length
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
