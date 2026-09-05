import { describe, expect, test } from "bun:test";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import { LocalOwnerModelGrants, releaseOwnerModelGrantAfterBody } from "../src/local-owner-model-grants.js";
import { fetchWithManagedCancellation } from "../src/managed-request-cancellation.js";
import type { OwnerModelGrant } from "../src/owner-model-grants.js";

const policy: MemoryPolicy = { ownerGeneration: "gen", memoryEpoch: "epoch", memoryEnabled: true, revision: 2, updatedAt: 10 };
const expected = { ownerId: "owner", ownerGeneration: "gen", conversationId: "conversation", turnId: "turn",
  leaseId: "lease", fenceGeneration: "fence", memoryPolicy: policy };
const grant = (readerId = "reader", expiresAt = 2_000): OwnerModelGrant => ({
  ...expected, readerId, grantId: "grant", expiresAt, state: "active", issuedAt: 1, updatedAt: 1,
});

describe("local owner model grants", () => {
  test("rejects pre-arrival revocation, old isolate nonces, and expired grants", () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader", grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    expect(local.valid(grant(), expected)).toBeNull();
    expect(new LocalOwnerModelGrants("new", () => 1_000).valid(grant("old"), expected)).toBeNull();
    expect(new LocalOwnerModelGrants("reader", () => 2_000).valid(grant(), expected)).toBeNull();
  });

  test("freeze aborts an exact active physical request and old-nonce freeze only acknowledges", () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    const active = local.begin(grant(), expected, new AbortController().signal);
    local.freeze({ ownerId: "other", ownerGeneration: "gen", readerId: "reader", grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    expect(active.requestSignal.aborted).toBe(false);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "old", grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    expect(active.requestSignal.aborted).toBe(false);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader", grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    expect(active.requestSignal.aborted).toBe(true);
    expect(active.assertValid).toThrow("OWNER_MODEL_GRANT_REVOKED");
  });

  test("keeps the request registered through response body consumption", async () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    const active = local.begin(grant(), expected, new AbortController().signal);
    const response = releaseOwnerModelGrantAfterBody(new Response("ok"), active.release);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader", grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    expect(active.requestSignal.aborted).toBe(true);
    expect(await response.text()).toBe("ok");
  });

  test("grant authority stays local and adds no provider headers", () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    const original = new Request("https://provider.test", { headers: { authorization: "Bearer provider" } });
    const active = local.begin(grant(), expected, original.signal);
    const physical = new Request(original, { signal: active.requestSignal });
    expect([...physical.headers]).toEqual([["authorization", "Bearer provider"]]);
    active.release();
  });

  test("the combined grant signal reaches private gateway cancellation", async () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    const original = new Request("https://gateway.test", {
      headers: { "x-stella-request-id": "physical-request" },
    });
    const active = local.begin(grant(), expected, original.signal);
    const guarded = new Request(original, { signal: active.requestSignal });
    const cancellations: string[] = [];
    const response = await fetchWithManagedCancellation({
      request: guarded,
      capability: "signed-capability",
      control: {
        cancelManagedRequest: async ({ requestId }) => {
          cancellations.push(requestId);
          return { canceled: true };
        },
      },
      waitUntil: work => { void work.catch(() => undefined); },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      })),
    });
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader",
      grants: [{ grantId: "grant", expiresAt: 2_000 }] });
    await expect(response.text()).rejects.toBeDefined();
    await Promise.resolve();
    expect(cancellations).toEqual(["physical-request"]);
    active.release();
  });

  test("rejects a renewal response that was pending when freeze arrived", () => {
    const local = new LocalOwnerModelGrants("reader", () => 1_000);
    const epoch = local.freezeEpoch(expected);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader",
      grants: [{ grantId: "older-grant", expiresAt: 2_000 }] });
    expect(local.validAfter({ ...grant(), grantId: "renewed-grant" }, expected, epoch)).toBeNull();
  });

  test("expiry blocks new dispatch while freeze still aborts an already active request", () => {
    let now = 1_000;
    const local = new LocalOwnerModelGrants("reader", () => now);
    const expiring = grant("reader", 1_100);
    const active = local.begin(expiring, expected, new AbortController().signal);
    now = 1_101;
    expect(local.valid(expiring, expected)).toBeNull();
    expect(active.requestSignal.aborted).toBe(false);
    local.freeze({ ownerId: "owner", ownerGeneration: "gen", readerId: "reader",
      grants: [{ grantId: "grant", expiresAt: 1_100 }] });
    expect(active.requestSignal.aborted).toBe(true);
    active.release();
  });
});
