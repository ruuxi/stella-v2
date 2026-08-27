import { describe, expect, test } from "bun:test";
import {
  APP_BUILD_SESSION_ENV,
  startStrictSessionProcess,
  strictSessionCommand,
  strictSessionExec,
} from "../src/strict-session-process.js";

describe("strict Builder session process boundary", () => {
  test("app and preview sessions receive no reusable turn authority", () => {
    expect(APP_BUILD_SESSION_ENV).toEqual({
      STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
      USER: "stella-tools",
      LOGNAME: "stella-tools",
      HOME: "/workspace/.stella-tool-home",
      XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
      XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
      XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
    });
    expect(JSON.stringify(APP_BUILD_SESSION_ENV)).not.toContain(
      "STELLA_TURN_TOKEN",
    );
  });

  test("serializes an exact setpriv drop and quotes hostile argv", () => {
    const command = strictSessionCommand([
      "/bin/sh",
      "-lc",
      "printf '%s' \"$HOME\"; touch /tmp/pwned",
      "a'b",
    ]);
    expect(command).toBe(
      "exec /usr/bin/setpriv --reuid=42424 --regid=42424 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- '/bin/sh' '-lc' 'printf '\"'\"'%s'\"'\"' \"$HOME\"; touch /tmp/pwned' 'a'\"'\"'b'",
    );
  });

  test("wraps both foreground and tracked background processes", async () => {
    const calls: Array<{ kind: string; command: string; options: unknown }> = [];
    const fake = {
      exec: async (command: string, options?: unknown) => {
        calls.push({ kind: "exec", command, options });
        return { success: true };
      },
      startProcess: async (command: string, options?: unknown) => {
        calls.push({ kind: "start", command, options });
        return { processId: "p" };
      },
    };
    await strictSessionExec(fake as never, ["bun", "entry.ts"], {
      timeout: 123,
    });
    await startStrictSessionProcess(fake as never, ["vite", "--host"], {
      cwd: "/workspace/app",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toStartWith("exec /usr/bin/setpriv ");
    expect(calls[0]?.command).toEndWith("-- 'bun' 'entry.ts'");
    expect(calls[1]?.command).toEndWith("-- 'vite' '--host'");
  });

  test("rejects empty and NUL-bearing argv", () => {
    expect(() => strictSessionCommand([])).toThrow("requires a command");
    expect(() => strictSessionCommand(["/bin/sh", "bad\0arg"])).toThrow(
      "NUL byte",
    );
  });
});
