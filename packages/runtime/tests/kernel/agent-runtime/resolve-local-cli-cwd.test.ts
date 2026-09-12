import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLocalCliCwd } from "@stella/runtime/kernel/agent-runtime/shared";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-local-cli-cwd-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveLocalCliCwd", () => {
  it("keeps a real app directory for the legacy frontend mode", () => {
    const appDirectory = makeTemporaryDirectory();

    expect(
      resolveLocalCliCwd({
        agentType: "orchestrator",
        stellaAppDir: appDirectory,
      }),
    ).toBe(appDirectory);
  });

  it("falls back to home when a packaged app exposes app.asar as a file", () => {
    const resourcesDirectory = makeTemporaryDirectory();
    const appAsar = path.join(resourcesDirectory, "app.asar");
    fs.writeFileSync(appAsar, "packaged app archive");

    expect(
      resolveLocalCliCwd({
        agentType: "orchestrator",
        stellaAppDir: appAsar,
      }),
    ).toBe(os.homedir());
  });
});
