/**
 * Connectors — a footer popover for browsing the native-connector catalog
 * (the Composio-backed integrations the runtime exposes through
 * `nativeIntegrations.list`). Connectable entries can be switched on and
 * off in place; everything else just shows what the agent can reach.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ElectronNativeIntegration } from "@/shared/types/electron";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { LoaderCircle } from "@/ui/icons";
import "./connectors-popover.css";

type Phase = "idle" | "loading" | "ready" | "error";

export function ConnectorsPopover({ trigger }: { trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [connectors, setConnectors] = useState<ElectronNativeIntegration[]>([]);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    const api = window.electronAPI?.nativeIntegrations;
    if (!api?.list) {
      setPhase("error");
      return;
    }
    setPhase((current) => (current === "ready" ? current : "loading"));
    try {
      const list = await api.list();
      setConnectors(
        [...list].sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            a.name.localeCompare(b.name),
        ),
      );
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const toggle = useCallback(async (connector: ElectronNativeIntegration) => {
    const api = window.electronAPI?.nativeIntegrations;
    if (!api) return;
    setBusyIds((current) => new Set(current).add(connector.id));
    try {
      const updated = connector.enabled
        ? await api.disable({ id: connector.id })
        : await api.enable({ id: connector.id });
      setConnectors((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
    } catch {
      // The row keeps its previous state; reopening refreshes the list.
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(connector.id);
        return next;
      });
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="connectors-popover"
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
      >
        <PopoverBody>
          <div className="connectors-popover__head">Connectors</div>
          {phase === "loading" || phase === "idle" ? (
            <div className="connectors-popover__status" role="status">
              <LoaderCircle
                className="stella-loader-circle"
                size={16}
                strokeWidth={2}
                aria-hidden="true"
              />
              Loading connectors…
            </div>
          ) : phase === "error" ? (
            <div className="connectors-popover__status" role="alert">
              Connectors are available in the Stella desktop app.
            </div>
          ) : connectors.length === 0 ? (
            <div className="connectors-popover__status">
              No connectors available yet.
            </div>
          ) : (
            <ul className="connectors-popover__list">
              {connectors.map((connector) => {
                const busy = busyIds.has(connector.id);
                return (
                  <li key={connector.id} className="connectors-popover__row">
                    {connector.iconUrl ? (
                      <img
                        className="connectors-popover__icon"
                        src={connector.iconUrl}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span
                        className="connectors-popover__icon connectors-popover__icon--fallback"
                        aria-hidden="true"
                      >
                        {connector.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="connectors-popover__copy">
                      <span className="connectors-popover__name">
                        {connector.name}
                      </span>
                      <span className="connectors-popover__meta">
                        {connector.category}
                        {connector.toolCount > 0
                          ? ` · ${connector.toolCount} tools`
                          : ""}
                      </span>
                    </span>
                    {connector.connectable ? (
                      <button
                        type="button"
                        className="connectors-popover__toggle"
                        data-enabled={connector.enabled || undefined}
                        disabled={busy}
                        onClick={() => void toggle(connector)}
                      >
                        {busy ? "…" : connector.enabled ? "On" : "Off"}
                      </button>
                    ) : connector.enabled ? (
                      <span
                        className="connectors-popover__toggle"
                        data-enabled="true"
                      >
                        On
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
