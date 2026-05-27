import { contextBridge, ipcRenderer } from "electron";

const api = {
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke("app:version"),
  onOpenClawMessage: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) =>
      callback(message);
    ipcRenderer.on("openclaw:message", handler);
    return () => {
      ipcRenderer.removeListener("openclaw:message", handler);
    };
  },
} as const;

export type ArmorClawAPI = typeof api;

contextBridge.exposeInMainWorld("armorClaw", api);
