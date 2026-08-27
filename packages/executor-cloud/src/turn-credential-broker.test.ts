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
  startTurnCredentialProxy,
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
      client.fetchTarget("/api/stella/relay/responses", {
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
          schemaVersion: 1,
          operationId: "d".repeat(64),
          historyCursor: `v1:${"a".repeat(64)}`,
          workspaceSha256: "e".repeat(64),
          nativeSha256: "b".repeat(64),
          receipt: "c".repeat(64),
          replayed: true,
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
    expect(receipt).toMatchObject({
      receipt: "c".repeat(64),
      replayed: true,
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

  test("a same-UID native child can use loopback without receiving broker or raw authority", async () => {
    const builderCalls: Array<{ headers: Headers; target: string }> = [];
    const client = new TurnCredentialBrokerClient(
      handoff(),
      async (_input, init) => {
        const captured = new Headers(init?.headers);
        builderCalls.push({
          headers: captured,
          target: captured.get(TURN_BROKER_HEADERS.targetPath) ?? "",
        });
        return Response.json({ id: "response-1" });
      },
    );
    const proxy = startTurnCredentialProxy(client);
    try {
      expect(proxy.dummyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        await fetch(`${proxy.relayBaseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ).toMatchObject({ status: 401 });
      expect(
        await fetch(`${proxy.relayBaseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${proxy.dummyToken}`,
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      ).toMatchObject({ status: 403 });
      expect(builderCalls).toHaveLength(0);
      const childEnvironment = { ...process.env };
      delete childEnvironment.STELLA_TURN_TOKEN;
      childEnvironment.ANTHROPIC_BASE_URL = proxy.relayBaseUrl;
      childEnvironment.CLAUDE_CODE_OAUTH_TOKEN = proxy.dummyToken;
      const script = String.raw`
        import { readFileSync } from "node:fs";
        const env = JSON.stringify(process.env);
        let parent = "";
        try { parent = readFileSync("/proc/" + process.ppid + "/environ", "utf8"); } catch {}
        const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
          method: "POST",
          headers: {
            authorization: "Bearer " + process.env.CLAUDE_CODE_OAUTH_TOKEN,
            "x-api-key": process.env.CLAUDE_CODE_OAUTH_TOKEN,
            "content-type": "application/json"
          },
          body: "{}"
        });
        process.stdout.write(JSON.stringify({ env, parent, status: response.status }));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: childEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stderr).toBe("");
      const observation = JSON.parse(stdout) as {
        env: string;
        parent: string;
        status: number;
      };
      expect(observation.status).toBe(200);
      expect(observation.env).not.toContain(capability);
      expect(observation.parent).not.toContain(capability);
      expect(observation.env).not.toContain("STELLA_TURN_TOKEN");
      expect(observation.env).toContain(proxy.dummyToken);

      expect(builderCalls).toHaveLength(1);
      expect(builderCalls[0]?.target).toBe("/api/stella/relay/v1/messages");
      expect(builderCalls[0]?.headers.get("authorization")).toBe(
        `${TURN_BROKER_AUTH_SCHEME} ${capability}`,
      );
      expect(builderCalls[0]?.headers.get("x-api-key")).toBeNull();
      expect(builderCalls[0]?.headers.get("x-stella-turn-token")).toBeNull();
    } finally {
      proxy.close();
    }
  });
});
