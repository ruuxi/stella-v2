type CommandLine = {
  appendSwitch: (name: string, value?: string) => void;
  hasSwitch: (name: string) => boolean;
};

type LinuxProtectedStorageOptions = {
  commandLine: CommandLine;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

const HYPRLAND_DESKTOP_NAMES = new Set(["hyprland", "omarchy"]);

const desktopNames = (env: NodeJS.ProcessEnv): string[] =>
  [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .flatMap((value) => value?.split(":") ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

export const needsLinuxSecretServiceSelection = ({
  env = process.env,
  platform = process.platform,
}: Omit<LinuxProtectedStorageOptions, "commandLine"> = {}): boolean =>
  platform === "linux" &&
  desktopNames(env).some((name) => HYPRLAND_DESKTOP_NAMES.has(name));

export const configureLinuxProtectedStorage = ({
  commandLine,
  env = process.env,
  platform = process.platform,
}: LinuxProtectedStorageOptions): boolean => {
  if (
    !needsLinuxSecretServiceSelection({ env, platform }) ||
    commandLine.hasSwitch("password-store")
  ) {
    return false;
  }

  commandLine.appendSwitch("password-store", "gnome-libsecret");
  return true;
};
