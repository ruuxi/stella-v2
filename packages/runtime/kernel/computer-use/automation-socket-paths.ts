import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const automationSocketsRootDir = (homeDir: string = os.homedir()) =>
  path.join(homeDir, ".stella", "computer-sockets");

export const automationSocketFileName = (stateDir: string, sessionId: string) =>
  `${createHash("sha1")
    .update(`${path.resolve(stateDir)}\n${sessionId}`)
    .digest("hex")
    .slice(0, 16)}.sock`;

export const resolveAutomationSocketPath = (
  stateDir: string,
  sessionId: string,
  options?: { homeDir?: string },
) =>
  path.join(
    automationSocketsRootDir(options?.homeDir),
    automationSocketFileName(stateDir, sessionId),
  );

export const maxAutomationSocketPathBytes = 100;
