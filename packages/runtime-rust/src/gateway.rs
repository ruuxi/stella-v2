//! Native Stella model-gateway client. Auth tokens are exchanged for a
//! key-bound capability and are never sent to a provider relay endpoint.
use crate::storage::now_ms;
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct GatewayFailure {
    status: reqwest::StatusCode,
    code: String,
    retry_after: Option<u64>,
}
impl std::fmt::Display for GatewayFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Gateway request failed ({}): {}", self.status, self.code)
    }
}
impl std::error::Error for GatewayFailure {}

fn decode_claims(jwt: &str) -> Result<Value> {
    let part = jwt.split('.').nth(1).context("Missing JWT payload")?;
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part)?)?)
}

/// Desktop signatures remain in Electron's protected identity service; CLI
/// execution can use an explicitly owned key. Neither mode exports a secret.
pub enum DeviceSigner {
    Local(SigningKey),
    Host {
        peer: crate::rpc::Peer,
        public_key: [u8; 32],
    },
}
impl DeviceSigner {
    pub async fn from_host(peer: crate::rpc::Peer) -> Result<Self> {
        let signed = peer
            .request(
                "host.auth.signDevice",
                json!({"input":"stella-device-key-probe"}),
            )
            .await?;
        let public_key: [u8; 32] = serde_json::from_value(signed["rawPublicKey"].clone())
            .context("Invalid host signing key")?;
        if signed["alg"] != "ed25519" {
            bail!("Unsupported host signing algorithm");
        }
        Ok(Self::Host { peer, public_key })
    }
    fn public_key(&self) -> [u8; 32] {
        match self {
            Self::Local(key) => key.verifying_key().to_bytes(),
            Self::Host { public_key, .. } => *public_key,
        }
    }
    async fn sign(&self, input: &str) -> Result<String> {
        match self {
            Self::Local(key) => Ok(URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).to_bytes())),
            Self::Host { peer, public_key } => {
                let signed = peer
                    .request("host.auth.signDevice", json!({"input":input}))
                    .await?;
                let returned: [u8; 32] = serde_json::from_value(signed["rawPublicKey"].clone())?;
                if signed["alg"] != "ed25519" || &returned != public_key {
                    bail!("Host signing identity changed during execution");
                }
                let signature = signed["signature"]
                    .as_str()
                    .context("Missing host signature")?;
                let bytes = URL_SAFE_NO_PAD.decode(signature)?;
                let signature_value = ed25519_dalek::Signature::from_slice(&bytes)?;
                ed25519_dalek::VerifyingKey::from_bytes(public_key)?
                    .verify_strict(input.as_bytes(), &signature_value)?;
                Ok(signature.to_string())
            }
        }
    }
}

pub struct Gateway {
    client: Client,
    origin: String,
    signer: DeviceSigner,
    capability: String,
    jti: String,
    agent_type: String,
    resolution: Value,
    revision: String,
}

