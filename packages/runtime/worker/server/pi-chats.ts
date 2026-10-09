import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  desktopPiChatEnabled,
  desktopPiRuntime,
  type PiChatRequest,
  type PiChatUsageRequest,
} from "@stella/contracts/pi-chat";
import {
  METHOD_NAMES,
  NOTIFICATION_NAMES,
  type RuntimeChatPayload,
} from "@stella/contracts/protocol";
import {
  getAgentRuntimeEngine,
  getModelOverride,
  getReasoningEffort,
  loadLocalPreferences,
} from "../../kernel/preferences/local-preferences.js";
import {
  getAccessibleLocalLlmApiKey,
  getAccessibleLocalLlmOAuthApiKey,
} from "../../kernel/storage/local-llm-credential-access.js";
import {
  getPlacementCancellation,
  persistPlacementCancellation,
  type PlacementLocalExecutionKind,
} from "../../kernel/runner/execution-placement-local-ownership.js";
import { prepareStoredLocalChatPayload } from "../../kernel/storage/local-chat-payload.js";
import { resolveOrchestratorThreadKey } from "../../kernel/thread-runtime.js";
import { prepareChatInput } from "./chat-input.js";
import { piUserContent } from "./pi-chat-input.js";
import { cloudAgentsFor } from "./pi-cloud-agents.js";
import { cloudJournalFor } from "./pi-journal.js";
import { piModelUsage } from "./pi-usage.js";
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


/** Whether this desktop runs pi-durable: by default, unless launched with `STELLA_AGENT_RUNTIME=loop`. */
export const piRuntimeEnabled = (): boolean => desktopPiRuntime(process.env.STELLA_AGENT_RUNTIME);

/**
 * Whether a conversation's own turns go to pi: the runtime runs pi and the
 * user's engine is not Claude Code, whose turns keep their own path.
 */
export const piChatRouted = (session: OpenSession): boolean =>
  desktopPiChatEnabled(
    process.env.STELLA_AGENT_RUNTIME,
    getAgentRuntimeEngine(session.config.get().stellaDataDirPath),
  );

/** What pi wrote into a conversation's chat log, by its row ids. */
const PI_LOG_ROW = "pi:";

/**
 * A conversation's chat log as pi mirrors it: the rows the agent loops wrote
 * (Claude Code's turns), and pi's own messages written as the loops write
 * theirs, into the timeline the app shows and the orchestrator thread the
 * Claude Code engine reads its history from.
 */
const piLocalLog = (
  session: OpenSession,
  conversationId: string,
): import("@stella/agent/host/desktop-local-log").DesktopLocalLog => ({
  read: async (afterSeq, limit) => {
    const page = session.storage.chatStore.listMessagesAfterSeq(conversationId, afterSeq, limit);
    return { ...page, messages: page.messages.filter((message) => !message.id.startsWith(PI_LOG_ROW)) };
  },
  write: async (message) => {
    const eventId = `${PI_LOG_ROW}${conversationId}:${message.key}`;
    if (session.storage.chatStore.hasEvent(conversationId, eventId)) return;
    const type = message.role === "user" ? "user_message" : "assistant_message";
    const userMessageId = message.replyTo ? `${PI_LOG_ROW}${conversationId}:${message.replyTo}` : undefined;
    session.storage.appendChatEventAndNotify({
      conversationId,
      eventId,
      type,
      timestamp: message.timestamp,
      ...(userMessageId ? { requestId: userMessageId } : {}),
      payload: prepareStoredLocalChatPayload({
        type,
        payload: {
          text: message.text,
          ...(userMessageId ? { userMessageId } : {}),
          metadata:
            message.role === "user"
              ? { ui: { visibility: "visible" } }
              : { runtime: message.followedByToolCall ? { followedByToolCall: true } : {} },
        },
        timestamp: message.timestamp,
      }),
    });
    session.storage.runtimeStore.appendThreadMessage({
      timestamp: message.timestamp,
      threadKey: resolveOrchestratorThreadKey(conversationId),
      role: message.role,
      content: message.text,
    });
  },
});

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
      credentials: {
        apiKey: (provider) => getAccessibleLocalLlmApiKey(session.config.get().stellaDataDirPath, provider),
        oauthToken: (provider) => getAccessibleLocalLlmOAuthApiKey(session.config.get().stellaDataDirPath, provider),
      },
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
      // A conversation stored in the cloud lists this computer's agents in
      // the owner's agent threads, where a paired phone shows and messages them.
      agentStarted: (agent) => {
        if (agent.conversationId.startsWith("local_")) return;
        void (async () => {
          const runner = session.runnerCell.get();
          if (!runner) return;
          await runner.computerAgents.start({
            agentId: agent.threadId,
            conversationId: agent.conversationId,
            description: agent.description,
            agentType: "general",
            attemptGeneration: agent.attempt,
            ownerGeneration: await runner.cloudJournal.ownerGeneration(),
          });
        })().catch((error) => console.warn("[pi-chat] computer thread start failed", error));
      },
      agentReported: (agent) => {
        // The loop's notice for a finished task.
        void hostBus
          .request(METHOD_NAMES.HOST_NOTIFICATION_SHOW, {
            title: agent.description.trim() || "Task complete",
            body: "",
            sound: "Glass",
          })
          .catch((error) => console.debug("[pi-chat] agent notification failed", error));
        if (agent.conversationId.startsWith("local_")) return;
        const body = /\n(?:result|error): ([\s\S]*?)(?=\n(?:agent_state|routing|presentation): |$)/.exec(agent.report)?.[1]?.trim();
        void (async () => {
          const runner = session.runnerCell.get();
          if (!runner) return;
          await runner.computerAgents.complete({
            agentId: agent.threadId,
            attemptGeneration: agent.attempt,
            status: agent.failed ? "error" : "completed",
            ownerGeneration: await runner.cloudJournal.ownerGeneration(),
            ...(body ? (agent.failed ? { error: body } : { result: body }) : {}),
          });
        })().catch((error) => console.warn("[pi-chat] computer thread completion failed", error));
      },
      // A conversation kept on this computer shares the agent loops' chat
      // log; a cloud one shares the journal.
      localLog: (conversationId) =>
        conversationId.startsWith("local_") ? piLocalLog(session, conversationId) : undefined,
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
 * A message the user sent on another device that the cloud placed on this
 * computer: prepared as a composer send is (attachments included) and
 * answered as a visible turn of the conversation, cancellable by its
 * placement run id (`cancelPiPlacement`).
 */
