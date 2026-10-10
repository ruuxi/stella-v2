import { ipcMain } from "electron";
import { z } from "zod";
import type { BrowserViewLayout } from "@stella/contracts/desktop/browser-view";
import type {
  IpcInvokeChannel,
  IpcInvokeResult,
} from "@stella/contracts/desktop/ipc-contract";
import {
  IPC_BROWSER_VIEW_CLOSE_TAB,
  IPC_BROWSER_VIEW_CONNECT,
  IPC_BROWSER_VIEW_CREATE_TAB,
  IPC_BROWSER_VIEW_GET_STATE,
  IPC_BROWSER_VIEW_GO_BACK,
  IPC_BROWSER_VIEW_GO_FORWARD,
  IPC_BROWSER_VIEW_HIDE,
  IPC_BROWSER_VIEW_NAVIGATE,
  IPC_BROWSER_VIEW_RELOAD,
  IPC_BROWSER_VIEW_REQUEST_EXTENSION_CONNECT,
  IPC_BROWSER_VIEW_SELECT_TAB,
  IPC_BROWSER_VIEW_SET_LAYOUT,
  IPC_BROWSER_VIEW_SET_OWNER_SCOPE,
  IPC_BROWSER_VIEW_SET_VISIBLE_OWNER,
  IPC_BROWSER_VIEW_SHOW,
} from "@stella/contracts/desktop/ipc-channels";
import type { InAppBrowserService } from "../services/in-app-browser-service.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";
import { handleIpc } from "./typed-ipc.js";

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
  const channels: IpcInvokeChannel[] = [];
  const register = <C extends IpcInvokeChannel>(
    channel: C,
    handler: (
      payload: unknown,
    ) => IpcInvokeResult<C> | Promise<IpcInvokeResult<C>>,
  ) => {
    channels.push(channel);
    handleIpc(channel, async (event, ...args) => {
      assertPrivilegedRequest(options, event, channel);
      return await handler(args[0]);
    });
  };

  register(IPC_BROWSER_VIEW_GET_STATE, () => options.service.getState());
  register(IPC_BROWSER_VIEW_CONNECT, async (payload) => {
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
  register(IPC_BROWSER_VIEW_SHOW, (payload) =>
    options.service.show(parseLayout(payload)),
  );
  register(IPC_BROWSER_VIEW_SET_VISIBLE_OWNER, (payload) => {
    const record = requireObject(payload, "Browser owner");
    return options.service.setVisibleOwner(
      requireString(record.ownerId, "ownerId"),
    );
  });
  register(IPC_BROWSER_VIEW_SET_OWNER_SCOPE, (payload) => {
    const record = ownerScopePayloadSchema.parse(payload);
    return options.service.setOwnerScope(record.ownerId);
  });
  register(IPC_BROWSER_VIEW_SET_LAYOUT, (payload) =>
    options.service.setLayout(parseLayout(payload)),
  );
  register(IPC_BROWSER_VIEW_HIDE, () => options.service.hide());
  register(IPC_BROWSER_VIEW_CREATE_TAB, async (payload) => {
    const record = createTabPayloadSchema.parse(payload);
    await options.service.createTab({
      ...(record.url !== undefined ? { url: record.url } : {}),
      ...(record.ownerId !== undefined ? { ownerId: record.ownerId } : {}),
      ...(record.activate !== undefined ? { activate: record.activate } : {}),
    });
    return await options.service.getState();
  });
  register(IPC_BROWSER_VIEW_SELECT_TAB, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.selectTab({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
      ...(record.activate === true ? { activate: true } : {}),
    });
  });
  register(IPC_BROWSER_VIEW_CLOSE_TAB, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.closeTab({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IPC_BROWSER_VIEW_NAVIGATE, (payload) => {
    const record = requireObject(payload, "Browser navigation");
    return options.service.navigate({
      tabId: requireString(record.tabId, "tabId"),
      url: requireString(record.url, "url"),
      ...ownerField(record),
    });
  });
  register(IPC_BROWSER_VIEW_GO_BACK, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goBack({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IPC_BROWSER_VIEW_GO_FORWARD, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.goForward({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IPC_BROWSER_VIEW_RELOAD, (payload) => {
    const record = requireObject(payload, "Browser tab");
    return options.service.reload({
      tabId: requireString(record.tabId, "tabId"),
      ...ownerField(record),
    });
  });
  register(IPC_BROWSER_VIEW_REQUEST_EXTENSION_CONNECT, () =>
    options.service.requestExtensionConnect(),
  );

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
};
