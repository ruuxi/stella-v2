import { ipcMain } from "electron";
import { z } from "zod";
import type {
  BrowserViewLayout,
  InAppBrowserService,
} from "../services/in-app-browser-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

export const IN_APP_BROWSER_CHANNELS = {
  getState: "browserView:getState",
  connect: "browserView:connect",
  show: "browserView:show",
  setVisibleOwner: "browserView:setVisibleOwner",
  setOwnerScope: "browserView:setOwnerScope",
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

const recordSchema = z.record(z.string(), z.unknown());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  recordSchema.safeParse(value).success;

const requireObject = (value: unknown, label: string) => {
  if (!isRecord(value)) {
    throw new Error(`${label} is required.`);
  }
  return value;
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

const optionalStringField = z.string().optional().catch(undefined);

const connectPayloadSchema = z
  .object({
    browserType: optionalStringField,
    profileId: optionalStringField,
  })
  .catch({});

const createTabPayloadSchema = z
  .object({
    url: optionalStringField,
    ownerId: optionalStringField,
    activate: z.boolean().optional().catch(undefined),
  })
  .catch({});

const ownerScopePayloadSchema = z
  .object({ ownerId: optionalStringField })
  .catch({});

const ownerField = (record: Record<string, unknown>) =>
  record.ownerId === undefined
    ? {}
    : { ownerId: requireString(record.ownerId, "ownerId") };

const boundsSchema = z.looseObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const parseLayout = (value: unknown): BrowserViewLayout => {
  const payload = requireObject(value, "Browser layout");
  const parseBounds = (candidate: unknown, label: string) => {
    const parsed = boundsSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (!issue || issue.path.length === 0) {
        throw new Error(`${label} is required.`);
      }
      throw new Error(
        `${label}.${String(issue.path[0])} must be a finite number.`,
      );
    }
    const { x, y, width, height } = parsed.data;
    return { x, y, width, height };
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
    const record = connectPayloadSchema.parse(payload);
    const state = await options.service.connect({
      ...(record.browserType !== undefined
        ? { browserType: record.browserType }
        : {}),
      ...(record.profileId !== undefined
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
  register(IN_APP_BROWSER_CHANNELS.setVisibleOwner, (payload) => {
    const record = requireObject(payload, "Browser owner");
    return options.service.setVisibleOwner(
      requireString(record.ownerId, "ownerId"),
    );
  });
  register(IN_APP_BROWSER_CHANNELS.setOwnerScope, (payload) => {
    const record = ownerScopePayloadSchema.parse(payload);
    return options.service.setOwnerScope(record.ownerId);
  });
  register(IN_APP_BROWSER_CHANNELS.setLayout, (payload) =>
    options.service.setLayout(parseLayout(payload)),
  );
  register(IN_APP_BROWSER_CHANNELS.hide, () => options.service.hide());
  register(IN_APP_BROWSER_CHANNELS.createTab, async (payload) => {
    const record = createTabPayloadSchema.parse(payload);
    await options.service.createTab({
      ...(record.url !== undefined ? { url: record.url } : {}),
      ...(record.ownerId !== undefined ? { ownerId: record.ownerId } : {}),
      ...(record.activate !== undefined ? { activate: record.activate } : {}),
    });
    return await options.service.getState();
  });
  register(IN_APP_BROWSER_CHANNELS.selectTab, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.selectTab({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
      ...(record.activate === true ? { activate: true } : {}),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.closeTab, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.closeTab({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.navigate, (payload) => {
    const record = requireObject(payload, "Browser navigation");
    return options.service.navigate({
      tabId: requireString(record.tabId, "tabId"),
      url: requireString(record.url, "url"),
      ...ownerField(record),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.goBack, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goBack({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.goForward, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goForward({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.reload, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.reload({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IN_APP_BROWSER_CHANNELS.requestExtensionConnect, () =>
    options.service.requestExtensionConnect(),
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
