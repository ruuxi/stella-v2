import { Effect } from "effect";
import { runStubTurn } from "./stub-turn.js";

if (!process.argv.includes("--stub")) {
  throw new Error("executor-cloud requires a supported command.");
}

const result = await Effect.runPromise(
  runStubTurn(process.env.STELLA_CLOUD_WORKSPACE_ROOT ?? "/workspace"),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
