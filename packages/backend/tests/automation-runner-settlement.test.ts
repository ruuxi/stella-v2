import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { createManagedExecutionSettlementHandle } from "../convex/automation/runner";
import { runConnectorAgentTurnCommitSequence } from "../convex/channels/connector_delivery";
import type { ManagedDispatchGuard } from "../convex/runtime_ai/managed";

const settlementGuard = (
  trace: string[],
  signal = new AbortController().signal,
): ManagedDispatchGuard => ({
  signal,
  beginDispatch: async () => {
    throw new Error("This test only exercises enclosing execution settlement.");
  },
  finishExecution: async (outcome) => {
    trace.push(`execution:${outcome}`);
  },
});

describe("automation runner deferred execution settlement", () => {
  it("orders joined provider, exact usage, delivery CAS, execution, then remote ACK", async () => {
    const trace: string[] = [];
    const settleExecution = createManagedExecutionSettlementHandle(
      settlementGuard(trace),
    );

    await runConnectorAgentTurnCommitSequence({
      runAgent: async () => {
        trace.push("provider-body-joined");
        trace.push("physical-receipt-captured");
        trace.push("usage-disposition-ack");
        return {
          text: "joined result",
          silent: false,
          settleExecution,
        };
      },
      persistAssistant: async () => {
        trace.push("assistant-write-cas");
      },
      deliver: async () => {
        trace.push("delivery-cas");
        return true;
      },
      executionSignal: () => new AbortController().signal,
      finishRemoteAttempt: async (outcome) => {
        trace.push(`remote:${outcome}`);
      },
    });

    // A catch/finally race observes the original promise without settling a
    // second time or changing the already-recorded outcome.
    await settleExecution("failed");
    expect(trace).toEqual([
      "provider-body-joined",
      "physical-receipt-captured",
      "usage-disposition-ack",
      "assistant-write-cas",
      "delivery-cas",
      "execution:succeeded",
      "remote:succeeded",
    ]);
  });

  it("settles a failed delivery once and never reaches a late-delivery branch", async () => {
    const trace: string[] = [];
    const controller = new AbortController();
    const settleExecution = createManagedExecutionSettlementHandle(
      settlementGuard(trace, controller.signal),
    );

    await expect(
      runConnectorAgentTurnCommitSequence({
        runAgent: async () => {
          trace.push("provider-body-joined");
          trace.push("physical-receipt-captured");
          trace.push("usage-disposition-ack");
          return {
            text: "joined result",
            silent: false,
            settleExecution,
          };
        },
        persistAssistant: async () => {
          trace.push("assistant-write-cas");
        },
        deliver: async () => {
          trace.push("delivery-cas-rejected");
          return false;
        },
        executionSignal: () => controller.signal,
        finishRemoteAttempt: async (remoteOutcome) => {
          trace.push(`remote:${remoteOutcome}`);
        },
      }),
    ).rejects.toThrow("Connector delivery was not accepted.");

    await settleExecution("succeeded");
    expect(trace).toEqual([
      "provider-body-joined",
      "physical-receipt-captured",
      "usage-disposition-ack",
      "assistant-write-cas",
      "delivery-cas-rejected",
      "execution:failed",
      "remote:failed",
    ]);
  });

  it("keeps delivery CAS ahead of both settlement acknowledgements in production", () => {
    const source = readFileSync(
      new URL("../convex/channels/connector_delivery.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function runFallbackAndDeliver");
    const end = source.indexOf(
      "async function persistConnectorAssistantMessage",
      start,
    );
    const body = source.slice(start, end);
    expect(body.indexOf("runConnectorAgentTurnCommitSequence")).toBeGreaterThan(
      -1,
    );
    expect(body.indexOf("acknowledgeUsageDisposition:")).toBeGreaterThan(
      body.indexOf("runConnectorAgentTurnCommitSequence"),
    );
    expect(body.indexOf("persistConnectorAssistantMessage")).toBeGreaterThan(
      body.indexOf("acknowledgeUsageDisposition:"),
    );
    expect(body.indexOf("deliverToConnectorCore")).toBeGreaterThan(
      body.indexOf("persistConnectorAssistantMessage"),
    );
    expect(body).not.toContain("recordManagedUsage");
    expect(body).not.toContain("scheduleManagedUsage");

    const deliveryStart = source.indexOf(
      "async function deliverToConnectorCore",
    );
    const deliveryEnd = source.indexOf("type SettleExecution", deliveryStart);
    expect(source.slice(deliveryStart, deliveryEnd)).not.toContain(
      "finishRemoteTurnAttemptInternal",
    );
  });
});
