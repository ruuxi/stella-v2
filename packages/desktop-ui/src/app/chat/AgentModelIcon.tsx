import type { CSSProperties } from "react";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import { BrandIcon } from "@/ui/brand-icon";
import { useT } from "@/shared/i18n";
import "./agent-model-icon.css";

export type AgentModelPresentation = {
  brand: string;
  model: string;
};

type Translate = ReturnType<typeof useT>;

const getAgentModelBrand = (
  snapshot: AgentModelConfigSnapshot | undefined,
): string => {
  if (!snapshot) return "stella";
  if (snapshot.engine === "codex_cli") return "openai";
  if (snapshot.engine === "claude_code_local") return "anthropic";

  const parts = snapshot.routeModel.trim().split("/").filter(Boolean);
  return parts[0] === "stella" && parts.length > 2
    ? parts[1]!
    : (parts[0] ?? "stella");
};

export const shouldShowAgentModelIcon = (
  snapshot: AgentModelConfigSnapshot | undefined,
): boolean => getAgentModelBrand(snapshot) !== "stella";

export const getAgentModelPresentation = (
  snapshot: AgentModelConfigSnapshot | undefined,
  t: Translate,
): AgentModelPresentation => {
  if (!snapshot) {
    return { brand: "stella", model: t("app.chat.agentModelIcon.unavailable") };
  }

  if (snapshot.engine === "codex_cli") {
    return {
      brand: "openai",
      model: snapshot.engineModel?.trim() || snapshot.routeModel,
    };
  }

  if (snapshot.engine === "claude_code_local") {
    return {
      brand: "anthropic",
      model: snapshot.engineModel?.trim() || snapshot.routeModel,
    };
  }

  const route = snapshot.routeModel.trim();
  return {
    brand: getAgentModelBrand(snapshot),
    model: route || t("app.chat.agentModelIcon.unavailable"),
  };
};

export function AgentModelIcon({
  snapshot,
  size = 14,
}: {
  snapshot?: AgentModelConfigSnapshot;
  size?: number;
}) {
  const t = useT();
  const presentation = getAgentModelPresentation(snapshot, t);
  if (!shouldShowAgentModelIcon(snapshot)) return null;
  return (
    <span
      className="agent-model-icon"
      data-brand={presentation.brand}
      title={presentation.model}
      aria-label={presentation.model}
      style={
        {
          "--agent-model-icon-size": `${size}px`,
        } as CSSProperties
      }
    >
      <BrandIcon brand={presentation.brand} size={size} />
    </span>
  );
}
