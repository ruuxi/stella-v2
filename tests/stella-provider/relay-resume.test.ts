import { describe, expect, it } from "bun:test";

import {
  RelayResumeSseParser,
  RelayResumeFrameTooLargeError,
  STELLA_RELAY_RESUME_MAX_BYTES,
  STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS,
  STELLA_RELAY_RESUME_RAW_FRAME_MAX_BYTES,
  decideRelayResumeAccess,
  relayResumeChunkEvents,
  relayResumeEventBytes,
  relayResumeNextPollDelay,
  relayRequestIdFromIdempotencyKey,
  relayResumeStreamIsStale,
  relayResumeTerminalSuffix,
} from "../../convex/stella_provider/relay_resume";

const sse = (event: Record<string, unknown>): string =>
  `data: ${JSON.stringify(event)}\n\n`;

describe("relay-owned Responses SSE cursoring", () => {
  it("derives stable owner-scoped opaque relay ids for old clients", async () => {
    const first = await relayRequestIdFromIdempotencyKey(
      "owner-a",
      "stella-response-stable-key",
    );
    expect(
      await relayRequestIdFromIdempotencyKey(
        "owner-a",
        "stella-response-stable-key",
      ),
    ).toBe(first);
    expect(
      await relayRequestIdFromIdempotencyKey(
        "owner-b",
        "stella-response-stable-key",
      ),
    ).not.toBe(first);
    expect(first).toMatch(/^stella-relay-[a-f0-9]{64}$/u);
    expect(first).not.toContain("stable-key");
  });

  it("assigns stable monotonic relay sequences across split transport chunks", () => {
    const parser = new RelayResumeSseParser();
    const wire =
      sse({
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_upstream", status: "in_progress" },
      }) +
      sse({
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "hel",
      }) +
      sse({
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        delta: '{"q":"x"}',
      }) +
      sse({
        type: "response.completed",
        sequence_number: 3,
        response: { id: "resp_upstream", status: "completed" },
      }) +
      "data: [DONE]\n\n";

    const frames = [
      ...parser.push(wire.slice(0, 37)),
      ...parser.push(wire.slice(37, 143)),
      ...parser.push(wire.slice(143)),
    ];
    const events = frames.flatMap((frame) =>
      frame.kind === "event" ? [frame.event] : [],
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[0]).toMatchObject({
      responseId: "resp_upstream",
      responseStatus: "in_progress",
    });
    expect(events[3]).toMatchObject({
      eventType: "response.completed",
      terminalStatus: "completed",
    });
    expect(
      events
        .map((event) => JSON.parse(event.frame.slice(6)))
        .map((event) => event.stella_relay_sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(frames.at(-1)).toMatchObject({ kind: "done" });
  });

  it("keeps replay chunks bounded without duplicating text or tool events", () => {
    const parser = new RelayResumeSseParser();
    const frames = parser.push(
      sse({ type: "response.output_text.delta", delta: "A" }) +
        sse({ type: "response.function_call_arguments.delta", delta: "B" }) +
        sse({ type: "response.output_text.delta", delta: "C" }),
    );
    const events = frames.flatMap((frame) =>
      frame.kind === "event" ? [frame.event] : [],
    );
    const chunks = relayResumeChunkEvents(events);
    const replayed = chunks.flat().filter((event) => event.sequence > 1);

    expect(replayed.map((event) => event.sequence)).toEqual([2, 3]);
    expect(replayed.map((event) => event.eventType)).toEqual([
      "response.function_call_arguments.delta",
      "response.output_text.delta",
    ]);
    expect(
      chunks
        .flat()
        .reduce((sum, event) => sum + relayResumeEventBytes(event), 0),
    ).toBeLessThan(STELLA_RELAY_RESUME_MAX_BYTES);
  });

  it("fails closed when an EOF arrives after partial events without a terminal", () => {
    const parser = new RelayResumeSseParser();
    const frames = parser.push(
      sse({ type: "response.created", response: { id: "resp_partial" } }) +
        sse({ type: "response.output_text.delta", delta: "partial" }),
    );
    expect(
      frames.some(
        (frame) => frame.kind === "event" && frame.event.terminalStatus,
      ),
    ).toBe(false);
    const suffix = relayResumeTerminalSuffix("upstream_eof", 2)!;
    expect(suffix[0]).toContain('"type":"error"');
    expect(suffix[0]).toContain('"stella_relay_sequence":3');
    expect(suffix[1]).toBe("data: [DONE]\n\n");
  });

  it("parses UTF-8 splits, all SSE line endings, comments, and multiline data", () => {
    const parser = new RelayResumeSseParser();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const wire =
      ": keepalive\r\r" +
      'data: {"type":"response.output_text.delta",\r\ndata: "delta":"🙂"}\r\n\r\n' +
      'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n';
    const bytes = encoder.encode(wire);
    const frames = [];
    for (let index = 0; index < bytes.length; index += 1) {
      frames.push(
        ...parser.push(
          decoder.decode(bytes.slice(index, index + 1), { stream: true }),
        ),
      );
    }
    frames.push(...parser.push(decoder.decode()));
    frames.push(...parser.finish().frames);

    expect(frames[0]).toMatchObject({ kind: "passthrough", replaySafe: true });
    expect(frames[1]).toMatchObject({
      kind: "event",
      event: { eventType: "response.output_text.delta" },
    });
    expect(frames[1]?.kind === "event" ? frames[1].event.frame : "").toContain(
      "🙂",
    );
    expect(frames[2]).toMatchObject({
      kind: "event",
      event: { terminalStatus: "incomplete" },
    });
  });

  it("rejects malformed and unbounded unterminated SSE frames", () => {
    const malformed = new RelayResumeSseParser().push("data: {bad json}\n\n");
    expect(malformed).toEqual([
      expect.objectContaining({ kind: "passthrough", replaySafe: false }),
    ]);

    const parser = new RelayResumeSseParser();
    expect(() =>
      parser.push(
        `data: ${"x".repeat(STELLA_RELAY_RESUME_RAW_FRAME_MAX_BYTES + 1)}`,
      ),
    ).toThrow(RelayResumeFrameTooLargeError);
  });

  it("strips exactly one leading byte-order mark, including split BOM bytes", () => {
    // Character-level BOM ahead of the first field.
    const charBom = new RelayResumeSseParser().push(
      `\uFEFF${sse({ type: "response.created", response: { id: "resp_bom" } })}`,
    );
    expect(charBom).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ eventType: "response.created" }),
      }),
    ]);

    // Byte-level BOM split across transport chunks, decoded by a decoder that
    // preserves the mark (regression: the parser must not depend on decoder
    // BOM handling).
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const bytes = new TextEncoder().encode(
      `\uFEFF${sse({ type: "response.output_text.delta", delta: "hi" })}`,
    );
    const parser = new RelayResumeSseParser();
    const frames = [
      ...parser.push(decoder.decode(bytes.slice(0, 2), { stream: true })),
      ...parser.push(decoder.decode(bytes.slice(2), { stream: true })),
    ];
    expect(frames).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          eventType: "response.output_text.delta",
          sequence: 1,
        }),
      }),
    ]);

    // Only the leading mark is special: a later U+FEFF is content.
    const midStream = new RelayResumeSseParser();
    midStream.push(sse({ type: "response.created" }));
    const later = midStream.push(
      `data: {"type":"response.output_text.delta","delta":"\uFEFF"}\n\n`,
    );
    expect(later).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ sequence: 2 }),
      }),
    ]);
    expect(
      later[0]!.kind === "event" &&
        (JSON.parse(later[0]!.event.frame.slice(6)) as { delta: string }).delta,
    ).toBe("\uFEFF");
  });

  it("handles malformed fields and dispatches a final EOF-terminated event", () => {
    const ignoredField = new RelayResumeSseParser().push(
      "bogus-field: ignored\ndata\n\n",
    );
    expect(ignoredField).toEqual([
      expect.objectContaining({ kind: "passthrough", replaySafe: false }),
    ]);

    const parser = new RelayResumeSseParser();
    expect(parser.push('data: {"type":"response.completed"}')).toEqual([]);
    expect(parser.finish().frames).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ terminalStatus: "completed" }),
      }),
    ]);
  });
});

