import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import type { ElectronNativeIntegration } from "@/shared/types/electron";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { LoaderCircle, Search } from "@/ui/icons";
import "./connectors-popover.css";

type Phase = "idle" | "loading" | "ready" | "error";

export function ConnectorsPopover({
  trigger,
  open: controlledOpen,
  onOpenChange,
  side = "top",
  align = "end",
}: {
  trigger: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [phase, setPhase] = useState<Phase>("idle");
  const [connectors, setConnectors] = useState<ElectronNativeIntegration[]>([]);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

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

    else setQuery("");
  }, [load, open]);

  const visibleConnectors = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return connectors;
    return connectors.filter((connector) =>
      `${connector.name} ${connector.category} ${connector.description}`
        .toLowerCase()
        .includes(trimmed),
    );
  }, [connectors, query]);

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
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={8}
      >
        <PopoverBody>
          <div className="connectors-popover__head">
            <span className="connectors-popover__title">Connectors</span>
            <label className="connectors-popover__search">
              <Search size={13} strokeWidth={1.75} aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search"
                aria-label="Search connectors"
                disabled={phase !== "ready"}
              />
            </label>
          </div>
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
          ) : visibleConnectors.length === 0 ? (
            <div className="connectors-popover__status">
              No connectors match that search.
            </div>
          ) : (
            <ul className="connectors-popover__list">
              {visibleConnectors.map((connector) => {
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
