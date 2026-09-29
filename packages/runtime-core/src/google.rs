//! Google GenerateContent boundary. Thought signatures belong to individual
//! parts; tool result images retain their model-specific wire placement.
use crate::{agent::AgentContext, anthropic::blocks};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
fn inline(block: &Value) -> Value {
    json!({"inlineData":{"mimeType":block["mimeType"],"data":block["data"]}})
}
fn signed(mut part: Value, signature: &Value) -> Value {
    if let Some(s) = signature.as_str()
        && !s.is_empty()
        && STANDARD.decode(s).is_ok()
    {
        part["thoughtSignature"] = json!(s);
    }
    part
}
pub fn request(context: &AgentContext, upstream: &str, max_tokens: u64) -> Result<Value> {
    let native = upstream.strip_prefix("google/").unwrap_or(upstream);
    let needs_id = native.starts_with("claude-") || native.starts_with("gpt-oss-");
    let major = native
        .strip_prefix("gemini-")
        .and_then(|s| s.strip_prefix("live-").or(Some(s)))
        .and_then(|s| s.split(['-', '.']).next())
        .and_then(|s| s.parse::<u64>().ok());
    let multimodal = major.is_none_or(|n| n >= 3);
    let mut contents = Vec::<Value>::new();
    for message in &context.messages {
        match message["role"].as_str() {
            Some("user" | "runtimeInternal") => {
                let parts = blocks(message)
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("text") => Some(json!({"text":b["text"]})),
                        Some("image") => Some(inline(b)),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                if !parts.is_empty() {
                    contents.push(json!({"role":"user","parts":parts}));
                }
            }
            Some("assistant") => {
                let mut parts = Vec::new();
                for block in blocks(message) {
                    match block["type"].as_str() {
                        Some("text")
                            if block["text"].as_str().is_some_and(|s| !s.trim().is_empty()) =>
                        {
                            parts.push(signed(
                                json!({"text":block["text"]}),
                                &block["textSignature"],
                            ))
                        }
                        Some("thinking")
                            if block["thinking"]
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty()) =>
                        {
                            parts.push(signed(
                                json!({"thought":true,"text":block["thinking"]}),
                                &block["thinkingSignature"],
                            ))
                        }
                        Some("toolCall") => {
                            let mut part = signed(
                                json!({"functionCall":{"name":block["name"],"args":block["arguments"]}}),
                                &block["thoughtSignature"],
                            );
                            if needs_id {
                                part["functionCall"]["id"] = block["id"].clone();
                            }
                            if major.is_some_and(|n| n >= 3)
                                && part.get("thoughtSignature").is_none()
                            {
                                part["thoughtSignature"] =
                                    json!("skip_thought_signature_validator");
                            }
                            parts.push(part);
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    contents.push(json!({"role":"model","parts":parts}));
                }
            }
            Some("toolResult") => {
                let blocks = blocks(message);
                let images = blocks
                    .iter()
                    .filter(|b| b["type"] == "image")
                    .map(inline)
                    .collect::<Vec<_>>();
                let text = blocks
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = if text.is_empty() && !images.is_empty() {
                    "(see attached image)"
                } else {
                    &text
                };
                let mut result =
                    json!({"functionResponse":{"name":message["toolName"],"response":{}}});
                result["functionResponse"]["response"][if message["isError"] == true {
                    "error"
                } else {
                    "output"
                }] = json!(text);
                if needs_id {
                    result["functionResponse"]["id"] = message["toolCallId"].clone();
                }
                if multimodal && !images.is_empty() {
                    result["functionResponse"]["parts"] = json!(images);
                }
                if let Some(last) = contents.last_mut()
                    && last["role"] == "user"
                    && last["parts"]
                        .as_array()
                        .is_some_and(|p| p.iter().any(|p| p.get("functionResponse").is_some()))
                {
                    last["parts"].as_array_mut().unwrap().push(result);
                } else {
                    contents.push(json!({"role":"user","parts":[result]}));
                }
                if !multimodal && !images.is_empty() {
                    let mut parts = vec![json!({"text":"Tool result image:"})];
                    parts.extend(images);
                    contents.push(json!({"role":"user","parts":parts}));
                }
            }
            role => bail!("Unsupported Google message role: {role:?}"),
        }
    }
    let mut body = json!({"contents":contents,"generationConfig":{"maxOutputTokens":max_tokens}});
    if !context.system_prompt.is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":context.system_prompt}]});
    }
    if !context.tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":context.tools.iter().map(|t|json!({"name":t["name"],"description":t["description"],"parametersJsonSchema":t["parameters"]})).collect::<Vec<_>>()}]);
    }
    Ok(body)
}
pub fn response(body: Value, model: &str, provider: &str, timestamp: i64) -> Result<Value> {
    if body.get("error").is_some_and(|v| !v.is_null()) {
        bail!(
            "Google provider error: {}",
            body["error"]["message"]
                .as_str()
                .unwrap_or("request failed")
        );
    }
    let candidate = body["candidates"]
        .as_array()
        .and_then(|a| a.first())
        .context("Google response has no candidates")?;
    let mut content = Vec::new();
    for (index, part) in candidate["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(text) = part["text"].as_str() {
            let thinking = part["thought"] == true;
            let mut block = if thinking {
                json!({"type":"thinking","thinking":text})
            } else {
                json!({"type":"text","text":text})
            };
            if let Some(signature) = part.get("thoughtSignature") {
                block[if thinking {
                    "thinkingSignature"
                } else {
                    "textSignature"
                }] = signature.clone();
            }
            content.push(block);
        }
        if let Some(call) = part.get("functionCall") {
            let generated = format!("google_{timestamp}_{index}");
            let mut block = json!({"type":"toolCall","id":call["id"].as_str().filter(|s|!s.is_empty()).unwrap_or(&generated),"name":call["name"],"arguments":call.get("args").cloned().unwrap_or_else(||json!({}))});
            if let Some(signature) = part.get("thoughtSignature") {
                block["thoughtSignature"] = signature.clone();
            }
            content.push(block);
        }
    }
    let usage = &body["usageMetadata"];
    let input = usage["promptTokenCount"].as_u64().unwrap_or(0);
    let cached = usage["cachedContentTokenCount"].as_u64().unwrap_or(0);
    let reasoning = usage["thoughtsTokenCount"].as_u64().unwrap_or(0);
    let output = usage["candidatesTokenCount"].as_u64().unwrap_or(0) + reasoning;
    let stop = match candidate["finishReason"].as_str() {
        Some("STOP") if content.iter().any(|b| b["type"] == "toolCall") => "toolUse",
        Some("STOP") => "stop",
        Some("MAX_TOKENS") => "length",
        _ => "error",
    };
    let mut message = json!({"role":"assistant","content":content,"api":"google-generative-ai","provider":provider,"model":model,"responseModel":body["modelVersion"],"responseId":body["responseId"],"timestamp":timestamp,"stopReason":stop,
        "usage":{"input":input.saturating_sub(cached),"output":output,"reasoning":reasoning,"cacheRead":cached,"cacheWrite":0,"totalTokens":usage["totalTokenCount"].as_u64().unwrap_or(input+output),"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}});
    if stop == "error" {
        message["errorMessage"] = json!(format!(
            "Google stopped with {}",
            candidate["finishReason"]
                .as_str()
                .unwrap_or("missing finish reason")
        ));
    }
    Ok(message)
}
