import { describe, expect, test } from "bun:test";

import {
  assertBun14,
  assertHashOnlyAcceptanceResult,
  minimalChildSystemEnvironment,
} from "./cloud-canonical-rn-acceptance.mjs";

const source = (name: string) =>
  Bun.file(new URL(name, import.meta.url)).text();

describe("mounted mobile cloud-canonical acceptance contract", () => {
  test("fails closed outside the acceptance Bun 1.4 runtime", () => {
    expect(assertBun14("1.4.0")).toBe("1.4.0");
    expect(assertBun14("1.4.3+build")).toBe("1.4.3+build");
    expect(() => assertBun14("1.3.14")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14("2.0.0")).toThrow("Bun 1.4.x is required");
  });

  test("rejects raw authority fields, sensitive values, and malformed hashes", () => {
    const digest = "a".repeat(64);
    expect(
      assertHashOnlyAcceptanceResult(
        {
          receipts: [
            {
              surface: "mobile-http",
              operation: "mobile.execution.submit",
              outcome: "accepted",
              requestIdSha256: digest,
            },
          ],
          summarySha256: digest,
        },
        { sensitiveValues: ["raw-secret-authority"] },
      ),
    ).toBeTruthy();
    expect(() =>
      assertHashOnlyAcceptanceResult({ conversationId: "raw-conversation" }),
    ).toThrow("forbidden in a hash-only acceptance result");
    expect(() =>
      assertHashOnlyAcceptanceResult(
        { outcome: "raw-secret-authority" },
        { sensitiveValues: ["raw-secret-authority"] },
      ),
    ).toThrow("exposed a raw acceptance authority value");
    expect(() =>
      assertHashOnlyAcceptanceResult({ requestIdSha256: "not-a-hash" }),
    ).toThrow("is not a SHA-256 digest");
  });

  test("passes only a minimal system environment into mounted children", () => {
    const child = minimalChildSystemEnvironment({
      PATH: "/acceptance/bin",
      TMPDIR: "/acceptance/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      CLOUDFLARE_API_TOKEN: "must-not-cross",
      CONVEX_DEPLOY_KEY: "must-not-cross",
    });
    expect(child).toEqual({
      PATH: "/acceptance/bin",
      TMPDIR: "/acceptance/tmp",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      NODE_ENV: "test",
      NO_COLOR: "1",
    });
    expect(JSON.stringify(child)).not.toContain("must-not-cross");
  });

  test("mounts the real hook and storage/lifecycle adapters without replacing product authority", async () => {
    const [live, preload] = await Promise.all([
      source("./cloud-canonical-rn-acceptance.live.test.tsx"),
      source("./cloud-canonical-rn-acceptance.preload.ts"),
    ]);
    expect(live).toContain("useCloudCanonicalChatThread(authority)");
    expect(live).toContain("enqueueDesktopChatOutbox");
    expect(live).toContain("loadDesktopChatOutbox");
    expect(live).toContain("saveChatMessages");
    expect(live).toContain('setVisibility("hidden")');
    expect(live).toContain('setVisibility("visible")');
    expect(live).toContain("dropLatestSocket()");
    expect(preload).toContain("new RealWebSocket(url, protocols)");
    expect(preload).toContain("DurableWebStorage implements Storage");
    expect(preload).toContain('mock.module("react-native"');
    expect(preload).not.toContain(
      'mock.module("@react-native-async-storage/async-storage"',
    );
    expect(preload).not.toContain("FakeWebSocket");
    expect(preload).not.toContain("mockFetch");
    expect(preload).not.toContain('auth-token.ts",');
    expect(preload).toContain('phase: "status-terminal"');
    expect(preload).toContain('phase: "response-released"');
  });

  test("uses fresh child processes, a response-after-commit fault, and a live reset barrier", async () => {
    const [orchestrator, live] = await Promise.all([
      source("./cloud-canonical-rn-acceptance.mjs"),
      source("./cloud-canonical-rn-acceptance.live.test.tsx"),
    ]);
    for (const phase of [
      "enqueue_response_loss",
      "replay_reconnect_switch",
      "clean_hydrate",
      "generation_rotation",
    ]) {
      expect(orchestrator + live).toContain(phase);
    }
    expect(orchestrator).toContain("spawn(\n    process.execPath");
    expect(orchestrator).not.toContain("...process.env");
    expect(live).toContain("sha256(`${runId}:${process.pid}`)");
    expect(live).not.toContain("${process.pid}:${runId}:");
    expect(orchestrator).toContain("actualProductScreenMounted: false");
    expect(orchestrator).toContain("nativeAsyncStorageBackendProved: false");
    expect(orchestrator).toContain('executor: "bun-jsdom-react-native-web"');
    expect(live).toContain("serverCommittedBeforeResponseLoss: true");
    expect(live).toContain("asyncStorageWriteCompletedBeforeNetwork: true");
    expect(live).toContain("recoveredRecordCount > 0");
    expect(live).toContain("terminalAcknowledgement.ordinal >");
    expect(live).toContain("blockedSendPreservedDraft:");
    expect(live).toContain("STELLA_MOBILE_ACCEPTANCE_ROTATION_BARRIER_DIR");
    expect(live).toContain("serverAdmissionResponseHeldAcrossReset: true");
    expect(live).toContain("oldRowsAfterRotation.length === 0");
    expect(live).toContain("newRowsAfterOldCallback.some");
    expect(live).not.toContain("oldGenerationOutboxPurged: true");
    expect(live).not.toContain("staleCallbackDropCount: 1");
  });
});
