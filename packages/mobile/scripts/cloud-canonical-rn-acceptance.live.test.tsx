/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
// @ts-expect-error react-native-web ships runtime code without declarations.
import { Pressable, Text, TextInput, View } from "react-native-web";

import { grantAiConsent } from "../src/lib/ai-consent";
import { clearCachedToken, getConvexToken } from "../src/lib/auth-token";
import {
  conversationStore,
  retireCloudConversationClientAuthority,
} from "../src/lib/cloud-conversation-store";
import {
  acknowledgeDesktopChatOutbox,
  enqueueDesktopChatOutbox,
  loadDesktopChatOutbox,
  waitForDesktopChatOutboxWrites,
} from "../src/lib/desktop-chat-outbox";
import { saveChatMessages } from "../src/lib/offline-chat-storage";
import { useCloudCanonicalChatThread } from "../src/lib/use-cloud-canonical-chat-thread";
import type { CloudConversationAuthority } from "../src/lib/cloud-conversation-authority";
import type { ChatThread } from "../src/lib/use-chat-thread";

type AcceptancePhase =
  | "enqueue_response_loss"
  | "replay_reconnect_switch"
  | "clean_hydrate"
  | "generation_rotation";

type ObservationControl = {
  observations: {
    storage: Array<{
      ordinal: number;
      operation: string;
      keySha256: string;
      valueSha256?: string;
    }>;
    asyncStorageCompletions: Array<{
      ordinal: number;
      operation: string;
      keySha256: string;
      valueSha256?: string;
    }>;
    fetches: Array<{
      ordinal: number;
      phase: string;
      operation: string;
      status?: number;
      requestIdSha256?: string;
      resourceIdSha256?: string;
      responseSha256?: string;
    }>;
    socketUrls: string[];
    socketSends: Array<{
      ordinal: number;
      payloadSha256: string;
      ping: boolean;
    }>;
    appStateChanges: Array<{ ordinal: number; state: string }>;
  };
  storage: Storage & { stateSha256(): string };
  sha256(value: string | Uint8Array): string;
  armResponseLoss(): void;
  holdNextAdmissionResponse(): void;
  releaseHeldAdmissionResponse(): void;
  setIdentity(jwt: string, subject: string, sessionId: string): void;
  setVisibility(next: "visible" | "hidden"): void;
  dropLatestSocket(): void;
  closeAllSockets(): void;
  recordAsyncStorageCompletion(
    operation: "set" | "remove" | "clear",
    key: string,
    value?: string,
  ): void;
};

declare global {
  // Installed by cloud-canonical-rn-acceptance.preload.ts.
  // eslint-disable-next-line no-var
  var __STELLA_MOBILE_RN_ACCEPTANCE__: ObservationControl;
}

const control = globalThis.__STELLA_MOBILE_RN_ACCEPTANCE__;
const sha256 = control.sha256;
const OUTBOX_KEY = "stella-mobile-cloud-chat-outbox-v1";
const OUTBOX_KEY_SHA256 = sha256(OUTBOX_KEY);
const RECEIPT_MARKER = "STELLA_MOBILE_RN_ACCEPTANCE_RECEIPT=";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const stableJson = (value: unknown): string => {
  const encode = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(encode);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, encode(child)]),
    );
  };
  return JSON.stringify(encode(value));
};

const processIdSha256 = (runId: string): string =>
  sha256(`${runId}:${process.pid}`);

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`${label} timed out.`);
    await act(async () => {
      await sleep(25);
    });
  }
};

const authorityFromEnv = (
  prefix = "STELLA_MOBILE_ACCEPTANCE_",
): CloudConversationAuthority => {
  const subject = required(`${prefix}SESSION_SUBJECT`);
  const sessionId = required(`${prefix}SESSION_ID`);
  return {
    identityKey: `account:${subject}:session:${sessionId}`,
    accountScope: `account:${subject}`,
    ownerGeneration: required(`${prefix}OWNER_GENERATION`),
    conversationId: required(`${prefix}CONVERSATION_ID`),
    socketOrigin: required("STELLA_MOBILE_ACCEPTANCE_BUILDER_ORIGIN"),
  };
};

const hashAuthority = (authority: CloudConversationAuthority) => ({
  identityKeySha256: sha256(authority.identityKey),
  accountScopeSha256: sha256(authority.accountScope),
  ownerGenerationSha256: sha256(authority.ownerGeneration),
  conversationIdSha256: sha256(authority.conversationId),
  socketOriginSha256: sha256(authority.socketOrigin),
});

const hashMessages = (thread: ChatThread): string =>
  sha256(
    stableJson(
      thread.messages.map((message) => ({
        idSha256: sha256(message.id),
        role: message.role,
        textSha256: sha256(message.text),
        queued: message.queued === true,
        stopped: message.stopped === true,
      })),
    ),
  );

