import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  STELLA_RENDERER_CSP_META,
  stellaRendererHeadEnd,
} from "@stella/contracts/desktop/renderer-security";

const fsPromises = fs.promises;

export const RENDERER_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RENDERER_ARTIFACT_STATE_SCHEMA_VERSION = 1 as const;

export const DEFAULT_RENDERER_ARTIFACT_LIMITS = {
  maxFiles: 4_096,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RELATIVE_PATH_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type RendererEntryName = "full" | "mini" | "overlay" | "pet";

export interface RendererArtifactFile {
  path: string;
  url: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface RendererArtifactManifest {
  schemaVersion: typeof RENDERER_ARTIFACT_SCHEMA_VERSION;
  buildId: string;
  version: string;
  artifactPrefix: string;
  bridgeAbi: number;
  minShellVersion: string;
  entries: Record<RendererEntryName, string>;
  files: RendererArtifactFile[];
  artifactSha256: string;
  size: number;
}

export interface RendererArtifactRef {
  buildId: string;
  version: string;
  bridgeAbi: number;
  artifactSha256: string;
  manifestSha256: string;
  installedAt: string;
}

export interface RendererArtifactQuarantine {
  artifactSha256: string;
  buildId: string;
  quarantinedAt: string;
  reason: string;
}

export interface RendererArtifactState {
  schemaVersion: typeof RENDERER_ARTIFACT_STATE_SCHEMA_VERSION;
  accountScope?: string;
  active?: RendererArtifactRef;
  candidate?: RendererArtifactRef;
  previous?: RendererArtifactRef;
  lastKnownGood?: RendererArtifactRef;
  quarantined: RendererArtifactQuarantine[];
}

export interface RendererArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface RendererArtifactFetchResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers?: {
    get(name: string): string | null;
  };
  body: AsyncIterable<Uint8Array> | null;
}

export type RendererArtifactFetcher = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<RendererArtifactFetchResponse>;

export interface RendererArtifactServiceOptions {
  userDataDir: string;
  bundledRendererRoot: string;
  shellVersion: string;
  supportedBridgeAbi: number;
  fetcher?: RendererArtifactFetcher;
  limits?: Partial<RendererArtifactLimits>;
  requestTimeoutMs?: number;
  now?: () => Date;
}

export interface StageRendererArtifactInput {
  /** Exact UTF-8 JSON bytes returned by the authenticated control plane. */
  manifestJson: string;
  /**
   * Digest obtained through the authenticated control-plane response. A
   * self-declared digest inside an unauthenticated manifest would not establish
   * authenticity, so staging always requires the out-of-band value.
   */
  expectedManifestSha256: string;
}

export interface ResolvedRendererEntrypoint {
  source: "installed" | "bundled";
  filePath: string;
  rendererRoot: string;
  artifact?: RendererArtifactRef;
}

const ENTRY_NAMES: readonly RendererEntryName[] = [
  "full",
  "mini",
  "overlay",
  "pet",
];

const BUNDLED_ENTRY_FILES: Record<RendererEntryName, string> = {
  full: "index.html",
  mini: "mini.html",
  overlay: "overlay.html",
  pet: "pet.html",
};
const RESERVED_ARTIFACT_PATHS = new Set(["manifest.json"]);

export const assertRendererEntrypointCsp = (
  html: string,
  label: string,
): void => {
  const headEnd = stellaRendererHeadEnd(html);
  if (headEnd === null || !html.startsWith(STELLA_RENDERER_CSP_META, headEnd)) {
    throw new Error(
      `${label} is missing the canonical first-child content security policy`,
    );
  }
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
};

const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const requireSafeToken = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !SAFE_TOKEN_RE.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const requireSha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const requireExternalSha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return requireSha256(value.toLowerCase().replace(/^sha256:/, ""), label);
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
};

