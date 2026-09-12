import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { RELEASE_ASSETS } from "@/lib/downloads";

/**
 * The installer is shipped as text, so the only meaningful test is to actually
 * execute it under `/bin/sh` with the outside world stubbed: `uname` reports
 * the OS/arch we want to exercise, `curl` writes a placeholder file instead of
 * downloading, and `pacman`/`sudo`/`update-desktop-database` record their
 * arguments. HOME is redirected into a temp dir so the AppImage branch writes
 * its real files and we can assert on them.
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

type RunOptions = {
  unameS: string;
  unameM: string;
  withPacman?: boolean;
  home?: string;
};

function runInstaller({
  unameS,
  unameM,
  withPacman = false,
  home,
}: RunOptions) {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-install-"));
  created.push(root);

  const binDir = path.join(root, "bin");
  const homeDir = home ?? path.join(root, "home");
  const log = path.join(root, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(log, "");

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
      'if [ -n "$dest" ]; then printf "payload of %s" "$url" > "$dest"; fi',
    ].join("\n"),
  );
  shim(binDir, "id", "echo 0");
  shim(binDir, "sudo", `echo "sudo $*" >> "${log}"; exec "$@"`);
  shim(
    binDir,
    "update-desktop-database",
    `echo "update-desktop-database $*" >> "${log}"`,
  );
  shim(binDir, "xdg-mime", `echo "xdg-mime $*" >> "${log}"`);
  shim(binDir, "open", `echo "open $*" >> "${log}"`);
  if (withPacman) {
    shim(binDir, "pacman", `echo "pacman $*" >> "${log}"`);
  }

  const scriptPath = path.join(root, "install.sh");
  writeFileSync(scriptPath, INSTALL_SCRIPT);

  const result = spawnSync("/bin/sh", [scriptPath], {
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: homeDir,
      XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    },
    encoding: "utf8",
  });

  return {
    root,
    homeDir,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    calls: readFileSync(log, "utf8"),
  };
}

describe("install.sh", () => {
  test("is POSIX sh, not bash", () => {
    expect(INSTALL_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(INSTALL_SCRIPT).not.toContain("[[");

    const parsed = spawnSync("/bin/sh", ["-n"], {
      input: INSTALL_SCRIPT,
      encoding: "utf8",
    });
    expect(String(parsed.stderr ?? "")).toBe("");
    expect(parsed.status).toBe(0);
  });

  test("Arch: downloads the pacman package and installs it with pacman -U", () => {
    const run = runInstaller({
      unameS: "Linux",
      unameM: "x86_64",
      withPacman: true,
    });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toContain(RELEASE_ASSETS.arch);
    expect(run.calls).toMatch(/pacman -U --noconfirm .*stella\.pkg\.tar\.xz/);
    // The Arch branch must never fall through to the AppImage branch.
    expect(
      existsSync(path.join(run.homeDir, ".local/bin/Stella.AppImage")),
    ).toBe(false);
  });

  test("non-Arch: installs the AppImage on PATH with an executable bit, icon and menu entry", () => {
    const run = runInstaller({ unameS: "Linux", unameM: "x86_64" });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.calls).toContain(RELEASE_ASSETS.linux);

    const appImage = path.join(run.homeDir, ".local/bin/Stella.AppImage");
    expect(existsSync(appImage)).toBe(true);
    expect(spawnSync("test", ["-x", appImage]).status).toBe(0);

    const desktopFile = path.join(
      run.homeDir,
      ".local/share/applications/stella-v2.desktop",
    );
    const entry = readFileSync(desktopFile, "utf8");
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain(`Exec="${appImage}" %U`);
    expect(entry).toContain("Icon=stella-v2");
    expect(entry).toContain("MimeType=x-scheme-handler/stella;");

    expect(
      existsSync(
        path.join(
          run.homeDir,
          ".local/share/icons/hicolor/512x512/apps/stella-v2.png",
        ),
      ),
    ).toBe(true);
    expect(run.calls).toContain("update-desktop-database");
  });

  test("non-Arch: re-running is idempotent", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "stella-home-"));
    created.push(home);

    const first = runInstaller({ unameS: "Linux", unameM: "x86_64", home });
    const desktopFile = path.join(
      home,
      ".local/share/applications/stella-v2.desktop",
    );
    const firstEntry = readFileSync(desktopFile, "utf8");

    const second = runInstaller({ unameS: "Linux", unameM: "x86_64", home });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(readFileSync(desktopFile, "utf8")).toBe(firstEntry);
  });

  test("Linux on an unpublished architecture fails with a clear error", () => {
    const run = runInstaller({ unameS: "Linux", unameM: "aarch64" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("x86_64 only");
    expect(run.stderr).toContain("aarch64");
  });

  test("macOS still downloads and opens the architecture-matched DMG", () => {
    const run = runInstaller({ unameS: "Darwin", unameM: "arm64" });

    expect(run.status).toBe(0);
    expect(run.calls).toContain(RELEASE_ASSETS["mac-arm64"]);
    expect(run.calls).toContain("open ");
  });

  test("unsupported operating systems fail with a clear error", () => {
    const run = runInstaller({ unameS: "FreeBSD", unameM: "x86_64" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unsupported operating system");
  });
});
