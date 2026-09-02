import { Effect } from "effect";
import "@stella/runtime/ai/utils/http-proxy.js";
import { registerBuiltInApiProviders } from "@stella/runtime/ai/providers/register-builtins.js";
import { forkAbortTimer } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { runStubTurn } from "./stub-turn.js";
import { runAppTurn } from "./app-turn.js";
import { runAgentTurn } from "./agent-turn.js";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "./agent-turn-result-file.js";
import { ATTACHED_TOOL_HOST_INPUT_PATH } from "./attached-tool-protocol.js";
import {
  parseAttachedToolHostInput,
  runAttachedToolHost,
} from "./attached-tool-host.js";
import {
  attachedToolClientPaths,
  runAttachedToolClient,
} from "./attached-tool-client.js";

registerBuiltInApiProviders();

// The daemon and the one-call client never produce a turn result, so they exit
// before the turn-result plumbing below.
if (process.argv.includes("--attached-tool-host")) {
  const raw = await readFile(ATTACHED_TOOL_HOST_INPUT_PATH, "utf8");
  await rm(ATTACHED_TOOL_HOST_INPUT_PATH, { force: true });
  const report = await Effect.runPromise(
    runAttachedToolHost(parseAttachedToolHostInput(JSON.parse(raw) as unknown)),
  );
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
