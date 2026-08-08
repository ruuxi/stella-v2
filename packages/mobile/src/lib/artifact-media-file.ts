import { File, Paths } from "expo-file-system";

/**
 * Materializes artifact bytes as a real file in the cache directory.
 *
 * Most previews are happy with the base64 `data:` URI `bytesToDataUri`
 * produces, but the two native media surfaces are not: WKWebView refuses
 * top-level navigation to a `data:` URL, so the PDF viewer can't reach the
 * system PDF renderer that way, and expo-audio hands its source to AVPlayer,
 * which wants a real URL. Both take a `file://` URI, and both infer the media
 * type from its extension — so the extension has to be right.
 */

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
};

const extensionFor = (sourcePath: string, mimeType: string): string => {
  const fromPath = /\.([A-Za-z0-9]{1,8})$/.exec(sourcePath)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_EXTENSIONS[mime] ?? "bin";
};

let sequence = 0;

export type ArtifactMediaFile = {
  /** `file://` URI a WebView or audio player can open directly. */
  uri: string;
  /** Best-effort removal — the cache directory is disposable either way. */
  remove: () => void;
};

/**
 * Write `bytes` to a uniquely named cache file, taking its extension from
 * `sourcePath` when it has one and falling back to `mimeType`.
 */
export function writeArtifactMediaFile(
  bytes: Uint8Array,
  mimeType: string,
  sourcePath: string,
): ArtifactMediaFile {
  sequence += 1;
  const file = new File(
    Paths.cache,
    `stella-artifact-${Date.now()}-${sequence}.${extensionFor(sourcePath, mimeType)}`,
  );
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);
  return {
    uri: file.uri,
    remove: () => {
      try {
        file.delete();
      } catch {
        // Already gone, or the OS purged the cache under us.
      }
    },
  };
}
