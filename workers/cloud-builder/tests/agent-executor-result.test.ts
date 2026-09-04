import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const { parseAgentExecutorResult, waitForCloudAgentTurnResultText } =
  await import("../src/index.js");
mock.restore();

const hex = (character: string): string => character.repeat(64);
const receipt = {
  operationId: hex("a"),
  historyCursor: `v1:${hex("b")}`,
  manifestId: hex("c"),
};
const messages = [
  {
    ordinal: 0,
    role: "assistant",
    payloadJson: JSON.stringify({ role: "assistant", content: [] }),
  },
];
const suspension = {
  schemaVersion: 1,
  outcome: "waiting_for_user" as const,
  interactionId: "browser-interaction-1",
  interactionRevision: 1,
  interactionKind: "login_takeover" as const,
  toolCallId: "tool-call-1",
  requestDigest: hex("f"),
  profileId: "default",
  profileEpoch: 1,
  displayOrigin: "https://example.test",
  expiresAt: 60_001,
};

describe("agent executor result decoder", () => {
  test("accepts only a checkpointed normal result", () => {
    expect(
      parseAgentExecutorResult({
        ok: true,
        finalText: "done",
        usage: { inputTokens: 1 },
        checkpointMs: 7,
        turnStateCheckpoint: receipt,
      }),
    ).toMatchObject({ ok: true, turnStateCheckpoint: receipt });

    expect(parseAgentExecutorResult({ ok: true, finalText: "done" })).toBeNull();
  });

  test("accepts an exact Builder fallback transcript and preserve-prior preflight", () => {
    expect(
      parseAgentExecutorResult({
        ok: false,
        error: "shutdown failed",
        checkpointPolicy: "builder_fallback",
        builderFallback: {
          historyCursor: `v1:${hex("e")}`,
          messages,
        },
      }),
    ).toMatchObject({ checkpointPolicy: "builder_fallback" });
    expect(
      parseAgentExecutorResult({
        ok: false,
        error: "preflight failed",
        checkpointPolicy: "preserve_prior",
      }),
    ).toMatchObject({ checkpointPolicy: "preserve_prior" });
  });

  test("accepts only the exact durable browser suspension shape", () => {
    expect(
      parseAgentExecutorResult({
        outcome: "suspended",
        ok: false,
        finalText: "",
        suspension,
        checkpointMs: 7,
        turnStateCheckpoint: receipt,
      }),
    ).toMatchObject({ outcome: "suspended", suspension });

    for (const value of [
      {
        outcome: "suspended",
        ok: true,
        finalText: "",
        suspension,
        turnStateCheckpoint: receipt,
      },
      {
        outcome: "suspended",
        ok: false,
        finalText: "waiting",
        suspension,
        turnStateCheckpoint: receipt,
      },
      {
        outcome: "suspended",
        ok: false,
        finalText: "",
        suspension,
      },
      {
        ok: false,
        finalText: "",
        suspension,
        turnStateCheckpoint: receipt,
      },
      {
        outcome: "suspended",
        ok: false,
        finalText: "",
        suspension: { ...suspension, credentialValue: "must-not-cross" },
        turnStateCheckpoint: receipt,
      },
    ]) {
      expect(parseAgentExecutorResult(value)).toBeNull();
    }
  });

  test("rejects parseable but untrusted stdout shapes", () => {
    for (const value of [
      null,
      {},
      { ok: "yes" },
      { ok: false, checkpointPolicy: "unknown" },
      {
        ok: false,
        checkpointPolicy: "builder_fallback",
        builderFallback: { historyCursor: "v1:empty", messages: [] },
      },
      {
        ok: false,
        checkpointPolicy: "preserve_prior",
        turnStateCheckpoint: receipt,
      },
      { ok: true, turnStateCheckpoint: receipt, injected: true },
    ]) {
      expect(parseAgentExecutorResult(value)).toBeNull();
    }
  });

  test("observes the root-only result independently of process-log capture", async () => {
    const expected = JSON.stringify({
      outcome: "suspended",
      ok: false,
      finalText: "",
      suspension,
      checkpointMs: 7,
      turnStateCheckpoint: receipt,
    });
    let reads = 0;
    const session = {
      readFile: async () => {
        reads += 1;
        if (reads === 1) throw new Error("not written yet");
        if (reads === 2) {
          return { content: btoa(expected.slice(0, -1)) };
        }
        return { content: btoa(expected) };
      },
    };
    const controller = new AbortController();

    await expect(
      waitForCloudAgentTurnResultText(session as never, [controller.signal]),
    ).resolves.toBe(expected);
    expect(reads).toBe(3);

    const canceled = new AbortController();
    canceled.abort(new Error("turn canceled"));
    await expect(
      waitForCloudAgentTurnResultText(session as never, [canceled.signal]),
    ).rejects.toThrow("turn canceled");
  });
});
