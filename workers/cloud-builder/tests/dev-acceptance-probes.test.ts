import { describe, expect, mock, test } from "bun:test";
import {
  acceptanceConversationTitle,
  acceptanceOwnerMarkerSha256,
  authorizeDevAcceptanceProbe,
  DEV_ACCEPTANCE_PROBE_VERSION,
  parseDevAcceptanceProbeRequest,
  recordDevAcceptanceProbeReceipt,
  type DevAcceptanceProbeEnvironment,
} from "../src/dev-acceptance-probes.js";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
const { OrchestratorSession } = await import("../src/orchestrator-session.js");
mock.restore();

const runId = "00000000-0000-4000-8000-000000000001";
const ownerId = "disposable-owner-for-acceptance";
const ownerGeneration = "generation-acceptance-1";
const conversationId = "acceptance-conversation-1";
const serviceSecret = "acceptance-service-secret";

const enabledEnv: DevAcceptanceProbeEnvironment = {
  BUILDER_SERVICE_SECRET: serviceSecret,
  ENABLE_DEV_ACCEPTANCE_PROBES: "1",
  STELLA_DEPLOYMENT_IDENTITY: "dev:impartial-crab-34",
};

const body = async (
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => ({
  version: DEV_ACCEPTANCE_PROBE_VERSION,
  operation: "status",
  runId,
  requestId: "probe-request-1",
  ownerId,
  ownerGeneration,
  acceptanceOwnerMarkerSha256: await acceptanceOwnerMarkerSha256(
    runId,
    ownerId,
  ),
  ...overrides,
});

const authorize = async (
  args: {
    env?: DevAcceptanceProbeEnvironment;
    secret?: string | null;
    bodyOverrides?: Record<string, unknown>;
    owner?: string;
    generation?: string;
    title?: string;
  } = {},
) =>
  authorizeDevAcceptanceProbe({
    env: args.env ?? enabledEnv,
    suppliedServiceSecret:
      args.secret === undefined ? serviceSecret : args.secret,
    body: await body(args.bodyOverrides),
    meta: {
      ownerId: args.owner ?? ownerId,
      ownerGeneration: args.generation ?? ownerGeneration,
      conversationId,
      title: args.title ?? acceptanceConversationTitle(runId),
    },
  });

describe("dev-only cloud acceptance probes", () => {
  test("production and ungated deployments hide the route", async () => {
    for (const env of [
      { ...enabledEnv, ENABLE_DEV_ACCEPTANCE_PROBES: undefined },
      { ...enabledEnv, ENABLE_DEV_ACCEPTANCE_PROBES: "0" },
      { ...enabledEnv, STELLA_DEPLOYMENT_IDENTITY: "production:main" },
      { ...enabledEnv, STELLA_DEPLOYMENT_IDENTITY: "prod:main" },
    ]) {
      expect(await authorize({ env })).toEqual({
        ok: false,
        status: 404,
        code: "probe_disabled",
      });
    }
  });

  test("a missing or wrong service secret cannot arm or abort", async () => {
    for (const secret of [null, "", "wrong-service-secret"]) {
      expect(
        await authorize({
          secret,
          bodyOverrides: {
            operation: "arm_fault",
            fault: "canonical_history",
          },
        }),
      ).toEqual({ ok: false, status: 404, code: "probe_not_found" });
      expect(
        await authorize({
          secret,
          bodyOverrides: { operation: "self_abort" },
        }),
      ).toEqual({ ok: false, status: 404, code: "probe_not_found" });
    }
  });

  test("wrong owner, generation, conversation marker, or owner marker is denied", async () => {
    expect(await authorize({ owner: "another-owner" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(
      await authorize({ generation: "replacement-generation" }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await authorize({ title: "ordinary-user-conversation" }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await authorize({
        bodyOverrides: { acceptanceOwnerMarkerSha256: "0".repeat(64) },
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  test("accepts only bounded typed operations without extra content", async () => {
    expect(parseDevAcceptanceProbeRequest(await body())).not.toBeNull();
    expect(
      parseDevAcceptanceProbeRequest(
        await body({ operation: "arm_fault", fault: "canonical_prompt" }),
      ),
    ).toMatchObject({ operation: "arm_fault", fault: "canonical_prompt" });
    expect(
      parseDevAcceptanceProbeRequest(
        await body({ sql: "DELETE FROM journal" }),
      ),
    ).toBeNull();
    expect(
      parseDevAcceptanceProbeRequest(
        await body({ operation: "arm_fault", fault: "arbitrary_sql" }),
      ),
    ).toBeNull();
    expect(
      parseDevAcceptanceProbeRequest(
        await body({ operation: "self_abort", fault: "canonical_prompt" }),
      ),
    ).toBeNull();
  });

  test("receipts replay identically and reject request-id replacement", async () => {
    const firstAuthorization = await authorize();
    if (!firstAuthorization.ok) throw new Error("expected authorization");
    const first = recordDevAcceptanceProbeReceipt({
      current: undefined,
      authorization: firstAuthorization,
      now: 10,
    });
    expect(first.status).toBe("recorded");
    if (first.status !== "recorded") throw new Error("expected receipt");
    expect(
      recordDevAcceptanceProbeReceipt({
        current: first.state,
        authorization: firstAuthorization,
        now: 20,
      }).status,
    ).toBe("replayed");

    const replacement = await authorize({
      bodyOverrides: { operation: "self_abort" },
    });
    if (!replacement.ok) throw new Error("expected replacement authorization");
    expect(
      recordDevAcceptanceProbeReceipt({
        current: first.state,
        authorization: replacement,
        now: 30,
      }).status,
    ).toBe("conflict");
  });

  test("the real handler performs no abort or fault mutation for denied calls", async () => {
    const cases = [
      {
        env: { ...enabledEnv, ENABLE_DEV_ACCEPTANCE_PROBES: "0" },
        metaOwner: ownerId,
      },
      {
        env: {
          ...enabledEnv,
          STELLA_DEPLOYMENT_IDENTITY: "production:main",
        },
        metaOwner: ownerId,
      },
      { env: enabledEnv, metaOwner: "ordinary-user-owner" },
    ];
    for (const [index, entry] of cases.entries()) {
      let aborts = 0;
      let faultMutations = 0;
      const values = new Map<string, unknown>();
      const instance = Object.create(
        OrchestratorSession.prototype,
      ) as OrchestratorSession & Record<string, unknown>;
      Object.assign(instance, {
        env: entry.env,
        ownerGeneration,
        devAcceptanceBootId: "raw-boot-id-never-returned",
        ctx: {
          id: { toString: () => "raw-durable-object-id" },
          storage: {
            get: async <T>(key: string) => values.get(key) as T | undefined,
            put: async (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
            },
          },
          waitUntil: () => {
            aborts += 100;
          },
          abort: () => {
            aborts += 1;
          },
        },
        journal: {
          ownerId: () => entry.metaOwner,
          meta: () => ({ title: acceptanceConversationTitle(runId) }),
          acceptanceContextFaultStatus: () => null,
          acceptanceContextFaultCandidate: () => {
            faultMutations += 1;
            return { seq: 0, payloadJson: "{}" };
          },
          armAcceptanceContextFault: () => {
            faultMutations += 1;
          },
        },
        conversationId: () => conversationId,
      });
      const operation = index === cases.length - 1 ? "arm_fault" : "self_abort";
      const response = await (
        instance as unknown as {
          handleDevAcceptanceProbe(request: Request): Promise<Response>;
        }
      ).handleDevAcceptanceProbe(
        new Request(
          "https://orchestrator-session/internal/dev-acceptance/probe",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-stella-acceptance-service-secret": serviceSecret,
            },
            body: JSON.stringify(
              await body({
                operation,
                ...(operation === "arm_fault"
                  ? { fault: "canonical_history" }
                  : {}),
              }),
            ),
          },
        ),
      );
      expect(response.status).toBe(404);
      expect(aborts).toBe(0);
      expect(faultMutations).toBe(0);
      expect(values.size).toBe(0);
    }
  });

  test("a valid typed fault is durable and can be armed only once per run", async () => {
    const values = new Map<string, unknown>();
    const instance = Object.create(
      OrchestratorSession.prototype,
    ) as OrchestratorSession & Record<string, unknown>;
    Object.assign(instance, {
      env: enabledEnv,
      ownerGeneration,
      devAcceptanceBootId: "raw-boot-id-never-returned",
      ctx: {
        id: { toString: () => "raw-durable-object-id" },
        storage: {
          get: async <T>(key: string) => values.get(key) as T | undefined,
          put: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
          },
        },
        waitUntil: () => undefined,
        abort: () => undefined,
      },
      journal: {
        ownerId: () => ownerId,
        meta: () => ({ title: acceptanceConversationTitle(runId) }),
        acceptanceContextFaultStatus: () => null,
      },
      conversationId: () => conversationId,
    });
    const invoke = async (requestId: string) =>
      await (
        instance as unknown as {
          handleDevAcceptanceProbe(request: Request): Promise<Response>;
        }
      ).handleDevAcceptanceProbe(
        new Request(
          "https://orchestrator-session/internal/dev-acceptance/probe",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-stella-acceptance-service-secret": serviceSecret,
            },
            body: JSON.stringify(
              await body({
                operation: "arm_fault",
                fault: "canonical_prompt",
                requestId,
              }),
            ),
          },
        ),
      );

    const first = await invoke("arm-prompt-once");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      operation: "arm_fault",
      fault: { kind: "canonical_prompt", armed: true },
    });
    const second = await invoke("arm-prompt-twice");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: "acceptance_probe_consumed",
    });
    expect(values.get("devAcceptanceProbeState:v1")).toMatchObject({
      promptFaultArmed: true,
      usedFaults: ["canonical_prompt"],
    });
  });
});
