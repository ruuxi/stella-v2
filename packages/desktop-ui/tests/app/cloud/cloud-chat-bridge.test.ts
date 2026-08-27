import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import {
  activateCloudConversationClientAuthority,
  pendingPrompts,
} from "../../../src/features/cloud/conversation-store";
import {
  setCloudConversationOutboxStorageForTests,
  type CloudConversationOutboxStorage,
} from "../../../src/features/cloud/conversation-outbox";
import {
  cloudLiveToStreamingAssistants,
  cloudPendingPromptsToEvents,
  cloudPrefixBoundaryForUserMessage,
  cloudPromptFromSendArgs,
  latestInFlightCloudUserMessageId,
  localCloudTaskOverlay,
  shouldUseLocalCloudOverlay,
} from "../../../src/features/cloud/use-cloud-chat-bridge";
import {
  classifyBrowserDispatchRejection,
  cloudTurnStartArgs,
} from "../../../src/features/cloud/use-conversation";
import { sha256Hex } from "../../../src/features/cloud/browser-execution-placement";
import {
  publishCloudExecutionSelection,
  resetCloudExecutionSelectionForTests,
} from "../../../src/features/cloud/cloud-execution-store";

const userRecord = (
  seq: number,
  clientMsgId = `client-${seq}`,
): JournalRecord => ({
  kind: "message",
  seq,
  turnId: `turn-${seq}`,
  createdAtMs: seq + 10,
  role: "user",
  hidden: false,
  clientMsgId,
  payload: { content: `prompt ${seq}` },
});

const pendingIds = new Set<string>();
const TEST_ACCOUNT_SCOPE = "account:test-owner";
const TEST_AUTHORITY = {
  accountScope: TEST_ACCOUNT_SCOPE,
  ownerGeneration: "generation:test-owner",
};
class MemoryStorage implements CloudConversationOutboxStorage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}
const emptySubmission = (
  prompt: string,
  requestedConversationId: string | null = "conversation-1",
) => ({
  requestedConversationId,
  prompt,
  imagePaths: [] as string[],
  attachments: [],
  locale: null,
  execution: null,
});
const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

beforeEach(() => {
  setCloudConversationOutboxStorageForTests(new MemoryStorage());
  pendingPrompts.retainAccountScope(TEST_ACCOUNT_SCOPE);
  activateCloudConversationClientAuthority(TEST_AUTHORITY);
});

afterEach(() => {
  for (const id of pendingIds) pendingPrompts.drop(TEST_AUTHORITY, id);
  pendingIds.clear();
  resetCloudExecutionSelectionForTests();
  setCloudConversationOutboxStorageForTests(undefined);
});

