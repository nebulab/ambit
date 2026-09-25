import { app, BrowserWindow, ipcMain, shell } from "electron";
import os from "node:os";
import path from "node:path";

import { DESKTOP_CHANNELS } from "./ipc.js";
import { inspectPersonalSetup } from "./setup.js";

let mainWindow: BrowserWindow | null = null;

function validateCall(event: Electron.IpcMainInvokeEvent, args: readonly unknown[]): void {
  if (event.sender !== mainWindow?.webContents || args.length !== 0) {
    throw new Error("Invalid desktop request");
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    title: "Ambit",
    webPreferences: {
      preload: path.join(app.getAppPath(), "out", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  void mainWindow.loadFile(path.join(app.getAppPath(), "out", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const home = os.homedir();

ipcMain.handle(DESKTOP_CHANNELS.inspectPersonal, async (event, ...args: unknown[]) => {
  validateCall(event, args);
  return inspectPersonalSetup(home);
});

ipcMain.handle(DESKTOP_CHANNELS.revealPersonal, async (event, ...args: unknown[]) => {
  validateCall(event, args);
  const setup = await inspectPersonalSetup(home);
  shell.showItemInFolder(setup.status === "error" ? setup.configPath : setup.root);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
