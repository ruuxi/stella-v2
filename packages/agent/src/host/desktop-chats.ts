/**
 * The desktop's chats on pi-durable: one harness per Stella conversation, on
 * its own SQLite file under `<data dir>/agent/`, opened on first use and kept
 * open so its agents keep running between turns. The runtime worker serves
 * `PiChatRequest`s with it and forwards a watched conversation's events to
 * the app (`@stella/contracts/pi-chat`).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionDestination } from "@stella/contracts/execution-context";
import {
  mergePiEntries,
  type PiChatEvent,
  type PiChatEventsPayload,
  type PiChatOlderResult,
  type PiChatRequest,
  type PiChatWatchResult,
  type PiEntry,
} from "@stella/contracts/pi-chat";
import type { DeviceSigner } from "@stella/runtime/kernel/home/device";
import { openStellaHarness, orchestratorAgent, STELLA_DEFAULT_ALIAS, stellaModelRef } from "../harness.ts";
import { stellaProvider } from "../provider/stella.ts";
import { openBunSqliteStorage } from "../storage/bun-sqlite.ts";
import { desktopAgentsHost, desktopEnvironments } from "./desktop-agents.ts";
import { desktopGatewayAccess, resolveStellaModels } from "./desktop-gateway.ts";
import { desktopContextSources } from "./desktop-sources.ts";

/** The newest entries a client gets when it attaches, and per older page. */
const HISTORY_PAGE = 200;
/** How often an open conversation is checked for being idle again. */
const IDLE_CHECK_MS = 30_000;
/** Until signed in, recovered work retries the provider this often. */
const PROVIDER_RETRY_MS = 5_000;

export type DesktopChatsOptions = {
  /** The Stella data directory (`~/.stella`). */
  dataDir: string;
  deviceId?: string;
  /** Where this computer's agents work by default. */
  workspace: string;
  siteAuth(): { baseUrl: string; authToken: string } | null;
  refreshAuthToken?(): Promise<string | null | undefined>;
  getDeviceSigner(): Promise<DeviceSigner> | DeviceSigner;
  memoryEnabled?(): boolean;
  /** A watched conversation's events, for every attached client. */
  emit(payload: PiChatEventsPayload): void;
  report(error: unknown): void;
};

type Chat = {
  harness: Harness;
  root: Conversation;
  stream?: AgentEventStream;
  watchers: number;
  idleCheck: ReturnType<typeof setInterval>;
};

const context = BACKGROUND_CONTEXT;

/** A conversation id as a file name. */
const fileName = (conversationId: string): string => {
  const safe = conversationId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe || safe.startsWith(".")) throw new Error(`Invalid conversation id: ${conversationId}`);
  return `${safe}.sqlite`;
};

