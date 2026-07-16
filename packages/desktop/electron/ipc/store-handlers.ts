import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "@stella/contracts";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

type StoreWebEmbedConfigPayload = {
  baseUrl: string;
  partition: string;
  preloadUrl: string;
};

type StoreHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  assertStoreWebSender?: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  getStoreAuthToken?: () => Promise<string | null>;
  getStoreWebEmbedConfig?: () => StoreWebEmbedConfigPayload | null;
  dispatchStoreWebLocalAction?: (
    action: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
};

export const registerStoreHandlers = (options: StoreHandlersOptions) => {
  const waitForRunner = (timeoutMs = 10_000) =>
    waitForConnectedRunner(options.getStellaHostRunner, {
      timeoutMs,
      unavailableMessage: "Store backend is unavailable.",
      onRunnerChanged: options.onStellaHostRunnerChanged,
    });
  const withStoreRunner = async <T>(
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
    action: (runner: Awaited<ReturnType<typeof waitForRunner>>) => Promise<T>,
  ) => {
    assertPrivilegedRequest(options, event, channel);
    return await action(await waitForRunner());
  };
  const assertStoreWebRequest = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => {
    if (!options.assertStoreWebSender?.(event, channel)) {
      throw new Error(`Blocked untrusted IPC call to ${channel}`);
    }
  };

  ipcMain.handle("storeWeb:getEmbedConfig", async (event) => {
    assertPrivilegedRequest(options, event, "storeWeb:getEmbedConfig");
    return options.getStoreWebEmbedConfig?.() ?? null;
  });

  ipcMain.handle("storeWeb:getAuthToken", async (event) => {
    assertStoreWebRequest(event, "storeWeb:getAuthToken");
    return (await options.getStoreAuthToken?.()) ?? null;
  });

  ipcMain.handle("storeWeb:openSignIn", async (event) => {
    assertStoreWebRequest(event, "storeWeb:openSignIn");
    if (!options.dispatchStoreWebLocalAction) {
      throw new Error("The local Store bridge is unavailable.");
    }
    return await options.dispatchStoreWebLocalAction({ type: "openSignIn" });
  });

  ipcMain.handle("storeWeb:showToast", async (event, payload: unknown) => {
    assertStoreWebRequest(event, "storeWeb:showToast");
    if (!options.dispatchStoreWebLocalAction) {
      throw new Error("The local Store bridge is unavailable.");
    }
    return await options.dispatchStoreWebLocalAction({
      type: "showToast",
      payload,
    });
  });

  ipcMain.handle(
    "store:listPackages",
    async (event) =>
      await withStoreRunner(
        event,
        "store:listPackages",
        async (runner) =>
          (await runner.listStorePackages()) satisfies StorePackageRecord[],
      ),
  );

  ipcMain.handle(
    "store:getPackage",
    async (event, payload: { packageId: string }) =>
      await withStoreRunner(
        event,
        "store:getPackage",
        async (runner) =>
          (await runner.getStorePackage(
            payload.packageId,
          )) satisfies StorePackageRecord | null,
      ),
  );

  ipcMain.handle(
    "store:listReleases",
    async (event, payload: { packageId: string }) =>
      await withStoreRunner(
        event,
        "store:listReleases",
        async (runner) =>
          (await runner.listStorePackageReleases(
            payload.packageId,
          )) satisfies StorePackageReleaseRecord[],
      ),
  );

  ipcMain.handle(
    "store:getRelease",
    async (event, payload: { packageId: string; releaseNumber: number }) =>
      await withStoreRunner(
        event,
        "store:getRelease",
        async (runner) =>
          (await runner.getStorePackageRelease(
            payload.packageId,
            payload.releaseNumber,
          )) satisfies StorePackageReleaseRecord | null,
      ),
  );
};
