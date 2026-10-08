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
import type { AssistantMessage, Message, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  ConversationBusy,
  defineDoc,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type EntryId,
  type Harness,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { ExecutionDestination } from "@stella/contracts/execution-context";
import { splitReplyRefs } from "@stella/contracts/reply-refs";
import {
  mergePiEntries,
  PI_REPORT_RE,
  piEntriesForClients,
  piMessageText,
  piEventsForClients,
  piUserView,
  type PiChatEvent,
  type PiChatEventsPayload,
  type PiChatAgentsResult,
  type PiChatOlderResult,
  type PiChatRequest,
  type PiChatWatchResult,
  type PiEntry,
  type PiUserMessage,
} from "@stella/contracts/pi-chat";
import type { DeviceSigner } from "@stella/runtime/kernel/home/device";
import {
  offersAgentTools,
  openStellaHarness,
  type OpenStellaHarness,
  orchestratorAgent,
  STELLA_DEFAULT_ALIAS,
  stellaModelRef,
} from "../harness.ts";
import type { StellaToolHost } from "../stella/host-tools.ts";
import {
  parseStellaModelId,
  stellaProvider,
  type StellaGatewayAccess,
  type StellaModelSpec,
} from "../provider/stella.ts";
import { openBunSqliteStorage } from "../storage/bun-sqlite.ts";
import { desktopAgentsHost, desktopEnvironments } from "./desktop-agents.ts";
import { journalMirror, type DesktopJournal, type JournalMirror } from "./desktop-journal.ts";
import { desktopGatewayAccess, resolveStellaModels } from "./desktop-gateway.ts";
import { desktopContextSources } from "./desktop-sources.ts";

/** The newest entries a client gets when it attaches, and per older page. */
const HISTORY_PAGE = 200;
/** A page of entries over IPC stays small enough to parse off the frame budget. */
const CLIENT_PAGE_BYTES = 2 * 1024 * 1024;
/** How far back a voice call's history reaches, in entries. */
const VOICE_HISTORY_ENTRIES = 200;
/** How long a turn waits for other devices' turns to be imported before it starts. */
const JOURNAL_CATCH_UP_MS = 3_000;
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
  /** The model the user picked for the orchestrator (`stella/<alias>`, or another provider's). */
  stellaModel?(): string | undefined;
  /** The orchestrator's thinking level, from the user's reasoning effort. */
  thinkingLevel?(): ModelThinkingLevel;
  /** Stella's own tools (web, html, image_gen, ask_user, …) for one conversation. */
  tools?(conversationId: string): StellaToolHost;
  /** The cloud journal of a conversation stored in the cloud, which its turns are mirrored into. */
  journal?(conversationId: string): DesktopJournal | undefined;
  /** A watched conversation's events, for every attached client. */
  emit(payload: PiChatEventsPayload): void;
  report(error: unknown): void;
};

type Chat = {
  harness: Harness;
  root: Conversation;
  refreshTools(): void;
  startAgent: OpenStellaHarness["startAgent"];
  agentRecords: OpenStellaHarness["agentRecords"];
  messageAgent: OpenStellaHarness["messageAgent"];
  runPlacedAgent: OpenStellaHarness["runPlacedAgent"];
  steerPlacedAgent: OpenStellaHarness["steerPlacedAgent"];
  /** For a conversation stored in the cloud: its journal mirror. */
  mirror?: JournalMirror;
  stream?: AgentEventStream;
  watchers: number;
  idleCheck: ReturnType<typeof setInterval>;
};

const context = BACKGROUND_CONTEXT;

