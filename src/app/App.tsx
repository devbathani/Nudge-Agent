import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Button, InputArea } from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  BellRingingIcon,
  BellSlashIcon,
  CircleIcon,
  ListChecksIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import type { NudgeAgent } from "../server";
import { groupTasks } from "../lib/tasks";
import {
  DEFAULT_PREFS,
  EMPTY_LEARNINGS,
  type NudgeBroadcast,
  type NudgeState,
  type Task
} from "../lib/types";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EmptyState } from "./components/EmptyState";
import { ChatError, MessageList } from "./components/MessageList";
import { TaskPanel } from "./components/TaskPanel";
import type { TaskAction } from "./components/TaskItem";
import { getAnonUserId, getBrowserTimeZone } from "./identity";
import { useNotifications } from "./useNotifications";

const EMPTY_STATE: NudgeState = {
  tasks: [],
  prefs: DEFAULT_PREFS,
  learned: EMPTY_LEARNINGS,
  syncedAt: new Date(0).toISOString()
};

type RpcResult = { ok: true } | { ok: false; error: string };

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const mode = dark ? "light" : "dark";
    setDark(!dark);
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem("theme", mode);
    } catch {
      // ignore
    }
  }, [dark]);
  return (
    <Button
      variant="ghost"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle dark mode"
    />
  );
}

/**
 * Current time for relative labels and task grouping. Ticks periodically, and
 * `refresh` lets a state sync regroup tasks immediately (e.g. a just-nudged
 * task moves to Overdue without waiting for the next tick).
 */
function useNow(intervalMs = 30_000): [Date, () => void] {
  const [now, setNow] = useState(() => new Date());
  const refresh = useCallback(() => setNow(new Date()), []);
  useEffect(() => {
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, refresh]);
  return [now, refresh];
}

