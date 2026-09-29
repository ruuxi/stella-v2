//! Account-scoped managed catalog discovery with the existing disk format.
use crate::{rpc::SharedService, storage::now_ms};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Catalog {
    providers: crate::provider_catalog::Providers,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    published: Mutex<Value>,
}
#[derive(Default)]
struct Entry {
    data: Mutex<Cached>,
    refresh: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct Cached {
    catalog: Option<Value>,
    version: String,
    disk_read: bool,
    last_attempt: i64,
    refreshed_at: Option<i64>,
    error: Option<String>,
}
struct Request {
    endpoint: String,
    auth: String,
    device: String,
    identity: String,
    version: String,
    file: Option<PathBuf>,
}

pub fn secure_origin(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        bail!("Service URL requires HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Service URL must not include credentials");
    }
    Ok(url.origin().ascii_serialization())
}

fn request(config: &Value) -> Result<Option<Request>> {
    let Some(auth) = config["authToken"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let Some(site) = config["convexSiteUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let endpoint = format!("{}/api/stella/models", secure_origin(site.trim())?);
    let claims = auth
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let jwt_identity = match claims {
        Some(c) => {
            let audience = match &c["aud"] {
                Value::Array(items) => items
                    .iter()
                    .map(|v| v.as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(","),
                Value::String(s) => s.clone(),
                _ => String::new(),
            };
            format!(
                "auth:jwt:{}:{}:{}:{}:{}",
                c["iss"].as_str().unwrap_or(""),
                c["sub"].as_str().unwrap_or(""),
                c["tokenIdentifier"].as_str().unwrap_or(""),
                audience,
                c["isAnonymous"]
                    .as_bool()
                    .map(|b| b.to_string())
                    .unwrap_or_default()
            )
        }
        None => format!("auth:jwt-unreadable:{:x}", Sha256::digest(auth)),
    };
    let device = config["deviceId"].as_str().unwrap_or("").trim().to_owned();
    let identity = format!(
        "{endpoint}|{jwt_identity}|{}",
        if device.is_empty() {
            "device:none"
        } else {
            &device
        }
    );
    let version = format!(
        "{identity}|{}",
        config["modelCatalogUpdatedAt"]
            .as_i64()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "model-catalog-updated-at:none".into())
    );
    let file = config["stellaDataDirPath"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|dir| {
            PathBuf::from(dir)
                .join("cache/model-catalog")
                .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())))
        });
    Ok(Some(Request {
        endpoint,
        auth: auth.trim().into(),
        device,
        identity,
        version,
        file,
    }))
}

fn validate_catalog(value: &Value) -> Result<()> {
    secure_origin(
        value["gateway"]["origin"]
            .as_str()
            .context("Catalog did not advertise a gateway origin")?,
    )?;
    for model in value["models"]
        .as_array()
        .context("Catalog models must be an array")?
    {
        for key in ["id", "name", "provider"] {
            model[key].as_str().context("Invalid catalog model")?;
        }
        if let Some(api) = model.get("api")
            && !matches!(
                api.as_str(),
                Some(
                    "openai-completions"
                        | "openai-responses"
                        | "anthropic-messages"
                        | "google-generative-ai"
                )
            )
        {
            bail!("Invalid catalog protocol");
        }
        if model.get("upstreamModel").is_some_and(|v| !v.is_string()) {
            bail!("Invalid catalog upstream model");
        }
    }
    for default in value["defaults"]
        .as_array()
        .context("Catalog defaults must be an array")?
    {
        for key in ["agentType", "model", "resolvedModel"] {
            default[key].as_str().context("Invalid catalog default")?;
        }
    }
    Ok(())
}

impl Catalog {
    pub async fn direct(
        &self,
        service: &SharedService,
        reference: &str,
    ) -> Result<crate::model_client::ModelClient> {
        let root = service.lock().unwrap().config["stellaDataDirPath"]
            .as_str()
            .map(PathBuf::from);
        self.providers.reload(root).await;
        let (model, headers) = self.providers.route(reference).await?;
        crate::model_client::ModelClient::direct(model, headers)
    }
    fn entry(&self, identity: &str) -> Arc<Entry> {
        let mut entries = self.entries.lock().unwrap();
        // Bound old signed-out accounts; active fetches keep their own Arc.
        if entries.len() >= 8 && !entries.contains_key(identity) {
            entries.clear();
        }
        entries.entry(identity.into()).or_default().clone()
    }

