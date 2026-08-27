import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { getCorsHeaders } from "../../convex/http_shared/cors";
import { resolveCloudManagedProtocol } from "../../convex/stella_provider/authorization";
import {
  RelayResumeSseParser,
  STELLA_RELAY_REQUEST_ID_HEADER,
  decideRelayResumeAccess,
  relayRequestIdFromIdempotencyKey,
  relayResumeRequestBinding,
  relayResumeTerminalSuffix,
} from "../../convex/stella_provider/relay_resume";

describe("cloud relay HTTP contract", () => {
  it("publishes the canonical wire protocol for every current gateway", () => {
    expect(resolveCloudManagedProtocol({ relayProvider: "anthropic" })).toBe(
      "anthropic-messages",
    );
    expect(resolveCloudManagedProtocol({ relayProvider: "google" })).toBe(
      "google-generative-ai",
    );
    for (const relayProvider of [
      "openai",
      "fireworks",
      "deepseek",
      "xai",
    ] as const) {
      expect(resolveCloudManagedProtocol({ relayProvider })).toBe(
        "openai-responses",
      );
    }
    for (const relayProvider of [
      "crof",
      "wafer",
      "openrouter",
      "meta",
    ] as const) {
      expect(resolveCloudManagedProtocol({ relayProvider })).toBe(
        "openai-completions",
      );
    }
    expect(
      resolveCloudManagedProtocol({
        relayProvider: "openrouter",
        configuredApi: "openai-responses",
      }),
    ).toBe("openai-responses");
  });

  it("allows clients to propose a resumable relay id through CORS", () => {
    const headers = getCorsHeaders("https://stella.sh");
    expect(headers["Access-Control-Allow-Headers"]?.toLowerCase()).toContain(
      STELLA_RELAY_REQUEST_ID_HEADER,
    );
  });

  it("allows generated owner-and-device tunnel origins without widening the domain", () => {
    expect(
      getCorsHeaders("https://t-owner123-device456.stellatunnel.com")[
        "Access-Control-Allow-Origin"
      ],
    ).toBe("https://t-owner123-device456.stellatunnel.com");
    expect(
      getCorsHeaders("https://t-owner123-device456.example.com")[
        "Access-Control-Allow-Origin"
      ],
    ).toBeUndefined();
  });

  it("derives a stable opaque relay id without exposing the owner or key", async () => {
    const first = await relayRequestIdFromIdempotencyKey(
      "owner-secret",
      "request-secret",
    );
    const second = await relayRequestIdFromIdempotencyKey(
      "owner-secret",
      "request-secret",
    );
    const other = await relayRequestIdFromIdempotencyKey(
      "owner-secret",
      "other-request",
    );
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).not.toContain("owner-secret");
    expect(first).not.toContain("request-secret");
  });

  it("binds retries to one canonical logical request without retaining prompt text", async () => {
    const first = await relayResumeRequestBinding({
      method: "post",
      pathname: "/api/stella/relay/v1/responses",
      agentType: "general",
      requestJson: {
        input: [{ role: "user", content: "private prompt" }],
        metadata: { second: 2, first: 1 },
        stream: true,
      },
    });
    const reordered = await relayResumeRequestBinding({
      method: "POST",
      pathname: "/api/stella/relay/v1/responses",
      agentType: "general",
      requestJson: {
        stream: true,
        metadata: { first: 1, second: 2 },
        input: [{ content: "private prompt", role: "user" }],
      },
    });
    const changedBody = await relayResumeRequestBinding({
      method: "POST",
      pathname: "/api/stella/relay/v1/responses",
      agentType: "general",
      requestJson: { input: "different", stream: true },
    });
    const changedAgent = await relayResumeRequestBinding({
      method: "POST",
      pathname: "/api/stella/relay/v1/responses",
      agentType: "computer",
      requestJson: {
        input: [{ role: "user", content: "private prompt" }],
        metadata: { first: 1, second: 2 },
        stream: true,
      },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changedBody);
    expect(first).not.toBe(changedAgent);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).not.toContain("private prompt");
  });

  it("parses split SSE events into a contiguous replay sequence", () => {
    const parser = new RelayResumeSseParser();
    expect(parser.push('data: {"type":"response.output_text.delta"')).toEqual(
      [],
    );
    const frames = parser.push(
      ',"delta":"hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]?.kind).toBe("event");
    expect(frames[1]?.kind).toBe("event");
    if (frames[0]?.kind === "event" && frames[1]?.kind === "event") {
      expect(frames[0].event.sequence).toBe(1);
      expect(frames[1].event.sequence).toBe(2);
      expect(frames[1].event.responseId).toBe("resp_1");
      expect(frames[1].event.terminalStatus).toBe("completed");
    }
  });

  it("fails closed for a foreign owner, expired cursor, or cursor ahead", () => {
    const snapshot = {
      ownerId: "owner-a",
      expiresAt: 2_000,
      hardExpiresAt: 3_000,
      lastSequence: 4,
    };
    expect(
      decideRelayResumeAccess({
        ownerId: "owner-b",
        snapshot,
        startingAfter: 0,
        nowMs: 1_000,
      }),
    ).toEqual({ ok: false, status: 404, message: "Relay response not found" });
    expect(
      decideRelayResumeAccess({
        ownerId: "owner-a",
        snapshot,
        startingAfter: 0,
        nowMs: 2_000,
      }),
    ).toMatchObject({ ok: false, status: 410 });
    expect(
      decideRelayResumeAccess({
        ownerId: "owner-a",
        snapshot,
        startingAfter: 5,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, status: 416 });
  });

  it("emits one terminal suffix after the stored event cursor", () => {
    expect(relayResumeTerminalSuffix("completed", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    const lost = relayResumeTerminalSuffix("upstream_eof", 7);
    expect(lost).toHaveLength(2);
    expect(lost?.[0]).toContain('"stella_relay_sequence":8');
    expect(lost?.[1]).toBe("data: [DONE]\n\n");
  });

  it("fences account deletion before long drains and performs a final relay pass", () => {
    const source = readFileSync(
      new URL("../../convex/account_deletion.ts", import.meta.url),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf("export const purgeOwnerCloudData"),
    );
    const gate = handler.indexOf("beginOwnerRelayResumePurge");
    const scheduleStop = handler.indexOf("stopOwnerSchedules(ctx, fence)");
    const conversationDrain = handler.indexOf("_listConversationIdsPage");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(conversationDrain);
    expect(scheduleStop).toBeGreaterThan(gate);
    expect(scheduleStop).toBeLessThan(conversationDrain);
    expect(handler.match(/await drain\(\);/gu)).toHaveLength(2);
    expect(handler).toContain("internal.cloud_purge.purgeOwnerCloudStack");
    const cloudPurge = readFileSync(
      new URL("../../convex/cloud_purge.ts", import.meta.url),
      "utf8",
    );
    expect(cloudPurge).toContain("if (unfinished.length > 0)");
    expect(cloudPurge).toContain("the owner activity fence remains active");
  });
});
