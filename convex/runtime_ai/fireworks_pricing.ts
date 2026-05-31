import {
  FIREWORKS_KIMI_K2P6_MODEL,
  getFireworksKimiK2P6ServiceTierPrice,
} from "../lib/billing_money";
import type { Api, Model, Usage } from "./types";

export function applyFireworksKimiK2P6ServiceTierPricing<TApi extends Api>(
  usage: Usage,
  model: Pick<Model<TApi>, "id" | "provider">,
  serviceTier: string | undefined,
): boolean {
  if (model.provider !== "fireworks" || model.id !== FIREWORKS_KIMI_K2P6_MODEL) {
    return false;
  }

  const price = getFireworksKimiK2P6ServiceTierPrice(model.id, serviceTier);
  if (!price) {
    return false;
  }
  usage.cost.input = (price.inputPerMillionUsd / 1_000_000) * usage.input;
  usage.cost.output = (price.outputPerMillionUsd / 1_000_000) * usage.output;
  usage.cost.cacheRead =
    ((price.cacheReadPerMillionUsd ?? 0) / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite =
    ((price.cacheWritePerMillionUsd ?? 0) / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
  return true;
}