describe("cloud chat bridge authority", () => {
  test("resolves fork and rewind against the canonical sequence before the user prompt", () => {
    expect(
      cloudPrefixBoundaryForUserMessage([userRecord(0)], "client-0"),
    ).toEqual({ targetSeq: 0, throughSeq: -1 });

    const records: JournalRecord[] = [
      userRecord(4, "earlier"),
      {
        kind: "skipped",
        seq: 5,
        turnId: "future-turn",
        createdAtMs: 15,
        originalKind: "future-record",
      },
      userRecord(6, "target"),
    ];
    expect(cloudPrefixBoundaryForUserMessage(records, "target")).toEqual({
      targetSeq: 6,
      throughSeq: 5,
    });
    expect(
      cloudPrefixBoundaryForUserMessage(records, "local-only-id"),
    ).toBeNull();
  });

  test("never revives SQLite rows while canonical cloud state is unavailable", () => {
    expect(shouldUseLocalCloudOverlay("live")).toBe(true);
    expect(shouldUseLocalCloudOverlay("idle")).toBe(false);
    expect(shouldUseLocalCloudOverlay("connecting")).toBe(false);
    expect(shouldUseLocalCloudOverlay("offline")).toBe(false);
    expect(shouldUseLocalCloudOverlay("blocked")).toBe(false);

    const runningTask = {
      id: "local-running",
      description: "Working",
      agentType: "general",
      source: "stella" as const,
      readOnly: false,
      status: "running" as const,
      startedAtMs: 900,
      lastUpdatedAtMs: 950,
    };
    expect(localCloudTaskOverlay("offline", [runningTask], 1_000)).toEqual([]);
    expect(localCloudTaskOverlay("live", [runningTask], 1_000)).toEqual([
      runningTask,
    ]);
    expect(
      localCloudTaskOverlay(
        "live",
        [{ ...runningTask, status: "completed" as const }],
        1_000,
      ),
    ).toEqual([]);
    expect(localCloudTaskOverlay("live", [runningTask], 700_951)).toEqual([]);
  });

  test("binds modern Fork and Rewind actions to the fenced cloud API with no SQLite mutation", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/use-full-shell-chat.js"),
      "utf8",
    );
    expect(source).toContain("useAction(cloudApi.forkMyConversation)");
    expect(source).toContain("useAction(cloudApi.rewindMyConversation)");
    expect(source).toContain("expectedEpoch: head.epoch");
    expect(source).toContain("expectedLastSeq: head.headSeq");
    expect(source).toContain('activeTurnPolicy: "conflict"');
    expect(source).toContain("refreshAfterCanonicalMutation()");
    expect(source).not.toContain("forkLocalConversation");
    expect(source).not.toContain("truncateLocalConversation");
  });

  test("pages complete cloud Activity history through the visible Home search", () => {
    const bridge = fs.readFileSync(
      path.join(SOURCE_ROOT, "features/cloud/use-cloud-chat-bridge.tsx"),
      "utf8",
    );
    const shell = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/use-full-shell-chat.js"),
      "utf8",
    );
    const work = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/FilesSection.jsx"),
      "utf8",
    );

    expect(bridge).toContain("hasOlderActivity: cloudActivity.hasOlder");
    expect(bridge).toContain(
      "isLoadingOlderActivity: cloudActivity.isLoadingOlder",
    );
    expect(shell).toContain(
      "const hasOlderActivity = cloudChat.hasOlderActivity",
    );
    expect(shell).toContain(
      "const loadOlderActivity = cloudChat.loadOlderActivity",
    );
    expect(work).toContain(
      "!query || !activity.hasOlder || activity.isLoadingOlder",
    );
    expect(work).toContain("activity.loadOlder()");
    expect(work).toContain("searchingOlderActivity");
    expect(work).toContain('"Looking through older agent activity."');
    expect(work).toContain("renderedAccountScopeRef.current === accountScope");
    expect(work).toContain("displaySearchStore.close()");
  });

  test("keeps a failed optimistic cloud prompt addressable for retry or discard", () => {
    const clientMsgId = `failed-${crypto.randomUUID()}`;
    pendingIds.add(clientMsgId);
    const submission = {
      requestedConversationId: "conversation-1",
      prompt: "send me\n\nAttached in my drive:\n- images/input.png",
      imagePaths: ["images/input.png"],
      attachments: [
        { path: "images/input.png", name: "input.png", sizeBytes: 42 },
      ],
      locale: "fr",
      execution: {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      } as const,
    };
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "send me",
      "conversation-1",
      submission,
    );
    pendingPrompts.fail(
      TEST_AUTHORITY,
      clientMsgId,
      "That didn't send. Try again.",
    );

    expect(pendingPrompts.getSnapshot()).toContainEqual({
      accountScope: TEST_ACCOUNT_SCOPE,
      ownerGeneration: TEST_AUTHORITY.ownerGeneration,
      clientMsgId,
      text: "send me",
      conversationId: "conversation-1",
      turnId: null,
      dispatchId: null,
      cancelRequested: false,
      error: "That didn't send. Try again.",
      retryOnNextActivation: false,
      durable: true,
      deliveryAcknowledged: false,
      createdAtMs: expect.any(Number),
      submission,
    });

    pendingPrompts.prepareRetry(TEST_AUTHORITY, clientMsgId);
    const retained = pendingPrompts
      .getSnapshot()
      .find((entry) => entry.clientMsgId === clientMsgId);
    expect(retained?.error).toBeNull();
    expect(retained?.submission).toEqual(submission);
  });

  test("retries the same client message with frozen locale and execution", () => {
    const submission = {
      requestedConversationId: "conversation-1",
      prompt: "frozen prompt",
      imagePaths: ["images/input.png"],
      attachments: [
        { path: "images/input.png", name: "input.png", sizeBytes: 42 },
      ],
      locale: "fr",
      execution: {
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      } as const,
    };
    const firstAttempt = cloudTurnStartArgs(
      "client-frozen",
      "generation-frozen",
      submission,
    );

    publishCloudExecutionSelection({
      engine: "stella",
      provider: "stella",
      model: "stella/standard",
      reasoningEffort: "default",
    });

    expect(
      cloudTurnStartArgs("client-frozen", "generation-frozen", submission),
    ).toEqual(firstAttempt);
    expect(firstAttempt).toMatchObject({
      clientMsgId: "client-frozen",
      expectedOwnerGeneration: "generation-frozen",
      conversationId: "conversation-1",
      locale: "fr",
      execution: submission.execution,
      attachments: ["images/input.png"],
    });
  });

  test("routes hosted sends and Stop through placement while retaining legacy Electron chat", () => {
    const conversationSource = fs.readFileSync(
      path.join(SOURCE_ROOT, "features/cloud/use-conversation.ts"),
      "utf8",
    );
    const bridgeSource = fs.readFileSync(
      path.join(SOURCE_ROOT, "features/cloud/use-cloud-chat-bridge.tsx"),
      "utf8",
    );
    expect(conversationSource).toContain(
      "submitBrowserExecution = useMutation(cloudApi.submitBrowserExecution)",
    );
    expect(conversationSource).toContain("await browserExecutionSubmitArgs({");
    expect(conversationSource).toContain(
      "__STELLA_RENDERED_ACCEPTANCE_BEFORE_BROWSER_DISPATCH__",
    );
    expect(conversationSource).toContain(
      "await waitForRenderedAcceptanceBrowserDispatch(",
    );
    expect(conversationSource).toContain(
      "__STELLA_RENDERED_ACCEPTANCE_AFTER_BROWSER_DISPATCH__",
    );
    expect(conversationSource).toContain('"owner_generation_rejected"');
    expect(conversationSource).toContain(
      "__STELLA_RENDERED_ACCEPTANCE_AUTHORITY__",
    );
    expect(conversationSource).toContain(
      "convex.query(cloudApi.getExecutionDispatchStatus",
    );
    expect(conversationSource).toContain(
      "await cancelExecutionDispatch(browserExecutionCancelArgs(dispatchId))",
    );
    expect(conversationSource).toContain("if (!webShell)");
    expect(conversationSource).toContain("startLegacyTurn(");
    expect(bridgeSource).toContain("conversation.cancelPending(");
  });

  test("classifies browser dispatch rejection only from the exact structured code", async () => {
    const staleCode = "OWNER_DATA_GENERATION_STALE";
    const resetMessage =
      "This request started before the account data was reset.";

    await expect(
      classifyBrowserDispatchRejection(
        Object.assign(new Error(resetMessage), {
          data: { code: staleCode, message: resetMessage },
        }),
      ),
    ).resolves.toEqual({
      outcome: "owner_generation_rejected",
      errorCodeSha256: await sha256Hex(staleCode),
    });

    await expect(
      classifyBrowserDispatchRejection(
        new Error(
          `ConvexError: ${JSON.stringify({ code: staleCode, message: resetMessage })}`,
        ),
      ),
    ).resolves.toEqual({
      outcome: "owner_generation_rejected",
      errorCodeSha256: await sha256Hex(staleCode),
    });

    await expect(
      classifyBrowserDispatchRejection(new Error(resetMessage)),
    ).resolves.toEqual({
      outcome: "other_rejected",
      errorCodeSha256: await sha256Hex("<no-error-code>"),
    });

    const otherCode = "OWNER_SESSION_REVOKED";
    await expect(
      classifyBrowserDispatchRejection(
        Object.assign(new Error(resetMessage), {
          data: { code: otherCode, message: resetMessage },
        }),
      ),
    ).resolves.toEqual({
      outcome: "other_rejected",
      errorCodeSha256: await sha256Hex(otherCode),
    });
  });

  test("retains pre-admission Stop intent and resolves the optimistic row by dispatch id", () => {
    const clientMsgId = `placement-${crypto.randomUUID()}`;
    pendingIds.add(clientMsgId);
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "place me",
      "conversation-1",
      emptySubmission("place me"),
    );
    pendingPrompts.requestCancel(TEST_AUTHORITY, clientMsgId);
    pendingPrompts.bindDispatch(
      TEST_AUTHORITY,
      clientMsgId,
      "exec:placed-turn",
    );
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toMatchObject({
      dispatchId: "exec:placed-turn",
      cancelRequested: true,
    });
    pendingPrompts.resolve(TEST_AUTHORITY, {
      kind: "message",
      seq: 1,
      turnId: "turn-placed",
      createdAtMs: 1,
      role: "user",
      hidden: false,
      clientMsgId: "exec:placed-turn",
      payload: { content: "place me" },
    });
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toBeNull();
  });

  test("projects pending prompts and live deltas without a second durable transcript", () => {
    const clientMsgId = "pending-client";
    const pending = [
      {
        accountScope: TEST_ACCOUNT_SCOPE,
        ownerGeneration: TEST_AUTHORITY.ownerGeneration,
        clientMsgId,
        text: "hello",
        createdAtMs: 100,
        conversationId: "conversation-1",
        turnId: "turn-live",
        dispatchId: "exec:turn-live",
        cancelRequested: false,
        error: null,
        retryOnNextActivation: false,
        durable: true,
        deliveryAcknowledged: false,
        submission: emptySubmission("hello"),
      },
    ];
    expect(cloudPendingPromptsToEvents(pending)).toEqual([
      {
        _id: clientMsgId,
        timestamp: 100,
        type: "user_message",
        payload: { text: "hello" },
      },
    ]);
    expect(
      cloudLiveToStreamingAssistants([], pending, {
        turnId: "turn-live",
        streamId: "stream-live",
        text: "working",
        toolName: null,
        toolLabel: null,
        dropped: false,
      }),
    ).toMatchObject([
      {
        userMessageId: clientMsgId,
        text: "working",
        runId: "turn-live",
      },
    ]);
  });

  test("never marks a failed optimistic prompt as the pending user message", () => {
    const pending = [
      {
        accountScope: TEST_ACCOUNT_SCOPE,
        ownerGeneration: TEST_AUTHORITY.ownerGeneration,
        clientMsgId: "still-sending",
        text: "first",
        createdAtMs: 100,
        conversationId: "conversation-1",
        turnId: "turn-live",
        dispatchId: "exec:turn-live",
        cancelRequested: false,
        error: null,
        retryOnNextActivation: false,
        durable: true,
        deliveryAcknowledged: false,
        submission: emptySubmission("first"),
      },
      {
        accountScope: TEST_ACCOUNT_SCOPE,
        ownerGeneration: TEST_AUTHORITY.ownerGeneration,
        clientMsgId: "failed-later",
        text: "second",
        createdAtMs: 101,
        conversationId: "conversation-1",
        turnId: null,
        dispatchId: null,
        cancelRequested: false,
        error: "That didn't send. Try again.",
        retryOnNextActivation: false,
        durable: true,
        deliveryAcknowledged: false,
        submission: emptySubmission("second"),
      },
    ];

    expect(latestInFlightCloudUserMessageId(pending)).toBe("still-sending");
    expect(latestInFlightCloudUserMessageId([pending[1]!])).toBeNull();
  });

  test("sends only visible prompt text and provides a context-only fallback", () => {
    expect(
      cloudPromptFromSendArgs({
        text: "  visible request  ",
        selectedText: "hidden selection",
        chatContext: { pastedTexts: ["hidden paste"] },
        onClear: () => {},
      }),
    ).toBe("visible request");
    expect(
      cloudPromptFromSendArgs({
        text: "",
        selectedText: "selection",
        chatContext: null,
        onClear: () => {},
      }),
    ).toBe("Help me with this selected text:\n\nselection");
  });

  test("fences async conversation edits and creates to the live account and route", () => {
    const shell = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/use-full-shell-chat.js"),
      "utf8",
    );
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );
    const topbar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );
    expect(shell).toContain(
      "conversationEditOperationRef.current !== operation",
    );
    expect(shell).toContain(
      "activeAccountScopeRef.current !== operation.accountScope",
    );
    expect(root).toContain("activeRouteIntentRef.current !== routeIntent");
    expect(root).toContain(
      "retireCloudConversationClientAuthority(accountScope)",
    );
    expect(root).toContain("retireCloudExecutionClientAuthority(accountScope)");
    expect(root).toContain("ownershipMigrationRetryRef.current !== operation");
    expect(topbar).toContain("activeAccountScopeRef.current !== accountScope");
  });
});
