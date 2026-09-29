//! Anthropic Messages wire format; signed and redacted reasoning stays opaque.
use crate::agent::AgentContext;
use anyhow::{Context, Result, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use serde_json::{Value, json};

pub fn blocks(message: &Value) -> Vec<Value> {
    message["content"].as_array().cloned().unwrap_or_else(|| {
        message["content"]
            .as_str()
            .map(|t| vec![json!({"type":"text","text":t})])
            .unwrap_or_default()
    })
}

fn image(block: &Value) -> Option<Value> {
    let original = block["data"].as_str()?.trim();
    let original = if original
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("data:"))
    {
        original.split_once(',')?.1
    } else {
        original
    };
    if original.len() > 10 * 1024 * 1024 {
        return None;
    }
    let clean = original
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect::<String>();
    let bytes = STANDARD
        .decode(&clean)
        .or_else(|_| STANDARD_NO_PAD.decode(&clean))
        .ok()?;
    let tail = |marker: &[u8], window: usize| {
        bytes[bytes.len().saturating_sub(window)..]
            .windows(marker.len())
            .any(|w| w == marker)
    };
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && tail(b"IEND\xae\x42\x60\x82", 256) {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") && tail(b"\xff\xd9", 256) {
        "image/jpeg"
    } else if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && tail(b";", 8) {
        "image/gif"
    } else if bytes.len() >= 12
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && (u32::from_le_bytes(bytes[4..8].try_into().ok()?) as u64) + 8 <= bytes.len() as u64
    {
        "image/webp"
    } else {
        return None;
    };
    Some(
        json!({"type":"image","source":{"type":"base64","media_type":mime,"data":STANDARD.encode(bytes)}}),
    )
}
fn user_content(message: &Value) -> Vec<Value> {
    blocks(message).iter().filter_map(|block|match block["type"].as_str(){
        Some("text") if block["text"].as_str().is_some_and(|s|!s.trim().is_empty())=>Some(json!({"type":"text","text":block["text"]})),
        Some("image")=>Some(image(block).unwrap_or_else(||json!({"type":"text","text":"[Image omitted: it could not be decoded as a valid image and was skipped.]"}))),
        _=>None,
    }).collect()
}

pub fn request(context: &AgentContext, model: &str, max_tokens: u64) -> Result<Value> {
    let latest = context
        .messages
        .iter()
        .rposition(|m| m["role"] == "assistant");
    let mut messages = Vec::<Value>::new();
    for (index, message) in context.messages.iter().enumerate() {
        match message["role"].as_str() {
            Some("user" | "runtimeInternal") => {
                let content = user_content(message);
                if !content.is_empty() {
                    messages.push(json!({"role":"user","content":content}));
                }
            }
            Some("assistant") => {
                let blocks = blocks(message);
                let last_real = blocks.iter().rposition(|b| b["type"] != "thinking");
                let mut content = Vec::new();
                for (i, block) in blocks.iter().enumerate() {
                    match block["type"].as_str(){
                        Some("text") if block["text"].as_str().is_some_and(|s|!s.trim().is_empty())=>content.push(json!({"type":"text","text":block["text"]})),
                        Some("toolCall")=>content.push(json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":block["arguments"]})),
                        Some("thinking")=>{
                            if latest==Some(index) && last_real.is_none_or(|last|i>last){continue;}
                            let signature=block["thinkingSignature"].as_str().filter(|s|!s.trim().is_empty());
                            if let Some(signature)=signature {
                                if block["redacted"]==true {content.push(json!({"type":"redacted_thinking","data":signature}));}
                                else if block["thinking"].as_str().is_some_and(|s|!s.trim().is_empty()){content.push(json!({"type":"thinking","thinking":block["thinking"],"signature":signature}));}
                            }
                            // Unsigned reasoning is never promoted to visible user text.
                        }
                        _=>{},
                    }
                }
                if !content.is_empty() {
                    messages.push(json!({"role":"assistant","content":content}));
                }
            }
            Some("toolResult") => {
                let result = json!({"type":"tool_result","tool_use_id":message["toolCallId"],"content":user_content(message),"is_error":message["isError"].as_bool().unwrap_or(false)});
                if index > 0 && context.messages[index - 1]["role"] == "toolResult" {
                    messages.last_mut().context("Missing tool result group")?["content"]
                        .as_array_mut()
                        .context("Invalid tool result group")?
                        .push(result);
                } else {
                    messages.push(json!({"role":"user","content":[result]}));
                }
            }
            role => bail!("Unsupported Anthropic message role: {role:?}"),
        }
    }
    // One breakpoint for system, tools and latest user turn, within Anthropic's
    // four-breakpoint limit. Thinking blocks cannot carry cache directives.
    if let Some(last) = messages.last_mut()
        && last["role"] == "user"
        && let Some(block) = last["content"].as_array_mut().and_then(|a| a.last_mut())
    {
        block["cache_control"] = json!({"type":"ephemeral"});
    }
    let mut body =
        json!({"model":model,"max_tokens":max_tokens,"messages":messages,"stream":false});
    if !context.system_prompt.is_empty() {
        body["system"] = json!([{"type":"text","text":context.system_prompt,"cache_control":{"type":"ephemeral"}}]);
    }
    if !context.tools.is_empty() {
        let mut tools=context.tools.iter().map(|t|json!({"name":t["name"],"description":t["description"],"input_schema":t["parameters"]})).collect::<Vec<_>>();
        tools.last_mut().unwrap()["cache_control"] = json!({"type":"ephemeral"});
        body["tools"] = json!(tools);
    }
    Ok(body)
}

pub fn response(body: Value, model: &str, provider: &str, timestamp: i64) -> Result<Value> {
    if body["type"] == "error" || body.get("error").is_some_and(|v| !v.is_null()) {
        bail!(
            "Anthropic provider error: {}",
            body["error"]["message"]
                .as_str()
                .unwrap_or("request failed")
        );
    }
    let mut content = Vec::new();
    for block in body["content"]
        .as_array()
        .context("Anthropic response has no content")?
    {
        match block["type"].as_str(){
            Some("text")=>content.push(json!({"type":"text","text":block["text"]})),
            Some("thinking")=>content.push(json!({"type":"thinking","thinking":block["thinking"],"thinkingSignature":block["signature"]})),
            Some("redacted_thinking")=>content.push(json!({"type":"thinking","thinking":"","redacted":true,"thinkingSignature":block["data"]})),
            Some("tool_use")=>content.push(json!({"type":"toolCall","id":block["id"],"name":block["name"],"arguments":block["input"]})),
            _=>{},
        }
    }
    let usage = &body["usage"];
    let input = usage["input_tokens"].as_u64().unwrap_or(0);
    let output = usage["output_tokens"].as_u64().unwrap_or(0);
    let read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    let stop = match body["stop_reason"].as_str() {
        Some("end_turn" | "stop_sequence") => "stop",
        Some("tool_use") => "toolUse",
        Some("max_tokens") => "length",
        _ => "error",
    };
    let mut message = json!({"role":"assistant","content":content,"api":"anthropic-messages","provider":provider,"model":model,"responseModel":body["model"],"responseId":body["id"],"timestamp":timestamp,"stopReason":stop,
        "usage":{"input":input,"output":output,"cacheRead":read,"cacheWrite":write,"totalTokens":input+output+read+write,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}});
    if stop == "error" {
        message["errorMessage"] = json!(format!(
            "Anthropic stopped with {}",
            body["stop_reason"]
                .as_str()
                .unwrap_or("missing stop reason")
        ));
    }
    Ok(message)
}
