import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
const acceptanceScript = path.join(
  repoRoot,
  "packages/runtime/scripts/live-exec-write-acceptance.ts",
);

describe("live exec/write acceptance", () => {
  it("passes against real pipe and PTY child transports", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.env.STELLA_BUN_BIN?.trim() || "bun",
      [acceptanceScript],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
    );
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      ok: boolean;
      evidence: {
        shell_safety_parser_only: {
          safe_descendants_allowed: number;
        };
        early_poll: { remained_running_at_return: boolean };
        utf8_receipts: {
          text: string;
          cursor_ranges: Array<[number, number]>;
        };
        idempotency_and_ownership: {
          retry_deduplicated: boolean;
          foreign_conversation_denied: boolean;
          foreign_agent_denied: boolean;
        };
        pty: {
          child_observed_resize: boolean;
          receipt_included_size: boolean;
          terminate_stopped_live_pty: boolean;
        };
        process_controls: {
          close_stdin_observed_eof: boolean;
          terminate_stopped_live_child: boolean;
        };
        tombstone: {
          foreign_caller_received_generic_missing: boolean;
        };
      };
    };

    expect(report).toMatchObject({
      ok: true,
      evidence: {
        shell_safety_parser_only: { safe_descendants_allowed: 6 },
        early_poll: { remained_running_at_return: true },
        utf8_receipts: {
          text: "🙂漢é",
          cursor_ranges: [
            [0, 4],
            [4, 7],
            [7, 9],
          ],
        },
        idempotency_and_ownership: {
          retry_deduplicated: true,
          foreign_conversation_denied: true,
          foreign_agent_denied: true,
        },
        pty: {
          child_observed_resize: true,
          receipt_included_size: true,
          terminate_stopped_live_pty: true,
        },
        process_controls: {
          close_stdin_observed_eof: true,
          terminate_stopped_live_child: true,
        },
        tombstone: {
          foreign_caller_received_generic_missing: true,
        },
      },
    });
  }, 20_000);
});
