import { describe, expect, test } from "bun:test";
import {
  ATTACHED_TOOL_NAMES,
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_REQUEST_MAX_BYTES,
  AttachedToolProtocolError,
  attachedToolFingerprint,
  decodeAttachedToolFrame,
  encodeAttachedToolFrame,
  parseAttachedToolControlResponse,
  parseAttachedToolRequest,
  parseAttachedToolResponse,
  parseSerializedAgentToolResult,
} from "./attached-tool-protocol.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: "turn-1",
  attemptGeneration: 1,
  toolCallId: "call-1",
  fingerprint: "a".repeat(64),
  toolName: "exec_command",
  params: { command: "ls" },
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  outcome: { kind: "ok", text: "hello" },
  details: null,
  authorizedImages: [],
  fileChanges: [],
  producedFiles: [],
  producedFilesOmitted: null,
  ...overrides,
});

describe("attached tool protocol", () => {
  test("serves only the four bridged tools", () => {
    expect([...ATTACHED_TOOL_NAMES]).toEqual([
      "exec_command",
      "write_stdin",
      "Read",
      "apply_patch",
    ]);
  });

  test("round-trips a request through the frame codec", () => {
    const parsed = parseAttachedToolRequest(
      decodeAttachedToolFrame(
        encodeAttachedToolFrame(request()),
        ATTACHED_TOOL_REQUEST_MAX_BYTES,
      ),
    );
    expect(parsed.toolName).toBe("exec_command");
    expect(parsed.params).toEqual({ command: "ls" });
  });

  test("refuses a tool the daemon does not serve", () => {
    expect(() =>
      parseAttachedToolRequest(request({ toolName: "code" })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("refuses an unexpected key rather than ignoring it", () => {
    expect(() =>
      parseAttachedToolRequest(request({ turnToken: "secret" })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("refuses a fingerprint that is not a sha256 digest", () => {
    expect(() =>
      parseAttachedToolRequest(request({ fingerprint: "nope" })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("refuses an attempt generation below the first attempt", () => {
    expect(() =>
      parseAttachedToolRequest(request({ attemptGeneration: 0 })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("parses each response status and rejects any other", () => {
    const envelope = {
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      toolCallId: "call-1",
      fingerprint: "b".repeat(64),
    };
    expect(
      parseAttachedToolResponse({
        ...envelope,
        status: "completed",
        result: result(),
      }).status,
    ).toBe("completed");
    expect(
      parseAttachedToolResponse({ ...envelope, status: "pending" }).status,
    ).toBe("pending");
    expect(
      parseAttachedToolResponse({
        ...envelope,
        status: "failed",
        error: "boom",
      }).status,
    ).toBe("failed");
    expect(() =>
      parseAttachedToolResponse({ ...envelope, status: "running" }),
    ).toThrow(AttachedToolProtocolError);
  });

  test("keeps an error result's message and rejects an unknown outcome kind", () => {
    const parsed = parseSerializedAgentToolResult(
      result({ outcome: { kind: "error", message: "exit 1" } }),
    );
    expect(parsed.outcome).toEqual({ kind: "error", message: "exit 1" });
    expect(() =>
      parseSerializedAgentToolResult(result({ outcome: { kind: "warn" } })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("refuses file records that are not file changes", () => {
    expect(() =>
      parseSerializedAgentToolResult(result({ fileChanges: [{ path: 1 }] })),
    ).toThrow(AttachedToolProtocolError);
  });

  test("refuses an image whose mime type is outside the allowed set", () => {
    expect(() =>
      parseSerializedAgentToolResult(
        result({
          authorizedImages: [
            { data: "AAAA", mimeType: "image/svg+xml", sourcePath: "/a.svg" },
          ],
        }),
      ),
    ).toThrow(AttachedToolProtocolError);
  });

  test("parses a quiesce report and its omission counter", () => {
    const parsed = parseAttachedToolControlResponse({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "quiesced",
      producedFiles: [{ path: "/world/out.txt", kind: { type: "add" } }],
      producedFilesOmitted: { count: 3, limit: 200 },
    });
    expect(parsed.status).toBe("quiesced");
  });

  test("fingerprints the same call identically regardless of key order", async () => {
    const left = await attachedToolFingerprint({
      toolName: "exec_command",
      params: { command: "ls", cwd: "/world" },
    });
    const right = await attachedToolFingerprint({
      toolName: "exec_command",
      params: { cwd: "/world", command: "ls" },
    });
    const other = await attachedToolFingerprint({
      toolName: "exec_command",
      params: { command: "rm -rf /", cwd: "/world" },
    });
    expect(left).toBe(right);
    expect(left).not.toBe(other);
    expect(left).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("refuses a frame larger than its bound", () => {
    const oversized = JSON.stringify({ pad: "x".repeat(2048) });
    expect(() => decodeAttachedToolFrame(oversized, 1024)).toThrow(
      AttachedToolProtocolError,
    );
  });
});
