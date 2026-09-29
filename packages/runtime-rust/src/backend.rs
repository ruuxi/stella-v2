use crate::rpc::SharedService;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

pub async fn query(service: &SharedService, path: &str, args: Value) -> Result<Value> {
    let (origin, auth) = {
        let state = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
        (
            state.config["convexUrl"]
                .as_str()
                .context("Convex URL is required")?
                .to_owned(),
            state.config["authToken"]
                .as_str()
                .context("Authentication is required")?
                .to_owned(),
        )
    };
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()?
        .post(format!("{}/api/query", origin.trim_end_matches('/')))
        .bearer_auth(auth)
        .json(&json!({"path":path,"args":args,"format":"json"}))
        .send()
        .await?;
    if !response.status().is_success() {
        bail!("Backend query {path} failed ({})", response.status());
    }
    let body: Value = response.json().await?;
    if body["status"] != "success" {
        bail!("Backend query {path} failed");
    }
    Ok(body["value"].clone())
}
