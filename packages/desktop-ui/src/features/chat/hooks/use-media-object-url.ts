import { useEffect, useState } from "react";

const MAX_PLAYBACK_BYTES = 96 * 1024 * 1024;

export const useMediaObjectUrl = (
  filePath: string | null,
  mimeType: string | undefined,
  enabled: boolean,
): string | null => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !filePath) {
      setUrl(null);
      return;
    }
    const reader = window.electronAPI?.display?.readFile;
    if (typeof reader !== "function") return;
    let live = true;
    let created: string | null = null;
    void reader(filePath, { maxBytes: MAX_PLAYBACK_BYTES })
      .then((result) => {
        if (!live || !result || result.missing) return;
        const blob = new Blob([result.bytes as BlobPart], {
          type: mimeType ?? result.mimeType,
        });
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [filePath, mimeType, enabled]);

  return url;
};
