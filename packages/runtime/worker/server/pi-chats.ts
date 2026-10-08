import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PiChatRequest } from "@stella/contracts/pi-chat";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type RuntimeChatPayload,
} from "@stella/contracts/protocol";
import {
  getModelOverride,
  getReasoningEffort,
  loadLocalPreferences,
} from "../../kernel/preferences/local-preferences.js";
import { prepareChatInput } from "./chat-input.js";
import { piUserContent } from "./pi-chat-input.js";
import { cloudAgentsFor } from "./pi-cloud-agents.js";
import { cloudJournalFor } from "./pi-journal.js";
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


/** Whether this desktop runs its chat on pi-durable (launched with `STELLA_AGENT_RUNTIME=pi`). */
export const piRuntimeEnabled = (): boolean => process.env.STELLA_AGENT_RUNTIME === "pi";

const chatsBySession = new WeakMap<OpenSession, Promise<DesktopChats>>();
/** The same chats once loaded, for synchronous checks. */
const loadedBySession = new WeakMap<OpenSession, DesktopChats>();

/** Whether pi has work in flight in this session: the worker stays up for it. */
export const piChatsBusy = (session: OpenSession): boolean => loadedBySession.get(session)?.busy() ?? false;

/** Close the session's pi chats (their harnesses, mirrors and environments), if they were opened. */
export const closePiChats = async (session: OpenSession): Promise<void> => {
  const chats = chatsBySession.get(session);
  chatsBySession.delete(session);
  loadedBySession.delete(session);
  await (await chats?.catch(() => undefined))?.close();
};

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
      memoryEnabled: () => loadLocalPreferences(session.config.get().stellaDataDirPath).memoryEnabled,
      stellaModel: () => getModelOverride(session.config.get().stellaDataDirPath, "orchestrator"),
      thinkingLevel: () => {
        const effort = getReasoningEffort(session.config.get().stellaDataDirPath, "orchestrator");
        return effort === "default" ? "off" : effort;
      },
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
      tools: (conversationId) => ({
        specs: (role) => session.runnerCell.get()?.piTools.specs(role) ?? [],
        run: async (call, context) => {
          const runner = session.runnerCell.get();
          if (!runner) throw new Error("Stella's runtime is restarting; try again.");
          const result = await runner.piTools.run({
            agentType: call.role,
            name: call.name,
            callId: call.callId,
            args: call.args,
            conversationId,
            ...(call.threadId ? { agentId: call.threadId } : {}),
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          });
          return {
            content: result.content,
            details: result.details,
            ...(result.isError ? { isError: true } : {}),
          };
        },
      }),
      journal: (conversationId) => cloudJournalFor(session, conversationId),
      cloudAgents: (conversationId) => cloudAgentsFor(session, conversationId),
      // The loop's notice for a finished task, from pi's agents.
      agentReported: (agent) => {
        void hostBus
          .request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
            title: agent.description.trim() || "Task complete",
            body: "",
            sound: "Glass",
          })
          .catch((error) => console.debug("[pi-chat] agent notification failed", error));
      },
      emit: (payload) => hostBus.notify(NOTIFICATION_NAMES.PI_CHAT_EVENTS, payload),
      report: (error) => console.error("[pi-chat]", error),
    }),
  );
  void chats.then(
    (loaded) => {
      if (chatsBySession.get(session) === chats) loadedBySession.set(session, loaded);
    },
    () => chatsBySession.delete(session),
  );
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

/**
 * A pi chat request from the app. A composer send arrives as the composer
 * sent it and is prepared here as the agent loops prepare it (images sized
 * and spilled, files saved, chat context), then submitted as one user input.
 */
export const piChatRequest = async (
  session: OpenSession,
  hostBus: HostBus.Interface,
  request: PiChatRequest,
): Promise<unknown> => {
  const chats = await piChatsFor(session, hostBus);
  if (request.op !== "submit" || !request.send) return await chats.request(request);
  const payload: RuntimeChatPayload = {
    ...(request.send as Omit<RuntimeChatPayload, "conversationId" | "userPrompt">),
    conversationId: request.conversationId,
    userPrompt: request.text,
    userMessageEventId: request.requestId,
  };
  const prepared = await prepareChatInput(payload, {
    stellaDataDirPath: session.config.get().stellaDataDirPath,
    resolveImageTarget: async () =>
      (await session.runnerCell.get()?.resolveImageTarget(payload.agentType)) ?? undefined,
  });
  return await chats.submit(request.conversationId, request.requestId, piUserContent(payload, prepared), {
    ...(payload.locale ? { locale: payload.locale } : {}),
  });
};