const requireRelativeArtifactPath = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    !SAFE_RELATIVE_PATH_RE.test(value)
  ) {
    throw new Error(`${label} is not a safe relative artifact path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.normalize("NFC") !== segment,
    )
  ) {
    throw new Error(`${label} is not a canonical relative artifact path`);
  }
  return value;
};

const requireHttpsUrl = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error(`${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return parsed.toString();
};

const canonicalFileDescriptors = (
  files: readonly RendererArtifactFile[],
): RendererArtifactFile[] =>
  [...files]
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    .map((file) => ({
      path: file.path,
      url: file.url,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType,
    }));

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const computeRendererArtifactSha256 = (
  files: readonly RendererArtifactFile[],
): string =>
  sha256(
    JSON.stringify(
      canonicalFileDescriptors(files).map(
        ({ path: filePath, size, sha256 }) => ({
          path: filePath,
          size,
          sha256,
        }),
      ),
    ),
  );

export const computeRendererManifestSha256 = (manifestJson: string): string =>
  sha256(manifestJson);

export const parseRendererArtifactManifest = (
  input: unknown,
  limits: RendererArtifactLimits = DEFAULT_RENDERER_ARTIFACT_LIMITS,
): RendererArtifactManifest => {
  const value = requireRecord(input, "renderer artifact manifest");
  exactKeys(
    value,
    [
      "schemaVersion",
      "buildId",
      "version",
      "artifactPrefix",
      "bridgeAbi",
      "minShellVersion",
      "entries",
      "files",
      "artifactSha256",
      "size",
    ],
    "renderer artifact manifest",
  );
  if (value.schemaVersion !== RENDERER_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("unsupported renderer artifact schema version");
  }
  const buildId = requireSafeToken(value.buildId, "buildId");
  const version = requireSafeToken(value.version, "version");
  const artifactPrefix = requireRelativeArtifactPath(
    value.artifactPrefix,
    "artifactPrefix",
  );
  if (
    typeof value.bridgeAbi !== "number" ||
    !Number.isSafeInteger(value.bridgeAbi) ||
    value.bridgeAbi < 1 ||
    value.bridgeAbi > 10_000
  ) {
    throw new Error("bridgeAbi must be a positive bounded integer");
  }
  if (
    typeof value.minShellVersion !== "string" ||
    !SEMVER_RE.test(value.minShellVersion)
  ) {
    throw new Error("minShellVersion must be semantic version");
  }

  const entriesValue = requireRecord(value.entries, "entries");
  exactKeys(entriesValue, ENTRY_NAMES, "entries");
  const entries = Object.fromEntries(
    ENTRY_NAMES.map((entryName) => [
      entryName,
      requireRelativeArtifactPath(
        entriesValue[entryName],
        `entries.${entryName}`,
      ),
    ]),
  ) as Record<RendererEntryName, string>;
  for (const [entryName, entryPath] of Object.entries(entries)) {
    if (!entryPath.endsWith(".html")) {
      throw new Error(`entries.${entryName} must reference an HTML file`);
    }
  }

  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > limits.maxFiles
  ) {
    throw new Error("files must be a non-empty bounded array");
  }

  let totalBytes = 0;
  const seenPaths = new Set<string>();
  const seenPortablePaths = new Set<string>();
  const files = value.files.map((item, index): RendererArtifactFile => {
    const file = requireRecord(item, `files[${index}]`);
    exactKeys(
      file,
      ["path", "url", "size", "sha256", "contentType"],
      `files[${index}]`,
    );
    const filePath = requireRelativeArtifactPath(
      file.path,
      `files[${index}].path`,
    );
    const portablePath = filePath.toLowerCase();
    if (RESERVED_ARTIFACT_PATHS.has(portablePath)) {
      throw new Error(
        `artifact path is reserved by the desktop shell: ${filePath}`,
      );
    }
    if (seenPaths.has(filePath) || seenPortablePaths.has(portablePath)) {
      throw new Error(`duplicate or case-colliding artifact path: ${filePath}`);
    }
    seenPaths.add(filePath);
    seenPortablePaths.add(portablePath);
    if (
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > limits.maxFileBytes
    ) {
      throw new Error(`files[${index}].size exceeds its allowed bounds`);
    }
    totalBytes += file.size;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > limits.maxTotalBytes
    ) {
      throw new Error("renderer artifact exceeds the aggregate size limit");
    }
    if (
      typeof file.contentType !== "string" ||
      file.contentType.length === 0 ||
      file.contentType.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:;\s*charset=utf-8)?$/i.test(
        file.contentType,
      )
    ) {
      throw new Error(`files[${index}].contentType is invalid`);
    }
    return {
      path: filePath,
      url: requireHttpsUrl(file.url, `files[${index}].url`),
      size: file.size,
      sha256: requireSha256(file.sha256, `files[${index}].sha256`),
      contentType: file.contentType.toLowerCase(),
    };
  });

  for (const [entryName, entryPath] of Object.entries(entries)) {
    if (!seenPaths.has(entryPath)) {
      throw new Error(`entries.${entryName} is not present in files`);
    }
  }

  const artifactSha256 = requireSha256(value.artifactSha256, "artifactSha256");
  if (computeRendererArtifactSha256(files) !== artifactSha256) {
    throw new Error("artifactSha256 does not match the manifest file set");
  }
  if (
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size !== totalBytes
  ) {
    throw new Error("renderer artifact aggregate size does not match files");
  }

  return {
    schemaVersion: RENDERER_ARTIFACT_SCHEMA_VERSION,
    buildId,
    version,
    artifactPrefix,
    bridgeAbi: value.bridgeAbi,
    minShellVersion: value.minShellVersion,
    entries,
    files: canonicalFileDescriptors(files),
    artifactSha256,
    size: totalBytes,
  };
};