impl Gateway {
    pub async fn connect(
        origin: &str,
        auth: &str,
        agent_type: &str,
        model: &str,
        signer: DeviceSigner,
    ) -> Result<Self> {
        let url = Url::parse(origin)?;
        if url.scheme() != "https"
            && url.host_str() != Some("127.0.0.1")
            && url.host_str() != Some("localhost")
        {
            bail!("Gateway requires HTTPS");
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("Gateway URL must not include credentials");
        }
        let origin = url.origin().ascii_serialization();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(900))
            .build()?;
        let claims = decode_claims(auth)?;
        let issuer = claims["iss"]
            .as_str()
            .context("Missing owner issuer")?
            .trim_end_matches('/');
        let subject = claims["sub"].as_str().context("Missing owner subject")?;
        let at = now_ms();
        let public = URL_SAFE_NO_PAD.encode(signer.public_key());
        let signature = signer
            .sign(&format!(
                "stella-device-exchange\n{issuer}|{subject}\n{origin}\n{at}"
            ))
            .await?;
        let response=client.post(format!("{origin}/v1/capabilities/session")).bearer_auth(auth).json(&json!({"deviceKey":{"alg":"ed25519","publicKey":public,"signature":signature,"timestamp":at}})).send().await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() {
            bail!(
                "Gateway session exchange failed ({status}): {}",
                body["error"]["code"].as_str().unwrap_or("unknown")
            );
        }
        let capability = body["capability"]
            .as_str()
            .context("Missing session capability")?
            .to_string();
        let jti = decode_claims(&capability)?["jti"]
            .as_str()
            .context("Capability has no request identity")?
            .to_string();
        let mut gateway = Self {
            client,
            origin,
            signer,
            capability,
            jti,
            agent_type: agent_type.into(),
            resolution: Value::Null,
            revision: String::new(),
        };
        gateway.resolution = gateway
            .post(
                "/v1/models/resolve",
                json!({"model":model,"agentType":agent_type}),
                None,
            )
            .await?;
        let r = &gateway.resolution;
        let digest = Sha256::digest(serde_json::to_vec(&json!([
            1,
            r["requestedModel"],
            r["resolvedModel"],
            r["provider"],
            r["protocol"],
            r["reasoning"],
            r["supportsImages"],
            r["contextWindow"],
            r["maxOutputTokens"]
        ]))?);
        gateway.revision = format!("v1:{digest:x}");
        Ok(gateway)
    }

    async fn post(&self, path: &str, body: Value, revision: Option<&str>) -> Result<Value> {
        for attempt in 0..4 {
            match self.post_once(path, &body, revision).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let response = error.downcast_ref::<GatewayFailure>();
                    let transient = response.is_some_and(|failure| {
                        matches!(failure.status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
                    }) || error
                        .downcast_ref::<reqwest::Error>()
                        .is_some_and(|failure| failure.is_connect() || failure.is_timeout());
                    if !transient || attempt == 3 {
                        return Err(error);
                    }
                    let delay = response
                        .and_then(|failure| failure.retry_after)
                        .unwrap_or(1 << attempt)
                        .min(30);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                }
            }
        }
        unreachable!()
    }

    async fn post_once(&self, path: &str, body: &Value, revision: Option<&str>) -> Result<Value> {
        let request_id = ulid::Ulid::new().to_string();
        let at = now_ms();
        let signature = self
            .signer
            .sign(&format!(
                "stella-dpop\nPOST\n{path}\n{}\n{request_id}\n{at}",
                self.jti
            ))
            .await?;
        let mut request = self
            .client
            .post(format!("{}{path}", self.origin))
            .bearer_auth(&self.capability)
            .header("x-stella-agent-type", &self.agent_type)
            .header("x-stella-request-id", request_id)
            .header("x-stella-dpop", signature)
            .header(
                "x-stella-dpop-key",
                URL_SAFE_NO_PAD.encode(self.signer.public_key()),
            )
            .header("x-stella-dpop-ts", at.to_string())
            .header("x-stella-dpop-alg", "ed25519");
        if path.ends_with("/messages") {
            request = request.header("anthropic-version", "2023-06-01");
        }
        if let Some(revision) = revision {
            request = request.header("x-stella-model-revision", revision);
        }
        let response = request.json(&body).send().await?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let parsed = response.json::<Value>().await;
        if !status.is_success() {
            return Err(GatewayFailure {
                status,
                code: parsed
                    .ok()
                    .and_then(|body| body["error"]["code"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unknown".into()),
                retry_after,
            }
            .into());
        }
        Ok(parsed?)
    }

    pub async fn complete(
        &self,
        context: &stella_runtime_core::agent::AgentContext,
    ) -> Result<Value> {
        let model = self.resolution["requestedModel"]
            .as_str()
            .context("Missing resolved model")?;
        let max_tokens = self.resolution["maxOutputTokens"]
            .as_u64()
            .unwrap_or(8192)
            .min(16384);
        let provider = self.resolution["provider"].as_str().unwrap_or("stella");
        let context = stella_runtime_core::agent::AgentContext {
            system_prompt: context.system_prompt.clone(),
            tools: context.tools.clone(),
            messages: stella_runtime_core::messages::transform(
                &context.messages,
                provider,
                self.resolution["protocol"].as_str().unwrap_or(""),
                model,
                self.resolution["supportsImages"] == true,
                now_ms(),
            ),
        };
        if self.resolution["protocol"] == "anthropic-messages" {
            let body = stella_runtime_core::anthropic::request(&context, model, max_tokens)?;
            let response = self
                .post("/v1/relay/v1/messages", body, Some(&self.revision))
                .await?;
            return stella_runtime_core::anthropic::response(response, model, provider, now_ms());
        }
        if self.resolution["protocol"] == "google-generative-ai" {
            let upstream = self.resolution["resolvedModel"].as_str().unwrap_or(model);
            let body = stella_runtime_core::google::request(&context, upstream, max_tokens)?;
            let mut path = reqwest::Url::parse(&format!("{}/v1/relay/models/", self.origin))?;
            path.path_segments_mut()
                .map_err(|_| anyhow::anyhow!("Invalid gateway origin"))?
                .pop_if_empty()
                .push(&format!("{model}:generateContent"));
            let response = self.post(path.path(), body, Some(&self.revision)).await?;
            return stella_runtime_core::google::response(response, model, provider, now_ms());
        }
        if self.resolution["protocol"] == "openai-responses" {
            let body = stella_runtime_core::responses::request(&context, model, max_tokens)?;
            let response = self
                .post("/v1/relay/responses", body, Some(&self.revision))
                .await?;
            return stella_runtime_core::responses::response(response, model, provider, now_ms());
        }
        if self.resolution["protocol"] != "openai-completions" {
            bail!(
                "Native completion adapter does not support {} yet",
                self.resolution["protocol"]
            );
        }
        let body = stella_runtime_core::completions::request(
            &context,
            model,
            self.resolution["maxOutputTokens"]
                .as_u64()
                .unwrap_or(8192)
                .min(16384),
        )?;
        let response = self
            .post("/v1/relay/chat/completions", body, Some(&self.revision))
            .await?;
        stella_runtime_core::completions::response(
            response,
            model,
            self.resolution["provider"].as_str().unwrap_or("stella"),
            now_ms(),
        )
    }

    pub fn ephemeral_signer() -> Result<DeviceSigner> {
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).map_err(|e| anyhow::anyhow!("Generating device signer: {e}"))?;
        Ok(DeviceSigner::Local(SigningKey::from_bytes(&seed)))
    }
}
