import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

export const USER_APP_TEARDOWN_MS = 30 * 60 * 1000;

export const MAX_RETAINED_USER_APPS = 3;

export const promoteRetainedUserApp = (
  retained: readonly string[],
  slug: string,
): readonly string[] => {
  if (retained[0] === slug) return retained;
  return [slug, ...retained.filter((entry) => entry !== slug)].slice(
    0,
    MAX_RETAINED_USER_APPS,
  );
};

export const countingDownUserApps = (
  retained: readonly string[],
  onScreenSlug: string | null,
): readonly string[] => retained.filter((slug) => slug !== onScreenSlug);

export const mountedUserApps = (
  retained: readonly string[],
  onScreenSlug: string | null,
): readonly string[] =>
  onScreenSlug === null || retained.includes(onScreenSlug)
    ? retained
    : [onScreenSlug, ...retained].slice(0, MAX_RETAINED_USER_APPS);

export type UserAppVisibilityContext = {

  activeSlug: string | null;
  activeSection: SidebarSection;
  panelOpen: boolean;
};

export const onScreenUserAppSlug = ({
  activeSlug,
  activeSection,
  panelOpen,
}: UserAppVisibilityContext): string | null =>
  panelOpen && activeSection === "apps" ? activeSlug : null;
