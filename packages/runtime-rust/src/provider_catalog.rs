//! Native models.json composition and models-store.json refresh. Credential
//! expressions are retained privately and never evaluated for picker metadata.
use crate::storage::now_ms;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
};

static SCHEMAS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../runtime-core/assets/model-schemas.json")).unwrap()
});
static CONFIG: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .build(&SCHEMAS["config"])
        .unwrap()
});
static REMOTE: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .build(&SCHEMAS["remote"])
        .unwrap()
});
static AUTO: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .build(&SCHEMAS["openrouterAuto"])
        .unwrap()
});
type Models = BTreeMap<String, BTreeMap<String, Value>>;

#[derive(Default)]
pub struct Providers {
    state: Mutex<State>,
    reload: tokio::sync::Mutex<()>,
    refresh: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    loaded: bool,
    config: Value,
    stored: BTreeMap<String, Value>,
    refreshed_at: Option<i64>,
    config_error: Option<String>,
    catalog_error: Option<String>,
    last_attempt: i64,
}

fn jsonc(input: &str) -> Result<Value> {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    let mut quoted = false;
    while let Some(c) = chars.next() {
        if quoted {
            output.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    output.push(next);
                }
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            output.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                    break;
                }
            }
        } else {
            output.push(c);
        }
    }
    let mut cleaned = String::new();
    let mut chars = output.chars().peekable();
    quoted = false;
    while let Some(c) = chars.next() {
        if quoted {
            cleaned.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    cleaned.push(next);
                }
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            cleaned.push(c);
        } else if c != ',' || !matches!(chars.clone().find(|c| !c.is_whitespace()), Some('}' | ']'))
        {
            cleaned.push(c);
        }
    }
    serde_json::from_str(&cleaned).context("Invalid models.json JSON")
}

fn merge(base: &Value, override_: &Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_default();
    if let Some(fields) = override_.as_object() {
        merged.extend(fields.clone());
    }
    Value::Object(merged)
}
fn compat(base: &Value, override_: &Value) -> Value {
    let mut result = merge(base, override_);
    for key in [
        "openRouterRouting",
        "vercelGatewayRouting",
        "chatTemplateKwargs",
    ] {
        if base[key].is_object() || override_[key].is_object() {
            result[key] = merge(&base[key], &override_[key]);
        }
    }
    result
}

fn valid_remote(provider: &str, model: &Value) -> bool {
    let schema = if provider == "openrouter" && model["id"] == "openrouter/auto" {
        &*AUTO
    } else {
        &*REMOTE
    };
    schema.is_valid(model)
}
fn normalized(provider: &str, mut model: Value) -> Value {
    model["provider"] = json!(provider);
    if model.get("cost").is_none() {
        model["cost"] = json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0});
    }
    model
}
fn auth_header(headers: &Value) -> bool {
    headers.as_object().is_some_and(|headers| {
        headers.iter().any(|(key, v)| {
            !v.as_str().unwrap_or("").is_empty()
                && matches!(
                    key.to_ascii_lowercase().as_str(),
                    "authorization"
                        | "proxy-authorization"
                        | "api-key"
                        | "x-api-key"
                        | "x-auth-token"
                        | "x-goog-api-key"
                )
        })
    })
}
fn managed_auth(provider: &Value) -> bool {
    provider.get("apiKey").is_some()
        || auth_header(&provider["headers"])
        || provider["models"]
            .as_array()
            .is_some_and(|models| models.iter().any(|m| auth_header(&m["headers"])))
        || provider["modelOverrides"]
            .as_object()
            .is_some_and(|models| models.values().any(|m| auth_header(&m["headers"])))
}