const parseArtifactRef = (
  input: unknown,
  label: string,
): RendererArtifactRef => {
  const value = requireRecord(input, label);
  exactKeys(
    value,
    [
      "buildId",
      "version",
      "bridgeAbi",
      "artifactSha256",
      "manifestSha256",
      "installedAt",
    ],
    label,
  );
  const version = requireSafeToken(value.version, `${label}.version`);
  if (
    typeof value.bridgeAbi !== "number" ||
    !Number.isSafeInteger(value.bridgeAbi) ||
    value.bridgeAbi < 1 ||
    value.bridgeAbi > 10_000
  ) {
    throw new Error(`${label}.bridgeAbi is invalid`);
  }
  return {
    buildId: requireSafeToken(value.buildId, `${label}.buildId`),
    version,
    bridgeAbi: value.bridgeAbi,
    artifactSha256: requireSha256(
      value.artifactSha256,
      `${label}.artifactSha256`,
    ),
    manifestSha256: requireSha256(
      value.manifestSha256,
      `${label}.manifestSha256`,
    ),
    installedAt: requireIsoTimestamp(value.installedAt, `${label}.installedAt`),
  };
};

export const parseRendererArtifactState = (
  input: unknown,
): RendererArtifactState => {
  const value = requireRecord(input, "renderer artifact state");
  const allowedKeys = [
    "schemaVersion",
    "accountScope",
    "active",
    "candidate",
    "previous",
    "lastKnownGood",
    "quarantined",
  ];
  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !allowedKeys.includes(key))) {
    throw new Error("renderer artifact state contains unsupported fields");
  }
  if (value.schemaVersion !== RENDERER_ARTIFACT_STATE_SCHEMA_VERSION) {
    throw new Error("unsupported renderer artifact state schema version");
  }
  if (!Array.isArray(value.quarantined)) {
    throw new Error("renderer artifact quarantine state must be an array");
  }
  const quarantinedDigests = new Set<string>();
  const quarantined = value.quarantined.map((item, index) => {
    const record = requireRecord(item, `quarantined[${index}]`);
    exactKeys(
      record,
      ["artifactSha256", "buildId", "quarantinedAt", "reason"],
      `quarantined[${index}]`,
    );
    const artifactSha256 = requireSha256(
      record.artifactSha256,
      `quarantined[${index}].artifactSha256`,
    );
    if (quarantinedDigests.has(artifactSha256)) {
      throw new Error("renderer artifact quarantine contains duplicates");
    }
    quarantinedDigests.add(artifactSha256);
    if (
      typeof record.reason !== "string" ||
      record.reason.trim().length === 0 ||
      record.reason.length > 1_024
    ) {
      throw new Error(`quarantined[${index}].reason is invalid`);
    }
    return {
      artifactSha256,
      buildId: requireSafeToken(
        record.buildId,
        `quarantined[${index}].buildId`,
      ),
      quarantinedAt: requireIsoTimestamp(
        record.quarantinedAt,
        `quarantined[${index}].quarantinedAt`,
      ),
      reason: record.reason,
    };
  });

  const parseOptionalRef = (
    key: "active" | "candidate" | "previous" | "lastKnownGood",
  ): RendererArtifactRef | undefined =>
    value[key] === undefined ? undefined : parseArtifactRef(value[key], key);

  const state: RendererArtifactState = {
    schemaVersion: RENDERER_ARTIFACT_STATE_SCHEMA_VERSION,
    accountScope:
      value.accountScope === undefined
        ? undefined
        : requireSha256(value.accountScope, "accountScope"),
    active: parseOptionalRef("active"),
    candidate: parseOptionalRef("candidate"),
    previous: parseOptionalRef("previous"),
    lastKnownGood: parseOptionalRef("lastKnownGood"),
    quarantined,
  };
  for (const [slot, artifact] of [
    ["active", state.active],
    ["candidate", state.candidate],
    ["previous", state.previous],
    ["lastKnownGood", state.lastKnownGood],
  ] as const) {
    if (artifact && quarantinedDigests.has(artifact.artifactSha256)) {
      throw new Error(`${slot} references a quarantined renderer artifact`);
    }
  }
  return state;
};

const emptyState = (): RendererArtifactState => ({
  schemaVersion: RENDERER_ARTIFACT_STATE_SCHEMA_VERSION,
  quarantined: [],
});

const parseSemver = (
  version: string,
): {
  core: readonly [number, number, number];
  prerelease: readonly (number | string)[];
} => {
  if (!SEMVER_RE.test(version)) {
    throw new Error("shellVersion must be semantic version");
  }
  const withoutBuild = version.split("+", 1)[0];
  const [coreValue, prereleaseValue] = withoutBuild.split("-", 2);
  const coreParts = coreValue.split(".").map(Number);
  return {
    core: [coreParts[0], coreParts[1], coreParts[2]],
    prerelease:
      prereleaseValue === undefined
        ? []
        : prereleaseValue.split(".").map((identifier) => {
            const numeric = Number(identifier);
            return Number.isSafeInteger(numeric) &&
              String(numeric) === identifier
              ? numeric
              : identifier;
          }),
  };
};

