import { useCallback, useEffect, useState } from "react";
import type { EngineConnection, EngineSettings } from "@stella/contracts/backend/engines";
import type { ClaudeLocalConfig } from "@stella/contracts/claude-local-accounts";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { getDeviceIdOrNull } from "@/platform/electron/device-id";
import { cloudEnginesApi } from "@/features/cloud/cloud-engines-api";
import {
  accountInitials,
  EngineAccountHeader,
  EngineAccountRowView,
  formatPlan,
  type EngineAccountMenuItem,
  type EngineAccountPlace,
} from "@/features/cloud/EngineAccountRow";
import { ClaudeLoginPrompt } from "./ClaudeLoginPrompt";
import { useClaudeLocalAccounts } from "./use-claude-local-accounts";
import { useClaudeLogin, type ClaudeLoginTarget } from "./use-claude-login";

/**
 * The owner's Claude accounts. Stella keeps only who each account is and
 * which one is active; every place (each computer, and the owner's cloud)
 * runs Claude Code on its own sign-in, made with Claude Code's own
 * `claude auth login`. Each row shows where the account is signed in.
 * Switching is manual only: picking a row makes that account the active one.
 */

const K = "settings.engineAccounts";

const sameEmail = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function ClaudeAccountsSection({
  settings,
  refreshing,
  cloudAvailable,
}: {
  settings: EngineSettings | undefined;
  refreshing: boolean;
  /** The owner's cloud can hold a sign-in (they are signed in to Stella). */
  cloudAvailable: boolean;
}) {
  const t = useT();
  const local = useClaudeLocalAccounts();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { reload: reloadLocal } = local;

  useEffect(() => {
    if (!local.available) return;
    let cancelled = false;
    void getDeviceIdOrNull().then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [local.available]);

  const login = useClaudeLogin({
    onSignedIn: (result, target) => {
      showToast({
        title: result.email
          ? t(target.place === "cloud" ? `${K}.signedInCloudAs` : `${K}.signedInComputerAs`, {
              email: result.email,
            })
          : t(target.place === "cloud" ? `${K}.signedInCloud` : `${K}.signedInComputer`),
      });
      if (target.place === "local") void reloadLocal();
    },
  });

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await action();
        if (done) showToast({ title: done });
      } catch (error) {
        showToast({
          title: error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
          variant: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const startLogin = (target: ClaudeLoginTarget) => void login.start(target);
  const canSignInHere = local.available && local.cliInstalled;
  const accounts = (settings?.connections ?? []).filter(
    (row): row is EngineConnection => row.provider === "anthropic",
  );
  const localFor = (email: string | undefined): ClaudeLocalConfig | undefined =>
    local.configs.find((config) => config.loggedIn && sameEmail(config.email, email));
  const unlistedLocal = local.configs.filter(
    (config) =>
      config.loggedIn &&
      config.email &&
      !accounts.some((account) => sameEmail(account.email, config.email)),
  );
  const signedOutExtras = local.configs.filter(
    (config) => !config.isDefault && !config.loggedIn,
  );
  const disabled = busy || refreshing;

  const computerPlace = (config: ClaudeLocalConfig | undefined): EngineAccountPlace[] =>
    local.available
      ? [{ key: "computer", label: t(`${K}.placeComputer`), signedIn: Boolean(config) }]
      : [];
  const signOutHereItem = (config: ClaudeLocalConfig | undefined): EngineAccountMenuItem[] =>
    config && !config.isDefault
      ? [
          {
            key: "out-here",
            label: t(`${K}.signOutComputer`),
            onSelect: () =>
              void run(() => local.signOut(config.configId), t(`${K}.signedOut`)),
          },
        ]
      : [];

  const addControl =
    local.available && cloudAvailable ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={disabled || login.open}
          >
            {t(`${K}.addClaude`)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} collisionPadding={12}>
          <DropdownMenuItem
            disabled={!canSignInHere}
            onSelect={() => startLogin({ place: "local" })}
          >
            {t(`${K}.addOnComputer`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => startLogin({ place: "cloud" })}>
            {t(`${K}.addInCloud`)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <Button
        type="button"
        variant="ghost"
        className="pill-btn"
        disabled={disabled || login.open || (!cloudAvailable && !canSignInHere)}
        onClick={() => startLogin({ place: cloudAvailable ? "cloud" : "local" })}
      >
        {t(`${K}.addClaude`)}
      </Button>
    );

  return (
    <>
      <EngineAccountHeader title={t(`${K}.claudeTitle`)} control={addControl} />
      {accounts.map((account) => {
        const config = localFor(account.email);
        const places = account.places ?? [];
        const inCloud = places.some((place) => place.kind === "cloud");
        const others = places.flatMap((place) =>
          place.kind === "device" && place.deviceId !== deviceId
            ? [
                {
                  key: `device:${place.deviceId}`,
                  label: place.deviceName ?? t(`${K}.placeOtherComputer`),
                  signedIn: true,
                },
              ]
            : [],
        );
        const items: EngineAccountMenuItem[] = [];
        if (canSignInHere && !config) {
          items.push({
            key: "in-here",
            label: t(`${K}.signInComputer`),
            onSelect: () =>
              startLogin({ place: "local", ...(account.email ? { email: account.email } : {}) }),
          });
        }
        if (cloudAvailable && !inCloud) {
          items.push({
            key: "in-cloud",
            label: t(`${K}.signInCloud`),
            onSelect: () =>
              startLogin({ place: "cloud", ...(account.email ? { email: account.email } : {}) }),
          });
        }
        const tail: EngineAccountMenuItem[] = [...signOutHereItem(config)];
        if (inCloud) {
          tail.push({
            key: "out-cloud",
            label: t(`${K}.signOutCloud`),
            onSelect: () =>
              void run(
                () => cloudEnginesApi.signOutClaudeCloud(account.accountId),
                t(`${K}.signedOut`),
              ),
          });
        }
        tail.push({
          key: "remove",
          label: t(`${K}.remove`),
          onSelect: () =>
            void run(
              () => cloudEnginesApi.disconnect("anthropic", account.accountId),
              t(`${K}.removed`),
            ),
        });
        const title = account.email ?? account.label;
        const plan = formatPlan(account.plan);
        return (
          <EngineAccountRowView
            key={account.accountId}
            id={account.accountId}
            title={title}
            initials={accountInitials({ label: account.label, ...(account.email ? { email: account.email } : {}) })}
            {...(plan ? { subtitle: plan } : {})}
            places={[
              ...computerPlace(config),
              ...(cloudAvailable
                ? [{ key: "cloud", label: t(`${K}.placeCloud`), signedIn: inCloud }]
                : []),
              ...others,
            ]}
            active={account.active}
            busy={disabled}
            {...(account.active
              ? {}
              : {
                  onPick: () =>
                    void run(() =>
                      cloudEnginesApi.setActiveAccount("anthropic", account.accountId),
                    ),
                })}
            items={items}
            tail={tail}
          />
        );
      })}
      {unlistedLocal.map((config) => {
        const plan = formatPlan(config.plan);
        return (
          <EngineAccountRowView
            key={`local:${config.configId}`}
            id={`local:${config.configId}`}
            title={config.email!}
            initials={accountInitials({ label: config.email!, email: config.email! })}
            {...(plan ? { subtitle: plan } : {})}
            places={computerPlace(config)}
            active={false}
            busy={disabled}
            items={
              cloudAvailable
                ? [
                    {
                      key: "in-cloud",
                      label: t(`${K}.signInCloud`),
                      onSelect: () => startLogin({ place: "cloud", email: config.email! }),
                    },
                  ]
                : []
            }
            tail={signOutHereItem(config)}
          />
        );
      })}
      {signedOutExtras.map((config) => (
        <EngineAccountRowView
          key={`local:${config.configId}`}
          id={`local:${config.configId}`}
          title={t(`${K}.signedOutLogin`)}
          initials="?"
          subtitle={t(`${K}.placeComputer`)}
          active={false}
          busy={disabled}
          items={[
            {
              key: "again",
              label: t(`${K}.signInAgain`),
              onSelect: () => startLogin({ place: "local", configId: config.configId }),
            },
          ]}
          tail={[
            {
              key: "remove",
              label: t(`${K}.remove`),
              onSelect: () => void run(() => local.signOut(config.configId)),
            },
          ]}
        />
      ))}
      {local.loaded && !local.cliInstalled ? (
        <div className="settings-row">
          <div className="settings-row-sublabel">{t(`${K}.cliMissing`)}</div>
        </div>
      ) : canSignInHere && local.defaultSignedOut ? (
        <div className="settings-row">
          <div className="settings-row-sublabel">{t(`${K}.defaultSignedOut`)}</div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={disabled || login.open}
              onClick={() => startLogin({ place: "local", configId: "default" })}
            >
              {t(`${K}.signIn`)}
            </Button>
          </div>
        </div>
      ) : null}
      <ClaudeLoginPrompt login={login} />
    </>
  );
}
