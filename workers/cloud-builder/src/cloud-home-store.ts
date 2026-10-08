import {
  builtinCloudAppSkill,
  CLOUD_APP_SKILL_ID,
  cloudAppSkillSource,
} from "./builtin-cloud-app-skill.js";
import type { BackendError, RpcResponse } from "@stella/contracts/backend/protocol";
import { sha256BytesHex, sha256Hex } from "./hash.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SKILL_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\\)(?!.*(?:^|\/)\.)[^\u0000-\u001f\u007f]+$/u;

export const CLOUD_SKILL_RUNTIME_MAX_SKILLS = 20;
export const CLOUD_SKILL_RUNTIME_MAX_FILES = 1_000;
export const CLOUD_SKILL_RUNTIME_MAX_BYTES = 50 * 1024 * 1024;

/**
 * One cloud-home control operation (`memory.context`, `skills.*`) on the owner's
 * object: `OwnerGate.homeControl` from a Worker route or another object, or
 * the gate's own `homeControl` from inside it.
 */
export type HomeControl = (
  op: string,
  body: { ownerGeneration: string } & Record<string, unknown>,
) => Promise<RpcResponse>;

/** `HomeControl` through the owner's gate, for code outside the gate. */
export const gateHomeControl =
  (gates: Cloudflare.Env["OWNER_GATES"], ownerId: string): HomeControl =>
  async (op, body) =>
    await gates.getByName(ownerId).homeControl({ op, body });

export type CloudHomeEndpoint = {
  control: HomeControl;
  ownerId: string;
  ownerGeneration: string;
  /**
   * Proves that the caller still owns a registered worker-side owner activity
   * lease. The lease itself must remain held until the enclosing publication
   * returns; purge waits for that lease before sweeping the owner prefix.
   */
  assertExternalWrite?: () => Promise<void>;
};

export type CloudMemoryPreference = {
  ownerGeneration: string;
  memoryEpoch: string;
  memoryEnabled: boolean;
  revision: number;
  updatedAt: number;
};

export type CloudSkillFileDescriptor = {
  path: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
};

export type CloudSkillCatalogEntry = {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  source:
    | "bundled"
    | "desktop_sync"
    | "mobile_sync"
    | "cloud_created"
    | "owner_migration";
  availability: "orchestrator" | "general" | "both";
  revision: number;
  versionId: string;
  manifestSha256: string;
  treeSha256: string;
  fileCount: number;
  totalSizeBytes: number;
  files: CloudSkillFileDescriptor[];
  updatedAt: number;
};

export type CloudSkillCatalogSnapshot = {
  ownerGeneration: string;
  agentType: "orchestrator" | "general";
  loadedAt: number;
  entries: readonly CloudSkillCatalogEntry[];
};

export type CloudSkillUploadFile = {
  path: string;
  bytes: Uint8Array;
  contentType: string;
};

type SkillWriteReceipt = {
  intentId: string;
  status: "prepared" | "committed" | "conflict" | "aborted";
  ownerGeneration: string;
  skillId: string;
  slug: string;
  name: string;
  description: string;
  source: CloudSkillCatalogEntry["source"];
  availability: CloudSkillCatalogEntry["availability"];
  baseRevision: number;
  baseVersionId?: string;
  versionId: string;
  nextRevision: number;
  manifestR2Key: string;
  manifestSha256: string;
  treeSha256: string;
  fileCount: number;
  totalSizeBytes: number;
  files: CloudSkillFileDescriptor[];
  expiresAt: number;
  conflictRevision?: number;
  conflictVersionId?: string;
};

type ImmutableObjectMetadata = {
  sha256: string;
  versionId: string;
  ownerHash: string;
  kind: "skill-manifest" | "skill-file";
};

export class CloudHomeProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloudHomeProtocolError";
  }
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudHomeProtocolError(`${label} was not an object.`);
  }
  return value as Record<string, unknown>;
};

const exactString = (value: unknown, label: string, max = 1_024): string => {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new CloudHomeProtocolError(`${label} was invalid.`);
  }
  return value;
};

const exactInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CloudHomeProtocolError(`${label} was invalid.`);
  }
  return value as number;
};

const exactBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") {
    throw new CloudHomeProtocolError(`${label} was invalid.`);
  }
  return value;
};

