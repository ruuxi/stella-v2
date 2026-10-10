const EXTENSION_RE = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/;

export const fileDisplayName = (nameOrPath: string): string => {
  const base = nameOrPath.split(/[\\/]/).filter(Boolean).pop() ?? nameOrPath;
  if (base.startsWith(".")) return base;
  const stripped = base.replace(EXTENSION_RE, "");
  return stripped.trim() ? stripped : base;
};
