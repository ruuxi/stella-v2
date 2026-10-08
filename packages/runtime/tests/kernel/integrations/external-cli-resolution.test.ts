import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "@stella/runtime/kernel/integrations/claude-code-session-runtime";
import {
  buildExternalCliChildEnv,
  resetExternalCliResolutionCache,
  resolveExternalCliPath,
} from "@stella/runtime/kernel/integrations/external-cli-resolution";

const writeExecutable = (filePath: string, source = "#!/bin/sh\nexit 0\n") => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
};

const trackedEnvNames = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "STELLA_CLAUDE_CLI_PATH",
  "CLAUDE_CLI_PATH",
  "STELLA_FAKE_CLAUDE_LOG",
  "STELLA_FAKE_AUTH_MARKER",
  "STELLA_CLI_BRIDGE_SOCK",
  "STELLA_SITE_AUTH_TOKEN",
  "STELLA_LLM_PROXY_TOKEN",
  "STELLA_CLI_BRIDGE_SOCK",
] as const;

const originalEnv = Object.fromEntries(
  trackedEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof trackedEnvNames)[number], string | undefined>;

const restoreTrackedEnv = () => {
  for (const name of trackedEnvNames) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

describe("external CLI resolution", () => {
  afterEach(() => {
    shutdownClaudeCodeRuntime();
    restoreTrackedEnv();
    resetExternalCliResolutionCache();
  });

  /** Version probe keyed by executable path; never spawns anything. */
  const fakeProbe = (versions: Record<string, string | null>) => {
    const calls: string[] = [];
    const probeVersion = (executablePath: string): string | null => {
      calls.push(executablePath);
      return versions[fs.realpathSync(executablePath)] ?? null;
    };
    return { probeVersion, calls };
  };

  it("uses override, PATH, and well-known locations in order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-order-"));
    const home = path.join(root, "home");
    const overrideClaude = path.join(root, "override", "claude");
    const genericOverrideClaude = path.join(root, "generic-override", "claude");
    const pathClaude = path.join(root, "path-bin", "claude");
    const bunClaude = path.join(home, ".bun", "bin", "claude");
    for (const executable of [
      overrideClaude,
      genericOverrideClaude,
      pathClaude,
      bunClaude,
    ]) {
      writeExecutable(executable);
    }

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.dirname(pathClaude),
      STELLA_CLAUDE_CLI_PATH: overrideClaude,
      CLAUDE_CLI_PATH: genericOverrideClaude,
    };
    // Equal versions: discovery order alone decides.
    const { probeVersion } = fakeProbe({
      [fs.realpathSync(pathClaude)]: "2.1.293",
      [fs.realpathSync(bunClaude)]: "2.1.293",
    });
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        overrideClaude,
      );

      delete env.STELLA_CLAUDE_CLI_PATH;
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        genericOverrideClaude,
      );

      delete env.CLAUDE_CLI_PATH;
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        pathClaude,
      );

      env.PATH = path.join(root, "empty-path");
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        bunClaude,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the newest installed copy over PATH order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-newest-"));
    const home = path.join(root, "home");
    const bunClaude = path.join(home, ".bun", "bin", "claude");
    const localClaude = path.join(home, ".local", "bin", "claude");
    writeExecutable(bunClaude);
    writeExecutable(localClaude);
    const { probeVersion } = fakeProbe({
      [fs.realpathSync(bunClaude)]: "2.1.231 (Claude Code)",
      [fs.realpathSync(localClaude)]: "2.1.293 (Claude Code)",
    });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      // The stale bun copy is first on PATH; the newer one is only in the
      // well-known installer directory.
      PATH: path.dirname(bunClaude),
    };
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        localClaude,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets an explicit override win even when it is older", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-override-"));
    const home = path.join(root, "home");
    const overrideClaude = path.join(root, "pinned", "claude");
    const localClaude = path.join(home, ".local", "bin", "claude");
    writeExecutable(overrideClaude);
    writeExecutable(localClaude);
    const { probeVersion, calls } = fakeProbe({
      [fs.realpathSync(overrideClaude)]: "1.0.0",
      [fs.realpathSync(localClaude)]: "2.1.293",
    });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.dirname(localClaude),
      STELLA_CLAUDE_CLI_PATH: overrideClaude,
    };
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        overrideClaude,
      );
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ranks a package-manager copy whose version is unknown below a versioned one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-unknown-"));
    const home = path.join(root, "home");
    const brokenClaude = path.join(home, ".bun", "bin", "claude");
    const localClaude = path.join(home, ".local", "bin", "claude");
    writeExecutable(brokenClaude);
    writeExecutable(localClaude);
    const { probeVersion } = fakeProbe({
      [fs.realpathSync(brokenClaude)]: null,
      [fs.realpathSync(localClaude)]: "2.0.0",
    });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.dirname(brokenClaude),
    };
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        localClaude,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors a PATH copy outside the known install directories without probing", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-cli-deliberate-"),
    );
    const home = path.join(root, "home");
    const wrapperClaude = path.join(root, "wrappers", "claude");
    const localClaude = path.join(home, ".local", "bin", "claude");
    writeExecutable(wrapperClaude);
    writeExecutable(localClaude);
    const { probeVersion, calls } = fakeProbe({
      [fs.realpathSync(wrapperClaude)]: null,
      [fs.realpathSync(localClaude)]: "9.9.9",
    });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.dirname(wrapperClaude),
    };
    try {
      // A wrapper, pinned build, or test double the user put on PATH is a
      // deliberate choice; a newer copy elsewhere must not override it.
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        wrapperClaude,
      );
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not re-probe an unchanged executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-cache-"));
    const home = path.join(root, "home");
    const bunClaude = path.join(home, ".bun", "bin", "claude");
    const localClaude = path.join(home, ".local", "bin", "claude");
    writeExecutable(bunClaude);
    writeExecutable(localClaude);
    const { probeVersion, calls } = fakeProbe({
      [fs.realpathSync(bunClaude)]: "2.1.231",
      [fs.realpathSync(localClaude)]: "2.1.293",
    });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.join(root, "none"),
    };
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        localClaude,
      );
      expect(calls).toHaveLength(2);
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        localClaude,
      );
      expect(calls).toHaveLength(2);

      // An upgrade rewrites the file; the next resolution probes it again.
      writeExecutable(bunClaude, "#!/bin/sh\n# upgraded\nexit 0\n");
      resolveExternalCliPath("claude", { env, probeVersion });
      expect(calls).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips version probing when only one copy is installed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-single-"));
    const home = path.join(root, "home");
    const bunClaude = path.join(home, ".bun", "bin", "claude");
    writeExecutable(bunClaude);
    const { probeVersion, calls } = fakeProbe({});
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.join(root, "none"),
    };
    try {
      expect(resolveExternalCliPath("claude", { env, probeVersion })).toBe(
        bunClaude,
      );
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("augments child PATH without dropping the existing environment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-env-"));
    const home = path.join(root, "home");
    const executable = path.join(root, "override", "claude");
    const originalPath = path.join(root, "gui-path");
    const env = buildExternalCliChildEnv(executable, {
      HOME: home,
      PATH: originalPath,
      ANTHROPIC_API_KEY: "preserved-auth",
      STELLA_CLI_BRIDGE_SOCK: "/tmp/stella-owner-only.sock",
    });
    const pathEntries = env.PATH?.split(path.delimiter);

    // ~/.bun/bin is appended after the user's own PATH, never ahead of it.
    expect(pathEntries).toEqual([
      path.dirname(executable),
      originalPath,
      path.join(home, ".bun", "bin"),
    ]);
    expect(env.ANTHROPIC_API_KEY).toBe("preserved-auth");
    expect(env.STELLA_CLI_BRIDGE_SOCK).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("injects the bridge only when an approved launch explicitly supplies it", () => {
    const executable = "/opt/stella/bin/claude";
    const inherited = {
      PATH: "/usr/bin",
      STELLA_CLI_BRIDGE_SOCK: "/tmp/leaked.sock",
      STELLA_SITE_AUTH_TOKEN: "raw-secret",
      STELLA_LLM_PROXY_TOKEN: "proxy-secret",
    };
    const irrelevant = buildExternalCliChildEnv(executable, inherited);
    expect(irrelevant.STELLA_CLI_BRIDGE_SOCK).toBeUndefined();
    expect(irrelevant.STELLA_SITE_AUTH_TOKEN).toBeUndefined();
    expect(irrelevant.STELLA_LLM_PROXY_TOKEN).toBeUndefined();
    const approved = buildExternalCliChildEnv(executable, inherited, {
      cliBridgeSocketPath: "/private/session/bridge.sock",
    });
    expect(approved.STELLA_CLI_BRIDGE_SOCK).toBe(
      "/private/session/bridge.sock",
    );
    expect(approved.STELLA_SITE_AUTH_TOKEN).toBeUndefined();
    expect(approved.STELLA_LLM_PROXY_TOKEN).toBeUndefined();
  });

  it("returns actionable errors when an external CLI is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cli-missing-"));
    const env = {
      HOME: path.join(root, "home"),
      PATH: path.join(root, "path"),
    };
    const emptyCandidates = [path.join(root, "well-known")];
    try {
      expect(() =>
        resolveExternalCliPath("claude", {
          env,
          wellKnownDirectories: emptyCandidates,
        }),
      ).toThrow(/STELLA_CLAUDE_CLI_PATH.*CLAUDE_CLI_PATH/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts Claude Code from ~/.bun/bin when GUI PATH omits it", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-gui-path-"),
    );
    const home = path.join(root, "home");
    const guiPath = path.join(root, "gui-bin");
    const bunBin = path.join(home, ".bun", "bin");
    const logPath = path.join(root, "claude-env.json");
    fs.mkdirSync(guiPath, { recursive: true });
    writeExecutable(
      path.join(bunBin, "claude"),
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk.toString('utf8');",
        "  if (!buffer.includes('\\n')) return;",
        "  fs.writeFileSync(process.env.STELLA_FAKE_CLAUDE_LOG, JSON.stringify({ path: process.env.PATH, auth: process.env.STELLA_FAKE_AUTH_MARKER, bridge: process.env.STELLA_CLI_BRIDGE_SOCK, rawToken: process.env.STELLA_SITE_AUTH_TOKEN, proxyToken: process.env.STELLA_LLM_PROXY_TOKEN }));",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'gui-session',",
        "    is_error: false,",
        "    result: 'claude started',",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "  }) + '\\n');",
        "  buffer = '';",
        "});",
      ].join("\n"),
    );

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = guiPath;
    delete process.env.STELLA_CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    process.env.STELLA_FAKE_CLAUDE_LOG = logPath;
    process.env.STELLA_FAKE_AUTH_MARKER = "preserved";
    process.env.STELLA_SITE_AUTH_TOKEN = "must-not-cross";
    process.env.STELLA_LLM_PROXY_TOKEN = "must-not-cross-either";
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-claude-gui-path",
        sessionKey: "session-claude-gui-path",
        prompt: "hello",
        modelId: "claude-code/default",
        cliBridgeSocketPath: "/private/claude-bridge.sock",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });
      const childEnv = JSON.parse(fs.readFileSync(logPath, "utf8")) as {
        path: string;
        auth: string;
        bridge: string;
        rawToken?: string;
        proxyToken?: string;
      };

      expect(result.text).toBe("claude started");
      expect(childEnv.path.split(path.delimiter)).toEqual([bunBin, guiPath]);
      expect(childEnv.auth).toBe("preserved");
      expect(childEnv.bridge).toBe("/private/claude-bridge.sock");
      expect(childEnv.rawToken).toBeUndefined();
      expect(childEnv.proxyToken).toBeUndefined();
    } finally {
      shutdownClaudeCodeRuntime();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
