import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDevHarnessOptions,
  resolveDevHarnessOptions,
  STELLA_DEV_HARNESS_APP_NAME_PREFIX,
} from "@stella/desktop/electron/bootstrap/dev-harness-options.js";

let sandbox = "";
let homeDir = "";
let workspaceDir = "";
let profileDir = "";

const enabledEnv = (overrides: Record<string, string | undefined> = {}) => ({
  STELLA_DEV_HARNESS: "1",
  STELLA_V2_DEV_USER_DATA_DIR: profileDir,
  STELLA_REMOTE_DEBUG_PORT: "9333",
  ...overrides,
});

beforeEach(async () => {
  sandbox = await mkdtemp(
    path.join(os.tmpdir(), "stella-dev-harness-options-"),
  );
  homeDir = path.join(sandbox, "home");
  workspaceDir = path.join(sandbox, "workspace", "repo");
  profileDir = path.join(sandbox, "profiles", "acceptance-one");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(path.join(homeDir, ".stella"), { recursive: true }),
    mkdir(profileDir, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const resolve = (args: {
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
}) =>
  resolveDevHarnessOptions({
    isPackaged: args.isPackaged ?? false,
    workspaceDir,
    homeDir,
    tempDir: os.tmpdir(),
    env: args.env ?? enabledEnv(),
  });

describe("resolveDevHarnessOptions", () => {
  it("returns an isolated profile and loopback-only decimal debugging port", async () => {
    expect(resolve({})).toEqual({
      appName: expect.stringMatching(
        new RegExp(`^${STELLA_DEV_HARNESS_APP_NAME_PREFIX} [a-f0-9]{12}$`),
      ),
      userDataDir: await realpath(profileDir),
      remoteDebuggingAddress: "127.0.0.1",
      remoteDebuggingPort: "9333",
    });
  });

  it("derives a stable, distinct safeStorage app name from each canonical profile", async () => {
    const first = resolve({});
    const secondProfile = path.join(sandbox, "profiles", "acceptance-two");
    await mkdir(secondProfile, { recursive: true });
    const second = resolve({
      env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: secondProfile }),
    });

    expect(resolve({})?.appName).toBe(first?.appName);
    expect(second?.appName).not.toBe(first?.appName);
    expect(first?.appName).not.toBe("Stella v2 Development");
  });

  it("is active only for unpackaged STELLA_DEV_HARNESS=1", () => {
    expect(
      resolve({ env: enabledEnv({ STELLA_DEV_HARNESS: "true" }) }),
    ).toBeNull();
    expect(
      resolve({ env: enabledEnv({ STELLA_DEV_HARNESS: undefined }) }),
    ).toBeNull();
  });

  it("ignores malformed harness values in packaged builds", () => {
    expect(
      resolve({
        isPackaged: true,
        env: enabledEnv({
          STELLA_V2_DEV_USER_DATA_DIR: "relative-live-profile",
          STELLA_REMOTE_DEBUG_PORT: "not-a-port",
        }),
      }),
    ).toBeNull();
  });

  it("requires an absolute existing directory", async () => {
    expect(() =>
      resolve({
        env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: "relative" }),
      }),
    ).toThrow("must be absolute");
    expect(() =>
      resolve({
        env: enabledEnv({
          STELLA_V2_DEV_USER_DATA_DIR: path.join(sandbox, "missing"),
        }),
      }),
    ).toThrow("existing directory");

    const file = path.join(sandbox, "not-a-directory");
    await writeFile(file, "not a profile");
    expect(() =>
      resolve({
        env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: file }),
      }),
    ).toThrow("existing directory");
  });

  it.each([
    ["filesystem root", () => path.parse(profileDir).root],
    ["home", () => homeDir],
    ["workspace", () => workspaceDir],
    ["workspace ancestor", () => path.dirname(workspaceDir)],
    ["live Stella", () => path.join(homeDir, ".stella")],
    ["temp root", () => os.tmpdir()],
  ])("rejects the broad or protected %s path", (_label, candidate) => {
    const value = typeof candidate === "function" ? candidate() : candidate;
    expect(() =>
      resolve({
        env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: value }),
      }),
    ).toThrow("must be a narrow directory");
  });

  it("rejects descendants of home, the workspace, and live Stella", async () => {
    const homeChild = path.join(homeDir, "harness-profile");
    const workspaceChild = path.join(workspaceDir, "profile");
    const liveChild = path.join(homeDir, ".stella", "electron-user-data");
    await Promise.all([
      mkdir(homeChild, { recursive: true }),
      mkdir(workspaceChild, { recursive: true }),
      mkdir(liveChild, { recursive: true }),
    ]);

    for (const candidate of [homeChild, workspaceChild, liveChild]) {
      expect(() =>
        resolve({
          env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: candidate }),
        }),
      ).toThrow("must be a narrow directory");
    }
  });

  it("resolves aliases before applying protected-path checks", async () => {
    const alias = path.join(sandbox, "profiles", "live-alias");
    await symlink(path.join(homeDir, ".stella"), alias, "dir");

    expect(() =>
      resolve({
        env: enabledEnv({ STELLA_V2_DEV_USER_DATA_DIR: alias }),
      }),
    ).toThrow("must be a narrow directory");
  });

  it.each(["", "1023", "65536", "1.5", "0x2455", "+9333", "09"])(
    "rejects invalid remote debugging port %j",
    (port) => {
      expect(() =>
        resolve({ env: enabledEnv({ STELLA_REMOTE_DEBUG_PORT: port }) }),
      ).toThrow("must be 0 or an integer from 1024 through 65535");
    },
  );

  it.each(["0", "1024", "65535"])("accepts boundary port %s", (port) => {
    expect(
      resolve({ env: enabledEnv({ STELLA_REMOTE_DEBUG_PORT: port }) })
        ?.remoteDebuggingPort,
    ).toBe(port);
  });
});

describe("applyDevHarnessOptions", () => {
  it("applies only the validated userData path and exact loopback switches", async () => {
    const calls: Array<[string, string, string]> = [];
    const options = resolve({});
    expect(options).not.toBeNull();

    applyDevHarnessOptions(
      {
        setName: (value) => calls.push(["setName", "appName", value]),
        setPath: (name, value) => calls.push(["setPath", name, value]),
        commandLine: {
          appendSwitch: (name, value) =>
            calls.push(["appendSwitch", name, value]),
        },
      },
      options!,
    );

    expect(calls).toEqual([
      ["setName", "appName", options!.appName],
      ["setPath", "userData", await realpath(profileDir)],
      ["appendSwitch", "remote-debugging-address", "127.0.0.1"],
      ["appendSwitch", "remote-debugging-port", "9333"],
    ]);
  });
});
