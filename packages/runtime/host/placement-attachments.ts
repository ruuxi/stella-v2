/**
 * Desktop-placed resolution of a turn's attachments.
 *
 * A placement payload names attachments by drive-relative path, never by
 * bytes. The cloud placement turns those paths into image content through
 * `/api/cloud/drive/attachments`; the desktop turns them into
 * `RuntimeAttachmentRef`s pointing at a short-lived signed drive GET, which the
 * agent runtime already knows how to materialize into vision content.
 *
 * The worker materializes documents from these owner-authorized signed URLs
 * into the profile's local attachment cache and supplies a real absolute Read
 * path to the agent, just as it persists images for later inspection.
 *
 * Nothing here caps the array. The server validated the count and the payload
 * hash covers the exact list, so a cap on this side could only silently drop an
 * attachment the server had already admitted, which is the one outcome the
 * reference design exists to prevent.
 *
 * `sourcePath` stays unset. The runtime hands it to the model as an absolute
 * path to Read, so a drive-relative path there is a broken instruction.
 */
import type { RuntimeAttachmentRef } from "@stella/contracts/protocol";

/** What `cloud_drive:getMyDriveFileUrl` returns for one path. */
export type DriveFileResolution = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  url: string;
};

/**
 * The paths a dispatch payload carries. Anything that is not a non-empty
 * string is dropped rather than failing the turn: the same payload also
 * reaches the cloud placement, which drops what it cannot read.
 */
export const placementAttachmentPaths = (
  payload: Record<string, unknown>,
): string[] => {
  if (!Array.isArray(payload.attachments)) return [];
  return payload.attachments.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
};

/**
 * One unreadable attachment must not cost the others, which is how the cloud
 * placement behaves. A path that no longer resolves is reported and skipped so
 * both placements degrade the same way for the same turn.
 */
export const resolvePlacementAttachments = async (args: {
  paths: readonly string[];
  resolve: (path: string) => Promise<DriveFileResolution>;
  onSkipped?: (path: string, error: unknown) => void;
}): Promise<RuntimeAttachmentRef[]> => {
  const resolved: RuntimeAttachmentRef[] = [];
  for (const path of args.paths) {
    try {
      const file = await args.resolve(path);
      const contentType = file.contentType.trim().toLowerCase();
      resolved.push({
        url: file.url,
        mimeType: contentType,
        kind: contentType.startsWith("image/") ? "image" : "file",
        name: file.name,
        size: file.sizeBytes,
      });
    } catch (error) {
      args.onSkipped?.(path, error);
    }
  }
  return resolved;
};
