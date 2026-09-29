//! Platform-independent execution loop. Platform implementations provide I/O;
//! message ownership, tool-call deduplication and turn boundaries live here.
use anyhow::{Result, bail};
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
        let assistant = execution.complete(context).await?;
        execution.emit(json!({"type":"message_end","message":assistant}));
        context.messages.push(assistant.clone());
        output.push(assistant.clone());
        if matches!(assistant["stopReason"].as_str(), Some("error" | "aborted")) {
            execution.emit(json!({"type":"turn_end","message":assistant,"toolResults":[]}));
            execution.emit(json!({"type":"agent_end","messages":output}));
            return Ok(output);
        }
        let calls = assistant["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["type"] == "toolCall")
            .map(|v| serde_json::from_value::<ToolCall>(v.clone()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut results = Vec::new();
        let mut by_execution_key: BTreeMap<String, ToolResult> = BTreeMap::new();
        for call in &calls {
            execution.emit(json!({"type":"tool_execution_start","toolCallId":call.id,"toolName":call.name,"args":call.arguments}));
            // serde_json's ordered maps give nested objects a stable key order.
            let key = serde_json::to_string(&json!([call.name, call.arguments]))?;
            let result = if let Some(original) = by_execution_key.get(&key) {
                original.clone()
            } else if execution.canceled() {
                ToolResult::error("Tool execution canceled")
            } else if !context.tools.iter().any(|tool| tool["name"] == call.name) {
                ToolResult::error(format!("Unknown tool: {}", call.name))
            } else {
                match execution.execute(call).await {
                    Ok(result) => result,
                    Err(error) => ToolResult::error(error.to_string()),
                }
            };
            by_execution_key
                .entry(key)
                .or_insert_with(|| result.clone());
            execution.emit(json!({"type":"tool_execution_end","toolCallId":call.id,"toolName":call.name,"result":result,"isError":result.is_error}));
            let message = json!({"role":"toolResult","toolCallId":call.id,"toolName":call.name,"content":result.content,"details":result.details,"isError":result.is_error,"timestamp":execution.now_ms()});
            execution.emit(json!({"type":"message_start","message":message}));
            execution.emit(json!({"type":"message_end","message":message}));
            results.push(message);
        }
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
