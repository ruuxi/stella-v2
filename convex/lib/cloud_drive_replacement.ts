/**
 * A Drive row can retain an anonymous owner's immutable @convex-dev/r2 key
 * after account linking. The next real byte write uses the connected owner's
 * key. Once the row transactionally points at that new key, the old object is
 * unreachable and may be deleted.
 *
 * Workspace rows are metadata-only claims about checkpoint bytes and never
 * prove an R2 object exists, so they do not create cleanup work.
 */
export const priorDriveObjectKeyForCleanup = ({
  priorR2Key,
  priorSource,
  nextR2Key,
}: {
  priorR2Key: string;
  priorSource: string;
  nextR2Key: string;
}): string | null =>
  priorSource !== "workspace" && priorR2Key !== nextR2Key ? priorR2Key : null;

/**
 * Post-commit object cleanup is allowed only after an indexed read proves no
 * Drive row still names the candidate key. Multiple rows can legitimately
 * share an old immutable key after historical migrations, so replacement of
 * one row alone is not sufficient proof.
 */
export const shouldDeleteReplacedDriveObjectKey = (
  isStillReferenced: boolean,
): boolean => !isStillReferenced;
