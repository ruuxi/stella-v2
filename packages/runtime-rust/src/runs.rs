//! Service-owned native execution. Disconnecting an RPC client never drops an
//! admitted run; cancellation waits for provider/tool futures to settle first.
use crate::{
    execution::NativeExecution,
    gateway::{DeviceSigner, Gateway},
    rpc::SharedService,
    storage::{chat::AppendEvent, now_ms},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicI64, Ordering},
};
use stella_runtime_core::agent::{AgentContext, Execution, ToolCall, ToolResult};
use tokio::sync::watch;

pub struct Run {
    pub id: String,
    pub conversation: String,
    pub thread: String,
    pub user_id: String,
    pub request_id: Option<String>,
    pub agent_type: String,
    cloud: bool,
    input: Mutex<Vec<Value>>,
    submitted: Mutex<std::collections::BTreeMap<String, String>>,
    accepting: AtomicBool,
    prompt_owner: Mutex<Value>,
    transcript: Mutex<Vec<Value>>,
    tool_results: Mutex<std::collections::BTreeMap<String, Value>>,
    pub cancel: watch::Sender<bool>,
    pub finished: watch::Sender<Option<Value>>,
    sequence: AtomicI64,
    completed_at: AtomicI64,
    failure: Mutex<Option<String>>,
    work: Arc<crate::work::Work>,
}
impl Run {
    pub fn lose_lease(&self, reason: &str) {
        *self.failure.lock().unwrap() = Some(reason.to_owned());
        self.cancel.send_replace(true);
    }
    pub fn snapshot(&self) -> Value {
        let owner = self.prompt_owner.lock().unwrap();
        json!({"runId":self.id,"conversationId":self.conversation,"requestId":owner["requestId"],"userMessageId":owner["userMessageId"],"agentType":self.agent_type})
    }
    fn settle_tools(&self, service: &SharedService, reason: &str) -> Result<()> {
        let transcript = self.transcript.lock().unwrap().clone();
        for message in &transcript {
            if message["role"] != "assistant" {
                continue;
            }
            for call in message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| block["type"] == "toolCall")
            {
                let id = call["id"].as_str().context("Tool call has no identity")?;
                if transcript
                    .iter()
                    .any(|m| m["role"] == "toolResult" && m["toolCallId"] == id)
                {
                    continue;
                }
                let completed = self.tool_results.lock().unwrap().remove(id);
                let result = if let Some(result) = completed {
                    result
                } else {
                    let text = format!(
                        "Tool execution interrupted: {reason}. An operation may have completed before interruption; verify its effects before retrying."
                    );
                    self.publish(service,json!({"type":"tool-end","toolCallId":id,"toolName":call["name"],"isError":true,"resultPreview":text,"details":{}}))?;
                    json!({"role":"toolResult","toolCallId":id,"toolName":call["name"],"isError":true,"content":[{"type":"text","text":text}],"details":{},"timestamp":now_ms()})
                };
                service
                    .lock()
                    .unwrap()
                    .store()?
                    .append_thread_message(&self.thread, &result)?;
                self.transcript.lock().unwrap().push(result);
            }
        }
        Ok(())
    }
    fn publish(&self, service: &SharedService, mut event: Value) -> Result<()> {
        let mut state = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
        // Sequence allocation and durable insertion share the same critical
        // section, including when multiple tools publish concurrently.
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        event
            .as_object_mut()
            .context("Invalid run event")?
            .extend(self.snapshot().as_object().unwrap().clone());
        event["seq"] = json!(seq);
        state
            .run_events
            .as_mut()
            .context("Run log unavailable")?
            .append(&event)?;
        let _ = state
            .notifications
            .send(json!({"jsonrpc":"2.0","method":"run.event","params":event}));
        Ok(())
    }
    pub async fn join(&self) -> Result<Value> {
        let mut receiver = self.finished.subscribe();
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return Ok(result);
            }
            receiver
                .changed()
                .await
                .context("Run settlement channel closed")?;
        }
    }
}

