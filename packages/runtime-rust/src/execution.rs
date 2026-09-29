use crate::{
    gateway::Gateway,
    storage::{Store, chat::AppendEvent, now_ms},
};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use stella_runtime_core::agent::{AgentContext, Execution, ToolCall, ToolResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub prompt: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub conversation_id: Option<String>,
}

pub struct NativeExecution {
    pub(crate) work: std::sync::Arc<crate::work::Work>,
    pub(crate) gateway: Gateway,
    pub(crate) canceled: AtomicBool,
    pub(crate) files: std::sync::Arc<crate::file_tools::FileTools>,
    pub(crate) file_context: crate::file_tools::FileContext,
}

impl Execution for NativeExecution {
    fn tool_concurrency(&self) -> usize {
        8
    }
    fn now_ms(&self) -> i64 {
        now_ms()
    }
    fn canceled(&self) -> bool {
        self.canceled.load(Ordering::Relaxed)
    }
    fn emit(&self, event: Value) {
        println!(
            "{}",
            json!({"jsonrpc":"2.0","method":"agent.event","params":event})
        );
    }
    async fn complete(&self, context: &AgentContext) -> Result<Value> {
        let message = self.gateway.complete(context).await?;
        self.emit(json!({"type":"message_start","message":message}));
        Ok(message)
    }
    async fn execute(&self, call: &ToolCall) -> Result<ToolResult> {
        match call.name.as_str() {
            "Read" | "apply_patch" => {
                let files = self.files.clone();
                let context = self.file_context.clone();
                let args = call.arguments.clone();
                let patch = call.name == "apply_patch";
                let work = self.work.enter();
                tokio::task::spawn_blocking(move || {
                    let _work = work;
                    if patch {
                        files.patch(&args, &context)
                    } else {
                        files.read(&args, &context)
                    }
                })
                .await?
            }
            _ => bail!("Native tool is not available: {}", call.name),
        }
    }
}

/// Standalone native execution entry point. Auth is passed only through the
/// environment, never command arguments, JSON transcripts, or diagnostics.
pub async fn run(request: RunRequest, store: &mut Store) -> Result<()> {
    let definition = stella_runtime_core::builtin::agent(&request.agent_type)
        .context("Unknown built-in agent")?;
    let auth = std::env::var("STELLA_AUTH_TOKEN")
        .context("STELLA_AUTH_TOKEN is required for managed model execution")?;
    let origin = std::env::var("STELLA_MODEL_GATEWAY_URL")
        .context("STELLA_MODEL_GATEWAY_URL is required")?;
    let gateway = Gateway::connect(
        &origin,
        &auth,
        &request.agent_type,
        request.model.as_deref().unwrap_or("stella/default"),
        Gateway::ephemeral_signer()?,
    )
    .await?;
    let execution = NativeExecution {
        work: Default::default(),
        gateway,
        canceled: AtomicBool::new(false),
        files: std::sync::Arc::new(Default::default()),
        file_context: Default::default(),
    };
    let conversation = request
        .conversation_id
        .unwrap_or(store.default_conversation()?);
    let user=store.append_event(serde_json::from_value::<AppendEvent>(json!({"conversationId":conversation,"type":"user_message","payload":{"text":request.prompt}}))?)?;
    let messages=store.list_events(&conversation,2000,None)?.into_iter().filter(|event|event.id!=user.id && matches!(event.kind.as_str(),"user_message"|"assistant_message")).map(|event|json!({"role":if event.kind=="user_message"{"user"}else{"assistant"},"content":[{"type":"text","text":event.payload.as_ref().and_then(|p|p["text"].as_str()).unwrap_or("")}],"timestamp":event.timestamp})).collect();
    let tools = stella_runtime_core::tools::native_definitions(&definition.tools);
    let mut context = AgentContext {
        system_prompt: definition.system_prompt.into(),
        messages,
        tools,
    };
    let prompt = json!({"role":"user","content":request.prompt,"timestamp":user.timestamp});
    let work = stella_runtime_core::agent::run(&execution, &mut context, vec![prompt]);
    let output = tokio::select! {
        result=work=>result?,
        _=tokio::signal::ctrl_c()=>{execution.canceled.store(true,Ordering::Relaxed);execution.work.settle().await;bail!("Native run canceled");}
    };
    for message in &output {
        if message["role"] != "assistant" {
            continue;
        }
        let text = message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            store.append_event(serde_json::from_value(json!({"conversationId":conversation,"type":"assistant_message","payload":{"text":text}}))?)?;
        }
    }
    Ok(())
}
