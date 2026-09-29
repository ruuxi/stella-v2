//! Native provider routing. Managed capabilities and direct credentials remain
//! separate transports, sharing only the platform-independent wire adapters.
use crate::{gateway::Gateway, storage::now_ms};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use stella_runtime_core::agent::AgentContext;

pub enum ModelClient {
    Managed(Box<Gateway>),
    Direct(Direct),
}
pub struct Direct {
    model: Value,
    headers: reqwest::header::HeaderMap,
    client: reqwest::Client,
}

impl From<Gateway> for ModelClient {
    fn from(gateway: Gateway) -> Self {
        Self::Managed(Box::new(gateway))
    }
}
impl ModelClient {
    pub fn direct(model: Value, headers: reqwest::header::HeaderMap) -> Result<Self> {
        let base = reqwest::Url::parse(
            model["baseUrl"]
                .as_str()
                .context("Provider base URL is required")?,
        )?;
        if !matches!(base.scheme(), "https" | "http")
            || !base.username().is_empty()
            || base.password().is_some()
        {
            bail!("Invalid provider transport URL");
        }
        if !matches!(
            model["api"].as_str(),
            Some(
                "anthropic-messages"
                    | "google-generative-ai"
                    | "openai-responses"
                    | "openai-completions"
            )
        ) {
            bail!("Unsupported native provider protocol");
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(900))
            .build()?;
        Ok(Self::Direct(Direct {
            model,
            headers,
            client,
        }))
    }
    pub async fn complete(&self, context: &AgentContext) -> Result<Value> {
        match self {
            Self::Managed(gateway) => gateway.complete(context).await,
            Self::Direct(direct) => direct.complete(context).await,
        }
    }
}

impl Direct {
    async fn complete(&self, context: &AgentContext) -> Result<Value> {
        let model = self.model["id"].as_str().context("Model ID missing")?;
        let provider = self.model["provider"]
            .as_str()
            .context("Model provider missing")?;
        let api = self.model["api"]
            .as_str()
            .context("Model protocol missing")?;
        let context = AgentContext {
            system_prompt: context.system_prompt.clone(),
            tools: context.tools.clone(),
            messages: stella_runtime_core::messages::transform(
                &context.messages,
                provider,
                api,
                model,
                self.model["input"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|i| i == "image")),
                now_ms(),
            ),
        };
        let max = self.model["maxTokens"].as_u64().unwrap_or(8192).min(16384);
        let base = self.model["baseUrl"]
            .as_str()
            .unwrap()
            .trim_end_matches('/');
        let mut headers = self.headers.clone();
        let (url, mut body) = match api {
            "anthropic-messages" => {
                headers.insert(
                    "anthropic-version",
                    reqwest::header::HeaderValue::from_static("2023-06-01"),
                );
                (
                    format!(
                        "{base}{}",
                        if base.ends_with("/v1") {
                            "/messages"
                        } else {
                            "/v1/messages"
                        }
                    ),
                    stella_runtime_core::anthropic::request(&context, model, max)?,
                )
            }
            "google-generative-ai" => {
                let mut url = reqwest::Url::parse(&format!("{base}/models/"))?;
                url.path_segments_mut()
                    .map_err(|_| anyhow::anyhow!("Invalid Google URL"))?
                    .pop_if_empty()
                    .push(&format!("{model}:generateContent"));
                (
                    url.to_string(),
                    stella_runtime_core::google::request(&context, model, max)?,
                )
            }
            "openai-responses" => (
                format!("{base}/responses"),
                stella_runtime_core::responses::request(&context, model, max)?,
            ),
            "openai-completions" => (
                format!("{base}/chat/completions"),
                stella_runtime_core::completions::request(&context, model, max)?,
            ),
            _ => bail!("Unsupported provider protocol"),
        };
        if api == "openai-completions"
            && self.model["compat"]["maxTokensField"] == "max_tokens"
            && let Some(value) = body
                .as_object_mut()
                .unwrap()
                .remove("max_completion_tokens")
        {
            body["max_tokens"] = value;
        }
        let mut received = None;
        for attempt in 0..4 {
            let response = self
                .client
                .post(&url)
                .headers(headers.clone())
                .json(&body)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) if attempt < 3 && (error.is_connect() || error.is_timeout()) => {
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                    continue;
                }
                Err(error) => return Err(error.without_url().into()),
            };
            let status = response.status();
            if !status.is_success() {
                if attempt < 3 && matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504) {
                    let delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(1 << attempt)
                        .min(30);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    continue;
                }
                // Provider error bodies may echo credentials/configuration.
                bail!("Provider {provider} request failed ({status})");
            }
            received = Some(response.json::<Value>().await?);
            break;
        }
        let body = received.context("Provider request exhausted retries")?;
        let mut message = match api {
            "anthropic-messages" => {
                stella_runtime_core::anthropic::response(body, model, provider, now_ms())?
            }
            "google-generative-ai" => {
                stella_runtime_core::google::response(body, model, provider, now_ms())?
            }
            "openai-responses" => {
                stella_runtime_core::responses::response(body, model, provider, now_ms())?
            }
            _ => stella_runtime_core::completions::response(body, model, provider, now_ms())?,
        };
        let mut total = 0.0;
        for kind in ["input", "output", "cacheRead", "cacheWrite"] {
            let price = self.model["cost"][kind].as_f64().unwrap_or(0.0).max(0.0);
            let cost = message["usage"][kind].as_f64().unwrap_or(0.0) * price / 1_000_000.0;
            message["usage"]["cost"][kind] = json!(cost);
            total += cost;
        }
        message["usage"]["cost"]["total"] = json!(total);
        Ok(message)
    }
}
