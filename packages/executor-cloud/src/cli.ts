import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { runStubTurn } from "./stub-turn.js";
import { runAppTurn } from "./app-turn.js";
import { runAgentTurn } from "./agent-turn.js";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "./agent-turn-result-file.js";

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
const forcedExit = setTimeout(() => process.exit(0), 1_000);
process.stdout.write(`${serialized}\n`, () => {
  clearTimeout(forcedExit);
  process.exit(0);
});
