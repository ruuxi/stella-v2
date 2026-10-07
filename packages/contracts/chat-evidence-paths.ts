export const basename = (filePath: string, stripExtension?: string): string => {
  const parts = filePath.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? filePath;
  if (stripExtension && name.endsWith(stripExtension)) {
    return name.slice(0, name.length - stripExtension.length);
  }
  return name;
};

export const extname = (filePath: string): string => {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};