/** The response language a conversation's latest message asked for, so it holds across restarts. */
const LocaleDoc = defineDoc<{ locale?: string }>({
  kind: "stella.locale",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

/** A conversation id as a file name. */
const fileName = (conversationId: string): string => {
  const safe = conversationId.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe || safe.startsWith(".")) throw new Error(`Invalid conversation id: ${conversationId}`);
  return `${safe}.sqlite`;
};

export function desktopChats(options: DesktopChatsOptions) {
  const chats = new Map<string, Promise<Chat>>();
  /** The conversation each agent placed here runs in, by its key at the placing host. */
  const placedIn = new Map<string, string>();
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
  let gateway: Promise<{ access: StellaGatewayAccess; gatewayOrigin: string }> | undefined;
  /** Each Stella model alias in use, resolved for the orchestrator and agents. */
  const specsByAlias = new Map<string, Promise<StellaModelSpec[]>>();

  /** The model gateway, once the user is signed in. */
  const ensureGateway = () =>
    (gateway ??= (async () => {
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
      return { access, gatewayOrigin };
    })().catch((error: unknown) => {
      gateway = undefined;
      throw error;
    }));

  /** The `stella` provider with an alias's models among the ones it offers. */
  const ensureProvider = async (alias: string = STELLA_DEFAULT_ALIAS): Promise<void> => {
    const { access, gatewayOrigin } = await ensureGateway();
    const known = specsByAlias.get(alias);
    if (known) {
      await known;
      return;
    }
    const pending = resolveStellaModels(access, gatewayOrigin, alias, ["orchestrator", "general"]);
    specsByAlias.set(alias, pending);
    try {
      await pending;
    } catch (error) {
      specsByAlias.delete(alias);
      throw error;
    }
    const all = await Promise.all([...specsByAlias.values()].map((specs) => specs.catch(() => [])));
    models.setProvider(stellaProvider({ access, models: all.flat() }));
  };

  /** The alias a conversation's agent runs on. */
  const aliasOf = (model: { modelId: string } | undefined): string =>
    (model && parseStellaModelId(model.modelId)?.alias) || STELLA_DEFAULT_ALIAS;

  /** The provider, retried until the user is signed in. */
  const waitForProvider = async (alias?: string): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ensureProvider(alias);
      } catch (error) {
        if (attempt === 0) options.report(error);
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_MS));
      }
    }
  };

  const open = (conversationId: string): Promise<Chat> => {
    let chat = chats.get(conversationId);
    if (!chat) {
      let opened: Chat | undefined;
      chat = (async () => {
        await mkdir(directory, { recursive: true });
        const storage = await openBunSqliteStorage(path.join(directory, fileName(conversationId)));
        const destination: ExecutionDestination = {
          kind: "device",
          deviceId: options.deviceId ?? "this-computer",
          label: "This computer",
        };
        const { harness, refreshTools, startAgent, agentRecords, messageAgent, runPlacedAgent, steerPlacedAgent } =
          await openStellaHarness(
          {
            storage,
            models,
            sources: desktopContextSources({
              stellaHome: options.dataDir,
              backendUrl: options.siteAuth()?.baseUrl,
              ...(options.memoryEnabled ? { memoryEnabled: options.memoryEnabled } : {}),
              destination,
              locale: async () =>
                opened && (await opened.harness.snapshot(LocaleDoc, opened.root.id, context))?.locale,
            }),
            agents: desktopAgentsHost({ ...(options.deviceId ? { deviceId: options.deviceId } : {}) }),
            ...(options.tools ? { tools: options.tools(conversationId) } : {}),
            env: environments.env,
            onReport: options.report,
          },
          context,
        );
        const orchestrator = orchestratorAgent(stellaModelRef("orchestrator"));
        const root = await harness.root(context, { agent: orchestrator });
        // A conversation from an older build keeps up with what the orchestrator is offered.
        if (offersAgentTools(await root.agent(context))) await root.configure(orchestrator, context);
        // Recovered work needs the provider; it waits for sign-in otherwise.
        const alias = aliasOf((await root.agent(context)).model);
        void waitForProvider(alias).then(() => harness.resume());
        const journal = options.journal?.(conversationId);
        const mirror = journal
          ? await journalMirror({ harness, root, journal, report: options.report, context })
          : undefined;
        void mirror?.importNow().catch((error: unknown) => options.report(error));
        const idleCheck = setInterval(() => {
          void harness.inspect(context).then(
            (inspection) =>
              markActive(conversationId, inspection.tasks.length > 0 || inspection.submissions.length > 0),
            (error: unknown) => options.report(error),
          );
          // While someone looks at it, what other devices said shows up here too.
          if (opened?.watchers) void mirror?.importNow().catch((error: unknown) => options.report(error));
        }, IDLE_CHECK_MS);
        idleCheck.unref?.();
        opened = {
          harness,
          root,
          refreshTools,
          startAgent,
          agentRecords,
          messageAgent,
          runPlacedAgent,
          steerPlacedAgent,
          ...(mirror ? { mirror } : {}),
          watchers: 0,
          idleCheck,
        };
        return opened;
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
    const { entries, trimmed } = piEntriesForClients([...page.items].reverse() as unknown as PiEntry[], CLIENT_PAGE_BYTES);
    return { entries, hasOlder: page.next !== undefined || trimmed };
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
      options.emit({ conversationId, events: piEventsForClients(events as unknown as PiChatEvent[]) });
    });
    if (previous) {
      options.emit({ conversationId, events: piEventsForClients([stream.snapshot as unknown as PiChatEvent]) });
      await previous.stop().catch(() => undefined);
    }
    return stream;
  };

  const watch = async (conversationId: string): Promise<PiChatWatchResult> => {
    const chat = await open(conversationId);
    chat.watchers += 1;
    const stream = await attach(conversationId, chat);
    const { entries, hasOlder } = await history(chat);
    const [snapshot] = piEventsForClients([stream.snapshot as unknown as PiChatEvent]) as [PiChatWatchResult["snapshot"]];
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

  /**
   * A conversation stored in the cloud answers with what other devices said
   * too: their turns are imported first, waiting at most a moment for the
   * journal.
   */
  const caughtUp = async (chat: Chat): Promise<void> => {
    if (!chat.mirror) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      chat.mirror.importNow().catch((error: unknown) => options.report(error)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, JOURNAL_CATCH_UP_MS);
      }),
    ]);
    clearTimeout(timer);
  };

  const submit = async (
    conversationId: string,
    requestId: string,
    content: UserInput,
    sent: { locale?: string } = {},
  ) => {
    // The Stella model the user picked (a BYOK pick runs on the default for now).
    const picked = options.stellaModel?.();
    const alias = picked?.startsWith("stella/") ? picked : STELLA_DEFAULT_ALIAS;
    await ensureProvider(alias);
    const chat = await open(conversationId);
    const agent = await chat.root.agent(context);
    const thinkingLevel = options.thinkingLevel?.() ?? "off";
    if (aliasOf(agent.model) !== alias || agent.thinkingLevel !== thinkingLevel) {
      await chat.root.configure({ model: stellaModelRef("orchestrator", alias), thinkingLevel }, context);
    }
    // The tool catalog follows the runtime's (extension tools come and go).
    chat.refreshTools();
    const locale = sent.locale;
    if (locale && (await chat.harness.snapshot(LocaleDoc, chat.root.id, context))?.locale !== locale) {
      await chat.harness.commit(async (tx) => {
        (await tx.doc(LocaleDoc, chat.root.id)).locale = locale;
        return undefined;
      }, context);
    }
    await markActive(conversationId, true);
    await caughtUp(chat);
    const submission = await chat.root.submit(
      // A message sent while Stella works joins the run at its next step.
      { type: "input", content, requestId, whenBusy: "steer" },
      context,
    );
    return { submissionId: submission.id };
  };

  /** The conversation open and its model ready, for work the host starts in it. */
  const ready = async (conversationId: string): Promise<Chat> => {
    const chat = await open(conversationId);
    await ensureProvider(aliasOf((await chat.root.agent(context)).model));
    chat.refreshTools();
    await markActive(conversationId, true);
    return chat;
  };

  /**
   * A turn the host starts (a schedule fire, a watch escalation): its prompt
   * shown as the user's only when the user wrote it, answered after whatever
   * the conversation is doing. Settles with the answer's text.
   */
  const automation = async (
    conversationId: string,
    turn: {
      requestId: string;
      prompt: string;
      visible: boolean;
      rejectIfBusy?: boolean;
      /** The conversation's events while the turn is open (a voice call narrates its tools). */
      observe?: (events: PiChatEvent[]) => void;
    },
  ): Promise<{ status: "ok"; finalText: string } | { status: "busy" | "error"; finalText: ""; error: string }> => {
    const chat = await ready(conversationId);
    const { observe } = turn;
    const observer = observe ? await watchEvents(chat.harness, chat.root.id, context) : undefined;
    observer?.start(async (events) => observe?.(events as unknown as PiChatEvent[]));
    try {
      return await automationTurn(chat, turn);
    } finally {
      await observer?.stop().catch(() => undefined);
    }
  };

  const automationTurn = async (
    chat: Chat,
    turn: { requestId: string; prompt: string; visible: boolean; rejectIfBusy?: boolean },
  ): Promise<{ status: "ok"; finalText: string } | { status: "busy" | "error"; finalText: ""; error: string }> => {
    await caughtUp(chat);
    let submission;
    try {
      submission = await chat.root.submit(
        {
          type: "input",
          // A prompt the user did not write is read by the model, not shown.
          content: turn.visible ? turn.prompt : [{ type: "text", text: turn.prompt, stella: { hidden: true } } as TextContent],
          requestId: turn.requestId,
          whenBusy: turn.rejectIfBusy ? "reject" : "followUp",
        },
        context,
      );
    } catch (error) {
      if (error instanceof ConversationBusy) {
        return { status: "busy", finalText: "", error: "Stella is already handling another turn." };
      }
      throw error;
    }
    const settled = await submission.wait(context);
    if (settled.status === "unanswered") {
      return { status: "error", finalText: "", error: settled.reason ?? "The turn did not finish." };
    }
    const answer = settled.type === "input" ? settled.answer : undefined;
    if (answer === undefined) return { status: "ok", finalText: "" };
    const page = await chat.root.entries({ minEntryId: answer, maxEntryId: answer }, 1, undefined, context);
    const message = (page.items[0] as unknown as PiEntry | undefined)?.model?.[0];
    // What gets delivered or spoken is the prose, without the reply's citations.
    return { status: "ok", finalText: splitReplyRefs(piMessageText(message)).text.trim() };
  };

  /**
   * What a voice call said, written into the transcript without a run: the
   * user's and the voice model's words as model history the timeline leaves
   * out, and the call's summary, which it shows. Once per `eventId`.
   */
  const voiceTranscript = async (
    conversationId: string,
    said: {
      eventId?: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
      hidden?: boolean;
      voiceSession?: { durationMs: number };
    },
  ): Promise<void> => {
    const chat = await open(conversationId);
    const timestamp = said.timestamp ?? Date.now();
    const marks = { source: "voice" as const, ...(said.voiceSession ? { voiceSession: said.voiceSession } : {}) };
    const message =
      said.role === "user"
        ? {
            role: "user" as const,
            content: [{ type: "text" as const, text: said.text, ...(said.hidden ? { stella: { hidden: true } } : {}) }],
            timestamp,
            ...marks,
          }
        : ({
            role: "assistant",
            content: [{ type: "text", text: said.text }],
            api: "stella-voice",
            provider: "stella",
            model: "realtime-voice",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp,
            ...marks,
            ...(said.hidden ? { stella: { hidden: true } } : {}),
          } as AssistantMessage);
    await chat.root.submit(
      {
        type: "write",
        ...(said.eventId ? { requestId: `voice-said:${said.eventId}` } : {}),
        entry: { kind: said.role === "user" ? "pi.user" : "pi.assistant", model: [message as Message] },
      },
      context,
    );
  };

  /** The conversation so far as a voice call starts with it: what was said, oldest first. */
  const voiceHistory = async (
    conversationId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string; timestamp: number }>> => {
    const chat = await open(conversationId);
    const page = await chat.root.entries({}, VOICE_HISTORY_ENTRIES, undefined, context);
    const items: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];
    for (const entry of [...page.items].reverse() as unknown as PiEntry[]) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.user" && message?.role === "user") {
        // What the user typed or said; not the context and notices sent along,
        // a report, or a prompt the app wrote.
        const text = piUserView(message).text || ((message as PiUserMessage).source === "voice" ? piMessageText(message) : "");
        if (text.trim() && !PI_REPORT_RE.test(text.trimStart())) {
          items.push({ role: "user", content: text, timestamp: message.timestamp });
        }
      } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
        const text = splitReplyRefs(piMessageText(message)).text.trim();
        if (text.trim()) items.push({ role: "assistant", content: text, timestamp: message.timestamp });
      }
    }
    return items;
  };

  /** An agent the host starts in a conversation (an app-source merge, memory sync). */
  const startAgent = async (
    conversationId: string,
    agent: { key: string; description: string; prompt: string },
  ): Promise<{ threadId: string }> => {
    const chat = await ready(conversationId);
    const { threadId } = await chat.startAgent(agent, context);
    return { threadId };
  };

  /** The conversation's agents, as the app lists them. */
  const agents = async (conversationId: string): Promise<PiChatAgentsResult> => {
    const chat = await open(conversationId);
    const records = await chat.agentRecords(context);
    return {
      agents: records.map(({ placement: _placement, ...agent }) => agent),
    };
  };

  /** What the user typed into one agent's thread, delivered once per `key`. */
  const messageAgent = async (
    conversationId: string,
    message: { key: string; threadId: string; message: string },
  ): Promise<void> => {
    const chat = await ready(conversationId);
    await chat.messageAgent(message, context);
  };

  /**
   * An agent another host placed on this computer (a cloud conversation's
   * agent on a device), run in the conversation here to its answer, which
   * goes back to that host.
   */
  const runPlacedAgent = async (
    conversationId: string,
    run: Parameters<OpenStellaHarness["runPlacedAgent"]>[0],
  ): ReturnType<OpenStellaHarness["runPlacedAgent"]> => {
    placedIn.set(run.agentKey, conversationId);
    const chat = await ready(conversationId);
    return await chat.runPlacedAgent(run, context);
  };

  /** A message for an agent placed here, from the host that placed it; false when it is not running here. */
  const steerPlacedAgent = async (message: { key: string; agentKey: string; message: string }): Promise<boolean> => {
    const conversationId = placedIn.get(message.agentKey);
    if (!conversationId) return false;
    return await (await open(conversationId)).steerPlacedAgent(message, context);
  };

  const older = async (conversationId: string, beforeEntryId: number): Promise<PiChatOlderResult> =>
    history(await open(conversationId), beforeEntryId);

  return {
    /** Submit a prepared message (text and marked parts). */
    submit,
    automation,
    startAgent,
    messageAgent,
    runPlacedAgent,
    steerPlacedAgent,
    voiceTranscript,
    voiceHistory,
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
        case "agents":
          return agents(request.conversationId);
      }
    },
    async close(): Promise<void> {
      const opened = await Promise.all([...chats.values()].map((chat) => chat.catch(() => undefined)));
      chats.clear();
      for (const chat of opened) {
        if (!chat) continue;
        clearInterval(chat.idleCheck);
        await chat.mirror?.stop();
        await chat.stream?.stop().catch(() => undefined);
        await chat.harness.close(context).catch(() => undefined);
      }
      await environments.cleanup(context);
    },
  };
}

export type DesktopChats = ReturnType<typeof desktopChats>;
