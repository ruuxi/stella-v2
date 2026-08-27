import { describe, expect, test } from "bun:test";

import {
  pickScheduleToolSummary,
  scheduleReceiptText,
} from "../schedule-receipt-summary";

describe("pickScheduleToolSummary", () => {
  test("drops persisted schedule side-channel JSON from summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview:
          '{ "schedule": { "affected": [ { "kind": "cron", "id": "cron:abc", "name": "Morning Anchor" } ] } }',
      }),
    ).toBeUndefined();
  });

  test("keeps plain-language schedule summaries", () => {
    expect(
      pickScheduleToolSummary({
        resultPreview: "Set up daily morning and evening check-ins.",
      }),
    ).toBe("Set up daily morning and evening check-ins.");
  });

  test("unwraps a serialized tool-result envelope (older desktops)", () => {
    expect(
      pickScheduleToolSummary({
        result:
          '{"content":[{"type":"text","text":"Created morning and evening check-ins."}]}',
      }),
    ).toBe("Created morning and evening check-ins.");
  });

  test("unparseable / empty values render nothing", () => {
    expect(pickScheduleToolSummary({ result: "" })).toBeUndefined();
    expect(
      pickScheduleToolSummary({ resultPreview: "{not json" }),
    ).toBeUndefined();
  });

  test("suppresses JSON-looking previews instead of rendering fragments", () => {

    expect(
      pickScheduleToolSummary({
        resultPreview: '{"content":[{"type":"text","text":"Registered the morni',
      }),
    ).toBeUndefined();
    expect(pickScheduleToolSummary({ resultPreview: "[1, 2," })).toBeUndefined();
    expect(
      pickScheduleToolSummary({ resultPreview: '{"some":"other json"}' }),
    ).toBeUndefined();

    expect(
      pickScheduleToolSummary({
        resultPreview: "{not json",
        result: "Paused the deploy check.",
      }),
    ).toBe("Paused the deploy check.");
  });
});

describe("scheduleReceiptText", () => {
  test("parsed envelope result resolves to clean text", () => {
    expect(
      scheduleReceiptText({
        result: {
          content: [
            {
              type: "text",
              text:
                "Created morning and evening check-in schedules for discipline rebuild.",
            },
          ],
        },
      }),
    ).toBe(
      "Created morning and evening check-in schedules for discipline rebuild.",
    );
  });

  test("serialized envelope result resolves to clean text", () => {
    expect(
      scheduleReceiptText({
        result:
          '{"content":[{"type":"text","text":"Paused the deploy check."}]}',
      }),
    ).toBe("Paused the deploy check.");
  });

  test("plain-string result passes through the summary picker", () => {
    expect(
      scheduleReceiptText({ resultPreview: "Set up daily check-ins." }),
    ).toBe("Set up daily check-ins.");
  });

  test("side-channel JSON preview yields nothing to render", () => {
    expect(
      scheduleReceiptText({
        resultPreview:
          '{ "schedule": { "affected": [ { "kind": "cron", "id": "cron:abc" } ] } }',
      }),
    ).toBeUndefined();
  });

  test("envelope carrying side-channel JSON does not leak raw structure", () => {
    expect(
      scheduleReceiptText({
        result: {
          content: [
            {
              type: "text",
              text: '{ "schedule": { "affected": [ { "id": "cron:abc" } ] } }',
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  test("envelope with no text blocks falls back to the preview", () => {
    expect(
      scheduleReceiptText({
        result: { content: [{ type: "image" }] },
        resultPreview: "Scheduled a weekly review.",
      }),
    ).toBe("Scheduled a weekly review.");
  });

  test("unparseable payloads render nothing", () => {
    expect(scheduleReceiptText({ result: { unexpected: true } })).toBeUndefined();
    expect(scheduleReceiptText({})).toBeUndefined();
  });
});
