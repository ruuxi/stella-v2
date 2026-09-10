import { useAction } from "convex/react";
import { useId, useMemo, type ReactNode } from "react";
import { DisplayFileSourceContext } from "@/shared/hooks/display-file-source";
import { driveApi } from "./cloud-api";

export function CloudFileSource({ path, children }: { path: string; children: ReactNode }) {
  const getUrl = useAction(driveApi.getMyDriveFileUrl);
  const id = useId();
  const source = useMemo(() => ({
    key: `drive:${id}:${path}`,
    async read(_filePath: string, maxBytes = 32 * 1024 * 1024) {
      const { url } = await getUrl({ path });
      const response = await fetch(url, { headers: { Range: `bytes=0-${maxBytes}` } });
      if (!response.ok) throw new Error("Couldn’t load this Drive file.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("This Drive file has no readable content.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = maxBytes - size;
          chunks.push(value.subarray(0, remaining));
          size += Math.min(value.length, remaining);
          if (value.length > remaining) { truncated = true; break; }
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, truncated, mimeType: response.headers.get("content-type") ?? "application/octet-stream" };
    },
  }), [getUrl, id, path]);
  return <DisplayFileSourceContext.Provider value={source}>{children}</DisplayFileSourceContext.Provider>;
}
