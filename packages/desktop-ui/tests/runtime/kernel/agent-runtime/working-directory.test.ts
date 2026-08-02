import os from "node:os";
import path from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgentWorkingDirectory } from "@stella/runtime/kernel/agent-runtime/shared";
import { buildRuntimeToolContext } from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import {
  resolveBundledAgentMetadataDir,
  resolveRuntimeStatePath,
  resolveStellaDataSeedDir,
} from "@stella/runtime/kernel/home/stella-paths";
import {
  createShellState,
  handleExecCommand,
} from "@stella/runtime/kernel/tools/shell";
import { resolveToolPath } from "@stella/runtime/kernel/tools/path-inference";
import { listSkillCatalogEntries } from "@stella/runtime/kernel/shared/skill-catalog";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();
const originalStellaAppDir = process.env.STELLA_APP_DIR;

afterEach(async () => {
  if (originalStellaAppDir === undefined) {
    delete process.env.STELLA_APP_DIR;
  } else {
    process.env.STELLA_APP_DIR = originalStellaAppDir;
  }
  vi.resetModules();
  await tempDirs.cleanup();
});

const runtimeToolContext = (args: {
  stellaAppDir: string;
  stellaDataDir: string;
  toolWorkspaceRoot?: string;
}) =>
  buildRuntimeToolContext({
    toolCallId: "tool-1",
    runId: "run-1",
    conversationId: "conversation-1",
    agentType: "orchestrator",
    deviceId: "device-1",
    ...args,
  });

describe("agent working directory", () => {
  it.each(["orchestrator", "manager", "general"])(
    "defaults %s to the absolute user home instead of the Stella install",
    (agentType) => {
      const stellaAppDir = path.join(os.homedir(), "stella");

      expect(resolveAgentWorkingDirectory({ agentType, stellaAppDir })).toBe(
        path.resolve(os.homedir()),
      );
    },
  );

  it("expands and respects an explicit per-task workspace override", () => {
    expect(
      resolveAgentWorkingDirectory({
        agentType: "orchestrator",
        stellaAppDir: "/Applications/Stella.app",
        workingDirectory: "~/projects/current",
      }),
    ).toBe(path.join(os.homedir(), "projects", "current"));
  });

  it("uses the resolved working directory for native shell and path tools", async () => {
    const stellaAppDir = await tempDirs.create("stella-install-");
    const stellaDataDir = await tempDirs.create("stella-data-");
    const projectDir = await tempDirs.create("stella-project-");
    const context = runtimeToolContext({
      stellaAppDir,
      stellaDataDir,
      toolWorkspaceRoot: projectDir,
    });
    const shellState = createShellState(stellaAppDir);

    const result = await handleExecCommand(
      shellState,
      { cmd: "pwd", yield_time_ms: 500 },
      context,
    );

    expect(context).toMatchObject({
      workingDirectory: projectDir,
      stellaAppDir,
      stellaDataDir,
      toolWorkspaceRoot: projectDir,
    });
    expect(result.result).toMatchObject({ cwd: projectDir });
    expect((result.result as { output: string }).output.trim()).toBe(
      await realpath(projectDir),
    );
    expect(resolveToolPath("notes/today.md", {}, context)).toBe(
      path.join(projectDir, "notes", "today.md"),
    );
  });

  it("keeps config, storage, skill, and extension roots independent of agent cwd", async () => {
    const stellaAppDir = await tempDirs.create("stella-install-paths-");
    const stellaDataDir = await tempDirs.create("stella-data-paths-");
    const homeSeed = path.join(stellaAppDir, "packages", "home-seed");
    const agentMetadata = path.join(
      homeSeed,
      "extensions",
      "stella-runtime",
      "agent-metadata",
    );
    const extensions = path.join(homeSeed, "extensions");
    await Promise.all([
      mkdir(path.join(homeSeed, "skills"), { recursive: true }),
      mkdir(agentMetadata, { recursive: true }),
      mkdir(path.join(stellaDataDir, "skills", "fixture-skill"), {
        recursive: true,
      }),
    ]);
    await writeFile(
      path.join(stellaDataDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: Fixture skill\ndescription: Test skill root\n---\n",
      "utf8",
    );

    const context = runtimeToolContext({ stellaAppDir, stellaDataDir });
    expect(context.workingDirectory).toBe(path.resolve(os.homedir()));
    expect(context.stellaAppDir).toBe(stellaAppDir);
    expect(context.stellaDataDir).toBe(stellaDataDir);
    expect(
      resolveRuntimeStatePath(undefined, stellaAppDir, stellaDataDir),
    ).toBe(stellaDataDir);
    expect(resolveStellaDataSeedDir(stellaAppDir)).toBe(homeSeed);
    expect(path.join(resolveStellaDataSeedDir(stellaAppDir), "skills")).toBe(
      path.join(stellaAppDir, "packages", "home-seed", "skills"),
    );
    expect(await listSkillCatalogEntries(stellaDataDir)).toEqual([
      expect.objectContaining({ id: "fixture-skill", name: "Fixture skill" }),
    ]);
    expect(resolveBundledAgentMetadataDir(stellaAppDir)).toBe(agentMetadata);
    expect(path.join(resolveStellaDataSeedDir(stellaAppDir), "extensions")).toBe(
      extensions,
    );
  });
});
