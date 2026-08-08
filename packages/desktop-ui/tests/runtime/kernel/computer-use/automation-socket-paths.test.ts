import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  automationSocketFileName,
  automationSocketsRootDir,
  maxAutomationSocketPathBytes,
  resolveAutomationSocketPath,
} from "@stella/runtime/kernel/computer-use/automation-socket-paths";

// The desktop app points STELLA_DATA_DIR at Electron userData, so the
// executor's state dir looks like this in dev. The old layout appended
// "/daemon-sockets/<hash>.sock" to it, which blew past the macOS 104-byte
// sockaddr_un cap (~117 chars); the daemon then refused to start with
// "Daemon socket path is too long".
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

    // 103 usable chars: 104 bytes including the trailing NUL.
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(103);
    // The executor guards at a stricter internal ceiling.
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(
      maxAutomationSocketPathBytes,
    );
    // Anchored at the short home-relative dir, not the data dir.
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

    // Both live in the one shared directory...
    expect(path.dirname(dev)).toBe(path.dirname(packaged));
    // ...but never collide on a socket file.
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
