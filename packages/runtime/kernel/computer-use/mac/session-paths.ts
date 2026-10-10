import fs from "node:fs";
import path from "node:path";
import {
  computerSessionsDir,
  computerStateDir,
  readJsonFile,
  resolveComputerSessionId,
} from "../session-fs.js";
import type { SnapshotDocument } from "./ax-format.js";

export type SessionPaths = {
  sessionId: string;
  sessionDir: string;
  statePath: string;
  screenshotPath: string;
};

export const locksDir = () => path.join(computerStateDir(), "locks");
const lockedUseDir = () => path.join(computerStateDir(), "locked-use");

export const deriveScreenshotPath = (statePath: string) => {
  const parsed = path.parse(statePath);
  return path.join(parsed.dir, `${parsed.name}.png`);
};

export const resolveSessionPaths = (
  sessionOverride?: string | null,
): SessionPaths => {
  const sessionId = resolveComputerSessionId(sessionOverride);
  const sessionDir = path.join(computerSessionsDir(), sessionId);
  const statePath = path.join(sessionDir, "last-snapshot.json");
  return {
    sessionId,
    sessionDir,
    statePath,
    screenshotPath: deriveScreenshotPath(statePath),
  };
};

export const ensureStateDirectory = (sessionPaths: SessionPaths) => {
  fs.mkdirSync(computerStateDir(), { recursive: true });
  fs.mkdirSync(locksDir(), { recursive: true });
  fs.mkdirSync(lockedUseDir(), { recursive: true });
  fs.mkdirSync(sessionPaths.sessionDir, { recursive: true });
};

export const readSnapshotDocument = (statePath: string) =>
  readJsonFile<SnapshotDocument>(statePath);
