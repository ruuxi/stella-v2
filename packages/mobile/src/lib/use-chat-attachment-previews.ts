import { makeFunctionReference } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ChatMessage } from "../types";
import { getConvexClient } from "./convex";

type DrivePreview = {
  path: string;
  name: string;
  contentType: string;
  url: string;
  expiresAt: number;
};
const getPreview = makeFunctionReference<"action", { path: string }, DrivePreview>(
  "cloud_drive:getMyDriveFileUrl",
);
const REFRESH_MARGIN_MS = 30_000;
const RETRY_MS = 30_000;

/** Resolve journal attachment paths through the current owner's authenticated drive. */
export function useChatAttachmentPreviews(
  messages: ChatMessage[],
  authorityScope: string,
): ChatMessage[] {
  // A stable path key avoids restarting requests for unrelated streamed rows.
  const pathKey = JSON.stringify([...new Set(messages.flatMap((message) =>
    message.attachmentPaths ?? []))].sort());
  const paths = useMemo(() => JSON.parse(pathKey) as string[], [pathKey]);
  const cacheRef = useRef({ scope: authorityScope, entries: new Map<string, DrivePreview>() });
  if (cacheRef.current.scope !== authorityScope) {
    // Reset during render: never render the prior account's signed URLs while
    // waiting for effect cleanup, and reject its outstanding request results.
    cacheRef.current = { scope: authorityScope, entries: new Map() };
  }
  const [revision, setRevision] = useState(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setRefresh((current) => current + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const cache = cacheRef.current;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Set(paths);
    for (const path of cache.entries.keys()) {
      if (!loaded.has(path)) cache.entries.delete(path);
    }
    if (!authorityScope || paths.length === 0) return;
    const pending = paths.filter((path) =>
      (cache.entries.get(path)?.expiresAt ?? 0) <= Date.now() + REFRESH_MARGIN_MS);
    let cursor = 0;
    const current = () => alive && cacheRef.current === cache;
    const worker = async () => {
      while (current() && cursor < pending.length) {
        const path = pending[cursor++]!;
        try {
          const preview = await getConvexClient().action(getPreview, { path });
          if (!current()) return;
          cache.entries.set(path, preview);
          setRevision((value) => value + 1);
        } catch {
          // Keep local previews and retry transient auth/network failures.
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker))
      .then(() => {
        if (!current()) return;
        const nextRefresh = Math.min(...paths.map((path) => {
          const expiry = cache.entries.get(path)?.expiresAt ?? 0;
          return expiry > Date.now() + REFRESH_MARGIN_MS
            ? expiry - Date.now() - REFRESH_MARGIN_MS
            : RETRY_MS;
        }));
        timer = setTimeout(() => setRefresh((value) => value + 1),
          Math.max(1_000, Math.min(nextRefresh, 2_147_483_647)));
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [authorityScope, paths, refresh]);

  return useMemo(() => {
    const entries = cacheRef.current.entries;
    return messages.map((message) => {
      const attachmentPaths = message.attachmentPaths;
      if (!attachmentPaths?.length) return message;
      const resolved = attachmentPaths.flatMap((path) => {
        const preview = entries.get(path);
        return preview && preview.expiresAt > Date.now() ? [preview] : [];
      });
      const existingPreviews = new Map(message.attachmentPreviews?.map((preview) => [preview.path, preview]));
      const attachmentPreviews = attachmentPaths.map((path) => {
        const preview = entries.get(path);
        const existing = existingPreviews.get(path);
        if (!preview || preview.expiresAt <= Date.now()) {
          return existing ?? { path, name: path.split("/").pop() || path };
        }
        return {
          path,
          name: preview.name,
          ...(preview.contentType.toLowerCase().startsWith("image/")
            ? { imageUri: preview.url } : {}),
        };
      });
      if (!resolved.length) return { ...message, attachmentPreviews };
      const images = resolved.filter((preview) => preview.contentType.toLowerCase().startsWith("image/"));
      const documents = resolved.filter((preview) => !preview.contentType.toLowerCase().startsWith("image/"));
      // Local thumbnails cover the admission/upload handoff; switch only when
      // the full canonical attachment set has resolved, avoiding partial strips.
      const thumbnailUris = resolved.length === attachmentPaths.length
        ? images.map((preview) => preview.url)
        : message.thumbnailUris?.length ? message.thumbnailUris : images.map((preview) => preview.url);
      return {
        ...message,
        attachmentPreviews,
        ...(images.length ? { hasImage: true } : {}),
        ...(thumbnailUris.length ? { thumbnailUris } : {}),
        ...(documents.length ? {
          documentNames: [...new Set([...(message.documentNames ?? []), ...documents.map((preview) => preview.name)])],
        } : {}),
      };
    });
  }, [messages, authorityScope, revision, refresh]);
}
