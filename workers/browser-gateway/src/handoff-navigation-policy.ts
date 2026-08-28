export const handoffNetworkRequestAllowed = (args: {
  requestUrl: string;
  documentNavigation: boolean;
  expectedOrigin: string;
}): boolean => {
  let url: URL;
  try {
    url = new URL(args.requestUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (args.documentNavigation && url.origin !== args.expectedOrigin) {
    return false;
  }
  return true;
};
