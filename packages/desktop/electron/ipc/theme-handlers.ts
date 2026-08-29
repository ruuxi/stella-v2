import { promises as fs } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_THEME_LIST_INSTALLED } from "@stella/contracts/desktop/ipc-channels";

type Theme = {
  id?: unknown;
  name?: unknown;
  light?: unknown;
  dark?: unknown;
};

const listInstalledThemes = async (stellaDataDir: string) => {
  const themesDir = path.join(stellaDataDir, "themes");
  try {
    const files = await fs.readdir(themesDir);
    const themes: Theme[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(themesDir, file), "utf-8");
        const theme = JSON.parse(raw) as Theme;
        // A theme file missing any of these renders as a broken swatch in the
        // picker, so drop it rather than surfacing it half-populated.
        if (theme.id && theme.name && theme.light && theme.dark) {
          themes.push(theme);
        }
      } catch {
        // One malformed theme file must not hide the user's other themes.
      }
    }
    return themes;
  } catch {
    return [];
  }
};

export const registerThemeHandlers = (options: {
  getStellaDataDir: () => string | null;
}) => {
  ipcMain.handle(IPC_THEME_LIST_INSTALLED, async () => {
    const stellaDataDir = options.getStellaDataDir();
    return stellaDataDir ? await listInstalledThemes(stellaDataDir) : [];
  });
};
