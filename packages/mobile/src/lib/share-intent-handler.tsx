import { useEffect } from "react";
import { useRouter } from "expo-router";
import { File } from "expo-file-system";
import { useShareIntentContext } from "expo-share-intent";
import type { ImagePickerAsset } from "expo-image-picker";
import { setPendingShare } from "./pending-share";

const asFileUri = (path: string) =>
  path.startsWith("file://") ? path : `file://${path}`;

/**
 * Watches the native share sheet intent (text, links, images shared into
 * Stella) and forwards it to the chat composer. Mounted once at the root so
 * both cold starts and warm shares land in the same place.
 */
export function ShareIntentHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } =
    useShareIntentContext();

  useEffect(() => {
    if (!hasShareIntent) return;

    let cancelled = false;
    void (async () => {
      const text = (shareIntent.webUrl ?? shareIntent.text ?? "").trim();
      const assets: ImagePickerAsset[] = [];
      for (const file of shareIntent.files ?? []) {
        if (!file.mimeType?.startsWith("image/")) continue;
        try {
          const uri = asFileUri(file.path);
          const base64 = await new File(uri).base64();
          assets.push({
            uri,
            base64,
            mimeType: file.mimeType,
            width: file.width ?? 0,
            height: file.height ?? 0,
            fileName: file.fileName,
          } as ImagePickerAsset);
        } catch {
          // Skip unreadable files rather than dropping the whole share.
        }
        if (assets.length >= 5) break;
      }
      if (cancelled) return;
      if (text || assets.length > 0) {
        setPendingShare({
          ...(text ? { text } : {}),
          ...(assets.length > 0 ? { assets } : {}),
        });
        router.replace("/chat");
      }
      resetShareIntent();
    })();

    return () => {
      cancelled = true;
    };
  }, [hasShareIntent, resetShareIntent, router, shareIntent]);

  return null;
}