fn compose(
    provider: &str,
    baseline: &BTreeMap<String, Value>,
    config: &Value,
) -> Result<BTreeMap<String, Value>> {
    let mut models = baseline.clone();
    for model in models.values_mut() {
        for key in ["api", "baseUrl"] {
            if let Some(v) = config.get(key) {
                model[key] = v.clone();
            }
        }
        if config["compat"].is_object() {
            model["compat"] = compat(&model["compat"], &config["compat"]);
        }
    }
    for definition in config["models"].as_array().into_iter().flatten() {
        let id = definition["id"].as_str().context("Missing model ID")?;
        let metadata = models.get(id).cloned().unwrap_or(Value::Null);
        let transport = models.values().next().cloned().unwrap_or(Value::Null);
        let mut model = json!({"id":id,"provider":provider});
        for key in ["api", "baseUrl"] {
            let selected = [
                &definition[key],
                &config[key],
                &metadata[key],
                &transport[key],
            ]
            .into_iter()
            .find(|v| v.is_string())
            .context("A configured model requires api and baseUrl")?;
            model[key] = selected.clone();
        }
        let defaults = json!({"name":id,"reasoning":false,"input":["text"],"contextWindow":128000,"maxTokens":16384});
        for key in ["name", "reasoning", "input", "contextWindow", "maxTokens"] {
            model[key] = definition
                .get(key)
                .or_else(|| metadata.get(key))
                .unwrap_or(&defaults[key])
                .clone();
        }
        model["cost"] = merge(
            &merge(
                &json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0}),
                &metadata["cost"],
            ),
            &definition["cost"],
        );
        if definition["thinkingLevelMap"].is_object() || metadata["thinkingLevelMap"].is_object() {
            model["thinkingLevelMap"] = merge(
                &metadata["thinkingLevelMap"],
                &definition["thinkingLevelMap"],
            );
        }
        let base = metadata.get("compat").unwrap_or(&config["compat"]);
        if base.is_object() || definition["compat"].is_object() {
            model["compat"] = compat(base, &definition["compat"]);
        }
        models.insert(id.into(), model);
    }
    if let Some(overrides) = config["modelOverrides"].as_object() {
        for (id, override_) in overrides {
            if let Some(model) = models.get_mut(id) {
                let previous = model.clone();
                for (key, value) in override_.as_object().unwrap() {
                    // Unknown fields and credentials are not part of metadata.
                    if matches!(
                        key.as_str(),
                        "name"
                            | "reasoning"
                            | "input"
                            | "contextWindow"
                            | "maxTokens"
                            | "toolOutputTokenLimit"
                    ) {
                        model[key] = value.clone();
                    }
                }
                for key in ["cost", "thinkingLevelMap"] {
                    if override_[key].is_object() {
                        model[key] = merge(&previous[key], &override_[key]);
                    }
                }
                if override_["compat"].is_object() {
                    model["compat"] = compat(&previous["compat"], &override_["compat"]);
                }
            }
        }
    }
    Ok(models)
}

