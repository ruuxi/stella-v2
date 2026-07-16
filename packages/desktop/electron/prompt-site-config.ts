import { readConfiguredConvexSiteUrl } from "@stella/contracts/convex-urls";
import desktopBuildConfig from "../config/app-config.json" with { type: "json" };

export type DesktopBuildConfig = {
  convexSiteUrl?: string | null;
};

export const resolvePackagedPromptSiteUrl = (
  config: DesktopBuildConfig = desktopBuildConfig,
): string | null => readConfiguredConvexSiteUrl(config.convexSiteUrl);
