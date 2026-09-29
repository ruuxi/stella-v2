//! Native single-writer admission and durable delivery to the existing DO.
use crate::{backend, rpc::SharedService, storage::now_ms};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::watch;

pub struct Lease {
    service: SharedService,
    conversation: String,
    payload: Value,
    pub history: Vec<Value>,
    pub token: String,
    stop: watch::Sender<bool>,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}
struct Response {
    status: u16,
    body: Value,
}
async fn post(
    service: &SharedService,
    conversation: &str,
    endpoint: &str,
    payload: &Value,
) -> Result<Response> {
    let realtime = backend::query(service, "cloud_apps:getCloudRealtimeConfig", json!({})).await?;
    let origin = realtime["httpOrigin"]
        .as_str()
        .context("Cloud realtime origin unavailable")?;
    let mut url = reqwest::Url::parse(origin)?;
    if url.scheme() != "https"
        && url.host_str() != Some("localhost")
        && url.host_str() != Some("127.0.0.1")
    {
        bail!("Cloud transcript requires HTTPS");
    }
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Invalid cloud origin"))?
        .clear()
        .extend(["conversations", conversation, "local-turns", endpoint]);
    let token = service.lock().unwrap().config["authToken"]
        .as_str()
        .context("Authentication required")?
        .to_owned();
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()?
        .post(url)
        .bearer_auth(token)
        .json(payload)
        .send()
        .await?;
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok(Response { status, body })
}
fn terminal(response: &Response) -> bool {
    response.status == 410
        || response.status == 409
            && matches!(
                response.body["code"].as_str(),
                Some(
                    "lease_mismatch"
                        | "turn_expired"
                        | "turn_finished"
                        | "turn_canceled"
                        | "idempotency_conflict"
                        | "OWNER_DATA_GENERATION_STALE"
                )
            )
}
fn check_ack(body: &Value) -> Result<()> {
    if body["leaseToken"].as_str().is_none_or(str::is_empty)
        || body["turnId"].as_str().is_none_or(str::is_empty)
        || body["expiresAt"].as_i64().unwrap_or(0) <= now_ms()
        || !body["history"]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string))
        || body["contextStartSeq"].as_i64().is_none()
        || body["contextEndSeq"].as_i64().is_none()
    {
        bail!("Invalid cloud admission acknowledgment");
    }
    Ok(())
}
impl Lease {
    pub async fn begin(
        service: SharedService,
        run: Arc<crate::runs::Run>,
        mut generation: String,
        prompt: Value,
    ) -> Result<Self> {
        if generation.is_empty() {
            generation = backend::query(
                &service,
                "execution_placement:getMyExecutionPlacementIdentity",
                json!({}),
            )
            .await?["ownerGeneration"]
                .as_str()
                .context("Owner generation unavailable")?
                .to_owned();
        }
        let device = service.lock().unwrap().config["deviceId"]
            .as_str()
            .context("Device identity unavailable")?
            .to_owned();
        let payload = json!({"deviceId":device,"expectedOwnerGeneration":generation,"localTurnId":run.id,"clientMsgId":run.user_id,"userMessageJson":serde_json::to_string(&prompt)?});
        let id = {
            let mut state = service.lock().unwrap();
            let after = state.store()?.thread_last_sequence(&run.thread)?;
            state.store()?.put_transcript(
                &run.conversation,
                "begin",
                &payload,
                Some(&json!({"kind":"native-thread","threadId":run.thread,"afterSequence":after})),
            )?
        };
        let mut canceled = run.cancel.subscribe();
        let mut attempts = 0;
        let (ack, admitted_at) = loop {
            if *canceled.borrow() {
                bail!("Run canceled before cloud admission");
            }
            let sent_at = now_ms();
            let response = tokio::select! {result=post(&service,&run.conversation,"begin",&payload)=>result,_=canceled.changed()=>bail!("Run canceled before cloud admission")};
            attempts += 1;
            match response {
                Ok(response)
                    if (200..300).contains(&response.status)
                        && check_ack(&response.body).is_ok() =>
                {
                    break (response.body, sent_at);
                }
                Ok(response) if terminal(&response) => {
                    service.lock().unwrap().store()?.transcript_delete(&id)?;
                    bail!(
                        "Cloud turn admission ended: {}",
                        response.body["code"]
                            .as_str()
                            .unwrap_or("conversation_deleted")
                    );
                }
                Ok(response) if response.status == 400 || response.status == 413 => {
                    service.lock().unwrap().store()?.transcript_attempt(
                        &id,
                        Some("Cloud admission rejected"),
                        true,
                    )?;
                    bail!("Cloud turn admission rejected ({})", response.status);
                }
                _ => service.lock().unwrap().store()?.transcript_attempt(
                    &id,
                    Some("Cloud admission retry"),
                    false,
                )?,
            }
            tokio::select! {_=tokio::time::sleep(std::time::Duration::from_millis((500_u64<<attempts.min(7)).min(60000)))=>{},_=canceled.changed()=>bail!("Run canceled before cloud admission")};
        };
        let token = ack["leaseToken"].as_str().unwrap().to_owned();
        let history = ack["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| serde_json::from_str(v.as_str().unwrap()))
            .collect::<std::result::Result<Vec<Value>, _>>()?;
        let (stop, mut stopped) = watch::channel(false);
        let heartbeat_service = service.clone();
        let heartbeat_payload = json!({"deviceId":device,"expectedOwnerGeneration":generation,"localTurnId":run.id,"leaseToken":token,"renewOnly":true});
        let heartbeat = tokio::spawn(async move {
            let mut deadline =
                (admitted_at + 30_000).min(ack["expiresAt"].as_i64().unwrap() - 5000);
            loop {
                if *stopped.borrow() {
                    break;
                }
                let remaining = deadline.saturating_sub(now_ms());
                if remaining <= 0 {
                    run.cancel.send_replace(true);
                    break;
                }
                tokio::select! {_=tokio::time::sleep(std::time::Duration::from_millis(10_000.min(remaining as u64)))=>{},_=stopped.changed()=>break};
                let sent = now_ms();
                let remaining = deadline.saturating_sub(sent);
                if remaining <= 0 {
                    run.cancel.send_replace(true);
                    break;
                }
                let attempt = tokio::time::timeout(
                    std::time::Duration::from_millis(remaining as u64),
                    post(
                        &heartbeat_service,
                        &run.conversation,
                        "begin",
                        &heartbeat_payload,
                    ),
                );
                let response =
                    tokio::select! {response=attempt=>response,_=stopped.changed()=>break};
                match response {
                    Ok(Ok(response))
                        if (200..300).contains(&response.status)
                            && check_ack(&response.body).is_ok() =>
                    {
                        deadline =
                            (sent + 30_000).min(response.body["expiresAt"].as_i64().unwrap() - 5000)
                    }
                    Ok(Ok(response)) if terminal(&response) => {
                        run.cancel.send_replace(true);
                        break;
                    }
                    _ => {}
                }
            }
        });
        Ok(Self {
            service,
            conversation: payload_conversation(&id)?,
            payload,
            history,
            token,
            stop,
            heartbeat: Some(heartbeat),
        })
    }
    pub async fn finish(mut self, records: &[Value], phase: &str) -> Result<()> {
        let records=records.iter().filter(|m|m["role"]=="assistant"||m["role"]=="toolResult").enumerate().map(|(ordinal,message)|Ok(json!({"ordinal":ordinal,"role":message["role"],"payloadJson":serde_json::to_string(message)?}))).collect::<Result<Vec<_>>>()?;
        let payload = json!({"deviceId":self.payload["deviceId"],"expectedOwnerGeneration":self.payload["expectedOwnerGeneration"],"localTurnId":self.payload["localTurnId"],"leaseToken":self.token,"records":records,"phase":phase});
        let id = self.service.lock().unwrap().store()?.put_transcript(
            &self.conversation,
            "finish",
            &payload,
            None,
        )?;
        self.stop.send_replace(true);
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.await?;
        }
        if records.len() > 1024 || serde_json::to_vec(&payload)?.len() > 16 * 1024 * 1024 {
            self.service.lock().unwrap().store()?.transcript_attempt(
                &id,
                Some("Cloud finish exceeds protocol limits"),
                true,
            )?;
            bail!("Cloud response exceeds transcript limits");
        }
        if let Ok(response) = post(&self.service, &self.conversation, "finish", &payload).await {
            settle_delivery(&self.service, &id, &response)?;
        }
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
fn payload_conversation(id: &str) -> Result<String> {
    Ok(serde_json::from_str::<Value>(
        id.strip_prefix("cloud-transcript:")
            .context("Invalid outbox ID")?,
    )?[2]
        .as_str()
        .context("Invalid conversation")?
        .into())
}
fn settle_delivery(service: &SharedService, id: &str, response: &Response) -> Result<()> {
    let mut state = service.lock().unwrap();
    let store = state.store()?;
    if (200..300).contains(&response.status) || terminal(response) {
        store.transcript_delete(id)?;
    } else {
        store.transcript_attempt(
            id,
            Some(response.body["code"].as_str().unwrap_or("delivery_failed")),
            response.status == 400 || response.status == 413,
        )?;
    }
    Ok(())
}

/// One service-owned recovery task. In-flight begins stay owned by their runs;
/// orphaned begins are reacquired idempotently and terminalized after restart.
pub fn start_delivery(service: &SharedService) {
    let weak = Arc::downgrade(service);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
        loop {
            interval.tick().await;
            let Some(service) = weak.upgrade() else {
                break;
            };
            let rows = {
                let mut state = service.lock().unwrap();
                if state.config["authToken"].as_str().is_none() {
                    continue;
                }
                match state.store().and_then(|s| s.transcript_outbox()) {
                    Ok(rows) => rows,
                    Err(_) => continue,
                }
            };
            for row in rows {
                let id = row["id"].as_str().unwrap();
                let kind = row["kind"].as_str().unwrap();
                let conversation = row["conversationId"].as_str().unwrap();
                if kind == "begin"
                    && service
                        .lock()
                        .unwrap()
                        .active_runs()
                        .iter()
                        .any(|run| row["payload"]["localTurnId"] == run.id)
                {
                    continue;
                }
                let attempts = row["attempts"].as_u64().unwrap_or(0);
                if attempts > 0
                    && now_ms() - row["updatedAt"].as_i64().unwrap_or(0)
                        < (500_i64 << attempts.min(7)).min(60_000)
                {
                    continue;
                }
                match post(&service, conversation, kind, &row["payload"]).await {
                    Ok(response)
                        if kind == "begin"
                            && (200..300).contains(&response.status)
                            && check_ack(&response.body).is_ok() =>
                    {
                        let recovery = &row["recovery"];
                        let precomputed = recovery["kind"] == "precomputed-finish";
                        let recovered = if recovery["kind"] == "native-thread" {
                            let mut state = service.lock().unwrap();
                            state.store().and_then(|store|store.thread_messages_after(recovery["threadId"].as_str().unwrap_or(""),recovery["afterSequence"].as_i64().unwrap_or(0))).ok().map(|messages|messages.into_iter().filter(|m|m["role"]=="assistant"||m["role"]=="toolResult").enumerate().map(|(ordinal,m)|json!({"ordinal":ordinal,"role":m["role"],"payloadJson":m.to_string()})).collect::<Vec<_>>())
                        } else {
                            None
                        };
                        let payload = json!({"deviceId":row["payload"]["deviceId"],"expectedOwnerGeneration":row["payload"]["expectedOwnerGeneration"],"localTurnId":row["payload"]["localTurnId"],"leaseToken":response.body["leaseToken"],"records":if precomputed {recovery["records"].clone()}else{json!(recovered.unwrap_or_default())},"phase":if precomputed {recovery["phase"].clone()}else{json!("canceled")}});
                        let _ = service.lock().unwrap().store().and_then(|store| {
                            store.put_transcript(conversation, "finish", &payload, None)
                        });
                    }
                    Ok(response) if kind == "begin" && (200..300).contains(&response.status) => {
                        let _ = service.lock().unwrap().store().and_then(|store| {
                            store.transcript_attempt(id, Some("invalid_begin_ack"), false)
                        });
                    }
                    Ok(response) => {
                        let _ = settle_delivery(&service, id, &response);
                    }
                    Err(_) => {
                        let _ =
                            service.lock().unwrap().store().and_then(|store| {
                                store.transcript_attempt(id, Some("network"), false)
                            });
                    }
                }
            }
        }
    });
}
