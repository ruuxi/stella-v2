import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const STELLA_BROWSER_BRIDGE_PROVIDER = "extension";
export const STELLA_BROWSER_BRIDGE_SESSION = "stella-app-bridge";
export const STELLA_BROWSER_BRIDGE_PORT = "39040";
export const STELLA_IN_APP_BROWSER_INIT_PORT = 39041;
export const STELLA_BROWSER_MANAGED_BRIDGE = "1";

/** Chrome native messaging host name — must match extension `connectNative` and host manifest. */
export const STELLA_NATIVE_MESSAGING_HOST_NAME = "com.stella.browser_bridge";

/** Chrome Web Store extension id allowed to connect to the native messaging host. */
export const STELLA_BROWSER_EXTENSION_ID = "kfnchfpocpmdblhfgcnpfaaebaioojnl";

const readBridgeToken = (tokenPath: string): string | null => {
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
};

export type StellaInAppBrowserInitEndpoint =
  | Readonly<{ path: string }>
  | Readonly<{ host: string; port: number }>;

const getBootstrapSession = (env: NodeJS.ProcessEnv) =>
  env.STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION?.trim() ||
  env.STELLA_BROWSER_SESSION?.trim() ||
  STELLA_BROWSER_BRIDGE_SESSION;

export const getStellaBrowserSocketDir = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const explicit = env.STELLA_BROWSER_SOCKET_DIR?.trim();
  if (explicit) return explicit;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, "stella-browser");
  const homeDir = os.homedir().trim();
  if (homeDir) return path.join(homeDir, ".stella-browser");
  return path.join(os.tmpdir(), "stella-browser");
};

export const getStellaInAppBrowserInitEndpoint = (
  env: NodeJS.ProcessEnv = process.env,
): StellaInAppBrowserInitEndpoint =>
  process.platform === "win32"
    ? Object.freeze({
        host: "127.0.0.1",
        port: STELLA_IN_APP_BROWSER_INIT_PORT,
      })
    : Object.freeze({
        path: path.join(
          getStellaBrowserSocketDir(env),
          `${getBootstrapSession(env)}.in-app.sock`,
        ),
      });

export const getStellaInAppBrowserInitTokenPath = (
  env: NodeJS.ProcessEnv = process.env,
): string =>
  path.join(
    getStellaBrowserSocketDir(env),
    `${getBootstrapSession(env)}.in-app-token`,
  );

const getBridgeTokenPath = (): string => {
  const socketDir = getStellaBrowserSocketDir();
  mkdirSync(socketDir, { recursive: true });
  return path.join(socketDir, `${STELLA_BROWSER_BRIDGE_SESSION}.ext-token`);
};

const persistBridgeToken = (
  tokenPath: string,
  token: string,
  overwriteExisting = false,
): void => {
  writeFileSync(tokenPath, token, { flag: overwriteExisting ? "w" : "wx" });
  if (process.platform !== "win32") {
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // Best-effort permissions tightening on Unix-like systems.
    }
  }
};

const getOrCreateBridgeToken = (): string => {
  const tokenPath = getBridgeTokenPath();
  const existingToken = readBridgeToken(tokenPath);
  if (existingToken) {
    return existingToken;
  }

  const nextToken = randomUUID();

  try {
    persistBridgeToken(tokenPath, nextToken);
    return nextToken;
  } catch {
    const persistedToken = readBridgeToken(tokenPath);
    if (persistedToken) {
      return persistedToken;
    }

    // Recover from a stale zero-byte/truncated token file so startup can heal itself.
    try {
      persistBridgeToken(tokenPath, nextToken, true);
      const repairedToken = readBridgeToken(tokenPath);
      if (repairedToken) {
        return repairedToken;
      }
    } catch {
      // Fall through to the descriptive error below.
    }

    throw new Error(
      `Failed to initialize persistent Stella browser bridge token at ${tokenPath}.`,
    );
  }
};

export const STELLA_BROWSER_BRIDGE_TOKEN = getOrCreateBridgeToken();

export const getStellaBrowserBridgeEnv = (): Record<string, string> => ({
  STELLA_BROWSER_PROVIDER: STELLA_BROWSER_BRIDGE_PROVIDER,
  STELLA_BROWSER_SESSION: STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_BROWSER_MANAGED_BRIDGE,
  STELLA_BROWSER_EXT_PORT: STELLA_BROWSER_BRIDGE_PORT,
  STELLA_BROWSER_EXT_TOKEN: STELLA_BROWSER_BRIDGE_TOKEN,
});