const compareSemver = (left: string, right: string): number => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index];
    if (difference !== 0) {
      return difference;
    }
  }
  if (
    parsedLeft.prerelease.length === 0 ||
    parsedRight.prerelease.length === 0
  ) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart - rightPart;
    }
    if (typeof leftPart === "number") {
      return -1;
    }
    if (typeof rightPart === "number") {
      return 1;
    }
    return leftPart.localeCompare(rightPart, "en");
  }
  return 0;
};

const isPathContained = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};

const assertPathContained = (
  root: string,
  candidate: string,
  label: string,
): void => {
  if (!isPathContained(root, candidate)) {
    throw new Error(`${label} escaped the renderer artifact root`);
  }
};

const syncDirectoryBestEffort = async (
  directoryPath: string,
): Promise<void> => {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(directoryPath, "r");
    await handle.sync();
  } catch {
    // Windows and some filesystems do not permit fsync on directory handles.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const writeTextAtomically = async (
  destination: string,
  contents: string,
): Promise<void> => {
  const parent = path.dirname(destination);
  await fsPromises.mkdir(parent, { recursive: true });
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fsPromises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsPromises.rename(temporary, destination);
    await syncDirectoryBestEffort(parent);
  } catch (error) {
    await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const writeJsonAtomically = async (
  destination: string,
  value: unknown,
): Promise<void> =>
  writeTextAtomically(destination, `${JSON.stringify(value, null, 2)}\n`);

const defaultFetcher: RendererArtifactFetcher = async (url, options) => {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
    headers: {
      Accept: "application/octet-stream",
    },
  });
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    headers: response.headers,
    body: response.body as unknown as AsyncIterable<Uint8Array> | null,
  };
};

export class RendererArtifactService {
  readonly rootDir: string;
  readonly stagingDir: string;
  readonly versionsDir: string;
  readonly statePath: string;

