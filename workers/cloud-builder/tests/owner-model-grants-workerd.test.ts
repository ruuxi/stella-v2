import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import {
  startWorkerdDev,
  type JsonResponse,
  type WorkerdDev,
} from "./helpers/workerd-dev.js";

const policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy => ({
  ownerGeneration: "owner-generation-1",
  memoryEpoch: "initial",
  memoryEnabled: true,
  revision: 0,
  updatedAt: 0,
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

describe("owner model grant protocol in real Workerd", () => {
  let dev: WorkerdDev;
  const requestJson = (
    path: string,
    body?: Record<string, unknown>,
  ): Promise<JsonResponse> => dev.requestJson(path, body);

  beforeAll(async () => {
    dev = await startWorkerdDev({
      config: "tests/fixtures/owner-model-grants-workerd.wrangler.jsonc",
      prefix: "stella-owner-model-grants-workerd-",
    });
  }, 30_000);

  afterAll(async () => {
    await dev?.stop();
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
    expect(await requestJson("/applied", input)).toEqual({
      status: 200,
      body: { requestId: "change-normal", revision: 1 },
    });
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
    expect((await requestJson("/applied", input)).body).toEqual({
      requestId: null,
      revision: 0,
    });

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
    expect((await requestJson("/applied", input)).body).toEqual({
      requestId: "change-lost",
      revision: 1,
    });
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
