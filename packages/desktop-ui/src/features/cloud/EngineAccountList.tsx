import { useState, type ReactNode } from "react";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Check, MoreHorizontal } from "@/ui/icons";
import { Switch } from "@/ui/switch";

/**
 * One provider's connected accounts: who each account is, which one is in
 * use, and whether a limited account hands over to the next automatically.
 */
export type EngineAccountRow = {
  id: string;
  /** Shown when the provider did not share an email. */
  label: string;
  email?: string;
  plan?: string;
  active: boolean;
  limitedUntil?: number;
};

export const accountInitials = (row: Pick<EngineAccountRow, "email" | "label">): string => {
  const source = (row.email ?? row.label).split("@")[0] ?? "";
  const words = source.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase() || "?";
};

export const formatLimitReset = (limitedUntil: number, now = Date.now()): string => {
  const minutes = Math.max(1, Math.round((limitedUntil - now) / 60_000));
  if (minutes < 60) return `Limit reached · resets in ${minutes} min`;
  const reset = new Date(limitedUntil);
  const sameDay = reset.toDateString() === new Date(now).toDateString();
  return `Limit reached · resets ${
    sameDay
      ? reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : reset.toLocaleString([], {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        })
  }`;
};

function AccountRow({
  row,
  divided,
  busy,
  onUse,
  onSignOut,
}: {
  row: EngineAccountRow;
  divided: boolean;
  busy: boolean;
  onUse: () => void;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const subtitle = [
    row.plan,
    row.limitedUntil ? formatLimitReset(row.limitedUntil) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="settings-row"
      style={divided ? undefined : { borderTop: "none" }}
      data-engine-account={row.id}
    >
      <div
        className="settings-row-info"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <Avatar fallback={accountInitials(row)} size="small" />
        <div style={{ minWidth: 0 }}>
          <div
            className="settings-row-label"
            style={{ overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {row.email ?? row.label}
          </div>
          {subtitle ? (
            <div className="settings-row-sublabel">{subtitle}</div>
          ) : null}
        </div>
      </div>
      <div
        className="settings-row-control"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {row.active ? (
          <Check size={16} aria-label="Active account" />
        ) : null}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="pill-btn"
              aria-label={`Options for ${row.email ?? row.label}`}
              disabled={busy}
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12}>
            {row.active ? null : (
              <>
                <DropdownMenuItem onSelect={onUse}>
                  Use this account
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={onSignOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function EngineAccountList({
  title,
  description,
  accounts,
  autoSwitch,
  autoSwitchDescription,
  busy,
  adding,
  addLabel,
  onAdd,
  onUse,
  onSignOut,
  onToggleAutoSwitch,
  addFlow,
}: {
  title: string;
  description: string;
  accounts: readonly EngineAccountRow[];
  autoSwitch: boolean;
  autoSwitchDescription: string;
  busy: boolean;
  adding: boolean;
  addLabel: string;
  onAdd: () => void;
  onUse: (id: string) => void;
  onSignOut: (id: string) => void;
  onToggleAutoSwitch: (enabled: boolean) => void;
  /** Extra UI while an account is being added (e.g. a paste-back field). */
  addFlow?: ReactNode;
}) {
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{title}</div>
          <div className="settings-row-sublabel">{description}</div>
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            onClick={onAdd}
            disabled={busy || adding}
          >
            {accounts.length === 0 ? "Connect" : addLabel}
          </Button>
        </div>
      </div>
      {accounts.map((row, index) => (
        <AccountRow
          key={row.id}
          row={row}
          divided={index > 0}
          busy={busy}
          onUse={() => onUse(row.id)}
          onSignOut={() => onSignOut(row.id)}
        />
      ))}
      {addFlow}
      {accounts.length > 0 ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Switch accounts at the limit</div>
            <div className="settings-row-sublabel">{autoSwitchDescription}</div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={autoSwitch}
              onCheckedChange={onToggleAutoSwitch}
              disabled={busy}
              hideLabel
              label="Switch accounts at the limit"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
