import { resolveStellaHomeDir } from "../../desktop/electron/data-paths";

export const resolveViteDevStellaHome = (options?: {
  homeDir?: string;
  devHomeOverride?: string | null;
}): string =>
  resolveStellaHomeDir({
    isPackaged: false,
    ...(options?.homeDir ? { homeDir: options.homeDir } : {}),
    devHomeOverride:
      options?.devHomeOverride ?? process.env.STELLA_V2_DEV_DATA_DIR,
  });
