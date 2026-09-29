use crate::{
    gateway::Gateway,
    storage::{Store, chat::AppendEvent, now_ms},
};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use stella_runtime_core::agent::{AgentContext, Execution, ToolCall, ToolResult};
use tokio::io::AsyncReadExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub prompt: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub conversation_id: Option<String>,
}

pub struct NativeExecution {
    gateway: Gateway,
    canceled: AtomicBool,
}

impl Execution for NativeExecution {
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
            "Read" => {
                let value = call.arguments["file_path"]
                    .as_str()
                    .context("file_path is required")?;
                let path = if let Some(relative) = value
                    .strip_prefix("~/")
                    .or_else(|| value.strip_prefix("$HOME/"))
                {
                    PathBuf::from(
                        std::env::var_os("HOME").context("Home directory is unavailable")?,
                    )
                    .join(relative)
                } else {
                    PathBuf::from(value)
                };
                if !path.is_absolute() {
                    bail!("Read requires an absolute path");
                }
                let file = tokio::fs::File::open(&path).await?;
                if !file.metadata().await?.is_file() {
                    bail!("Read expects a regular file");
                }
                let mut bytes = Vec::new();
                file.take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > 8 * 1024 * 1024 {
                    bail!("File exceeds the native reader's 8 MiB bound");
                }
                let data = String::from_utf8(bytes)
                    .context("This native reader currently accepts UTF-8 text files")?;
                let offset = call.arguments["offset"].as_u64().unwrap_or(1).max(1) as usize;
                let limit = call.arguments["limit"]
                    .as_u64()
                    .unwrap_or(2000)
                    .clamp(1, 2000) as usize;
                let text = data
                    .lines()
                    .enumerate()
                    .skip(offset - 1)
                    .take(limit)
                    .map(|(i, line)| format!("{}\t{}", i + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(ToolResult {
                    content: vec![json!({"type":"text","text":text})],
                    details: json!({"filePath":path}),
                    is_error: false,
                })
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
        gateway,
        canceled: AtomicBool::new(false),
    };
    let conversation = request
        .conversation_id
        .unwrap_or(store.default_conversation()?);
    let user=store.append_event(serde_json::from_value::<AppendEvent>(json!({"conversationId":conversation,"type":"user_message","payload":{"text":request.prompt}}))?)?;
    let messages=store.list_events(&conversation,2000,None)?.into_iter().filter(|event|event.id!=user.id && matches!(event.kind.as_str(),"user_message"|"assistant_message")).map(|event|json!({"role":if event.kind=="user_message"{"user"}else{"assistant"},"content":[{"type":"text","text":event.payload.as_ref().and_then(|p|p["text"].as_str()).unwrap_or("")}],"timestamp":event.timestamp})).collect();
    let tools = if definition.tools.contains(&"Read") {
        vec![
            json!({"name":"Read","description":"Read a UTF-8 text file by absolute path.","parameters":{"type":"object","properties":{"file_path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":2000}},"required":["file_path"]}}),
        ]
    } else {
        vec![]
    };
    let mut context = AgentContext {
        system_prompt: definition.system_prompt.into(),
        messages,
        tools,
    };
    let prompt = json!({"role":"user","content":request.prompt,"timestamp":user.timestamp});
    let work = stella_runtime_core::agent::run(&execution, &mut context, vec![prompt]);
    let output = tokio::select! {
        result=work=>result?,
        _=tokio::signal::ctrl_c()=>{execution.canceled.store(true,Ordering::Relaxed);bail!("Native run canceled");}
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
