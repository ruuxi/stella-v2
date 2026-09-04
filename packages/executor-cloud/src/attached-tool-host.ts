/**
 * The resident tool-host daemon for an attached sandbox.
 *
 * One daemon per turn, started when the Durable Object attaches the container
 * and joined when the turn quiesces. It exists because `write_stdin` writes to
 * the PTY `exec_command` created: a per-call exec would lose that shell, so
 * the shell state has to outlive any single call and the tool host is created
 * exactly once here.
 *
 * The daemon serves only `ATTACHED_TOOL_NAMES` over a root-only Unix socket.
 * It never sees the reusable turn token; the broker capability it consumes is
 * the same one-shot file handoff the container executor already uses, and it
 * spends that only on the drive routes.
 *
 * Idempotency is `toolCallId` plus an argument fingerprint. A repeat of a
 * completed call replays its cached result. A repeat of a call still running
 * answers `pending`. A repeat of a call whose outcome the daemon cannot prove
 * answers `failed`, because a command may already have crossed a boundary the
 * world cannot undo and guessing would run it twice.
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { Deferred, Effect } from "effect";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";
import type {
  ToolContext,
  ToolHost,
} from "@stella/runtime/kernel/tools/host.js";
import {
  TOOL_RESULT_AUTHORIZED_IMAGES,
  type ToolResult,
} from "@stella/runtime/kernel/tools/types.js";
import type { TurnBrokerInput } from "@stella/contracts/turn-credential-broker";
import {
  ATTACHED_TOOL_MAX_DELIVERED_FILES,
  ATTACHED_TOOL_MAX_IMAGES,
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_REQUEST_MAX_BYTES,
  ATTACHED_TOOL_RESPONSE_MAX_BYTES,
  type AttachedToolPaths,
  AttachedToolProtocolError,
  decodeAttachedToolFrame,
  encodeAttachedToolFrame,
  isAttachedToolName,
  parseAttachedToolControlRequest,
  parseAttachedToolRequest,
  type AttachedToolControlResponse,
  type AttachedToolResponse,
  type SerializedAgentToolResult,
  type SerializedAuthorizedImage,
} from "./attached-tool-protocol.js";
import {
  hydrateDriveForAgentTurn,
  prepareCloudToolFilesystem,
} from "./agent-turn.js";
import { collectProducedFiles, reportProducedFiles } from "./produced-files.js";
import {
  takeTurnBrokerHandoff,
  TurnCredentialBrokerClient,
} from "./turn-credential-broker.js";
import { driveHydrationNotice } from "./general-agent-prompt.js";
import {
  CLOUD_HOST_STATE,
  CLOUD_TOOL_HOME,
  CLOUD_TOOL_PROCESS_IDENTITY,
} from "./cloud-process-isolation.js";
import { cloudAgentToolContext } from "./cloud-tool-context.js";
import {
  toolStateDir,
  worldDriveWorkspace,
  worldRootForFork,
} from "./workspace-paths.js";
import { pullWorldProjection, pushWorldProjection } from "./world-sync.js";

export type AttachedToolHostInput = Readonly<{
  turnId: string;
  attemptGeneration: number;
  threadId: string;
  prompt: string;
  workspaceRestored: boolean;
  turnBroker: TurnBrokerInput;
  world: Readonly<{
    origin: string;
    name: string;
    capability: string;
    fork?: string;
  }>;
}>;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Remove only an abandoned Unix socket; never steal a live daemon's path. */
export const removeStaleAttachedToolSocket = async (
  socketPath: string,
): Promise<void> => {
  const disposition = await new Promise<"missing" | "stale" | "live">(
    (resolve, reject) => {
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve("live");
      });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy();
        if (error.code === "ENOENT") resolve("missing");
        else if (error.code === "ECONNREFUSED") resolve("stale");
        else reject(error);
      });
    },
  );
  if (disposition === "live") {
    throw new Error("Another attached tool daemon already owns this socket.");
  }
  if (disposition === "stale") await rm(socketPath);
};

