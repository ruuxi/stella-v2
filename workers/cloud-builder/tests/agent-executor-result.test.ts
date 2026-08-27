import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
}));
const { parseAgentExecutorResult } = await import("../src/index.js");
mock.restore();

const hex = (character: string): string => character.repeat(64);
const receipt = {
  schemaVersion: 1,
  operationId: hex("a"),
  historyCursor: `v1:${hex("b")}`,
  workspaceSha256: hex("c"),
  receipt: hex("d"),
  replayed: false,
};
const messages = [
  {
    ordinal: 0,
    role: "assistant",
    payloadJson: JSON.stringify({ role: "assistant", content: [] }),
  },
];

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
});
