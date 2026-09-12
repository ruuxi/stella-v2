import { useState, useCallback } from "react";
import { Modal } from "@/ui/modal";
import type { ChatContext } from "@/shared/types/electron";
import { useT } from "@/shared/i18n";

export function useScreenshotPreview(chatContext: ChatContext | null) {
  const [index, setIndex] = useState<number | null>(null);

  const screenshot =
    index !== null ? (chatContext?.regionScreenshots?.[index] ?? null) : null;
  const effectiveIndex = screenshot ? index : null;

  const setPreviewIndex = useCallback((next: number | null) => {
    setIndex(next);
  }, []);

  return { screenshot, previewIndex: effectiveIndex, setPreviewIndex };
}

export function ScreenshotPreviewOverlay({
  screenshot,
  index,
  onClose,
}: {
  screenshot: { dataUrl: string };
  index: number;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal
      onClose={onClose}
      container={document.body}
      // The alt text already names this surface exactly; a second string
      // would only be the same sentence in a different catalog entry.
      label={t("app.chat.screenshotPreview.alt", { index: index + 1 })}
      backdropStyle={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.72)",
        padding: "24px",
      }}
      style={{ display: "flex", outline: "none" }}
    >
      <img
        src={screenshot.dataUrl}
        alt={t("app.chat.screenshotPreview.alt", { index: index + 1 })}
        style={{
          maxWidth: "92vw",
          maxHeight: "92vh",
          objectFit: "contain",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-xl)",
        }}
      />
    </Modal>
  );
}
