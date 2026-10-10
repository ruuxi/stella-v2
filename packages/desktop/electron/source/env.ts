import fs from "node:fs";
import path from "node:path";

/**
 * The renderer's `import.meta.env`, as Vite defined it: `VITE_*` keys from
 * `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local` (later files
 * win, then the process environment), plus MODE, DEV, PROD, SSR and
 * BASE_URL.
 */

/**
 * A backend deployed under the repo's worker names (a first hostname label
 * containing `cloud-builder`, on any domain) pairs with the same-named Apps
 * hosts: `cloud-builder` becomes `apps-host` and `apps-auth`. Any other
 * backend names its Apps hosts with VITE_STELLA_APPS_HOST and
 * VITE_STELLA_APPS_AUTH_HOST.
 */
export const pairedAppsHosts = (
  backendUrl: string | undefined,
): { appsHost: string; appsAuthHost: string } | null => {
  let url: URL;
  try {
    url = new URL(backendUrl?.trim() ?? "");
  } catch {
    return null;
  }
  const [label, ...rest] = url.hostname.split(".");
  if (url.protocol !== "https:" || !label?.includes("cloud-builder") || rest.length === 0) return null;
  const host = (name: string) => `https://${[label.replace("cloud-builder", name), ...rest].join(".")}`;
  return { appsHost: host("apps-host"), appsAuthHost: host("apps-auth") };
};

const parseEnvFile =(source: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[match[1]!] = value;
  }
  return values;
};

export type RendererEnv = Record<string, string | boolean>;

const readEnvFiles = (uiRoot: string, mode: string): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    try {
      Object.assign(merged, parseEnvFile(fs.readFileSync(path.join(uiRoot, name), "utf8")));
    } catch {
      // A missing env file is normal.
    }
  }
  return merged;
};

const MAIN_PROCESS_ENV_KEY = /^(STELLA_NATIVE_OAUTH_[A-Z0-9_]+_CLIENT_ID|WORKSPACE_CLIENT_ID)$/;

export const applyDesktopIdentityEnv = (uiRoot: string, mode: string): void => {
  const files = readEnvFiles(uiRoot, mode);
  const adopt = (key: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !process.env[key]?.trim()) process.env[key] = trimmed;
  };
  adopt("STELLA_WEB_URL", process.env.VITE_STELLA_WEB_URL ?? files.VITE_STELLA_WEB_URL);
  // Main fetches canvas-share links opened in the app (canvas-share-service).
  adopt(
    "CANVAS_SHARE_BASE_URL",
    process.env.VITE_CANVAS_SHARE_BASE_URL ?? files.VITE_CANVAS_SHARE_BASE_URL,
  );
  for (const [key, value] of Object.entries(files)) {
    if (MAIN_PROCESS_ENV_KEY.test(key)) adopt(key, value);
  }
};

export const loadRendererEnv = (uiRoot: string, mode: string): RendererEnv => {
  const merged = readEnvFiles(uiRoot, mode);
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITE_") && value !== undefined) merged[key] = value;
  }
  // A launcher that only names the backend gets its Apps hosts too.
  const paired = pairedAppsHosts(merged.VITE_STELLA_BACKEND_URL);
  if (paired) {
    merged.VITE_STELLA_APPS_HOST ||= paired.appsHost;
    merged.VITE_STELLA_APPS_AUTH_HOST ||= paired.appsAuthHost;
  }
  const env: RendererEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith("VITE_")) env[key] = value;
  }
  const dev = mode !== "production";
  return { ...env, MODE: mode, DEV: dev, PROD: !dev, SSR: false, BASE_URL: "/" };
};

/** `define` entries for the transformer: each key, plus the whole object. */
export const envDefines = (env: RendererEnv): Record<string, string> => {
  const defines: Record<string, string> = {
    "import.meta.env": JSON.stringify(env),
    "process.env.NODE_ENV": JSON.stringify(env.DEV ? "development" : "production"),
  };
  for (const [key, value] of Object.entries(env)) {
    defines[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return defines;
};
