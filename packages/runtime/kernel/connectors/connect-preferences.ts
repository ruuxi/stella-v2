import path from "node:path";

import {
  readJsonStateFile,
  updateJsonStateFile,
} from "../shared/atomic-json-state.js";
import { getConnectorStateRoot } from "./state.js";

const PREFERENCES_FILE = "connect-preferences.json";

export type ConnectorDeclineEntry = {
  declinedAt: number;

  count: number;
};

type ConnectPreferencesFile = {
  version: 1;
  declined: Record<string, ConnectorDeclineEntry>;
};

const preferencesPath = (stellaAppDir: string) =>
  path.join(getConnectorStateRoot(stellaAppDir), PREFERENCES_FILE);

const parsePreferences = (raw: unknown): ConnectPreferencesFile => {
  const parsed = raw as ConnectPreferencesFile | undefined;
  if (parsed?.version === 1 && parsed.declined) return parsed;

  return { version: 1, declined: {} };
};

const readPreferences = async (
  stellaAppDir: string,
): Promise<ConnectPreferencesFile> =>
  readJsonStateFile(preferencesPath(stellaAppDir), parsePreferences);

export const getConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<ConnectorDeclineEntry | null> => {
  const preferences = await readPreferences(stellaAppDir);
  return preferences.declined[id] ?? null;
};

export const listConnectorDeclines = async (
  stellaAppDir: string,
): Promise<Record<string, ConnectorDeclineEntry>> => {
  const preferences = await readPreferences(stellaAppDir);
  return preferences.declined;
};

export const recordConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<ConnectorDeclineEntry> => {
  let entry: ConnectorDeclineEntry = { declinedAt: Date.now(), count: 1 };
  await updateJsonStateFile({
    filePath: preferencesPath(stellaAppDir),
    parse: parsePreferences,
    update: (preferences) => {
      entry = {
        declinedAt: Date.now(),
        count: (preferences.declined[id]?.count ?? 0) + 1,
      };
      preferences.declined[id] = entry;
    },
  });
  return entry;
};

export const clearConnectorDecline = async (
  stellaAppDir: string,
  id: string,
): Promise<void> => {
  await updateJsonStateFile({
    filePath: preferencesPath(stellaAppDir),
    parse: parsePreferences,
    update: (preferences) => {
      delete preferences.declined[id];
    },
  });
};
