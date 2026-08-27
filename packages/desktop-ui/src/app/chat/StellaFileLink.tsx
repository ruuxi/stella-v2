import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import { displayPayloadForStellaFile } from "@/features/chat/lib/stella-file-links";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { basenameOf } from "@/features/workspace-display/path-to-viewer";
import { useT } from "@/shared/i18n";

type StellaFileLinkProps = {
  path?: unknown;
  label?: unknown;
  node?: unknown;
};

export const StellaFileLink = ({ path, label }: StellaFileLinkProps) => {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const filePath = typeof path === "string" ? path : "";
  const rawLabel = typeof label === "string" ? label.trim() : "";
  const display = rawLabel || (filePath ? basenameOf(filePath) : "");

  const open = useCallback(() => {
    if (!filePath) return;
    setFailed(false);
    const payload = displayPayloadForStellaFile(filePath, Date.now());
    if (payload) {
      openDisplayPayloadTab(payload);
      return;
    }

    const api = window.electronAPI?.system;
    if (!api?.openPath) {
      setFailed(true);
      return;
    }
    void api
      .openPath(filePath)
      .then((result) => {
        if (!result?.ok) setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [filePath]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    },
    [open],
  );

  if (!filePath || !display) {
    return <span>{display || null}</span>;
  }

  return (
    <a
      role="button"
      tabIndex={0}
      className="markdown-stella-file"
      data-failed={failed || undefined}
      title={
        failed ? t("app.chat.fileLink.openFailed", { filePath }) : filePath
      }
      onClick={open}
      onKeyDown={handleKeyDown}
    >
      {display}
    </a>
  );
};
