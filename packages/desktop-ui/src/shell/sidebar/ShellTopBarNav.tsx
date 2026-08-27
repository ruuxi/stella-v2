import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import {
  markAllUserAppsSeen,
  useNewUserAppsHint,
} from "@/app/apps/new-user-apps-hint";
import { preloadNavSurfaceRoute } from "@/shell/topbar/nav-surface-preloads";
import { useT } from "@/shared/i18n";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "./app-registry";
import "./topbar-nav.css";

const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

interface NavItemProps {
  app: AppMetadata;

  active: boolean;
  badgeCount?: number;
  showHintDot?: boolean;
  onHintDismiss?: () => void;
}

const NavItem = ({
  app,
  active,
  badgeCount = 0,
  showHintDot = false,
  onHintDismiss,
}: NavItemProps) => {
  const t = useT();
  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const showHint = showHintDot && !showBadge;
  const router = useRouter();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadNavSurfaceRoute(app.id);
      if (showHint) onHintDismiss?.();
      if (active && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
        return;
      }

      if (!active && app.resolveClickRoute) {
        const to = app.resolveClickRoute();
        if (to !== app.route) {
          event.preventDefault();
          void router.navigate({ to });
        }
      }
    },
    [active, app, router, showHint, onHintDismiss],
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
      {showHint && (
        <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
      )}
    </Link>
  );
};

type ShellTopBarPrimaryNavProps = {

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

  const newAppsHint = useNewUserAppsHint();
  const matchRoute = useMatchRoute();
  const onAppsRoute = Boolean(matchRoute({ to: "/apps", fuzzy: true }));

  const matchedApp = navApps.find((a) =>
    Boolean(matchRoute({ to: a.route, fuzzy: true })),
  );
  const matchedId = matchedApp?.id ?? null;

  useEffect(() => {
    if (newAppsHint.active && onAppsRoute) {
      markAllUserAppsSeen();
    }
  }, [newAppsHint.active, onAppsRoute]);

  const hintFor = useCallback(
    (app: AppMetadata) => {
      if (app.id === "apps") return newAppsHint.active;
      return false;
    },
    [newAppsHint.active],
  );

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
          showHintDot={hintFor(app)}
          onHintDismiss={() => {
            if (app.id === "apps") markAllUserAppsSeen();
          }}
        />
      ))}
    </nav>
  );
};