export const parseAttachedToolHostInput = (
  value: unknown,
): AttachedToolHostInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Attached tool host input is not an object.");
  }
  const row = value as Record<string, unknown>;
  const broker = row.turnBroker as { credentialsPath?: unknown } | undefined;
  const world = row.world as
    | { origin?: unknown; name?: unknown; capability?: unknown; fork?: unknown }
    | undefined;
  if (
    !boundedText(row.turnId, 256) ||
    !Number.isSafeInteger(row.attemptGeneration) ||
    Number(row.attemptGeneration) < 1 ||
    !boundedText(row.threadId, 256) ||
    typeof row.prompt !== "string" ||
    typeof row.workspaceRestored !== "boolean" ||
    !broker ||
    typeof broker !== "object" ||
    !boundedText(broker.credentialsPath, 4096) ||
    !world ||
    !boundedText(world.origin, 2_048) ||
    typeof world.name !== "string" ||
    !/^[0-9a-f]{64}:[0-9a-f]{64}$/u.test(world.name) ||
    !boundedText(world.capability, 4_096) ||
    (world.fork !== undefined &&
      (typeof world.fork !== "string" ||
        !/^fork-[0-9a-f-]{36}$/u.test(world.fork)))
  ) {
    throw new Error("Attached tool host input is invalid.");
  }
  return {
    turnId: row.turnId,
    attemptGeneration: Number(row.attemptGeneration),
    threadId: row.threadId,
    prompt: row.prompt,
    workspaceRestored: row.workspaceRestored,
    turnBroker: row.turnBroker as TurnBrokerInput,
    world: {
      origin: world.origin,
      name: world.name,
      capability: world.capability,
      ...(typeof world.fork === "string" ? { fork: world.fork } : {}),
    },
  };
};

/** What the daemon knows about one `toolCallId` + fingerprint pair. */
export type CallState =
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "done"; result: SerializedAgentToolResult }>
  | Readonly<{ kind: "lost"; error: string }>;

const MODEL_VISIBLE_MAX_CHARS = 30_000;

const resultText = (result: ToolResult): string => {
  const raw =
    typeof result.result === "string"
      ? result.result
      : result.result === undefined
        ? ""
        : JSON.stringify(result.result, null, 2);
  return raw.length > MODEL_VISIBLE_MAX_CHARS
    ? `${raw.slice(0, 15_000)}\n…[truncated]…\n${raw.slice(-15_000)}`
    : raw;
};

const serializeImages = (
  result: ToolResult,
): readonly SerializedAuthorizedImage[] =>
  (result[TOOL_RESULT_AUTHORIZED_IMAGES] ?? [])
    .slice(0, ATTACHED_TOOL_MAX_IMAGES)
    .map((image) => ({
      data: Buffer.from(image.data).toString("base64"),
      mimeType: image.mimeType,
      sourcePath: image.sourcePath,
    }));

export const serializeToolResult = (
  result: ToolResult,
): SerializedAgentToolResult => ({
  outcome: result.error
    ? { kind: "error", message: result.error.slice(0, 8_000) }
    : { kind: "ok", text: resultText(result) },
  details: result.details ?? null,
  authorizedImages: serializeImages(result),
});

const appendSyncNotices = (
  result: SerializedAgentToolResult,
  notices: readonly string[],
): SerializedAgentToolResult => {
  if (notices.length === 0) return result;
  const notice = notices
    .map((message) => `World sync notice: ${message}`)
    .join("\n");
  return {
    ...result,
    outcome:
      result.outcome.kind === "ok"
        ? {
            kind: "ok",
            text: `${result.outcome.text}${result.outcome.text ? "\n\n" : ""}${notice}`,
          }
        : {
            kind: "error",
            message: `${result.outcome.message}\n\n${notice}`.slice(0, 8_000),
          },
  };
};

const readFrame = (socket: Socket, maxBytes: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered, "utf8") > maxBytes) {
        cleanup();
        reject(new AttachedToolProtocolError("frame"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      cleanup();
      try {
        resolve(decodeAttachedToolFrame(line, maxBytes));
      } catch (error) {
        reject(asError(error));
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new AttachedToolProtocolError("frame"));
    };
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });

