export const LINK_WALLET_ADD_CARD_URL = "https://app.link.com/wallet";
export const LINK_WALLET_MANAGE_URL = "https://app.link.com";
export const LINK_WALLET_CLIENT_NAME = "Stella";
export const LINK_WALLET_MAX_AMOUNT_CENTS = 50_000;
export const LINK_WALLET_AUTH_RELATIVE_PATH = "wallet/link-auth.json";

export type LinkPaymentMethodView = {
  id: string;
  brand: string;
  last4: string;
  isDefault: boolean;
};

export type LinkSpendView = {
  id: string;
  merchantName: string;
  amountCents: number;
  currency: "usd";
  status: string;
  createdAtMs?: number;
};

export type LinkWalletSnapshot =
  | { status: "disconnected" }
  | {
      status: "connecting";
      verificationUrl?: string;
      userCode?: string;
    }
  | {
      status: "connected";
      paymentMethods: readonly LinkPaymentMethodView[];
      spends: readonly LinkSpendView[];
    };

export type LinkWalletCardPhase =
  | "offer"
  | "pairing"
  | "connected"
  | "awaiting_approval"
  | "error";

export type LinkWalletCardView = {
  requestId: string;
  phase: LinkWalletCardPhase;
  conversationId?: string;
  verificationUrl?: string;
  userCode?: string;
  merchantName?: string;
  amountLabel?: string;
  message?: string;
};