const exactSha256 = (value: unknown, label: string): string => {
  const digest = exactString(value, label, 64);
  if (!SHA256_PATTERN.test(digest)) {
    throw new CloudHomeProtocolError(`${label} was invalid.`);
  }
  return digest;
};

const safeSkillPath = (value: unknown): string => {
  const path = exactString(value, "Skill file path", 240).normalize("NFC");
  if (
    !SAFE_SKILL_PATH.test(path) ||
    path.endsWith("/") ||
    path.split("/").some((segment) => !segment || segment.length > 96)
  ) {
    throw new CloudHomeProtocolError("Skill file path was unsafe.");
  }
  return path;
};

const cloneBytes = (bytes: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const bodyBytes = async (object: R2ObjectBody): Promise<Uint8Array> =>
  new Uint8Array(await object.arrayBuffer());

const metadataMatches = (
  object: R2Object,
  metadata: ImmutableObjectMetadata,
): boolean =>
  object.customMetadata?.stellaSha256 === metadata.sha256 &&
  object.customMetadata?.stellaVersionId === metadata.versionId &&
  object.customMetadata?.stellaOwnerHash === metadata.ownerHash &&
  object.customMetadata?.stellaKind === metadata.kind;

const parseMemoryPreference = (value: unknown): CloudMemoryPreference => {
  const row = asRecord(value, "Cloud memory preference");
  return {
    ownerGeneration: exactString(row.ownerGeneration, "Owner generation"),
    memoryEpoch: exactString(row.memoryEpoch, "Memory epoch"),
    memoryEnabled: exactBoolean(row.memoryEnabled, "Memory enabled"),
    revision: exactInteger(row.revision, "Memory preference revision"),
    updatedAt: exactInteger(row.updatedAt, "Memory preference update time"),
  };
};

const parseSkillFile = (value: unknown): CloudSkillFileDescriptor => {
  const row = asRecord(value, "Skill file");
  return {
    path: safeSkillPath(row.path),
    r2Key: exactString(row.r2Key, "Skill object key", 1_024),
    sha256: exactSha256(row.sha256, "Skill file digest"),
    sizeBytes: exactInteger(row.sizeBytes, "Skill file size"),
    contentType: exactString(row.contentType, "Skill content type", 120),
  };
};

const parseSkillEntry = (value: unknown): CloudSkillCatalogEntry => {
  const row = asRecord(value, "Skill catalog entry");
  if (!Array.isArray(row.files)) {
    throw new CloudHomeProtocolError("Skill catalog omitted its exact files.");
  }
  const files = row.files.map(parseSkillFile);
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length || !paths.has("SKILL.md")) {
    throw new CloudHomeProtocolError("Skill catalog file set was invalid.");
  }
  const fileCount = exactInteger(row.fileCount, "Skill file count");
  const totalSizeBytes = exactInteger(row.totalSizeBytes, "Skill total size");
  if (
    fileCount !== files.length ||
    totalSizeBytes !== files.reduce((total, file) => total + file.sizeBytes, 0)
  ) {
    throw new CloudHomeProtocolError("Skill catalog totals were inconsistent.");
  }
  const source = exactString(
    row.source,
    "Skill source",
  ) as CloudSkillCatalogEntry["source"];
  if (
    ![
      "bundled",
      "desktop_sync",
      "mobile_sync",
      "cloud_created",
      "owner_migration",
    ].includes(source)
  ) {
    throw new CloudHomeProtocolError("Skill source was invalid.");
  }
  const availability = exactString(
    row.availability,
    "Skill availability",
  ) as CloudSkillCatalogEntry["availability"];
  if (!["orchestrator", "general", "both"].includes(availability)) {
    throw new CloudHomeProtocolError("Skill availability was invalid.");
  }
  return {
    skillId: exactString(row.skillId, "Skill id"),
    slug: exactString(row.slug, "Skill slug", 63),
    name: exactString(row.name, "Skill name", 120),
    description: exactString(row.description, "Skill description", 1_000),
    source,
    availability,
    revision: exactInteger(row.revision, "Skill revision"),
    versionId: exactString(row.versionId, "Skill version id"),
    manifestSha256: exactSha256(row.manifestSha256, "Skill manifest digest"),
    treeSha256: exactSha256(row.treeSha256, "Skill tree digest"),
    fileCount,
    totalSizeBytes,
    files,
    updatedAt: exactInteger(row.updatedAt, "Skill update time"),
  };
};

