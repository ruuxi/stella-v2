import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const REQUIRED_CONVEX = Object.freeze({
  deployment: "dev:impartial-crab-34",
  cloudUrl: "https://impartial-crab-34.convex.cloud",
  siteUrl: "https://impartial-crab-34.convex.site",
});

export const REQUIRED_CLOUD_BUILDER_ORIGIN =
  "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev";

export const FORBIDDEN_TARGET_PATTERN =
  /(?:flexible-panther-999|benevolent-minnow-586)/i;

const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|credential|jwt|password|secret|session|token)/i;

export class CloudProofError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "CloudProofError";
    this.details = details;
  }
}

const required = (env, key) => {
  const value = env[key]?.trim();
  if (!value) throw new CloudProofError(`${key} is required.`);
  return value;
};

const exactUrl = (value, expected, key) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CloudProofError(`${key} must be a valid URL.`);
  }
  if (parsed.href !== `${expected}/` || parsed.origin !== expected) {
    throw new CloudProofError(`${key} must be exactly ${expected}.`);
  }
  return expected;
};

const workerUrl = (value) => {
  if (FORBIDDEN_TARGET_PATTERN.test(value)) {
    throw new CloudProofError(
      "Historical or production cloud targets are forbidden.",
    );
  }
  return exactUrl(value, REQUIRED_CLOUD_BUILDER_ORIGIN, "CLOUD_BUILDER_URL");
};

const boundedInteger = (value, fallback, min, max, key) => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CloudProofError(
      `${key} must be an integer from ${min} to ${max}.`,
    );
  }
  return parsed;
};