    async fn refresh(self: &Arc<Self>, req: Request, entry: Arc<Entry>, force: bool) {
        let queued_at = now_ms();
        let _single = entry.refresh.lock().await;
        {
            let mut cached = entry.data.lock().unwrap();
            if cached.last_attempt >= queued_at
                || (!force
                    && ((cached.catalog.is_some() && cached.version == req.version)
                        || now_ms().saturating_sub(cached.last_attempt) < 30_000))
            {
                return;
            }
            cached.last_attempt = now_ms();
        }
        let fetched: Result<Value> = async {
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(15)).build()?;
            let mut call = client.get(&req.endpoint).bearer_auth(&req.auth);
            if !req.device.is_empty() { call = call.header("X-Device-ID", &req.device); }
            let response = call.send().await?;
            if !response.status().is_success() { bail!("Catalog request failed ({})", response.status()); }
            if response.content_length().is_some_and(|len|len>8*1024*1024) { bail!("Catalog exceeds 8 MiB"); }
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len()+chunk.len()>8*1024*1024 { bail!("Catalog exceeds 8 MiB"); }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes)?;
            let origin = secure_origin(body["gateway"]["origin"].as_str().context("Catalog did not advertise a gateway origin")?)?;
            let mut models = Vec::new();
            for item in body["data"].as_array().context("Catalog data must be an array")? {
                if item.get("type").is_some_and(|t|t != "language") { continue; }
                let id = item["id"].as_str().context("Catalog model is missing its ID")?;
                let mut model = json!({"id":id,"name":item["name"].as_str().unwrap_or(id),"provider":item["provider"].as_str().unwrap_or("stella")});
                for key in ["api", "upstreamModel"] { if let Some(v) = item.get(key) { model[key] = v.clone(); } }
                models.push(model);
            }
            let catalog = json!({"models":models,"defaults":body.get("defaults").cloned().unwrap_or_else(||json!([])),"gateway":{"origin":origin}});
            validate_catalog(&catalog)?;
            Ok(catalog)
        }.await;
        match fetched {
            Ok(catalog) => {
                if let Some(file) = &req.file {
                    // The cache is advisory; a read-only/full disk must not
                    // discard an otherwise valid authenticated catalog.
                    let _ =
                        write_cache(file, &json!({"cacheKey":req.version,"catalog":catalog})).await;
                }
                let mut cached = entry.data.lock().unwrap();
                cached.catalog = Some(catalog);
                cached.version = req.version;
                cached.error = None;
                cached.refreshed_at = Some(now_ms());
            }
            Err(error) => entry.data.lock().unwrap().error = Some(format!("{error:#}")),
        }
    }

    async fn managed(
        self: &Arc<Self>,
        service: &SharedService,
        force: bool,
    ) -> Result<Option<Value>> {
        let config = service.lock().unwrap().config.clone();
        let Some(req) = request(&config)? else {
            return Ok(None);
        };
        let entry = self.entry(&req.identity);
        {
            let _single = entry.refresh.lock().await;
            let read_disk = !entry.data.lock().unwrap().disk_read;
            if read_disk {
                if let Some(file) = &req.file
                    && let Ok(bytes) = read_cache(file).await
                    && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(version) = body["cacheKey"].as_str()
                    && version.starts_with(&format!("{}|", req.identity))
                    && validate_catalog(&body["catalog"]).is_ok()
                {
                    let mut cached = entry.data.lock().unwrap();
                    cached.catalog = Some(body["catalog"].clone());
                    cached.version = version.into();
                }
                entry.data.lock().unwrap().disk_read = true;
            }
        }
        let (cached, fresh) = {
            let data = entry.data.lock().unwrap();
            (data.catalog.clone(), data.version == req.version)
        };
        if cached.is_some() && !force {
            if !fresh {
                let this = self.clone();
                let service = Arc::downgrade(service);
                tokio::spawn(async move {
                    this.refresh(req, entry, false).await;
                    if let Some(service) = service.upgrade() {
                        this.publish(&service);
                    }
                });
            }
            return Ok(cached);
        }
        self.refresh(req, entry.clone(), force).await;
        let data = entry.data.lock().unwrap();
        if data.catalog.is_none() {
            bail!(
                "{}",
                data.error.as_deref().unwrap_or("Model catalog unavailable")
            );
        }
        Ok(data.catalog.clone())
    }

    fn snapshot(&self, config: &Value) -> Value {
        let mut models = Vec::new();
        let mut snapshot = json!({"runtimeManagedProviders":[],"refreshedAt":null});
        match request(config) {
            Ok(Some(req)) => {
                let entry = self.entry(&req.identity);
                let data = entry.data.lock().unwrap();
                if let Some(catalog) = &data.catalog {
                    let origin = catalog["gateway"]["origin"].as_str().unwrap();
                    models.extend(
                        catalog["models"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|m| {
                                m["id"].as_str().is_some_and(|id| id.starts_with("stella/"))
                            })
                            .map(|m| stella_runtime_core::catalog::managed_model(m, origin)),
                    );
                }
                snapshot["refreshedAt"] = json!(data.refreshed_at);
                if let Some(error) = &data.error {
                    snapshot["catalogError"] = json!(error);
                }
            }
            Err(error) => snapshot["catalogError"] = json!(error.to_string()),
            _ => {}
        }
        let mut providers = self.providers.snapshot(models);
        if snapshot["refreshedAt"].as_i64() > providers["refreshedAt"].as_i64() {
            providers["refreshedAt"] = snapshot["refreshedAt"].clone();
        }
        if let Some(error) = snapshot["catalogError"].as_str() {
            providers["catalogError"] = json!(match providers["catalogError"].as_str() {
                Some(other) => format!("{other}\n{error}"),
                None => error.into(),
            });
        }
        providers
    }

    pub fn publish(&self, service: &SharedService) -> Value {
        let state = service.lock().unwrap();
        let mut snapshot = self.snapshot(&state.config);
        let mut previous = self.published.lock().unwrap();
        let revision = previous["revision"].as_u64().unwrap_or(0);
        snapshot["revision"] = json!(revision);
        if *previous != snapshot {
            snapshot["revision"] = json!(revision + 1);
            *previous = snapshot.clone();
            let _ = state
                .notifications
                .send(json!({"method":"modelCatalog.updated","params":snapshot}));
        }
        snapshot
    }

    pub async fn list(self: &Arc<Self>, service: &SharedService, force: bool) -> Value {
        let root = service.lock().unwrap().config["stellaDataDirPath"]
            .as_str()
            .map(PathBuf::from);
        self.providers.reload(root).await;
        // Listing retains the last usable registry and surfaces failures in the
        // snapshot, so a network outage does not empty the picker.
        let _ = self.managed(service, force).await;
        if force {
            self.providers.refresh(true).await;
        } else {
            let this = self.clone();
            let weak = Arc::downgrade(service);
            tokio::spawn(async move {
                this.providers.refresh(false).await;
                if let Some(service) = weak.upgrade() {
                    this.publish(&service);
                }
            });
        }
        self.publish(service)
    }

    pub async fn gateway(self: &Arc<Self>, service: &SharedService) -> Result<String> {
        let explicit = std::env::var("STELLA_MODEL_GATEWAY_URL").ok().or_else(|| {
            service.lock().unwrap().config["modelGatewayUrl"]
                .as_str()
                .map(str::to_owned)
        });
        if let Some(origin) = explicit {
            return secure_origin(&origin);
        }
        let catalog = self
            .managed(service, false)
            .await?
            .context("Signed-in model catalog configuration is required")?;
        Ok(catalog["gateway"]["origin"]
            .as_str()
            .context("Catalog gateway missing")?
            .into())
    }
}

pub(crate) async fn read_cache(path: &std::path::Path) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 8 * 1024 * 1024 {
        bail!("Catalog cache exceeds 8 MiB");
    }
    Ok(bytes)
}

pub(crate) async fn write_cache(path: &std::path::Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("Cache path has no parent")?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(".{}.tmp", ulid::Ulid::new()));
    let result: Result<()> = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&serde_json::to_vec(value)?).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    result
}
