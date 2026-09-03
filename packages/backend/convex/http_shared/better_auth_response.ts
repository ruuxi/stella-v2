const readBetterAuthResponseHeader = (
  result: unknown,
  wantedName: string,
): string => {
  if (!result || typeof result !== "object") return "";
  const headers = (result as { headers?: unknown }).headers;
  if (headers instanceof Headers) {
    return headers.get(wantedName)?.trim() ?? "";
  }
  const headersList = (
    headers as { _headersList?: Array<[string, string]> } | null | undefined
  )?._headersList;
  if (!Array.isArray(headersList)) return "";
  const normalizedWantedName = wantedName.toLowerCase();
  return (
    headersList
      .find(([name]) => name.toLowerCase() === normalizedWantedName)?.[1]
      ?.trim() ?? ""
  );
};

/** Read the opaque bearer emitted by Better Auth's bearer plugin. */
export const readBetterAuthSessionToken = (result: unknown): string =>
  readBetterAuthResponseHeader(result, "set-auth-token");

export const readBetterAuthResponseUserId = (result: unknown): string => {
  if (!result || typeof result !== "object") return "";
  const response = (result as { response?: unknown }).response;
  if (!response || typeof response !== "object") return "";
  const user = (response as { user?: unknown }).user;
  if (!user || typeof user !== "object") return "";
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id.trim() : "";
};
