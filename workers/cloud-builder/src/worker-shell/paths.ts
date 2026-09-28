/**
 * Lexical shell-path normalization, shared by the BuildSession's router and
 * the worker shell. Kept dependency-free so importing it never pulls just-bash
 * into the Durable Object.
 */
export const normalizeShellPath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
};
