const LINK_CLI_RE =
  /(?:^|[\s;|&])(?:npx|bunx|pnpm(?:\s+dlx)?|yarn(?:\s+dlx)?)\s+(?:-y\s+)?@stripe\/link-cli\b|\blink-cli\b/u;

export type DetectedLinkCli =
  | { kind: "auth_login" }
  | {
      kind: "spend_request";
      requestsApproval: boolean;
      merchantName?: string;
      amountCents?: number;
    }
  | { kind: "other" };

const flagValue = (command: string, name: string): string | undefined => {
  const match = command.match(
    new RegExp(`--${name}(?:\\s+|=)(?:"([^"]+)"|'([^']+)'|(\\S+))`, "u"),
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.trim() || undefined;
};

export const detectLinkCliInvocation = (
  command: string,
): DetectedLinkCli | null => {
  if (!LINK_CLI_RE.test(command)) return null;
  if (/\bauth\s+login\b/u.test(command)) return { kind: "auth_login" };
  if (/\bspend-request\b/u.test(command)) {
    const amountRaw = flagValue(command, "amount");
    const amountCents = amountRaw ? Number(amountRaw) : undefined;
    return {
      kind: "spend_request",
      requestsApproval: /--request-approval\b/u.test(command),
      ...(flagValue(command, "merchant-name")
        ? { merchantName: flagValue(command, "merchant-name") }
        : {}),
      ...(amountCents !== undefined && Number.isFinite(amountCents)
        ? { amountCents }
        : {}),
    };
  }
  return { kind: "other" };
};

export const BUYING_KEYWORD_RE =
  /\b(buy|buying|purchase|purchasing|pay for|checkout|spend|wallet|link\.com)\b/iu;
