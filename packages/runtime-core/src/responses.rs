//! Provider boundary for the Responses protocol. Reasoning items and tool-call
//! identities survive round trips instead of being flattened into user text.
use crate::agent::AgentContext;
use anyhow::{Result, bail};
use serde_json::{Value, json};

fn blocks(message: &Value) -> Vec<Value> {
    if let Some(text) = message["content"].as_str() {
        return vec![json!({"type":"text","text":text})];
    }
    message["content"].as_array().cloned().unwrap_or_default()
}

pub fn request(context: &AgentContext, model: &str, max_tokens: u64) -> Result<Value> {
    let mut input = Vec::new();
    for message in &context.messages {
        match message["role"].as_str() {
            Some("user" | "runtimeInternal") => {
                let content=blocks(message).into_iter().filter_map(|b|match b["type"].as_str() {
                    Some("text")=>Some(json!({"type":"input_text","text":b["text"]})),
                    Some("image")=>Some(json!({"type":"input_image","image_url":format!("data:{};base64,{}",b["mimeType"].as_str().unwrap_or("image/png"),b["data"].as_str().unwrap_or("")),"detail":"auto"})),
                    _=>None,
                }).collect::<Vec<_>>();
                input.push(json!({"role":"user","content":content}));
            }
            Some("assistant") => {
                for b in blocks(message) {
                    match b["type"].as_str() {
                        Some("text")=>input.push(json!({"role":"assistant","content":[{"type":"output_text","text":b["text"]}]})),
                        Some("toolCall")=>input.push(json!({"type":"function_call","call_id":b["id"].as_str().unwrap_or("").split('|').next().unwrap_or(""),"name":b["name"],"arguments":b["arguments"].to_string()})),
                        Some("thinking")=>{
                            if let Some(signature)=b["thinkingSignature"].as_str() {
                                let item:Value=serde_json::from_str(signature)?;
                                if item["type"]=="reasoning" {input.push(item);}
                            }
                        }
                        _=>{},
                    }
                }
            }
            Some("toolResult") => {
                let output = blocks(message)
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let images=blocks(message).into_iter().filter(|b|b["type"]=="image").map(|b|json!({"type":"input_image","detail":"auto","image_url":format!("data:{};base64,{}",b["mimeType"].as_str().unwrap_or("image/png"),b["data"].as_str().unwrap_or(""))})).collect::<Vec<_>>();
                input.push(json!({"type":"function_call_output","call_id":message["toolCallId"].as_str().unwrap_or("").split('|').next().unwrap_or(""),"output":if output.is_empty() && !images.is_empty(){"(see attached image)"}else{&output}}));
                if !images.is_empty(){
                    let mut content=vec![json!({"type":"input_text","text":"Attached image(s) from the previous tool result:"})];content.extend(images);
                    input.push(json!({"role":"user","content":content}));
                }
            }
            role => bail!("Unsupported Responses message role: {role:?}"),
        }
    }
    let mut body = json!({"model":model,"instructions":context.system_prompt,"input":input,"max_output_tokens":max_tokens,"stream":false,"store":false});
    if !context.tools.is_empty() {
        body["tools"]=json!(context.tools.iter().map(|t|json!({"type":"function","name":t["name"],"description":t["description"],"parameters":t["parameters"]})).collect::<Vec<_>>());
    }
    Ok(body)
}

pub fn response(body: Value, model: &str, provider: &str, timestamp: i64) -> Result<Value> {
    if body.get("error").is_some_and(|e| !e.is_null()) {
        bail!(
            "Provider error: {}",
            body["error"]["message"]
                .as_str()
                .unwrap_or("Responses request failed")
        );
    }
    let mut content = Vec::new();
    for item in body["output"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("message") => {
                for block in item["content"].as_array().into_iter().flatten() {
                    if block["type"] == "output_text" {
                        content.push(json!({"type":"text","text":block["text"]}));
                    } else if block["type"] == "refusal" {
                        content.push(json!({"type":"text","text":block["refusal"]}));
                    }
                }
            }
            Some("function_call") => {
                let arguments: Value =
                    serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))?;
                content.push(json!({"type":"toolCall","id":item["call_id"],"name":item["name"],"arguments":arguments}));
            }
            Some("reasoning") => {
                let thinking = item["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                content.push(json!({"type":"thinking","thinking":thinking,"thinkingSignature":item.to_string()}));
            }
            _ => {}
        }
    }
    let usage = &body["usage"];
    let input = usage["input_tokens"].as_u64().unwrap_or(0);
    let output = usage["output_tokens"].as_u64().unwrap_or(0);
    let cache = usage["input_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    let tools = content.iter().any(|b| b["type"] == "toolCall");
    let stop = match body["status"].as_str() {
        Some("incomplete") => "length",
        Some("failed" | "cancelled") => "error",
        _ if tools => "toolUse",
        _ => "stop",
    };
    Ok(
        json!({"role":"assistant","content":content,"api":"openai-responses","provider":provider,"model":model,"responseModel":body["model"],"responseId":body["id"],"timestamp":timestamp,"stopReason":stop,"usage":{"input":input.saturating_sub(cache),"output":output,"cacheRead":cache,"cacheWrite":0,"totalTokens":input+output,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}),
    )
}
