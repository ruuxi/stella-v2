//! Rebuild provider context without mutating the exact durable transcript.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn transform(
    messages: &[Value],
    provider: &str,
    api: &str,
    model: &str,
    images: bool,
    now: i64,
) -> Vec<Value> {
    let mut ids = BTreeMap::new();
    let normalized=messages.iter().cloned().map(|mut message|{
        let same=message["provider"]==provider&&message["api"]==api&&message["model"]==model;
        let role=message["role"].as_str().unwrap_or("").to_owned();
        if !images && matches!(role.as_str(),"user"|"runtimeInternal"|"toolResult") && let Some(content)=message["content"].as_array(){
            let described=content.iter().any(|block|block["text"].as_str().is_some_and(|text|text.contains("<image_description>")));
            let placeholder=if role=="toolResult"{"(tool image omitted)"}else{"(image omitted)"};let mut previous=false;let mut blocks=Vec::new();
            for block in content {
                if block["type"]=="image" {
                    if let Some(path)=block["sourcePath"].as_str().map(str::trim).filter(|s|!s.is_empty()){blocks.push(json!({"type":"text","text":format!("<image_reference>\n{path}\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>")}));previous=false;}
                    else if !described&&!previous{blocks.push(json!({"type":"text","text":placeholder}));previous=true;}
                }else{previous=block["text"]==placeholder;blocks.push(block.clone());}
            }
            message["content"]=json!(blocks);
        }
        if role=="assistant" && let Some(content)=message["content"].as_array(){
            message["content"]=json!(content.iter().filter_map(|block|{
                match block["type"].as_str(){
                    Some("thinking")=>if same && (block["redacted"]==true||block["thinkingSignature"].as_str().is_some_and(|s|!s.is_empty())||block["thinking"].as_str().is_some_and(|s|!s.trim().is_empty())){Some(block.clone())}else{None},
                    Some("text") if !same=>Some(json!({"type":"text","text":block["text"]})),
                    Some("toolCall") if !same=>{
                        let mut call=block.clone();call.as_object_mut().unwrap().remove("thoughtSignature");
                        if api=="anthropic-messages" || api=="google-generative-ai" && (model.starts_with("claude-")||model.starts_with("gpt-oss-")){
                            if let Some(old)=call["id"].as_str(){let id=old.chars().map(|c|if c.is_ascii_alphanumeric()||c=='_'||c=='-'{c}else{'_'}).take(64).collect::<String>();ids.insert(old.to_owned(),id.clone());call["id"]=json!(id);}
                        }Some(call)
                    },
                    _=>Some(block.clone()),
                }
            }).collect::<Vec<_>>());
        }
        if role=="toolResult" && let Some(id)=message["toolCallId"].as_str().and_then(|id|ids.get(id)){message["toolCallId"]=json!(id);}
        message
    }).collect::<Vec<_>>();
    let mut results = BTreeMap::new();
    for message in &normalized {
        if message["role"] == "toolResult"
            && let Some(id) = message["toolCallId"].as_str()
        {
            results.entry(id.to_owned()).or_insert(message);
        }
    }
    let mut emitted = BTreeSet::new();
    let mut output = Vec::new();
    for message in &normalized {
        if message["role"] == "toolResult" {
            continue;
        }
        if message["role"] == "assistant"
            && matches!(message["stopReason"].as_str(), Some("error" | "aborted"))
        {
            continue;
        }
        output.push(message.clone());
        if message["role"] != "assistant" {
            continue;
        }
        for call in message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "toolCall")
        {
            let Some(id) = call["id"].as_str() else {
                continue;
            };
            if !emitted.insert(id) {
                continue;
            }
            output.push(results.get(id).map(|m|(*m).clone()).unwrap_or_else(||json!({"role":"toolResult","toolCallId":id,"toolName":call["name"],"content":[{"type":"text","text":"No result provided"}],"isError":true,"timestamp":now})));
        }
    }
    output
}
