/**
 * On the website a canvas renders from its text (`srcDoc`), with no folder
 * behind it, so its relative images, stylesheets and scripts are read from
 * their Drive copies (the desktop copies them beside the document) and
 * embedded before it shows.
 */
import { useEffect, useState } from "react";
import { embedRelativeHtmlAssets } from "@stella/contracts/html-relative-assets";
import { readDeviceFileCopy } from "@/features/cloud/device-file-copy";

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8");

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const imageTypeFor = (filePath: string, reported: string) => {
  if (reported.startsWith("image/")) return reported;
  const extension = /\.([a-z0-9]+)$/iu.exec(filePath)?.[1]?.toLowerCase() ?? "";
  return IMAGE_TYPES[extension] ?? null;
};

const dataUrlOf = (bytes: Uint8Array, type: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read image."));
    reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  });

const embedFromDeviceCopies = (
  html: string,
  documentPath: string,
  signal: AbortSignal,
) =>
  embedRelativeHtmlAssets(
    html,
    documentPath,
    async ({ path, kind }) => {
      const copy = await readDeviceFileCopy(path, MAX_ASSET_BYTES);
      if (!copy || copy.truncated || signal.aborted) return null;
      if (kind === "text") return decoder.decode(copy.bytes);
      const type = imageTypeFor(path, copy.mimeType);
      return type ? await dataUrlOf(copy.bytes, type) : null;
    },
    signal,
  );

export const useEmbeddedCanvasAssets = (
  html: string,
  documentPath: string,
  enabled: boolean,
): { html: string; loading: boolean } => {
  const [embedded, setEmbedded] = useState<{
    source: string;
    html: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !html) return;
    const controller = new AbortController();
    const settle = (result: string) => {
      if (!controller.signal.aborted) setEmbedded({ source: html, html: result });
    };
    void embedFromDeviceCopies(html, documentPath, controller.signal).then(
      settle,
      () => settle(html),
    );
    return () => controller.abort();
  }, [html, documentPath, enabled]);
  if (!enabled || !html) return { html, loading: false };
  return embedded?.source === html
    ? { html: embedded.html, loading: false }
    : { html: "", loading: true };
};