export const skillTreeSha256 = async (
  files: readonly Pick<
    CloudSkillUploadFile,
    "path" | "bytes" | "contentType"
  >[],
): Promise<string> => {
  const rows = await Promise.all(
    files.map(async (file) => {
      const path = safeSkillPath(file.path);
      const contentType = exactString(
        file.contentType.trim(),
        "Skill content type",
        120,
      );
      const bytes = cloneBytes(file.bytes);
      return {
        path,
        sha256: await sha256BytesHex(bytes),
        sizeBytes: bytes.byteLength,
        contentType,
      };
    }),
  );
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return await sha256Hex(
    rows
      .map(
        (file) =>
          `${file.path}\0${file.sha256}\0${file.sizeBytes}\0${file.contentType}\n`,
      )
      .join(""),
  );
};

/** HTTP status a Worker route reports for a refused control operation. */
const controlStatus = (error: BackendError): number => {
  if (error.reason?.includes("STALE") || error.reason === "owner_generation_stale") return 412;
  switch (error.code) {
    case "CONFLICT":
      return 409;
    case "NOT_FOUND":
      return 404;
    case "RATE_LIMITED":
      return 429;
    case "UNAVAILABLE":
    case "INTERNAL":
      return 503;
    default:
      return 400;
  }
};

const controlError = (error: BackendError): CloudHomeProtocolError =>
  new CloudHomeProtocolError(error.message, controlStatus(error), error.reason ?? error.code);

