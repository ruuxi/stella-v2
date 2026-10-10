/**
 * The desktop's chats on pi-durable: one harness per Stella conversation, on
 * its own SQLite file under `<data dir>/agent/`, opened on first use and kept
 * open so its agents keep running between turns. The runtime worker serves
 * `PiChatRequest`s with it and forwards a watched conversation's events to
 * the app (`@stella/contracts/pi-chat`).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  ConversationBusy,
  defineDoc,
  LiveDoc,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness,
  type ModelRef,
  type Submission,
  type UserInput,
} from "@earendil-works/pi-durable";
import {
  formatAgentMessage,
  type AgentDirectoryAgentRow,
  type AgentDirectorySessionRow,
  type AgentMessageSender,
} from "@stella/contracts/agent-directory";
import type { AgentMessageDelivery } from "@stella/contracts/backend/agent-threads";
import type { ExecutionDestination } from "@stella/contracts/execution-context";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { splitReplyRefs } from "@stella/contracts/reply-refs";
import {
  isPiAgentText,
  mergePiEntries,
  piEntriesForClients,
  piMessageText,
  piEventsForClients,
  piUserView,
  type PiChatEvent,
  type PiChatEventsPayload,
  type PiChatAgentsResult,
  type PiChatBrainResult,
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
import { StellaAgentsDoc, type AgentDirectoryHost, type RemoteAgentHost } from "../stella/agents.ts";
import type { StellaToolHost } from "../stella/host-tools.ts";
import {
  parseStellaModelId,
  STELLA_PROVIDER_ID,
  stellaProvider,
  type StellaGatewayAccess,
  type StellaModelSpec,
} from "../provider/stella.ts";
import {
  byokModels,
  parseModelPick,
  stellaCredentialStore,
  storeOnlyAuthContext,
  type StellaCredentialAccess,
} from "../provider/byok.ts";
import { openBunSqliteStorage } from "../storage/bun-sqlite.ts";
import { isDeviceToolName } from "@stella/contracts/turn-plane/device-tools";
import { deviceRefusal } from "../stella/execution.ts";
import { placementOf, StellaPlacementDoc } from "../stella/placement.ts";
import { desktopAgentsHost, desktopEnvironments } from "./desktop-agents.ts";
import {
  desktopCoding,
  desktopExecution,
  type DesktopBrain,
  type DesktopExecution,
  type DesktopExecutionRemote,
} from "./desktop-execution.ts";
import type { PiBrainRecord } from "@stella/contracts/turn-plane/pi-brain";
import { journalMirror, type DesktopJournal, type JournalMirror } from "./desktop-journal.ts";
import { localLogMirror, writtenReply, type DesktopLocalLog, type LocalLogMirror } from "./desktop-local-log.ts";
import { desktopGatewayAccess, resolveStellaModels } from "./desktop-gateway.ts";
import { desktopContextSources } from "./desktop-sources.ts";

/** The newest entries a client gets when it attaches, and per older page. */
const HISTORY_PAGE = 200;
/** A page of entries over IPC stays small enough to parse off the frame budget. */
const CLIENT_PAGE_BYTES = 2 * 1024 * 1024;
/** How far back a voice call's history reaches, in entries. */
const VOICE_HISTORY_ENTRIES = 200;
/** How far back the files a conversation linked are looked for, in entries. */
const LINKED_FILE_ENTRIES = 500;
/** How long a turn waits for other devices' turns to be imported before it starts. */
const JOURNAL_CATCH_UP_MS = 3_000;
/** How often an open conversation is checked for being idle again. */
const IDLE_CHECK_MS = 30_000;
/** How often the journal is read while a turn runs elsewhere, or while one here can be stopped from elsewhere. */
const FOLLOW_MS = 2_000;
/** How long after a turn is placed elsewhere the journal is read that often, until the turn shows. */
const FOLLOW_WINDOW_MS = 60_000;
/** How long where a conversation's brain runs is trusted before it is read again. */
const BRAIN_TTL_MS = 5_000;
/** How long a moved brain's brief waits for Stella's turn here to end. */
const BRAIN_HANDOFF_WAIT_MS = 5 * 60_000;
/** Until signed in, recovered work retries the provider this often. */
const PROVIDER_RETRY_MS = 5_000;
/** How long the agents' directory waits for the cloud; a message waits out the cloud's own device wait. */
const DIRECTORY_TIMEOUT_MS = 5_000;
const AGENT_MESSAGE_TIMEOUT_MS = 15_000;

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
  /** The keys the user brought for other providers' models (BYOK), as the app keeps them. */
  credentials?: StellaCredentialAccess;
  /** The orchestrator's thinking level, from the user's reasoning effort. */
  thinkingLevel?(): ModelThinkingLevel;
  /** Stella's own tools (web, html, image_gen, ask_user, …) for one conversation. */
  tools?(conversationId: string): StellaToolHost;
  /** The cloud journal of a conversation stored in the cloud, which its turns are mirrored into. */
  journal?(conversationId: string): DesktopJournal | undefined;
  /** For a conversation stored in the cloud: its cloud agents, run in its object. */
  cloudAgents?(conversationId: string): RemoteAgentHost | undefined;
  /**
   * For a conversation stored in the cloud: how its tools reach the owner's
   * other computers and a cloud container, once they are moved there.
   */
  execution?(conversationId: string): DesktopExecutionRemote | undefined;
  /**
   * For a conversation stored in the cloud: where its brain runs, as its
   * object records it. Once that names another host, this computer takes
   * none of its turns while that host can take them.
   */
  brain?(conversationId: string): DesktopBrain | undefined;
  /** The chats on this computer, newest first, which agents list and message as sessions. */
  localSessions?(): Array<{ conversationId: string; title: string; updatedAt: number }>;
  /**
   * The owner's agent threads in the cloud, once signed in: a conversation's
   * agents elsewhere and the user's cloud sessions, and a note for one of
   * them. A chat kept on this computer never reaches them.
   */
  agentThreads?: {
    directory(conversationId: string): Promise<{ agents: AgentDirectoryAgentRow[]; sessions: AgentDirectorySessionRow[] }>;
    message(args: { messageId: string; to: string; text: string; from: AgentMessageSender }): Promise<AgentMessageDelivery>;
  };
  /** One of Stella's agents started work (a spawn or a follow-up: `attempt` counts them). */
  agentStarted?(agent: { conversationId: string; threadId: string; description: string; attempt: number }): void;
  /**
   * An agent finished and reported to Stella (the app shows a notification).
   * `running`: a message since has it working again, so `attempt` is that
   * newer run's and still open.
   */
  agentReported?(agent: {
    conversationId: string;
    threadId: string;
    description: string;
    failed: boolean;
    report: string;
    attempt: number;
    running: boolean;
  }): void;
  /** One of Stella's agents was paused before it answered; Stella is not told (`StellaAgentsHost.agentPaused`). */
  agentPaused?(agent: { conversationId: string; threadId: string; description: string; attempt: number }): void;
  /**
   * For a conversation kept on this computer: the agent loops' chat log,
   * which the Claude Code engine answers from. Its turns are mirrored both
   * ways, so the conversation stays one across engines.
   */
  localLog?(conversationId: string): DesktopLocalLog | undefined;
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
  /** For a conversation kept on this computer: its chat log mirror. */
  localLog?: LocalLogMirror;
  /** Where its tools run when they are not on this computer. */
  execution: DesktopExecution;
  stream?: AgentEventStream;
  watchers: number;
  idleCheck: ReturnType<typeof setInterval>;
  /** Reads the journal closely while a turn runs elsewhere (`follow`). */
  followCheck: ReturnType<typeof setInterval>;
  followUntil: number;
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

