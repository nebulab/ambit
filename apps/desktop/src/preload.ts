import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS } from "./ipc.js";
import type { DesktopApi } from "./ipc.js";

const api: DesktopApi = {
  inspectPersonal: () => ipcRenderer.invoke(DESKTOP_CHANNELS.inspectPersonal),
  browseLocalSkills: () => ipcRenderer.invoke(DESKTOP_CHANNELS.browseLocalSkills),
  readLocalSkill: (catalog, name) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.readLocalSkill, catalog, name),
  openExternal: (url) => ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
  revealPersonal: () => ipcRenderer.invoke(DESKTOP_CHANNELS.revealPersonal),
  stageTool: (tool) => ipcRenderer.invoke(DESKTOP_CHANNELS.stageTool, tool),
  chooseLocalCatalog: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseLocalCatalog),
  stageLocalCatalog: (folder, name) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.stageLocalCatalog, folder, name),
  stageSkill: (catalog, name) => ipcRenderer.invoke(DESKTOP_CHANNELS.stageSkill, catalog, name),
  reviewEmpty: () => ipcRenderer.invoke(DESKTOP_CHANNELS.reviewEmpty),
  applyEmpty: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.applyEmpty, id),
  cancelApply: () => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelApply),
  onApplyProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      phase: "checking" | "writing" | "installing",
    ) => callback(phase);

    ipcRenderer.on(DESKTOP_CHANNELS.applyProgress, listener);

    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.applyProgress, listener);
  },
  retryEmpty: () => ipcRenderer.invoke(DESKTOP_CHANNELS.retryEmpty),
  cancelPendingAction: () => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelPendingAction),
  onRequestReview: (callback) => {
    const listener = () => callback();

    ipcRenderer.on(DESKTOP_CHANNELS.requestReview, listener);

    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.requestReview, listener);
  },
};

contextBridge.exposeInMainWorld("ambit", api);
