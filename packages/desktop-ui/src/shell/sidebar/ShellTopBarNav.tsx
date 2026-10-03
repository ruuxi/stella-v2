import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import { preloadNavSurfaceRoute } from "@/shell/topbar/nav-surface-preloads";
import { useT } from "@/shared/i18n";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "./app-registry";
import "./topbar-nav.css";

// App discovery happens in `./app-registry`, which owns the glob over
// `desktop/src/app/<id>/metadata.ts` and exposes a subscribable snapshot.
const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

interface NavItemProps {
  app: AppMetadata;
  /** Route-matched (drives re-entry click + selected text/aria). */
  active: boolean;
  badgeCount?: number;
}

const NavItem = ({
  app,
  active,
  badgeCount = 0,
}: NavItemProps) => {
  const t = useT();
  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const router = useRouter();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadNavSurfaceRoute(app.id);
      if (active && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
        return;
      }
      // Entering from outside: the app may redirect its nav click.
      if (!active && app.resolveClickRoute) {
        const to = app.resolveClickRoute();
        if (to !== app.route) {
          event.preventDefault();
          void router.navigate({ to });
        }
      }
    },
    [active, app, router],
  );

  return (
    <Link
      to={app.route}
      className="shell-topbar-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={handleClick}
      onFocus={() => preloadNavSurfaceRoute(app.id)}
      onMouseEnter={() => preloadNavSurfaceRoute(app.id)}
      title={
        showBadge
          ? t("shell.sidebar.nav.unreadTitle", {
              label: app.label,
              count: badgeCount,
            })
          : app.label
      }
      aria-label={
        showBadge
          ? t("shell.sidebar.nav.unreadAriaLabel", {
              label: app.label,
              count: badgeCount,
            })
          : app.label
      }
    >
      <span className="shell-topbar-nav-label">{app.label}</span>
      {showBadge && (
        <span className="shell-topbar-nav-badge" aria-hidden="true">
          {badgeLabel}
        </span>
      )}
    </Link>
  );
};

type ShellTopBarPrimaryNavProps = {
  /**
   * Nav entry ids to suppress. The full-window bar omits surfaces owned by
   * the right sidebar.
   */
  omitIds?: readonly string[];
};

export const ShellTopBarPrimaryNav = ({
  omitIds,
}: ShellTopBarPrimaryNavProps = {}) => {
  const t = useT();
  const allApps = useRegisteredApps();
  const navApps = useMemo(
    () =>
      allApps.filter(
        (a) =>
          !a.hideFromSidebar &&
          a.slot === "top" &&
          !(omitIds?.includes(a.id) ?? false),
      ),
    [allApps, omitIds],
  );

  const matchRoute = useMatchRoute();

  // The route-matched app drives the re-entry click + the plain-text
  // selected state (stronger color + weight — deliberately no pill fill).
  const matchedApp = navApps.find((a) =>
    Boolean(matchRoute({ to: a.route, fuzzy: true })),
  );
  const matchedId = matchedApp?.id ?? null;

  if (navApps.length === 0) {
    return null;
  }

  return (
    <nav className="shell-topbar-nav" aria-label={t("shell.sidebar.nav.apps")}>
      {navApps.map((app) => (
        <NavItem
          key={app.id}
          app={app}
          active={matchedId === app.id}
        />
      ))}
    </nav>
  );
};