const writeFrame = (socket: Socket, frame: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.write(`${encodeAttachedToolFrame(frame)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

export type AttachedToolHostReport = Readonly<{
  bootNotices: readonly string[];
  /** Drive paths whose delivery to the drive succeeded. */
  deliveredFiles: readonly string[];
}>;

export type AttachedToolDispatcher = Readonly<{
  answer(
    frame: unknown,
  ): Promise<AttachedToolResponse | AttachedToolControlResponse>;
}>;

/**
 * The daemon's decision layer, separated from its process and its socket.
 *
 * Everything that decides whether a frame runs a command, replays a receipt,
 * or refuses lives here, over a call table the caller owns. The transport
 * around it only moves bytes.
 */
export const createAttachedToolDispatcher = (args: {
  identity: Readonly<{ turnId: string; attemptGeneration: number }>;
  bootNotices: readonly string[];
  calls: Map<string, CallState>;
  execute: (
    key: string,
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<SerializedAgentToolResult>;
  quiesce: (linkedPaths: readonly string[]) => Promise<AttachedToolHostReport>;
}): AttachedToolDispatcher => {
  const belongsToTurn = (request: {
    turnId: string;
    attemptGeneration: number;
  }): boolean =>
    request.turnId === args.identity.turnId &&
    request.attemptGeneration === args.identity.attemptGeneration;

  const answerTool = async (frame: unknown): Promise<AttachedToolResponse> => {
    const request = parseAttachedToolRequest(frame);
    const envelope = {
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      toolCallId: request.toolCallId,
      fingerprint: request.fingerprint,
    } as const;
    if (!belongsToTurn(request) || !isAttachedToolName(request.toolName)) {
      return {
        ...envelope,
        status: "failed",
        error: "This request does not belong to the attached turn.",
      };
    }
    const key = `${request.toolCallId}:${request.fingerprint}`;
    const known = args.calls.get(key);
    if (known?.kind === "done") {
      return { ...envelope, status: "completed", result: known.result };
    }
    if (known?.kind === "running") return { ...envelope, status: "pending" };
    if (known?.kind === "lost") {
      return { ...envelope, status: "failed", error: known.error };
    }
    try {
      return {
        ...envelope,
        status: "completed",
        result: await args.execute(key, request.toolCallId, request.toolName, {
          ...request.params,
        }),
      };
    } catch (error) {
      return {
        ...envelope,
        status: "failed",
        error: asError(error).message.slice(0, 8_000),
      };
    }
  };

  const answerControl = async (
    frame: unknown,
  ): Promise<AttachedToolControlResponse> => {
    const request = parseAttachedToolControlRequest(frame);
    if (!belongsToTurn(request)) {
      return {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "failed",
        error: "This request does not belong to the attached turn.",
      };
    }
    if (request.control === "boot_report") {
      return {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "boot_report",
        notices: args.bootNotices,
      };
    }
    const report = await args.quiesce(request.linkedPaths);
    return {
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "quiesced",
      deliveredFiles: report.deliveredFiles,
    };
  };

  return {
    answer: async (frame) =>
      Boolean(frame) &&
      typeof frame === "object" &&
      "control" in (frame as Record<string, unknown>)
        ? await answerControl(frame)
        : await answerTool(frame),
  };
};

/**
 * Run the daemon until a `quiesce` control call joins it. The returned report
 * is what the last caller already received; it is repeated here so the process
 * can log a truthful exit line without a second round trip.
 */
export const runAttachedToolHost = (
  input: AttachedToolHostInput,
  paths: AttachedToolPaths,
): Effect.Effect<AttachedToolHostReport, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () =>
            new TurnCredentialBrokerClient(
              await takeTurnBrokerHandoff(input.turnBroker),
            ),
          catch: asError,
        }),
        (client) => Effect.sync(() => client.close()),
      );
      const postJson = async (
        route: string,
        body: unknown,
      ): Promise<Response> => await broker.postJson(route, body);

      const workspaceRoot = worldRootForFork(input.world.fork);
      const workspaceStateDir = toolStateDir(workspaceRoot);
      const driveWorkspace = worldDriveWorkspace(workspaceRoot);
      yield* Effect.tryPromise({
        try: () =>
          prepareCloudToolFilesystem({
            workspaceRoot,
            workspaceStateDir,
            driveStateDir: driveWorkspace.stateDir,
            toolHome: CLOUD_TOOL_HOME,
          }),
        catch: asError,
      });

      const driveSync = yield* Effect.tryPromise({
        try: () =>
          hydrateDriveForAgentTurn({
            turnId: input.turnId,
            prompt: input.prompt,
            workspaceRoot: driveWorkspace.root,
            workspaceRestored: input.workspaceRestored,
            stateDir: driveWorkspace.stateDir,
            owner: CLOUD_TOOL_PROCESS_IDENTITY,
            post: postJson,
          }),
        catch: asError,
      });

      const toolHost: ToolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: CLOUD_HOST_STATE,
            recoverStaleSecrets: false,
            enableShellShims: false,
          }),
        ),
        (host) =>
          Effect.tryPromise({
            try: () => host.shutdown(),
            catch: asError,
          }).pipe(Effect.orDie),
      );

      const context: ToolContext = cloudAgentToolContext({
        threadId: input.threadId,
        workspaceRoot,
        workspaceStateDir,
        toolHome: CLOUD_TOOL_HOME,
      });

      const calls = new Map<string, CallState>();
      const notice = driveHydrationNotice(driveSync, workspaceRoot);
      const bootNotices = notice ? [notice] : [];

      const execute = async (
        key: string,
        toolCallId: string,
        toolName: string,
        params: Record<string, unknown>,
      ): Promise<SerializedAgentToolResult> => {
        calls.set(key, { kind: "running" });
        const syncAtBoundary =
          toolName === "exec_command" || toolName === "write_stdin";
        const syncNotices: string[] = [];
        if (syncAtBoundary) {
          await pullWorldProjection({
            root: workspaceRoot,
            access: input.world,
          }).catch((error) => {
            const message = asError(error).message;
            console.error(`world pull failed: ${message}`);
            syncNotices.push(`pull failed: ${message}`);
          });
        }
        let result: ToolResult;
        try {
          result = await toolHost.executeTool(toolName, params, {
            ...context,
            requestId: toolCallId,
          });
        } catch (error) {
          if (syncAtBoundary) {
            await pushWorldProjection({
              root: workspaceRoot,
              access: input.world,
            }).catch((failure) =>
              console.error(`world push failed: ${asError(failure).message}`),
            );
          }
          // The command may already have run. Recording the loss keeps a
          // replay from re-running it behind the caller's back.
          calls.set(key, { kind: "lost", error: asError(error).message });
          throw asError(error);
        }
        if (syncAtBoundary) {
          await pushWorldProjection({
            root: workspaceRoot,
            access: input.world,
          }).catch((error) => {
            const message = asError(error).message;
            console.error(`world push failed: ${message}`);
            syncNotices.push(`push failed: ${message}`);
          });
        }
        const serialized = appendSyncNotices(
          serializeToolResult(result),
          syncNotices,
        );
        calls.set(key, { kind: "done", result: serialized });
        return serialized;
      };

      const quiesce = async (
        linkedPaths: readonly string[],
      ): Promise<AttachedToolHostReport> => {
        await toolHost.shutdown();
        await pushWorldProjection({ root: workspaceRoot, access: input.world });
        const collected = await collectProducedFiles({
          workspaceRoot: driveWorkspace.root,
          linked: linkedPaths,
          gitAware: false,
          drivePrefix: "",
          processIdentity: {
            ...CLOUD_TOOL_PROCESS_IDENTITY,
            home: CLOUD_TOOL_HOME,
          },
        }).catch(() => null);
        const files = collected?.files ?? [];
        if (files.length === 0) {
          return { bootNotices, deliveredFiles: [] };
        }
        const delivery = await reportProducedFiles({
          turnId: input.turnId,
          files,
          known: driveSync.known,
          uploads: driveSync.uploads,
          post: postJson,
        });
        const refused = new Set(delivery.skipped.map((entry) => entry.path));
        return {
          bootNotices,
          deliveredFiles: files
            .filter((file) => !refused.has(file.path))
            .slice(0, ATTACHED_TOOL_MAX_DELIVERED_FILES)
            .map((file) => file.path),
        };
      };

      const done = yield* Deferred.make<AttachedToolHostReport, Error>();

      const dispatcher = createAttachedToolDispatcher({
        identity: {
          turnId: input.turnId,
          attemptGeneration: input.attemptGeneration,
        },
        bootNotices,
        calls,
        execute,
        quiesce: async (linkedPaths) => {
          const report = await quiesce(linkedPaths);
          await Effect.runPromise(Deferred.succeed(done, report));
          return report;
        },
      });

      const serve = async (socket: Socket): Promise<void> => {
        let frame: unknown;
        try {
          frame = await readFrame(socket, ATTACHED_TOOL_REQUEST_MAX_BYTES);
        } catch (error) {
          console.error(`attached tool call failed: ${asError(error).message}`);
          socket.end();
          return;
        }
        try {
          await writeFrame(socket, await dispatcher.answer(frame));
        } catch (error) {
          const message = asError(error).message;
          console.error(`attached tool call failed: ${message}`);
          // A failed answer is still an answer. Closing the socket instead
          // left the client with a bare transport failure, so the worker
          // learned nothing about why a quiesce or tool call failed.
          await writeFrame(
            socket,
            attachedToolAnswerFailure(frame, message),
          ).catch(() => undefined);
        } finally {
          socket.end();
        }
      };

      const server: Server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(paths.directory, { mode: 0o700, recursive: true });
            await removeStaleAttachedToolSocket(paths.socket);
            const listener = createServer(
              { allowHalfOpen: false },
              (socket) => {
                void serve(socket);
              },
            );
            await new Promise<void>((resolve, reject) => {
              listener.once("error", reject);
              listener.listen(paths.socket, () => resolve());
            });
            return listener;
          },
          catch: asError,
        }),
        (listener) =>
          Effect.promise(async () => {
            await new Promise<void>((resolve) =>
              listener.close(() => resolve()),
            );
            await rm(paths.socket, { force: true });
          }),
      );
      server.on("error", (error) => {
        console.error(`attached tool socket failed: ${error.message}`);
      });

      return yield* Deferred.await(done);
    }),
  );

/**
 * A response frame the caller can act on when the socket is unreachable. The
 * client writes this rather than exiting silently, so a lost daemon surfaces
 * as a tool error the model can react to instead of a hung turn.
 */
export const attachedToolTransportFailure = (
  toolCallId: string,
  fingerprint: string,
  message: string,
): AttachedToolResponse => ({
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  status: "failed",
  toolCallId,
  fingerprint,
  error: message.slice(0, 8_000) || "The attached tool host is unreachable.",
});

/**
 * The frame the daemon answers with when producing the real answer threw.
 * Shaped by the request it failed to answer, so the client can parse it as
 * a failed control response or a failed tool response and carry the message
 * to the worker instead of reporting a closed socket.
 */
export const attachedToolAnswerFailure = (
  frame: unknown,
  message: string,
): AttachedToolControlResponse | AttachedToolResponse => {
  const row =
    frame && typeof frame === "object" && !Array.isArray(frame)
      ? (frame as Record<string, unknown>)
      : {};
  if ("control" in row) {
    return {
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "failed",
      error: message.slice(0, 8_000) || "The attached tool host failed.",
    };
  }
  return attachedToolTransportFailure(
    typeof row.toolCallId === "string" ? row.toolCallId : "",
    typeof row.fingerprint === "string" ? row.fingerprint : "",
    message,
  );
};

export const ATTACHED_TOOL_HOST_RESPONSE_MAX_BYTES =
  ATTACHED_TOOL_RESPONSE_MAX_BYTES;