const instrumentAsyncStorageCompletion = () => {
  const mutable = AsyncStorage as typeof AsyncStorage & {
    setItem: typeof AsyncStorage.setItem;
    removeItem: typeof AsyncStorage.removeItem;
    clear: typeof AsyncStorage.clear;
  };
  const setItem = mutable.setItem.bind(mutable);
  const removeItem = mutable.removeItem.bind(mutable);
  const clear = mutable.clear.bind(mutable);
  mutable.setItem = async (key, value, callback) => {
    const result = await setItem(key, value, callback);
    control.recordAsyncStorageCompletion("set", key, value);
    return result;
  };
  mutable.removeItem = async (key, callback) => {
    const result = await removeItem(key, callback);
    control.recordAsyncStorageCompletion("remove", key);
    return result;
  };
  mutable.clear = async (callback) => {
    const result = await clear(callback);
    control.recordAsyncStorageCompletion("clear", "*");
    return result;
  };
};

type RenderSnapshot = {
  authorityReady: boolean;
  storageLoaded: boolean;
  sending: boolean;
  issueSha256: string | null;
  messageStateSha256: string;
  queuedCount: number;
  messageCount: number;
  draftSha256: string;
};

type MountedSurface = {
  root: Root;
  container: HTMLElement;
  snapshots: RenderSnapshot[];
  current(): ChatThread;
  render(authority: CloudConversationAuthority): Promise<void>;
  unmount(): Promise<void>;
};

const mountSurface = async (
  initialAuthority: CloudConversationAuthority,
): Promise<MountedSurface> => {
  const container = document.getElementById("root");
  assert(
    container instanceof HTMLElement,
    "RN acceptance root is unavailable.",
  );
  const root = createRoot(container);
  const snapshots: RenderSnapshot[] = [];
  let currentThread: ChatThread | null = null;

  const Surface = ({
    authority,
  }: {
    authority: CloudConversationAuthority;
  }) => {
    const thread = useCloudCanonicalChatThread(authority);
    currentThread = thread;
    useEffect(() => {
      snapshots.push({
        authorityReady: thread.authorityReady === true,
        storageLoaded: thread.storageLoaded,
        sending: thread.sending,
        issueSha256: thread.authorityIssue
          ? sha256(thread.authorityIssue.message)
          : null,
        messageStateSha256: hashMessages(thread),
        queuedCount: thread.messages.filter((message) => message.queued).length,
        messageCount: thread.messages.length,
        draftSha256: sha256(thread.draft),
      });
    });
    return (
      <View testID="acceptance-signed-in-chat">
        <TextInput
          testID="acceptance-prompt"
          accessibilityLabel="Acceptance prompt"
          value={thread.draft}
          onChangeText={thread.setDraft}
        />
        <Pressable
          testID="acceptance-send"
          accessibilityRole="button"
          accessibilityLabel="Send acceptance prompt"
          disabled={!thread.authorityReady || !thread.storageLoaded}
          onPress={thread.send}
        >
          <Text>Send</Text>
        </Pressable>
        <Text testID="acceptance-issue">
          {thread.authorityIssue?.message ?? ""}
        </Text>
      </View>
    );
  };

  const render = async (authority: CloudConversationAuthority) => {
    await act(async () => {
      root.render(<Surface authority={authority} />);
    });
  };
  await render(initialAuthority);
  return {
    root,
    container,
    snapshots,
    current: () => {
      assert(currentThread, "RN chat hook has not rendered.");
      return currentThread;
    },
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.replaceChildren();
    },
  };
};

const waitUntilReady = async (surface: MountedSurface, timeoutMs: number) => {
  await waitFor(
    () =>
      surface.current().storageLoaded &&
      surface.current().authorityReady === true,
    `Canonical RN chat authority (${stableJson(surface.snapshots.at(-1) ?? null)})`,
    timeoutMs,
  );
};

const enterPrompt = async (
  surface: MountedSurface,
  prompt: string,
  timeoutMs: number,
) => {
  const input = surface.container.querySelector(
    '[data-testid="acceptance-prompt"]',
  );
  assert(
    input instanceof HTMLInputElement,
    "RN Web TextInput was not mounted.",
  );
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  assert(setter, "The DOM input value setter is unavailable.");
  await act(async () => {
    setter.call(input, prompt);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: prompt }),
    );
  });
  await waitFor(
    () => surface.current().draft === prompt,
    "RN Web composer update",
    timeoutMs,
  );
};

const enterPromptAndSend = async (
  surface: MountedSurface,
  prompt: string,
  timeoutMs: number,
) => {
  await enterPrompt(surface, prompt, timeoutMs);
  const button = surface.container.querySelector(
    '[data-testid="acceptance-send"]',
  );
  assert(button instanceof HTMLElement, "RN Web Pressable was not mounted.");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await waitFor(
    () => surface.current().draft === "",
    "RN Web send interaction",
    timeoutMs,
  );
};

const outboxFor = (authority: CloudConversationAuthority) =>
  loadDesktopChatOutbox("cloud", {
    accountScope: authority.accountScope,
    ownerGeneration: authority.ownerGeneration,
    conversationId: authority.conversationId,
  });

const rawOutboxFor = async (authority: CloudConversationAuthority) =>
  (await loadDesktopChatOutbox("cloud")).filter(
    (row) =>
      row.authority?.accountScope === authority.accountScope &&
      row.authority.ownerGeneration === authority.ownerGeneration &&
      row.authority.conversationId === authority.conversationId,
  );

