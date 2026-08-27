import crypto from "node:crypto";
import path from "node:path";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { ensurePrivateDir, writePrivateFile } from "../../shared/private-fs.js";
import {
  createScheduleScriptAuthEnv,
  runScheduleScript,
  scheduleScriptsDir,
  SCRIPT_RUN_TIMEOUT_MS,
} from "../../shared/schedule-scripts.js";
import type { ToolDefinition } from "../types.js";

export type ScriptDraftToolOptions = {

  stellaDataDir: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
};

const formatResult = (params: {
  scriptPath: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}): string => {
  const lines = [
    `scriptPath: ${params.scriptPath}`,
    `exitCode: ${params.exitCode}`,
    `durationMs: ${params.durationMs}`,
  ];
  if (params.timedOut) {
    lines.push(`timedOut: true (${SCRIPT_RUN_TIMEOUT_MS}ms cap)`);
  }
  lines.push("");
  lines.push("stdout:");
  lines.push(params.stdout.length > 0 ? params.stdout : "(empty)");
  lines.push("");
  lines.push("stderr:");
  lines.push(params.stderr.length > 0 ? params.stderr : "(empty)");
  return lines.join("\n");
};

export const createScriptDraftTool = (
  options: ScriptDraftToolOptions,
): ToolDefinition => ({
  name: "ScriptDraft",
  agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL],
  demoted: {
    searchTerms: [
      "watch",
      "watcher",
      "sensor",
      "monitor",
      "schedule",
      "script",
      "check",
      "poll",
      "diff",
      "cron",
    ],
  },
  description:
    "Author a watch check script: writes Bun/TypeScript to the schedule-scripts directory and immediately dry-runs it, returning the assigned scriptPath plus exitCode, stdout, and stderr. Watch contract at fire time: empty stdout + exit 0 = no change (silent); non-empty stdout = detected change details; non-zero exit = sensor failure. Keep the script deterministic (fetch + extract + diff against `<scriptPath>.state.json`), store the new baseline in the sidecar, and iterate here until the dry-run is clean — then register the sensor with `schedule_add({ kind: 'watch', scriptPath })`.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "Full TypeScript source for the check script. Print change details to stdout only when something changed (that output escalates to the assistant at fire time); print nothing when unchanged; exit non-zero on sensor failure. Read/write the sidecar `<scriptPath>.state.json` (via env STELLA_SCHEDULE_SCRIPT_PATH) for the last-seen baseline. Wall-clock cap: 30s per run.",
      },
    },
    required: ["code"],
  },
  execute: async (args) => {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) {
      return { error: "code is required." };
    }

    const dir = scheduleScriptsDir(options.stellaDataDir);
    await ensurePrivateDir(dir);
    const scriptPath = path.join(dir, `${crypto.randomUUID()}.ts`);
    await writePrivateFile(scriptPath, code);

    const authEnv = createScheduleScriptAuthEnv(
      options.getStellaSiteAuth?.() ?? null,
    );
    const runResult = await runScheduleScript(
      scriptPath,
      authEnv ? { env: authEnv } : undefined,
    );
    return {
      result: formatResult({
        scriptPath,
        exitCode: runResult.exitCode,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        durationMs: runResult.durationMs,
        timedOut: runResult.timedOut,
      }),
    };
  },
});