struct RuntimeExecution {
    native: NativeExecution,
    service: SharedService,
    run: Arc<Run>,
}
impl RuntimeExecution {
    fn record(&self, event: Value) -> Result<()> {
        match event["type"].as_str().unwrap_or("") {
            "message_start" if event["message"]["stellaPromptOwner"].is_object()=>{
                *self.run.prompt_owner.lock().unwrap()=event["message"]["stellaPromptOwner"].clone();
            }

            "message_end"=>{
                let mut durable=event["message"].clone();
                if let Some(object)=durable.as_object_mut(){object.remove("stellaPromptOwner");}
                let message=&durable;
                let prompt_owner=self.run.prompt_owner.lock().unwrap().clone();
                self.run.transcript.lock().unwrap().push(message.clone());
                self.service.lock().map_err(|_|anyhow::anyhow!("Runtime state poisoned"))?.store()?.append_thread_message(&self.run.thread,message)?;
                if message["role"]=="toolResult" && let Some(id)=message["toolCallId"].as_str(){self.run.tool_results.lock().unwrap().remove(id);}
                if message["role"]=="assistant" {
                    let text=message_text(message);
                    if !text.is_empty() {
                        let mut state=self.service.lock().map_err(|_|anyhow::anyhow!("Runtime state poisoned"))?;
                        let id=format!("assistant-msg-{}-{}",self.run.id,self.run.sequence.load(Ordering::SeqCst)+1);
                        let followed=message["content"].as_array().is_some_and(|v|v.iter().any(|c|c["type"]=="toolCall"));
                        if !self.run.cloud {
                        let stored=state.store()?.append_event(serde_json::from_value::<AppendEvent>(json!({"conversationId":self.run.conversation,"eventId":id,"requestId":prompt_owner["userMessageId"],"type":"assistant_message","payload":{"text":text,"userMessageId":prompt_owner["userMessageId"],"metadata":{"runtime":{"followedByToolCall":followed,"turnComplete":!followed,"responseTarget":{"type":"user_turn"}}}}}))?)?;
                        let _=state.notifications.send(json!({"method":"localChat.updated","params":{"conversationId":self.run.conversation,"event":stored}}));
                        }
                        drop(state);
                        self.run.publish(&self.service,json!({"type":"assistant-message","assistantMessageText":text,"assistantMessageEventId":if self.run.cloud {Value::Null}else{json!(id)},"followedByToolCall":followed,"responseTarget":{"type":"user_turn"}}))?;
                    }
                }
            }
            "tool_execution_start"=>self.run.publish(&self.service,json!({"type":"tool-start","toolCallId":event["toolCallId"],"toolName":event["toolName"],"args":event["args"]}))?,
            "tool_execution_end"=>{
                if let Some(id)=event["toolCallId"].as_str(){self.run.tool_results.lock().unwrap().insert(id.into(),json!({"role":"toolResult","toolCallId":id,"toolName":event["toolName"],"isError":event["isError"],"content":event["result"]["content"],"details":event["result"]["details"],"timestamp":now_ms()}));}
                self.run.publish(&self.service,json!({"type":"tool-end","toolCallId":event["toolCallId"],"toolName":event["toolName"],"isError":event["isError"],"resultPreview":message_text(&event["result"]),"details":event["result"]["details"]}))?;
            }
            _=>{}
        }
        Ok(())
    }
}
impl Execution for RuntimeExecution {
    fn tool_concurrency(&self) -> usize {
        8
    }
    async fn steering(&self) -> Result<Vec<Value>> {
        Ok(std::mem::take(&mut *self.run.input.lock().unwrap()))
    }
    async fn follow_up(&self) -> Result<Vec<Value>> {
        self.steering().await
    }

    fn emit(&self, event: Value) {
        if let Err(error) = self.record(event) {
            *self.run.failure.lock().unwrap() = Some(format!("{error:#}"));
            self.run.cancel.send_replace(true);
        }
    }
    fn now_ms(&self) -> i64 {
        now_ms()
    }
    fn canceled(&self) -> bool {
        *self.run.cancel.borrow()
    }
    async fn complete(&self, context: &AgentContext) -> Result<Value> {
        if let Some(error) = self.run.failure.lock().unwrap().as_ref() {
            bail!("{error}");
        }
        let mut canceled = self.run.cancel.subscribe();
        if *canceled.borrow() {
            bail!("Run canceled");
        }
        tokio::select! {
            message=self.native.gateway.complete(context)=>message,
            _=canceled.changed()=>bail!("Run canceled"),
        }
    }
    async fn execute(&self, call: &ToolCall) -> Result<ToolResult> {
        let mut canceled = self.run.cancel.subscribe();
        if *canceled.borrow() {
            bail!("Run canceled");
        }
        tokio::select! {
            result=self.native.execute(call)=>result,
            _=canceled.changed()=>bail!("Tool canceled"),
        }
    }
}

