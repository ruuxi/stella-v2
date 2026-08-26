import { describe, expect, it, vi } from "vitest";

import type { ComputerUseRequest } from "@stella/runtime/kernel/computer-use/contract";
import {
  ComputerUseProtocolError,
  ComputerUseSessionError,
  createComputerUseSession,
  executeComputerUseRequest,
} from "@stella/runtime/kernel/computer-use/session";

const request = {
  schemaVersion: 2,
  protocolVersion: "2.0",
  requestId: "request-1",
  sessionId: "session-1",
  type: "action",
  execution: "background",
  command: {
    target: { type: "app", app: "Notes" },
    observedStateId: "state_observed",
    action: { type: "press_key", key: "ENTER" },
  },
} as const satisfies ComputerUseRequest;

describe("ComputerUseSession", () => {
  it("accepts an injected session and validates matching receipts", async () => {
    const handler = vi.fn(async () => ({
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-1",
      sessionId: "session-1",
      type: "action",
      receipt: {
        type: "action",
        action: "press_key",
        target: { type: "app", app: "Notes" },
        status: "accepted",
        deferred: true,
      },
    }));

    await expect(
      executeComputerUseRequest(createComputerUseSession(handler), request),
    ).resolves.toMatchObject({ type: "action" });
    expect(handler).toHaveBeenCalledWith(request, undefined);
  });

  it("rejects correlation and receipt mismatches", async () => {
    const mismatch = createComputerUseSession(async () => ({
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "wrong-request",
      sessionId: "session-1",
      type: "action",
      receipt: {
        type: "action",
        action: "click_element",
        target: { type: "app", app: "Notes" },
        status: "accepted",
        deferred: true,
      },
    }));

    await expect(
      executeComputerUseRequest(mismatch, request),
    ).rejects.toBeInstanceOf(ComputerUseProtocolError);
  });

  it("turns typed error responses into stable session errors", async () => {
    const failed = createComputerUseSession(async () => ({
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-1",
      sessionId: "session-1",
      type: "error",
      error: {
        code: "policy_denied",
        message: "App control denied.",
        retryable: false,
      },
    }));

    const result = executeComputerUseRequest(failed, request);
    await expect(result).rejects.toBeInstanceOf(ComputerUseSessionError);
    await expect(result).rejects.toMatchObject({
      code: "policy_denied",
      requestId: "request-1",
      retryable: false,
    });
  });
});
