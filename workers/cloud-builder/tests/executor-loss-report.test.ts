import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  Files: class {},
  SandboxFileError: { is: () => false },
}));
const { executorLossText, recoveredAgentReport } = await import(
  "../src/build-session/alarms-recovery.js"
);
mock.restore();

const assistant = (text: string) =>
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
  });

const hostWith = (rows: unknown) =>
  ({
    fetchCanonicalAgentHistory: () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  }) as never;

const turn = { turnId: "turn-1", attemptGeneration: 1 } as never;

describe("an agent whose executor was lost after saving its workspace", () => {
  test("hands over the last report it actually produced", () => {
    const report = recoveredAgentReport(
      hostWith([
        { seq: 1, turnId: "turn-0", role: "assistant", payloadJson: assistant("Older turn.") },
        { seq: 2, turnId: "turn-1", role: "user", payloadJson: JSON.stringify({ role: "user" }) },
        { seq: 3, turnId: "turn-1", role: "assistant", payloadJson: assistant("Freed 42 GB.") },
      ]),
      turn,
    );
    expect(report).toBe("Freed 42 GB.");
    const text = executorLossText(report);
    expect(text.message).toContain("Freed 42 GB.");
    expect(text.message).not.toContain("could not be recovered");
    expect(text.threadError).toContain("recovered from its transcript");
  });

  test("prefers the newest assistant text of this attempt", () => {
    expect(
      recoveredAgentReport(
        hostWith([
          { seq: 1, turnId: "turn-1", role: "assistant", payloadJson: assistant("First pass.") },
          { seq: 2, turnId: "turn-1", role: "assistant", payloadJson: assistant("Final pass.") },
        ]),
        turn,
      ),
    ).toBe("Final pass.");
  });

  test("ignores other turns, tool results and empty content", () => {
    expect(
      recoveredAgentReport(
        hostWith([
          { seq: 1, turnId: "turn-0", role: "assistant", payloadJson: assistant("Another turn.") },
          { seq: 2, turnId: "turn-1", role: "toolResult", payloadJson: assistant("Tool output.") },
          { seq: 3, turnId: "turn-1", role: "assistant", payloadJson: assistant("   ") },
          { seq: 4, turnId: "turn-1", role: "assistant", payloadJson: "not json" },
        ]),
        turn,
      ),
    ).toBeNull();
  });

  test("still says the report was lost when there is nothing to recover", () => {
    const text = executorLossText(recoveredAgentReport(hostWith([]), turn));
    expect(text.message).toContain("could not be recovered");
  });

  test("survives a history read that fails", () => {
    expect(
      recoveredAgentReport(hostWith(new Error("storage gone")), turn),
    ).toBeNull();
  });

  test("bounds a very long report", () => {
    const report = recoveredAgentReport(
      hostWith([
        {
          seq: 1,
          turnId: "turn-1",
          role: "assistant",
          payloadJson: assistant("x".repeat(20_000)),
        },
      ]),
      turn,
    );
    expect(report).toContain("[Report truncated]");
    expect(report!.length).toBeLessThan(9_000);
  });
});
