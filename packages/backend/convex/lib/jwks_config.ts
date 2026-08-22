export type JwksRuntimeMode = "dynamic" | "static";

type Environment = Record<string, string | undefined>;

export type StaticJwksKeyMetadata = {
  id: string;
  publicKey: string;
  createdAt: number;
};

export type StaticJwksMetadata = {
  keys: StaticJwksKeyMetadata[];
  signingKeyId: string;
};

const INVALID_STATIC_JWKS =
  "JWKS is invalid. Refusing to start with an ambiguous static signing keyset.";

const parseCreatedAt = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(INVALID_STATIC_JWKS);
};

const assertRsaPublicKey = (value: string) => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const privateFields = ["d", "p", "q", "dp", "dq", "qi", "oth"];
    if (
      parsed.kty !== "RSA" ||
      typeof parsed.n !== "string" ||
      parsed.n.length === 0 ||
      typeof parsed.e !== "string" ||
      parsed.e.length === 0 ||
      privateFields.some((field) => field in parsed)
    ) {
      throw new Error(INVALID_STATIC_JWKS);
    }
  } catch {
    throw new Error(INVALID_STATIC_JWKS);
  }
};

/**
 * Validate a legacy static keyset without returning or inspecting private-key
 * contents. Callers only receive public metadata needed for migration checks.
 */
export const inspectStaticJwks = (
  raw: string | undefined,
): StaticJwksMetadata | null => {
  if (!raw?.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(INVALID_STATIC_JWKS);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(INVALID_STATIC_JWKS);
  }

  const ids = new Set<string>();
  const createdAtValues = new Set<number>();
  const keys = parsed.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error(INVALID_STATIC_JWKS);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.publicKey !== "string" ||
      record.publicKey.length === 0 ||
      typeof record.privateKey !== "string" ||
      record.privateKey.length === 0 ||
      (record.alg !== undefined && record.alg !== "RS256")
    ) {
      throw new Error(INVALID_STATIC_JWKS);
    }
    if (ids.has(record.id)) {
      throw new Error(INVALID_STATIC_JWKS);
    }
    ids.add(record.id);
    assertRsaPublicKey(record.publicKey);
    const createdAt = parseCreatedAt(record.createdAt);
    if (createdAtValues.has(createdAt)) {
      throw new Error(INVALID_STATIC_JWKS);
    }
    createdAtValues.add(createdAt);
    return {
      id: record.id,
      publicKey: record.publicKey,
      createdAt,
    };
  });

  const signingKey = [...keys].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!signingKey) {
    throw new Error(INVALID_STATIC_JWKS);
  }
  return { keys, signingKeyId: signingKey.id };
};

/**
 * `STELLA_JWKS_MODE` is an additive migration switch. With no switch, Stella
 * preserves the old behavior: use `JWKS` when present, otherwise use the
 * database-backed endpoint. Dynamic mode deliberately leaves a dormant JWKS
 * value untouched so rollback never requires printing or copying it.
 */
export const resolveJwksRuntimeConfig = (
  environment: Environment = process.env,
): { mode: JwksRuntimeMode; staticJwks?: string } => {
  const requestedMode = environment.STELLA_JWKS_MODE?.trim().toLowerCase();
  if (
    requestedMode &&
    requestedMode !== "dynamic" &&
    requestedMode !== "static"
  ) {
    throw new Error(
      "STELLA_JWKS_MODE must be either 'dynamic' or 'static'. Refusing to guess.",
    );
  }

  const rawStaticJwks = environment.JWKS?.trim();
  if (requestedMode === "dynamic") {
    return { mode: "dynamic" };
  }
  if (requestedMode === "static" && !rawStaticJwks) {
    throw new Error("STELLA_JWKS_MODE=static requires JWKS.");
  }
  if (rawStaticJwks) {
    inspectStaticJwks(rawStaticJwks);
    return { mode: "static", staticJwks: rawStaticJwks };
  }
  return { mode: "dynamic" };
};

export const assertDynamicJwksMode = (config: { mode: JwksRuntimeMode }) => {
  if (config.mode !== "dynamic") {
    throw new Error(
      "JWKS rotation is disabled while static signing is active. Complete the documented dynamic-mode preflight first.",
    );
  }
};
