/**
 * One call, one process. The Durable Object writes a root-owned request file
 * and execs this; it forwards that one frame to the daemon's socket, writes
 * the daemon's one answer to a root-owned result file, and exits.
 *
 * It holds no state and makes no decision. Everything it could get wrong is a
 * transport failure, and a transport failure is written out as a `failed`
 * response rather than swallowed, so the caller sees a tool error instead of a
 * turn that never returns.
 */

import { connect, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import {
  ATTACHED_TOOL_DIR,
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_REQUEST_MAX_BYTES,
  ATTACHED_TOOL_REQUEST_PATH,
  ATTACHED_TOOL_RESPONSE_MAX_BYTES,
  ATTACHED_TOOL_RESULT_PATH,
  ATTACHED_TOOL_SOCKET_PATH,
  AttachedToolProtocolError,
  type AttachedToolControlResponse,
  type AttachedToolResponse,
  decodeAttachedToolFrame,
  encodeAttachedToolFrame,
  parseAttachedToolControlResponse,
  parseAttachedToolResponse,
} from "./attached-tool-protocol.js";

/**
 * The frame the client writes when the daemon could not be reached or did not
 * answer with a valid frame. It is the only way the worker learns why a call
 * failed, so it must parse as a current-protocol failure: a stale version
 * here turned every transport failure into "frame field version is invalid"
 * and hid the real error behind it.
 */
export const attachedToolClientFailure = (
  request: unknown,
  message: string,
): AttachedToolControlResponse | AttachedToolResponse => {
  const isControl =
    Boolean(request) &&
    typeof request === "object" &&
    "control" in (request as Record<string, unknown>);
  const error = message.slice(0, 8_000) || "The attached tool host is unreachable.";
  return isControl
    ? { version: ATTACHED_TOOL_PROTOCOL_VERSION, status: "failed", error }
    : {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "failed",
        toolCallId: toolCallIdOf(request),
        fingerprint: fingerprintOf(request),
        error,
      };
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export type AttachedToolClientPaths = Readonly<{
  socketPath: string;
  requestPath: string;
  resultPath: string;
}>;

export const attachedToolClientPaths = (
  argv: readonly string[],
): AttachedToolClientPaths => {
  const flag = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && path.isAbsolute(value) && !value.includes("\u0000")
      ? value
      : fallback;
  };
  return {
    socketPath: flag("--socket", ATTACHED_TOOL_SOCKET_PATH),
    requestPath: flag("--request", ATTACHED_TOOL_REQUEST_PATH),
    resultPath: flag("--result", ATTACHED_TOOL_RESULT_PATH),
  };
};

const roundTrip = (socketPath: string, frame: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      outcome();
    };
    const socket: Socket = connect(socketPath, () => {
      socket.write(`${encodeAttachedToolFrame(frame)}\n`, (error) => {
        if (error) finish(() => reject(error));
      });
    });
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (
        Buffer.byteLength(buffered, "utf8") > ATTACHED_TOOL_RESPONSE_MAX_BYTES
      ) {
        finish(() => reject(new AttachedToolProtocolError("frame")));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      finish(() => {
        try {
          resolve(
            decodeAttachedToolFrame(line, ATTACHED_TOOL_RESPONSE_MAX_BYTES),
          );
        } catch (error) {
          reject(asError(error));
        }
      });
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () =>
      finish(() => reject(new AttachedToolProtocolError("frame"))),
    );
  });

/**
 * Forward the pending request and leave exactly one result file behind.
 *
 * The answer is re-parsed here even though the daemon just built it: this
 * process is the one that decides what lands in the file the worker trusts,
 * and a frame it cannot parse must become a stated failure rather than bytes
 * the worker has to interpret.
 */
export const runAttachedToolClient = (
  paths: AttachedToolClientPaths,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const request = yield* Effect.tryPromise({
      try: async () =>
        decodeAttachedToolFrame(
          await readFile(paths.requestPath, "utf8"),
          ATTACHED_TOOL_REQUEST_MAX_BYTES,
        ),
      catch: asError,
    });
    const isControl =
      Boolean(request) &&
      typeof request === "object" &&
      "control" in (request as Record<string, unknown>);
    const answer = yield* Effect.tryPromise({
      try: async () => {
        const frame = await roundTrip(paths.socketPath, request);
        return isControl
          ? parseAttachedToolControlResponse(frame)
          : parseAttachedToolResponse(frame);
      },
      catch: asError,
    }).pipe(
      Effect.catch((error: Error) =>
        Effect.succeed(attachedToolClientFailure(request, error.message)),
      ),
    );
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(ATTACHED_TOOL_DIR, { mode: 0o700, recursive: true });
        await writeFile(
          paths.resultPath,
          `${encodeAttachedToolFrame(answer)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      },
      catch: asError,
    });
  });

const FINGERPRINT = /^[0-9a-f]{64}$/u;

/**
 * A failure frame still has to name the call it failed, and the only place
 * that name exists is the request this process could not deliver. A request
 * too malformed to name one gets placeholders the worker's parser rejects,
 * which is the right outcome: nothing about that call is provable.
 */
const toolCallIdOf = (request: unknown): string => {
  const value = (request as Record<string, unknown> | null)?.toolCallId;
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : "unknown";
};

const fingerprintOf = (request: unknown): string => {
  const value = (request as Record<string, unknown> | null)?.fingerprint;
  return typeof value === "string" && FINGERPRINT.test(value)
    ? value
    : "0".repeat(64);
};
