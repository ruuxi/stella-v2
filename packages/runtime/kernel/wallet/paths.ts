import path from "node:path";

import { LINK_WALLET_AUTH_RELATIVE_PATH } from "@stella/contracts/link-wallet";

export const linkWalletDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "wallet");

export const linkWalletAuthFile = (stellaDataDir: string): string =>
  path.join(stellaDataDir, LINK_WALLET_AUTH_RELATIVE_PATH);
