import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CreditCard, LogOut, Settings } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import {
  preloadAuthDialog,
  preloadBillingScreen,
} from "@/shell/topbar/nav-surface-preloads";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { useNickname } from "@/global/auth/hooks/use-nickname";
import { secureSignOut } from "@/global/auth/services/auth";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { CustomLogIn as LogIn } from "@/ui/nav-icons";
import { useSettingsMenu } from "@/shell/topbar/use-settings-menu";
import "./topbar-nav.css";
import "./account-dialogs.css";

const PlanUsageDialog = lazy(() =>
  import("@/global/billing/PlanUsageDialog").then((module) => ({
    default: module.PlanUsageDialog,
  })),
);

type BillingPlanId = "free" | "go" | "pro" | "plus" | "ultra";

type BillingStatusLite = {
  plan?: BillingPlanId;
  plans?: Partial<Record<BillingPlanId, { label?: string }>>;
};

const planLabel = (
  plan: BillingPlanId | undefined,
  status: BillingStatusLite | undefined,
): string | undefined => {
  if (!plan) return "Free";
  const live = status?.plans?.[plan]?.label;
  if (live) return live;
  switch (plan) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "pro":
      return "Pro";
  }
};

interface ShellTopBarAccountProps {
  onSignIn?: () => void;
}

