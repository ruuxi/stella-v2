import { describe, expect, test } from "vitest";
import {
  browserExecutionCancelArgs,
  browserExecutionPayload,
  browserExecutionSubmitArgs,
  waitForBrowserExecutionTurn,
} from "../../../src/features/cloud/browser-execution-placement";

const frozenSubmission = {
  requestedConversationId: "conversation-browser",
  prompt: "Explain the attached chart",
  imagePaths: ["images/chart.png"],
  attachments: [{ path: "images/chart.png", name: "chart.png", sizeBytes: 42 }],
  locale: "fr",
  execution: {
    engine: "openai-codex",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
  executionTarget: { mode: "device", deviceId: "desktop-living-room" },
} as const;

describe("browser execution placement", () => {
  test("carries the exact frozen prompt, locale, attachment, and model bytes", async () => {
    const input = {
      clientMsgId: "client:frozen-browser",
      conversationId: "conversation-browser",
      submission: frozenSubmission,
    };
    expect(browserExecutionPayload(input)).toEqual({
      schemaVersion: 1,
      prompt: frozenSubmission.prompt,
      conversationId: "conversation-browser",
      clientMsgId: "client:frozen-browser",
      locale: "fr",
      attachments: ["images/chart.png"],
      execution: frozenSubmission.execution,
    });
    const first = await browserExecutionSubmitArgs(input);
    const retry = await browserExecutionSubmitArgs(input);
    expect(retry).toEqual(first);
    expect(first).toEqual({
      protocol: 1,
      idempotencyKey: "client:frozen-browser",
      kind: "chat",
      ingress: "browser",
      subject: "cloud",
      conversationId: "conversation-browser",
      requiredCapabilities: ["chat"],
      targetMode: "device",
      targetDeviceId: "desktop-living-room",
      payload: browserExecutionPayload(input),
    });
  });

  test("refuses a submission frozen against another conversation", () => {
    expect(() =>
      browserExecutionPayload({
        clientMsgId: "client:mismatch",
        conversationId: "conversation-other",
        submission: frozenSubmission,
      }),
    ).toThrow("changed conversation authority");
  });

  test("automatic browser placement is explicit and resolves without a device id", async () => {
    const submission = {
      ...frozenSubmission,
      executionTarget: { mode: "automatic" as const },
    };
    const result = await browserExecutionSubmitArgs({
      clientMsgId: "client:automatic-browser",
      conversationId: "conversation-browser",
      submission,
    });
    expect(result.targetMode).toBe("automatic");
    expect(result).not.toHaveProperty("targetDeviceId");
    expect(result.payload).not.toHaveProperty("targetMode");
  });

  test("waits for the placement turn id and fences a stale account response", async () => {
    let reads = 0;
    const started = await waitForBrowserExecutionTurn({
      dispatchId: "exec:browser-start",
      queryStatus: async (dispatchId) => {
        reads += 1;
        return {
          dispatchId,
          idempotencyKey: "client:browser-start",
          kind: "chat",
          ingress: "browser",
          subject: "cloud",
          conversationId: "conversation-browser",
          state: reads === 1 ? "cloud_committed" : "cloud_running",
          placement: "cloud",
          ...(reads === 2 ? { cloudTurnId: "turn-browser" } : {}),
        };
      },
      isCurrentAccount: () => true,
      delay: async () => undefined,
      attempts: 3,
    });
    expect(started).toMatchObject({
      status: "started",
      turnId: "turn-browser",
      dispatch: { dispatchId: "exec:browser-start" },
    });

    let current = true;
    const stale = await waitForBrowserExecutionTurn({
      dispatchId: "exec:stale-account",
      queryStatus: async (dispatchId) => {
        current = false;
        return {
          dispatchId,
          idempotencyKey: "client:stale-account",
          kind: "chat",
          ingress: "browser",
          subject: "cloud",
          conversationId: "conversation-old-owner",
          state: "cloud_running",
          placement: "cloud",
          cloudTurnId: "turn-old-owner",
        };
      },
      isCurrentAccount: () => current,
      delay: async () => undefined,
    });
    expect(stale).toEqual({ status: "stale" });
  });

  test("uses one stable placement cancellation receipt before or after turn creation", () => {
    expect(browserExecutionCancelArgs("exec:browser-cancel")).toEqual({
      dispatchId: "exec:browser-cancel",
      cancelRequestId: "cancel:exec:browser-cancel",
      reason: "Canceled by the user.",
    });
  });
});
