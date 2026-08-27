import { expo } from "@better-auth/expo";

export const expoOAuthProxy = () => {
  const { hooks: _cookieRedirectHook, ...proxyOnly } = expo();
  return proxyOnly;
};
