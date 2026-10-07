import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_USER_ASK_ESCALATION_POLICY,
  normalizeUserAskEscalationPolicy,
  type UserAskEscalationPolicy,
} from "@stella/contracts/user-ask";
import { backendOrigin, getJson, HttpRequestError, putJson } from "./http";

const isMissingRoute = (error: unknown): boolean =>
  error instanceof HttpRequestError &&
  (error.status === 404 || error.status === 501 || error.status === 405);

const unwrap = (payload: unknown): unknown => {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const source = payload as Record<string, unknown>;
    if (source.policy && typeof source.policy === "object") return source.policy;
  }
  return payload;
};

export type UserAskPolicyView = {
  policy: UserAskEscalationPolicy;
  loaded: boolean;
  available: boolean;
  saving: boolean;
  failed: boolean;
  update: (next: UserAskEscalationPolicy) => void;
};

export function useUserAskEscalationPolicy(enabled: boolean): UserAskPolicyView {
  const [policy, setPolicy] = useState<UserAskEscalationPolicy>(
    DEFAULT_USER_ASK_ESCALATION_POLICY,
  );
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getJson("/api/user-asks/policy", { origin: backendOrigin() })
      .then((payload) => {
        if (cancelled) return;
        setPolicy(normalizeUserAskEscalationPolicy(unwrap(payload)));
        setAvailable(true);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isMissingRoute(error)) setAvailable(false);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const update = useCallback((next: UserAskEscalationPolicy) => {
    const normalized = normalizeUserAskEscalationPolicy(next);
    setPolicy(normalized);
    setFailed(false);
    setSaving(true);
    void putJson("/api/user-asks/policy", normalized, {
      origin: backendOrigin(),
    })
      .then((payload) => {
        setPolicy(normalizeUserAskEscalationPolicy(unwrap(payload) ?? normalized));
        setSaving(false);
      })
      .catch((error: unknown) => {
        setSaving(false);
        if (isMissingRoute(error)) {
          setAvailable(false);
          return;
        }
        setFailed(true);
      });
  }, []);

  return { policy, loaded, available, saving, failed, update };
}
