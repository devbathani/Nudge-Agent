// End-to-end smoke test of the autonomous loop against a running dev server.
// Exercises SQL schema creation, scheduling, idempotent callbacks, the
// template fallback, message persistence, state sync and reset, without
// needing the LLM.
//
//   npm run dev:offline        # terminal 1 (or npm run dev)
//   npm run smoke              # terminal 2
//
// Env: NUDGE_URL (default http://localhost:5173)

import { AgentClient } from "agents/client";

const base = new URL(process.env.NUDGE_URL ?? "http://localhost:5173");
const name = `smoke-${Date.now().toString(36)}`;
const frames = [];
let state = null;

const client = new AgentClient({
  agent: "NudgeAgent",
  name,
  host: base.host,
  protocol: base.protocol === "https:" ? "wss" : "ws",
  onStateUpdate: (s) => (state = s)
});
client.addEventListener("message", (e) => {
  try {
    frames.push(JSON.parse(String(e.data)));
  } catch {
    // ignore non-JSON frames
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const task = (id) => state?.tasks.find((t) => t.id === id);
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();

try {
  await client.ready;
  console.log(`Connected to ${base.origin} as ${name}`);

  const hello = await client.call("hello", ["Asia/Kolkata"]);
  check("hello stores timezone", hello.prefs?.timezone === "Asia/Kolkata");
  // Disable quiet hours so the test is independent of the time of day.
  await client.call("rpcSetPreferences", [
    { quietHoursStart: "00:00", quietHoursEnd: "00:00" }
  ]);

  const bad = await client.call("rpcAddTask", [
    { title: "Past", dueAt: "2020-01-01T09:00:00Z" }
  ]);
  check(
    "rejects a past dueAt with a clear error",
    bad.ok === false && /past/.test(bad.error),
    bad.error
  );

  // 1. A task that is completed before it is due must never nudge.
  const early = await client.call("rpcAddTask", [
    { title: "Smoke: completed early", dueAt: inSeconds(4) }
  ]);
  check("creates a task", early.ok === true, early.task?.id);
  const done = await client.call("rpcComplete", [early.task.id]);
  check("completes it before it is due", done.ok === true);

  // 2. A task that comes due gets nudged.
  const added = await client.call("rpcAddTask", [
    { title: "Smoke: drink water", dueAt: inSeconds(5), persistence: "urgent" }
  ]);
  const id = added.task.id;
  check(
    "schedules a reminder",
    Boolean(added.firstReminder),
    added.firstReminder
  );

  const fired = await waitFor(
    () => frames.find((f) => f.type === "nudge/fired" && f.taskId === id),
    40_000,
    "nudge/fired broadcast"
  );
  check("nudge fires and is broadcast", true, `"${fired.text}"`);
  check("tone matches persistence", fired.level === "urgent", fired.level);

  await waitFor(() => task(id)?.status === "nudged", 5_000, "state sync");
  const t = task(id);
  check("state machine: pending -> nudged", t.status === "nudged");
  check(
    "nudge count incremented",
    t.nudgeCount === 1,
    `${t.nudgeCount}/${t.maxNudges}`
  );
  const gapMin = (Date.parse(t.nextNudgeAt) - Date.now()) / 60_000;
  check(
    "next follow-up uses 15 min backoff",
    gapMin > 13 && gapMin <= 15.1,
    `${gapMin.toFixed(1)} min`
  );

  const persisted = frames.some(
    (f) =>
      Array.isArray(f.messages) &&
      f.messages.some(
        (m) => m.metadata?.kind === "nudge" && m.metadata?.taskId === id
      )
  );
  check("nudge persisted as an assistant chat message", persisted);

  const early2 = frames.find(
    (f) => f.type === "nudge/fired" && f.taskId === early.task.id
  );
  check("completed task was never nudged", !early2);

  const snoozed = await client.call("rpcSnooze", [id, "1h"]);
  check(
    "snooze via RPC",
    snoozed.ok === true && task(id)?.status === "snoozed"
  );
  const completed = await client.call("rpcComplete", [id]);
  await waitFor(() => task(id)?.status === "done", 5_000, "done");
  check(
    "complete via RPC clears the schedule",
    completed.ok === true && task(id).nextNudgeAt === null
  );
  const again = await client.call("rpcComplete", [id]);
  check(
    "terminal state rejects further actions",
    again.ok === false,
    again.error
  );

  // 3. Recurrence: completing a daily task creates the next occurrence.
  const daily = await client.call("rpcAddTask", [
    { title: "Smoke: daily", dueAt: inSeconds(3600), repeat: "daily" }
  ]);
  const dailyDone = await client.call("rpcComplete", [daily.task.id]);
  check(
    "recurring task spawns next occurrence",
    Boolean(dailyDone.nextOccurrence),
    dailyDone.nextOccurrence?.due
  );

  const reset = await client.call("resetMyData", ["Asia/Kolkata"]);
  await waitFor(() => state?.tasks.length === 0, 5_000, "reset");
  check("reset clears everything", reset.ok === true);
} catch (error) {
  console.error("✘", error instanceof Error ? error.message : error);
  failures++;
} finally {
  client.close();
}

console.log(
  failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed"
);
process.exit(failures ? 1 : 0);
