import { describe, expect, it } from "vitest";
import {
  formatCallTime,
  formatCost,
  formatPercent,
  formatTokens,
  shortId,
  threadLabel,
} from "../../../src/app/usage/format";

describe("usage formatting", () => {
  it("formats tokens with standard notation below 10k and compact above", () => {
    expect(formatTokens(9_999)).toBe(
      new Intl.NumberFormat(undefined, {
        notation: "standard",
        maximumFractionDigits: 1,
      }).format(9_999),
    );
    expect(formatTokens(1_250_000)).toBe(
      new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(1_250_000),
    );
  });

  it("formats costs with sub-cent precision", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0042)).toBe("$0.00420");
    expect(formatCost(1.2345)).toBe("$1.234");
  });

  it("formats percentages", () => {
    expect(formatPercent(0.6)).toBe("60.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("formats call timestamps with the cached formatter", () => {
    const timestamp = new Date("2026-08-08T12:34:56Z").getTime();
    expect(formatCallTime(timestamp)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(timestamp),
    );
  });

  it("shortens long ids and keeps short ones intact", () => {
    expect(shortId("thread-123")).toBe("thread-123");
    expect(shortId("thread-0123456789abcdef0123456789")).toBe(
      "thread-01…3456789",
    );
  });

  it("labels threads by name with an execution fallback", () => {
    expect(
      threadLabel({ threadName: "Inspect pricing", agentType: "general" }),
    ).toBe("Inspect pricing");
    expect(
      threadLabel({ threadName: "", agentType: "general", agentDepth: 2 }),
    ).toBe("Sub-agent · general");
    expect(threadLabel({ threadName: "", agentType: "" })).toBe(
      "Agent · unknown",
    );
  });
});
