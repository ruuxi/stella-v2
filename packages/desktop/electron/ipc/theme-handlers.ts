import { promises as fs } from "node:fs";
import path from "node:path";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC_THEME_LIST_INSTALLED } from "@stella/contracts/desktop/ipc-channels";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type ThemeHandlersOptions = {
  stellaDataDirPath: string;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const listInstalledThemes = async (stellaDataDirPath: string) => {
  const themesDir = path.join(stellaDataDirPath, "themes");
  try {
    const files = await fs.readdir(themesDir);
    const themes: unknown[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(themesDir, file), "utf8");
        const theme = JSON.parse(raw) as Record<string, unknown>;
        if (theme.id && theme.name && theme.light && theme.dark) {
          themes.push(theme);
        }
      } catch {
        // Ignore invalid or unreadable theme files.
      }
    }
    return themes;
  } catch {
    return [];
  }
};

export const registerThemeHandlers = (options: ThemeHandlersOptions) => {
  ipcMain.handle(IPC_THEME_LIST_INSTALLED, async (event) => {
    assertPrivilegedRequest(options, event, IPC_THEME_LIST_INSTALLED);
    return await listInstalledThemes(options.stellaDataDirPath);
  });
};
