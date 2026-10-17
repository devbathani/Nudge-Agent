import { useCallback, useState } from "react";

const ASKED_KEY = "nudge:notifications-asked";

type Permission = NotificationPermission | "unsupported";

function isSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function readAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Browser Notification API wrapper. Permission is requested at most once
 * automatically (on the user's first message, which is a user gesture);
 * after that only the explicit bell button in the header asks again.
 */
export function useNotifications() {
  const [permission, setPermission] = useState<Permission>(() =>
    isSupported() ? Notification.permission : "unsupported"
  );

  const request = useCallback(async () => {
    if (!isSupported()) return;
    try {
      localStorage.setItem(ASKED_KEY, "1");
    } catch {
      // ignore
    }
    if (Notification.permission !== "default") {
      setPermission(Notification.permission);
      return;
    }
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(Notification.permission);
    }
  }, []);

  const askOnce = useCallback(() => {
    if (
      isSupported() &&
      Notification.permission === "default" &&
      !readAsked()
    ) {
      void request();
    }
  }, [request]);

  const notify = useCallback((title: string, body: string, tag?: string) => {
    if (!isSupported() || Notification.permission !== "granted") return;
    try {
      const n = new Notification(title, { body, tag, icon: "/favicon.ico" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Some mobile browsers only allow notifications from a service worker.
    }
  }, []);

  return { permission, request, askOnce, notify };
}
