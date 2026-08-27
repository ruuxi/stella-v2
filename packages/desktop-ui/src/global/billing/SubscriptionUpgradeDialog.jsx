import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCurrentUser } from "@/global/auth/hooks/use-current-user";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { uiState } from "@/platform/ui-state";
import { useT } from "@/shared/i18n";
import "./SubscriptionUpgradeDialog.css";
const PAID_PLANS = new Set([
    "go",
    "pro",
]);
const DEFAULT_PLAN_LABEL = {
    free: "Free",
    go: "Go",
    pro: "Pro",
};
const planLabelOf = (plan, status) => status?.plans?.[plan]?.label ?? DEFAULT_PLAN_LABEL[plan];
const storageKeyFor = (accountKey) => `stella-billing-last-seen-plan:${accountKey}`;

export const SUBSCRIPTION_UPGRADED_EVENT = "stella:subscription-upgraded";

export function SubscriptionUpgradeDialog() {
    const t = useT();
    const { hasConnectedAccount } = useAuthSessionState();
    const { user } = useCurrentUser();

    const accountKey = user?.email?.toLowerCase() ?? "";
    const billingStatus = useQuery(api.billing.getSubscriptionStatus, hasConnectedAccount ? {} : "skip");
    const [shownPlan, setShownPlan] = useState(null);

    const lastProcessedRef = useRef(null);
    useEffect(() => {
        if (!hasConnectedAccount) {
            lastProcessedRef.current = null;
            return;
        }
        if (!accountKey)
            return;
        if (billingStatus && billingStatus.authenticated === false)
            return;
        const plan = billingStatus?.plan;
        if (!plan)
            return;
        const fingerprint = `${accountKey}|${plan}`;
        if (lastProcessedRef.current === fingerprint)
            return;
        lastProcessedRef.current = fingerprint;
        const storageKey = storageKeyFor(accountKey);
        let stored = null;
        const raw = uiState.getItem(storageKey);
        if (raw && raw in DEFAULT_PLAN_LABEL) {
            stored = raw;
        }
        if (stored === plan)
            return;
        uiState.setItem(storageKey, plan);

        if (stored === null)
            return;

        if (!PAID_PLANS.has(plan))
            return;
        setShownPlan(plan);
        window.dispatchEvent(new CustomEvent(SUBSCRIPTION_UPGRADED_EVENT));
    }, [accountKey, billingStatus, hasConnectedAccount]);
    const onClose = useCallback(() => setShownPlan(null), []);
    const message = useMemo(() => {
        if (!shownPlan)
            return null;
        const label = planLabelOf(shownPlan, billingStatus);
        return {
            title: t("billing.upgradeDialog.title", { plan: label }),
            description: t("billing.upgradeDialog.description"),
        };
    }, [billingStatus, shownPlan, t]);
    if (!message)
        return null;
    return (<Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent fit className="subscription-upgrade-dialog">
        <DialogHeader>
          <DialogTitle>{message.title}</DialogTitle>
          <DialogDescription>{message.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="subscription-upgrade-dialog-body">
          <div className="subscription-upgrade-actions">
            <Button type="button" variant="primary" className="pill-btn pill-btn--primary" onClick={onClose}>
              {t("billing.upgradeDialog.cta")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>);
}
