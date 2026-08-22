import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectRoot } from "./paths.js";

let isLoggingEnabled = false;

export function setLoggingEnabled(enabled: boolean) {
  isLoggingEnabled = enabled;
}

/**
 * Appends a diagnostic line to the Microsoft Graph server log. Callers MUST
 * NOT pass access tokens, refresh tokens, client secrets, or Authorization
 * headers — this integration never logs secrets. {@link redactSecrets}
 * scrubs common token shapes as a defensive backstop.
 */
export function logToFile(message: string) {
  if (!isLoggingEnabled) {
    return;
  }
  const root = getProjectRoot();
  if (!root) {
    return;
  }
  const logFilePath = path.join(root, "logs", "server.log");
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${redactSecrets(message)}\n`;

  void fs.mkdir(path.dirname(logFilePath), { recursive: true }).then(() =>
    fs.appendFile(logFilePath, logMessage).catch((err) => {
      console.error("Failed to write to log file:", err);
    }),
  );
}

/** Defensive scrubber for bearer tokens and OAuth token fields. */
export function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /((?:access|refresh|id)_token"?\s*[:=]\s*"?)[A-Za-z0-9._~+/-]+=*/gi,
      "$1[redacted]",
    );
}
