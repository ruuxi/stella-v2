import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  automationSocketFileName,
  automationSocketsRootDir,
  maxAutomationSocketPathBytes,
  resolveAutomationSocketPath,
} from "@stella/runtime/kernel/computer-use/automation-socket-paths";

const devStateDir = (homeDir: string) =>
  path.join(
    homeDir,
    "Library",
    "Application Support",
    "Stella Development",
    "stella-computer",
  );

const packagedStateDir = (homeDir: string) =>
  path.join(
    homeDir,
    "Library",
    "Application Support",
    "Stella",
    "stella-computer",
  );

describe("automation socket paths", () => {
  it("stays inside the 104-byte macOS socket cap even with a long STELLA_DATA_DIR", () => {
    const homeDir = "/Users/rahulnanda";
    const socketPath = resolveAutomationSocketPath(
      devStateDir(homeDir),
      "manual",
      { homeDir },
    );

    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);

    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(
      maxAutomationSocketPathBytes,
    );

    expect(
      socketPath.startsWith(
        path.join(homeDir, ".stella", "computer-sockets") + path.sep,
      ),
    ).toBe(true);
    expect(socketPath).not.toContain("Application Support");
    expect(path.basename(socketPath)).toMatch(/^[0-9a-f]{16}\.sock$/);
  });

  it("stays short for this machine's real home directory", () => {
    const socketPath = resolveAutomationSocketPath(
      devStateDir(os.homedir()),
      "manual",
    );
    expect(socketPath.startsWith(automationSocketsRootDir() + path.sep)).toBe(
      true,
    );
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);
  });

  it("keeps installs isolated: same session id in different state dirs yields different sockets", () => {
    const homeDir = "/Users/rahulnanda";
    const dev = resolveAutomationSocketPath(devStateDir(homeDir), "manual", {
      homeDir,
    });
    const packaged = resolveAutomationSocketPath(
      packagedStateDir(homeDir),
      "manual",
      { homeDir },
    );

    expect(path.dirname(dev)).toBe(path.dirname(packaged));

    expect(dev).not.toBe(packaged);
  });

  it("keeps sessions isolated within one install", () => {
    const stateDir = devStateDir("/Users/rahulnanda");
    expect(automationSocketFileName(stateDir, "manual")).not.toBe(
      automationSocketFileName(stateDir, "other-session"),
    );
  });

  it("is deterministic so daemon spawner and client resolve the same socket", () => {
    const stateDir = packagedStateDir("/Users/rahulnanda");
    expect(automationSocketFileName(stateDir, "manual")).toBe(
      automationSocketFileName(stateDir, "manual"),
    );
  });
});
