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
import { MoreHorizontal } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import "./engine-accounts.css";

/**
 * One provider's accounts: who each account is, which one is in use, and
 * (for ChatGPT) which saved accounts are signed out or need a new sign-in.
 * A usage limit never switches accounts; the user picks the active one.
 */
export type EngineAccountRow = {
  id: string;
  /** Shown when the provider did not share an email. */
  label: string;
  email?: string;
  plan?: string;
  active: boolean;
  /** Absent while signed in. */
  status?: "signed_out" | "reauth_required";
  /** ChatGPT: false when the sign-in didn't grant ChatGPT plan use. */
  planUsage?: boolean;
};

export type EngineAccountMenuItem = { key: string; label: string; onSelect: () => void };

const K = "settings.engineAccounts";

export const accountInitials = (row: { email?: string; label: string }): string => {
  const source = (row.email ?? row.label).split("@")[0] ?? "";
  const words = source.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase() || "?";
};

/** "max" → "Max": plans as the provider reports them, capitalized. */
export const formatPlan = (plan: string | undefined): string | undefined =>
  plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : undefined;

/** The title row of an account list: what it is, plus its add control. */
export function EngineAccountHeader({
  title,
  description,
  control,
}: {
  title: string;
  description: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{title}</div>
        <div className="settings-row-sublabel">{description}</div>
      </div>
      {control ? <div className="settings-row-control">{control}</div> : null}
    </div>
  );
}

/** One account: avatar, name, a detail line, the Active badge and its menu. */
export function EngineAccountRowView({
  id,
  title,
  initials,
  subtitle,
  detail,
  active,
  busy,
  items,
  tail = [],
  divided,
}: {
  id: string;
  title: string;
  initials: string;
  subtitle?: string;
  /** Extra content under the subtitle (e.g. where the account is signed in). */
  detail?: ReactNode;
  active: boolean;
  busy: boolean;
  items: EngineAccountMenuItem[];
  /** Destructive items, after a separator. */
  tail?: EngineAccountMenuItem[];
  divided: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className="settings-row"
      style={divided ? undefined : { borderTop: "none" }}
      data-engine-account={id}
    >
      <div
        className="settings-row-info"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <Avatar fallback={initials} size="small" />
        <div style={{ minWidth: 0 }}>
          <div
            className="settings-row-label"
            style={{ overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {title}
          </div>
          {subtitle ? <div className="settings-row-sublabel">{subtitle}</div> : null}
          {detail}
        </div>
      </div>
      <div
        className="settings-row-control"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {active ? <span className="engine-account-badge">{t(`${K}.active`)}</span> : null}
        {items.length + tail.length > 0 ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="pill-btn"
                aria-label={t(`${K}.moreLabel`, { name: title })}
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
        ) : null}
      </div>
    </div>
  );
}

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

/** A ChatGPT account list (this computer's, or the cloud's). */
export function EngineAccountList({
  title,
  description,
  accounts,
  busy,
  adding,
  onAdd,
  addButton,
  addFlow,
  footer,
  ...actions
}: {
  title: string;
  description: ReactNode;
  accounts: readonly EngineAccountRow[];
  busy: boolean;
  adding: boolean;
  onAdd: () => void;
  /** Replaces the default add button (e.g. "Continue with ChatGPT"). */
  addButton?: ReactNode;
  /** Extra UI while an account is being added (e.g. a paste-back field). */
  addFlow?: ReactNode;
  /** Shown under the list (e.g. a "Manage usage" link). */
  footer?: ReactNode;
} & EngineAccountActions) {
  const t = useT();
  const statusText = (row: EngineAccountRow): string | undefined =>
    row.status === "signed_out"
      ? t(`${K}.statusSignedOut`)
      : row.status === "reauth_required"
        ? t(`${K}.statusReauth`)
        : row.planUsage === false
          ? t(`${K}.statusPlanUsageOff`)
          : undefined;

  return (
    <>
      <EngineAccountHeader
        title={title}
        description={description}
        control={
          addButton ?? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={onAdd}
              disabled={busy || adding}
            >
              {accounts.length === 0 ? t(`${K}.connect`) : t(`${K}.addAccount`)}
            </Button>
          )
        }
      />
      {accounts.map((row, index) => {
        const usable = !row.status && row.planUsage !== false;
        const items: EngineAccountMenuItem[] = [];
        if (usable && !row.active) {
          items.push({ key: "use", label: t(`${K}.useAccount`), onSelect: () => actions.onUse(row.id) });
        }
        if (row.status && actions.onSignInAgain) {
          items.push({
            key: "again",
            label: t(`${K}.signInAgain`),
            onSelect: () => actions.onSignInAgain!(row.id),
          });
        }
        if (!row.status && row.planUsage === false && actions.onEnablePlanUsage) {
          items.push({
            key: "enable",
            label: t(`${K}.enablePlanUsage`),
            onSelect: () => actions.onEnablePlanUsage!(row.id),
          });
        }
        const tail: EngineAccountMenuItem[] = [];
        if (row.status !== "signed_out") {
          tail.push({ key: "out", label: t(`${K}.signOut`), onSelect: () => actions.onSignOut(row.id) });
        }
        if (actions.onRemove) {
          tail.push({ key: "remove", label: t(`${K}.remove`), onSelect: () => actions.onRemove!(row.id) });
        }
        const subtitle = [formatPlan(row.plan), statusText(row)].filter(Boolean).join(" · ");
        return (
          <EngineAccountRowView
            key={row.id}
            id={row.id}
            title={row.email ?? row.label}
            initials={accountInitials(row)}
            {...(subtitle ? { subtitle } : {})}
            active={row.active}
            busy={busy}
            items={items}
            tail={tail}
            divided={index > 0}
          />
        );
      })}
      {addFlow}
      {footer}
    </>
  );
}
