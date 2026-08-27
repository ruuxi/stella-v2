import { File, Paths } from "expo-file-system";

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

  uri: string;

  remove: () => void;
};

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

      }
    },
  };
}
