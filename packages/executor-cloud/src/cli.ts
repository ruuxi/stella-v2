import { Effect } from "effect";
import { runStubTurn } from "./stub-turn.js";
import { runAppTurn } from "./app-turn.js";

const result = process.argv.includes("--stub")
  ? await Effect.runPromise(
      runStubTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace"),
    )
  : process.argv.includes("--app-turn")
    ? await Effect.runPromise(
        runAppTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace/app"),
      )
    : (() => {
        throw new Error("executor-cloud requires a supported command.");
      })();
process.stdout.write(`${JSON.stringify(result)}\n`);
