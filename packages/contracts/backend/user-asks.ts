import type {
  UserAsk,
  UserAskEscalationPolicy,
} from "../user-ask.js";

export type UserAskViews = {
  "userAsks.open": {
    args: Record<string, never>;
    result: readonly UserAsk[];
  };
};

export type UserAskCalls = {
  "userAsks.policy": {
    args: Record<string, never>;
    result: UserAskEscalationPolicy;
  };
};
