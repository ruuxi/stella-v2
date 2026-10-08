/**
 * A finished media job's output, read for the files it produced and saved
 * under the Stella media folder.
 */

export type OutputMedia =
  | {
      kind: "image";
      urls: string[];
      mimeTypes?: Array<string | undefined>;
      localPaths?: string[];
    }
  | { kind: "video"; url: string; localPath?: string }
  | { kind: "audio"; url: string; localPath?: string }
  | { kind: "text"; text: string }
  | {
      kind: "download";
      url: string;
      label: string;
      /** The model's own file name, whose extension says what the file is. */
      fileName?: string;
      localPath?: string;
    }
  | { kind: "unknown" };

/* ── Output extraction ── */

export function extractOutput(output: unknown): OutputMedia {
  if (!output || typeof output !== "object") return { kind: "unknown" };
  const o = output as Record<string, unknown>;

  if (Array.isArray(o.images) && o.images.length > 0) {
    const imageEntries = o.images as Array<{
      url?: string;
      mimeType?: string;
      content_type?: string;
    }>;
    const urls = imageEntries
      .map((img) => img.url)
      .filter((u): u is string => Boolean(u));
    const mimeTypes = imageEntries
      .filter((img) => Boolean(img.url))
      .map((img) => img.mimeType ?? img.content_type);
    if (urls.length > 0) return { kind: "image", urls, mimeTypes };
  }

  if (o.video && typeof o.video === "object") {
    const url = (o.video as { url?: string }).url;
    if (url) return { kind: "video", url };
  }

  for (const key of ["audio_file", "audio"]) {
    const src = o[key];
    if (src && typeof src === "object") {
      const url = (src as { url?: string }).url;
      if (url) return { kind: "audio", url };
    }
  }

  if (typeof o.text === "string") return { kind: "text", text: o.text };

  const download = (value: unknown, label: string): OutputMedia | null => {
    if (!value || typeof value !== "object") return null;
    const { url, file_name } = value as { url?: unknown; file_name?: unknown };
    if (typeof url !== "string" || !url) return null;
    return {
      kind: "download",
      url,
      label,
      ...(typeof file_name === "string" ? { fileName: file_name } : {}),
    };
  };

  const mesh = download(o.model_mesh, "Download 3D model");
  if (mesh) return mesh;

  for (const val of Object.values(o)) {
    const found = download(val, "Download result");
    if (found) return found;
  }

  return { kind: "unknown" };
}

/* ── Save output files to desktop/state ── */

export async function saveOutputToStella(
  output: OutputMedia,
  jobId: string,
): Promise<OutputMedia> {
  const saveApi = window.electronAPI?.media?.saveOutput;
  if (!saveApi) return output;

  const ext = (url: string, mimeType?: string) => {
    const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase();
    if (normalizedMime === "image/jpeg") return "jpg";
    if (normalizedMime === "image/png") return "png";
    if (normalizedMime === "image/gif") return "gif";
    if (normalizedMime === "image/webp") return "webp";
    const m = url.match(/\.(\w{2,5})(?:[?#]|$)/);
    if (m) return m[1];
    if (output.kind === "image") return "png";
    if (output.kind === "video") return "mp4";
    if (output.kind === "audio") return "mp3";
    return "bin";
  };

  try {
    switch (output.kind) {
      case "image": {
        const results = await Promise.all(
          output.urls.map((url, i) =>
            saveApi(
              url,
              `${jobId}_${i}.${ext(url, output.mimeTypes?.[i])}`,
              "image",
            ),
          ),
        );
        const localPaths = results
          .filter((r) => r.ok && r.path)
          .map((r) => r.path!);
        return { ...output, localPaths };
      }
      case "video":
      case "audio":
      case "download": {
        const fileExt =
          output.kind === "download"
            ? output.fileName?.match(/\.([a-z0-9]{2,5})$/i)?.[1]
            : undefined;
        const result = await saveApi(
          output.url,
          `${jobId}.${fileExt?.toLowerCase() ?? ext(output.url)}`,
        );
        return result.ok && result.path
          ? { ...output, localPath: result.path }
          : output;
      }
      default:
        return output;
    }
  } catch {
    return output;
  }
}