const switchIdentity = async (
  surface: MountedSurface,
  authority: CloudConversationAuthority,
  jwt: string,
  subject: string,
  sessionId: string,
  timeoutMs: number,
) => {
  control.setIdentity(jwt, subject, sessionId);
  clearCachedToken();
  retireCloudConversationClientAuthority(
    authority.accountScope,
    authority.ownerGeneration,
  );
  await surface.render(authority);
  await waitUntilReady(surface, timeoutMs);
};

const receipt = (
  operation: string,
  outcome: string,
  fields: Record<string, string | number | undefined> = {},
) => ({
  surface: "mobile-client",
  operation,
  outcome,
  ...Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  ),
});

const runEnqueueResponseLoss = async (
  authority: CloudConversationAuthority,
  runId: string,
  timeoutMs: number,
) => {
  assert(
    (await outboxFor(authority)).length === 0,
    "The enqueue storage is not fresh.",
  );
  await grantAiConsent();
  const surface = await mountSurface(authority);
  await waitUntilReady(surface, timeoutMs);
  const mountId = crypto.randomUUID();
  const prompt = `MOBILE-RN-RESPONSE-LOSS-${runId}`;
  control.armResponseLoss();
  await enterPromptAndSend(surface, prompt, timeoutMs);
  await waitFor(
    () =>
      control.observations.fetches.some(
        (entry) => entry.phase === "response-withheld",
      ),
    "Committed admission response loss",
    timeoutMs,
  );
  await waitFor(
    async () => (await outboxFor(authority)).length === 1,
    "Pending durable outbox",
    timeoutMs,
  );
  const rows = await outboxFor(authority);
  const row = rows[0]!;
  const completion = control.observations.asyncStorageCompletions.find(
    (entry) =>
      entry.operation === "set" && entry.keySha256 === OUTBOX_KEY_SHA256,
  );
  const submitStart = control.observations.fetches.find(
    (entry) => entry.phase === "start",
  );
  const serverResponse = control.observations.fetches.find(
    (entry) => entry.phase === "server-response",
  );
  const withheld = control.observations.fetches.find(
    (entry) => entry.phase === "response-withheld",
  );
  assert(completion, "AsyncStorage outbox completion was not observed.");
  assert(
    submitStart && serverResponse && withheld,
    "Admission ordering is incomplete.",
  );
  assert(
    completion.ordinal < submitStart.ordinal &&
      submitStart.ordinal < serverResponse.ordinal &&
      serverResponse.ordinal < withheld.ordinal,
    "The response-loss ordering contract failed.",
  );
  const sendIdSha256 = sha256(row.sendId);
  assert(
    submitStart.requestIdSha256 === sendIdSha256 &&
      serverResponse.requestIdSha256 === sendIdSha256,
    "The durable outbox identity did not reach admission.",
  );
  await surface.unmount();
  await waitForDesktopChatOutboxWrites();
  control.closeAllSockets();
  return {
    phase: "enqueue_response_loss",
    passed: true,
    processIdSha256: processIdSha256(runId),
    mountIdSha256: sha256(mountId),
    authority: hashAuthority(authority),
    storageStateSha256: control.storage.stateSha256(),
    promptSha256: sha256(prompt),
    sendIdSha256,
    dispatchIdSha256: withheld.resourceIdSha256,
    uiSendAccepted: true,
    asyncStorageWriteCompletedBeforeNetwork: true,
    serverCommittedBeforeResponseLoss: true,
    responseWithheldFromHook: true,
    processExitsWithPendingOutbox: true,
    ordering: {
      asyncStorageWriteCompletion: completion.ordinal,
      submitStart: submitStart.ordinal,
      serverResponse: serverResponse.ordinal,
      responseWithheld: withheld.ordinal,
    },
    receipts: [
      receipt("mobile.rn.ui-send", "accepted", {
        requestIdSha256: sendIdSha256,
        stateSha256: hashMessages(surface.current()),
      }),
      {
        surface: "mobile-http",
        operation: "mobile.execution.submit.response-loss",
        status: withheld.status,
        outcome: "committed-response-withheld",
        requestIdSha256: sendIdSha256,
        resourceIdSha256: withheld.resourceIdSha256,
        responseSha256: withheld.responseSha256,
      },
    ],
  };
};

