//! Platform-independent execution loop. Platform implementations provide I/O;
//! message ownership, tool-call deduplication and turn boundaries live here.
use anyhow::{Result, bail};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub system_prompt: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: Vec<Value>,
    #[serde(default)]
    pub details: Value,
    #[serde(default)]
    pub is_error: bool,
}

impl ToolResult {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type":"text","text":message.into()})],
            details: json!({}),
            is_error: true,
        }
    }
}

#[allow(async_fn_in_trait)]
pub trait Execution {
    fn emit(&self, event: Value);
    fn now_ms(&self) -> i64;
    fn canceled(&self) -> bool;
    /// The platform selects a bounded concurrency policy; one retains serial
    /// tool ordering for execution environments that require it.
    fn tool_concurrency(&self) -> usize {
        1
    }
    fn degenerate_response_retries(&self) -> usize {
        1
    }
    /// Emit message_start and incremental message_update events while producing
    /// a final native AssistantMessage. The loop owns message_end.
    async fn complete(&self, context: &AgentContext) -> Result<Value>;
    /// Each implementation must enforce its tool schema and cancellation. A
    /// failed tool is data; a failed durable checkpoint is an execution error.
    async fn execute(&self, call: &ToolCall) -> Result<ToolResult>;
    async fn steering(&self) -> Result<Vec<Value>> {
        Ok(vec![])
    }
    async fn follow_up(&self) -> Result<Vec<Value>> {
        Ok(vec![])
    }
    async fn turn_boundary(
        &self,
        _context: &AgentContext,
        _completed: &[Value],
        _pending: &[Value],
    ) -> Result<Option<Vec<Value>>> {
        Ok(None)
    }
}

fn push(
    execution: &impl Execution,
    context: &mut AgentContext,
    output: &mut Vec<Value>,
    message: Value,
) {
    execution.emit(json!({"type":"message_start","message":message}));
    execution.emit(json!({"type":"message_end","message":message}));
    context.messages.push(message.clone());
    output.push(message);
}

/// Runs to a natural stop, preserving the existing event ordering. No extension
/// hooks are evaluated: built-in prompt preparation happens before admission.
pub async fn run(
    execution: &impl Execution,
    context: &mut AgentContext,
    prompts: Vec<Value>,
) -> Result<Vec<Value>> {
    if prompts.is_empty()
        && (context.messages.is_empty()
            || context
                .messages
                .last()
                .is_some_and(|m| m["role"] == "assistant"))
    {
        bail!("Continuation requires a nonempty context ending in a user or tool result");
    }
    let mut output = Vec::new();
    execution.emit(json!({"type":"agent_start"}));
    execution.emit(json!({"type":"turn_start"}));
    for message in prompts {
        push(execution, context, &mut output, message);
    }
    let mut pending = execution.steering().await?;
    loop {
        for message in pending.drain(..) {
            push(execution, context, &mut output, message);
        }
        if execution.canceled() {
            execution.emit(json!({"type":"agent_end","messages":output}));
            return Ok(output);
        }
        let mut assistant = execution.complete(context).await?;
        for _ in 0..execution.degenerate_response_retries().min(3) {
            let usable = assistant["content"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|b| {
                    b["type"] == "toolCall"
                        || b["type"] == "text"
                            && b["text"].as_str().is_some_and(|t| !t.trim().is_empty())
                })
            });
            if usable
                || !matches!(assistant["stopReason"].as_str(), Some("stop" | "length"))
                || execution.canceled()
            {
                break;
            }
            let mut failed = assistant.clone();
            failed["stopReason"] = json!("error");
            failed["errorMessage"] =
                json!("Provider returned no usable assistant output; retrying.");
            execution.emit(json!({"type":"message_end","message":failed}));
            assistant = execution.complete(context).await?;
        }
        execution.emit(json!({"type":"message_end","message":assistant}));
        context.messages.push(assistant.clone());
        output.push(assistant.clone());
        if matches!(assistant["stopReason"].as_str(), Some("error" | "aborted")) {
            execution.emit(json!({"type":"turn_end","message":assistant,"toolResults":[]}));
            execution.emit(json!({"type":"agent_end","messages":output}));
            bail!(
                "{}",
                assistant["errorMessage"]
                    .as_str()
                    .unwrap_or("Provider did not complete the response")
            );
        }
        let calls = assistant["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["type"] == "toolCall")
            .map(|v| serde_json::from_value::<ToolCall>(v.clone()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        // Deduplicate BEFORE launching futures: duplicate calls never race
        // through a shared cache and execute the same mutation twice.
        let mut keys = BTreeMap::<String, usize>::new();
        let mut groups = Vec::<Vec<usize>>::new();
        for (index, call) in calls.iter().enumerate() {
            let key = serde_json::to_string(&json!([call.name, call.arguments]))?;
            let group = *keys.entry(key).or_insert_with(|| {
                groups.push(vec![]);
                groups.len() - 1
            });
            groups[group].push(index);
        }
        let pending_tools=futures::stream::iter(groups.into_iter().map(|indices| {
            let calls=&calls;
            let definitions=&context.tools;
            async move {
                let call=&calls[indices[0]];
                for index in &indices {let item=&calls[*index];execution.emit(json!({"type":"tool_execution_start","toolCallId":item.id,"toolName":item.name,"args":item.arguments}));}
                let result=if execution.canceled(){ToolResult::error("Tool execution canceled")}
                else if !definitions.iter().any(|tool|tool["name"]==call.name){ToolResult::error(format!("Unknown tool: {}",call.name))}
                else {
                    match execution.execute(call).await {
                        Ok(result)=>result,
                        Err(error)=>ToolResult::error(format!("{error:#}")),
                    }
                };
                let messages=indices.into_iter().map(|index|{
                    let call=&calls[index];
                    execution.emit(json!({"type":"tool_execution_end","toolCallId":call.id,"toolName":call.name,"result":result,"isError":result.is_error}));
                    let message=json!({"role":"toolResult","toolCallId":call.id,"toolName":call.name,"content":result.content,"details":result.details,"isError":result.is_error,"timestamp":execution.now_ms()});
                    (index,message)
                }).collect::<Vec<_>>();
                messages
            }
        })).buffer_unordered(execution.tool_concurrency().clamp(1,32));
        let mut ordered = pending_tools
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        ordered.sort_by_key(|(index, _)| *index);
        let results = ordered
            .into_iter()
            .map(|(_, message)| {
                // Durable context and tool-result messages retain provider call
                // order even when completion notifications arrive out of order.
                execution.emit(json!({"type":"message_start","message":message}));
                execution.emit(json!({"type":"message_end","message":message}));
                message
            })
            .collect::<Vec<_>>();
        let mut completed = vec![assistant.clone()];
        for result in &results {
            context.messages.push(result.clone());
            output.push(result.clone());
            completed.push(result.clone());
        }
        execution.emit(json!({"type":"turn_end","message":assistant,"toolResults":results}));
        pending = execution.steering().await?;
        if calls.is_empty() && pending.is_empty() {
            pending = execution.follow_up().await?;
        }
        if execution.canceled() || (calls.is_empty() && pending.is_empty()) {
            break;
        }
        if let Some(replacement) = execution
            .turn_boundary(context, &completed, &pending)
            .await?
        {
            context.messages = replacement;
            output.clear();
        }
        execution.emit(json!({"type":"turn_start"}));
    }
    execution.emit(json!({"type":"agent_end","messages":output}));
    Ok(output)
}
