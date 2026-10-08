import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { METHOD_NAMES, NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import {
  createRemoteDeviceSigner,
  HOST_DEVICE_SIGNING_METHOD,
} from "../../host/device-signing-method.js";
import type * as HostBus from "./host-bus.js";
import type { OpenSession } from "./sessions.js";

/**
 * The desktop chat on pi-durable (`@stella/agent/host/desktop-chats`), one
 * per worker session, loaded on its first request: conversations that run on
 * it never touch the runner's orchestrator loop. Watched conversations'
 * events go to the app as `piChat.events` notifications.
 */
type DesktopChats = import("@stella/agent/host/desktop-chats").DesktopChats;

const chatsBySession = new WeakMap<OpenSession, Promise<DesktopChats>>();

export const piChatsFor = (
  session: OpenSession,
  hostBus: HostBus.Interface,
): Promise<DesktopChats> => {
  let chats = chatsBySession.get(session);
  if (chats) return chats;
  let signer: ReturnType<typeof createRemoteDeviceSigner> | undefined;
  chats = import("@stella/agent/host/desktop-chats").then(({ desktopChats }) =>
    desktopChats({
      dataDir: session.config.get().stellaDataDirPath,
      deviceId: session.config.deviceId,
      workspace: os.homedir(),
      siteAuth: () => session.runnerCell.get()?.getStellaSiteAuth() ?? null,
      refreshAuthToken: async () => {
        const result = (await hostBus.request(
          METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
          { source: "stella_provider" },
          { retryOnDisconnect: true },
        )) as { authenticated?: boolean; token?: string } | null;
        return result?.authenticated ? (result.token ?? null) : null;
      },
      getDeviceSigner: () => {
        const pending =
          signer ??
          createRemoteDeviceSigner((input) =>
            hostBus.request(HOST_DEVICE_SIGNING_METHOD, { input }, { retryOnDisconnect: true }),
          );
        signer = pending;
        void pending.catch(() => {
          if (signer === pending) signer = undefined;
        });
        return pending;
      },
      emit: (payload) => hostBus.notify(NOTIFICATION_NAMES.PI_CHAT_EVENTS, payload),
      report: (error) => console.error("[pi-chat]", error),
    }),
  );
  void chats.catch(() => chatsBySession.delete(session));
  chatsBySession.set(session, chats);
  return chats;
};

/**
 * Resume the conversations a previous runtime process left with pi work in
 * flight (`<data dir>/agent/active.json`). Loads the pi chat only when there
 * are any.
 */
export const resumePiChats = async (
  session: OpenSession,
  hostBus: HostBus.Interface,
): Promise<void> => {
  const file = path.join(session.config.get().stellaDataDirPath, "agent", "active.json");
  if (!existsSync(file)) return;
  try {
    const ids = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(ids) || ids.length === 0) return;
  } catch {
    return;
  }
  await (await piChatsFor(session, hostBus)).resumeActive();
};
