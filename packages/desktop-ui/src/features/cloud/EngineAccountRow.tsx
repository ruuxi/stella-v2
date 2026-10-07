import { useState, type ReactNode } from "react";
import { Avatar } from "@/ui/avatar";
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
 * The row primitives both provider sections use. One row is one account of
 * the owner's: who it is, where it is signed in, and whether it is the one
 * in use. Picking the account is the row itself; everything destructive is
 * behind its menu.
 */

export type EngineAccountMenuItem = { key: string; label: string; onSelect: () => void };

/** Where an account is signed in: this computer, the cloud, another computer. */
export type EngineAccountPlace = { key: string; label: string; signedIn: boolean };

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

export function EngineAccountPlaces({ places }: { places: EngineAccountPlace[] }) {
  const t = useT();
  if (places.length === 0) return null;
  return (
    <div className="engine-account-places">
      {places.map((place) => (
        <span
          key={place.key}
          className="engine-account-place"
          data-signed-in={place.signedIn || undefined}
          aria-label={t(place.signedIn ? `${K}.placeSignedIn` : `${K}.placeSignedOut`, {
            place: place.label,
          })}
          title={t(place.signedIn ? `${K}.placeSignedIn` : `${K}.placeSignedOut`, {
            place: place.label,
          })}
        >
          {place.label}
        </span>
      ))}
    </div>
  );
}

/** The title row of an account list: what it is, plus its add control. */
export function EngineAccountHeader({
  title,
  description,
  control,
}: {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{title}</div>
        {description ? <div className="settings-row-sublabel">{description}</div> : null}
      </div>
      {control ? <div className="settings-row-control">{control}</div> : null}
    </div>
  );
}

/**
 * One account: avatar, name, where it is signed in, the Active badge and its
 * menu. Clicking the row makes the account the active one — no menu hop —
 * while sign-out and remove stay behind the menu.
 */
export function EngineAccountRowView({
  id,
  title,
  initials,
  subtitle,
  places = [],
  active,
  busy,
  onPick,
  items,
  tail = [],
  divided,
}: {
  id: string;
  title: string;
  initials: string;
  subtitle?: string;
  places?: EngineAccountPlace[];
  active: boolean;
  busy: boolean;
  /** Make this the active account. Absent when it cannot serve turns yet. */
  onPick?: () => void;
  items: EngineAccountMenuItem[];
  /** Destructive items, after a separator. */
  tail?: EngineAccountMenuItem[];
  divided: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = (
    <>
      <Avatar fallback={initials} size="small" />
      <div className="engine-account-identity__text">
        <div className="settings-row-label">{title}</div>
        {subtitle ? <div className="settings-row-sublabel">{subtitle}</div> : null}
        <EngineAccountPlaces places={places} />
      </div>
    </>
  );
  return (
    <div
      className="settings-row"
      style={divided ? undefined : { borderTop: "none" }}
      data-engine-account={id}
    >
      {onPick && !active ? (
        <button
          type="button"
          className="settings-row-info engine-account-identity engine-account-identity--pick"
          onClick={onPick}
          disabled={busy}
          title={t(`${K}.useAccount`)}
          aria-label={`${t(`${K}.useAccount`)}: ${title}`}
        >
          {identity}
        </button>
      ) : (
        <div className="settings-row-info engine-account-identity">{identity}</div>
      )}
      <div className="engine-account-controls settings-row-control">
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
