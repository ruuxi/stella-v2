import fs from "node:fs";
import path from "node:path";

/**
 * The renderer's `import.meta.env`, as Vite defined it: `VITE_*` keys from
 * `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local` (later files
 * win, then the process environment), plus MODE, DEV, PROD, SSR and
 * BASE_URL.
 */

export const BACKEND_SUFFIX = /^https:\/\/stella-v2-cloud-builder-([a-z0-9-]+)\.lolruuxi\.workers\.dev$/;

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

export const loadRendererEnv = (uiRoot: string, mode: string): RendererEnv => {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    try {
      Object.assign(merged, parseEnvFile(fs.readFileSync(path.join(uiRoot, name), "utf8")));
    } catch {
      // A missing env file is normal.
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITE_") && value !== undefined) merged[key] = value;
  }
  // A `stella-v2-cloud-builder-<suffix>` backend pairs with the same-suffix
  // Apps hosts, so a launcher that only names the backend gets its apps too.
  const suffix = BACKEND_SUFFIX.exec(merged.VITE_STELLA_BACKEND_URL?.trim().replace(/\/+$/, "") ?? "")?.[1];
  if (suffix) {
    merged.VITE_STELLA_APPS_HOST ||= `https://stella-v2-apps-host-${suffix}.lolruuxi.workers.dev`;
    merged.VITE_STELLA_APPS_AUTH_HOST ||= `https://stella-v2-apps-auth-${suffix}.lolruuxi.workers.dev`;
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
