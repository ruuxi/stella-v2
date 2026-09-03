export const magicLinkSendErrorKey = (code: string | undefined): string => {
  if (code === "email_not_supported") return "global.auth.emailNotSupported";
  return "global.auth.sendFailed";
};
