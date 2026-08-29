/**
 * The resident general-agent turn's import graph, declared in one place so a
 * bundler can be pointed at it.
 *
 * Everything reachable from here has to load inside workerd, where there is no
 * `createToolHost`, no `node:child_process`, no `node:fs` and no
 * `worker_threads`. `general-agent-resident-bundle.test.ts` bundles this file
 * and fails on any of those. Adding a module to the resident path means adding
 * it here.
 */

export * as generalAgentTools from "../../src/general-agent-tools.js";
export * as agentComputeLadder from "../../src/agent-compute-ladder.js";
export * as attachedToolProtocol from "@stella/executor-cloud/attached-tool-protocol";
export * as generalAgentPrompt from "@stella/executor-cloud/general-agent-prompt";
export * as agentHistory from "@stella/executor-cloud/agent-history";
export * as pruneHistory from "@stella/executor-cloud/prune-history";