function NudgeApp() {
  const userId = useMemo(() => getAnonUserId(), []);
  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const [now, refreshNow] = useNow();
  const toasts = useKumoToastManager();
  const notifications = useNotifications();

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<NudgeState>(EMPTY_STATE);
  const [input, setInput] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onBroadcast = useCallback(
    (event: MessageEvent) => {
      let data: NudgeBroadcast;
      try {
        data = JSON.parse(String(event.data)) as NudgeBroadcast;
      } catch {
        return; // binary or non-JSON frame
      }
      if (data?.type === "nudge/fired") {
        toasts.add({
          title: `🔔 ${data.title}`,
          description: data.text,
          timeout: 8000
        });
        notifications.notify(
          `Nudge: ${data.title}`,
          data.text,
          `nudge-${data.taskId}`
        );
      } else if (data?.type === "nudge/briefing") {
        toasts.add({ title: "Your daily briefing is ready", timeout: 6000 });
        notifications.notify(
          "Nudge: daily briefing",
          "Your summary for today is in the chat.",
          "nudge-briefing"
        );
      }
    },
    [toasts, notifications]
  );

  const agent = useAgent<NudgeAgent, NudgeState>({
    agent: "NudgeAgent",
    name: userId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback(
      (next: NudgeState) => {
        setState(next);
        refreshNow();
      },
      [refreshNow]
    ),
    onMessage: onBroadcast
  });

  // Tell the agent our timezone on every (re)connect.
  useEffect(() => {
    if (!connected) return;
    agent.stub
      .hello(timeZone)
      .catch((e: unknown) => console.warn("hello failed", e));
  }, [connected, agent, timeZone]);

  const { messages, sendMessage, clearHistory, stop, status, error } =
    useAgentChat({
      agent,
      // Sent with every chat request so the very first turn already knows the zone.
      body: () => ({ timezone: timeZone }),
      experimental_throttle: 80
    });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !connected) return;
      notifications.askOnce(); // user gesture: a good moment to ask, once
      setDismissedError(null);
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    },
    [isStreaming, connected, notifications, sendMessage]
  );

  const runTaskAction = useCallback(
    async (task: Task, action: TaskAction) => {
      setBusyIds((prev) => new Set(prev).add(task.id));
      try {
        let result: RpcResult;
        switch (action) {
          case "done":
            result = await agent.stub.rpcComplete(task.id);
            break;
          case "cancel":
            result = await agent.stub.rpcCancel(task.id);
            break;
          case "snooze-15m":
            result = await agent.stub.rpcSnooze(task.id, "15m");
            break;
          case "snooze-1h":
            result = await agent.stub.rpcSnooze(task.id, "1h");
            break;
          case "snooze-tomorrow":
            result = await agent.stub.rpcSnooze(task.id, "tomorrow");
            break;
        }
        if (!result.ok) {
          toasts.add({
            title: "Couldn't update task",
            description: result.error,
            timeout: 6000
          });
        } else if (action === "done") {
          toasts.add({
            title: `✓ ${task.title}`,
            description: "Marked done. No more nudges.",
            timeout: 3500
          });
        }
      } catch (e) {
        console.error(e);
        toasts.add({
          title: "Connection problem",
          description:
            "That didn't reach Nudge. Check your connection and try again.",
          timeout: 6000
        });
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      }
    },
    [agent, toasts]
  );

  const resetData = useCallback(async () => {
    setResetting(true);
    try {
      const result = await agent.stub.resetMyData(timeZone);
      if (!result.ok) throw new Error(result.error);
      clearHistory();
      toasts.add({
        title: "All clear",
        description: "Your tasks, history and preferences were deleted.",
        timeout: 4000
      });
      setConfirmReset(false);
    } catch (e) {
      console.error(e);
      toasts.add({
        title: "Reset failed",
        description: "Please try again.",
        timeout: 6000
      });
    } finally {
      setResetting(false);
    }
  }, [agent, timeZone, clearHistory, toasts]);

  const groups = groupTasks(state.tasks, now, timeZone);
  const openCount =
    groups.overdue.length +
    groups.today.length +
    groups.upcoming.length +
    groups.snoozed.length;
  const errorText = error
    ? error.message || "Something went wrong. Please try again."
    : null;

  return (
    <div className="flex h-dvh flex-col bg-kumo-elevated">
      <header className="flex items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <BellRingingIcon
            size={22}
            weight="fill"
            className="shrink-0 text-amber-500"
          />
          <h1 className="text-lg font-semibold text-kumo-default">Nudge</h1>
          <span className="hidden truncate text-xs text-kumo-subtle sm:inline">
            reminds you until it's done
          </span>
          <span
            className="ml-1 flex items-center gap-1 text-xs text-kumo-subtle"
            title={connected ? "Connected" : "Reconnecting…"}
          >
            <CircleIcon
              size={8}
              weight="fill"
              className={connected ? "text-emerald-500" : "text-red-500"}
            />
            <span className="hidden md:inline">
              {connected ? "Connected" : "Reconnecting…"}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          {notifications.permission !== "unsupported" && (
            <Button
              variant="ghost"
              shape="square"
              aria-label={
                notifications.permission === "granted"
                  ? "Notifications on"
                  : "Enable notifications"
              }
              title={
                notifications.permission === "granted"
                  ? "Desktop notifications are on"
                  : notifications.permission === "denied"
                    ? "Notifications are blocked in your browser settings"
                    : "Enable desktop notifications"
              }
              icon={
                notifications.permission === "granted" ? (
                  <BellRingingIcon size={16} />
                ) : (
                  <BellSlashIcon size={16} />
                )
              }
              onClick={() => void notifications.request()}
            />
          )}
          <ThemeToggle />
          <Button
            variant="ghost"
            shape="square"
            aria-label="Reset my data"
            title="Reset my data"
            icon={<TrashIcon size={16} />}
            onClick={() => setConfirmReset(true)}
          />
          <Button
            variant="secondary"
            className="lg:hidden"
            icon={<ListChecksIcon size={16} />}
            onClick={() => setPanelOpen(true)}
            aria-label="Show tasks"
          >
            {openCount}
            {groups.overdue.length > 0 && (
              <span className="ml-1 h-2 w-2 rounded-full bg-red-500" />
            )}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
              {messages.length === 0 && (
                <EmptyState
                  disabled={!connected || isStreaming}
                  onPick={send}
                />
              )}
              <MessageList
                messages={messages}
                tasks={state.tasks}
                isStreaming={isStreaming}
                onAction={runTaskAction}
              />
              {isStreaming &&
                messages[messages.length - 1]?.role === "user" && (
                  <p className="text-xs text-kumo-subtle animate-pulse">
                    Nudge is thinking…
                  </p>
                )}
              {errorText && dismissedError !== errorText && (
                <ChatError
                  message={errorText}
                  onDismiss={() => setDismissedError(errorText)}
                />
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="mx-auto max-w-3xl px-4 py-3"
            >
              <div className="flex items-end gap-2 rounded-xl border border-kumo-line bg-kumo-base p-2.5 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder={
                    connected
                      ? "e.g. Remind me to call the dentist tomorrow at 10…"
                      : "Connecting…"
                  }
                  aria-label="Message Nudge"
                  disabled={!connected}
                  rows={1}
                  className="flex-1 resize-none bg-transparent! shadow-none! outline-none! ring-0! focus:ring-0! max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                  />
                )}
              </div>
              <p className="mt-1.5 text-center text-[11px] text-kumo-inactive">
                Llama 3.3 on Workers AI · your data lives in your own Durable
                Object
              </p>
            </form>
          </div>
        </main>

        {/* Side panel: static on large screens, a slide-over drawer on small ones. */}
        {panelOpen && (
          <button
            type="button"
            aria-label="Close tasks"
            className="fixed inset-0 z-40 bg-black/30 lg:hidden"
            onClick={() => setPanelOpen(false)}
          />
        )}
        <aside
          className={`fixed inset-y-0 right-0 z-50 w-full max-w-[380px] overflow-y-auto border-l border-kumo-line bg-kumo-elevated shadow-xl transition-transform lg:static lg:z-auto lg:translate-x-0 lg:shadow-none ${
            panelOpen ? "translate-x-0" : "translate-x-full"
          }`}
          aria-label="Tasks panel"
        >
          <div className="flex justify-end px-2 pt-2 lg:hidden">
            <Button
              variant="ghost"
              shape="square"
              aria-label="Close tasks"
              icon={<XIcon size={16} />}
              onClick={() => setPanelOpen(false)}
            />
          </div>
          <TaskPanel
            state={state}
            now={now}
            timeZone={timeZone}
            busyIds={busyIds}
            onAction={runTaskAction}
          />
        </aside>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset all your data?"
        description="This permanently deletes your tasks, reminder history, chat, preferences and everything Nudge has learned about you. Scheduled reminders are cancelled."
        confirmLabel="Delete everything"
        busy={resetting}
        onConfirm={() => void resetData()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center text-kumo-inactive">
            Loading…
          </div>
        }
      >
        <NudgeApp />
      </Suspense>
    </Toasty>
  );
}
