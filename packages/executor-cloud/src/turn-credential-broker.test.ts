import { describe, expect, test } from "bun:test";
import {
  TURN_BROKER_AUTH_SCHEME,
  TURN_BROKER_HEADERS,
  TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
  type TurnBrokerHandoff,
} from "@stella/contracts/turn-credential-broker";
import { access, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TurnCredentialBrokerClient,
  parseTurnBrokerHandoff,
  takeTurnBrokerHandoff,
  type TurnBrokerFetch,
} from "./turn-credential-broker.js";

const capability = "A".repeat(43);
const handoff = (
  overrides: Partial<TurnBrokerHandoff> = {},
): TurnBrokerHandoff => ({
  version: 1,
  endpoint: "https://builder.example/sessions/session-1/turn-broker",
  capability,
  expiresAt: Date.now() + 60_000,
  initialSequence: 1,
  sessionId: "session-1",
  ownerId: "owner-1",
  ownerGeneration: "generation-4",
  turnId: "turn-7",
  attemptGeneration: 2,
  ...overrides,
});

describe("executor turn credential broker", () => {
  test("takes a strict one-shot handoff and unlinks it before use", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "stella-broker-test-"),
    );
    const credentialsPath = path.join(directory, "handoff.json");
    try {
      await writeFile(credentialsPath, JSON.stringify(handoff()), {
        mode: 0o600,
      });
      const taken = await takeTurnBrokerHandoff({ credentialsPath });
      expect(taken).toMatchObject({
        capability,
        ownerGeneration: "generation-4",
        attemptGeneration: 2,
      });
      await expect(access(credentialsPath)).rejects.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("unlinks malformed handoffs too and rejects added ambient fields", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "stella-broker-test-"),
    );
    const credentialsPath = path.join(directory, "handoff.json");
    try {
      await writeFile(
        credentialsPath,
        JSON.stringify({ ...handoff(), rawTurnToken: "must-not-exist" }),
        { mode: 0o600 },
      );
      await expect(takeTurnBrokerHandoff({ credentialsPath })).rejects.toThrow(
        "invalid",
      );
      await expect(access(credentialsPath)).rejects.toBeDefined();
      expect(() =>
        parseTurnBrokerHandoff(
          handoff({ expiresAt: Date.now() - 1 }),
          Date.now(),
        ),
      ).toThrow("expired");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a handoff inode that is not private and singly linked", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "stella-broker-test-"),
    );
    const credentialsPath = path.join(directory, "handoff.json");
    const aliasPath = path.join(directory, "handoff-alias.json");
    try {
      await writeFile(credentialsPath, JSON.stringify(handoff()), {
        mode: 0o600,
      });
      await link(credentialsPath, aliasPath);
      await expect(takeTurnBrokerHandoff({ credentialsPath })).rejects.toThrow(
        "private bounded regular file",
      );
      await expect(access(credentialsPath)).resolves.toBeNull();
      await expect(access(aliasPath)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes exact sequences and overwrites hostile credential headers", async () => {
    const calls: Array<{ headers: Headers; body: string }> = [];
    const fetchImpl: TurnBrokerFetch = async (_input, init) => {
      calls.push({
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return Response.json({ ok: true });
    };
    const client = new TurnCredentialBrokerClient(handoff(), fetchImpl);
    await Promise.all([
      client.postJson("/api/cloud/events", { ordinal: 1 }),
      client.fetchTarget("/api/cloud/events", {
        method: "POST",
        headers: {
          authorization: "Bearer hostile",
          "x-api-key": "hostile",
          "x-stella-turn-token": "hostile",
          [TURN_BROKER_HEADERS.sequence]: "999",
        },
        body: "{}",
      }),
    ]);

    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => call.headers.get(TURN_BROKER_HEADERS.sequence)),
    ).toEqual(["1", "2"]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(
        `${TURN_BROKER_AUTH_SCHEME} ${capability}`,
      );
      expect(call.headers.get("x-api-key")).toBeNull();
      expect(call.headers.get("x-stella-turn-token")).toBeNull();
      expect(call.headers.get(TURN_BROKER_HEADERS.ownerGeneration)).toBe(
        "generation-4",
      );
      expect(call.headers.get(TURN_BROKER_HEADERS.attemptGeneration)).toBe("2");
    }
  });

  test("poisons the capability after an ambiguous response instead of replaying it", async () => {
    let calls = 0;
    const client = new TurnCredentialBrokerClient(handoff(), async () => {
      calls += 1;
      throw new Error("connection reset after write");
    });
    await expect(
      client.postJson("/api/cloud/events", { progress: true }),
    ).rejects.toThrow("ambiguous");
    await expect(
      client.postJson("/api/cloud/events", { progress: false }),
    ).rejects.toThrow("ambiguous");
    expect(calls).toBe(1);
    expect(client.closed).toBe(true);
  });

  test("aborts an in-flight broker call and never starts queued authority after close", async () => {
    let calls = 0;
    const client = new TurnCredentialBrokerClient(
      handoff(),
      async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const active = client.postJson("/api/cloud/events", { ordinal: 1 });
    const queued = client.postJson("/api/cloud/events", { ordinal: 2 });
    const activeObserved = active.then(
      () => null,
      (error: unknown) => error,
    );
    const queuedObserved = queued.then(
      () => null,
      (error: unknown) => error,
    );
    await Bun.sleep(1);
    client.close(new Error("turn canceled"));
    const activeError = await activeObserved;
    const queuedError = await queuedObserved;
    expect(activeError).toBeInstanceOf(Error);
    expect((activeError as Error).message).toContain("ambiguous");
    expect(queuedError).toBeInstanceOf(Error);
    expect((queuedError as Error).message).toContain("turn canceled");
    expect(calls).toBe(1);
  });

  test("keeps cancellation live while a checkpoint response body is draining", async () => {
    let observedSignal: AbortSignal | undefined;
    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const client = new TurnCredentialBrokerClient(
      handoff(),
      async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"schemaVersion":'));
              observedSignal?.addEventListener(
                "abort",
                () => controller.error(observedSignal?.reason),
                { once: true },
              );
              responseStarted();
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
    const active = client.commitNativeStateCheckpoint({
      engine: "anthropic",
      sessionId: "native-session-1",
      cursor: `v1:${"a".repeat(64)}`,
      tree: {
        algorithm: "sha256",
        digest: "b".repeat(64),
        entries: 4,
        bytes: 128,
      },
      mac: "d".repeat(64),
    });
    const observed = active.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await started;
    await Bun.sleep(1);
    client.close(new Error("turn canceled while draining"));

    const outcome = await Promise.race([
      observed,
      Bun.sleep(100).then(() => "still-pending" as const),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("ambiguous");
    expect(observedSignal?.aborted).toBe(true);
  });

  test("aborts a real streamed callback transport after returning its headers", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"type":"response.output_text"}'),
              );
            },
          }),
        );
      },
    });
    const client = new TurnCredentialBrokerClient(
      handoff({
        endpoint: `http://127.0.0.1:${upstream.port}/turn-broker`,
      }),
    );
    try {
      const response = await client.fetchTarget("/api/cloud/events", {
        method: "POST",
        body: "{}",
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "response.output_text",
      );
      const pendingRead = reader.read().then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      client.close(new Error("turn canceled after callback headers"));

      const outcome = await Promise.race([
        pendingRead,
        Bun.sleep(100).then(() => "still-pending" as const),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect(client.closed).toBe(true);
    } finally {
      client.close();
      upstream.stop(true);
    }
  });

  test("refuses broker redirects without sending the capability to the redirect origin", async () => {
    let sourceCalls = 0;
    let sinkCalls = 0;
    const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        sinkCalls += 1;
        return Response.json({ reached: true });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        sourceCalls += 1;
        expect(request.headers.get("authorization")).toBe(
          `${TURN_BROKER_AUTH_SCHEME} ${capability}`,
        );
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${sink.port}/stolen` },
        });
      },
    });
    try {
      const client = new TurnCredentialBrokerClient(
        handoff({
          endpoint: `http://127.0.0.1:${source.port}/sessions/session-1/turn-broker`,
        }),
      );
      await expect(
        client.postJson("/api/cloud/events", { progress: true }),
      ).rejects.toThrow("ambiguous");
      expect(client.closed).toBe(true);
      expect(sourceCalls).toBe(1);
      expect(sinkCalls).toBe(0);
    } finally {
      source.stop(true);
      sink.stop(true);
    }
  });

  test("recovers a lost checkpoint response with the exact same sequence and request fingerprint", async () => {
    const calls: Array<{ headers: Headers; body: string }> = [];
    const client = new TurnCredentialBrokerClient(
      handoff(),
      async (_input, init) => {
        const captured = {
          headers: new Headers(init?.headers),
          body: String(init?.body),
        };
        calls.push(captured);
        if (calls.length === 1) {
          throw new Error("response lost after durable checkpoint");
        }
        return Response.json({
          operationId: "d".repeat(64),
          historyCursor: `v1:${"a".repeat(64)}`,
          manifestId: "e".repeat(64),
        });
      },
    );
    const receipt = await client.commitNativeStateCheckpoint({
      engine: "anthropic",
      sessionId: "native-session-1",
      cursor: `v1:${"a".repeat(64)}`,
      tree: {
        algorithm: "sha256",
        digest: "b".repeat(64),
        entries: 4,
        bytes: 128,
      },
      mac: "d".repeat(64),
    });
    expect(receipt).toEqual({
      operationId: "d".repeat(64),
      historyCursor: `v1:${"a".repeat(64)}`,
      manifestId: "e".repeat(64),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.headers.get(TURN_BROKER_HEADERS.sequence)).toBe("1");
    expect(calls[1]?.headers.get(TURN_BROKER_HEADERS.sequence)).toBe("1");
    expect(calls[0]?.headers.get(TURN_BROKER_HEADERS.requestId)).toBe(
      calls[1]?.headers.get(TURN_BROKER_HEADERS.requestId),
    );
    expect(calls[0]?.headers.get(TURN_BROKER_HEADERS.targetPath)).toBe(
      TURN_BROKER_NATIVE_STATE_CHECKPOINT_PATH,
    );
  });

  test("canonicalizes and bounds a suspended checkpoint transcript", async () => {
    let captured: Record<string, unknown> | undefined;
    let calls = 0;
    const cursor = `v1:${"a".repeat(64)}`;
    const client = new TurnCredentialBrokerClient(
      handoff(),
      async (_input, init) => {
        calls += 1;
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          operationId: "b".repeat(64),
          historyCursor: cursor,
          manifestId: "c".repeat(64),
        });
      },
    );
    const suspensionTranscript = [
      {
        ordinal: 0,
        role: "user",
        payloadJson: JSON.stringify({ role: "user", content: [] }),
      },
      {
        ordinal: 1,
        role: "assistant",
        payloadJson: JSON.stringify({ role: "assistant", content: [] }),
      },
    ];
    await client.commitTurnStateCheckpoint({
      historyCursor: cursor,
      suspensionTranscript,
    });
    expect(captured).toEqual({
      schemaVersion: 1,
      historyCursor: cursor,
      suspensionTranscript,
    });
    expect(calls).toBe(1);

    const invalid = new TurnCredentialBrokerClient(handoff(), async () => {
      calls += 1;
      return new Response();
    });
    await expect(
      invalid.commitTurnStateCheckpoint({
        historyCursor: cursor,
        suspensionTranscript: [
          {
            ordinal: 0,
            role: "assistant",
            payloadJson: JSON.stringify({ role: "user", content: [] }),
          },
        ],
      }),
    ).rejects.toThrow("transcript is invalid");
    expect(calls).toBe(1);
  });

  test("does not advance or reuse authority after an invalid checkpoint receipt", async () => {
    let calls = 0;
    const client = new TurnCredentialBrokerClient(handoff(), async () => {
      calls += 1;
      return Response.json({ schemaVersion: 1, receipt: "not-valid" });
    });
    await expect(
      client.commitNativeStateCheckpoint({
        engine: "anthropic",
        sessionId: "native-session-1",
        cursor: `v1:${"a".repeat(64)}`,
        tree: {
          algorithm: "sha256",
          digest: "b".repeat(64),
          entries: 4,
          bytes: 128,
        },
        mac: "d".repeat(64),
      }),
    ).rejects.toThrow("ambiguous");
    await expect(
      client.postJson("/api/cloud/messages", { text: "must-not-send" }),
    ).rejects.toThrow("ambiguous");
    expect(calls).toBe(1);
    expect(client.closed).toBe(true);
  });
});
