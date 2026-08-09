/**
 * Creator page. Lists every public add-on a creator has shared.
 *
 * Reachable via `/c/:username`. Author bylines on add-on cards link
 * here once the creator has a social profile.
 */
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/convex/api";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { useT, useTPlural } from "@/shared/i18n";
import type { StorePackageRecord } from "@/shared/types/electron";
import "./store.css";

type Props = { username: string };
const CREATOR_CACHE_TTL_MS = 10 * 60 * 1000;

export function CreatorPage({ username }: Props) {
  const t = useT();
  const tPlural = useTPlural();
  const navigate = useNavigate();
  // One-shot, not a subscription: visiting a creator's page is
  // read-only browsing — neither the profile nor their published
  // package list will move while the user is on the page.
  const profile = usePersistentConvexOneShot(
    api.social.profiles.getProfileByUsername,
    {
      username,
    },
    {
      scope: "public",
      ttlMs: CREATOR_CACHE_TTL_MS,
    },
  ) as { username: string } | null | undefined;
  const packages = usePersistentConvexOneShot(
    api.data.store_packages.listPackagesByAuthorUsername,
    { username },
    {
      scope: "public",
      ttlMs: CREATOR_CACHE_TTL_MS,
    },
  ) as StorePackageRecord[] | undefined;

  if (profile === undefined || packages === undefined) {
    return (
      <div className="store-creator-page">
        <div className="store-creator-loading">
          {t("features.store.creator.loading")}
        </div>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="store-creator-page">
        <div className="store-creator-empty">
          <div className="store-creator-empty-title">
            {t("features.store.creator.notFoundTitle")}
          </div>
          <div className="store-creator-empty-body">
            {t("features.store.creator.notFoundBodyPrefix")}{" "}
            <code>@{username}</code>{" "}
            {t("features.store.creator.notFoundBodySuffix")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="store-creator-page">
      <header className="store-creator-header">
        <div className="store-creator-handle">@{profile.username}</div>
        <div className="store-creator-count">
          {tPlural("features.store.creator.addonCount", packages.length)}
        </div>
      </header>

      {packages.length === 0 ? (
        <div className="store-creator-empty">
          <div className="store-creator-empty-body">
            {t("features.store.creator.noAddons", {
              username: `@${profile.username}`,
            })}
          </div>
        </div>
      ) : (
        <div className="store-grid">
          {packages.map((pkg) => (
            <div
              key={pkg.packageId}
              className="store-card"
              data-clickable="true"
              onClick={() =>
                void navigate({
                  to: "/store",
                  search: { tab: "discover", package: pkg.packageId },
                })
              }
            >
              <div className="store-card-body">
                <div className="store-card-top">
                  <span className="store-card-name">{pkg.displayName}</span>
                </div>
                <div className="store-card-desc">{pkg.description}</div>
                <div className="store-card-meta">
                  {t("features.store.creator.version", {
                    version: pkg.latestReleaseNumber,
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