describe("relay resume isolation and retention", () => {
  const snapshot = {
    ownerId: "owner:a",
    expiresAt: 20_000,
    hardExpiresAt: 30_000,
    lastSequence: 7,
  };

  it("denies a cross-user cursor without disclosing whether it exists", () => {
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:b",
        snapshot,
        startingAfter: 3,
        nowMs: 10_000,
      }),
    ).toEqual({ ok: false, status: 404, message: "Relay response not found" });
  });

  it("returns an explicit expiry and rejects cursors ahead of durable state", () => {
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:a",
        snapshot,
        startingAfter: 3,
        nowMs: 20_000,
      }),
    ).toMatchObject({ ok: false, status: 410 });
    expect(
      decideRelayResumeAccess({
        ownerId: "owner:a",
        snapshot,
        startingAfter: 8,
        nowMs: 10_000,
      }),
    ).toMatchObject({ ok: false, status: 416 });
  });

  it("replays terminal streams as finite SSE responses", () => {
    expect(relayResumeTerminalSuffix("completed", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    expect(relayResumeTerminalSuffix("failed", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    expect(relayResumeTerminalSuffix("error", 7)).toEqual(["data: [DONE]\n\n"]);
    expect(relayResumeTerminalSuffix("incomplete", 7)).toEqual([
      "data: [DONE]\n\n",
    ]);
    expect(relayResumeTerminalSuffix("streaming", 7)).toBeNull();
    expect(relayResumeTerminalSuffix("canceled", 7)?.[0]).toContain(
      '"code":"relay_stream_canceled"',
    );
  });

  it("fails an orphaned stream after the redeploy heartbeat window", () => {
    expect(relayResumeStreamIsStale(10_000, 40_000)).toBe(false);
    expect(relayResumeStreamIsStale(10_000, 40_001)).toBe(true);
  });

  it("bounds incremental reads and exponentially backs off when caught up", () => {
    expect(STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS).toBeLessThanOrEqual(2);
    expect(relayResumeNextPollDelay(100, false)).toBe(200);
    expect(relayResumeNextPollDelay(800, false)).toBe(1_000);
    expect(relayResumeNextPollDelay(1_000, false)).toBe(1_000);
    expect(relayResumeNextPollDelay(1_000, true)).toBe(100);
  });
});
