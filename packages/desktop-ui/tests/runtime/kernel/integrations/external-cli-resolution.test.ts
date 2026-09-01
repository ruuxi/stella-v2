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
  });

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
    try {
      expect(resolveExternalCliPath("claude", { env })).toBe(overrideClaude);

      delete env.STELLA_CLAUDE_CLI_PATH;
      expect(resolveExternalCliPath("claude", { env })).toBe(
        genericOverrideClaude,
      );

      delete env.CLAUDE_CLI_PATH;
      expect(resolveExternalCliPath("claude", { env })).toBe(pathClaude);

      env.PATH = path.join(root, "empty-path");
      expect(resolveExternalCliPath("claude", { env })).toBe(bunClaude);
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

    expect(pathEntries).toEqual([
      path.dirname(executable),
      path.join(home, ".bun", "bin"),
      originalPath,
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
