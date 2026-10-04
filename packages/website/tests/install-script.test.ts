import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { INSTALL_SCRIPT } from "@/lib/install-script";
import { LAUNCHER_CHECKSUMS_URL, RELEASE_ASSETS } from "@/lib/downloads";

/**
 * The installer is shipped as text, so the only meaningful test is to actually
 * execute it under `/bin/sh` with the outside world stubbed: `uname` reports
 * the OS/arch we want to exercise, `curl` serves a placeholder launcher (a
 * script that records it was started) and a SHA256SUMS covering it, and
 * `open`/`ditto` record or fake the macOS steps. HOME is redirected into a
 * temp dir so the script writes its real files and we can assert on them.
 */

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function shim(dir: string, name: string, body: string) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

const ASSET_NAMES = [
  "Stella-macos.zip",
  "Stella.exe",
  "stella-launcher-linux-x64",
  "stella-launcher-linux-arm64",
];

type RunOptions = {
  unameS: string;
  unameM: string;
  home?: string;
  badChecksum?: boolean;
};

function runInstaller({ unameS, unameM, home, badChecksum = false }: RunOptions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-install-"));
  created.push(root);

  const binDir = path.join(root, "bin");
  const homeDir = home ?? path.join(root, "home");
  const log = path.join(root, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(log, "");

  // Every launcher download is this script; started, it records itself.
  const payload = path.join(root, "payload");
  writeFileSync(payload, `#!/bin/sh\necho "launched $0" >> "${log}"\n`);
  const hash = badChecksum
    ? "0".repeat(64)
    : createHash("sha256").update(readFileSync(payload)).digest("hex");
  const sums = path.join(root, "SHA256SUMS");
  writeFileSync(sums, ASSET_NAMES.map((name) => `${hash}  ${name}\n`).join(""));

  shim(
    binDir,
    "uname",
    `case "\${1:-}" in -s) echo ${unameS} ;; -m) echo ${unameM} ;; *) echo ${unameS} ;; esac`,
  );
  // `curl -fL --progress-bar <url> -o <dest>` and `curl -fsSL <url> -o <dest>`.
  shim(
    binDir,
    "curl",
    [
      `echo "curl $*" >> "${log}"`,
      'dest=""',
      'url=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -o) dest="$2"; shift 2 ;;',
      "    -*) shift ;;",
      '    *) url="$1"; shift ;;',
      "  esac",
      "done",
      'case "$url" in',
      `  *SHA256SUMS) cp "${sums}" "$dest" ;;`,
      `  *) cp "${payload}" "$dest" ;;`,
      "esac",
    ].join("\n"),
  );
  shim(binDir, "open", `echo "open $*" >> "${log}"`);
  // `ditto -x -k <zip> <dir>` unpacks a Stella.app; `ditto <src> <dst>` copies.
  shim(
    binDir,
    "ditto",
    [
      `echo "ditto $*" >> "${log}"`,
      'if [ "$1" = "-x" ]; then mkdir -p "$4/Stella.app/Contents"; else cp -R "$1" "$2"; fi',
    ].join("\n"),
  );

  const scriptPath = path.join(root, "install.sh");
  writeFileSync(scriptPath, INSTALL_SCRIPT);

  const result = spawnSync("/bin/sh", [scriptPath], {
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: homeDir,
      XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
      STELLA_APPS_DIR: path.join(homeDir, "Apps"),
    },
    encoding: "utf8",
  });

  return {
    homeDir,
    log,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    calls: () => readFileSync(log, "utf8"),
  };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

describe("install.sh", () => {
  test("Linux x64: installs the verified launcher where it installs itself and starts it", async () => {
    const run = runInstaller({ unameS: "Linux", unameM: "x86_64" });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls()).toContain(RELEASE_ASSETS.linux);
    expect(run.calls()).toContain(LAUNCHER_CHECKSUMS_URL);

    const launcher = path.join(
      run.homeDir,
      ".local/share/stella/bin/stella-launcher",
    );
    expect(spawnSync("test", ["-x", launcher]).status).toBe(0);
    expect(
      existsSync(
        path.join(run.homeDir, ".local/share/stella/bin/.stella-launcher.download"),
      ),
    ).toBe(false);
    expect(
      await waitFor(() => run.calls().includes(`launched ${launcher}`)),
    ).toBe(true);
  });

  test("Linux arm64: installs the arm64 launcher", () => {
    const run = runInstaller({ unameS: "Linux", unameM: "aarch64" });

    expect(run.status).toBe(0);
    expect(run.calls()).toContain(RELEASE_ASSETS["linux-arm64"]);
  });

  test("Linux: re-running replaces the launcher in place", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "stella-home-"));
    created.push(home);

    const first = runInstaller({ unameS: "Linux", unameM: "x86_64", home });
    const second = runInstaller({ unameS: "Linux", unameM: "x86_64", home });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
  });

  test("a checksum mismatch fails and leaves nothing installed", () => {
    const run = runInstaller({
      unameS: "Linux",
      unameM: "x86_64",
      badChecksum: true,
    });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("failed its checksum");
    expect(
      existsSync(path.join(run.homeDir, ".local/share/stella/bin/stella-launcher")),
    ).toBe(false);
    expect(
      existsSync(
        path.join(run.homeDir, ".local/share/stella/bin/.stella-launcher.download"),
      ),
    ).toBe(false);
  });

  test("Linux on an unpublished architecture fails with a clear error", () => {
    const run = runInstaller({ unameS: "Linux", unameM: "riscv64" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("x86_64 and arm64 only");
    expect(run.stderr).toContain("riscv64");
  });

  test("macOS installs the verified universal app and opens it", () => {
    const run = runInstaller({ unameS: "Darwin", unameM: "arm64" });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls()).toContain(RELEASE_ASSETS["mac-arm64"]);
    const app = path.join(run.homeDir, "Apps/Stella.app");
    expect(existsSync(app)).toBe(true);
    expect(run.calls()).toContain(`open ${app}`);
  });

  test("unsupported operating systems fail with a clear error", () => {
    const run = runInstaller({ unameS: "FreeBSD", unameM: "x86_64" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unsupported operating system");
  });
});
