import { BrandIcon } from "@/ui/brand-icon";
import "./agent-model-icon.css";
export const getAgentModelPresentation = (snapshot) => {
    if (!snapshot) {
        return { brand: "stella", model: "Model details unavailable" };
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
    const parts = route.split("/").filter(Boolean);
    const brand = parts[0] === "stella" && parts.length > 2
        ? parts[1]
        : (parts[0] ?? "stella");
    return { brand, model: route || "Model details unavailable" };
};
export function AgentModelIcon({ snapshot, size = 14, }) {
    const presentation = getAgentModelPresentation(snapshot);
    return (<span className="agent-model-icon" data-brand={presentation.brand} title={presentation.model} aria-label={presentation.model} style={{
            "--agent-model-icon-size": `${size}px`,
        }}>
      <BrandIcon brand={presentation.brand} size={size}/>
    </span>);
}
