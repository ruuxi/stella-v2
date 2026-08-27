export type CloudBuildCallback = {
  buildId: string;
  appId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  artifactPrefix: string;
  previewUrl: string;
  metricsJson: string;
  slug: string;
  autoActivate: boolean;
  title?: string;
};

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_METRICS_BYTES = 64 * 1024;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A JSON object is required.");
  }
  return value as Record<string, unknown>;
};

const requiredString = (
  record: Record<string, unknown>,
  field: string,
  pattern: RegExp,
): string => {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
};

export const parseCloudBuildCallback = (value: unknown): CloudBuildCallback => {
  const body = asRecord(value);
  const buildId = requiredString(body, "buildId", BUILD_ID_PATTERN);
  const appId = requiredString(body, "appId", ID_PATTERN);
  const ownerId = requiredString(body, "ownerId", /^\S{1,512}$/);
  const ownerGeneration = requiredString(
    body,
    "ownerGeneration",
    /^\S{1,512}$/,
  );
  const turnId = requiredString(body, "turnId", ID_PATTERN);
  const artifactPrefix = requiredString(
    body,
    "artifactPrefix",
    /^builds\/[0-9a-f]{64}\/[A-Za-z0-9_-]{1,64}$/,
  );
  if (!artifactPrefix.endsWith(`/${buildId}`)) {
    throw new Error("artifactPrefix must be builds/<ownerHash>/<buildId>.");
  }
  const previewUrl = requiredString(
    body,
    "previewUrl",
    /^https?:\/\/\S{1,2048}$/,
  );
  try {
    const parsed = new URL(previewUrl);
    if (parsed.username || parsed.password) throw new Error();
  } catch {
    throw new Error("previewUrl is invalid.");
  }
  const slug = requiredString(body, "slug", SLUG_PATTERN);
  if (typeof body.autoActivate !== "boolean") {
    throw new Error("autoActivate must be a boolean.");
  }
  const metricsJson = JSON.stringify(body.metrics ?? null);
  if (new TextEncoder().encode(metricsJson).byteLength > MAX_METRICS_BYTES) {
    throw new Error("metrics is too large.");
  }
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 80)
      : undefined;
  return {
    buildId,
    appId,
    ownerId,
    ownerGeneration,
    turnId,
    artifactPrefix,
    previewUrl,
    metricsJson,
    slug,
    autoActivate: body.autoActivate,
    ...(title ? { title } : {}),
  };
};