/**
 * Stella's own tools for one conversation: her Read reads where her tools
 * run, this computer or wherever `switch_destination` moved them.
 */
const placedTools = (tools: StellaToolHost, execution: DesktopExecution, chat: () => Chat | undefined): StellaToolHost => ({
  specs: (role) => tools.specs(role),
  run: async (call, context) => {
    const opened = chat();
    if (call.role === "orchestrator" && isDeviceToolName(call.name) && opened) {
      const placement = placementOf(await opened.harness.snapshot(StellaPlacementDoc, opened.root.id, context));
      if (placement && placement.kind !== "local") {
        return await execution.run(
          placement,
          { piConversationId: opened.root.id, callId: call.callId, toolName: call.name, params: call.args },
          context,
        );
      }
    }
    return await tools.run(call, context);
  },
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
  /** Runs of agents placed here, until they settle, so the host that placed one can stop it. */
  const placedRuns = new Map<string, { runKey: string; cancel: AbortController }>();
  const directory = path.join(options.dataDir, "agent");

  // Conversations with work in flight, so a new runtime process resumes
  // them without waiting for a window to open them.
  const activeFile = path.join(directory, "active.json");
  let active: Promise<Set<string>> | undefined;
  /** The same set once read, for `busy()`. */
  let activeNow: ReadonlySet<string> = new Set();
  let saving = Promise.resolve();
  const activeSet = () =>
    (active ??= readFile(activeFile, "utf8")
      .then(
        (text) => new Set((JSON.parse(text) as unknown[]).filter((id): id is string => typeof id === "string")),
        () => new Set<string>(),
      )
      .then((ids) => (activeNow = ids)));
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
  // Stella's agents by thread id, to their conversation: a message from
  // another device (a paired phone) names only the thread.
  const threadsFile = path.join(directory, "threads.json");
  let threads: Promise<Record<string, string>> | undefined;
  const threadIndex = () =>
    (threads ??= readFile(threadsFile, "utf8").then(
      (text) => JSON.parse(text) as Record<string, string>,
      (): Record<string, string> => ({}),
    ));
  const noteAgentThread = async (threadId: string, conversationId: string) => {
    const index = await threadIndex();
    if (index[threadId] === conversationId) return;
    index[threadId] = conversationId;
    const text = JSON.stringify(index);
    saving = saving.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(`${threadsFile}.tmp`, text);
      await rename(`${threadsFile}.tmp`, threadsFile);
    }).catch((error: unknown) => options.report(error));
    await saving;
  };
  const environments = desktopEnvironments(options.workspace);
  /**
   * Where each conversation stored in the cloud has its brain, as last read,
   * and the host that takes this computer's turns for it now (null: here).
   */
  const brains = new Map<string, { record: PiBrainRecord | null; host: PiBrainRecord | null; at: number }>();
  /** The record's host, unless that is this computer. */
  const otherHost = (record: PiBrainRecord | null) =>
    record && !(record.host === "device" && record.deviceId === options.deviceId) ? record : null;
  /**
   * The host this computer's turns for the conversation go to: the one its
   * record names, while that host can take them. With no record, or one
   * naming a host that can't now (a computer offline or not ready, the cloud
   * out of reach), null: the sender's host answers, as with no record, and
   * the record stays for once that host is back.
   */
  const brainHost = async (conversationId: string): Promise<PiBrainRecord | null> => {
    const known = brains.get(conversationId);
    if (known && Date.now() - known.at < BRAIN_TTL_MS) return known.host;
    const brain = options.brain?.(conversationId);
    if (!brain) return null;
    let record: PiBrainRecord | null;
    try {
      record = await brain.read();
    } catch {
      // The cloud is out of reach (offline, signed out), and so is every host it would pass a turn to.
      brains.set(conversationId, { record: known?.record ?? null, host: null, at: Date.now() });
      return null;
    }
    let host = otherHost(record);
    if (host?.host === "device") {
      const { deviceId, label } = host;
      const listed = await options.execution?.(conversationId)?.devices().catch(() => undefined);
      const device = listed?.find((entry) => entry.deviceId === deviceId);
      if (!device || deviceRefusal(device, label ?? deviceId)) host = null;
    }
    brains.set(conversationId, { record, host, at: Date.now() });
    return host;
  };
  /** Whether this computer takes the conversation's turns, or where a send goes instead. */
  const brainPlacement = async (conversationId: string): Promise<PiChatBrainResult> => {
    const host = await brainHost(conversationId);
    if (!host) return { here: true };
    return host.host === "cloud"
      ? { here: false, target: { mode: "cloud" } }
      : { here: false, target: { mode: "device", deviceId: host.deviceId }, ...(host.label ? { label: host.label } : {}) };
  };
  /**
   * What Stella reads hidden and the user did not write (an agent's report
   * or note) for a conversation whose brain runs elsewhere: placed there as
   * this computer's sends are, once per `requestId`. False when she runs
   * here, or where she runs can't take it now, for the conversation here to take.
   */
  const noteOnBrain = async (conversationId: string, requestId: string, text: string): Promise<boolean> => {
    const host = await brainHost(conversationId);
    if (!host) return false;
    const brain = options.brain?.(conversationId);
    if (!brain) return false;
    // Another computer's harness counts its own request ids.
    const id = createHash("sha256").update(`${options.deviceId ?? ""}\0${conversationId}\0${requestId}`).digest("hex").slice(0, 48);
    if (!(await brain.note(host, { id: `pi-note:${id}`, text }))) return false;
    // Her answer comes back through the journal.
    const chat = await chats.get(conversationId)?.catch(() => undefined);
    if (chat) chat.followUntil = Date.now() + FOLLOW_WINDOW_MS;
    return true;
  };
  const elsewhere = (placement: Extract<PiChatBrainResult, { here: false }>) =>
    `Stella for this chat runs ${placement.target.mode === "cloud" ? "in the cloud" : `on ${placement.label ?? placement.target.deviceId}`} now, so this computer does not answer it.`;
  // A model on another provider runs with the key the user stored for it,
  // never one found in this process's environment.
  const models = createModels(
    options.credentials
      ? { credentials: stellaCredentialStore(options.credentials), authContext: storeOnlyAuthContext }
      : {},
  );
  const byok = byokModels(models);
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

  /** The orchestrator's model for the user's pick: a Stella alias, or a model on the user's own key. */
  const pickedModel = async (): Promise<ModelRef> => {
    const pick = parseModelPick(options.stellaModel?.());
    if (!pick || pick.kind === "stella") {
      const alias = pick?.alias ?? STELLA_DEFAULT_ALIAS;
      await ensureProvider(alias);
      return stellaModelRef("orchestrator", alias);
    }
    const ref = byok.ensure(pick);
    if ("error" in ref) throw new Error(ref.error);
    return ref;
  };

  /** A model a conversation or one of its agents is on, ready to run (after a restart too). */
  const ensureModel = async (ref: ModelRef | undefined): Promise<void> => {
    if (!ref || ref.provider === STELLA_PROVIDER_ID) await ensureProvider(aliasOf(ref));
    else byok.restore(ref);
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

  /** Settles as `work` does, or fails once `ms` pass. */
  const within = <T,>(work: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  /**
   * Who a conversation's agents reach beyond its own harness: the other
   * chats on this computer and their Stellas' agents, and, for a
   * conversation stored in the cloud, the owner's agent threads (its agents
   * elsewhere, the user's cloud sessions).
   */
  const directoryFor = (conversationId: string): AgentDirectoryHost => {
    const cloud = conversationId.startsWith("local_") ? undefined : options.agentThreads;
    const localSessions = (): AgentDirectorySessionRow[] =>
      (options.localSessions?.() ?? []).map((row) => ({
        ...row,
        active: activeNow.has(row.conversationId),
        where: row.conversationId.startsWith("local_") ? "this computer" : "cloud",
      }));
    return {
      conversationId: async () => conversationId,
      list: async () => {
        const local = localSessions();
        if (!cloud) return { agents: [], sessions: local };
        try {
          const remote = await within(cloud.directory(conversationId), DIRECTORY_TIMEOUT_MS, "Stella's cloud did not answer.");
          // A chat here keeps the title this computer has and the cloud's place.
          const sessions = new Map(remote.sessions.map((row) => [row.conversationId, row]));
          for (const row of local) {
            const there = sessions.get(row.conversationId);
            sessions.set(
              row.conversationId,
              there
                ? {
                    ...there,
                    title: row.title.trim() ? row.title : there.title,
                    active: row.active || there.active,
                    updatedAt: Math.max(row.updatedAt, there.updatedAt),
                  }
                : row,
            );
          }
          return { agents: remote.agents, sessions: [...sessions.values()] };
        } catch (error) {
          return {
            agents: [],
            sessions: local,
            unavailable: `Stella's cloud did not answer (${error instanceof Error ? error.message : String(error)}), so agents running in the cloud or on other devices are not listed right now.`,
          };
        }
      },
      message: async ({ key, to, text, from, remoteStella }) => {
        const id = createHash("sha256").update(`${options.deviceId ?? ""}\0${conversationId}\0${key}`).digest("hex").slice(0, 48);
        const framed = formatAgentMessage(from, text);
        if (!remoteStella && to !== conversationId) {
          // Another chat here: its Stella reads the note as its next turn, and the user does not see it.
          if (chats.has(to) || localSessions().some((row) => row.conversationId === to)) {
            if (await noteOnBrain(to, `agent-note:${id}`, framed)) return { delivered: "queued", threadId: to };
            const chat = await ready(to);
            const note: TextContent & { stella: { hidden: true } } = { type: "text", text: framed, stella: { hidden: true } };
            await chat.root.submit({ type: "input", content: [note], whenBusy: "followUp", requestId: `agent-note:${id}` }, context);
            return { delivered: "queued", threadId: to };
          }
          // One of another chat's agents here: it reaches the agent as that chat's Stella's messages do.
          const home = (await threadIndex())[to];
          if (home && home !== conversationId) {
            const chat = await ready(home);
            const record = (await chat.agentRecords(context)).find((agent) => agent.threadId === to);
            if (record) {
              await chat.messageAgent({ key: `note:${id}`, threadId: to, message: framed, fromOrchestrator: true }, context);
              return { delivered: record.status === "running" ? "steered" : "resumed", threadId: to };
            }
          }
        }
        if (!cloud) return undefined;
        return await within(
          cloud.message({ messageId: `pi-msg:${id}`, to, text, from }),
          AGENT_MESSAGE_TIMEOUT_MS,
          "Stella's cloud did not answer, so the message may not have been delivered.",
        );
      },
    };
  };

  const open = (conversationId: string): Promise<Chat> => {
    let chat = chats.get(conversationId);
    if (!chat) {
      let opened: Chat | undefined;
      chat = (async () => {
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, fileName(conversationId));
        const storage = await openBunSqliteStorage(file);
        const remote = options.execution?.(conversationId);
        const brain = options.brain?.(conversationId);
        const execution = desktopExecution({
          conversationId,
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          localOnly: conversationId.startsWith("local_"),
          ...(remote ? { remote } : {}),
          ...(brain ? { brain } : {}),
          // Stella's brief continues elsewhere once her turn here has ended.
          turnEnded: async () => {
            const deadline = Date.now() + BRAIN_HANDOFF_WAIT_MS;
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              if (opened && (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run === undefined) return;
            }
          },
          brainMoved: (record) => brains.set(conversationId, { record, host: otherHost(record), at: Date.now() }),
          report: options.report,
        });
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
              cloudStored: !conversationId.startsWith("local_"),
            }),
            agents: (() => {
              const cloud = options.cloudAgents?.(conversationId);
              const { agentStarted, agentReported, agentPaused } = options;
              /** How many runs Stella has given one of its agents: the attempt a run is. */
              const attempts = async (threadId: string) => {
                if (!opened) return 1;
                const state = await opened.harness.snapshot(StellaAgentsDoc, opened.root.id, context);
                return Math.max(1, Object.values(state?.calls ?? {}).filter((call) => call.threadId === threadId).length);
              };
              return desktopAgentsHost({
                ...(options.deviceId ? { deviceId: options.deviceId } : {}),
                ...(cloud ? { cloud } : {}),
                directory: directoryFor(conversationId),
                execution: execution.host,
                beginAgentRun: async (run) => {
                  // Stella's own agents, not their subagents.
                  if (!opened || run.parentConversationId !== opened.root.id) return;
                  await noteAgentThread(run.threadId, conversationId);
                  const agent = (await opened.harness.snapshot(StellaAgentsDoc, opened.root.id, context))?.agents[run.threadId];
                  agentStarted?.({
                    conversationId,
                    threadId: run.threadId,
                    description: agent?.description ?? run.threadId,
                    attempt: await attempts(run.threadId),
                  });
                },
                // Stella reads them where she runs: here, or as a note placed there.
                deliverReport: async (report, context) => {
                  if (report.settled) return;
                  if (await noteOnBrain(conversationId, report.requestId, report.text)) return;
                  // The harness is open by then: reports run once it resumes.
                  const root = await harness.conversation(report.rootConversationId, context);
                  await root?.submit(
                    { type: "input", content: report.text, whenBusy: "followUp", requestId: report.requestId },
                    context,
                  );
                },
                deliverNote: async (note, context) => {
                  if (await noteOnBrain(conversationId, note.requestId, note.text)) return;
                  const root = await harness.conversation(note.rootConversationId, context);
                  if (!root) throw new Error("Stella is not reachable from here.");
                  // Read by the model, never shown: the user did not write it.
                  const hidden: TextContent & { stella: { hidden: true } } = { type: "text", text: note.text, stella: { hidden: true } };
                  await root.submit({ type: "input", content: [hidden], whenBusy: "followUp", requestId: note.requestId }, context);
                },
                ...(agentReported
                  ? {
                      agentReported: (agent) => {
                        void (async () => {
                          const attempt = await attempts(agent.threadId);
                          const record = opened
                            ? (await opened.harness.snapshot(StellaAgentsDoc, opened.root.id, context))?.agents[agent.threadId]
                            : undefined;
                          const live =
                            opened && record && !record.remote
                              ? await opened.harness.snapshot(LiveDoc, record.conversationId as ConversationId, context)
                              : undefined;
                          agentReported({ conversationId, ...agent, attempt, running: live?.run !== undefined });
                        })().catch((error: unknown) => options.report(error));
                      },
                    }
                  : {}),
                ...(agentPaused
                  ? {
                      agentPaused: async (agent) => {
                        agentPaused({ conversationId, ...agent, attempt: await attempts(agent.threadId) });
                      },
                    }
                  : {}),
              });
            })(),
            ...(options.tools ? { tools: placedTools(options.tools(conversationId), execution, () => opened) } : {}),
            // An agent's file and shell tools run here, or wherever its tools were moved.
            extensions: [desktopCoding(execution.run)],
            env: environments.env,
            onReport: options.report,
          },
          context,
        );
        const orchestrator = orchestratorAgent(stellaModelRef("orchestrator"));
        const root = await harness.root(context, { agent: orchestrator });
        // A conversation from an older build keeps up with what the orchestrator is offered.
        if (offersAgentTools(await root.agent(context))) await root.configure(orchestrator, context);
        // A conversation kept on this computer starts with what the agent
        // loops' chat log holds (imported as the mirror starts), and keeps up with it.
        const log = options.localLog?.(conversationId);
        const localLog = log ? await localLogMirror({ harness, root, log, report: options.report, context }) : undefined;
        // Recovered work needs its models: a Stella alias waits for sign-in; a
        // model on the user's own key is ready at once.
        const rootModel = (await root.agent(context)).model;
        for (const agent of Object.values((await harness.snapshot(StellaAgentsDoc, root.id, context))?.agents ?? {})) {
          if (agent.remote) continue;
          const model = (await (await harness.conversation(agent.conversationId as ConversationId, context))?.agent(context))?.model;
          if (model && model.provider !== STELLA_PROVIDER_ID) byok.restore(model);
        }
        if (rootModel && rootModel.provider !== STELLA_PROVIDER_ID) {
          byok.restore(rootModel);
          void harness.resume();
        } else {
          void waitForProvider(aliasOf(rootModel)).then(() => harness.resume());
        }
        const journal = options.journal?.(conversationId);
        const mirror = journal
          ? await journalMirror({
              harness,
              root,
              journal,
              report: options.report,
              // A turn running elsewhere shows as running to whoever watches.
              onRemoteTurns: (turns) => {
                if (opened?.watchers) options.emit({ conversationId, events: [{ type: "remote_turns", turns }] });
              },
              context,
            })
          : undefined;
        void mirror?.importNow().catch((error: unknown) => options.report(error));
        const idleCheck = setInterval(() => {
          void (async () => {
            const inspection = await harness.inspect(context);
            // A cloud agent still working is work here too: its report comes
            // back through the journal, for this computer to answer.
            const awaitingCloud = mirror
              ? (await agentRecords(context)).some((agent) => agent.placement.kind === "cloud" && agent.status === "running")
              : false;
            await markActive(
              conversationId,
              inspection.tasks.length > 0 || inspection.submissions.length > 0 || awaitingCloud,
            );
            // While someone looks at it, or a report is due, what the journal
            // gained shows up here.
            if (opened?.watchers || awaitingCloud) await mirror?.importNow();
          })().catch((error: unknown) => options.report(error));
        }, IDLE_CHECK_MS);
        idleCheck.unref?.();
        let following = false;
        const followCheck = setInterval(() => {
          if (!mirror || following || !opened) return;
          const watched =
            opened.watchers > 0 && (mirror.remoteTurns().length > 0 || Date.now() < opened.followUntil);
          // While a turn of this computer's is open, a Stop from another device ends it here.
          if (!watched && !mirror.turnOpen()) return;
          following = true;
          void mirror
            .importNow()
            .catch((error: unknown) => options.report(error))
            .finally(() => {
              following = false;
            });
        }, FOLLOW_MS);
        followCheck.unref?.();
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
          ...(localLog ? { localLog } : {}),
          execution,
          watchers: 0,
          idleCheck,
          followCheck,
          followUntil: 0,
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
   * Events as clients receive them, a snapshot's entries cut to its newest
   * page: older context (all of a long conversation's imported history,
   * until pi first compacts it) is paged in like the rest of the history.
   */
  const eventsForClients = (events: readonly PiChatEvent[]): PiChatEvent[] =>
    piEventsForClients(
      events.map((event) =>
        event.type === "snapshot" ? { ...event, entries: piEntriesForClients(event.entries, CLIENT_PAGE_BYTES).entries } : event,
      ),
    );

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
      options.emit({ conversationId, events: eventsForClients(events as unknown as PiChatEvent[]) });
    });
    if (previous) {
      options.emit({ conversationId, events: eventsForClients([stream.snapshot as unknown as PiChatEvent]) });
      await previous.stop().catch(() => undefined);
    }
    return stream;
  };

  const watch = async (conversationId: string): Promise<PiChatWatchResult> => {
    const chat = await open(conversationId);
    // What another engine said here since shows too.
    await chat.localLog?.importNow().catch((error: unknown) => options.report(error));
    chat.watchers += 1;
    const stream = await attach(conversationId, chat);
    const { entries, hasOlder } = await history(chat);
    const [snapshot] = eventsForClients([stream.snapshot as unknown as PiChatEvent]) as [PiChatWatchResult["snapshot"]];
    return {
      snapshot: { ...snapshot, entries: mergePiEntries(entries, snapshot.entries) },
      hasOlder,
      remote: chat.mirror?.remoteTurns() ?? [],
    };
  };

  /**
   * Stella's greeting after onboarding, as a reply in the conversation: the
   * model reads it like its own words, and it stays on this computer, as the
   * agent loops kept it (`localOnly`: the journal mirror skips it).
   */
  const welcome = async (conversationId: string, message: string): Promise<void> => {
    const text = message.trim();
    if (!text) return;
    const chat = await open(conversationId);
    const reply = writtenReply(text, Date.now(), "welcome");
    await chat.root.submit(
      {
        type: "write",
        requestId: `welcome:${randomUUID()}`,
        entry: { kind: "pi.assistant", model: [reply], data: { localOnly: true } },
      },
      context,
    );
  };

  /**
   * The local files Stella linked in a conversation: in its replies and in
   * its agents' words. Only what Stella wrote grants a paired phone a file,
   * never what a user or a tool said.
   */
  const linkedFiles = async (conversationId: string): Promise<{ paths: string[] }> => {
    const chat = await open(conversationId);
    const page = await chat.root.entries({}, LINKED_FILE_ENTRIES, undefined, context);
    const texts: string[] = [];
    for (const entry of page.items as unknown as PiEntry[]) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.assistant" && message?.role === "assistant") texts.push(piMessageText(message));
    }
    for (const agent of await chat.agentRecords(context)) texts.push(...agent.assistantMessages);
    return { paths: [...new Set(texts.flatMap((text) => extractLocalFileLinkPaths(text)))] };
  };

  /** A turn of this conversation was placed elsewhere: read the journal closely until it shows. */
  const follow = async (conversationId: string): Promise<void> => {
    const chat = await open(conversationId);
    chat.followUntil = Date.now() + FOLLOW_WINDOW_MS;
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
   * A conversation answers with what was said elsewhere too: one stored in
   * the cloud with other devices' turns, imported first, waiting at most a
   * moment for the journal; one kept on this computer with another engine's.
   */
  const caughtUp = async (chat: Chat): Promise<void> => {
    await chat.localLog?.importNow().catch((error: unknown) => options.report(error));
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
    sent: { locale?: string; followSender?: boolean } = {},
  ) => {
    // Stella answers where her brain is; the app places a send there instead,
    // and sends it here when that host could not take it.
    if (!sent.followSender) {
      const placement = await brainPlacement(conversationId);
      if (!placement.here) throw new Error(elsewhere(placement));
    }
    // The model the user picked: one of Stella's, or one on their own key.
    const model = await pickedModel();
    const chat = await open(conversationId);
    const agent = await chat.root.agent(context);
    const thinkingLevel = options.thinkingLevel?.() ?? "off";
    if (
      agent.model?.provider !== model.provider ||
      agent.model?.modelId !== model.modelId ||
      agent.thinkingLevel !== thinkingLevel
    ) {
      await chat.root.configure({ model, thinkingLevel }, context);
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
    await chat.localLog?.importNow().catch((error: unknown) => options.report(error));
    await ensureModel((await chat.root.agent(context)).model);
    chat.refreshTools();
    await markActive(conversationId, true);
    return chat;
  };

  /** Chats another device placed here, by placement run id, until they settle (`cancelPlacement`). */
  const placements = new Map<string, Placement>();
  type Placement = { chat?: Chat; submission?: Submission; canceled?: true };

  /** Withdraw a placed chat's input while it waits, or stop the run answering it. */
  const stopPlacement = async ({ chat, submission }: Placement) => {
    if (!chat || !submission) return;
    const withdrawn = await chat.harness.abortSubmission(submission.id, context, chat.root.id);
    if (withdrawn === "already_placed") await chat.root.abort(context);
  };

  /**
   * A turn the host starts (a schedule fire, a watch escalation, a chat
   * another device placed here): its prompt shown as the user's only when
   * the user wrote it, answered after whatever the conversation is doing.
   * Settles with the answer's text.
   */
  const automation = async (
    conversationId: string,
    turn: {
      requestId: string;
      prompt: string;
      /** The input as prepared (attached images and files); else `prompt`. */
      content?: UserInput;
      visible: boolean;
      rejectIfBusy?: boolean;
      /** A chat another device placed here, cancellable by this id. */
      placementRunId?: string;
      /** The conversation's events while the turn is open (a voice call narrates its tools). */
      observe?: (events: PiChatEvent[]) => void;
    },
  ): Promise<{ status: "ok"; finalText: string } | { status: "busy" | "error"; finalText: ""; error: string }> => {
    const { observe, placementRunId } = turn;
    // A chat placed here is for this computer; anything else waits for where
    // Stella is, unless that host can't take turns now (then it runs here).
    if (!placementRunId) {
      const where = await brainPlacement(conversationId);
      if (!where.here) return { status: "error", finalText: "", error: elsewhere(where) };
    }
    // Before anything awaits, so a cancel that lands while the conversation opens still holds.
    const placement: Placement = {};
    if (placementRunId) placements.set(placementRunId, placement);
    try {
      const chat = await ready(conversationId);
      placement.chat = chat;
      const observer = observe ? await watchEvents(chat.harness, chat.root.id, context) : undefined;
      observer?.start(async (events) => observe?.(events as unknown as PiChatEvent[]));
      try {
        return await automationTurn(chat, turn);
      } finally {
        await observer?.stop().catch(() => undefined);
      }
    } finally {
      if (placementRunId && placements.get(placementRunId) === placement) placements.delete(placementRunId);
    }
  };

  const automationTurn = async (
    chat: Chat,
    turn: {
      requestId: string;
      prompt: string;
      content?: UserInput;
      visible: boolean;
      rejectIfBusy?: boolean;
      placementRunId?: string;
    },
  ): Promise<{ status: "ok"; finalText: string } | { status: "busy" | "error"; finalText: ""; error: string }> => {
    await caughtUp(chat);
    const placement = turn.placementRunId ? placements.get(turn.placementRunId) : undefined;
    if (placement?.canceled) return { status: "error", finalText: "", error: "Canceled." };
    let submission;
    try {
      submission = await chat.root.submit(
        {
          type: "input",
          // A prompt the user did not write is read by the model, not shown.
          content:
            turn.content ??
            (turn.visible ? turn.prompt : [{ type: "text", text: turn.prompt, stella: { hidden: true } } as TextContent]),
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
    if (placement) {
      placement.submission = submission;
      if (placement.canceled) await stopPlacement(placement);
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
        // an agent's report or note, or a prompt the app wrote.
        const text = piUserView(message).text || ((message as PiUserMessage).source === "voice" ? piMessageText(message) : "");
        if (text.trim() && !isPiAgentText(text)) {
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
      agents: records.map(({ placement: _placement, paused: _paused, ...agent }) => agent),
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
    // Before anything awaits, so a cancel that lands while the conversation opens still holds.
    const placed = { runKey: run.runKey, cancel: new AbortController() };
    placedRuns.set(run.agentKey, placed);
    try {
      const chat = await ready(conversationId);
      return await chat.runPlacedAgent({ ...run, signal: placed.cancel.signal }, context);
    } finally {
      if (placedRuns.get(run.agentKey) === placed) placedRuns.delete(run.agentKey);
    }
  };

  /** A message for an agent placed here, from the host that placed it; false when it is not running here. */
  const steerPlacedAgent = async (message: { key: string; agentKey: string; message: string }): Promise<boolean> => {
    const conversationId = placedIn.get(message.agentKey);
    if (!conversationId) return false;
    return await (await open(conversationId)).steerPlacedAgent(message, context);
  };

  /** Stop a run of an agent placed here, for the host that placed it; false when that run is not going here. */
  const cancelPlacedAgent = (agentKey: string, runKey: string): boolean => {
    const placed = placedRuns.get(agentKey);
    if (placed?.runKey !== runKey) return false;
    placed.cancel.abort();
    return true;
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
    cancelPlacedAgent,
    voiceTranscript,
    voiceHistory,
    /**
     * Stop a chat another device placed here: withdraw it while it waits,
     * or stop the run answering it.
     */
    async cancelPlacement(placementRunId: string): Promise<{ canceled: boolean }> {
      const placement = placements.get(placementRunId);
      if (!placement) return { canceled: false };
      placement.canceled = true;
      await stopPlacement(placement);
      return { canceled: true };
    },
    /**
     * A message for one of Stella's agents from another device (a paired
     * phone, the cloud's Stella): it steers the agent while it works or
     * starts its next run, and the report goes to Stella here.
     */
    async deliverAgentMessage(
      threadId: string,
      text: string,
      messageId: string,
    ): Promise<"steered" | "resumed" | "not_found"> {
      const conversationId = (await threadIndex())[threadId];
      if (!conversationId || !text.trim()) return "not_found";
      const chat = await ready(conversationId);
      const record = (await chat.agentRecords(context)).find((agent) => agent.threadId === threadId);
      if (!record) return "not_found";
      await chat.messageAgent(
        { key: `device:${messageId.trim() || crypto.randomUUID()}`, threadId, message: text, fromOrchestrator: true },
        context,
      );
      return record.status === "running" ? "steered" : "resumed";
    },
    async deliverReport(conversationId: string, report: { requestId: string; text: string }): Promise<void> {
      if (await noteOnBrain(conversationId, report.requestId, report.text)) return;
      const chat = await ready(conversationId);
      await caughtUp(chat);
      const hidden: TextContent & { stella: { hidden: true } } = { type: "text", text: report.text, stella: { hidden: true } };
      await chat.root.submit({ type: "input", content: [hidden], whenBusy: "followUp", requestId: report.requestId }, context);
    },
    /**
     * Where one of Stella's agents on this computer stands, for settling the
     * cloud's record of it: undefined when no conversation here started it.
     * A run a previous process left unfinished reads as running: it resumes.
     */
    async agentStatus(
      threadId: string,
    ): Promise<{ conversationId: string; status: "running" | "completed" | "error" | "canceled"; attempt: number } | undefined> {
      const conversationId = (await threadIndex())[threadId];
      if (!conversationId) return undefined;
      const chat = await open(conversationId);
      const record = (await chat.agentRecords(context)).find((agent) => agent.threadId === threadId);
      if (!record) return undefined;
      const calls = Object.values((await chat.harness.snapshot(StellaAgentsDoc, chat.root.id, context))?.calls ?? {});
      return {
        conversationId,
        status: record.paused ? "canceled" : record.status,
        attempt: Math.max(1, calls.filter((call) => call.threadId === threadId).length),
      };
    },
    /** Whether any conversation has work in flight here, so the process must stay up. */
    busy(): boolean {
      return activeNow.size > 0;
    },
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
        case "follow":
          await follow(request.conversationId);
          return { ok: true };
        case "welcome":
          await welcome(request.conversationId, request.message);
          return { ok: true };
        case "files":
          return linkedFiles(request.conversationId);
        case "brain":
          return brainPlacement(request.conversationId);
      }
    },
    async close(): Promise<void> {
      const opened = await Promise.all([...chats.values()].map((chat) => chat.catch(() => undefined)));
      chats.clear();
      for (const chat of opened) {
        if (!chat) continue;
        clearInterval(chat.idleCheck);
        clearInterval(chat.followCheck);
        await chat.mirror?.stop();
        await chat.localLog?.stop();
        await chat.execution.close();
        await chat.stream?.stop().catch(() => undefined);
        await chat.harness.close(context).catch(() => undefined);
      }
      await environments.cleanup(context);
    },
  };
}

export type DesktopChats = ReturnType<typeof desktopChats>;
