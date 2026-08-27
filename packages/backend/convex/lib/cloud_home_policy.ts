import { ConvexError } from "convex/values";

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const CLOUD_HOME_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CLOUD_HOME_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const CLOUD_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const CLOUD_HOME_MAX_DOCUMENTS = 100;
export const CLOUD_HOME_WRITE_INTENT_TTL_MS = 15 * 60_000;
export const CLOUD_DREAM_CLAIM_TTL_MS = 5 * 60_000;
export const CLOUD_SKILL_MAX_FILES = 256;
export const CLOUD_SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const CLOUD_SKILL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type CloudMemoryDocumentKind =
  | "memory"
  | "profile"
  | "memory_map"
  | "core_memory"
  | "personality"
  | "imported_markdown"
  | "user_markdown"
  | "archive";

export type CloudMemoryWriter =
  | "remember"
  | "dream"
  | "desktop_sync"
  | "mobile_sync"
  | "user_edit"
  | "owner_migration"
  | "system_seed";

const CANONICAL_MEMORY_DOCUMENTS = {
  "MEMORY.md": {
    kind: "memory",
    displayPath: "~/.stella/memories/MEMORY.md",
    maxBytes: 256 * 1024,
  },
  "memories/profile.md": {
    kind: "profile",
    displayPath: "~/.stella/memories/profile.md",
    maxBytes: 32 * 1024,
  },
  "memories/memory_map.md": {
    kind: "memory_map",
    displayPath: "~/.stella/memories/memory_map.md",
    maxBytes: 32 * 1024,
  },
  "core-memory.md": {
    kind: "core_memory",
    displayPath: "~/.stella/core-memory.md",
    maxBytes: 64 * 1024,
  },
  "PERSONALITY.md": {
    kind: "personality",
    displayPath: "~/.stella/PERSONALITY.md",
    maxBytes: 64 * 1024,
  },
} as const satisfies Record<
  string,
  { kind: CloudMemoryDocumentKind; displayPath: string; maxBytes: number }
>;

export type NormalizedCloudMemoryDocument = {
  name: string;
  displayPath: string;
  kind: CloudMemoryDocumentKind;
  maxBytes: number;
};

const assertSafeRelativeMarkdownPath = (value: string): string => {
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ConvexError("Invalid cloud-home Markdown path.");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.length > 96,
    ) ||
    !normalized.toLocaleLowerCase().endsWith(".md")
  ) {
    throw new ConvexError("Invalid cloud-home Markdown path.");
  }
  return normalized;
};

export const normalizeCloudMemoryDocument = (
  rawName: string,
  requestedKind: CloudMemoryDocumentKind,
): NormalizedCloudMemoryDocument => {
  const name = rawName.normalize("NFC").trim().replace(/^\.\//u, "");
  const canonical = (
    CANONICAL_MEMORY_DOCUMENTS as Record<
      string,
      {
        kind: CloudMemoryDocumentKind;
        displayPath: string;
        maxBytes: number;
      }
    >
  )[name];
  if (canonical) {
    if (canonical.kind !== requestedKind) {
      throw new ConvexError(`Cloud-home document kind does not match ${name}.`);
    }
    return { name, ...canonical };
  }
  const safe = assertSafeRelativeMarkdownPath(name);
  if (safe.startsWith("imports/")) {
    if (requestedKind !== "imported_markdown") {
      throw new ConvexError(
        "Imported documents require imported_markdown kind.",
      );
    }
    const segments = safe.split("/");
    if (segments.length < 3) {
      throw new ConvexError(
        "Imported documents require a source and Markdown file name.",
      );
    }
    return {
      name: safe,
      displayPath: `~/.stella/${safe}`,
      kind: requestedKind,
      maxBytes: 512 * 1024,
    };
  }
  if (safe.startsWith("markdown/")) {
    if (requestedKind !== "user_markdown") {
      throw new ConvexError("User Markdown requires user_markdown kind.");
    }
    return {
      name: safe,
      displayPath: `~/.stella/${safe}`,
      kind: requestedKind,
      maxBytes: 512 * 1024,
    };
  }
  if (safe.startsWith("archive/")) {
    if (requestedKind !== "archive") {
      throw new ConvexError("Dream archive documents require archive kind.");
    }
    return {
      name: safe,
      displayPath: `~/.stella/memories/${safe}`,
      kind: requestedKind,
      maxBytes: 512 * 1024,
    };
  }
  throw new ConvexError("Unsupported cloud-home Markdown path.");
};

export const legacyCloudMemoryName = (name: string): string | null => {
  if (name === "memories/profile.md") return "profile.md";
  if (name === "memories/memory_map.md") return "memory_map.md";
  return null;
};

export const assertSha256 = (value: string): string => {
  const normalized = value.trim().toLocaleLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new ConvexError("Expected a lowercase SHA-256 digest.");
  }
  return normalized;
};