impl Providers {
    pub async fn route(&self, reference: &str) -> Result<(Value, reqwest::header::HeaderMap)> {
        let (provider, id) = reference
            .split_once('/')
            .context("Model reference must include its provider")?;
        if stella_runtime_core::catalog::retired(provider) {
            bail!("Provider has been retired");
        }
        let snapshot = self.snapshot(vec![]);
        let model = snapshot["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["provider"] == provider && m["id"] == id)
            .cloned()
            .context("Unknown provider model")?;
        let (config, base_headers) = {
            let state = self.state.lock().unwrap();
            let config = if snapshot["runtimeManagedProviders"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == provider)
            {
                state.config["providers"][provider].clone()
            } else {
                Value::Null
            };
            let baseline = state
                .stored
                .get(provider)
                .and_then(|e| e["models"].as_array())
                .and_then(|models| models.iter().find(|m| m["id"] == id))
                .unwrap_or(&stella_runtime_core::catalog::MODELS[provider][id]);
            (config, baseline["headers"].clone())
        };
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(values) = base_headers.as_object() {
            for (name, value) in values {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                    reqwest::header::HeaderValue::from_str(
                        value.as_str().context("Invalid provider header")?,
                    )?,
                );
            }
        }
        let definition = config["models"]
            .as_array()
            .and_then(|models| models.iter().find(|m| m["id"] == id));
        for values in [
            Some(&config["headers"]),
            definition.map(|m| &m["headers"]),
            Some(&config["modelOverrides"][id]["headers"]),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(values) = values.as_object() {
                for (name, expression) in values {
                    let value =
                        resolve_value(expression.as_str().context("Invalid configured header")?)
                            .await
                            .context("Configured provider header could not be resolved")?;
                    headers.insert(
                        reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                        reqwest::header::HeaderValue::from_str(&value)?,
                    );
                }
            }
        }
        let key = if let Some(configured) = config["apiKey"].as_str() {
            Some(
                resolve_value(configured)
                    .await
                    .context("Configured provider API key could not be resolved")?,
            )
        } else {
            environment_key(provider)
        };
        if let Some(key) = key {
            let header = if config["authHeader"] == true {
                "authorization"
            } else {
                match model["api"].as_str() {
                    Some("anthropic-messages") => "x-api-key",
                    Some("google-generative-ai") => "x-goog-api-key",
                    _ => "authorization",
                }
            };
            let value = if header == "authorization" {
                format!("Bearer {key}")
            } else {
                key
            };
            if !headers.contains_key(header) {
                headers.insert(header, reqwest::header::HeaderValue::from_str(&value)?);
            }
        } else if !snapshot["runtimeManagedProviders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == provider && p["credentialless"] == true)
            && !headers.keys().any(|key| {
                matches!(
                    key.as_str(),
                    "authorization" | "api-key" | "x-api-key" | "x-auth-token" | "x-goog-api-key"
                )
            })
        {
            bail!("No credential is available for provider {provider}");
        }
        Ok((model, headers))
    }
    pub async fn reload(&self, root: Option<PathBuf>) {
        let _single = self.reload.lock().await;
        let first = {
            let state = self.state.lock().unwrap();
            !state.loaded || state.root != root
        };
        if first {
            let stored = if let Some(root) = &root {
                crate::catalog::read_cache(&root.join("models-store.json"))
                    .await
                    .ok()
                    .and_then(|bytes| {
                        serde_json::from_slice::<BTreeMap<String, Value>>(&bytes).ok()
                    })
                    .unwrap_or_default()
            } else {
                BTreeMap::new()
            };
            let mut state = self.state.lock().unwrap();
            *state = State {
                root: root.clone(),
                loaded: true,
                ..Default::default()
            };
            for (provider, entry) in stored {
                if stella_runtime_core::catalog::retired(&provider) {
                    continue;
                }
                let Some(models) = entry["models"].as_array() else {
                    continue;
                };
                let valid = models
                    .iter()
                    .filter(|m| valid_remote(&provider, m))
                    .cloned()
                    .map(|m| normalized(&provider, m))
                    .collect::<Vec<_>>();
                let checked = if valid.len() == models.len() {
                    entry["checkedAt"].as_i64()
                } else {
                    None
                };
                if let Some(at) = checked {
                    state.refreshed_at = Some(state.refreshed_at.unwrap_or(at).max(at));
                }
                state
                    .stored
                    .insert(provider, json!({"models":valid,"checkedAt":checked}));
            }
        }
        let config: Result<Value> = async {
            let Some(root) = &root else {
                return Ok(json!({"providers":{}}));
            };
            let bytes = match crate::catalog::read_cache(&root.join("models.json")).await {
                Ok(bytes) => bytes,
                Err(e)
                    if e.downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    return Ok(json!({"providers":{}}));
                }
                Err(e) => return Err(e.context("Failed to read models.json")),
            };
            let config = jsonc(std::str::from_utf8(&bytes)?)?;
            if !CONFIG.is_valid(&config) {
                bail!("Invalid models.json schema");
            }
            if config["providers"]
                .as_object()
                .unwrap()
                .keys()
                .any(|k| k.trim().is_empty())
            {
                bail!("Invalid empty provider ID");
            }
            Ok(config)
        }
        .await;
        let mut state = self.state.lock().unwrap();
        match config {
            Ok(config) => {
                state.config = config;
                state.config_error = None;
            }
            Err(error) => {
                state.config = json!({"providers":{}});
                state.config_error = Some(error.to_string());
            }
        }
    }

