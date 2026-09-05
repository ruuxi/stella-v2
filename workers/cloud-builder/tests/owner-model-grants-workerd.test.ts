import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  MEMORY_POLICY_APPLY_PATH,
  type MemoryPolicy,
} from "@stella/contracts/turn-plane/memory-policy";
import {
  startWorkerdDev,
  type JsonResponse,
  type WorkerdDev,
} from "./helpers/workerd-dev.js";

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  ownerGeneration: "owner-generation-1",
  memoryEpoch: "epoch-1",
  memoryEnabled: true,
  revision: 0,
  updatedAt: 1,
  ...overrides,
});

const turn = (suffix: string) => ({
  ownerId: `owner-${suffix}`,
  ownerGeneration: "owner-generation-1",
  conversationId: `conversation-${suffix}`,
  turnId: `turn-${suffix}`,
  leaseId: `lease-${suffix}`,
  policy: policy(),
});

const grantFrom = (response: JsonResponse): Record<string, unknown> => {
  const grant = response.body.grant;
  if (response.status !== 200 || !grant) {
    throw new Error(`issue failed: ${JSON.stringify(response)}`);
  }
  return grant as Record<string, unknown>;
};

/**
 * The Convex memory-policy endpoints the gate's transport calls: one policy
 * per owner, and every applied change is recorded by request id.
 */
const startFakeConvex = async (): Promise<{
  url: string;
  applied: string[];
  close(): Promise<void>;
}> => {
  const policies = new Map<string, MemoryPolicy>();
  const applied: string[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: unknown) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const ownerId = String(body.ownerId);
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.headers.authorization !== "Bearer fixture-secret") {
        return reply(403, { error: "forbidden" });
      }
      if (request.url === "/api/cloud/home/memory/preference") {
        return reply(200, policies.get(ownerId) ?? policy());
      }
      if (
        request.url === MEMORY_POLICY_APPLY_PATH &&
        body.kind === "preference"
      ) {
        const current = policies.get(ownerId) ?? policy();
        policies.set(ownerId, {
          ...current,
          memoryEnabled: body.memoryEnabled === true,
          revision: current.revision + 1,
          updatedAt: current.updatedAt + 1,
        });
        applied.push(String(body.requestId));
        return reply(200, { ok: true });
      }
      reply(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    applied,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

describe("owner model grant protocol in real Workerd", () => {
  let convex: Awaited<ReturnType<typeof startFakeConvex>>;
  let dev: WorkerdDev;
  const requestJson = (
    path: string,
    body?: Record<string, unknown>,
  ): Promise<JsonResponse> => dev.requestJson(path, body);

  beforeAll(async () => {
    convex = await startFakeConvex();
    dev = await startWorkerdDev({
      config: "tests/fixtures/owner-model-grants-workerd.wrangler.jsonc",
      prefix: "stella-owner-model-grants-workerd-",
      vars: { STELLA_CONVEX_SITE_URL: convex.url },
    });
  }, 30_000);

  afterAll(async () => {
    try {
      await dev?.stop();
    } finally {
      await convex?.close();
    }
  }, 30_000);

  test("owner change freezes a reader grant without deadlocking and the old grant is unusable", async () => {
    const input = turn("normal-change");
    const grant = grantFrom(await requestJson("/issue", input));
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: true },
    });

    expect(
      await requestJson("/change", { ...input, requestId: "change-normal" }),
    ).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(convex.applied).toContain("change-normal");
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });

    const next = { ...input, turnId: "turn-next", leaseId: "lease-next" };
    const stale = await requestJson("/issue", next);
    expect(stale.status).toBe(503);
    expect(String(stale.body.error)).toContain("MEMORY_POLICY_CHANGED");
    grantFrom(
      await requestJson("/issue", {
        ...next,
        policy: policy({ memoryEnabled: false, revision: 1, updatedAt: 2 }),
      }),
    );
  }, 60_000);

  test("lost freeze response persists pending change, denies new grants, and replay completes", async () => {
    const input = turn("lost-freeze");
    const grant = grantFrom(await requestJson("/issue", input));
    const lost = await requestJson("/change", {
      ...input,
      requestId: "change-lost",
      lostOnce: true,
    });
    expect(lost).toMatchObject({ status: 503, body: { ok: false } });
    expect(convex.applied).not.toContain("change-lost");

    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
    const denied = await requestJson("/issue", {
      ...input,
      turnId: "turn-new",
      leaseId: "lease-new",
    });
    expect(denied.status).toBe(503);
    expect(String(denied.body.error)).toContain("MEMORY_POLICY_CHANGING");

    expect(await requestJson("/retry-change", input)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(convex.applied.filter((id) => id === "change-lost")).toHaveLength(1);
    grantFrom(
      await requestJson("/issue", {
        ...input,
        turnId: "turn-new",
        leaseId: "lease-new",
        policy: policy({ memoryEnabled: false, revision: 1, updatedAt: 2 }),
      }),
    );
  }, 60_000);

  test("reader restart nonce makes an old grant unusable and stale-reader freeze ack is safe", async () => {
    const input = turn("restart");
    const grant = grantFrom(await requestJson("/issue", input));
    const beforeUse = await requestJson("/use", { ...input, grant });
    expect(beforeUse).toMatchObject({ status: 200, body: { ok: true } });
    const oldReaderId = String(beforeUse.body.readerId);

    await requestJson("/abort-reader", input).catch(() => ({
      status: 503,
      body: {},
    }));
    const restarted = await dev.eventually(
      () => requestJson("/use", { ...input, grant }),
      (value) => value.status === 200 && value.body.readerId !== oldReaderId,
    );
    expect(restarted.body.ok).toBe(false);

    const staleAck = await requestJson("/freeze-stale-reader", {
      ...input,
      readerId: oldReaderId,
      grantId: String(grant.grantId),
    });
    expect(staleAck.status).toBe(200);
    expect(staleAck.body.currentReaderId).not.toBe(oldReaderId);
  }, 60_000);

  test("owner fence begin commits only after the grant freeze barrier revokes readers", async () => {
    const input = turn("fence");
    const grant = grantFrom(await requestJson("/issue", input));
    const begun = await requestJson("/begin-fence", input);
    expect(begun.status).toBe(200);
    expect(begun.body).toMatchObject({ status: 200 });
    expect(begun.body.fence).toMatchObject({ state: "blocked" });
    expect(begun.body.barrier).toBeUndefined();
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
  }, 60_000);
});
