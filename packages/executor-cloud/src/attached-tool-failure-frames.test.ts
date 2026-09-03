import { describe, expect, test } from "bun:test";
import { attachedToolClientFailure } from "./attached-tool-client.js";
import { attachedToolAnswerFailure } from "./attached-tool-host.js";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  parseAttachedToolControlResponse,
  parseAttachedToolResponse,
} from "./attached-tool-protocol.js";

const TOOL_CALL_ID = "call_7f3a";
const FINGERPRINT = "a".repeat(64);

const controlRequest = {
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: "turn-1",
  attemptGeneration: 1,
  control: "quiesce",
  linkedPaths: [],
};

const toolRequest = {
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: "turn-1",
  attemptGeneration: 1,
  toolCallId: TOOL_CALL_ID,
  fingerprint: FINGERPRINT,
  toolName: "exec_command",
  params: { cmd: "true" },
};

/**
 * Every failure frame either side writes must parse under the current
 * protocol. A stale version on the client's frame turned each transport
 * failure into "frame field version is invalid" at the worker and hid the
 * real error — including the one that failed a follow-up turn's quiesce.
 */
describe("attached tool failure frames", () => {
  test("the client's control failure carries the message under the current version", () => {
    const frame = attachedToolClientFailure(controlRequest, "socket closed");
    expect(frame.version).toBe(ATTACHED_TOOL_PROTOCOL_VERSION);
    expect(parseAttachedToolControlResponse(frame)).toEqual({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "failed",
      error: "socket closed",
    });
  });

  test("the client's tool failure names the call it failed", () => {
    const frame = attachedToolClientFailure(toolRequest, "ECONNREFUSED");
    expect(parseAttachedToolResponse(frame)).toMatchObject({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "failed",
      toolCallId: TOOL_CALL_ID,
      fingerprint: FINGERPRINT,
      error: "ECONNREFUSED",
    });
  });

  test("the daemon answers a failed control call with a parseable failure", () => {
    const frame = attachedToolAnswerFailure(
      controlRequest,
      "tool host shutdown failed",
    );
    expect(parseAttachedToolControlResponse(frame)).toEqual({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "failed",
      error: "tool host shutdown failed",
    });
  });

  test("the daemon answers a failed tool call with the call's own identity", () => {
    const frame = attachedToolAnswerFailure(toolRequest, "boom");
    expect(parseAttachedToolResponse(frame)).toMatchObject({
      status: "failed",
      toolCallId: TOOL_CALL_ID,
      fingerprint: FINGERPRINT,
      error: "boom",
    });
  });

  test("an empty message still yields a bounded, parseable failure", () => {
    const frame = attachedToolClientFailure(controlRequest, "");
    const parsed = parseAttachedToolControlResponse(frame);
    expect(parsed.status).toBe("failed");
    expect(parsed.status === "failed" ? parsed.error.length : 0).toBeGreaterThan(0);
  });
});