pub fn message_text(message: &Value) -> String {
    message["content"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
}

pub fn start(service: SharedService, params: Value) -> Result<Arc<Run>> {
    let conversation = params["conversationId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .context("conversationId is required")?
        .to_owned();
    let prompt = params["userPrompt"]
        .as_str()
        .context("userPrompt is required")?
        .to_owned();
    let kind = params["agentType"]
        .as_str()
        .unwrap_or("orchestrator")
        .to_owned();
    let definition =
        stella_runtime_core::builtin::agent(&kind).context("Unknown built-in agent")?;
    let cloud = params["storageMode"] == "cloud";
    let (run, config, host, lane) = {
        let mut state = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
        let host = state
            .host
            .clone()
            .context("No initialized host is attached")?;
        let request_id = params["requestId"].as_str().map(str::to_owned);
        // Reserve before any network await. A duplicate request returns its
        // original run and cannot execute the user's side effects a second time.
        if let Some(existing) = state.runs.values().find(|r| {
            r.conversation == conversation && request_id.is_some() && r.request_id == request_id
        }) {
            return Ok(existing.clone());
        }
        state.runs.retain(|_, r| {
            let completed = r.completed_at.load(Ordering::Relaxed);
            completed == 0 || now_ms() - completed < 30 * 60 * 1000
        });
        let user_id = params["userMessageEventId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| ulid::Ulid::new().to_string());
        if !cloud
            && let Some(active) = state
                .runs
                .values()
                .find(|r| {
                    !r.cloud
                        && r.conversation == conversation
                        && r.agent_type == kind
                        && r.accepting.load(Ordering::SeqCst)
                        && r.finished.borrow().is_none()
                })
                .cloned()
        {
            {
                let mut submitted = active.submitted.lock().unwrap();
                if let Some(previous) = submitted.get(&user_id) {
                    if previous != &prompt {
                        bail!("User message identity was reused with different text");
                    }
                    return Ok(active.clone());
                }
                submitted.insert(user_id.clone(), prompt.clone());
            }
            let timestamp = params["userMessageTimestamp"]
                .as_i64()
                .unwrap_or_else(now_ms);
            state.store()?.append_event(serde_json::from_value(json!({"conversationId":conversation,"eventId":user_id,"requestId":user_id,"type":"user_message","timestamp":timestamp,"payload":{"text":prompt}}))?)?;
            let mut input = active.input.lock().unwrap();
            // This mutex is also the natural-stop fence. If it closed while we
            // acquired the service lock, admit a new queued run below.
            if active.accepting.load(Ordering::SeqCst) {
                input.push(json!({"role":"user","content":[{"type":"text","text":prompt}],"timestamp":timestamp,"stellaPromptOwner":{"userMessageId":user_id,"requestId":request_id}}));
                let _ = state.notifications.send(
                    json!({"method":"localChat.updated","params":{"conversationId":conversation}}),
                );
                drop(input);
                return Ok(active);
            }
        }
        let thread_id = format!("{kind}:{conversation}");
        let (thread, _) =
            state
                .store()?
                .resolve_thread(&conversation, &kind, Some(&thread_id), &kind)?;

        if !cloud {
            let user=state.store()?.append_event(serde_json::from_value(json!({"conversationId":conversation,"eventId":user_id,"requestId":user_id,"type":"user_message","timestamp":params["userMessageTimestamp"].as_i64().unwrap_or_else(now_ms),"payload":{"text":prompt}}))?)?;
            let _=state.notifications.send(json!({"method":"localChat.updated","params":{"conversationId":conversation,"event":user}}));
        }
        let run = Arc::new(Run {
            id: ulid::Ulid::new().to_string(),
            conversation,
            thread,
            prompt_owner: Mutex::new(json!({"userMessageId":user_id,"requestId":request_id})),
            input: Mutex::new(Vec::new()),
            submitted: Mutex::new(std::collections::BTreeMap::from([(
                user_id.clone(),
                prompt.clone(),
            )])),
            accepting: AtomicBool::new(true),
            user_id,
            request_id,
            agent_type: kind.clone(),
            cloud,
            transcript: Mutex::new(Vec::new()),
            tool_results: Default::default(),
            cancel: watch::channel(false).0,
            finished: watch::channel(None).0,
            sequence: AtomicI64::new(0),
            completed_at: AtomicI64::new(0),
            failure: Mutex::new(None),
            work: Default::default(),
        });
        state.runs.insert(run.id.clone(), run.clone());
        (
            run,
            state.config.clone(),
            host,
            state.orchestrator_lane.clone(),
        )
    };
    let owned = run.clone();
    tokio::spawn(async move {
        let mut lease = None;
        let mut canceled = owned.cancel.subscribe();
        let _lane = if *canceled.borrow() {
            None
        } else {
            tokio::select! { lock=lane.lock_owned()=>Some(lock),_=canceled.changed()=>None }
        };
        let execution_result: Result<String> = tokio::select! {
          result=async {
            if *owned.cancel.borrow(){bail!("Run canceled");}
            owned.publish(&service,json!({"type":"run-started","responseTarget":{"type":"user_turn"}}))?;
            let history=service.lock().unwrap().store()?.raw_thread_messages(&owned.thread)?;
            let user_message=json!({"role":"user","content":[{"type":"text","text":prompt}],"timestamp":params["userMessageTimestamp"].as_i64().unwrap_or_else(now_ms)});
            let history=if cloud {
                let admitted=crate::cloud_transcript::Lease::begin(service.clone(),owned.clone(),params["ownerGeneration"].as_str().unwrap_or("").to_owned(),user_message.clone()).await?;
                let history=admitted.history.clone();
                lease=Some(admitted);
                history
            }else{history};
            let catalog=service.lock().unwrap().catalog.clone();
            let origin=catalog.gateway(&service).await?;
            let auth=config["authToken"].as_str().context("Managed execution requires authentication")?;
            let signer=DeviceSigner::from_host(host).await?;
            let gateway=Gateway::connect(&origin,auth,&kind,params["model"].as_str().unwrap_or("stella/default"),signer).await?;
            let (files,shells)={let state=service.lock().unwrap();(state.files.clone(),state.shells.clone())};
            let native=NativeExecution{shells,shell_owner:json!({"conversationId":owned.conversation,"agentId":if kind=="orchestrator"{None}else{Some(&owned.thread)},"agentType":kind,"runId":owned.id}),work:owned.work.clone(),gateway,canceled:AtomicBool::new(false),files,file_context:crate::file_tools::FileContext{data_dir:config["stellaDataDirPath"].as_str().map(std::path::PathBuf::from),app_dir:config["stellaAppDir"].as_str().map(std::path::PathBuf::from),workspace_root:params["toolWorkspaceRoot"].as_str().map(std::path::PathBuf::from),scope:owned.thread.clone()}};
            let execution=RuntimeExecution{native,service:service.clone(),run:owned.clone()};
            let tools=stella_runtime_core::tools::native_definitions(&definition.tools);
            let mut context=AgentContext{system_prompt:definition.system_prompt.into(),messages:history,tools};
            let mut prompts=vec![user_message];
            let mut messages=Vec::new();
            loop {
                messages.extend(stella_runtime_core::agent::run(&execution,&mut context,prompts).await?);
                let pending={let mut input=owned.input.lock().unwrap();if input.is_empty(){owned.accepting.store(false,Ordering::SeqCst);}std::mem::take(&mut *input)};
                if pending.is_empty() || execution.canceled(){break;}
                prompts=pending;
            }
            if let Some(error)=owned.failure.lock().unwrap().as_ref(){bail!("{error}");}
            Ok(messages.iter().rev().find(|m|m["role"]=="assistant").map(message_text).unwrap_or_default())
          }=>result,
          _=canceled.changed()=>Err(anyhow::anyhow!("Run canceled")),
        };
        owned.accepting.store(false, Ordering::SeqCst);
        owned.work.settle().await;
        if let Err(error) = owned.settle_tools(
            &service,
            if *owned.cancel.borrow() {
                "run canceled"
            } else {
                "run ended before tool settlement"
            },
        ) {
            *owned.failure.lock().unwrap() =
                Some(format!("Unable to settle tool transcript: {error:#}"));
        }
        let failure = owned.failure.lock().unwrap().clone();
        let canceled = *owned.cancel.borrow() && failure.is_none();
        let (mut outcome, text, mut error) = match execution_result {
            Ok(text) if !canceled => ("success", text, None),
            Ok(_) => ("canceled", String::new(), None),
            Err(error) => (
                if canceled { "canceled" } else { "error" },
                String::new(),
                Some(format!("{error:#}")),
            ),
        };
        if let Some(failure) = failure {
            outcome = "error";
            error = Some(failure);
        }
        if let Some(lease) = lease {
            let records = owned.transcript.lock().unwrap().clone();
            let phase = match outcome {
                "success" => "completed",
                "canceled" => "canceled",
                _ => "failed",
            };
            if let Err(delivery) = lease.finish(&records, phase).await {
                outcome = "error";
                error = Some(format!("Cloud transcript settlement failed: {delivery:#}"));
            }
        }
        let terminal = json!({"type":"run-finished","outcome":outcome,"finalText":text,"error":error,"persisted":true});
        let settled = match owned.publish(&service, terminal) {
            Ok(()) => {
                json!({"status":if outcome=="success"{"ok"}else{"error"},"finalText":text,"error":error,"outcome":outcome})
            }
            Err(error) => {
                json!({"status":"error","finalText":"","error":format!("Could not persist terminal event: {error:#}")})
            }
        };
        owned.completed_at.store(now_ms(), Ordering::Relaxed);
        owned.finished.send_replace(Some(settled));
        let pending = std::mem::take(&mut *owned.input.lock().unwrap());
        for message in pending {
            let owner = &message["stellaPromptOwner"];
            let payload = json!({"conversationId":owned.conversation,"agentType":owned.agent_type,"storageMode":"local","userPrompt":message_text(&message),"userMessageEventId":owner["userMessageId"],"requestId":owner["requestId"],"userMessageTimestamp":message["timestamp"]});
            if let Err(error) = start(service.clone(), payload) {
                eprintln!("Unable to recover queued user input: {error:#}");
            }
        }
    });
    Ok(run)
}
