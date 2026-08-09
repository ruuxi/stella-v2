/**
 * The full-page user-app library.
 *
 * Apps themselves open in the right sidebar's Apps section, which also carries
 * its own library list. This route remains available to deep links, but picking
 * an app here still hands off to the sidebar rather than rendering it inline,
 * so there is exactly one place a user app is ever mounted.
 */
import { useDeferredValue, useMemo, useState, useSyncExternalStore, } from "react";
import { Search } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { Select } from "@/ui/select";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { getServerSnapshot, getSnapshot, refreshUserApps, subscribe, } from "./user-apps-registry";
import { AppCreationIllustration } from "./AppCreationIllustration";
import { formatUserAppCreatedAt, listUserApps, USER_APP_SORT_LABELS, useRequestUserApp, type UserAppSort, } from "./user-app-library";
import "./apps.css";
function useUserApps() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
export function AppsApp() {
    const t = useT();
    const registry = useUserApps();
    const { apps, error, phase, refreshing } = registry;
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<UserAppSort>("recent");
    const deferredQuery = useDeferredValue(query);
    const handleCreateApp = useRequestUserApp();
    const visible = useMemo(() => listUserApps(apps, deferredQuery, sort), [apps, deferredQuery, sort]);
    const hasApps = apps.length > 0;
    if (phase === "loading" && !hasApps) {
        return (<main className="apps-screen apps-screen--status" role="status" aria-live="polite">
        {t("app.apps.loading")}
      </main>);
    }
    if (phase === "unsupported") {
        return (<main className="apps-screen apps-screen--status" role="status">
        <h1 className="apps-screen__empty-title">{t("app.apps.unsupportedTitle")}</h1>
        <p className="apps-screen__empty-body">
          {t("app.apps.unsupportedBody")}
        </p>
      </main>);
    }
    if (phase === "error" && !hasApps) {
        return (<main className="apps-screen apps-screen--status" role="alert">
        <h1 className="apps-screen__empty-title">{t("app.apps.errorTitle")}</h1>
        <p className="apps-screen__empty-body">
          {error || t("app.apps.errorBody")}
        </p>
        <button type="button" className="pill-btn pill-btn--primary pill-btn--lg" onClick={() => void refreshUserApps()}>
          {t("app.apps.tryAgain")}
        </button>
      </main>);
    }
    return (<main className="apps-screen" aria-busy={refreshing || undefined}>
      {hasApps ? (<header className="apps-screen__hero">
          <h1 className="apps-screen__title">
            <em>{t("app.apps.heroTitleEmphasis")}</em> {t("app.apps.heroTitleRest")}
          </h1>
        </header>) : null}

      {hasApps ? (<>
          {phase === "error" ? (<div className="apps-screen__warning" role="status">
              <span>{t("app.apps.staleWarning")}</span>
              <button type="button" className="pill-btn" onClick={() => void refreshUserApps()}>
                {t("app.apps.tryAgain")}
              </button>
            </div>) : null}
          <div className="apps-screen__toolbar">
            <label className="apps-screen__search">
              <Search size={14} className="apps-screen__search-icon" aria-hidden/>
              <input type="search" placeholder={t("app.apps.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="apps-screen__search-input"/>
            </label>
            <div className="apps-screen__sort">
              <span className="apps-screen__sort-label">{t("app.apps.sortLabel")}</span>
              <Select className="apps-screen__sort-trigger" value={sort} onValueChange={(value) => setSort(value as UserAppSort)} options={(Object.keys(USER_APP_SORT_LABELS) as UserAppSort[]).map((option) => ({
                value: option,
                label: t(USER_APP_SORT_LABELS[option]),
            }))} aria-label={t("app.apps.sortLabel")}/>
            </div>
            <button type="button" className="pill-btn pill-btn--lg" onClick={handleCreateApp}>
              {t("app.apps.createApp")}
            </button>
          </div>

          {visible.length === 0 ? (<div className="apps-screen__no-match">
              {t("app.apps.noMatchPrefix")} <span className="apps-screen__no-match-query">"{deferredQuery}"</span>{t("app.apps.noMatchSuffix")}
            </div>) : (<ul className="apps-screen__grid">
              {visible.map((app) => (<li key={app.slug} className="apps-card">
                  <button type="button" className="apps-card__link" onClick={() => sidebarSections.openLocation("apps", app.slug)}>
                    <span className="apps-card__label">{app.meta.label}</span>
                    <span className="apps-card__meta">
                      {formatUserAppCreatedAt(app.meta.createdAt)}
                    </span>
                  </button>
                </li>))}
            </ul>)}
        </>) : (<section className="apps-screen__empty" aria-labelledby="apps-empty-title">
          <div className="apps-screen__empty-illustration">
            <AppCreationIllustration />
          </div>
          <h2 id="apps-empty-title" className="apps-screen__empty-title">
            {t("app.apps.emptyTitle")}
          </h2>
          <p className="apps-screen__empty-body">
            {t("app.apps.emptyBody")}
          </p>
          <button type="button" className="pill-btn pill-btn--primary pill-btn--lg" onClick={handleCreateApp}>
            {t("app.apps.emptyAction")}
          </button>
        </section>)}
    </main>);
}
