import { Effect } from "effect";
import { runStubTurn } from "./stub-turn.js";
import { runAppTurn } from "./app-turn.js";
import { runAgentTurn } from "./agent-turn.js";

const result = process.argv.includes("--stub")
  ? await Effect.runPromise(
      runStubTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace"),
    )
  : process.argv.includes("--app-turn")
    ? await Effect.runPromise(
        runAppTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace/app"),
      )
    : process.argv.includes("--agent-turn")
      ? await Effect.runPromise(
          runAgentTurn(
            process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace/drive",
          ),
        )
      : (() => {
          throw new Error("executor-cloud requires a supported command.");
        })();
// The result line IS the turn: the DO parses the last line of stdout and only
// then checkpoints and reports a terminal state. An agent that left a shell
// session (or anything else holding the event loop) alive would otherwise keep
// this one-shot process running until the turn watchdog fires minutes later,
// turning a finished turn into a timeout. The container is destroyed right
// after this, so there is nothing left to wind down gracefully.
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
