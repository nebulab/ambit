import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS } from "./ipc.js";
import type { DesktopApi } from "./ipc.js";

const api: DesktopApi = {
  inspectPersonal: () => ipcRenderer.invoke(DESKTOP_CHANNELS.inspectPersonal),
  revealPersonal: () => ipcRenderer.invoke(DESKTOP_CHANNELS.revealPersonal),
};

contextBridge.exposeInMainWorld("ambit", api);