export class CloudHomeStore {
  private ownerHashPromise?: Promise<string>;
  private ownerGenerationHashPromise?: Promise<string>;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly endpoint: CloudHomeEndpoint,
  ) {}

  private ownerHash(): Promise<string> {
    this.ownerHashPromise ??= sha256Hex(this.endpoint.ownerId);
    return this.ownerHashPromise;
  }

  private ownerGenerationHash(): Promise<string> {
    this.ownerGenerationHashPromise ??= sha256Hex(
      this.endpoint.ownerGeneration,
    );
    return this.ownerGenerationHashPromise;
  }

  private async generationPrefix(): Promise<string> {
    return `agent-home/${await this.ownerHash()}/generations/${await this.ownerGenerationHash()}/`;
  }

  private async assertOwnedKey(key: string): Promise<void> {
    const prefix = `agent-home/${await this.ownerHash()}/`;
    if (!key.startsWith(prefix) || key.length <= prefix.length) {
      throw new CloudHomeProtocolError(
        "Cloud-home metadata referenced another owner namespace.",
      );
    }
  }

  private async control(op: string, body: Record<string, unknown>) {
    const response = await this.endpoint.control(op, {
      ...body,
      ownerGeneration: this.endpoint.ownerGeneration,
    });
    if (!response.ok) throw controlError(response.error);
    return response.value;
  }

  private async verifyObject(
    key: string,
    expected: { bytes?: Uint8Array; sha256: string; sizeBytes: number },
    metadata?: ImmutableObjectMetadata,
  ): Promise<Uint8Array> {
    await this.assertOwnedKey(key);
    const object = await this.bucket.get(key);
    if (!object) {
      throw new CloudHomeProtocolError("Cloud-home object is missing.");
    }
    if (
      object.size !== expected.sizeBytes ||
      (metadata && !metadataMatches(object, metadata))
    ) {
      throw new CloudHomeProtocolError(
        "Cloud-home object metadata contradicts its receipt.",
      );
    }
    const bytes = await bodyBytes(object);
    if (
      bytes.byteLength !== expected.sizeBytes ||
      (await sha256BytesHex(bytes)) !== expected.sha256
    ) {
      throw new CloudHomeProtocolError(
        "Cloud-home object bytes failed integrity verification.",
      );
    }
    if (
      expected.bytes &&
      (expected.bytes.byteLength !== bytes.byteLength ||
        expected.bytes.some((byte, index) => bytes[index] !== byte))
    ) {
      throw new CloudHomeProtocolError(
        "An immutable cloud-home key already contains different bytes.",
      );
    }
    return bytes;
  }

  private async putImmutable(
    key: string,
    bytes: Uint8Array,
    metadata: ImmutableObjectMetadata,
    contentType: string,
  ): Promise<void> {
    await this.assertOwnedKey(key);
    if (
      bytes.byteLength < 0 ||
      (await sha256BytesHex(bytes)) !== metadata.sha256
    ) {
      throw new CloudHomeProtocolError(
        "Upload bytes do not match their digest.",
      );
    }
    const existing = await this.bucket.head(key);
    if (!existing) {
      if (!this.endpoint.assertExternalWrite) {
        throw new CloudHomeProtocolError(
          "Cloud-home publication requires an owner activity lease.",
        );
      }
      // This is deliberately the last await before PUT. Owner generation
      // fencing alone cannot make an external R2 write transactional with a
      // reset. The still-held worker lease makes purge wait for this operation
      // before its exhaustive owner-prefix sweep.
      await this.endpoint.assertExternalWrite();
      await this.bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
        customMetadata: {
          stellaSha256: metadata.sha256,
          stellaVersionId: metadata.versionId,
          stellaOwnerHash: metadata.ownerHash,
          stellaKind: metadata.kind,
        },
      });
    }
    await this.verifyObject(
      key,
      { bytes, sha256: metadata.sha256, sizeBytes: bytes.byteLength },
      metadata,
    );
  }

  /**
   * The memory policy a turn runs under. The memory itself is world files
   * (`world-memory.ts`), read by the turn, not by this store.
   */
  async getMemoryContext(): Promise<{ preference: CloudMemoryPreference }> {
    const preference = parseMemoryPreference(
      await this.control("memory.context", {}),
    );
    if (preference.ownerGeneration !== this.endpoint.ownerGeneration) {
      throw new CloudHomeProtocolError("Cloud memory context is stale.");
    }
    return { preference };
  }

  async loadSkillCatalog(
    agentType: "orchestrator" | "general",
  ): Promise<CloudSkillCatalogSnapshot> {
    const payload = await this.control("skills.catalog", { agentType });
    if (!Array.isArray(payload)) {
      throw new CloudHomeProtocolError("Cloud skill catalog was invalid.");
    }
    const parsed = payload
      .map(parseSkillEntry)
      .filter((entry) => entry.slug !== "create-stella-cloud-app");
    const identities = new Set<string>();
    const slugs = new Set<string>();
    const entries: CloudSkillCatalogEntry[] = [];
    let fileCount = 0;
    let totalSizeBytes = 0;
    for (const entry of parsed) {
      const identity = `${entry.skillId}\0${entry.versionId}`;
      if (identities.has(identity) || slugs.has(entry.slug)) {
        throw new CloudHomeProtocolError(
          "Skill catalog contained duplicate mirrored identities.",
        );
      }
      identities.add(identity);
      slugs.add(entry.slug);
      if (
        entries.length >= CLOUD_SKILL_RUNTIME_MAX_SKILLS ||
        fileCount + entry.fileCount > CLOUD_SKILL_RUNTIME_MAX_FILES ||
        totalSizeBytes + entry.totalSizeBytes > CLOUD_SKILL_RUNTIME_MAX_BYTES
      ) {
        continue;
      }
      await Promise.all(
        entry.files.map((file) => this.assertOwnedKey(file.r2Key)),
      );
      entries.push(entry);
      fileCount += entry.fileCount;
      totalSizeBytes += entry.totalSizeBytes;
    }
    return Object.freeze({
      ownerGeneration: this.endpoint.ownerGeneration,
      agentType,
      loadedAt: Date.now(),
      entries: Object.freeze(
        [await builtinCloudAppSkill(), ...entries].map((entry) =>
          Object.freeze(entry),
        ),
      ),
    });
  }

  searchSkills(
    snapshot: CloudSkillCatalogSnapshot,
    query: string,
    limit = 8,
  ): CloudSkillCatalogEntry[] {
    this.assertSnapshot(snapshot);
    const terms = query
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 12);
    return snapshot.entries
      .map((entry) => {
        const text =
          `${entry.slug} ${entry.name} ${entry.description}`.toLocaleLowerCase();
        return {
          entry,
          score: terms.reduce(
            (score, term) => score + (text.includes(term) ? 1 : 0),
            0,
          ),
        };
      })
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.updatedAt - a.entry.updatedAt ||
          a.entry.slug.localeCompare(b.entry.slug),
      )
      .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
      .map(({ entry }) => entry);
  }

  async readSkillFile(
    snapshot: CloudSkillCatalogSnapshot,
    skillId: string,
    path: string,
  ): Promise<Uint8Array> {
    this.assertSnapshot(snapshot);
    const safePath = safeSkillPath(path);
    const entry = snapshot.entries.find((skill) => skill.skillId === skillId);
    const file = entry?.files.find((candidate) => candidate.path === safePath);
    if (!entry || !file) {
      throw new CloudHomeProtocolError(
        "That file is not in the pinned mirrored skill version.",
      );
    }
    if (entry.skillId === CLOUD_APP_SKILL_ID && safePath === "SKILL.md")
      return new TextEncoder().encode(cloudAppSkillSource);
    return await this.verifyObject(file.r2Key, {
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    });
  }

  async readSkillText(
    snapshot: CloudSkillCatalogSnapshot,
    skillId: string,
    path: string,
  ): Promise<string> {
    return textDecoder.decode(
      await this.readSkillFile(snapshot, skillId, path),
    );
  }

  async publishSkill(args: {
    slug: string;
    name: string;
    description: string;
    source: CloudSkillCatalogEntry["source"];
    availability: CloudSkillCatalogEntry["availability"];
    expectedRevision: number;
    /** Optional receipt bytes from a caller; must equal our canonical manifest. */
    manifestBytes?: Uint8Array;
    files: CloudSkillUploadFile[];
    idempotencyKey: string;
  }): Promise<SkillWriteReceipt> {
    const files = await Promise.all(
      args.files.map(async (file) => ({
        path: safeSkillPath(file.path),
        bytes: cloneBytes(file.bytes),
        contentType: exactString(
          file.contentType.trim(),
          "Skill content type",
          120,
        ),
        sha256: await sha256BytesHex(file.bytes),
        sizeBytes: file.bytes.byteLength,
      })),
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (
      new Set(files.map((file) => file.path)).size !== files.length ||
      !files.some((file) => file.path === "SKILL.md")
    ) {
      throw new CloudHomeProtocolError(
        "Skill package needs one unique SKILL.md file.",
      );
    }
    const skillMarkdown = files.find((file) => file.path === "SKILL.md")!;
    const skillText = utf8Text(skillMarkdown.bytes);
    const frontmatter = skillText.match(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
    )?.[1];
    if (
      !frontmatter ||
      !/^name\s*:\s*\S+/mu.test(frontmatter) ||
      !/^description\s*:\s*\S+/mu.test(frontmatter)
    ) {
      throw new CloudHomeProtocolError(
        "SKILL.md needs bounded name and description frontmatter.",
      );
    }
    const treeSha256 = await skillTreeSha256(files);
    const canonicalManifest = `${JSON.stringify({
      schemaVersion: 1,
      slug: args.slug,
      name: args.name,
      description: args.description,
      source: args.source,
      availability: args.availability,
      treeSha256,
      files: files.map(({ path, sha256, sizeBytes, contentType }) => ({
        path,
        sha256,
        sizeBytes,
        contentType,
      })),
    })}\n`;
    const manifestBytes = utf8Bytes(canonicalManifest);
    if (args.manifestBytes) {
      const supplied = cloneBytes(args.manifestBytes);
      if (
        supplied.byteLength !== manifestBytes.byteLength ||
        supplied.some((byte, index) => byte !== manifestBytes[index])
      ) {
        throw new CloudHomeProtocolError(
          "Supplied skill manifest was not the canonical package manifest.",
        );
      }
    }
    const manifestSha256 = await sha256BytesHex(manifestBytes);
    const receiptRow = asRecord(
      await this.control("skills.begin", {
        slug: args.slug,
        name: args.name,
        description: args.description,
        source: args.source,
        availability: args.availability,
        expectedRevision: args.expectedRevision,
        manifestSha256,
        treeSha256,
        files: files.map(({ path, sha256, sizeBytes, contentType }) => ({
          path,
          sha256,
          sizeBytes,
          contentType,
        })),
        idempotencyKey: args.idempotencyKey,
      }),
      "Skill upload receipt",
    );
    const prepared = this.parseSkillWriteReceipt(receiptRow);
    if (prepared.status === "conflict" || prepared.status === "aborted") {
      return prepared;
    }
    if (
      prepared.ownerGeneration !== this.endpoint.ownerGeneration ||
      prepared.manifestSha256 !== manifestSha256 ||
      prepared.treeSha256 !== treeSha256 ||
      prepared.files.length !== files.length
    ) {
      throw new CloudHomeProtocolError(
        "Skill reservation contradicted the requested package.",
      );
    }
    const ownerHash = await this.ownerHash();
    await this.putImmutable(
      prepared.manifestR2Key,
      manifestBytes,
      {
        sha256: manifestSha256,
        versionId: prepared.versionId,
        ownerHash,
        kind: "skill-manifest",
      },
      "application/json; charset=utf-8",
    );
    for (const reserved of prepared.files) {
      const input = files.find((file) => file.path === reserved.path);
      if (
        !input ||
        input.sha256 !== reserved.sha256 ||
        input.sizeBytes !== reserved.sizeBytes ||
        input.contentType !== reserved.contentType
      ) {
        throw new CloudHomeProtocolError(
          "Reserved skill files contradicted the requested package.",
        );
      }
      await this.putImmutable(
        reserved.r2Key,
        input.bytes,
        {
          sha256: input.sha256,
          versionId: prepared.versionId,
          ownerHash,
          kind: "skill-file",
        },
        input.contentType,
      );
    }
    return this.parseSkillWriteReceipt(
      asRecord(
        await this.control("skills.commit", {
          intentId: prepared.intentId,
          versionId: prepared.versionId,
          manifestR2Key: prepared.manifestR2Key,
          manifestSha256,
          treeSha256,
        }),
        "Skill commit receipt",
      ),
    );
  }

  private assertSnapshot(snapshot: CloudSkillCatalogSnapshot): void {
    if (
      snapshot.ownerGeneration !== this.endpoint.ownerGeneration ||
      !["orchestrator", "general"].includes(snapshot.agentType) ||
      !Array.isArray(snapshot.entries)
    ) {
      throw new CloudHomeProtocolError("Skill catalog snapshot is stale.");
    }
  }

  private parseSkillWriteReceipt(
    row: Record<string, unknown>,
  ): SkillWriteReceipt {
    const status = exactString(
      row.status,
      "Skill receipt status",
    ) as SkillWriteReceipt["status"];
    if (!["prepared", "committed", "conflict", "aborted"].includes(status)) {
      throw new CloudHomeProtocolError("Skill receipt status was invalid.");
    }
    if (!Array.isArray(row.files)) {
      throw new CloudHomeProtocolError("Skill receipt omitted files.");
    }
    const files = row.files.map(parseSkillFile);
    return {
      intentId: exactString(row.intentId, "Skill intent id"),
      status,
      ownerGeneration: exactString(row.ownerGeneration, "Owner generation"),
      skillId: exactString(row.skillId, "Skill id"),
      slug: exactString(row.slug, "Skill slug", 63),
      name: exactString(row.name, "Skill name", 120),
      description: exactString(row.description, "Skill description", 1_000),
      source: exactString(
        row.source,
        "Skill source",
      ) as SkillWriteReceipt["source"],
      availability: exactString(
        row.availability,
        "Skill availability",
      ) as SkillWriteReceipt["availability"],
      baseRevision: exactInteger(row.baseRevision, "Skill base revision"),
      ...(row.baseVersionId === undefined
        ? {}
        : {
            baseVersionId: exactString(
              row.baseVersionId,
              "Skill base version id",
            ),
          }),
      versionId: exactString(row.versionId, "Skill version id"),
      nextRevision: exactInteger(row.nextRevision, "Skill next revision"),
      manifestR2Key: exactString(
        row.manifestR2Key,
        "Skill manifest object key",
        1_024,
      ),
      manifestSha256: exactSha256(row.manifestSha256, "Skill manifest digest"),
      treeSha256: exactSha256(row.treeSha256, "Skill tree digest"),
      fileCount: exactInteger(row.fileCount, "Skill file count"),
      totalSizeBytes: exactInteger(row.totalSizeBytes, "Skill total size"),
      files,
      expiresAt: exactInteger(row.expiresAt, "Skill intent expiry"),
      ...(row.conflictRevision === undefined
        ? {}
        : {
            conflictRevision: exactInteger(
              row.conflictRevision,
              "Skill conflict revision",
            ),
          }),
      ...(row.conflictVersionId === undefined
        ? {}
        : {
            conflictVersionId: exactString(
              row.conflictVersionId,
              "Skill conflict version id",
            ),
          }),
    };
  }
}

export const utf8Bytes = (value: string): Uint8Array =>
  textEncoder.encode(value);

export const utf8Text = (value: Uint8Array): string =>
  textDecoder.decode(value);
