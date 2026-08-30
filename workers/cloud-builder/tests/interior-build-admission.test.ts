import { describe, expect, mock, test } from "bun:test";
import {
  TURN_BROKER_AUTH_SCHEME,
  TURN_BROKER_HEADERS,
  TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
} from "@stella/contracts/turn-credential-broker";
import {
  issueTurnBrokerCredential,
  turnBrokerStorageKey,
} from "../src/turn-credential-broker.js";
import {
  interiorBuildRequestKey,
  type InteriorBuildRequestRecord,
} from "../src/interior-build-request.js";

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
const { BuildSession } = await import("../src/index.js");
mock.restore();

const now = 1_800_000_000_000;
const identity = {
  sessionId: "session-1",
  ownerId: "owner-1",
  ownerGeneration: "generation-7",
  turnId: "turn-9",
  attemptGeneration: 3,
};

const brokerHarness = async () => {
  const { handoff, record } = await issueTurnBrokerCredential({
    identity,
    endpoint: "https://builder.example/sessions/session-1/turn-broker",
    now,
    ttlMs: 60_000,
    randomBytes: (bytes) => bytes.fill(7),
  });
  const values = new Map<string, unknown>();
  values.set("turn", {
    kind: "agent",
    ownerId: identity.ownerId,
    ownerGeneration: identity.ownerGeneration,
    turnId: identity.turnId,
    attemptGeneration: identity.attemptGeneration,
    threadId: "thread-1",
    prompt: "prompt",
    turnToken: "token",
    convexCallbackBase: "https://convex.example",
    turnBrokerRoute: { sessionId: identity.sessionId },
    execution: { engine: "stella" },
  });
  values.set(turnBrokerStorageKey(identity), record);
  values.set(
    `turnStateBaseWorkspaceRevision:${identity.turnId}:${identity.attemptGeneration}`,
    0,
  );
  values.set("sandboxId", `agent-${identity.turnId}`);
  const put = async (
    key: string | Record<string, unknown>,
    value?: unknown,
  ) => {
    if (typeof key === "string") {
      values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      values.set(entryKey, structuredClone(entryValue));
    }
  };
  const instance = Object.create(BuildSession.prototype) as Record<
    string,
    unknown
  >;
  Object.assign(instance, {
    ctx: {
      storage: {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        put,
      },
      blockConcurrencyWhile: async <T>(operation: () => Promise<T>) =>
        await operation(),
    },
    env: {},
    exactTurnCancellations: { matching: async () => undefined },
    agentTurnExecutions: new Map([
      [identity.turnId, { cancellation: { aborted: false } }],
    ]),
    assertTurnWritable: async () => undefined,
    assertConvexAgentTurnAuthority: async () => undefined,
  });
  const post = async (body: unknown): Promise<Response> => {
    const handle = (
      BuildSession.prototype as unknown as Record<string, unknown>
    )["handleTurnBroker"] as (
      this: Record<string, unknown>,
      request: Request,
    ) => Promise<Response>;
    return await handle.call(
      instance,
      new Request(
        `https://builder.example${TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `${TURN_BROKER_AUTH_SCHEME} ${handoff.capability}`,
            "content-type": "application/json",
            [TURN_BROKER_HEADERS.ownerId]: identity.ownerId,
            [TURN_BROKER_HEADERS.ownerGeneration]: identity.ownerGeneration,
            [TURN_BROKER_HEADERS.turnId]: identity.turnId,
            [TURN_BROKER_HEADERS.attemptGeneration]: String(
              identity.attemptGeneration,
            ),
            [TURN_BROKER_HEADERS.sequence]: "1",
            [TURN_BROKER_HEADERS.requestId]:
              "00000000-0000-4000-8000-000000000001",
            [TURN_BROKER_HEADERS.targetMethod]: "POST",
            [TURN_BROKER_HEADERS.targetPath]:
              TURN_BROKER_INTERIOR_BUILD_REQUEST_PATH,
          },
          body: JSON.stringify(body),
        },
      ),
    );
  };
  const stored = (): InteriorBuildRequestRecord | undefined =>
    values.get(
      interiorBuildRequestKey(identity.turnId, identity.attemptGeneration),
    ) as InteriorBuildRequestRecord | undefined;
  return { post, stored };
};

describe("interior build request admission", () => {
  test("records the request on any cloud agent turn", async () => {
    const harness = await brokerHarness();
    const response = await harness.post({
      schemaVersion: 1,
      note: "renderer refresh",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      requested: true,
    });
    expect(harness.stored()).toMatchObject({
      schemaVersion: 1,
      turnId: identity.turnId,
      attemptGeneration: identity.attemptGeneration,
      note: "renderer refresh",
    });
  });

  test("refuses a malformed request body", async () => {
    const harness = await brokerHarness();
    const response = await harness.post({ schemaVersion: 2 });
    expect(response.status).toBe(400);
    expect(harness.stored()).toBeUndefined();
  });
});
