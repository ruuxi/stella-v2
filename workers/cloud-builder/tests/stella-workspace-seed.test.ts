import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
  ContainerProxy: class {},
}));
const {
  normalizeToolWorkspaceRoot,
  seedFirstStellaToolWorkspace,
  stellaToolWorkspaceExists,
} = await import("../src/index.js");
mock.restore();

describe("first Stella workspace seed", () => {
  test("securely initializes a missing optional Drive root before hydration", async () => {
    let command = "";
    const session = {
      exec: async (nextCommand: string) => {
        command = nextCommand;
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await normalizeToolWorkspaceRoot(session as never, "/workspace/world");

    expect(command).toContain(
      "else mkdir -m 0750 '/workspace/world/drive' && chown 42424:42424 '/workspace/world/drive'; fi",
    );
    expect(command).toContain(
      `test "$(readlink -f '/workspace/world/drive')" = '/workspace/world/drive'`,
    );
    expect(command).toContain(
      `test "$(stat -c '%u:%g:%a' '/workspace/world/drive')" = 42424:42424:750`,
    );
  });

  test("rejects an unsafe existing Drive root instead of repairing it", async () => {
    let command = "";
    const session = {
      exec: async (nextCommand: string) => {
        command = nextCommand;
        return { success: false, exitCode: 1, stdout: "", stderr: "" };
      },
    };

    await expect(
      normalizeToolWorkspaceRoot(session as never, "/workspace/world"),
    ).rejects.toThrow("Cloud workspace mount boundary validation failed.");

    expect(command).toContain(
      "then test -d '/workspace/world/drive' && test ! -L '/workspace/world/drive'",
    );
    expect(command).not.toContain("chown -R");
    expect(command.indexOf("chown 42424:42424 '/workspace/world/drive'")).toBe(
      command.lastIndexOf("chown 42424:42424 '/workspace/world/drive'"),
    );
  });

  test("does not create a Drive root for the throwaway app workspace", async () => {
    let command = "";
    const session = {
      exec: async (nextCommand: string) => {
        command = nextCommand;
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await normalizeToolWorkspaceRoot(session as never, "/workspace/app");

    expect(command).not.toContain("/workspace/world/drive");
  });

  test("reports a missing checkout without a non-zero Sandbox command", async () => {
    let command = "";
    const session = {
      exec: async (nextCommand: string) => {
        command = nextCommand;
        return {
          success: true,
          exitCode: 0,
          stdout: "absent\n",
          stderr: "",
        };
      },
    };

    await expect(stellaToolWorkspaceExists(session as never)).resolves.toBe(
      false,
    );
    expect(command).toContain("printf '%s\\n' absent");
    expect(command).not.toBe("test -d '/workspace/world/stella'");
  });

  test("rejects an existing symlink or non-directory checkout", async () => {
    const session = {
      exec: async () => ({
        success: true,
        exitCode: 0,
        stdout: "invalid\n",
        stderr: "",
      }),
    };

    await expect(
      stellaToolWorkspaceExists(session as never),
    ).rejects.toThrow("not a safe directory");
  });

  test("re-normalizes the workspace after the archival copy changes its mode", async () => {
    const calls: string[] = [];
    let mode = "42424:42424:750";
    const session = {
      exec: async (command: string) => {
        calls.push(command);
        if (command.includes("cp -a /opt/stella/packages/desktop-ui/.")) {
          mode = "42424:42424:755";
          return { success: true, exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("chmod 0750 '/workspace/world'")) {
          mode = "42424:42424:750";
        }
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await seedFirstStellaToolWorkspace(session as never);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toStartWith("/usr/bin/setpriv ");
    expect(calls[0]).toContain(
      `cp -a /opt/stella/packages/desktop-ui/. '"'"'/workspace/world/stella/'"'"'`,
    );
    expect(calls[1]).toContain("chmod 0750 '/workspace/world'");
    expect(calls[1]).toContain(
      "test \"$(stat -c '%u:%g:%a' '/workspace/world')\" = 42424:42424:750",
    );
    expect(mode).toBe("42424:42424:750");
  });

  test("does not claim a seed succeeded when the boundary cannot be restored", async () => {
    let calls = 0;
    const session = {
      exec: async () => {
        calls += 1;
        return {
          success: calls === 1,
          exitCode: calls === 1 ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      },
    };

    await expect(
      seedFirstStellaToolWorkspace(session as never),
    ).rejects.toThrow("Cloud workspace mount boundary validation failed.");
  });
});