const evidencePath = (value) => {
  if (!path.isAbsolute(value)) {
    throw new CloudProofError(
      "STELLA_CLOUD_PROOF_EVIDENCE_PATH must be an absolute JSON file path.",
    );
  }
  const declared = path.resolve(value);
  let resolved;
  try {
    const parent = realpathSync(path.dirname(declared));
    if (!statSync(parent).isDirectory())
      throw new Error("parent is not a directory");
    resolved = path.join(parent, path.basename(declared));
  } catch (error) {
    throw new CloudProofError(
      `STELLA_CLOUD_PROOF_EVIDENCE_PATH parent must already exist: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const liveStellaRoot = path.join(homedir(), ".stella");
  if (
    resolved === path.parse(resolved).root ||
    resolved === liveStellaRoot ||
    resolved.startsWith(`${liveStellaRoot}${path.sep}`) ||
    !resolved.endsWith(".json")
  ) {
    throw new CloudProofError(
      "STELLA_CLOUD_PROOF_EVIDENCE_PATH must name a fresh JSON file outside the live ~/.stella tree.",
    );
  }
  return resolved;
};

/**
 * Loads the mutating protocol-proof configuration. The explicit confirmation
 * and exact URLs prevent a stale shell from aiming this at the historical
 * staging deployment or production.
 */
export const loadProtocolProofConfig = (env) => {
  const deployment = required(env, "CONVEX_DEPLOYMENT");
  if (deployment !== REQUIRED_CONVEX.deployment) {
    throw new CloudProofError(
      `CONVEX_DEPLOYMENT must be exactly ${REQUIRED_CONVEX.deployment}.`,
    );
  }
  const convexUrl = exactUrl(
    required(env, "CONVEX_URL"),
    REQUIRED_CONVEX.cloudUrl,
    "CONVEX_URL",
  );
  const convexSiteUrl = exactUrl(
    required(env, "CONVEX_SITE_URL"),
    REQUIRED_CONVEX.siteUrl,
    "CONVEX_SITE_URL",
  );
  if (
    required(env, "STELLA_CLOUD_PROOF_CONFIRM") !==
    "mutate-dev:impartial-crab-34"
  ) {
    throw new CloudProofError(
      "Set STELLA_CLOUD_PROOF_CONFIRM=mutate-dev:impartial-crab-34 to acknowledge disposable dev writes.",
    );
  }
  if (required(env, "STELLA_CLOUD_PROOF_IDENTITY_KIND") !== "disposable") {
    throw new CloudProofError(
      "STELLA_CLOUD_PROOF_IDENTITY_KIND must be disposable; personal/shared identities are not accepted.",
    );
  }

  return Object.freeze({
    deployment,
    convexUrl,
    convexSiteUrl,
    cloudBuilderUrl: workerUrl(required(env, "CLOUD_BUILDER_URL")),
    jwt: required(env, "STELLA_CLOUD_PROOF_JWT"),
    builderServiceSecret: required(env, "BUILDER_SERVICE_SECRET"),
    evidencePath: evidencePath(
      required(env, "STELLA_CLOUD_PROOF_EVIDENCE_PATH"),
    ),
    timeoutMs: boundedInteger(
      env.STELLA_CLOUD_PROOF_TIMEOUT_MS,
      20_000,
      1_000,
      120_000,
      "STELLA_CLOUD_PROOF_TIMEOUT_MS",
    ),
    projectionTimeoutMs: boundedInteger(
      env.STELLA_CLOUD_PROOF_PROJECTION_TIMEOUT_MS,
      60_000,
      5_000,
      300_000,
      "STELLA_CLOUD_PROOF_PROJECTION_TIMEOUT_MS",
    ),
    rolloverRowsPerTurn: boundedInteger(
      env.STELLA_CLOUD_PROOF_ROLLOVER_ROWS_PER_TURN,
      1_000,
      500,
      1_000,
      "STELLA_CLOUD_PROOF_ROLLOVER_ROWS_PER_TURN",
    ),
  });
};

export const assertSafeAcceptanceEnvironment = (manifest, env) => {
  const target = manifest?.target;
  if (!target || typeof target !== "object") {
    throw new CloudProofError("Acceptance manifest target is required.");
  }
  const checked = loadNonMutatingTarget({
    deployment: target.convexDeployment,
    convexUrl: target.convexUrl,
    convexSiteUrl: target.convexSiteUrl,
    cloudBuilderUrl: target.cloudBuilderUrl,
  });
  if (
    env.STELLA_CLOUD_ACCEPTANCE_CONFIRM !== "run-real-dev:impartial-crab-34"
  ) {
    throw new CloudProofError(
      "Set STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-dev:impartial-crab-34 before invoking real product commands.",
    );
  }
  return checked;
};

export const loadNonMutatingTarget = (target) => {
  if (target.deployment !== REQUIRED_CONVEX.deployment) {
    throw new CloudProofError(
      `Manifest deployment must be exactly ${REQUIRED_CONVEX.deployment}.`,
    );
  }
  return Object.freeze({
    deployment: target.deployment,
    convexUrl: exactUrl(
      target.convexUrl,
      REQUIRED_CONVEX.cloudUrl,
      "convexUrl",
    ),
    convexSiteUrl: exactUrl(
      target.convexSiteUrl,
      REQUIRED_CONVEX.siteUrl,
      "convexSiteUrl",
    ),
    cloudBuilderUrl: workerUrl(target.cloudBuilderUrl),
  });
};

export const assert = (condition, message, details) => {
  if (!condition) throw new CloudProofError(message, details);
};

export const sha256 = (value) =>
  createHash("sha256")
    .update(
      Buffer.isBuffer(value) || value instanceof Uint8Array
        ? value
        : String(value),
    )
    .digest("hex");

export const sanitizeEvidence = (value, key = "") => {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/^Bearer\s+/i.test(value)) return "[REDACTED]";
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[JWT REDACTED]",
      )
      .replace(
        /((?:authorization|cookie|password|secret|token)=)[^&\s]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /(?:flexible-panther-999|benevolent-minnow-586)/gi,
        "[FORBIDDEN]",
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidence(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeEvidence(entryValue, entryKey),
      ]),
    );
  }
  return value;
};

export const writeEvidence = async (filePath, value) => {
  const sanitized = sanitizeEvidence(value);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const abortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

const readWithSignal = (reader, signal) => {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const boundedText = async (response, maxBytes, signal) => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CloudProofError(
      "Response body exceeded the proof harness limit.",
      { status: response.status, bytes: declaredLength, declared: true },
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new CloudProofError(
          "Response body exceeded the proof harness limit.",
          { status: response.status, bytes },
        );
      }
      chunks.push(chunk);
    }
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // An aborted pending read owns the lock until cancellation settles.
    }
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
};

export const requestJson = async (
  url,
  {
    label,
    timeoutMs,
    expectedStatuses = [200],
    maxResponseBytes = 256_000,
    ...init
  },
) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new CloudProofError("Request timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new CloudProofError(
      "Request response-body limit must be a positive integer.",
    );
  }
  if (
    !Array.isArray(expectedStatuses) ||
    expectedStatuses.length === 0 ||
    expectedStatuses.some(
      (status) => !Number.isSafeInteger(status) || status < 100 || status > 599,
    )
  ) {
    throw new CloudProofError("Expected HTTP statuses are invalid.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await boundedText(
      response,
      maxResponseBytes,
      controller.signal,
    );
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!expectedStatuses.includes(response.status)) {
          throw new CloudProofError(
            `${label} returned HTTP ${response.status}.`,
            {
              status: response.status,
              bodyFormat: "non-json",
              bodyHash: sha256(text),
            },
          );
        }
        throw new CloudProofError(`${label} returned non-JSON.`, {
          status: response.status,
          bodyHash: sha256(text),
        });
      }
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new CloudProofError(`${label} returned HTTP ${response.status}.`, {
        status: response.status,
        body: sanitizeEvidence(body),
      });
    }
    return { status: response.status, body, headers: response.headers };
  } catch (error) {
    if (error instanceof CloudProofError) throw error;
    const reason =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CloudProofError(`${label} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
};

export const poll = async (
  operation,
  predicate,
  { timeoutMs, intervalMs = 500, label },
) => {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let latestError;
  while (Date.now() <= deadline) {
    try {
      latest = await operation();
      latestError = undefined;
      if (predicate(latest)) return latest;
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new CloudProofError(
    `${label} did not converge within ${timeoutMs}ms.`,
    {
      latest: sanitizeEvidence(latest),
      latestError:
        latestError instanceof Error
          ? latestError.message
          : String(latestError ?? ""),
    },
  );
};
