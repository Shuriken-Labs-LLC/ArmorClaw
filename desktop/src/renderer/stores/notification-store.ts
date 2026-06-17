import { create } from "zustand";

export type NotificationEventType =
  | "commitment.fired"
  | "commitment.missed"
  | "commitment.failed"
  | "memory.proposed"
  | "integration.error"
  | "task.completed";

export interface NotificationPrefs {
  inApp: Record<NotificationEventType, boolean>;
}

const DEFAULT_PREFS: NotificationPrefs = {
  inApp: {
    "commitment.fired": true,
    "commitment.missed": true,
    "commitment.failed": true,
    "memory.proposed": true,
    "integration.error": true,
    "task.completed": true,
  },
};

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem("armorclaw:notification-prefs");
    if (raw) return JSON.parse(raw) as NotificationPrefs;
  } catch { /* use defaults */ }
  return DEFAULT_PREFS;
}

function savePrefs(prefs: NotificationPrefs): void {
  localStorage.setItem("armorclaw:notification-prefs", JSON.stringify(prefs));
}

export interface Notification {
  id: string;
  type: "info" | "warning" | "success" | "error";
  eventType?: NotificationEventType;
  title: string;
  body?: string;
  commitmentId?: string;
  createdAt: number;
  read: boolean;
}

interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  panelOpen: boolean;
  prefs: NotificationPrefs;

  add: (n: Omit<Notification, "id" | "createdAt" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  togglePanel: () => void;
  setEventPref: (eventType: NotificationEventType, enabled: boolean) => void;
}

let counter = 0;

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,
  prefs: loadPrefs(),

  add: (n) => {
    if (n.eventType && !get().prefs.inApp[n.eventType]) return;
    const id = `notif_${Date.now()}_${++counter}`;
    const notification: Notification = { ...n, id, createdAt: Date.now(), read: false };
    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 100),
      unreadCount: s.unreadCount + 1,
    }));
  },

  markRead: (id) =>
    set((s) => {
      const idx = s.notifications.findIndex((n) => n.id === id);
      if (idx === -1 || s.notifications[idx]!.read) return s;
      const updated = [...s.notifications];
      updated[idx] = { ...updated[idx]!, read: true };
      return { notifications: updated, unreadCount: Math.max(0, s.unreadCount - 1) };
    }),

  markAllRead: () =>
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    })),

  dismiss: (id) =>
    set((s) => {
      const n = s.notifications.find((x) => x.id === id);
      return {
        notifications: s.notifications.filter((x) => x.id !== id),
        unreadCount: n && !n.read ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      };
    }),

  clearAll: () => set({ notifications: [], unreadCount: 0 }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setEventPref: (eventType, enabled) => {
    set((s) => {
      const prefs: NotificationPrefs = {
        ...s.prefs,
        inApp: { ...s.prefs.inApp, [eventType]: enabled },
      };
      savePrefs(prefs);
      return { prefs };
    });
  },
}));