    pub fn snapshot(&self, managed: Vec<Value>) -> Value {
        let state = self.state.lock().unwrap();
        let mut baseline = Models::new();
        for model in stella_runtime_core::catalog::all() {
            baseline
                .entry(model["provider"].as_str().unwrap().into())
                .or_default()
                .insert(model["id"].as_str().unwrap().into(), model);
        }
        for (provider, entry) in &state.stored {
            for model in entry["models"].as_array().into_iter().flatten() {
                baseline
                    .entry(provider.clone())
                    .or_default()
                    .insert(model["id"].as_str().unwrap().into(), model.clone());
            }
        }
        for model in managed {
            baseline
                .entry("stella".into())
                .or_default()
                .insert(model["id"].as_str().unwrap().into(), model);
        }
        for provider in state.config["providers"]
            .as_object()
            .into_iter()
            .flat_map(|p| p.keys())
        {
            if !stella_runtime_core::catalog::retired(provider) {
                baseline.entry(provider.clone()).or_default();
            }
        }
        let mut models = Vec::new();
        let mut runtime_managed = Vec::new();
        let mut errors = state.config_error.iter().cloned().collect::<Vec<_>>();
        for (provider, base) in baseline {
            let config = &state.config["providers"][&provider];
            match compose(&provider, &base, config) {
                Ok(composed) => {
                    models.extend(composed.into_values());
                    if config.is_object() {
                        let auth = managed_auth(config);
                        runtime_managed.push(json!({"id":provider,"authManaged":auth,"credentialless":!auth && config["authHeader"]!=true && stella_runtime_core::catalog::MODELS.get(&provider).is_none()}));
                    }
                }
                Err(error) => {
                    errors.push(format!("models.json provider {provider}: {error}"));
                    models.extend(base.into_values());
                }
            }
        }
        for model in &mut models {
            model.as_object_mut().unwrap().remove("headers");
        }
        let mut result = json!({"models":models,"runtimeManagedProviders":runtime_managed,"refreshedAt":state.refreshed_at});
        if !errors.is_empty() {
            result["configError"] = json!(errors.join("\n"));
        }
        if let Some(error) = &state.catalog_error {
            result["catalogError"] = json!(error);
        }
        result
    }

    pub async fn refresh(&self, force: bool) {
        let queued = now_ms();
        let _single = self.refresh.lock().await;
        let (providers, root) = {
            let mut state = self.state.lock().unwrap();
            if state.last_attempt >= queued || (!force && now_ms() - state.last_attempt < 30_000) {
                return;
            }
            state.last_attempt = now_ms();
            let mut providers = stella_runtime_core::catalog::MODELS
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            providers.extend(
                [
                    "anthropic",
                    "openai",
                    "google",
                    "fireworks",
                    "deepseek",
                    "crof",
                    "wafer",
                    "openrouter",
                ]
                .map(str::to_owned),
            );
            providers.sort();
            providers.dedup();
            providers.retain(|p| {
                p != "local"
                    && !stella_runtime_core::catalog::retired(p)
                    && (force
                        || state
                            .stored
                            .get(p)
                            .and_then(|e| e["checkedAt"].as_i64())
                            .is_none_or(|at| now_ms() - at >= 4 * 60 * 60 * 1000))
            });
            (providers, state.root.clone())
        };
        if providers.is_empty() {
            return;
        }
        let mut pending = providers.into_iter();
        let mut jobs = tokio::task::JoinSet::new();
        let mut errors = Vec::new();
        let mut changed = false;
        loop {
            while jobs.len() < 6 {
                let Some(provider) = pending.next() else {
                    break;
                };
                jobs.spawn(async move {
                    let result = fetch(&provider).await;
                    (provider, result)
                });
            }
            let Some(result) = jobs.join_next().await else {
                break;
            };
            match result {
                Ok((provider, Ok(models))) => {
                    let mut state = self.state.lock().unwrap();
                    let models = models.unwrap_or_else(|| {
                        state
                            .stored
                            .get(&provider)
                            .map(|e| e["models"].clone())
                            .unwrap_or_else(|| json!([]))
                    });
                    state
                        .stored
                        .insert(provider, json!({"models":models,"checkedAt":now_ms()}));
                    state.refreshed_at = Some(now_ms());
                    changed = true;
                }
                Ok((provider, Err(error))) => errors.push(format!("{provider}: {error}")),
                Err(error) => errors.push(error.to_string()),
            }
        }
        let stored = {
            let mut state = self.state.lock().unwrap();
            state.catalog_error = if errors.is_empty() {
                None
            } else {
                Some(format!(
                    "Model catalog refresh failed: {}",
                    errors.join("; ")
                ))
            };
            json!(state.stored)
        };
        if changed && let Some(root) = root {
            let _ = crate::catalog::write_cache(&root.join("models-store.json"), &stored).await;
        }
    }
}

