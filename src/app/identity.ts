// Anonymous per-browser identity. The id doubles as the Durable Object
// instance name, so each browser gets its own NudgeAgent with its own tasks.
// This is a deliberate simplification (no auth); see README "Identity".

const STORAGE_KEY = "nudge:user-id";
const VALID_ID = /^[a-z0-9-]{8,64}$/;

let sessionFallback: string | null = null;

export function getAnonUserId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && VALID_ID.test(existing)) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode, strict settings): fall back to a
    // per-tab identity rather than failing to load.
    sessionFallback ??= crypto.randomUUID();
    return sessionFallback;
  }
}

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