export function desktopChats(options: DesktopChatsOptions) {
  const chats = new Map<string, Promise<Chat>>();
  const directory = path.join(options.dataDir, "agent");

  // Conversations with work in flight, so a new runtime process resumes
  // them without waiting for a window to open them.
  const activeFile = path.join(directory, "active.json");
  let active: Promise<Set<string>> | undefined;
  let saving = Promise.resolve();
  const activeSet = () =>
    (active ??= readFile(activeFile, "utf8").then(
      (text) => new Set((JSON.parse(text) as unknown[]).filter((id): id is string => typeof id === "string")),
      () => new Set<string>(),
    ));
  const markActive = async (conversationId: string, busy: boolean) => {
    const ids = await activeSet();
    if (ids.has(conversationId) === busy) return;
    if (busy) ids.add(conversationId);
    else ids.delete(conversationId);
    const text = JSON.stringify([...ids]);
    saving = saving.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(`${activeFile}.tmp`, text);
      await rename(`${activeFile}.tmp`, activeFile);
    }).catch((error: unknown) => options.report(error));
    await saving;
  };
  const environments = desktopEnvironments(options.workspace);
  const models = createModels();
  let provider: Promise<void> | undefined;

  /** The `stella` provider, set up once the user is signed in. */
  const ensureProvider = () =>
    (provider ??= (async () => {
      const site = options.siteAuth();
      if (!site) throw new Error("Sign in to Stella to chat.");
      const baseUrl = site.baseUrl.replace(/\/+$/, "");
      const catalog = (await (await fetch(`${baseUrl}/api/stella/models`)).json()) as { gateway?: { origin?: string } };
      const gatewayOrigin = catalog.gateway?.origin;
      if (!gatewayOrigin) throw new Error("Stella's model catalog names no gateway.");
      const access = desktopGatewayAccess({
        gatewayOrigin,
        getAuthToken: () => options.siteAuth()?.authToken,
        ...(options.refreshAuthToken
          ? { refreshAuthToken: async () => (await options.refreshAuthToken?.()) ?? undefined }
          : {}),
        getDeviceSigner: options.getDeviceSigner,
      });
      const specs = await resolveStellaModels(access, gatewayOrigin, STELLA_DEFAULT_ALIAS, ["orchestrator", "general"]);
      models.setProvider(stellaProvider({ access, models: specs }));
    })().catch((error: unknown) => {
      provider = undefined;
      throw error;
    }));

  /** The provider, retried until the user is signed in. */
  const waitForProvider = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ensureProvider();
      } catch (error) {
        if (attempt === 0) options.report(error);
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_MS));
      }
    }
  };

  const open = (conversationId: string): Promise<Chat> => {
    let chat = chats.get(conversationId);
    if (!chat) {
      chat = (async () => {
        await mkdir(directory, { recursive: true });
        const storage = await openBunSqliteStorage(path.join(directory, fileName(conversationId)));
        const destination: ExecutionDestination = {
          kind: "device",
          deviceId: options.deviceId ?? "this-computer",
          label: "This computer",
        };
        const { harness } = await openStellaHarness(
          {
            storage,
            models,
            sources: desktopContextSources({
              stellaHome: options.dataDir,
              backendUrl: options.siteAuth()?.baseUrl,
              ...(options.memoryEnabled ? { memoryEnabled: options.memoryEnabled } : {}),
              destination,
            }),
            agents: desktopAgentsHost({ ...(options.deviceId ? { deviceId: options.deviceId } : {}) }),
            env: environments.env,
            onReport: options.report,
          },
          context,
        );
        const root = await harness.root(context, { agent: orchestratorAgent(stellaModelRef("orchestrator")) });
        // Recovered work needs the provider; it waits for sign-in otherwise.
        void waitForProvider().then(() => harness.resume());
        const idleCheck = setInterval(() => {
          void harness.inspect(context).then(
            (inspection) =>
              markActive(conversationId, inspection.tasks.length > 0 || inspection.submissions.length > 0),
            (error: unknown) => options.report(error),
          );
        }, IDLE_CHECK_MS);
        idleCheck.unref?.();
        return { harness, root, watchers: 0, idleCheck };
      })().catch((error: unknown) => {
        chats.delete(conversationId);
        throw error;
      });
      chats.set(conversationId, chat);
    }
    return chat;
  };

  /** The newest page of the whole history, ascending; compaction never hides it. */
  const history = async (chat: Chat, beforeEntryId?: number): Promise<{ entries: PiEntry[]; hasOlder: boolean }> => {
    const page = await chat.root.entries(
      beforeEntryId === undefined ? {} : { maxEntryId: (beforeEntryId - 1) as EntryId },
      HISTORY_PAGE,
      undefined,
      context,
    );
    return { entries: [...page.items].reverse() as unknown as PiEntry[], hasOlder: page.next !== undefined };
  };

  /**
   * (Re)attach the conversation's event stream. Every attached client gets
   * the new snapshot as an event, so none misses what happened between the
   * old stream and the new one.
   */
  const attach = async (conversationId: string, chat: Chat): Promise<AgentEventStream> => {
    const previous = chat.stream;
    const stream = await watchEvents(chat.harness, chat.root.id, context);
    chat.stream = stream;
    stream.start(async (events) => {
      if (chat.stream !== stream) return;
      options.emit({ conversationId, events: events as unknown as PiChatEvent[] });
    });
    if (previous) {
      options.emit({ conversationId, events: [stream.snapshot as unknown as PiChatEvent] });
      await previous.stop().catch(() => undefined);
    }
    return stream;
  };

  const watch = async (conversationId: string): Promise<PiChatWatchResult> => {
    const chat = await open(conversationId);
    chat.watchers += 1;
    const stream = await attach(conversationId, chat);
    const { entries, hasOlder } = await history(chat);
    const snapshot = stream.snapshot as unknown as PiChatWatchResult["snapshot"];
    return { snapshot: { ...snapshot, entries: mergePiEntries(entries, snapshot.entries) }, hasOlder };
  };

  const unwatch = async (conversationId: string): Promise<void> => {
    const chat = await chats.get(conversationId);
    if (!chat || chat.watchers === 0) return;
    chat.watchers -= 1;
    if (chat.watchers > 0) return;
    const stream = chat.stream;
    chat.stream = undefined;
    await stream?.stop().catch(() => undefined);
  };

  const submit = async (conversationId: string, requestId: string, text: string) => {
    await ensureProvider();
    const chat = await open(conversationId);
    await markActive(conversationId, true);
    const submission = await chat.root.submit(
      // A message sent while Stella works joins the run at its next step.
      { type: "input", content: text, requestId, whenBusy: "steer" },
      context,
    );
    return { submissionId: submission.id };
  };

  const older = async (conversationId: string, beforeEntryId: number): Promise<PiChatOlderResult> =>
    history(await open(conversationId), beforeEntryId);

  return {
    /** Reopen the conversations a previous process left with work in flight. */
    async resumeActive(): Promise<void> {
      for (const conversationId of await activeSet()) {
        await open(conversationId).catch((error: unknown) => options.report(error));
      }
    },
    async request(request: PiChatRequest): Promise<unknown> {
      switch (request.op) {
        case "submit":
          return submit(request.conversationId, request.requestId, request.text);
        case "abort":
          await (await open(request.conversationId)).root.abort(context);
          return { ok: true };
        case "watch":
          return watch(request.conversationId);
        case "unwatch":
          await unwatch(request.conversationId);
          return { ok: true };
        case "older":
          return older(request.conversationId, request.beforeEntryId);
      }
    },
    async close(): Promise<void> {
      const opened = await Promise.all([...chats.values()].map((chat) => chat.catch(() => undefined)));
      chats.clear();
      for (const chat of opened) {
        if (!chat) continue;
        clearInterval(chat.idleCheck);
        await chat.stream?.stop().catch(() => undefined);
        await chat.harness.close(context).catch(() => undefined);
      }
      await environments.cleanup(context);
    },
  };
}

export type DesktopChats = ReturnType<typeof desktopChats>;