fn environment_key(provider: &str) -> Option<String> {
    let names: &[&str] = match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "google" => &["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        "meta" => &["META_API_KEY", "MODEL_API_KEY"],
        "cerebras" => &["CEREBRAS_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY"],
        "vercel-ai-gateway" => &["AI_GATEWAY_API_KEY"],
        "zai" => &["ZAI_API_KEY"],
        "minimax" => &["MINIMAX_API_KEY"],
        "minimax-cn" => &["MINIMAX_CN_API_KEY"],
        "huggingface" => &["HF_TOKEN"],
        "opencode" | "opencode-go" => &["OPENCODE_API_KEY"],
        "kimi-coding" => &["KIMI_API_KEY"],
        _ => &[],
    };
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

async fn resolve_value(expression: &str) -> Result<String> {
    if let Some(command) = expression.strip_prefix('!') {
        let mut invocation = if cfg!(windows) {
            let mut cmd = tokio::process::Command::new(
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            );
            cmd.args(["/d", "/s", "/c", command]);
            cmd
        } else {
            let mut cmd = tokio::process::Command::new(
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            );
            cmd.args(["-lc", command]);
            cmd
        };
        invocation
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = invocation
            .spawn()
            .context("Credential command could not start")?;
        let stdout = child
            .stdout
            .take()
            .context("Credential command has no output stream")?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            use tokio::io::AsyncReadExt;
            let mut bytes = Vec::new();
            stdout.take(65537).read_to_end(&mut bytes).await?;
            if bytes.len() > 65536 {
                bail!("Credential command output exceeds limit");
            }
            if !child.wait().await?.success() {
                bail!("Credential command failed");
            }
            let value = String::from_utf8(bytes)
                .context("Credential command output is not UTF-8")?
                .trim()
                .to_owned();
            if value.is_empty() {
                bail!("Credential command returned no value");
            }
            Ok(value)
        })
        .await
        .context("Credential command timed out")?;
        if result.is_err() {
            let _ = child.kill().await;
        }
        return result;
    }
    let escaped = expression
        .replace("$$", "\0stella-dollar\0")
        .replace("$!", "\0stella-bang\0");
    static ENV: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))").unwrap()
    });
    let mut missing = false;
    let result = ENV.replace_all(&escaped, |capture: &regex::Captures| {
        let name = capture.get(1).or_else(|| capture.get(2)).unwrap().as_str();
        match std::env::var(name) {
            Ok(value) => value,
            Err(_) => {
                missing = true;
                String::new()
            }
        }
    });
    if missing {
        bail!("Credential environment variable is not set");
    }
    Ok(result
        .replace("\0stella-dollar\0", "$")
        .replace("\0stella-bang\0", "!"))
}

async fn fetch(provider: &str) -> Result<Option<Value>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let mut url = reqwest::Url::parse("https://pi.dev/api/models/providers/")?;
    url.path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .push(provider);
    let mut response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await?;
    if matches!(response.status().as_u16(), 404 | 501) {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!("HTTP {}", response.status());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            bail!("Provider catalog exceeds 8 MiB");
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes)?;
    let entries = if body.is_array() {
        body
    } else if let Some(models) = body.get("models") {
        models.clone()
    } else if let Some(object) = body.as_object() {
        json!(object.values().collect::<Vec<_>>())
    } else {
        bail!("Invalid provider catalog");
    };
    let entries = entries
        .as_array()
        .context("Provider models must be an array")?;
    let valid = entries
        .iter()
        .filter(|m| valid_remote(provider, m))
        .cloned()
        .map(|m| normalized(provider, m))
        .collect::<Vec<_>>();
    if !entries.is_empty() && valid.is_empty() {
        bail!("Provider catalog contains no valid models");
    }
    Ok(Some(json!(valid)))
}
