import { ChevronDown } from "@/ui/icons";
import { useCallback, useEffect, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useT } from "@/shared/i18n";
import "./open-with-menu.css";

type Opener = {
  id: string;
  label: string;
  kind: "app" | "default" | "reveal";
};

export const OpenWithMenu = ({
  filePath,
  variant = "button",
}: {
  filePath: string;

  variant?: "button" | "plus";
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [openerResult, setOpenerResult] = useState<{
    filePath: string;
    openers: Opener[];
  } | null>(null);
  const openers =
    openerResult?.filePath === filePath ? openerResult.openers : null;

  useEffect(() => {
    if (!open || openers) return;
    let cancelled = false;
    const api = window.electronAPI?.system;
    if (!api?.listExternalOpeners) {
      setOpenerResult({ filePath, openers: [] });
      return;
    }
    void api
      .listExternalOpeners(filePath)
      .then((result) => {
        if (cancelled) return;
        setOpenerResult({ filePath, openers: result?.openers ?? [] });
      })
      .catch(() => {
        if (cancelled) return;
        setOpenerResult({ filePath, openers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [open, openers, filePath]);

  const handleSelect = useCallback(
    (openerId: string) => {
      const api = window.electronAPI?.system;
      if (!api?.openWithExternal) return;
      void api.openWithExternal(filePath, openerId);
    },
    [filePath],
  );

  const appOpeners = openers?.filter((entry) => entry.kind === "app") ?? [];
  const builtins = openers?.filter((entry) => entry.kind !== "app") ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {variant === "plus" ? (
          <button
            type="button"
            className="open-with-menu__trigger open-with-menu__trigger--chevron"
            onClick={(event) => event.stopPropagation()}
            title={t("app.chat.openWith.otherWaysTitle")}
            aria-label={t("app.chat.openWith.otherWaysLabel")}
          >
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="open-with-menu__trigger"
            onClick={(event) => event.stopPropagation()}
            title={t("app.chat.openWith.triggerTitle")}
          >
            <span className="open-with-menu__trigger-label">
              {t("app.chat.openWith.triggerLabel")}
            </span>
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className="open-with-menu"
      >
        {openers === null ? (
          <div className="open-with-menu__loading">
            {t("app.chat.openWith.loading")}
          </div>
        ) : (
          <>
            {appOpeners.map((opener) => (
              <DropdownMenuItem
                key={opener.id}
                onSelect={() => handleSelect(opener.id)}
              >
                {opener.label}
              </DropdownMenuItem>
            ))}
            {appOpeners.length > 0 && builtins.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {builtins.map((opener) => (
              <DropdownMenuItem
                key={opener.id}
                onSelect={() => handleSelect(opener.id)}
              >
                {opener.label}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
