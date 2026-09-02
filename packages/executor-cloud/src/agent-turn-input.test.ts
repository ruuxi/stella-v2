import { describe, expect, test } from "bun:test";
import {
  parseCloudModelGatewayInput,
  type AgentTurnInput,
} from "./agent-turn.js";

/**
 * What the sandbox is handed for one turn.
 *
 * The executor holds exactly two credentials now: a one-shot pointer to the
 * BuildSession's turn broker, and a turn capability that is only meaningful at
 * the model gateway. There is no reusable Convex turn token and no Convex
 * callback base — the control plane is unreachable from inside the sandbox,
 * and the broker is what mediates the calls a turn is still allowed to make.
 */

const CAPABILITY = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2ln";

const input: AgentTurnInput = {
  kind: "agent",
  ownerId: "owner-1",
  ownerGeneration: "generation-1",
  conversationId: "conversation-1",
  threadId: "thread-1",
  turnId: "turn-1",
  attemptGeneration: 1,
  prompt: "do the thing",
  workspaceRestored: false,
  nativeStateIntegrityKey: "a".repeat(64),
  turnBroker: { credentialsPath: "/workspace/.turn-broker-1.json" },
  modelGateway: { origin: "https://gateway.example", capability: CAPABILITY },
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/default",
    reasoningEffort: "default",
  },
};

describe("agent turn input", () => {
  test("carries no reusable control-plane credential", () => {
    const keys = Object.keys(input);
    expect(keys).not.toContain("turnToken");
    expect(keys).not.toContain("convexCallbackBase");
    expect(keys).not.toContain("convexSiteUrl");
    expect(input.turnBroker).toEqual({
      credentialsPath: "/workspace/.turn-broker-1.json",
    });
    expect(input.modelGateway.capability).toBe(CAPABILITY);
  });

  test("the model gateway input fails closed on anything but an origin and a JWS", () => {
    expect(parseCloudModelGatewayInput(input.modelGateway)).toEqual({
      origin: "https://gateway.example",
      capability: CAPABILITY,
    });
    // Local development is the only non-HTTPS origin allowed.
    expect(
      parseCloudModelGatewayInput({
        origin: "http://127.0.0.1:8787",
        capability: CAPABILITY,
      }),
    ).toEqual({ origin: "http://127.0.0.1:8787", capability: CAPABILITY });

    for (const malformed of [
      null,
      "not-an-object",
      { origin: "https://gateway.example" },
      { capability: CAPABILITY },
      { origin: "http://gateway.example", capability: CAPABILITY },
      { origin: "https://user:pass@gateway.example", capability: CAPABILITY },
      { origin: "https://gateway.example/path", capability: CAPABILITY },
      { origin: "https://gateway.example?q=1", capability: CAPABILITY },
      { origin: "https://gateway.example", capability: "not.a-jws" },
      { origin: "https://gateway.example", capability: "" },
    ]) {
      expect(parseCloudModelGatewayInput(malformed)).toBeNull();
    }
  });
});
