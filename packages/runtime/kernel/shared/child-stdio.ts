import type { ChildProcess } from "node:child_process";
import { errorDiagnosticFields } from "../../observability/error-fields.js";
import { getFileLogger } from "../../observability/file-logger.js";

export type ChildStdioStream = "stdin" | "stdout" | "stderr";

const STREAMS: readonly ChildStdioStream[] = ["stdin", "stdout", "stderr"];

/**
 * Give each of a child's stdio streams an `error` listener. Bun backs child
 * stdio with socketpairs, so a write to a child that has closed its stdin
 * fails with `EPIPE ... send` and is also emitted on the stream; with no
 * listener that emission is an uncaught exception that ends the runtime.
 * The log line names the child, so a dead peer is never anonymous.
 */
export const watchChildStdio = (
  child: ChildProcess,
  label: string,
  onError?: (stream: ChildStdioStream, error: Error) => void,
): void => {
  for (const stream of STREAMS) {
    child[stream]?.on("error", (error: Error) => {
      const fields = {
        label,
        pid: child.pid ?? null,
        stream,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        ...errorDiagnosticFields(error),
      };
      getFileLogger()?.warn("child.stdio-error", fields);
      console.warn(
        `[child-stdio] ${label} pid=${child.pid ?? "?"} ${stream}: ${error.message}`,
      );
      onError?.(stream, error);
    });
  }
};