  private readonly bundledRendererRoot: string;
  private readonly fetcher: RendererArtifactFetcher;
  private readonly limits: RendererArtifactLimits;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private readonly shellVersion: string;
  private readonly supportedBridgeAbi: number;
  private trialArtifactSha256: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: RendererArtifactServiceOptions) {
    this.rootDir = path.join(
      path.resolve(options.userDataDir),
      "renderer-artifacts",
    );
    this.stagingDir = path.join(this.rootDir, "staging");
    this.versionsDir = path.join(this.rootDir, "versions");
    this.statePath = path.join(this.rootDir, "state.json");
    this.bundledRendererRoot = path.resolve(options.bundledRendererRoot);
    this.shellVersion = options.shellVersion;
    parseSemver(this.shellVersion);
    this.supportedBridgeAbi = options.supportedBridgeAbi;
    if (
      !Number.isSafeInteger(this.supportedBridgeAbi) ||
      this.supportedBridgeAbi < 1 ||
      this.supportedBridgeAbi > 10_000
    ) {
      throw new Error("supportedBridgeAbi is invalid");
    }
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.limits = {
      ...DEFAULT_RENDERER_ARTIFACT_LIMITS,
      ...options.limits,
    };
    if (
      !Number.isSafeInteger(this.limits.maxFiles) ||
      this.limits.maxFiles < 1 ||
      !Number.isSafeInteger(this.limits.maxFileBytes) ||
      this.limits.maxFileBytes < 1 ||
      !Number.isSafeInteger(this.limits.maxTotalBytes) ||
      this.limits.maxTotalBytes < this.limits.maxFileBytes
    ) {
      throw new Error("renderer artifact limits are invalid");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new Error("renderer artifact request timeout is invalid");
    }
    this.now = options.now ?? (() => new Date());
  }

  async getState(): Promise<RendererArtifactState> {
    return this.runExclusive(async () => this.readState());
  }

  async isHealthyDeploymentInstalled(input: {
    accountScope: string;
    artifactSha256: string;
    manifestSha256: string;
  }): Promise<boolean> {
    return this.runExclusive(async () => {
      const accountScope = requireSha256(input.accountScope, "accountScope");
      const artifactSha256 = requireSha256(
        input.artifactSha256,
        "artifactSha256",
      );
      const manifestSha256 = requireSha256(
        input.manifestSha256,
        "manifestSha256",
      );
      const state = await this.readState();
      if (
        state.accountScope !== accountScope ||
        state.active?.artifactSha256 !== artifactSha256 ||
        state.active.manifestSha256 !== manifestSha256 ||
        state.lastKnownGood?.artifactSha256 !== artifactSha256 ||
        state.lastKnownGood.manifestSha256 !== manifestSha256
      ) {
        return false;
      }
      try {
        await this.verifyRefInstalled(state.active);
        if (state.lastKnownGood !== state.active) {
          await this.verifyRefInstalled(state.lastKnownGood);
        }
        return true;
      } catch {
        return false;
      }
    });
  }

  async getTrustedRendererRoots(): Promise<string[]> {
    return this.runExclusive(async () => {
      let state: RendererArtifactState;
      try {
        state = await this.readState();
      } catch {
        return [this.bundledRendererRoot];
      }
      const roots = [this.bundledRendererRoot];
      const quarantined = new Set(
        state.quarantined.map((entry) => entry.artifactSha256),
      );
      const seen = new Set<string>();
      for (const ref of [
        this.isActiveArtifactLoadable(state) ? state.active : undefined,
        state.previous,
        state.lastKnownGood,
      ]) {
        if (
          !ref ||
          seen.has(ref.artifactSha256) ||
          quarantined.has(ref.artifactSha256)
        ) {
          continue;
        }
        try {
          await this.verifyRefInstalled(ref);
          roots.push(this.versionPath(ref.manifestSha256));
          seen.add(ref.artifactSha256);
        } catch {
          // Never extend privileged IPC trust to an unverifiable cache entry.
        }
      }
      return roots;
    });
  }

  async stage(input: StageRendererArtifactInput): Promise<RendererArtifactRef> {
    return this.runExclusive(async () => {
      const expectedManifestSha256 = requireExternalSha256(
        input.expectedManifestSha256,
        "expectedManifestSha256",
      );
      if (
        typeof input.manifestJson !== "string" ||
        Buffer.byteLength(input.manifestJson, "utf8") > 4 * 1024 * 1024
      ) {
        throw new Error("renderer manifest JSON exceeds its allowed bounds");
      }
      let manifestInput: unknown;
      try {
        manifestInput = JSON.parse(input.manifestJson);
      } catch {
        throw new Error("renderer manifest JSON is invalid");
      }
      const manifest = parseRendererArtifactManifest(
        manifestInput,
        this.limits,
      );
      this.assertManifestCompatibility(manifest);
      const manifestSha256 = computeRendererManifestSha256(input.manifestJson);
      if (manifestSha256 !== expectedManifestSha256) {
        throw new Error(
          "renderer manifest digest does not match control plane",
        );
      }

      const state = await this.readState();
      if (
        state.quarantined.some(
          (entry) => entry.artifactSha256 === manifest.artifactSha256,
        )
      ) {
        throw new Error("renderer artifact is quarantined");
      }

      await fsPromises.mkdir(this.stagingDir, { recursive: true });
      await fsPromises.mkdir(this.versionsDir, { recursive: true });
      const stagePath = path.join(this.stagingDir, randomUUID());
      assertPathContained(this.stagingDir, stagePath, "staging path");
      await fsPromises.mkdir(stagePath, { recursive: false, mode: 0o700 });
      let installed = false;
      try {
        for (const file of manifest.files) {
          const destination = path.resolve(stagePath, file.path);
          assertPathContained(
            stagePath,
            destination,
            `artifact file ${file.path}`,
          );
          await fsPromises.mkdir(path.dirname(destination), {
            recursive: true,
            mode: 0o700,
          });
          await this.downloadVerifiedFile(file, destination);
        }

        for (const entryName of ENTRY_NAMES) {
          const entryPath = path.resolve(
            stagePath,
            manifest.entries[entryName],
          );
          assertPathContained(
            stagePath,
            entryPath,
            `renderer entrypoint ${entryName}`,
          );
          assertRendererEntrypointCsp(
            await fsPromises.readFile(entryPath, "utf8"),
            `renderer entrypoint ${entryName}`,
          );
        }

        await writeTextAtomically(
          path.join(stagePath, "manifest.json"),
          input.manifestJson,
        );
        await syncDirectoryBestEffort(stagePath);

        const versionPath = this.versionPath(manifestSha256);
        try {
          await fsPromises.rename(stagePath, versionPath);
          installed = true;
          await syncDirectoryBestEffort(this.versionsDir);
        } catch (error) {
          const code =
            error instanceof Error && "code" in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") {
            throw error;
          }
          try {
            await this.verifyInstalledVersion(
              versionPath,
              manifest,
              manifestSha256,
            );
          } catch {
            const corruptPath = path.join(
              this.versionsDir,
              `.${manifestSha256}.corrupt.${randomUUID()}`,
            );
            assertPathContained(
              this.versionsDir,
              corruptPath,
              "corrupt version path",
            );
            await fsPromises.rename(versionPath, corruptPath);
            try {
              await fsPromises.rename(stagePath, versionPath);
              installed = true;
              await syncDirectoryBestEffort(this.versionsDir);
            } catch (replacementError) {
              await fsPromises
                .rename(corruptPath, versionPath)
                .catch(() => undefined);
              throw replacementError;
            }
            await fsPromises
              .rm(corruptPath, { recursive: true, force: true })
              .catch(() => undefined);
          }
        }

        const ref: RendererArtifactRef = {
          buildId: manifest.buildId,
          version: manifest.version,
          bridgeAbi: manifest.bridgeAbi,
          artifactSha256: manifest.artifactSha256,
          manifestSha256,
          installedAt: this.now().toISOString(),
        };
        const nextState: RendererArtifactState = {
          ...state,
          candidate: ref,
        };
        await this.writeState(nextState);
        return ref;
      } finally {
        if (!installed) {
          await fsPromises
            .rm(stagePath, {
              recursive: true,
              force: true,
            })
            .catch(() => undefined);
        }
      }
    });
  }

  async activate(
    artifactSha256?: string,
    accountScope?: string,
  ): Promise<RendererArtifactRef> {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const targetDigest =
        artifactSha256 === undefined
          ? state.candidate?.artifactSha256
          : requireSha256(artifactSha256, "artifactSha256");
      if (!targetDigest) {
        throw new Error("there is no renderer artifact candidate to activate");
      }
      if (
        state.quarantined.some((entry) => entry.artifactSha256 === targetDigest)
      ) {
        throw new Error("renderer artifact is quarantined");
      }
      const target = [
        state.candidate,
        state.active,
        state.previous,
        state.lastKnownGood,
      ].find((item) => item?.artifactSha256 === targetDigest);
      if (!target) {
        throw new Error("renderer artifact is not referenced by durable state");
      }
      await this.verifyRefInstalled(target);

      const nextState: RendererArtifactState = {
        ...state,
        accountScope:
          accountScope === undefined
            ? state.accountScope
            : requireSha256(accountScope, "accountScope"),
        active: target,
        candidate:
          state.candidate?.artifactSha256 === targetDigest
            ? undefined
            : state.candidate,
        previous:
          state.active?.artifactSha256 === targetDigest
            ? state.previous
            : state.active,
      };
      await this.writeState(nextState);
      this.trialArtifactSha256 = target.artifactSha256;
      return target;
    });
  }

  async markHealthy(artifactSha256?: string): Promise<RendererArtifactRef> {
    return this.runExclusive(async () => {
      const state = await this.readState();
      if (!state.active) {
        throw new Error("there is no active renderer artifact");
      }
      if (
        artifactSha256 !== undefined &&
        requireSha256(artifactSha256, "artifactSha256") !==
          state.active.artifactSha256
      ) {
        throw new Error(
          "only the active renderer artifact can be marked healthy",
        );
      }
      await this.verifyRefInstalled(state.active);
      const nextState: RendererArtifactState = {
        ...state,
        lastKnownGood: state.active,
      };
      await this.writeState(nextState);
      this.trialArtifactSha256 = null;
      return state.active;
    });
  }

  async rollback(): Promise<RendererArtifactRef | undefined> {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const target = await this.selectUsableFallback(state, [
        state.previous,
        state.lastKnownGood,
      ]);
      const nextState: RendererArtifactState = {
        ...state,
        active: target,
        candidate: undefined,
        previous: undefined,
      };
      await this.writeState(nextState);
      this.trialArtifactSha256 = null;
      return target;
    });
  }

  async deactivateToBundled(): Promise<boolean> {
    return this.runExclusive(async () => {
      const state = await this.readState();
      const hadDeployment = Boolean(
        state.active ||
        state.candidate ||
        state.previous ||
        state.lastKnownGood,
      );
      if (!hadDeployment) return false;
      await this.writeState({
        schemaVersion: RENDERER_ARTIFACT_STATE_SCHEMA_VERSION,
        quarantined: state.quarantined,
      });
      this.trialArtifactSha256 = null;
      return true;
    });
  }

  async quarantine(
    artifactSha256: string,
    reason: string,
  ): Promise<RendererArtifactRef | undefined> {
    return this.runExclusive(async () => {
      const digest = requireSha256(artifactSha256, "artifactSha256");
      const normalizedReason = reason.trim();
      if (normalizedReason.length === 0 || normalizedReason.length > 1_024) {
        throw new Error("quarantine reason is invalid");
      }
      const state = await this.readState();
      const matchingRef = [
        state.active,
        state.candidate,
        state.previous,
        state.lastKnownGood,
      ].find((item) => item?.artifactSha256 === digest);
      if (!matchingRef) {
        throw new Error("renderer artifact is not referenced by current state");
      }

      const quarantine: RendererArtifactQuarantine = {
        artifactSha256: digest,
        buildId: matchingRef.buildId,
        quarantinedAt: this.now().toISOString(),
        reason: normalizedReason,
      };
      const quarantined = [
        ...state.quarantined.filter((entry) => entry.artifactSha256 !== digest),
        quarantine,
      ];
      const fallback =
        state.active?.artifactSha256 === digest
          ? await this.selectUsableFallback({ ...state, quarantined }, [
              state.previous,
              state.lastKnownGood,
            ])
          : state.active;
      const nextState: RendererArtifactState = {
        ...state,
        active: fallback,
        candidate:
          state.candidate?.artifactSha256 === digest
            ? undefined
            : state.candidate,
        previous:
          state.previous?.artifactSha256 === digest
            ? undefined
            : state.previous,
        lastKnownGood:
          state.lastKnownGood?.artifactSha256 === digest
            ? undefined
            : state.lastKnownGood,
        quarantined,
      };
      await this.writeState(nextState);
      if (this.trialArtifactSha256 === digest) {
        this.trialArtifactSha256 = null;
      }
      return fallback;
    });
  }

  async resolveEntrypoint(
    entryName: RendererEntryName,
  ): Promise<ResolvedRendererEntrypoint> {
    return this.runExclusive(async () => {
      if (!ENTRY_NAMES.includes(entryName)) {
        throw new Error("unsupported renderer entrypoint");
      }
      let state: RendererArtifactState;
      try {
        state = await this.readState();
      } catch {
        return this.resolveBundledEntrypoint(entryName);
      }
      const artifact = await this.selectUsableFallback(state, [
        this.isActiveArtifactLoadable(state) ? state.active : undefined,
        state.lastKnownGood,
      ]);
      if (!artifact) {
        return this.resolveBundledEntrypoint(entryName);
      }
      try {
        const manifest = await this.readInstalledManifest(artifact);
        const filePath = path.resolve(
          this.versionPath(artifact.manifestSha256),
          manifest.entries[entryName],
        );
        await this.assertInstalledFile(
          this.versionPath(artifact.manifestSha256),
          filePath,
        );
        return {
          source: "installed",
          filePath,
          rendererRoot: this.versionPath(artifact.manifestSha256),
          artifact,
        };
      } catch {
        return this.resolveBundledEntrypoint(entryName);
      }
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private versionPath(manifestSha256: string): string {
    const digest = requireSha256(manifestSha256, "manifestSha256");
    const versionPath = path.join(this.versionsDir, digest);
    assertPathContained(this.versionsDir, versionPath, "version path");
    return versionPath;
  }

  private async readState(): Promise<RendererArtifactState> {
    let contents: string;
    try {
      contents = await fsPromises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return emptyState();
      }
      throw error;
    }
    try {
      return parseRendererArtifactState(JSON.parse(contents));
    } catch {
      const corruptStatePath = path.join(
        this.rootDir,
        `state.corrupt.${this.now().getTime()}.${randomUUID()}.json`,
      );
      assertPathContained(this.rootDir, corruptStatePath, "corrupt state path");
      await fsPromises.rename(this.statePath, corruptStatePath);
      return emptyState();
    }
  }

  private async writeState(state: RendererArtifactState): Promise<void> {
    const validated = parseRendererArtifactState(state);
    await writeJsonAtomically(this.statePath, validated);
  }

  private async downloadVerifiedFile(
    file: RendererArtifactFile,
    destination: string,
  ): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.requestTimeoutMs,
    );
    let handle: fs.promises.FileHandle | undefined;
    try {
      const response = await this.fetcher(file.url, {
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `renderer artifact download failed with HTTP ${response.status}`,
        );
      }
      if (response.url) {
        const responseUrl = requireHttpsUrl(
          response.url,
          "renderer artifact response URL",
        );
        if (responseUrl !== file.url) {
          throw new Error("renderer artifact download redirected");
        }
      }
      const contentLength = response.headers?.get("content-length");
      if (contentLength !== null && contentLength !== undefined) {
        const parsedLength = Number(contentLength);
        if (
          !Number.isSafeInteger(parsedLength) ||
          parsedLength < 0 ||
          parsedLength > file.size ||
          parsedLength > this.limits.maxFileBytes
        ) {
          throw new Error("renderer artifact content-length exceeds its bound");
        }
      }

      handle = await fsPromises.open(destination, "wx", 0o600);
      const hash = createHash("sha256");
      let downloaded = 0;
      let position = 0;
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        downloaded += chunk.byteLength;
        if (downloaded > file.size || downloaded > this.limits.maxFileBytes) {
          throw new Error("renderer artifact file exceeded its declared size");
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            position,
          );
          if (bytesWritten <= 0) {
            throw new Error("renderer artifact file write made no progress");
          }
          offset += bytesWritten;
          position += bytesWritten;
        }
      }
      if (downloaded !== file.size) {
        throw new Error("renderer artifact file size did not match manifest");
      }
      if (hash.digest("hex") !== file.sha256) {
        throw new Error("renderer artifact file hash did not match manifest");
      }
      await handle.sync();
    } finally {
      clearTimeout(timeout);
      await handle?.close().catch(() => undefined);
    }
  }

  private async verifyInstalledVersion(
    versionPath: string,
    expectedManifest: RendererArtifactManifest,
    expectedManifestSha256: string,
  ): Promise<void> {
    const installedManifest = await this.readManifestAt(versionPath);
    const { manifest } = installedManifest;
    if (
      installedManifest.manifestSha256 !== expectedManifestSha256 ||
      manifest.artifactSha256 !== expectedManifest.artifactSha256
    ) {
      throw new Error("installed renderer artifact manifest does not match");
    }
    for (const file of manifest.files) {
      const filePath = path.resolve(versionPath, file.path);
      await this.assertInstalledFile(versionPath, filePath);
      const stat = await fsPromises.stat(filePath);
      if (stat.size !== file.size) {
        throw new Error("installed renderer artifact file size does not match");
      }
      const actualHash = createHash("sha256");
      const stream = fs.createReadStream(filePath);
      for await (const chunk of stream) {
        actualHash.update(chunk);
      }
      if (actualHash.digest("hex") !== file.sha256) {
        throw new Error("installed renderer artifact file hash does not match");
      }
    }
  }

  private async readManifestAt(versionPath: string): Promise<{
    manifest: RendererArtifactManifest;
    manifestSha256: string;
  }> {
    const manifestPath = path.resolve(versionPath, "manifest.json");
    assertPathContained(versionPath, manifestPath, "installed manifest path");
    await this.assertInstalledFile(versionPath, manifestPath);
    const manifestJson = await fsPromises.readFile(manifestPath, "utf8");
    return {
      manifest: parseRendererArtifactManifest(
        JSON.parse(manifestJson),
        this.limits,
      ),
      manifestSha256: computeRendererManifestSha256(manifestJson),
    };
  }

  private async readInstalledManifest(
    ref: RendererArtifactRef,
  ): Promise<RendererArtifactManifest> {
    const installedManifest = await this.readManifestAt(
      this.versionPath(ref.manifestSha256),
    );
    const { manifest } = installedManifest;
    if (
      manifest.artifactSha256 !== ref.artifactSha256 ||
      installedManifest.manifestSha256 !== ref.manifestSha256
    ) {
      throw new Error("installed renderer artifact reference does not match");
    }
    return manifest;
  }

  private async verifyRefInstalled(ref: RendererArtifactRef): Promise<void> {
    const manifest = await this.readInstalledManifest(ref);
    this.assertManifestCompatibility(manifest);
    await this.verifyInstalledVersion(
      this.versionPath(ref.manifestSha256),
      manifest,
      ref.manifestSha256,
    );
  }

  private async selectUsableFallback(
    state: RendererArtifactState,
    candidates: readonly (RendererArtifactRef | undefined)[],
  ): Promise<RendererArtifactRef | undefined> {
    const quarantined = new Set(
      state.quarantined.map((entry) => entry.artifactSha256),
    );
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (
        !candidate ||
        seen.has(candidate.artifactSha256) ||
        quarantined.has(candidate.artifactSha256)
      ) {
        continue;
      }
      seen.add(candidate.artifactSha256);
      try {
        await this.verifyRefInstalled(candidate);
        return candidate;
      } catch {
        // Continue to the next known-good or bundled fallback.
      }
    }
    return undefined;
  }

  private async assertInstalledFile(
    versionPath: string,
    filePath: string,
  ): Promise<void> {
    assertPathContained(versionPath, filePath, "installed artifact file");
    const [versionStat, stat] = await Promise.all([
      fsPromises.lstat(versionPath),
      fsPromises.lstat(filePath),
    ]);
    if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) {
      throw new Error(
        "installed renderer artifact version is not a regular directory",
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        "installed renderer artifact entry is not a regular file",
      );
    }
    const [realVersionsRoot, realVersionPath, realFilePath] = await Promise.all(
      [
        fsPromises.realpath(this.versionsDir),
        fsPromises.realpath(versionPath),
        fsPromises.realpath(filePath),
      ],
    );
    assertPathContained(
      realVersionsRoot,
      realVersionPath,
      "installed artifact version real path",
    );
    assertPathContained(
      realVersionPath,
      realFilePath,
      "installed artifact real path",
    );
  }

  private assertManifestCompatibility(
    manifest: RendererArtifactManifest,
  ): void {
    if (manifest.bridgeAbi !== this.supportedBridgeAbi) {
      throw new Error("renderer artifact bridge ABI is incompatible");
    }
    if (compareSemver(this.shellVersion, manifest.minShellVersion) < 0) {
      throw new Error("renderer artifact requires a newer desktop shell");
    }
  }

  private isActiveArtifactLoadable(state: RendererArtifactState): boolean {
    if (!state.active) return false;
    return (
      state.active.artifactSha256 === this.trialArtifactSha256 ||
      state.active.artifactSha256 === state.lastKnownGood?.artifactSha256
    );
  }

  private async resolveBundledEntrypoint(
    entryName: RendererEntryName,
  ): Promise<ResolvedRendererEntrypoint> {
    const filePath = path.resolve(
      this.bundledRendererRoot,
      BUNDLED_ENTRY_FILES[entryName],
    );
    assertPathContained(
      this.bundledRendererRoot,
      filePath,
      "bundled renderer entrypoint",
    );
    const stat = await fsPromises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("bundled renderer fallback is unavailable");
    }
    return {
      source: "bundled",
      filePath,
      rendererRoot: this.bundledRendererRoot,
    };
  }
}
