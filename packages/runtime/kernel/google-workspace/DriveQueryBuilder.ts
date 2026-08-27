export function escapeQueryString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
