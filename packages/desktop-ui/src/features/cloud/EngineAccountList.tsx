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
 * One provider's accounts: who each account is, which one is in use,
 * whether a limited account hands over to the next automatically, and (for
 * ChatGPT) which saved accounts are signed out or need a new sign-in.
 */
export type EngineAccountRow = {
  id: string;
  /** Shown when the provider did not share an email. */
  label: string;
  email?: string;
  plan?: string;
  active: boolean;
  limitedUntil?: number;
  /** Absent while signed in. */
  status?: "signed_out" | "reauth_required";
  /** ChatGPT: false when the sign-in didn't grant ChatGPT plan use. */
  planUsage?: boolean;
  /**
   * Replaces the reset time while limited, for providers whose limit
   * doesn't say when it resets (ChatGPT).
   */
  limitText?: string;
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

const statusText = (row: EngineAccountRow): string | undefined =>
  row.status === "signed_out"
    ? "Signed out"
    : row.status === "reauth_required"
      ? "Sign-in ended · sign in again"
      : row.planUsage === false
        ? "ChatGPT plan use isn't enabled"
        : undefined;

export type EngineAccountActions = {
  onUse: (id: string) => void;
  onSignOut: (id: string) => void;
  /** Sign a saved account in again (its registration is kept). */
  onSignInAgain?: (id: string) => void;
  /** Ask for consent to use the ChatGPT plan after it was declined. */
  onEnablePlanUsage?: (id: string) => void;
  /** Forget the account entirely. */
  onRemove?: (id: string) => void;
};

function AccountRow({
  row,
  divided,
  busy,
  actions,
}: {
  row: EngineAccountRow;
  divided: boolean;
  busy: boolean;
  actions: EngineAccountActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const usable = !row.status && row.planUsage !== false;
  const subtitle = [
    row.plan,
    statusText(row),
    usable && row.limitedUntil ? (row.limitText ?? formatLimitReset(row.limitedUntil)) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const items: Array<{ key: string; label: string; onSelect: () => void }> = [];
  if (usable && !row.active) {
    items.push({ key: "use", label: "Use this account", onSelect: () => actions.onUse(row.id) });
  }
  if (row.status && actions.onSignInAgain) {
    items.push({ key: "again", label: "Sign in again", onSelect: () => actions.onSignInAgain!(row.id) });
  }
  if (!row.status && row.planUsage === false && actions.onEnablePlanUsage) {
    items.push({
      key: "enable",
      label: "Enable ChatGPT plan use",
      onSelect: () => actions.onEnablePlanUsage!(row.id),
    });
  }
  const tail: Array<{ key: string; label: string; onSelect: () => void }> = [];
  if (row.status !== "signed_out") {
    tail.push({ key: "out", label: "Sign out", onSelect: () => actions.onSignOut(row.id) });
  }
  if (actions.onRemove) {
    tail.push({ key: "remove", label: "Remove", onSelect: () => actions.onRemove!(row.id) });
  }
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
            {items.map((item) => (
              <DropdownMenuItem key={item.key} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
            ))}
            {items.length > 0 && tail.length > 0 ? <DropdownMenuSeparator /> : null}
            {tail.map((item) => (
              <DropdownMenuItem key={item.key} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenuItem>
            ))}
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
  addButton,
  onToggleAutoSwitch,
  addFlow,
  footer,
  ...actions
}: {
  title: string;
  description: ReactNode;
  accounts: readonly EngineAccountRow[];
  autoSwitch: boolean;
  autoSwitchDescription: string;
  busy: boolean;
  adding: boolean;
  addLabel: string;
  onAdd: () => void;
  /** Replaces the default add button (e.g. "Continue with ChatGPT"). */
  addButton?: ReactNode;
  onToggleAutoSwitch: (enabled: boolean) => void;
  /** Extra UI while an account is being added (e.g. a paste-back field). */
  addFlow?: ReactNode;
  /** Shown under the list (e.g. a "Manage usage" link). */
  footer?: ReactNode;
} & EngineAccountActions) {
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{title}</div>
          <div className="settings-row-sublabel">{description}</div>
        </div>
        <div className="settings-row-control">
          {addButton ?? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={onAdd}
              disabled={busy || adding}
            >
              {accounts.length === 0 ? "Connect" : addLabel}
            </Button>
          )}
        </div>
      </div>
      {accounts.map((row, index) => (
        <AccountRow
          key={row.id}
          row={row}
          divided={index > 0}
          busy={busy}
          actions={actions}
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
      {footer}
    </>
  );
}
