import { useNotificationStore, type Notification } from "../stores/notification-store";

export function NotificationBell(): React.JSX.Element {
  const { unreadCount, togglePanel } = useNotificationStore();

  return (
    <button
      className="relative rounded-md p-1.5 text-[#8b8b92] hover:text-white"
      onClick={togglePanel}
      title="Notifications"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.5A3.5 3.5 0 0 0 4.5 5v2.947c0 .346-.102.685-.294.97l-1.703 2.556a.25.25 0 0 0 .208.388h10.578a.25.25 0 0 0 .208-.388l-1.703-2.556a1.75 1.75 0 0 1-.294-.97V5A3.5 3.5 0 0 0 8 1.5ZM6.5 13a1.5 1.5 0 0 0 3 0h-3Z" />
      </svg>
      {unreadCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#d97706] px-1 text-[10px] font-bold text-white">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export function NotificationPanel(): React.JSX.Element | null {
  const { notifications, panelOpen, togglePanel, markRead, markAllRead, dismiss, clearAll } =
    useNotificationStore();

  if (!panelOpen) return null;

  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-[#26262c] bg-[#16161a] shadow-xl">
      <div className="flex items-center justify-between border-b border-[#26262c] px-3 py-2">
        <h3 className="text-xs font-medium text-white">Notifications</h3>
        <div className="flex gap-2">
          {notifications.some((n) => !n.read) && (
            <button
              className="text-[10px] text-[#8b8b92] hover:text-white"
              onClick={markAllRead}
            >
              Mark all read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              className="text-[10px] text-[#8b8b92] hover:text-white"
              onClick={clearAll}
            >
              Clear
            </button>
          )}
          <button
            className="text-[10px] text-[#8b8b92] hover:text-white"
            onClick={togglePanel}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[#8b8b92]">
            No notifications
          </div>
        ) : (
          notifications.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              onRead={() => markRead(n.id)}
              onDismiss={() => dismiss(n.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  onRead,
  onDismiss,
}: {
  notification: Notification;
  onRead: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const typeIcon = {
    info: "ℹ️",
    warning: "⚠️",
    success: "✅",
    error: "❌",
  }[notification.type];

  const age = formatAge(notification.createdAt);

  return (
    <div
      className={`flex gap-2 border-b border-[#26262c] px-3 py-2 last:border-0 ${
        notification.read ? "opacity-60" : ""
      }`}
      onClick={onRead}
    >
      <span className="mt-0.5 text-xs">{typeIcon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1">
          <p className="text-xs font-medium text-white">{notification.title}</p>
          <button
            className="shrink-0 text-[10px] text-[#8b8b92] hover:text-white"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          >
            ✕
          </button>
        </div>
        {notification.body && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-[#8b8b92]">
            {notification.body}
          </p>
        )}
        <p className="mt-1 text-[10px] text-[#8b8b92]">{age}</p>
      </div>
      {!notification.read && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#d97706]" />
      )}
    </div>
  );
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
