import { create } from "zustand";

export interface Notification {
  id: string;
  type: "info" | "warning" | "success" | "error";
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

  add: (n: Omit<Notification, "id" | "createdAt" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  togglePanel: () => void;
}

let counter = 0;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,

  add: (n) => {
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
}));
