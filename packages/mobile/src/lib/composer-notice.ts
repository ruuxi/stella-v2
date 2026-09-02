/**
 * Pinned "act before continuing" notices for the mobile composer: the
 * user is signed out, their plan ran out of room, a model is gated, a
 * provider rejected the request.
 *
 * Mirrors the desktop composer-notice store: one notice per conversation
 * scope (newest wins), an unscoped notice shows on every chat surface, a
 * new send clears whatever a previous failure left behind. The chat
 * screen renders the head of this store above the composer, in the same
 * slot as the cloud-browser intervention card.
 *
 * Classification lives here too so the send pipeline can hand a raw
 * failure over without knowing anything about the UI.
 */

import { useSyncExternalStore } from "react";

export type ComposerNoticeKind = "sign-in" | "upgrade" | "limit" | "provider";

export type ComposerNotice = {
  id: string;
  /** Owning conversation; `null` = unscoped, shown everywhere. */
  conversationId: string | null;
  kind: ComposerNoticeKind;
  title: string;
  description?: string;
};

export type ComposerNoticeInput = Omit<ComposerNotice, "id"> & { id?: string };

let notices: ComposerNotice[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => notices;

export const getComposerNotices = (): readonly ComposerNotice[] => notices;

export function showComposerNotice(input: ComposerNoticeInput): string {
  const id = input.id ?? `composer-notice-${++nextId}`;
  notices = [
    ...notices.filter((entry) => entry.conversationId !== input.conversationId),
    { ...input, id },
  ];
  emit();
  return id;
}

export function dismissComposerNotice(id: string): void {
  if (!notices.some((entry) => entry.id === id)) return;
  notices = notices.filter((entry) => entry.id !== id);
  emit();
}

/** A new send in `conversationId` makes its notice (and unscoped ones) stale. */
export function clearComposerNotices(
  conversationId: string | null | undefined,
): void {
  const remaining = notices.filter(
    (entry) =>
      entry.conversationId !== null &&
      entry.conversationId !== (conversationId ?? null),
  );
  if (remaining.length === notices.length) return;
  notices = remaining;
  emit();
}

export function resetComposerNotices(): void {
  notices = [];
  emit();
}

export function selectComposerNotice(
  entries: readonly ComposerNotice[],
  conversationId: string | null | undefined,
): ComposerNotice | null {
  const scoped = conversationId
    ? entries.find((entry) => entry.conversationId === conversationId)
    : undefined;
  if (scoped) return scoped;
  return entries.find((entry) => entry.conversationId === null) ?? null;
}

export function useComposerNotice(
  conversationId: string | null | undefined,
): ComposerNotice | null {
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return selectComposerNotice(entries, conversationId);
}

// ─── Classification ─────────────────────────────────────────────────────────

type NoticeCopy = Omit<ComposerNoticeInput, "conversationId">;

const includesAny = (value: string, matchers: readonly string[]) =>
  matchers.some((matcher) => value.includes(matcher));

const SIGN_IN_MATCHERS = [
  "sign in required",
  "sign-in required",
  "authentication required",
  "unauthorized",
  "unauthenticated",
  "invalid token",
  "token expired",
  "expired token",
  "session expired",
  "session revoked",
] as const;

/** The Free plan's allowance is a lifetime budget — never "try again later". */
const FREE_ALLOWANCE_MATCHERS = [
  "free_allowance_exhausted",
  "lifetime_limit_reached",
  "free allowance",
  "lifetime allowance",
  "lifetime usage limit",
] as const;

const CAPABILITY_MATCHERS = [
  "capability_required",
  "capability_not_available",
  "capability_denied",
  "paid_plan_required",
  "requires a stella subscription",
  "[capability/",
] as const;

const PLAN_LIMIT_MATCHERS = [
  "usage limit reached",
  "managed-model limits reached",
] as const;

const MODEL_RESTRICTION_MATCHERS = [
  "unsupported stella model selection",
  "invalid stella model selection",
  "model not available",
  "model is not available",
] as const;

const RATE_LIMIT_MATCHERS = [
  "rate limit exceeded",
  "too many requests",
  "chatgpt usage limit",
] as const;

const PROVIDER_MATCHERS = [
  "authentication failed",
  "api key",
  "forbidden",
  "permission denied",
] as const;

const statusCodeOf = (normalized: string): number | null => {
  const match = normalized.match(
    /\b(?:http(?: status)?|status(?: code)?|error(?: code)?|code)\s*[:=]?\s*([45]\d{2})\b/i,
  );
  if (!match?.[1]) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
};

/**
 * Map a failed send's message to notice copy, or `null` when the failure
 * is transient (network, timeout, unknown) and belongs in the reply bubble
 * alone. The copy mirrors the desktop provider-error resolver so the
 * guidance matches across devices.
 */
export function classifyComposerNotice(
  message: string | null | undefined,
): NoticeCopy | null {
  const normalized = (message ?? "").trim().toLowerCase();
  if (!normalized) return null;
  const status = statusCodeOf(normalized);

  if (normalized.includes("sign in to stella to use cloud agents")) {
    return {
      kind: "sign-in",
      title: "Sign in to run agents",
      description: "Sign in to Stella before running cloud agents.",
    };
  }

  if (includesAny(normalized, FREE_ALLOWANCE_MATCHERS)) {
    return {
      kind: "upgrade",
      title: "You've used your free allowance",
      description:
        "The Free plan's allowance is spent. Upgrade to keep going with Stella.",
    };
  }
  if (includesAny(normalized, CAPABILITY_MATCHERS)) {
    return {
      kind: "upgrade",
      title: "That's on a higher plan",
      description: "Upgrade to unlock this feature.",
    };
  }
  if (includesAny(normalized, PLAN_LIMIT_MATCHERS)) {
    return {
      kind: "upgrade",
      title: "Stella needs more room",
      description:
        "You have reached the limit for your current plan. Upgrade to keep going, or wait until usage resets.",
    };
  }
  if (includesAny(normalized, MODEL_RESTRICTION_MATCHERS)) {
    return {
      kind: "upgrade",
      title: "Model not available on your plan",
      description:
        "Stella will use the recommended model for your plan. Upgrade to switch models.",
    };
  }
  if (includesAny(normalized, RATE_LIMIT_MATCHERS) || status === 429) {
    return {
      kind: "limit",
      title: "Model usage limit reached",
      description:
        "This model has reached a temporary usage limit. Choose another model or try again shortly.",
    };
  }
  if (includesAny(normalized, SIGN_IN_MATCHERS) || status === 401) {
    return {
      kind: "sign-in",
      title: "Sign in to keep using Stella",
      description: "Stella needs you to sign in again before continuing.",
    };
  }
  if (includesAny(normalized, PROVIDER_MATCHERS) || status === 403) {
    return {
      kind: "provider",
      title: "Provider access needed",
      description:
        "Reconnect the selected provider or choose another model to continue.",
    };
  }
  return null;
}

/**
 * Pin a notice for `error` when it names something the user must act on.
 * Returns true when a notice was shown.
 */
export function showComposerNoticeForError(
  error: unknown,
  conversationId: string | null | undefined,
): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const copy = classifyComposerNotice(message);
  if (!copy) return false;
  showComposerNotice({ ...copy, conversationId: conversationId ?? null });
  return true;
}
