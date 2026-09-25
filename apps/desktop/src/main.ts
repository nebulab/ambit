import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { DESKTOP_CHANNELS } from "./ipc.js";
import { inspectPersonalSetup } from "./setup.js";
import {
  SETUP_TOOLS,
  applyEmptySetup,
  inspectLocalCatalog,
  previewEmptySetup,
  previewExistingLocalCatalog,
  retryEmptySetup,
} from "../../../src/project/empty-setup.js";
import type {
  EmptySetupReview,
  LocalCatalogDraft,
  SetupTool,
} from "../../../src/project/empty-setup.js";
import { AmbitError } from "../../../src/errors.js";

let mainWindow: BrowserWindow | null = null;
let draftTool: SetupTool | null = null;
let draftCatalog: LocalCatalogDraft | null = null;
let review: { readonly id: string; readonly value: EmptySetupReview } | null = null;
let retryReview: EmptySetupReview | null = null;
let pendingAction: "close" | "quit" | null = null;
let applying = false;
let allowClose = false;

function validateCall(
  event: Electron.IpcMainInvokeEvent,
  args: readonly unknown[],
  count = 0,
): void {
  if (event.sender !== mainWindow?.webContents || args.length !== count) {
    throw new Error("Invalid desktop request");
  }
}

function desktopError(error: unknown): never {
  if (error instanceof AmbitError) {
    throw new Error(error.format());
  }

  throw error;
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
  mainWindow.on("close", (event) => {
    if (allowClose) {
      return;
    }

    if (applying) {
      event.preventDefault();

      return;
    }

    if (draftTool === null && draftCatalog === null) {
      return;
    }

    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: "question",
      message: "Apply changes to Personal setup?",
      buttons: ["Apply", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });

    if (choice === 1) {
      draftTool = null;
      draftCatalog = null;
      review = null;
      allowClose = true;
      mainWindow?.close();
    } else if (choice === 0) {
      pendingAction = "close";
      mainWindow?.webContents.send(DESKTOP_CHANNELS.requestReview);
    }
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

ipcMain.handle(DESKTOP_CHANNELS.stageTool, (event, ...args: unknown[]) => {
  validateCall(event, args, 1);
  if (applying) {
    throw new Error("Wait for installation to finish");
  }

  const tool = args[0];

  if (tool !== null && (typeof tool !== "string" || !SETUP_TOOLS.includes(tool as SetupTool))) {
    throw new Error("Invalid agent tool");
  }

  draftTool = tool as SetupTool | null;
  if (tool === null) {
    draftCatalog = null;
  }

  review = null;
});

ipcMain.handle(DESKTOP_CHANNELS.chooseLocalCatalog, async (event, ...args: unknown[]) => {
  validateCall(event, args);
  if (applying || mainWindow === null) {
    throw new Error("Wait for installation to finish");
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a local catalog",
    properties: ["openDirectory"],
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle(DESKTOP_CHANNELS.stageLocalCatalog, async (event, ...args: unknown[]) => {
  validateCall(event, args, 2);
  if (applying) {
    throw new Error("Wait for installation to finish");
  }

  const [folder, name] = args;

  if (
    (folder !== null && (typeof folder !== "string" || folder.length === 0)) ||
    typeof name !== "string"
  ) {
    throw new Error("Invalid local catalog");
  }

  if (folder === null) {
    draftCatalog = null;
    review = null;

    return null;
  }

  const loaded = await inspectLocalCatalog(folder, name).catch(desktopError);

  draftCatalog = loaded;
  review = null;

  return loaded;
});

ipcMain.handle(DESKTOP_CHANNELS.reviewEmpty, async (event, ...args: unknown[]) => {
  validateCall(event, args);
  if (applying) {
    throw new Error("Wait for installation to finish");
  }

  if (draftTool === null && draftCatalog === null) {
    throw new Error("Choose an agent tool or local catalog first");
  }

  const value = await (
    draftTool === null
      ? previewExistingLocalCatalog(home, draftCatalog!)
      : previewEmptySetup(home, draftTool, draftCatalog ?? undefined)
  ).catch(desktopError);

  review = { id: randomUUID(), value };

  return { id: review.id, tool: value.tool, catalog: draftCatalog };
});

ipcMain.handle(DESKTOP_CHANNELS.applyEmpty, async (event, ...args: unknown[]) => {
  validateCall(event, args, 1);
  if (typeof args[0] !== "string" || review?.id !== args[0]) {
    throw new Error("Review these changes again before applying");
  }

  const selected = review.value;

  review = null;
  applying = true;
  try {
    const result = await applyEmptySetup(selected).catch(desktopError);

    draftTool = null;
    draftCatalog = null;
    retryReview = result.status === "partial" ? selected : null;
    if (result.status === "installed" && pendingAction !== null) {
      const action = pendingAction;

      pendingAction = null;
      allowClose = true;
      if (action === "quit") {
        app.quit();
      } else {
        mainWindow?.close();
      }
    }

    return result;
  } finally {
    applying = false;
  }
});

ipcMain.handle(DESKTOP_CHANNELS.retryEmpty, async (event, ...args: unknown[]) => {
  validateCall(event, args);
  if (retryReview === null) {
    throw new Error("There is no installation to retry");
  }

  applying = true;
  try {
    await retryEmptySetup(retryReview).catch(desktopError);
    retryReview = null;
  } finally {
    applying = false;
  }
});

ipcMain.handle(DESKTOP_CHANNELS.cancelPendingAction, (event, ...args: unknown[]) => {
  validateCall(event, args);
  pendingAction = null;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (allowClose || (draftTool === null && draftCatalog === null) || mainWindow === null) {
    return;
  }

  event.preventDefault();
  mainWindow.close();
});
