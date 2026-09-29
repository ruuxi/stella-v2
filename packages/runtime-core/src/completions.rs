//! OpenAI-compatible JSON completion encoding used by Stella's managed
//! default route. It preserves native tool-result messages at the boundary.
use crate::agent::AgentContext;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

fn text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn parts(content: &Value) -> Value {
    if content.is_string() {
        return content.clone();
    }
    let blocks=content.as_array().into_iter().flatten().filter_map(|b|match b["type"].as_str() {
        Some("text")=>Some(json!({"type":"text","text":b["text"]})),
        Some("image")=>Some(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",b["mimeType"].as_str().unwrap_or("image/png"),b["data"].as_str().unwrap_or(""))}})),
        _=>None,
    }).collect::<Vec<_>>();
    if blocks.is_empty() {
        Value::Null
    } else {
        json!(blocks)
    }
}

pub fn request(context: &AgentContext, model: &str, max_tokens: u64) -> Result<Value> {
    let mut messages = Vec::new();
    if !context.system_prompt.is_empty() {
        messages.push(json!({"role":"system","content":context.system_prompt}));
    }
    let mut tool_images=Vec::new();
    for (index,message) in context.messages.iter().enumerate() {
        match message["role"].as_str() {
            Some("user"|"runtimeInternal")=>messages.push(json!({"role":"user","content":parts(&message["content"])})),
            Some("assistant")=>{
                let mut item=json!({"role":"assistant","content":text(&message["content"])});
                let calls=message["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="toolCall").map(|b|json!({"id":b["id"],"type":"function","function":{"name":b["name"],"arguments":b["arguments"].to_string()}})).collect::<Vec<_>>();
                if !calls.is_empty() { item["tool_calls"]=json!(calls); }
                let reasoning=message["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="thinking").filter_map(|b|b["thinking"].as_str()).collect::<Vec<_>>().join("");
                if !reasoning.is_empty() {item["reasoning_content"]=json!(reasoning);}
                messages.push(item);
            }
            Some("toolResult")=>{
                let text=text(&message["content"]);
                let images=message["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="image").cloned().collect::<Vec<_>>();
                messages.push(json!({"role":"tool","tool_call_id":message["toolCallId"],"content":if text.is_empty()&&!images.is_empty(){"(see attached image)"}else{&text}}));
                tool_images.extend(images);
                if context.messages.get(index+1).is_none_or(|m|m["role"]!="toolResult") && !tool_images.is_empty(){
                    let mut content=vec![json!({"type":"text","text":"Attached image(s) from tool result:"})];content.append(&mut tool_images);
                    messages.push(json!({"role":"user","content":parts(&json!(content))}));
                }
            },
            role=>bail!("Unsupported message role at completion boundary: {role:?}"),
        }
    }
    let mut body =
        json!({"model":model,"messages":messages,"stream":false,"max_tokens":max_tokens});
    if !context.tools.is_empty() {
        body["tools"]=json!(context.tools.iter().map(|t|json!({"type":"function","function":{"name":t["name"],"description":t["description"],"parameters":t["parameters"]}})).collect::<Vec<_>>());
    }
    Ok(body)
}

pub fn response(body: Value, model: &str, provider: &str, timestamp: i64) -> Result<Value> {
    if let Some(error) = body.get("error") {
        bail!(
            "Provider error: {}",
            error["message"].as_str().unwrap_or("completion failed")
        );
    }
    let choice = body["choices"]
        .as_array()
        .and_then(|c| c.first())
        .context("Completion response contains no choices")?;
    let message = &choice["message"];
    let mut content = Vec::new();
    let reasoning = message["reasoning_content"]
        .as_str()
        .or_else(|| message["reasoning"].as_str())
        .unwrap_or("");
    if !reasoning.is_empty() {
        content.push(json!({"type":"thinking","thinking":reasoning}));
    }
    let answer = message["content"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| text(&message["content"]));
    if !answer.is_empty() {
        content.push(json!({"type":"text","text":answer}));
    }
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            let arguments: Value =
                serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))?;
            content.push(json!({"type":"toolCall","id":call["id"],"name":call["function"]["name"],"arguments":arguments}));
        }
    }
    let usage = &body["usage"];
    let input = usage["prompt_tokens"].as_u64().unwrap_or(0);
    let output = usage["completion_tokens"].as_u64().unwrap_or(0);
    let cache = usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    let stop = match choice["finish_reason"].as_str() {
        Some("tool_calls" | "function_call") => "toolUse",
        Some("length") => "length",
        Some("content_filter") => "error",
        _ => "stop",
    };
    Ok(
        json!({"role":"assistant","content":content,"api":"openai-completions","provider":provider,"model":model,"responseModel":body["model"],"responseId":body["id"],"timestamp":timestamp,"stopReason":stop,"usage":{"input":input.saturating_sub(cache),"output":output,"cacheRead":cache,"cacheWrite":0,"totalTokens":input+output,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}),
    )
}
