import { ipcMain } from "electron";
import type {
  BrowserViewLayout,
  InAppBrowserService,
} from "../services/in-app-browser-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

export const IN_APP_BROWSER_CHANNELS = {
  getState: "browserView:getState",
  connect: "browserView:connect",
  show: "browserView:show",
  setLayout: "browserView:setLayout",
  hide: "browserView:hide",
  createTab: "browserView:createTab",
  selectTab: "browserView:selectTab",
  closeTab: "browserView:closeTab",
  navigate: "browserView:navigate",
  goBack: "browserView:goBack",
  goForward: "browserView:goForward",
  reload: "browserView:reload",
  requestExtensionConnect: "browserView:requestExtensionConnect",
  state: "browserView:state",
} as const;

type RegisterInAppBrowserHandlersOptions = {
  service: InAppBrowserService;
  ensureAgentRouting?: () => Promise<void>;
  assertPrivilegedSender: (
    event: Electron.IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const requireObject = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required.`);
  }
  return value as Record<string, unknown>;
};

const requireString = (
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
) => {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`${label} is required.`);
  }
  return value;
};

const parseLayout = (value: unknown): BrowserViewLayout => {
  const payload = requireObject(value, "Browser layout");
  const parseBounds = (candidate: unknown, label: string) => {
    const bounds = requireObject(candidate, label);
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
        throw new Error(`${label}.${key} must be a finite number.`);
      }
    }
    return {
      x: bounds.x as number,
      y: bounds.y as number,
      width: bounds.width as number,
      height: bounds.height as number,
    };
  };
  return {
    pageBounds: parseBounds(payload.pageBounds, "pageBounds"),
    surfaceBounds: parseBounds(payload.surfaceBounds, "surfaceBounds"),
  };
};

export const registerInAppBrowserHandlers = (
  options: RegisterInAppBrowserHandlersOptions,
) => {
  const channels: string[] = [];
  const register = (
    channel: string,
    handler: (payload: unknown) => unknown | Promise<unknown>,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, payload) => {
      assertPrivilegedRequest(options, event, channel);
      return await handler(payload);
    });
  };

  register(IN_APP_BROWSER_CHANNELS.getState, () => options.service.getState());
  register(IN_APP_BROWSER_CHANNELS.connect, async (payload) => {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const state = await options.service.connect({
      ...(typeof record.browserType === "string"
        ? { browserType: record.browserType }
        : {}),
      ...(typeof record.profileId === "string"
        ? { profileId: record.profileId }
        : {}),
    });
    if (state.connection === "connected") {
      await options.ensureAgentRouting?.();
      return await options.service.getState();
    }
    return state;
  });
  register(IN_APP_BROWSER_CHANNELS.show, (payload) =>
    options.service.show(parseLayout(payload)),
  );
  register(IN_APP_BROWSER_CHANNELS.setLayout, (payload) =>
    options.service.setLayout(parseLayout(payload)),
  );
  register(IN_APP_BROWSER_CHANNELS.hide, () => options.service.hide());
  register(IN_APP_BROWSER_CHANNELS.createTab, (payload) => {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    return options.service.createTab({
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.selectTab, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.selectTab({
      tabId: requireString(record.tabId, "tabId"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.closeTab, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.closeTab({
      tabId: requireString(record.tabId, "tabId"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.navigate, (payload) => {
    const record = requireObject(payload, "Browser navigation");
    return options.service.navigate({
      tabId: requireString(record.tabId, "tabId"),
      url: requireString(record.url, "url"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.goBack, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goBack({
      tabId: requireString(record.tabId, "tabId"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.goForward, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goForward({
      tabId: requireString(record.tabId, "tabId"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.reload, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.reload({
      tabId: requireString(record.tabId, "tabId"),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.requestExtensionConnect, () =>
    options.service.requestExtensionConnect(),
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
