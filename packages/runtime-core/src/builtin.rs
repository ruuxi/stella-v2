//! Stella behavior is compiled into the runtime. No dynamic extension loader,
//! JavaScript callbacks, runtime script evaluation, or user-overridable code.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub tools: Vec<&'static str>,
    pub max_agent_depth: u32,
    pub system_prompt: &'static str,
    pub records_thread_summary: bool,
}

fn definition(id: &'static str, source: &'static str) -> AgentDefinition {
    let (_, rest) = source.split_once("---\n").expect("bundled frontmatter");
    let (metadata, prompt) = rest.split_once("\n---\n").expect("bundled prompt");
    let field = |name: &str| {
        metadata
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap_or("")
            .trim()
    };
    AgentDefinition {
        id,
        name: field("name:"),
        tools: field("tools:")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect(),
        max_agent_depth: field("maxAgentDepth:").parse().expect("bundled depth"),
        system_prompt: prompt.trim_start_matches('\n'),
        records_thread_summary: id == "general",
    }
}

pub static AGENTS: LazyLock<Vec<AgentDefinition>> = LazyLock::new(|| {
    vec![
        definition(
            "orchestrator",
            include_str!("../assets/agents/orchestrator.md"),
        ),
        definition("general", include_str!("../assets/agents/general.md")),
        definition("explore", include_str!("../assets/agents/explore.md")),
        definition("fashion", include_str!("../assets/agents/fashion.md")),
    ]
});

pub const PERSONALITY: &str = include_str!("../assets/prompts/personality.md");
pub const COMPACTION_PROMPT: &str = include_str!("../assets/prompts/thread-compaction.md");

pub fn agent(id: &str) -> Option<&'static AgentDefinition> {
    AGENTS.iter().find(|a| a.id == id)
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PromptContext {
    pub agent_type: String,
    pub is_user_turn: Option<bool>,
    pub user_prompt: String,
    pub stale_user_reminder_text: String,
    pub should_inject_dynamic_reminder: bool,
    pub orchestrator_reminder_text: String,
    pub connector_transition_reminder_text: String,
    pub last_compaction_at: i64,
    pub shown_reminders: BTreeMap<String, i64>,
    pub connectors: Vec<Connector>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub connectable: bool,
    #[serde(default)]
    pub declined: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    pub text: String,
    pub ui_visibility: &'static str,
    pub message_type: &'static str,
    pub custom_type: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPreparation {
    pub prepend_messages: Vec<PromptMessage>,
    /// Persist these keys only when the prompt is admitted to execution.
    pub reminder_keys: Vec<String>,
}

fn reminder(text: &str, custom_type: &'static str) -> PromptMessage {
    PromptMessage {
        text: format!("<system-reminder>{}</system-reminder>", text.trim()),
        ui_visibility: "hidden",
        message_type: "message",
        custom_type,
    }
}

fn normalized(text: &str) -> String {
    let lower = text.to_lowercase();
    format!(
        " {} ",
        lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    )
}

static SYNONYMS: LazyLock<BTreeMap<String, Vec<String>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/connector-synonyms.json"))
        .expect("bundled synonyms")
});
static STOPWORDS: LazyLock<BTreeSet<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/connector-stopwords.json"))
        .expect("bundled stopwords")
});

pub fn matched_connectors<'a>(catalog: &'a [Connector], prompt: &str) -> Vec<&'a Connector> {
    let text = normalized(prompt);
    let mut hits = Vec::new();
    for entry in catalog {
        let name = normalized(&entry.name).trim().to_string();
        for keyword in [&entry.id, &name] {
            if keyword.len() >= 4
                && !STOPWORDS.contains(keyword)
                && text.contains(&normalized(keyword))
            {
                hits.push((keyword.len(), entry));
            }
        }
        for (word, ids) in SYNONYMS.iter() {
            if ids.contains(&entry.id) && text.contains(&normalized(word)) {
                hits.push((word.len(), entry));
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
    let mut seen = BTreeSet::new();
    hits.into_iter()
        .filter_map(|(_, entry)| {
            if seen.insert(&entry.id) {
                Some(entry)
            } else {
                None
            }
        })
        .take(3)
        .collect()
}

/// Deterministic equivalent of Stella's bundled before-user-message hooks.
/// Connection state is supplied by the platform's credential/catalog store;
/// unavailable entries are omitted, retaining the original best-effort policy.
pub fn prepare_prompt(context: &PromptContext) -> PromptPreparation {
    let mut result = PromptPreparation {
        prepend_messages: vec![],
        reminder_keys: vec![],
    };
    for (text, custom_type, enabled) in [
        (
            &context.stale_user_reminder_text,
            "runtime.stale_user_reminder",
            true,
        ),
        (
            &context.orchestrator_reminder_text,
            "runtime.orchestrator_reminder",
            context.should_inject_dynamic_reminder,
        ),
        (
            &context.connector_transition_reminder_text,
            "runtime.connector_format_reminder",
            true,
        ),
    ] {
        if enabled && !text.trim().is_empty() {
            result.prepend_messages.push(reminder(text, custom_type));
        }
    }
    if context.agent_type != "orchestrator"
        || context.is_user_turn == Some(false)
        || context.user_prompt.trim().is_empty()
    {
        return result;
    }
    let shown = |key: &str| {
        context
            .shown_reminders
            .get(key)
            .is_some_and(|at| *at > context.last_compaction_at)
    };
    let mut available = Vec::new();
    // Match the original Unicode word-boundary semantics for the MCP hint.
    if context
        .user_prompt
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|s| s == "mcp")
        && !shown("connector-mcp-hint")
    {
        available.push(("connector-mcp-hint".to_string(),"Keyword hint: MCP was mentioned, possibly incidentally. If the user wants to manage an MCP connection, agents can use connect.addMcp(…) or connect.remove(id) through the code connect client; connect.documentation() has details.".to_string()));
    }
    for entry in matched_connectors(&context.connectors, &context.user_prompt) {
        if available.len() >= 2 {
            break;
        }
        let id = &entry.id;
        let name = &entry.name;
        let (key, text) = if entry.connected {
            (
                format!("connector-connected:{id}"),
                format!(
                    "Keyword hint: {name} may be relevant. It is connected (integration id `{id}`). If it fits the user's intent, agents can use it via the code connect client (await connect.call(\"{id}\", …)). The keyword match alone does not imply it should be used."
                ),
            )
        } else {
            if !entry.connectable || entry.declined {
                continue;
            }
            (
                format!("connector-offer:{id}"),
                format!(
                    "Keyword hint: {name} may be relevant. Its connector is not connected. If it fits the user's intent and would help, `connector_status` can show an inline connect card (connector: \"{id}\"; also available inside code as tools.connector_status({{ connector: \"{id}\" }})). The keyword match alone does not imply a connection is needed."
                ),
            )
        };
        if !shown(&key) {
            available.push((key, text));
        }
    }
    for (key, text) in available {
        result
            .prepend_messages
            .push(reminder(&text, "runtime.connector_availability_reminder"));
        result.reminder_keys.push(key);
    }
    result
}