export const piPlacedChat = async (
  session: OpenSession,
  hostBus: HostBus.Interface,
  run: {
    conversationId: string;
    userPrompt: string;
    placementRunId: string;
    userMessageEventId?: string;
    attachments?: RuntimeChatPayload["attachments"];
  },
) => {
  const chats = await piChatsFor(session, hostBus);
  const requestId = run.userMessageEventId || `placement:${run.placementRunId}`;
  const payload: RuntimeChatPayload = {
    conversationId: run.conversationId,
    userPrompt: run.userPrompt,
    userMessageEventId: requestId,
    platform: process.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(run.attachments?.length ? { attachments: run.attachments } : {}),
  };
  const prepared = await prepareChatInput(payload, {
    stellaDataDirPath: session.config.get().stellaDataDirPath,
    resolveImageTarget: async () => (await session.runnerCell.get()?.resolveImageTarget(undefined)) ?? undefined,
  });
  const content = piUserContent(payload, prepared);
  // The sender binds its pending message to this id: the journal row keeps it.
  content[0] = { ...content[0]!, stella: { ...content[0]!.stella, clientMsgId: requestId } } as typeof content[number];
  const canceled = piPlacementCanceled(session, "chat", run.placementRunId);
  if (canceled) return { status: "error" as const, finalText: "" as const, error: canceled };
  return await chats.automation(run.conversationId, {
    requestId,
    prompt: run.userPrompt,
    content,
    visible: true,
    placementRunId: run.placementRunId,
  });
};

/**
 * A message from another device for one of this computer's pi agents;
 * `not_found` when no pi conversation here has that agent.
 */
export const piDeliverAgentMessage = async (
  session: OpenSession,
  hostBus: HostBus.Interface,
  message: { threadId: string; text: string; messageId: string },
) => (await piChatsFor(session, hostBus)).deliverAgentMessage(message.threadId, message.text, message.messageId);

/**
 * Why a placement was canceled before it ran here, if it was: the cancel is
 * kept on disk, so a run delivered after it (even after a restart) never
 * starts. Read in the same step that registers the run, so a later cancel
 * finds the run instead.
 */
export const piPlacementCanceled = (
  session: OpenSession,
  kind: PlacementLocalExecutionKind,
  executionId: string,
): string | null => getPlacementCancellation({ store: session.storage.runtimeStore, kind, executionId });

/** Keep a placement's cancel, before anything awaits (`piPlacementCanceled`). */
const persistPiCancel = (
  session: OpenSession,
  kind: PlacementLocalExecutionKind,
  executionId: string,
  reason?: string,
) => persistPlacementCancellation({ store: session.storage.runtimeStore, kind, executionId, ...(reason ? { reason } : {}) });

/** Stop a placed chat pi is answering; false when pi has no such run. */
export const cancelPiPlacement = async (session: OpenSession, placementRunId: string, reason?: string): Promise<boolean> => {
  persistPiCancel(session, "chat", placementRunId, reason);
  const chats = await chatsBySession.get(session)?.catch(() => undefined);
  return (await chats?.cancelPlacement(placementRunId))?.canceled === true;
};

/** Stop a run of an agent placed here that pi is running; false when pi has no such run. */
export const cancelPiPlacedAgent = async (
  session: OpenSession,
  cancel: { agentKey: string; runKey: string; reason?: string },
): Promise<boolean> => {
  persistPiCancel(session, "agent", cancel.runKey, cancel.reason);
  const chats = await chatsBySession.get(session)?.catch(() => undefined);
  return chats?.cancelPlacedAgent(cancel.agentKey, cancel.runKey) === true;
};

/**
 * A pi chat request from the app. A composer send arrives as the composer
 * sent it and is prepared here as the agent loops prepare it (images sized
 * and spilled, files saved, chat context), then submitted as one user input.
 */
export const piChatRequest = async (
  session: OpenSession,
  hostBus: HostBus.Interface,
  request: PiChatRequest | PiChatUsageRequest,
): Promise<unknown> => {
  if (request.op === "usage") return await piModelUsage(session.config.get().stellaDataDirPath, request);
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
