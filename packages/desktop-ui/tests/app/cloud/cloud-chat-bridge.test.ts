import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import { pendingPrompts } from "../../../src/features/cloud/conversation-store";
import {
  cloudLiveToStreamingAssistants,
  cloudPendingPromptsToEvents,
  cloudPrefixBoundaryForUserMessage,
  cloudPromptFromSendArgs,
  localCloudTaskOverlay,
  shouldUseLocalCloudOverlay,
} from "../../../src/features/cloud/use-cloud-chat-bridge";
import { cloudTurnStartArgs } from "../../../src/features/cloud/use-conversation";
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
const emptySubmission = (prompt: string) => ({
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

afterEach(() => {
  for (const id of pendingIds) pendingPrompts.drop(TEST_ACCOUNT_SCOPE, id);
  pendingIds.clear();
  resetCloudExecutionSelectionForTests();
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

  test("keeps a failed optimistic cloud prompt addressable for retry or discard", () => {
    const clientMsgId = `failed-${crypto.randomUUID()}`;
    pendingIds.add(clientMsgId);
    const submission = {
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
      TEST_ACCOUNT_SCOPE,
      clientMsgId,
      "send me",
      "conversation-1",
      submission,
    );
    pendingPrompts.fail(
      TEST_ACCOUNT_SCOPE,
      clientMsgId,
      "That didn't send. Try again.",
    );

    expect(pendingPrompts.getSnapshot()).toContainEqual({
      accountScope: TEST_ACCOUNT_SCOPE,
      clientMsgId,
      text: "send me",
      conversationId: "conversation-1",
      turnId: null,
      error: "That didn't send. Try again.",
      createdAtMs: expect.any(Number),
      submission,
    });

    pendingPrompts.clearError(TEST_ACCOUNT_SCOPE, clientMsgId);
    const retained = pendingPrompts
      .getSnapshot()
      .find((entry) => entry.clientMsgId === clientMsgId);
    expect(retained?.error).toBeNull();
    expect(retained?.submission).toBe(submission);
  });

  test("retries the same client message with frozen locale and execution", () => {
    const submission = {
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
      "conversation-1",
      submission,
    );

    publishCloudExecutionSelection({
      engine: "stella",
      provider: "stella",
      model: "stella/standard",
      reasoningEffort: "default",
    });

    expect(
      cloudTurnStartArgs("client-frozen", "conversation-1", submission),
    ).toEqual(firstAttempt);
    expect(firstAttempt).toMatchObject({
      clientMsgId: "client-frozen",
      conversationId: "conversation-1",
      locale: "fr",
      execution: submission.execution,
      attachments: ["images/input.png"],
    });
  });

  test("projects pending prompts and live deltas without a second durable transcript", () => {
    const clientMsgId = "pending-client";
    const pending = [
      {
        accountScope: TEST_ACCOUNT_SCOPE,
        clientMsgId,
        text: "hello",
        createdAtMs: 100,
        conversationId: "conversation-1",
        turnId: "turn-live",
        error: null,
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
    expect(root).toContain(
      "ownershipMigrationRetryRef.current !== operation",
    );
    expect(topbar).toContain("activeAccountScopeRef.current !== accountScope");
  });
});
