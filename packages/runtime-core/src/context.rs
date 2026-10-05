//! Shared context accounting and checkpoint projection. Exact transcripts are
//! never rewritten when a checkpoint changes the model's working window.
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Default, Debug)]
pub struct Pressure {
    pub tokens: usize,
    pub images: usize,
    pub image_bytes: usize,
}
fn binary_bytes(value: &Value) -> usize {
    if let Some(bytes) = value.as_array() {
        return bytes.len();
    }
    let Some(text) = value.as_str() else {
        return 0;
    };
    let text = if text.starts_with("data:") {
        text.split_once(',').map(|(_, s)| s).unwrap_or(text)
    } else {
        text
    };
    let encoded = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    (encoded.len() * 3 / 4).saturating_sub(encoded.chars().rev().take_while(|c| *c == '=').count())
}
fn image_tokens(value: &Value) -> usize {
    let dimension = |a, b| {
        value[a]
            .as_f64()
            .or_else(|| value[b].as_f64())
            .filter(|n| *n > 0.0)
            .map(f64::floor)
    };
    let (Some(w), Some(h)) = (
        dimension("width", "widthPx"),
        dimension("height", "heightPx"),
    ) else {
        return 1200;
    };
    let scale = (2048.0 / w.max(h)).min(1.0);
    85 + 170
        * ((w * scale).ceil() / 512.0).ceil() as usize
        * ((h * scale).ceil() / 512.0).ceil() as usize
}
pub fn pressure(value: &Value) -> Pressure {
    fn visit(value: &Value, key: &str, parent: &Value, stats: &mut Pressure) -> Value {
        let lower = key.to_ascii_lowercase();
        let inline = value.get("inlineData").or_else(|| value.get("inline_data"));
        let image = if matches!(
            value["type"].as_str(),
            Some("image" | "input_image" | "image_url")
        ) {
            Some((
                value,
                value
                    .get("data")
                    .or_else(|| value.get("image_url"))
                    .or_else(|| value.get("url"))
                    .unwrap_or(&Value::Null),
            ))
        } else if let Some(inline) = inline.filter(|v| v.get("data").is_some()) {
            Some((inline, &inline["data"]))
        } else if !value["image"]["source"]["bytes"].is_null() {
            Some((&value["image"], &value["image"]["source"]["bytes"]))
        } else if lower.contains("image_url")
            || value.as_str().is_some_and(|s| s.starts_with("data:image/"))
            || matches!(parent["type"].as_str(), Some("image" | "input_image"))
                && matches!(key, "data" | "url")
        {
            Some((parent, value))
        } else {
            None
        };
        if let Some((metadata, data)) = image {
            stats.images += 1;
            stats.image_bytes += binary_bytes(data);
            stats.tokens += image_tokens(metadata);
            return json!("[model-visible image]");
        }
        match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, v)| visit(v, &i.to_string(), value, stats))
                    .collect(),
            ),
            Value::Object(items) => Value::Object(
                items
                    .iter()
                    .map(|(k, v)| (k.clone(), visit(v, k, value, stats)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    let mut stats = Pressure::default();
    let visible = visit(value, "", &Value::Null, &mut stats);
    stats.tokens += visible.to_string().len().div_ceil(3);
    stats
}
pub fn text(content: &Value) -> String {
    content.as_str().map(str::to_owned).unwrap_or_else(|| {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    })
}
fn retired(content: &Value) -> bool {
    let text = text(content);
    [
        "~/.stella/memories/MEMORY.md",
        "~/.stella/memories/memory_map.md",
        "~/.stella/memories/memory_summary.md",
        "~/.stella/memories/memory_index.md",
        "~/.stella/memories/memory_shadow.md",
        "~/.stella/memories/raw_memories.md",
    ]
    .iter()
    .any(|p| text.contains(p))
}
fn identity(kind: &str, content: &Value) -> Option<String> {
    match kind {
        "bootstrap.skills_catalog" => Some("skills".into()),
        "bootstrap.startup_doc" => text(content)
            .trim()
            .strip_prefix("<startup_doc path=\"")
            .and_then(|s| s.split_once('\"'))
            .map(|(path, _)| format!("doc:{path}")),
        _ => None,
    }
}
fn receipts(details: &Value) -> Vec<Value> {
    details["imageReceipts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            let id = r["id"].as_str().unwrap_or("").trim();
            id.strip_prefix("sha256:").is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f'))
            }) && r["mimeType"]
                .as_str()
                .is_some_and(|s| s.trim().starts_with("image/"))
                && r["decodedBytes"].as_f64().is_some_and(|n| n >= 0.0)
                && r["origin"]["timestamp"].is_number()
                && r["origin"]["role"].is_string()
                && matches!(
                    r["artifact"]["durability"].as_str(),
                    Some("durable" | "non-durable")
                )
        })
        .cloned()
        .collect()
}
/// Entries use {seq,id,type,createdAt,data}; the checkpoint uses the existing
/// thread_context field names. Synthetic rows never consume durable sequences.
pub fn project(entries: &[Value], checkpoint: Option<&Value>) -> Vec<Value> {
    let mut messages = Vec::new();
    let docs: Vec<Value> = checkpoint
        .into_iter()
        .flat_map(|c| {
            c["details"]["residentFold"]["docs"]
                .as_array()
                .into_iter()
                .flatten()
                .take(16)
        })
        .filter(|doc| {
            doc["customType"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && doc["text"].as_str().is_some_and(|s| !s.trim().is_empty())
                && !retired(&doc["text"])
        })
        .cloned()
        .map(|mut doc| {
            if let Some(id) = identity(doc["customType"].as_str().unwrap_or(""), &doc["text"]) {
                let source = doc["text"].as_str().unwrap_or("");
                if matches!(
                    id.as_str(),
                    "doc:~/.stella/core-memory.md"
                        | "doc:~/.stella/memories/profile.md"
                        | "doc:~/.stella/memories/index.md"
                ) {
                    doc["text"] = json!(crate::redaction::memory(source));
                }
            }
            doc
        })
        .collect();
    let identities: BTreeSet<String> = docs
        .iter()
        .filter_map(|d| identity(d["customType"].as_str().unwrap_or(""), &d["text"]))
        .collect();
    let checkpoint_time = checkpoint
        .and_then(|c| c["timestamp"].as_i64())
        .unwrap_or(0);
    let fold = !docs.is_empty()
        || checkpoint.is_some_and(|c| c["details"]["replaceDerivedContext"] == true);
    let mut inserted = false;
    let insert = |out: &mut Vec<Value>| {
        let Some(c) = checkpoint else {
            return;
        };
        for doc in &docs {
            out.push(json!({"role":"runtimeInternal","customType":doc["customType"],"content":[{"type":"text","text":doc["text"]}],"timestamp":checkpoint_time}));
        }
        let receipts = receipts(&c["details"]);
        let mut summary = format!(
            "[[THREAD_CHECKPOINT]]\n\n{}",
            c["summary"].as_str().unwrap_or("").trim()
        );
        if !receipts.is_empty() {
            summary.push_str(&format!(
                "\n\n<image-receipts version=\"1\">\n{}\n</image-receipts>",
                json!(receipts)
            ));
        }
        out.push(json!({"role":"assistant","content":[{"type":"text","text":summary}],"timestamp":checkpoint_time,"model":"history","provider":"history","api":"history","stopReason":"stop"}));
        if let Some(text) = c["details"]["pinnedUserInstruction"]["text"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.push(json!({"role":"user","content":text,"timestamp":checkpoint_time}));
        }
    };
    for entry in entries {
        let seq = entry["seq"].as_i64().unwrap_or(0);
        if let Some(c) = checkpoint {
            let from = c["coveredFromSeq"].as_i64().unwrap_or(0);
            let through = c["coveredThroughSeq"].as_i64().unwrap_or(0);
            if seq >= from && !inserted {
                insert(&mut messages);
                inserted = true;
            }
            if seq >= from && seq <= through {
                continue;
            }
        }
        let data = &entry["data"];
        if entry["type"] == "message" {
            if data["message"].is_object() {
                messages.push(data["message"].clone());
            }
        } else if entry["type"] == "custom_message" {
            let kind = data["customType"].as_str().unwrap_or("");
            if kind == "containment.quarantine" {
                continue;
            } // Containment metadata is never model-visible text.
            if fold
                && (retired(&data["content"])
                    || entry["createdAt"].as_i64().unwrap_or(0) <= checkpoint_time
                        && (kind == "runtime.orchestrator_reminder"
                            || kind.starts_with("runtime.context_delta.")
                            || identity(kind, &data["content"])
                                .is_some_and(|i| identities.contains(&i))))
            {
                continue;
            }
            messages.push(json!({"role":"runtimeInternal","customType":kind,"content":data["content"],"timestamp":entry["createdAt"]}));
        }
    }
    if !inserted {
        insert(&mut messages);
    }
    let keys: BTreeSet<String> = entries
        .iter()
        .filter(|e| e["data"]["customType"] == "containment.quarantine")
        .filter_map(|e| serde_json::from_str::<Value>(&text(&e["data"]["content"])).ok())
        .filter_map(|r| r["key"].as_str().map(str::to_owned))
        .collect();
    for message in &mut messages {
        if message["role"] == "toolResult"
            && keys.contains(&format!(
                "{}:{}",
                message["timestamp"].as_i64().unwrap_or(0),
                message["toolCallId"].as_str().unwrap_or("")
            ))
        {
            message["content"] = json!([{"type":"text","text":"[content quarantined: triggered provider abort]\nThis tool result has been withheld from model context. The original is preserved in the durable transcript."}]);
            message.as_object_mut().unwrap().remove("details");
        }
    }
    messages
}
