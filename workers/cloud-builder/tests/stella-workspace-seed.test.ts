import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: () => ({}),
  Sandbox: class {},
}));
const { seedFirstStellaToolWorkspace } = await import("../src/index.js");
mock.restore();

describe("first Stella workspace seed", () => {
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
