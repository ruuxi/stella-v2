import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

const WEBSITE_VIEW_THEME_CHANNEL = "stellaDesktopWebsite:themeChanged";

type WebsiteEmbeddedTheme = {
  mode?: "light" | "dark";
  foreground?: string;
  foregroundWeak?: string;
  border?: string;
  primary?: string;
  surface?: string;
  background?: string;
};

contextBridge.exposeInMainWorld("stellaDesktopStore", {
  getAuthToken: () => invoke<string | null>("storeWeb:getAuthToken"),
  onThemeChanged: (callback: (theme: WebsiteEmbeddedTheme) => void) => {
    const listener = (_event: unknown, theme: WebsiteEmbeddedTheme) => {
      callback(theme);
    };
    ipcRenderer.on(WEBSITE_VIEW_THEME_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(WEBSITE_VIEW_THEME_CHANNEL, listener);
    };
  },
  openSignIn: () => invoke("storeWeb:openSignIn"),
  showToast: (payload: {
    title?: string;
    description?: string;
    variant?: "default" | "success" | "error" | "loading";
    duration?: number;
  }) => invoke("storeWeb:showToast", payload),
});