export const ShellTopBarAccount = ({ onSignIn }: ShellTopBarAccountProps) => {
  const t = useT();
  const { user: convexUser, hasConnectedAccount } = useCurrentUser();
  const { cacheScope, user: sessionUser } = useAuthSessionState();
  const { nickname } = useNickname();
  const user = {
    email: convexUser?.email ?? sessionUser?.email ?? undefined,
    name: convexUser?.name ?? sessionUser?.name ?? undefined,
  };

  const [billingQueryReady, setBillingQueryReady] = useState(false);
  useEffect(() => {
    const scheduleIdle =
      window.requestIdleCallback ??
      ((callback: IdleRequestCallback) =>
        window.setTimeout(
          () =>
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            } as IdleDeadline),
          1,
        ));
    const cancelIdle =
      window.cancelIdleCallback ??
      ((handle: number) => window.clearTimeout(handle));
    const handle = scheduleIdle(() => setBillingQueryReady(true));
    return () => cancelIdle(handle);
  }, []);

  const [billingRefreshKey, setBillingRefreshKey] = useState(0);
  useEffect(() => {
    const handler = () => setBillingRefreshKey((n) => n + 1);
    window.addEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
    return () =>
      window.removeEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
  }, []);

  const billingStatus = usePersistentConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount && billingQueryReady ? {} : "skip",
    {
      scope: cacheScope,
      ttlMs: 5 * 60 * 1000,
      refreshKey: billingRefreshKey,
    },
  ) as BillingStatusLite | undefined;

  const pendingSignOutRef = useRef(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [planUsageOpen, setPlanUsageOpen] = useState(false);

  // Settings destinations are folded into this menu while signed in, so its
  // close handler has to service both handoffs: a queued Theme/Connectors
  // popover and the sign-out confirmation.
  const {
    destinations: settingsDestinations,
    connectHint,
    applyPendingPopover,
    popovers: settingsPopovers,
  } = useSettingsMenu();

  const handleDropdownCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (applyPendingPopover()) return;
    if (!pendingSignOutRef.current) return;
    pendingSignOutRef.current = false;
    setSignOutConfirmOpen(true);
  };

  const handleConfirmSignOut = useCallback(() => {
    setSignOutConfirmOpen(false);
    void secureSignOut();
  }, []);

  if (!hasConnectedAccount) {
    return (
      <div className="shell-topbar-account">
        <button
          type="button"
          className="shell-topbar-account-signin"
          onClick={() => {
            preloadAuthDialog();
            onSignIn?.();
          }}
          onFocus={preloadAuthDialog}
          onMouseEnter={preloadAuthDialog}
          title={t("sidebar.signIn")}
          aria-label={t("sidebar.signIn")}
        >
          <span className="shell-topbar-account-signin-icon">
            <LogIn size={14} />
          </span>
          <span className="shell-topbar-account-signin-label">
            {t("sidebar.signIn")}
          </span>
        </button>
      </div>
    );
  }

  const accountName =
    (user.name ?? user.email ?? t("sidebar.account")).trim() ||
    t("sidebar.account");
  const displayLabel = nickname.trim() || accountName;
  const sidebarPlanLabel = billingQueryReady
    ? planLabel(billingStatus?.plan, billingStatus)
    : null;

  return (
    <div className="shell-topbar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shell-topbar-account-trigger"
            title={
              displayLabel === accountName
                ? sidebarPlanLabel
                  ? `${accountName} · ${sidebarPlanLabel}`
                  : accountName
                : sidebarPlanLabel
                  ? `${displayLabel} · ${accountName} · ${sidebarPlanLabel}`
                  : `${displayLabel} · ${accountName}`
            }
            aria-label={
              sidebarPlanLabel
                ? t("shell.sidebar.account.planAriaLabel", {
                    name: displayLabel,
                    plan: sidebarPlanLabel,
                  })
                : displayLabel
            }
          >
            <span className="shell-topbar-account-identity">
              <span className="shell-topbar-account-nickname">
                {displayLabel}
              </span>
              {sidebarPlanLabel ? (
                <span className="shell-topbar-account-plan">
                  {sidebarPlanLabel}
                </span>
              ) : null}
            </span>
            {/* The gear is a pure clickability affordance — the whole button
                is the single click target that opens the unified menu. */}
            <span
              className="shell-topbar-account-settings-icon"
              aria-hidden="true"
            >
              <Settings size={14} strokeWidth={1.75} />
            </span>
            {connectHint.active ? (
              <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="shell-settings-menu"
          side="bottom"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={handleDropdownCloseAutoFocus}
        >
          {settingsDestinations.map(
            ({ id, label, Icon, onSelect, hint }, index) => (
              <Fragment key={id}>
                <DropdownMenuItem onSelect={onSelect}>
                  <span data-slot="dropdown-menu-item-icon">
                    <Icon size={15} strokeWidth={1.75} />
                    {hint ? (
                      <span
                        className="shell-topbar-nav-hint-dot shell-settings-menu-item-hint-dot"
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  {label}
                </DropdownMenuItem>
                {index === 0 ? (
                  <DropdownMenuItem
                    onClick={() => setPlanUsageOpen(true)}
                    onMouseEnter={preloadBillingScreen}
                    onFocus={preloadBillingScreen}
                  >
                    <span data-slot="dropdown-menu-item-icon">
                      <CreditCard size={15} strokeWidth={1.75} />
                    </span>
                    Plan &amp; usage
                  </DropdownMenuItem>
                ) : null}
              </Fragment>
            ),
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-variant="destructive"
            onClick={() => {
              pendingSignOutRef.current = true;
            }}
          >
            <span data-slot="dropdown-menu-item-icon">
              <LogOut size={15} strokeWidth={1.75} />
            </span>
            {t("common.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {settingsPopovers}
      {planUsageOpen ? (
        <Suspense fallback={null}>
          <PlanUsageDialog open onOpenChange={setPlanUsageOpen} />
        </Suspense>
      ) : null}
      <Dialog open={signOutConfirmOpen} onOpenChange={setSignOutConfirmOpen}>
        <DialogContent
          fit
          className="sidebar-signout-dialog"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{t("shell.sidebar.account.signOutTitle")}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="sidebar-signout-description">
            {t("shell.sidebar.account.signOutDescription")}
          </DialogDescription>
          <div className="sidebar-confirm-actions">
            <Button
              variant="ghost"
              size="large"
              className="pill-btn pill-btn--lg"
              onClick={() => setSignOutConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={handleConfirmSignOut}
              data-tone="destructive"
              className="pill-btn pill-btn--danger pill-btn--lg"
            >
              {t("common.signOut")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