export const assertIdempotencyKey = (value: string): string => {
  const normalized = value.trim();
  if (!CLOUD_HOME_IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new ConvexError("Invalid cloud-home idempotency key.");
  }
  return normalized;
};

export const assertOpaqueCloudHomeId = (
  value: string,
  label: string,
): string => {
  const normalized = value.trim();
  if (!CLOUD_HOME_OPAQUE_ID_PATTERN.test(normalized)) {
    throw new ConvexError(`Invalid ${label}.`);
  }
  return normalized;
};

export const assertCloudHomeSize = (
  sizeBytes: number,
  maxBytes: number,
): number => {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > maxBytes
  ) {
    throw new ConvexError(
      `Cloud-home content must be between 0 and ${maxBytes} bytes.`,
    );
  }
  return sizeBytes;
};

export const normalizeSkillId = (value: string): string => {
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (!CLOUD_SKILL_ID_PATTERN.test(normalized)) {
    throw new ConvexError(
      "Skill ids must be lowercase letters, numbers, and hyphens.",
    );
  }
  return normalized;
};

export const normalizeSkillFilePath = (value: string): string => {
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ConvexError("Invalid skill file path.");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.length > 96,
    )
  ) {
    throw new ConvexError("Invalid skill file path.");
  }
  return normalized;
};

export const memoryDocumentId = async (
  ownerId: string,
  name: string,
): Promise<string> =>
  `memdoc-${(await sha256Hex(`${ownerId}\0${name}`)).slice(0, 40)}`;

export const memoryVersionId = async (args: {
  ownerId: string;
  documentId: string;
  idempotencyKey: string;
  sha256: string;
}): Promise<string> =>
  `memver-${(
    await sha256Hex(
      `${args.ownerId}\0${args.documentId}\0${args.idempotencyKey}\0${args.sha256}`,
    )
  ).slice(0, 40)}`;

export const cloudSkillId = async (
  ownerId: string,
  name: string,
): Promise<string> =>
  `skill-${(await sha256Hex(`${ownerId}\0${name}`)).slice(0, 40)}`;

export const cloudSkillVersionId = async (args: {
  ownerId: string;
  skillId: string;
  idempotencyKey: string;
  treeSha256: string;
}): Promise<string> =>
  `skillver-${(
    await sha256Hex(
      `${args.ownerId}\0${args.skillId}\0${args.idempotencyKey}\0${args.treeSha256}`,
    )
  ).slice(0, 40)}`;

export const agentHomeOwnerHash = async (ownerId: string): Promise<string> =>
  await sha256Hex(ownerId);

export const agentHomeGenerationHash = async (
  ownerGeneration: string,
): Promise<string> => await sha256Hex(ownerGeneration);

export const agentHomeGenerationR2Prefix = async (args: {
  ownerId: string;
  ownerGeneration: string;
}): Promise<string> => {
  const [ownerHash, generationHash] = await Promise.all([
    agentHomeOwnerHash(args.ownerId),
    agentHomeGenerationHash(args.ownerGeneration),
  ]);
  return `agent-home/${ownerHash}/generations/${generationHash}/`;
};

export const memoryVersionR2Key = async (args: {
  ownerId: string;
  ownerGeneration: string;
  documentId: string;
  versionId: string;
  sha256: string;
}): Promise<string> =>
  `${await agentHomeGenerationR2Prefix(args)}memory-versions/${args.documentId}/${args.versionId}/${args.sha256}.md`;

export const dreamInboxR2Key = async (args: {
  ownerId: string;
  ownerGeneration: string;
  inboxId: string;
  sourceRevision: number;
  sha256: string;
}): Promise<string> =>
  `${await agentHomeGenerationR2Prefix(args)}dream-inbox/${args.inboxId}/${args.sourceRevision}-${args.sha256}.json`;

export const dreamInboxId = async (
  ownerId: string,
  sourceKey: string,
): Promise<string> =>
  `dream-${(await sha256Hex(`${ownerId}\0${sourceKey}`)).slice(0, 40)}`;

export const skillManifestR2Key = async (args: {
  ownerId: string;
  ownerGeneration: string;
  skillId: string;
  versionId: string;
}): Promise<string> =>
  `${await agentHomeGenerationR2Prefix(args)}skills/${args.skillId}/${args.versionId}/manifest.json`;

export const skillFileR2Key = async (args: {
  ownerId: string;
  ownerGeneration: string;
  skillId: string;
  versionId: string;
  path: string;
}): Promise<string> =>
  `${await agentHomeGenerationR2Prefix(args)}skills/${args.skillId}/${args.versionId}/files/${normalizeSkillFilePath(args.path)}`;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
