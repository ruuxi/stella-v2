import { describe, expect, it } from "vitest";
import {
  shouldEmitBrowserBridgeGlobalToast,
  STELLA_BROWSER_BRIDGE_FAILURE_REASONS,
  STELLA_BROWSER_BRIDGE_STATES,
} from "@stella/contracts/browser-bridge-status";

const BRIDGE_MISSING_ERROR =
  "Browser bridge is not installed. Reinstall Stella or run the desktop build so the bridge binary is present.";

const BRIDGE_STATUSES = [
  { state: "idle", attempt: 0 },
  { state: "connecting", attempt: 0 },
  { state: "connected", attempt: 0 },
  {
    state: "reconnecting",
    attempt: 1,
    nextRetryMs: 1000,
    reason: "transient_failure",
  },
  {
    state: "reconnecting",
    attempt: 4,
    nextRetryMs: 8000,
    reason: "bridge_missing",
    error: BRIDGE_MISSING_ERROR,
    notifyUser: true,
  },
  {
    state: "reconnecting",
    attempt: 8,
    nextRetryMs: 8000,
    reason: "connection_lost",
    error: "The Stella browser bridge disconnected",
    notifyUser: true,
  },
  {
    state: "reconnecting",
    attempt: 5,
    nextRetryMs: 8000,
    reason: "authorization_failed",
    error: "permission denied",
    notifyUser: true,
  },
  {
    state: "host_registration_failed",
    attempt: 0,
    reason: "bridge_missing",
    error: BRIDGE_MISSING_ERROR,
    notifyUser: true,
  },
  {
    state: "host_registration_failed",
    attempt: 0,
    reason: "authorization_failed",
    error: "Native messaging host registration failed",
    notifyUser: true,
  },
] as const;

describe("browser bridge global toast policy", () => {
  it("covers every known bridge state and failure reason", () => {
    expect(STELLA_BROWSER_BRIDGE_STATES).toEqual([
      "idle",
      "connecting",
      "connected",
      "reconnecting",
      "host_registration_failed",
    ]);
    expect(STELLA_BROWSER_BRIDGE_FAILURE_REASONS).toEqual([
      "bridge_missing",
      "authorization_failed",
      "connection_lost",
      "transient_failure",
    ]);
  });

  it("never turns optional bridge missing, loss, or retry into a global toast", () => {
    for (const status of BRIDGE_STATUSES) {
      expect(shouldEmitBrowserBridgeGlobalToast(status)).toBe(false);
    }

    for (const state of STELLA_BROWSER_BRIDGE_STATES) {
      for (const reason of STELLA_BROWSER_BRIDGE_FAILURE_REASONS) {
        expect(
          shouldEmitBrowserBridgeGlobalToast({
            state,
            reason,
            notifyUser: true,
            error: BRIDGE_MISSING_ERROR,
            attempt: 9,
            nextRetryMs: 8000,
          }),
        ).toBe(false);
      }
    }
  });
});
