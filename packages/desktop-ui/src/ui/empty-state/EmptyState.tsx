import type { CSSProperties, ReactNode } from "react";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { cn } from "@/shared/lib/utils";
import type { IconComponent } from "@/ui/icons";
import { StellaCharacter } from "@/ui/stella-character/StellaCharacter";
import { EmptyStateMotifArt, type EmptyStateMotif } from "./motifs";
import "./empty-state.css";

export type { EmptyStateMotif };

export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  icon?: IconComponent;
};

export type EmptyStateProps = {
  motif: EmptyStateMotif;
  title: string;
  body?: ReactNode;
  bodyHint?: string | undefined;
  detail?: string | undefined;
  action?: EmptyStateAction | undefined;
  secondaryAction?: EmptyStateAction | undefined;
  size?: "regular" | "compact";
  live?: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
};

const MARK_SIZE = { regular: 58, compact: 40 } as const;

const MARK_SPOT: Partial<Record<EmptyStateMotif, "low" | "right" | "inside">> = {
  files: "low",
  unavailable: "right",
  preview: "right",
  blank: "right",
  changes: "right",
  trash: "inside",
};

function ActionButton({ action }: { action: EmptyStateAction }) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      className="pill-btn pill-btn--lg empty-state__action"
      onClick={action.onClick}
    >
      {Icon ? <Icon size={14} strokeWidth={2} aria-hidden="true" /> : null}
      {action.label}
    </button>
  );
}

export function EmptyState({
  motif,
  title,
  body,
  bodyHint,
  detail,
  action,
  secondaryAction,
  size = "regular",
  live = true,
  className,
  style,
}: EmptyStateProps) {
  const windowFocused = useWindowFocus();
  const spot = MARK_SPOT[motif] ?? "center";
  return (
    <div
      className={cn("empty-state", className)}
      data-size={size}
      data-motif={motif}
      data-still={!live || !windowFocused ? "true" : undefined}
      role="status"
      style={style}
    >
      <div className="empty-state__art" aria-hidden="true">
        <EmptyStateMotifArt motif={motif} />
        <div className="empty-state__mark" data-spot={spot}>
          <StellaCharacter
            size={MARK_SIZE[size]}
            state="idle"
            shape="star"
            ink="aurora"
            eyeColor="var(--empty-state-eye, var(--background))"
            paused
          />
        </div>
        <EmptyStateMotifArt motif={motif} layer="front" />
      </div>
      <div className="empty-state__copy">
        <p className="empty-state__title">{title}</p>
        {detail ? (
          <p className="empty-state__detail" title={detail}>
            {detail}
          </p>
        ) : null}
        {body ? (
          <p className="empty-state__body" title={bodyHint}>
            {body}
          </p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="empty-state__actions">
          {action ? <ActionButton action={action} /> : null}
          {secondaryAction ? <ActionButton action={secondaryAction} /> : null}
        </div>
      ) : null}
    </div>
  );
}
