import { vi } from "vitest";

type MemoryPolicyLoopbackTest = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Loops the cloud-builder memory-policy callback back into the deployment
 * under test so the real service callback and private mutations run. The
 * owner gate's serialization, durable recovery and acknowledgement are tested
 * in its own suite.
 */
export const stubMemoryPolicyLoopback = (t: MemoryPolicyLoopbackTest) => {
  vi.stubEnv("CLOUD_BUILDER_URL", "https://builder.test");
  vi.stubEnv("BUILDER_SERVICE_SECRET", "memory-policy-test-secret");
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        request.url !==
        "https://builder.test/internal/owners/memory-policy/change"
      ) {
        throw new Error(`Unexpected test fetch: ${request.url}`);
      }
      const applied = await t.fetch("/api/cloud/home/memory/policy/apply", {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      });
      if (applied.ok) return Response.json({ ok: true });
      const body = await applied.json();
      return Response.json(
        { error: body.code ?? "MEMORY_POLICY_CHANGE_REFUSED" },
        { status: applied.status },
      );
    },
  );
};
