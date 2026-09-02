/**
 * Wire-shape validation for a Stella-interior build candidate, shared by the
 * `interior-build.recorded` outbox event. Structural only; the semantic checks
 * (owner hash, build id derivation, manifest digest) live in
 * `cloud_deployments.recordInteriorBuild`.
 */

export type InteriorBuildCandidate = {
  buildId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  threadId: string;
  sourceRevision?: string;
  baseRevision?: string;
  artifactPrefix: string;
  artifactManifestJson: string;
  manifestSha256?: string;
  artifactDigest: string;
  artifactSizeBytes: number;
  bridgeAbi: number;
  minShellVersion: string;
};

export const parseInteriorBuildCandidate = (
  body: unknown,
): InteriorBuildCandidate => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("A JSON object is required.");
  }
  const candidate = body as Record<string, unknown>;
  const requiredString = (field: string): string => {
    const value = candidate[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} is required.`);
    }
    return value;
  };
  const optionalString = (field: string): string | undefined => {
    const value = candidate[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} is invalid.`);
    }
    return value;
  };
  const artifactManifestJson = requiredString("manifestJson");
  try {
    const parsed = JSON.parse(artifactManifestJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifestJson must encode an object.");
    }
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.startsWith("manifestJson")
        ? error.message
        : "manifestJson must be valid JSON.",
    );
  }
  const artifactSizeBytes = candidate.size;
  const bridgeAbi = candidate.bridgeAbi;
  if (!Number.isSafeInteger(artifactSizeBytes) || (artifactSizeBytes as number) < 0) {
    throw new Error("size is invalid.");
  }
  if (!Number.isSafeInteger(bridgeAbi) || (bridgeAbi as number) < 1) {
    throw new Error("bridgeAbi is invalid.");
  }
  const sourceRevision = optionalString("sourceRevision");
  const baseRevision = optionalString("baseRevision");
  const manifestSha256 = optionalString("manifestSha256");
  return {
    buildId: requiredString("buildId"),
    ownerId: requiredString("ownerId"),
    ownerGeneration: requiredString("ownerGeneration"),
    turnId: requiredString("turnId"),
    threadId: requiredString("threadId"),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(baseRevision === undefined ? {} : { baseRevision }),
    artifactPrefix: requiredString("artifactPrefix"),
    artifactManifestJson,
    ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
    artifactDigest: requiredString("digest"),
    artifactSizeBytes: artifactSizeBytes as number,
    bridgeAbi: bridgeAbi as number,
    minShellVersion: requiredString("minShellVersion"),
  };
};
