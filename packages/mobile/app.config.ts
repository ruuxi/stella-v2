import type { ConfigContext, ExpoConfig } from "expo/config";

const read = (name: string): string | undefined => process.env[name]?.trim() || undefined;

type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

export default ({ config }: ConfigContext): ExpoConfig => {
  const owner = read("STELLA_MOBILE_OWNER");
  const slug = read("STELLA_MOBILE_SLUG");
  const projectId = read("STELLA_MOBILE_EAS_PROJECT_ID");
  const appleTeamId = read("STELLA_MOBILE_APPLE_TEAM_ID");
  const bundleId = read("STELLA_MOBILE_IOS_BUNDLE_ID");
  const androidPackage = read("STELLA_MOBILE_ANDROID_PACKAGE");
  const scheme = read("EXPO_PUBLIC_STELLA_MOBILE_SCHEME");
  const base = config as ExpoConfig;
  if (![owner, slug, projectId, appleTeamId, bundleId, androidPackage, scheme].some(Boolean)) return base;

  const next: ExpoConfig = { ...base };
  if (owner) next.owner = owner;
  if (slug) next.slug = slug;
  if (scheme) next.scheme = scheme;
  if (projectId) {
    next.updates = { ...base.updates, url: `https://u.expo.dev/${projectId}` };
    next.extra = { ...base.extra, eas: { ...base.extra?.eas, projectId } };
  }
  if (androidPackage) next.android = { ...base.android, package: androidPackage };
  if (appleTeamId || bundleId) {
    next.ios = { ...base.ios };
    if (appleTeamId) next.ios.appleTeamId = appleTeamId;
    if (bundleId) {
      const group = `group.${bundleId}`;
      next.ios.bundleIdentifier = bundleId;
      next.ios.entitlements = {
        ...base.ios?.entitlements,
        "com.apple.security.application-groups": [group],
      };
      next.plugins = (base.plugins ?? []).map((entry): PluginEntry =>
        Array.isArray(entry) && entry[0] === "expo-widgets"
          ? [entry[0], { ...entry[1], bundleIdentifier: `${bundleId}.LiveActivities`, groupIdentifier: group }]
          : entry,
      );
    }
  }
  return next;
};
