import { describe, expect, it } from "vitest";
import { getToolResultPreview } from "@stella/runtime/kernel/agent-runtime/shared";
import { pickScheduleToolSummary } from "@/global/schedule/schedule-receipt-summary";

describe("getToolResultPreview", () => {
  it("prefers human-readable Schedule tool result over structured details", () => {
    const preview = getToolResultPreview("Schedule", {
      result:
        "Created morning and evening check-in schedules for discipline rebuild.",
      details: {
        schedule: {
          affected: [
            {
              kind: "cron",
              id: "cron:abc",
              conversationId: "conv-1",
              name: "Morning Anchor",
              enabled: true,
              nextRunAtMs: 1,
            },
          ],
        },
      },
    });

    expect(preview).toBe(
      "Created morning and evening check-in schedules for discipline rebuild.",
    );
    expect(preview).not.toContain('"schedule"');
  });
});

describe("pickScheduleToolSummary", () => {
  it("drops persisted schedule side-channel JSON from dialog summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview:
          '{ "schedule": { "affected": [ { "kind": "cron", "id": "cron:abc", "name": "Morning Anchor" } ] } }',
      }),
    ).toBeUndefined();
  });

  it("keeps plain-language schedule summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview: "Set up daily morning and evening check-ins.",
      }),
    ).toBe("Set up daily morning and evening check-ins.");
  });

  it("extracts the text field from a serialized tool-result envelope", () => {
    const humanText =
      "All registered for conversation conv-1:\n\n1. **Morning Anchor** — daily at 09:00";
    expect(
      pickScheduleToolSummary({
        resultPreview: JSON.stringify({
          content: [{ type: "text", text: humanText }],
        }),
      }),
    ).toBe(humanText);
  });

  it("passes an already-clean string through unchanged", () => {
    const clean = "Registered one reminder for tomorrow at 3pm.";
    expect(pickScheduleToolSummary({ resultPreview: clean })).toBe(clean);
    expect(pickScheduleToolSummary({ resultPreview: ` ${clean}  ` })).toBe(
      clean,
    );
  });

  it("returns undefined for a tool-result envelope without usable text", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview: JSON.stringify({ content: [{ type: "text" }] }),
      }),
    ).toBeUndefined();
  });

  it("suppresses unparseable JSON-looking previews instead of rendering fragments", () => {

    const truncatedEnvelope =
      '{"content":[{"type":"text","text":"Registered the morni';
    expect(
      pickScheduleToolSummary({ resultPreview: truncatedEnvelope }),
    ).toBeUndefined();
    expect(pickScheduleToolSummary({ resultPreview: "{not json" })).toBeUndefined();
    expect(pickScheduleToolSummary({ resultPreview: "[1, 2," })).toBeUndefined();
    expect(
      pickScheduleToolSummary({ resultPreview: '{"some":"other json"}' }),
    ).toBeUndefined();
  });

  it("still surfaces a later prose candidate when the preview is structured", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview: "{not json",
        result: "Paused the deploy check.",
      }),
    ).toBe("Paused the deploy check.");
  });
});
