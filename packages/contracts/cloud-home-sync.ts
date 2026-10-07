/**
 * Renderer-safe Cloud Home import and synchronization contracts.
 *
 * Filesystem paths are deliberately relative display paths. The Electron main
 * process never returns the configured Stella data-directory path to a
 * renderer, and cursors never persist document contents or skill bytes.
 */

export const CLOUD_HOME_LOCAL_SCAN_VERSION = 1 as const;
export const CLOUD_HOME_MAX_DOCUMENTS = 100;
export const CLOUD_HOME_MAX_EXPORT_BYTES = 2 * 1024 * 1024;
export const CLOUD_SKILL_MAX_PACKAGES = 50;
export const CLOUD_SKILL_MAX_FILES = 256;
export const CLOUD_SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const CLOUD_SKILL_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** Bounds one renderer scan even when several valid packages are present. */
export const CLOUD_HOME_LOCAL_SKILLS_SCAN_MAX_BYTES = 50 * 1024 * 1024;

export type CloudHomeImportOwnership =
  | "owned"
  | "unclaimed"
  | "anonymous"
  | "other_owner"
  | "corrupt";

export type CloudMemoryKind =
  | "memory"
  | "profile"
  | "memory_map"
  | "core_memory"
  | "personality"
  | "imported_markdown"
  | "user_markdown";

export type CloudMemoryImportDisposition =
  | "automatic_allowed"
  | "explicit_required"
  | "explicit_allowed";

export type LocalCloudMemoryDocument = {
  name: string;
  displayPath: string;
  kind: CloudMemoryKind;
  source: "legacy_local";
  content: string;
  sha256: string;
  sizeBytes: number;
};

export type LocalCloudSkillFile = {
  path: string;
  contentType: string;
  base64: string;
  sha256: string;
  sizeBytes: number;
};

export type LocalCloudSkillPackage = {
  slug: string;
  name: string;
  description: string;
  source: "desktop_sync";
  availability: "both";
  treeSha256: string;
  fileCount: number;
  totalSizeBytes: number;
  files: LocalCloudSkillFile[];
};

export type CloudHomeScanWarningCode =
  | "invalid_path"
  | "unsafe_file"
  | "unsupported_document"
  | "document_too_large"
  | "document_limit"
  | "skill_invalid"
  | "skill_too_large"
  | "skill_limit"
  | "read_failed";

export type CloudHomeScanWarning = {
  code: CloudHomeScanWarningCode;
  /** A bounded relative display path, never an absolute local path. */
  path: string;
  message: string;
};

export type LocalCloudHomeScan = {
  schemaVersion: typeof CLOUD_HOME_LOCAL_SCAN_VERSION;
  memories: LocalCloudMemoryDocument[];
  skills: LocalCloudSkillPackage[];
  warnings: CloudHomeScanWarning[];
};

export type CloudMemoryDocument = {
  documentId: string;
  name: string;
  displayPath: string;
  kind: CloudMemoryKind | "archive";
  source: string;
  revision: number;
  versionId?: string;
  sha256?: string;
  sizeBytes: number;
  updatedAt: number;
  content: string;
};

export type CloudMemorySnapshot = {
  ownerGeneration: string;
  memoryEpoch: string;
  importDisposition: CloudMemoryImportDisposition;
  lastWipedEpoch?: string;
  lastWipeCompletedAt?: number;
  documents: CloudMemoryDocument[];
};

export type CloudSkillHead = {
  skillId: string;
  ownerGeneration: string;
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
  versionId?: string;
  manifestSha256?: string;
  treeSha256?: string;
  fileCount?: number;
  totalSizeBytes?: number;
  updatedAt: number;
};

/**
 * Result of tombstoning one cloud mirror head. `conflict` means the cloud row
 * advanced past the revision the device observed, so it was left in place.
 */
export type CloudSkillMirrorDeletion = {
  status: "deleted" | "conflict";
};

export type CloudHomeSyncErrorCode =
  | "not_available"
  | "not_authenticated"
  | "scan_failed"
  | "cloud_unavailable"
  | "cloud_conflict"
  | "verification_failed"
  | "import_confirmation_required"
  | "memory_reimport_confirmation_required"
  | "local_owner_mismatch"
  | "local_owner_record_invalid";

export type CloudHomeSyncIssue = {
  code: CloudHomeSyncErrorCode;
  /** Safe label such as a cloud document name or skill slug. */
  item?: string;
  message: string;
};

export type CloudHomeSyncPhase =
  | "idle"
  | "scanning"
  | "reconciling"
  | "complete"
  | "attention"
  | "unavailable";

export type CloudHomeSyncStatus = {
  accountScope: string | null;
  phase: CloudHomeSyncPhase;
  memoryUploaded: number;
  memoryCloudWins: number;
  skillsUploaded: number;
  skillsCloudWins: number;
  skipped: number;
  warnings: CloudHomeScanWarning[];
  issues: CloudHomeSyncIssue[];
  lastCompletedAt?: number;
};

export type CloudHomeSyncCursor = {
  schemaVersion: 1;
  ownerGeneration?: string;
  memoryEpoch?: string;
  memories: Record<
    string,
    { localSha256: string; cloudVersionId?: string; cloudRevision: number }
  >;
  skills: Record<
    string,
    { localTreeSha256: string; cloudVersionId?: string; cloudRevision: number }
  >;
  lastCompletedAt?: number;
};
