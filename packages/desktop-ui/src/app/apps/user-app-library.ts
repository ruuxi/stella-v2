import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useT } from "@/shared/i18n";
import { dispatchComposeText } from "@/shared/lib/stella-orb-chat";
import type { UserApp } from "@/app/apps/user-apps-registry";

export type UserAppSort = "recent" | "name";

export const USER_APP_SORT_LABELS: Record<UserAppSort, string> = {
  recent: "app.apps.sort.recent",
  name: "app.apps.sort.name",
};

export const isUserAppSort = (value: string): value is UserAppSort =>
  value === "recent" || value === "name";

const RELATIVE_UNITS: ReadonlyArray<{
  ms: number;
  unit: Intl.RelativeTimeFormatUnit;
}> = [
  { ms: 60 * 1000, unit: "second" },
  { ms: 60 * 60 * 1000, unit: "minute" },
  { ms: 24 * 60 * 60 * 1000, unit: "hour" },
  { ms: 7 * 24 * 60 * 60 * 1000, unit: "day" },
  { ms: 30 * 24 * 60 * 60 * 1000, unit: "week" },
  { ms: 365 * 24 * 60 * 60 * 1000, unit: "month" },
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function formatUserAppCreatedAt(iso: string): string {
  const created = new Date(iso).getTime();
  if (!Number.isFinite(created)) return "";
  const diff = created - Date.now();
  const abs = Math.abs(diff);
  for (let i = 0; i < RELATIVE_UNITS.length - 1; i++) {
    const current = RELATIVE_UNITS[i]!;
    const next = RELATIVE_UNITS[i + 1]!;
    if (abs < next.ms) {
      return relativeTimeFormatter.format(
        Math.round(diff / current.ms),
        current.unit,
      );
    }
  }
  const last = RELATIVE_UNITS[RELATIVE_UNITS.length - 1]!;
  return relativeTimeFormatter.format(Math.round(diff / last.ms), last.unit);
}

export function listUserApps(
  apps: readonly UserApp[],
  query: string,
  sort: UserAppSort,
): readonly UserApp[] {
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? apps.filter(
        (app) =>
          app.meta.label.toLowerCase().includes(trimmed) ||
          app.slug.toLowerCase().includes(trimmed),
      )
    : apps.slice();
  if (sort === "name") {
    filtered.sort((a, b) => a.meta.label.localeCompare(b.meta.label));
  } else {
    filtered.sort((a, b) => {
      const at = Date.parse(a.meta.createdAt);
      const bt = Date.parse(b.meta.createdAt);
      const av = Number.isFinite(at) ? at : 0;
      const bv = Number.isFinite(bt) ? bt : 0;
      return bv - av;
    });
  }
  return filtered;
}

export function useRequestUserApp(): () => void {
  const navigate = useNavigate();
  const t = useT();
  return useCallback(() => {
    void navigate({ to: "/chat" }).then(() => {
      requestAnimationFrame(() => {
        dispatchComposeText({ text: t("app.apps.createAppPrompt") });
      });
    });
  }, [navigate, t]);
}