const runReplayReconnectSwitch = async (
  authority: CloudConversationAuthority,
  runId: string,
  timeoutMs: number,
) => {
  const expectedPriorState = required(
    "STELLA_MOBILE_RN_EXPECTED_PRIOR_STATE_SHA256",
  );
  assert(
    control.storage.stateSha256() === expectedPriorState,
    "The replay process did not receive the exact prior Web Storage state.",
  );
  const priorRows = await outboxFor(authority);
  assert(
    priorRows.length === 1,
    "The replay process did not recover one outbox row.",
  );
  const sendIdSha256 = sha256(priorRows[0]!.sendId);
  const surface = await mountSurface(authority);
  const mountId = crypto.randomUUID();
  await waitUntilReady(surface, timeoutMs);
  const restoredQueuedMessage = surface.snapshots.some(
    (snapshot) => snapshot.queuedCount > 0,
  );
  await waitFor(
    () =>
      control.observations.fetches.some(
        (entry) =>
          entry.phase === "server-response" &&
          entry.requestIdSha256 === sendIdSha256,
      ),
    "Durable outbox replay admission",
    timeoutMs,
  );
  const replayResponse = control.observations.fetches.find(
    (entry) =>
      entry.phase === "server-response" &&
      entry.requestIdSha256 === sendIdSha256,
  )!;
  const store = conversationStore(
    authority.conversationId,
    authority.accountScope,
    authority.ownerGeneration,
  );
  await waitFor(
    () => {
      const state = store.getSnapshot();
      return (
        state.status === "live" &&
        state.epoch !== null &&
        state.records.length > 0
      );
    },
    "Canonical cursor before transport drop",
    timeoutMs,
  );
  const beforeDrop = store.getSnapshot();
  const socketCountBeforeDrop = control.observations.socketUrls.length;
  control.dropLatestSocket();
  await waitFor(
    () => control.observations.socketUrls.length > socketCountBeforeDrop,
    "WebSocket cursor reconnect",
    timeoutMs,
  );
  await waitFor(
    () => store.getSnapshot().status === "live",
    "WebSocket live recovery",
    timeoutMs,
  );
  const reconnectUrl = new URL(control.observations.socketUrls.at(-1)!);
  const resumedWithCursor = reconnectUrl.searchParams.has("since");
  const resumedWithEpoch = reconnectUrl.searchParams.has("epoch");
  await waitFor(
    () =>
      control.observations.fetches.some(
        (entry) =>
          entry.phase === "status-terminal" &&
          entry.resourceIdSha256 === replayResponse.resourceIdSha256,
      ),
    "Server terminal placement status",
    timeoutMs,
  );
  const terminalStatus = control.observations.fetches.find(
    (entry) =>
      entry.phase === "status-terminal" &&
      entry.resourceIdSha256 === replayResponse.resourceIdSha256,
  )!;
  await waitFor(
    () =>
      control.observations.asyncStorageCompletions.some(
        (entry) =>
          entry.operation === "remove" &&
          entry.keySha256 === OUTBOX_KEY_SHA256 &&
          entry.ordinal > terminalStatus.ordinal,
      ),
    "Durable outbox acknowledgement after terminal status",
    timeoutMs,
  );
  const terminalAcknowledgement =
    control.observations.asyncStorageCompletions.find(
      (entry) =>
        entry.operation === "remove" &&
        entry.keySha256 === OUTBOX_KEY_SHA256 &&
        entry.ordinal > terminalStatus.ordinal,
    )!;
  assert(
    (await outboxFor(authority)).length === 0,
    "Terminal acknowledgement did not clear the durable outbox.",
  );
  await waitFor(
    () => {
      const state = store.getSnapshot();
      return (
        state.status === "live" &&
        state.records.some(
          (record) => record.kind === "turn" && record.phase !== "started",
        )
      );
    },
    "Canonical terminal journal",
    timeoutMs,
  );
  const afterReconnect = store.getSnapshot();
  const sequences = afterReconnect.records.map((record) => record.seq);
  const uniqueSequences = new Set(sequences);
  const gapless = sequences.every(
    (sequence, index) => index === 0 || sequence === sequences[index - 1]! + 1,
  );
  assert(
    uniqueSequences.size === sequences.length,
    "Reconnect duplicated journal rows.",
  );
  assert(gapless, "Reconnect exposed a journal gap.");
  assert(
    beforeDrop.epoch === afterReconnect.epoch,
    "Reconnect changed the live journal epoch.",
  );
  assert(
    resumedWithCursor && resumedWithEpoch,
    "Reconnect omitted its live cursor.",
  );
  const recoveredRecordCount = Math.max(
    0,
    afterReconnect.records.length - beforeDrop.records.length,
  );
  assert(
    recoveredRecordCount > 0,
    "Reconnect did not recover a canonical record created after the drop.",
  );

  const pingCountBefore = control.observations.socketSends.filter(
    (entry) => entry.ping,
  ).length;
  control.setVisibility("hidden");
  await act(async () => sleep(20));
  control.setVisibility("visible");
  await waitFor(
    () =>
      control.observations.socketSends.filter((entry) => entry.ping).length >
      pingCountBefore,
    "AppState foreground wake",
    timeoutMs,
  );

  const secondary = authorityFromEnv("STELLA_MOBILE_ACCEPTANCE_SECONDARY_");
  assert(
    secondary.accountScope !== authority.accountScope,
    "Secondary acceptance identity must be a different account.",
  );
  const canaryId = `mobile:${Date.now()}:${crypto.randomUUID()}`;
  await enqueueDesktopChatOutbox("cloud", {
    sendId: canaryId,
    userMessageId: canaryId,
    text: `A-OUTBOX-ISOLATION-${runId}`,
    displayText: `A-OUTBOX-ISOLATION-${runId}`,
    createdAt: Date.now(),
    attachments: [],
    authority: {
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
    },
  });
  await switchIdentity(
    surface,
    secondary,
    required("STELLA_MOBILE_ACCEPTANCE_SECONDARY_JWT"),
    required("STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_SUBJECT"),
    required("STELLA_MOBILE_ACCEPTANCE_SECONDARY_SESSION_ID"),
    timeoutMs,
  );
  const secondaryActiveRows = await outboxFor(secondary);
  assert(
    secondaryActiveRows.length === 0,
    "Account B observed account A's outbox.",
  );
  const retainedAWhileB = await outboxFor(authority);
  assert(
    retainedAWhileB.some((row) => row.sendId === canaryId),
    "Account A's outbox partition was not retained while B was mounted.",
  );
  await acknowledgeDesktopChatOutbox("cloud", new Set([canaryId]), {
    accountScope: authority.accountScope,
    ownerGeneration: authority.ownerGeneration,
    conversationId: authority.conversationId,
  });
  await switchIdentity(
    surface,
    authority,
    required("STELLA_MOBILE_RN_ACCEPTANCE_JWT"),
    required("STELLA_MOBILE_RN_ACCEPTANCE_SESSION_SUBJECT"),
    required("STELLA_MOBILE_RN_ACCEPTANCE_SESSION_ID"),
    timeoutMs,
  );
  const restoredA = await outboxFor(authority);
  assert(
    restoredA.length === 0,
    "A→B→A did not preserve A's acknowledged outbox state.",
  );

  const localFallbackId = `local-fallback-${crypto.randomUUID()}`;
  await saveChatMessages("cloud", [
    {
      id: localFallbackId,
      role: "assistant",
      text: `LOCAL-FALLBACK-MUST-NOT-RENDER-${runId}`,
      createdAt: Date.now(),
    },
  ]);
  const submitCountBeforeOutage = control.observations.fetches.filter(
    (entry) => entry.phase === "start",
  ).length;
  const unavailableAuthority = {
    ...authority,
    identityKey: `${authority.identityKey}:outage`,
    conversationId: `outage-${sha256(runId).slice(0, 24)}`,
    socketOrigin: "ws://127.0.0.1:1",
  };
  await surface.render(unavailableAuthority);
  await waitFor(
    () => surface.current().authorityIssue !== null,
    "Explicit cloud-only outage",
    timeoutMs,
  );
  const outagePrompt = `CLOUD-ONLY-OUTAGE-${runId}`;
  await enterPrompt(surface, outagePrompt, timeoutMs);
  const localFallbackCount = surface
    .current()
    .messages.filter((message) => message.id === localFallbackId).length;
  const outageIssueSha256 = sha256(surface.current().authorityIssue!.message);
  const button = surface.container.querySelector(
    '[data-testid="acceptance-send"]',
  );
  assert(button instanceof HTMLElement, "Outage send surface is unavailable.");
  assert(
    button.getAttribute("aria-disabled") === "true",
    "Cloud outage did not disable its UI send action.",
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await act(async () => sleep(50));
  const submitCountAfterOutage = control.observations.fetches.filter(
    (entry) => entry.phase === "start",
  ).length;
  assert(
    localFallbackCount === 0,
    "Cloud outage rendered local transcript fallback.",
  );
  assert(
    submitCountAfterOutage === submitCountBeforeOutage,
    "Cloud outage dispatched through a fallback transport.",
  );
  assert(
    surface.current().draft === outagePrompt,
    "Blocked cloud send consumed the user's nonempty draft.",
  );

  await surface.unmount();
  control.closeAllSockets();
  return {
    phase: "replay_reconnect_switch",
    passed: true,
    processIdSha256: processIdSha256(runId),
    mountIdSha256: sha256(mountId),
    authority: hashAuthority(authority),
    secondaryAuthority: hashAuthority(secondary),
    storageStateSha256: control.storage.stateSha256(),
    sendIdSha256,
    dispatchIdSha256: replayResponse.resourceIdSha256,
    restoredQueuedMessage,
    replayCollapsedToCommittedDispatch:
      replayResponse.requestIdSha256 === sendIdSha256,
    acknowledgedAfterTerminal:
      terminalAcknowledgement.ordinal > terminalStatus.ordinal,
    priorStateSha256: expectedPriorState,
    terminalAcknowledgementOrdering: {
      serverTerminalStatus: terminalStatus.ordinal,
      asyncStorageOutboxRemoval: terminalAcknowledgement.ordinal,
    },
    cursorReconnect: {
      sameMountedClient: true,
      resumedWithCursor,
      resumedWithEpoch,
      epochStable: beforeDrop.epoch === afterReconnect.epoch,
      gapCount: gapless ? 0 : 1,
      duplicateCount: sequences.length - uniqueSequences.size,
      recoveredRecordCount,
    },
    appState: {
      backgroundCallbacks: control.observations.appStateChanges.filter(
        (entry) => entry.state === "background",
      ).length,
      activeCallbacks: control.observations.appStateChanges.filter(
        (entry) => entry.state === "active",
      ).length,
      foregroundWakeObserved: true,
    },
    identitySwitch: {
      actualHookRerendered: true,
      accountsDiffer: secondary.accountScope !== authority.accountScope,
      aToBToA: true,
      outboxIsolated:
        secondaryActiveRows.length === 0 && retainedAWhileB.length === 1,
      aAcknowledgementPreserved: restoredA.length === 0,
      serverAuthorityFenceProved: false,
    },
    noLocalFallback: {
      explicitIssueSha256: outageIssueSha256,
      attemptedPromptSha256: sha256(outagePrompt),
      blockedSendPreservedDraft: surface.current().draft === outagePrompt,
      localFallbackCount,
      fallbackNetworkCount: submitCountAfterOutage - submitCountBeforeOutage,
    },
    messageStateSha256: hashMessages(surface.current()),
    receipts: [
      {
        surface: "mobile-http",
        operation: "mobile.execution.submit.replay",
        status: replayResponse.status,
        outcome: "idempotent-replay",
        requestIdSha256: sendIdSha256,
        resourceIdSha256: replayResponse.resourceIdSha256,
        responseSha256: replayResponse.responseSha256,
      },
      receipt("mobile.rn.websocket.cursor-reconnect", "gapless", {
        stateSha256: sha256(stableJson(sequences)),
        count: sequences.length,
      }),
      receipt("mobile.rn.app-state", "background-active", {
        count: control.observations.appStateChanges.length,
      }),
      receipt("mobile.rn.identity-switch", "a-b-a", {
        stateSha256: sha256(
          stableJson([
            authority.accountScope,
            secondary.accountScope,
            authority.accountScope,
          ]),
        ),
      }),
      receipt("mobile.rn.no-local-fallback", "explicit-error", {
        responseSha256: outageIssueSha256,
        count: localFallbackCount,
      }),
    ],
  };
};

const runCleanHydrate = async (
  authority: CloudConversationAuthority,
  runId: string,
  timeoutMs: number,
) => {
  assert(control.storage.length === 0, "Clean hydration storage is not empty.");
  await grantAiConsent();
  const surface = await mountSurface(authority);
  const mountId = crypto.randomUUID();
  await waitUntilReady(surface, timeoutMs);
  const promptSha256 = sha256(`MOBILE-RN-RESPONSE-LOSS-${runId}`);
  await waitFor(
    () =>
      surface
        .current()
        .messages.some(
          (message) =>
            message.role === "user" && sha256(message.text) === promptSha256,
        ),
    "Clean canonical prompt hydration",
    timeoutMs,
  );
  const canonicalMessages = surface.current().messages;
  const projectedUser = canonicalMessages.some(
    (message) =>
      message.role === "user" && sha256(message.text) === promptSha256,
  );
  const projectedAssistant = canonicalMessages.some(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  assert(
    projectedUser && projectedAssistant,
    "Clean storage did not rebuild the canonical turn.",
  );
  const messageStateSha256 = hashMessages(surface.current());
  await surface.unmount();
  control.closeAllSockets();
  await AsyncStorage.clear();
  const canaryId = `mobile:${Date.now()}:${crypto.randomUUID()}`;
  await enqueueDesktopChatOutbox("cloud", {
    sendId: canaryId,
    userMessageId: canaryId,
    text: `GENERATION-CANARY-${runId}`,
    displayText: `GENERATION-CANARY-${runId}`,
    createdAt: Date.now(),
    attachments: [],
    authority: {
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
    },
  });
  await waitForDesktopChatOutboxWrites();
  return {
    phase: "clean_hydrate",
    passed: true,
    processIdSha256: processIdSha256(runId),
    mountIdSha256: sha256(mountId),
    authority: hashAuthority(authority),
    cleanNamespaceStartedEmpty: true,
    canonicalUserProjected: projectedUser,
    canonicalAssistantProjected: projectedAssistant,
    localFallbackCount: 0,
    messageStateSha256,
    generationCanaryOutboxStateSha256: control.storage.stateSha256(),
    generationCanarySendIdSha256: sha256(canaryId),
    receipts: [
      receipt("mobile.rn.clean-hydration", "canonical", {
        stateSha256: messageStateSha256,
        count: canonicalMessages.length,
      }),
      receipt("mobile.rn.generation-canary", "durable", {
        requestIdSha256: sha256(canaryId),
        stateSha256: control.storage.stateSha256(),
        count: 1,
      }),
    ],
  };
};

const runGenerationRotation = async (
  oldAuthority: CloudConversationAuthority,
  runId: string,
  timeoutMs: number,
) => {
  const expectedPriorState = required("EXPECTED_PRIOR_STATE_SHA256");
  assert(
    control.storage.stateSha256() === expectedPriorState,
    "Generation canary storage does not match the sealed prior state.",
  );
  const oldRows = await outboxFor(oldAuthority);
  assert(oldRows.length === 1, "Old-generation canary is unavailable.");
  const canarySendIdSha256 = sha256(oldRows[0]!.sendId);
  const oldStore = conversationStore(
    oldAuthority.conversationId,
    oldAuthority.accountScope,
    oldAuthority.ownerGeneration,
  );
  control.holdNextAdmissionResponse();
  const surface = await mountSurface(oldAuthority);
  const mountId = crypto.randomUUID();
  await waitUntilReady(surface, timeoutMs);
  await waitFor(
    () =>
      control.observations.fetches.some(
        (entry) =>
          entry.phase === "server-response" &&
          entry.requestIdSha256 === canarySendIdSha256,
      ),
    "Old-generation held admission",
    timeoutMs,
  );
  assert(
    oldStore.getSnapshot().status === "live",
    "Old-generation socket was not live at the reset barrier.",
  );

  const harnessRoot = realpathSync(
    required("STELLA_MOBILE_ACCEPTANCE_HARNESS_ROOT"),
  );
  const barrierDirectory = path.resolve(
    required("STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR"),
  );
  const relativeBarrier = path.relative(harnessRoot, barrierDirectory);
  assert(
    relativeBarrier !== "" &&
      !relativeBarrier.startsWith("..") &&
      !path.isAbsolute(relativeBarrier),
    "Generation barrier must be inside the isolated harness root.",
  );
  await mkdir(barrierDirectory, { recursive: true, mode: 0o700 });
  const readyFile = path.join(barrierDirectory, "ready.json");
  const continueFile = path.join(barrierDirectory, "continue.json");
  assert(!existsSync(readyFile), "Generation READY marker already exists.");
  const temporaryReady = `${readyFile}.${process.pid}.tmp`;
  await writeFile(
    temporaryReady,
    JSON.stringify({
      version: 1,
      processIdSha256: processIdSha256(runId),
      mountIdSha256: sha256(mountId),
      accountScopeSha256: sha256(oldAuthority.accountScope),
      ownerGenerationSha256: sha256(oldAuthority.ownerGeneration),
      conversationIdSha256: sha256(oldAuthority.conversationId),
      canarySendIdSha256,
      serverAdmissionResponseHeld: true,
      staleSocketLive: true,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(temporaryReady, 0o600);
  await rename(temporaryReady, readyFile);
  await waitFor(
    () => existsSync(continueFile),
    "Owner-generation rotation barrier",
    timeoutMs,
  );
  const continuation = JSON.parse(await readFile(continueFile, "utf8")) as {
    ownerGeneration?: unknown;
    conversationId?: unknown;
  };
  await unlink(continueFile);
  const newOwnerGeneration =
    typeof continuation.ownerGeneration === "string"
      ? continuation.ownerGeneration.trim()
      : "";
  const newConversationId =
    typeof continuation.conversationId === "string"
      ? continuation.conversationId.trim()
      : "";
  assert(newOwnerGeneration, "Rotation continuation omitted owner generation.");
  assert(newConversationId, "Rotation continuation omitted conversation id.");
  assert(
    newOwnerGeneration !== oldAuthority.ownerGeneration,
    "Owner generation did not rotate.",
  );
  const authority = {
    ...oldAuthority,
    identityKey: `${oldAuthority.identityKey}:generation:${sha256(newOwnerGeneration)}`,
    ownerGeneration: newOwnerGeneration,
    conversationId: newConversationId,
  };
  await surface.render(authority);
  await waitUntilReady(surface, timeoutMs);
  await waitFor(
    async () => (await rawOutboxFor(oldAuthority)).length === 0,
    "Stale generation outbox purge",
    timeoutMs,
  );
  const newStore = conversationStore(
    authority.conversationId,
    authority.accountScope,
    authority.ownerGeneration,
  );
  const oldState = oldStore.getSnapshot();
  assert(
    newStore !== oldStore,
    "Owner generation reused the previous conversation store.",
  );
  assert(
    oldState.status === "idle" &&
      oldState.epoch === null &&
      oldState.records.length === 0,
    "Stale-generation store/socket was not synchronously retired.",
  );

  const generationGuardId = `mobile:${Date.now()}:${crypto.randomUUID()}`;
  await enqueueDesktopChatOutbox("cloud", {
    sendId: generationGuardId,
    userMessageId: generationGuardId,
    text: `NEW-GENERATION-GUARD-${runId}`,
    displayText: `NEW-GENERATION-GUARD-${runId}`,
    createdAt: Date.now(),
    attachments: [],
    authority: {
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
    },
  });
  assert(
    (await rawOutboxFor(authority)).length === 1,
    "New-generation callback guard was not durable.",
  );
  control.releaseHeldAdmissionResponse();
  await waitFor(
    () =>
      control.observations.fetches.some(
        (entry) =>
          entry.phase === "response-released" &&
          entry.requestIdSha256 === canarySendIdSha256,
      ),
    "Held old-generation response delivery after rerender",
    timeoutMs,
  );
  await act(async () => sleep(50));
  await waitForDesktopChatOutboxWrites();
  await waitFor(
    () => surface.current().sending === false,
    "New-generation idle state after stale callback",
    timeoutMs,
  );
  const releasedOldCallbacks = control.observations.fetches.filter(
    (entry) =>
      entry.phase === "response-released" &&
      entry.requestIdSha256 === canarySendIdSha256,
  ).length;
  const oldRowsAfterRotation = await rawOutboxFor(oldAuthority);
  const newRowsAfterOldCallback = await rawOutboxFor(authority);
  assert(
    oldRowsAfterRotation.length === 0,
    "Old-generation outbox rows survived the authority rotation.",
  );
  assert(
    releasedOldCallbacks === 1 &&
      newRowsAfterOldCallback.some((row) => row.sendId === generationGuardId),
    "Old-generation admission callback mutated new-generation state.",
  );
  await acknowledgeDesktopChatOutbox("cloud", new Set([oldRows[0]!.sendId]), {
    accountScope: oldAuthority.accountScope,
    ownerGeneration: oldAuthority.ownerGeneration,
    conversationId: oldAuthority.conversationId,
  });
  const newRowsAfterStaleAck = await rawOutboxFor(authority);
  assert(
    newRowsAfterStaleAck.some((row) => row.sendId === generationGuardId),
    "Stale acknowledgement changed new authority state.",
  );
  await acknowledgeDesktopChatOutbox("cloud", new Set([generationGuardId]), {
    accountScope: authority.accountScope,
    ownerGeneration: authority.ownerGeneration,
    conversationId: authority.conversationId,
  });
  assert(
    (await rawOutboxFor(authority)).length === 0,
    "Generation callback guard cleanup failed.",
  );
  const finalStateSha256 = control.storage.stateSha256();
  await surface.unmount();
  control.closeAllSockets();
  return {
    phase: "generation_rotation",
    passed: true,
    processIdSha256: processIdSha256(runId),
    mountIdSha256: sha256(mountId),
    accountScopeSha256: sha256(authority.accountScope),
    oldConversationIdSha256: sha256(oldAuthority.conversationId),
    conversationIdSha256: sha256(authority.conversationId),
    oldGenerationSha256: sha256(oldAuthority.ownerGeneration),
    newGenerationSha256: sha256(authority.ownerGeneration),
    generationsDiffer: true,
    liveAcrossResetBarrier: true,
    serverAdmissionResponseHeldAcrossReset: true,
    heldOldResponseDeliveredAfterRerender: releasedOldCallbacks === 1,
    actualHookRerendered: true,
    oldGenerationOutboxPurged: oldRowsAfterRotation.length === 0,
    staleSocketRetired: true,
    staleCallbackDropCount:
      releasedOldCallbacks === 1 && newRowsAfterOldCallback.length === 1
        ? 1
        : 0,
    staleOutboxAckRejected: newRowsAfterStaleAck.length === 1,
    newGenerationHydrated: true,
    newAuthorityIdleAfterStaleCallback: surface.current().sending === false,
    localFallbackCount: 0,
    priorStateSha256: expectedPriorState,
    finalStateSha256,
    receipts: [
      receipt("mobile.rn.owner-generation-rotation", "retired-and-purged", {
        requestIdSha256: canarySendIdSha256,
        stateSha256: finalStateSha256,
        count: 1,
      }),
    ],
  };
};

test(
  "mounted signed-in cloud-canonical mobile acceptance",
  async () => {
    instrumentAsyncStorageCompletion();
    const bunVersion = (process.versions as Record<string, string | undefined>)
      .bun;
    assert(
      /^1\.4\.[0-9]+(?:[-+].*)?$/u.test(bunVersion ?? ""),
      "Bun 1.4.x is required.",
    );
    const runId = required("STELLA_MOBILE_ACCEPTANCE_RUN_ID");
    assert(UUID_PATTERN.test(runId), "The acceptance run id is invalid.");
    const timeoutMs = Math.max(
      30_000,
      Math.min(
        15 * 60_000,
        Number(process.env.STELLA_MOBILE_ACCEPTANCE_TIMEOUT_MS) || 12 * 60_000,
      ),
    );
    const phase = required(
      "STELLA_MOBILE_RN_ACCEPTANCE_PHASE",
    ) as AcceptancePhase;
    assert(
      [
        "enqueue_response_loss",
        "replay_reconnect_switch",
        "clean_hydrate",
        "generation_rotation",
      ].includes(phase),
      "The mounted RN acceptance phase is invalid.",
    );
    clearCachedToken();
    assert(
      (await getConvexToken()) === required("STELLA_MOBILE_RN_ACCEPTANCE_JWT"),
      "The injected signed-in JWT did not reach the real auth-token wrapper.",
    );
    const authority = authorityFromEnv();
    const result =
      phase === "enqueue_response_loss"
        ? await runEnqueueResponseLoss(authority, runId, timeoutMs)
        : phase === "replay_reconnect_switch"
          ? await runReplayReconnectSwitch(authority, runId, timeoutMs)
          : phase === "clean_hydrate"
            ? await runCleanHydrate(authority, runId, timeoutMs)
            : await runGenerationRotation(authority, runId, timeoutMs);
    expect(result.passed).toBe(true);
    console.log(`${RECEIPT_MARKER}${JSON.stringify(result)}`);
  },
  15 * 60_000,
);
