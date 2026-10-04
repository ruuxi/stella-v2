//! Vendored provider metadata, shared by native and Worker targets. This is
//! compiled data; no TypeScript module or extension is loaded at runtime.
use serde_json::{Value, json};
use std::sync::LazyLock;

pub static MODELS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/models.json")).expect("vendored model catalog")
});

pub fn retired(provider: &str) -> bool {
    matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "groq" | "mistral" | "fal"
    )
}

pub fn all() -> Vec<Value> {
    MODELS
        .as_object()
        .unwrap()
        .iter()
        .filter(|(p, _)| !retired(p))
        .flat_map(|(_, models)| models.as_object().unwrap().values().cloned())
        .collect()
}

pub fn managed_model(entry: &Value, origin: &str) -> Value {
    let id = entry["id"].as_str().unwrap_or_default();
    let upstream = entry["upstreamModel"].as_str().unwrap_or(id);
    let provider = ["openai", "anthropic", "google", "deepseek", "wafer"]
        .into_iter()
        .find(|p| upstream.starts_with(&format!("{p}/")))
        .unwrap_or(if upstream.starts_with("accounts/fireworks/") {
            "fireworks"
        } else {
            "openrouter"
        });
    let native = if provider == "openrouter" || provider == "fireworks" {
        upstream
    } else {
        upstream
            .strip_prefix(&format!("{provider}/"))
            .unwrap_or(upstream)
    };
    let registry = [
        upstream.to_owned(),
        native.to_owned(),
        native.replace('.', "-"),
    ]
    .into_iter()
    .find_map(|candidate| MODELS[provider].get(&candidate));
    let api = entry["api"].as_str().unwrap_or(match provider {
        "anthropic" => "anthropic-messages",
        "google" => "google-generative-ai",
        "openai" | "fireworks" | "deepseek" => "openai-responses",
        _ => "openai-completions",
    });
    let mut model = registry.cloned().unwrap_or_else(|| json!({"reasoning":true,"input":["text","image"],
        "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":80000,"maxTokens":16384}));
    model["id"] = json!(id);
    model["name"] = json!(id.strip_prefix("stella/").unwrap_or(id));
    model["provider"] = json!("stella");
    model["api"] = json!(api);
    model["baseUrl"] = json!(format!("{origin}/v1/relay"));
    model.as_object_mut().unwrap().remove("headers");
    model
}
