import { isValidServiceBearerSecret } from "./service-bearer.js";

export const CLOUD_BUILDER_REQUIRED_FIELDS = [
  "Sandbox",
  "APP_BUILD_SANDBOX",
  "BUILD_SESSIONS",
  "ORCHESTRATOR_SESSIONS",
  "OWNER_TRANSFER_COORDINATORS",
  "OWNER_GATES",
  "TURN_OUTBOX",
  "BROWSER_GATEWAY",
  "MODEL_GATEWAY",
  "APP_BUILDS",
  "APP_ROUTES",
  "BACKUP_BUCKET",
  "AGENT_HOME",
  "CONVERSATION_ARCHIVE",
  "LOADER",
  "BUILDER_SERVICE_SECRET",
  "SANDBOX_TRANSPORT",
  "TURN_TIMEOUT_MS",
  "SANDBOX_IDLE_TIMEOUT_MS",
  "APPS_HOST_BASE_URL",
  "TRUSTED_APPS_HOST_BASE_URL",
  "STELLA_CONVEX_SITE_URL",
  "STELLA_CONVEX_CLOUD_URL",
  "MODEL_GATEWAY_URL",
  "CLOUD_BUILDER_PUBLIC_URL",
  "CAPABILITY_SIGNING_KEY",
  "CAPABILITY_SIGNING_KID",
] as const;

export type CloudBuilderRequiredField =
  (typeof CLOUD_BUILDER_REQUIRED_FIELDS)[number];

export type CloudBuilderReadinessInput = Partial<
  Record<CloudBuilderRequiredField, unknown>
>;

export type CloudBuilderReadiness = {
  ready: boolean;
  missing: CloudBuilderRequiredField[];
  invalid: CloudBuilderRequiredField[];
};

const isPresent = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== "";

const hasMethods = (value: unknown, methods: readonly string[]): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  methods.every(
    (method) =>
      typeof (value as Readonly<Record<string, unknown>>)[method] ===
      "function",
  );

const isPositiveIntegerString = (value: unknown): boolean => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
};

const normalizedHttpsOrigin = (value: unknown): string | null => {
  if (typeof value !== "string" || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
};

const isHttpsOrigin = (value: unknown): boolean =>
  normalizedHttpsOrigin(value) !== null;

const validators: Readonly<
  Record<CloudBuilderRequiredField, (value: unknown) => boolean>
> = {
  Sandbox: (value) => hasMethods(value, ["getByName"]),
  APP_BUILD_SANDBOX: (value) => hasMethods(value, ["getByName"]),
  BUILD_SESSIONS: (value) => hasMethods(value, ["getByName"]),
  ORCHESTRATOR_SESSIONS: (value) => hasMethods(value, ["getByName"]),
  OWNER_TRANSFER_COORDINATORS: (value) => hasMethods(value, ["getByName"]),
  OWNER_GATES: (value) => hasMethods(value, ["getByName"]),
  TURN_OUTBOX: (value) => hasMethods(value, ["send", "sendBatch"]),
  BROWSER_GATEWAY: (value) => hasMethods(value, ["fetch"]),
  MODEL_GATEWAY: (value) => hasMethods(value, ["fetch"]),
  APP_BUILDS: (value) => hasMethods(value, ["get", "put", "delete", "list"]),
  APP_ROUTES: (value) => hasMethods(value, ["get", "put", "delete", "list"]),
  BACKUP_BUCKET: (value) => hasMethods(value, ["get", "put", "delete", "list"]),
  AGENT_HOME: (value) => hasMethods(value, ["get", "put", "delete", "list"]),
  CONVERSATION_ARCHIVE: (value) =>
    hasMethods(value, ["get", "put", "delete", "list"]),
  LOADER: (value) => hasMethods(value, ["get", "load"]),
  BUILDER_SERVICE_SECRET: isValidServiceBearerSecret,
  SANDBOX_TRANSPORT: (value) => value === "rpc",
  TURN_TIMEOUT_MS: isPositiveIntegerString,
  SANDBOX_IDLE_TIMEOUT_MS: isPositiveIntegerString,
  APPS_HOST_BASE_URL: isHttpsOrigin,
  TRUSTED_APPS_HOST_BASE_URL: isHttpsOrigin,
  STELLA_CONVEX_SITE_URL: isHttpsOrigin,
  STELLA_CONVEX_CLOUD_URL: isHttpsOrigin,
  MODEL_GATEWAY_URL: isHttpsOrigin,
  CLOUD_BUILDER_PUBLIC_URL: isHttpsOrigin,
  CAPABILITY_SIGNING_KEY: (value) =>
    typeof value === "string" &&
    /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/u.test(value),
  CAPABILITY_SIGNING_KID: (value) =>
    typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value),
};

/**
 * Pure readiness evaluation. The result is intentionally restricted to a
 * fixed allowlist of field names and never carries binding values or secrets.
 */
export const evaluateCloudBuilderReadiness = (
  input: CloudBuilderReadinessInput,
): CloudBuilderReadiness => {
  const missing: CloudBuilderRequiredField[] = [];
  const invalid: CloudBuilderRequiredField[] = [];
  for (const field of CLOUD_BUILDER_REQUIRED_FIELDS) {
    const value = input[field];
    if (!isPresent(value)) {
      missing.push(field);
    } else if (!validators[field](value)) {
      invalid.push(field);
    }
  }

  const appsHost = normalizedHttpsOrigin(input.APPS_HOST_BASE_URL);
  const trustedAppsHost = normalizedHttpsOrigin(
    input.TRUSTED_APPS_HOST_BASE_URL,
  );
  if (
    appsHost !== null &&
    trustedAppsHost !== null &&
    appsHost === trustedAppsHost
  ) {
    if (!invalid.includes("APPS_HOST_BASE_URL")) {
      invalid.push("APPS_HOST_BASE_URL");
    }
    if (!invalid.includes("TRUSTED_APPS_HOST_BASE_URL")) {
      invalid.push("TRUSTED_APPS_HOST_BASE_URL");
    }
  }

  return {
    ready: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
};
