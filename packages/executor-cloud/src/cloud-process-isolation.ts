import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";

export const CLOUD_TOOL_PROCESS_IDENTITY = {
  uid: 42_424,
  gid: 42_424,
  user: "stella-tools",
  requireNoNewPrivileges: true,
} as const;

export const CLOUD_TOOL_HOME = "/workspace/.stella-tool-home";
export const CLOUD_HOST_STATE = "/home/stella-host-state";

const modeBits = (mode: number): number => mode & 0o7777;

const assertRealDirectory = async (args: {
  target: string;
  uid: number;
  gid: number;
  mode: number;
  label: string;
}): Promise<void> => {
  const resolvedTarget = path.resolve(args.target);
  const details = await lstat(resolvedTarget).catch(() => null);
  if (!details?.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${args.label} must be a real directory.`);
  }
  const canonical = await realpath(resolvedTarget).catch(() => "");
  if (canonical !== resolvedTarget) {
    throw new Error(`${args.label} must not traverse a symbolic-link path.`);
  }
  if (details.uid !== args.uid || details.gid !== args.gid) {
    throw new Error(`${args.label} has an invalid owner.`);
  }
  if (modeBits(details.mode) !== args.mode) {
    throw new Error(`${args.label} has an invalid mode.`);
  }
};

const inside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/**
 * Validate the image anchors after Cloudflare mounts/restores have happened.
 * Mounts can replace Dockerfile ownership and modes, so image-build checks are
 * insufficient: a turn refuses to run before any project/setup/model process.
 */
export const assertCloudMountedDirectoryBoundary = async (args: {
  workspaceRoot: string;
  workspaceAnchor?: string;
  nativeStateAnchor?: string;
  hostStateAnchor?: string;
}): Promise<void> => {
  const workspaceAnchor = path.resolve(args.workspaceAnchor ?? "/workspace");
  const nativeStateAnchor = path.resolve(
    args.nativeStateAnchor ?? "/home/stella-native-state",
  );
  const hostStateAnchor = path.resolve(
    args.hostStateAnchor ?? CLOUD_HOST_STATE,
  );
  await assertRealDirectory({
    target: workspaceAnchor,
    uid: 0,
    gid: CLOUD_TOOL_PROCESS_IDENTITY.gid,
    mode: 0o750,
    label: "Cloud workspace anchor",
  });
  await assertRealDirectory({
    target: hostStateAnchor,
    uid: 0,
    gid: 0,
    mode: 0o700,
    label: "Cloud host state anchor",
  });
  await assertRealDirectory({
    target: nativeStateAnchor,
    uid: 0,
    gid: 0,
    mode: 0o700,
    label: "Native state anchor",
  });

  const workspaceRoot = path.resolve(args.workspaceRoot);
  const details = await lstat(workspaceRoot).catch(() => null);
  if (!details?.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Cloud workspace root must be a real directory.");
  }
  const canonical = await realpath(workspaceRoot).catch(() => "");
  if (canonical !== workspaceRoot || !inside(canonical, workspaceAnchor)) {
    throw new Error(
      "Cloud workspace root must be canonical and contained by /workspace.",
    );
  }
  if (
    details.uid !== CLOUD_TOOL_PROCESS_IDENTITY.uid ||
    details.gid !== CLOUD_TOOL_PROCESS_IDENTITY.gid ||
    modeBits(details.mode) !== 0o750
  ) {
    throw new Error("Cloud workspace root has an invalid owner or mode.");
  }
};

export const assertToolOwnedDirectory = async (
  target: string,
  mode = 0o700,
): Promise<void> =>
  assertRealDirectory({
    target,
    uid: CLOUD_TOOL_PROCESS_IDENTITY.uid,
    gid: CLOUD_TOOL_PROCESS_IDENTITY.gid,
    mode,
    label: "Cloud tool directory",
  });

export const assertSetprivBinaryBoundary = async (): Promise<void> => {
  const details = await lstat("/usr/bin/setpriv").catch(() => null);
  const canonical = await realpath("/usr/bin/setpriv").catch(() => "");
  if (
    !details?.isFile() ||
    details.isSymbolicLink() ||
    details.nlink !== 1 ||
    details.uid !== 0 ||
    details.gid !== 0 ||
    (modeBits(details.mode) & 0o022) !== 0 ||
    canonical !== "/usr/bin/setpriv"
  ) {
    throw new Error("Cloud privilege trampoline is not a trusted root binary.");
  }
};

const statusValue = (status: string, key: string): string => {
  const line = status
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  if (!line) throw new Error(`Cloud privilege probe omitted ${key}.`);
  return line.slice(line.indexOf(":") + 1).trim();
};

export const assertStrictLinuxProcessStatus = (
  status: string,
  identity: Pick<ToolProcessIdentity, "uid" | "gid"> =
    CLOUD_TOOL_PROCESS_IDENTITY,
): void => {
  const expectedUid = String(identity.uid);
  const expectedGid = String(identity.gid);
  if (
    statusValue(status, "Uid").split(/\s+/u).some((value) => value !== expectedUid)
  ) {
    throw new Error("Cloud child retained an unexpected user identity.");
  }
  if (
    statusValue(status, "Gid").split(/\s+/u).some((value) => value !== expectedGid)
  ) {
    throw new Error("Cloud child retained an unexpected group identity.");
  }
  if (statusValue(status, "Groups") !== "") {
    throw new Error("Cloud child retained supplementary groups.");
  }
  for (const key of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    if (!/^0+$/u.test(statusValue(status, key))) {
      throw new Error(`Cloud child retained ${key} capabilities.`);
    }
  }
  if (statusValue(status, "NoNewPrivs") !== "1") {
    throw new Error("Cloud child did not enter no_new_privs mode.");
  }
};

export const assertCurrentCloudProcessIsolation = async (): Promise<void> => {
  if (process.platform !== "linux") {
    throw new Error("Cloud model entrypoints require a Linux isolation host.");
  }
  const status = await readFile("/proc/self/status", "utf8");
  assertStrictLinuxProcessStatus(status);
};

/** Prove the exact trampoline contract before any untrusted child can start. */
export const proveStrictCloudProcessIsolation = async (): Promise<void> => {
  await assertSetprivBinaryBoundary();
  const identity: ToolProcessIdentity = {
    ...CLOUD_TOOL_PROCESS_IDENTITY,
    home: "/workspace",
  };
  const launch = isolateToolProcessLaunch({
    command: "/bin/cat",
    commandArgs: ["/proc/self/status"],
    identity,
  });
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(
      `Cloud privilege probe failed (${result.code ?? "unknown"}): ${result.stderr.trim()}`,
    );
  }
  assertStrictLinuxProcessStatus(result.stdout);
};
