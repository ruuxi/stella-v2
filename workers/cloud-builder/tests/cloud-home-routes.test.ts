import { describe, expect, test } from "bun:test";
import { handleUserCloudHomeRoute } from "../src/cloud-home-routes.js";

/**
 * The owner's gate as the routes see it: the snapshot's generation and the
 * cloud-home control operations. `calls` records "snapshot" and each op.
 */
const fakeGates = (
  ownerGeneration: string,
  answer: (op: string, body: Record<string, unknown>) => unknown = (op) => {
    throw new Error(`unexpected control op: ${op}`);
  },
) => {
  const calls: string[] = [];
  const OWNER_GATES = {
    getByName: () => ({
      snapshot: async () => {
        calls.push("snapshot");
        return { ownerGeneration };
      },
      homeControl: async ({ op, body }: { op: string; body: Record<string, unknown> }) => {
        calls.push(op);
        return { ok: true, value: await answer(op, body) };
      },
    }),
  } as unknown as Cloudflare.Env["OWNER_GATES"];
  return { OWNER_GATES, calls };
};

const lease = async <T>(
  _ownerId: string,
  _ownerGeneration: string,
  _activityId: string,
  operation: (assertExternalWrite: () => Promise<void>) => Promise<T>,
): Promise<T> => await operation(async () => undefined);

const bucketWithPutCounter = () => {
  let puts = 0;
  const bucket = {
    async put() {
      puts += 1;
      return null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts: () => puts };
};

describe("Cloud Home user route bounds", () => {
  test("rejects aggregate skill bytes before control-plane begin or R2 PUT", async () => {
    const gates = fakeGates("generation-1");
    const r2 = bucketWithPutCounter();
    const fourAndHalfMiB = Buffer.alloc(4.5 * 1024 * 1024).toString("base64");
    const files = Array.from({ length: 6 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `assets/file-${index}.bin`,
      contentType:
        index === 0
          ? "text/markdown; charset=utf-8"
          : "application/octet-stream",
      base64: fourAndHalfMiB,
    }));
    const request = new Request(
      "https://builder.example.test/cloud-home/skills/upload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "too-large",
          name: "Too large",
          description: "Aggregate rejection fixture",
          source: "desktop_sync",
          availability: "both",
          expectedRevision: 0,
          idempotencyKey: "aggregate-limit-test",
          files,
        }),
      },
    );

    const response = await handleUserCloudHomeRoute({
      request,
      env: { AGENT_HOME: r2.bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "Skill package exceeds the total size limit.",
    });
    expect(gates.calls).toEqual(["snapshot"]);
    expect(r2.puts()).toBe(0);
  });

  test("redacts unexpected exception messages", async () => {
    const gates = fakeGates("generation-1");
    const response = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/skills/export?agentType=general",
      ),
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      withLease: async () => {
        throw new Error(
          "https://internal.example/agent-home/private-key?token=secret",
        );
      },
    });

    expect(response?.status).toBe(500);
    const text = await response?.text();
    expect(text).toContain("Cloud home request failed.");
    expect(text).not.toContain("internal.example");
    expect(text).not.toContain("private-key");
    expect(text).not.toContain("secret");
  });

  test("rejects an invalid skill agentType instead of changing its meaning", async () => {
    const gates = fakeGates("generation-1");
    const response = await handleUserCloudHomeRoute({
      request: new Request(
        "https://builder.example.test/cloud-home/skills/export?agentType=admin",
      ),
      env: { AGENT_HOME: {} as R2Bucket, OWNER_GATES: gates.OWNER_GATES },
      ownerId: "owner-1",
      withLease: lease,
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "agentType was invalid." });
    expect(gates.calls).toEqual(["snapshot"]);
  });
});
