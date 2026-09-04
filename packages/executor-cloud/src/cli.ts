import { Effect } from "effect";
import { loadModelRegistry } from "@stella/contracts/model-registry";
import "@stella/runtime/ai/utils/http-proxy.js";
import { registerBuiltInApiProviders } from "@stella/runtime/ai/providers/register-builtins.js";
import { forkAbortTimer } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { runStubTurn } from "./stub-turn.js";
import { runAppTurn } from "./app-turn.js";
import { runAgentTurn } from "./agent-turn.js";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "./agent-turn-result-file.js";
import { attachedToolPathsForDirectory } from "./attached-tool-protocol.js";
import {
  parseAttachedToolHostInput,
  runAttachedToolHost,
  writeAttachedToolDaemonIdentity,
} from "./attached-tool-host.js";
import {
  attachedToolClientPaths,
  runAttachedToolClient,
} from "./attached-tool-client.js";

await loadModelRegistry();
registerBuiltInApiProviders();

// The daemon and the one-call client never produce a turn result, so they exit
// before the turn-result plumbing below.
if (process.argv.includes("--attached-tool-host")) {
  // A daemon that dies must say so on stderr: the worker reads it back when
  // the bridge stops answering, and a bare exit explains nothing.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      console.error(`attached tool host received ${signal}`);
      process.exit(1);
    });
  }
  process.on("uncaughtException", (error) => {
    console.error(
      `attached tool host crashed: ${String(error?.stack ?? error)}`,
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(
      `attached tool host rejected: ${String((error as { stack?: string })?.stack ?? error)}`,
    );
    process.exit(1);
  });
  const directoryFlag = process.argv.indexOf("--dir");
  const directory =
    directoryFlag >= 0 ? process.argv[directoryFlag + 1] : undefined;
  if (!directory) throw new Error("Attached tool host requires --dir.");
  const paths = attachedToolPathsForDirectory(directory);
  await writeAttachedToolDaemonIdentity(paths);
  const raw = await readFile(paths.hostInput, "utf8");
  await rm(paths.hostInput, { force: true });
  let report: unknown;
  try {
    report = await Effect.runPromise(
      runAttachedToolHost(
        parseAttachedToolHostInput(JSON.parse(raw) as unknown),
        paths,
      ),
    );
  } catch (error) {
    console.error(
      `attached tool host failed: ${String((error as { stack?: string })?.stack ?? error)}`,
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
}
if (process.argv.includes("--attached-tool-client")) {
  await Effect.runPromise(
    runAttachedToolClient(attachedToolClientPaths(process.argv)),
  );
  process.exit(0);
}

const agentTurn = process.argv.includes("--agent-turn");
const result = process.argv.includes("--stub")
  ? await Effect.runPromise(
      runStubTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace"),
    )
  : process.argv.includes("--app-turn")
    ? await Effect.runPromise(
        runAppTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace/app"),
      )
    : agentTurn
      ? await Effect.runPromise(runAgentTurn())
      : (() => {
          throw new Error("executor-cloud requires a supported command.");
        })();
const serialized = JSON.stringify(result);
if (agentTurn) {
  await writeFile(CLOUD_AGENT_TURN_RESULT_PATH, `${serialized}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
// Keep stdout for compatibility and diagnostics, but never let a lost pipe ACK
// hold the one-shot executor past Builder's durable-recovery alarm. Agent turns
// already flushed the authoritative root-only result above.
const cancelForcedExit = forkAbortTimer(1_000, () => process.exit(0));
process.stdout.write(`${serialized}\n`, () => {
  cancelForcedExit();
  process.exit(0);
});
