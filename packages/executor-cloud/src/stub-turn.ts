import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";

export type StubTurnResult = {
  ok: true;
  tool: "Read";
  marker: string;
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const runStubTurn = (
  workspaceRoot = "/workspace",
): Effect.Effect<StubTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const markerPath = path.join(workspaceRoot, ".stella-m0-runtime-marker");
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(workspaceRoot, { recursive: true });
          await writeFile(markerPath, "stella-runtime-headless-ok\n", "utf8");
        },
        catch: asError,
      });

      const toolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: path.join(workspaceRoot, ".stella"),
          }),
        ),
        (host) =>
          Effect.tryPromise({
            try: () => host.shutdown(),
            catch: asError,
          }).pipe(Effect.orDie),
      );

      const readResult = yield* Effect.tryPromise({
        try: () =>
          toolHost.executeTool(
            "Read",
            { file_path: markerPath },
            {
              conversationId: "m0-stub",
              deviceId: "cloud",
              requestId: crypto.randomUUID(),
              workingDirectory: workspaceRoot,
              toolWorkspaceRoot: workspaceRoot,
              storageMode: "cloud",
            },
          ),
        catch: asError,
      });

      const serialized = JSON.stringify(readResult);
      if (!serialized.includes("stella-runtime-headless-ok")) {
        return yield* Effect.fail(
          new Error("The runtime Read tool did not return the M0 marker."),
        );
      }

      return {
        ok: true as const,
        tool: "Read" as const,
        marker: "stella-runtime-headless-ok",
      };
    }),
  );
