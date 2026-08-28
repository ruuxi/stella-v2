import type {
  LinkPaymentMethodView,
  LinkSpendView,
  LinkWalletSnapshot,
} from "@stella/contracts/link-wallet";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const last4From = (value: unknown): string | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;
  const digits = raw.replace(/\D/gu, "");
  if (digits.length >= 4) return digits.slice(-4);
  if (/^\d{2,4}$/u.test(raw)) return raw;
  return undefined;
};

export const parseJsonObject = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.search(/[{[]/u);
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as unknown;
    } catch {
      return null;
    }
  }
};

export const parseAuthStatus = (
  value: unknown,
): { authenticated: boolean } => {
  const record = asRecord(value);
  if (!record) return { authenticated: false };
  const authenticated = asBoolean(record.authenticated);
  if (authenticated !== undefined) return { authenticated };
  if (asString(record.access_token) || asString(record.accessToken)) {
    return { authenticated: true };
  }
  return { authenticated: false };
};

export const parseLoginPrompt = (
  value: unknown,
): { verificationUrl?: string; userCode?: string } => {
  const record = asRecord(value);
  if (!record) return {};
  const verificationUrl =
    asString(record.verification_url) ??
    asString(record.verificationUrl) ??
    asString(record.url) ??
    asString(record.login_url);
  const userCode =
    asString(record.user_code) ??
    asString(record.userCode) ??
    asString(record.phrase) ??
    asString(record.login_phrase) ??
    asString(record.code);
  return {
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(userCode ? { userCode } : {}),
  };
};

const promptKey = (prompt: {
  verificationUrl?: string;
  userCode?: string;
}): string => `${prompt.verificationUrl ?? ""}|${prompt.userCode ?? ""}`;

export const extractLoginPrompts = (
  text: string,
): { verificationUrl?: string; userCode?: string }[] => {
  const prompts: { verificationUrl?: string; userCode?: string }[] = [];
  const seen = new Set<string>();
  const consider = (value: unknown) => {
    const prompt = parseLoginPrompt(value);
    if (!prompt.verificationUrl && !prompt.userCode) return;
    const key = promptKey(prompt);
    if (seen.has(key)) return;
    seen.add(key);
    prompts.push(prompt);
  };
  consider(parseJsonObject(text));
  for (const line of text.split(/\r?\n/u)) {
    consider(parseJsonObject(line));
  }
  return prompts;
};

export const parsePaymentMethods = (
  value: unknown,
): LinkPaymentMethodView[] => {
  const record = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.payment_methods)
        ? record.payment_methods
        : Array.isArray(record?.paymentMethods)
          ? record.paymentMethods
          : [];
  const methods: LinkPaymentMethodView[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    if (!item) continue;
    const id = asString(item.id);
    const last4 =
      last4From(item.last4) ??
      last4From(item.last_4) ??
      last4From(item.card_last4);
    const brand =
      asString(item.brand) ??
      asString(item.display_brand) ??
      asString(item.type) ??
      "card";
    if (!id || !last4) continue;
    methods.push({
      id,
      brand,
      last4,
      isDefault: Boolean(
        asBoolean(item.is_default) ??
          asBoolean(item.isDefault) ??
          asBoolean(item.default),
      ),
    });
  }
  return methods;
};

const spendStatus = (value: unknown): string =>
  asString(value) ?? "unknown";

export const parseSpendHistory = (value: unknown): LinkSpendView[] => {
  const record = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.transactions)
        ? record.transactions
        : Array.isArray(record?.spend_requests)
          ? record.spend_requests
          : Array.isArray(record?.spendRequests)
            ? record.spendRequests
            : [];
  const spends: LinkSpendView[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    if (!item) continue;
    const id = asString(item.id);
    const merchantName =
      asString(item.merchant_name) ??
      asString(item.merchantName) ??
      asString(item.merchant) ??
      asString(asRecord(item.merchant)?.name) ??
      "Unknown";
    const amountCents = Math.round(
      asNumber(item.amount) ??
        asNumber(item.amount_cents) ??
        asNumber(item.amountCents) ??
        0,
    );
    if (!id) continue;
    const createdAt =
      asNumber(item.created_at) ??
      asNumber(item.createdAt) ??
      asNumber(item.created);
    const createdAtMs =
      createdAt === undefined
        ? undefined
        : createdAt > 1_000_000_000_000
          ? createdAt
          : createdAt * 1000;
    spends.push({
      id,
      merchantName,
      amountCents,
      currency: "usd",
      status: spendStatus(item.status),
      ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    });
  }
  return spends;
};

export const snapshotFromCli = (args: {
  authenticated: boolean;
  paymentMethods?: unknown;
  spends?: unknown;
}): LinkWalletSnapshot => {
  if (!args.authenticated) return { status: "disconnected" };
  return {
    status: "connected",
    paymentMethods: parsePaymentMethods(args.paymentMethods),
    spends: parseSpendHistory(args.spends),
  };
};
