use std::collections::BTreeSet;

const ACTIONS_RS: &str = include_str!("actions.rs");
const MANIFEST: &str = include_str!("../../../protocol/actions.json");

fn manifest_actions() -> (BTreeSet<String>, BTreeSet<String>) {
    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).expect("protocol/actions.json must be valid JSON");
    let actions = manifest
        .get("actions")
        .and_then(|v| v.as_object())
        .expect("manifest must have an actions object");
    let mut all = BTreeSet::new();
    let mut chain = BTreeSet::new();
    for (name, entry) in actions {
        assert!(
            !name.trim().is_empty(),
            "manifest contains an empty action name"
        );
        assert!(
            entry.get("params").and_then(|v| v.as_array()).is_some(),
            "manifest action '{}' must list params (possibly empty)",
            name
        );
        all.insert(name.clone());
        if entry.get("chain").and_then(|v| v.as_bool()) == Some(true) {
            chain.insert(name.clone());
        }
    }
    (all, chain)
}

fn function_body<'a>(source: &'a str, needle: &str) -> &'a str {
    let start = source
        .find(needle)
        .unwrap_or_else(|| panic!("actions.rs no longer contains `{}`", needle));
    let rest = &source[start..];
    let end = rest
        .find("\n}")
        .unwrap_or_else(|| panic!("could not find the end of `{}`", needle));
    &rest[..end]
}

fn string_literals(body: &str) -> Vec<String> {
    let mut literals = Vec::new();
    let mut chars = body.char_indices();
    while let Some((start, ch)) = chars.next() {
        if ch != '"' {
            continue;
        }
        let mut literal = String::new();
        let mut closed = false;
        for (_, inner) in chars.by_ref() {
            match inner {
                '"' => {
                    closed = true;
                    break;
                }
                '\\' => {

                    literal.push(inner);
                }
                _ => literal.push(inner),
            }
        }
        assert!(closed, "unterminated string literal at byte {}", start);
        literals.push(literal);
    }
    literals
}

fn membership_fn_actions(needle: &str) -> BTreeSet<String> {
    string_literals(function_body(ACTIONS_RS, needle))
        .into_iter()
        .filter(|literal| !literal.is_empty())
        .collect()
}

fn dispatch_arm_actions() -> BTreeSet<String> {
    let body = function_body(ACTIONS_RS, "async fn dispatch_action(");
    let mut actions = BTreeSet::new();
    let mut pattern = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if pattern.is_empty() && !trimmed.starts_with('"') {
            continue;
        }
        pattern.push(' ');
        if let Some(arrow) = trimmed.find("=>") {
            pattern.push_str(&trimmed[..arrow]);

            if pattern
                .split('|')
                .all(|part| part.trim().starts_with('"') && part.trim().ends_with('"'))
            {
                for literal in string_literals(&pattern) {
                    let is_action_name = !literal.is_empty()
                        && literal.chars().all(|c| c.is_ascii_lowercase() || c == '_');
                    if is_action_name {
                        actions.insert(literal);
                    }
                }
            }
            pattern.clear();
        } else {
            pattern.push_str(trimmed);
        }
    }
    actions
}

fn diff(label: &str, left: &BTreeSet<String>, right: &BTreeSet<String>) -> String {
    let missing: Vec<_> = left.difference(right).cloned().collect();
    if missing.is_empty() {
        String::new()
    } else {
        format!("\n  {}: {:?}", label, missing)
    }
}

#[test]
fn known_actions_match_manifest() {
    let (manifest_all, _) = manifest_actions();
    let known = membership_fn_actions("fn is_known_action(");
    assert!(
        manifest_all == known,
        "is_known_action and protocol/actions.json disagree:{}{}",
        diff("in manifest but not is_known_action", &manifest_all, &known),
        diff("in is_known_action but not manifest", &known, &manifest_all),
    );
}

#[test]
fn chain_allowed_actions_match_manifest() {
    let (manifest_all, manifest_chain) = manifest_actions();
    let chain = membership_fn_actions("fn is_chain_allowed_action(");
    assert!(
        manifest_chain == chain,
        "is_chain_allowed_action and the manifest's \"chain\": true set disagree:{}{}",
        diff(
            "in manifest but not is_chain_allowed_action",
            &manifest_chain,
            &chain
        ),
        diff(
            "in is_chain_allowed_action but not manifest",
            &chain,
            &manifest_chain
        ),
    );
    assert!(
        chain.is_subset(&manifest_all),
        "chain-allowed actions must be known actions"
    );

    for top_level_only in [
        "chain",
        "mark_tab",
        "finalize_tabs",
        "close_owner",
        "release_owner_lease",
        "cookies_export_all",
        "cookies_export_for_urls",
        "extension_status",
        "launch",
        "close",
        "confirm",
        "deny",
    ] {
        assert!(
            !chain.contains(top_level_only),
            "'{}' is top-level-only and must not be chain-allowed",
            top_level_only
        );
    }
}

#[test]
fn every_manifest_action_dispatches_and_every_arm_is_in_the_manifest() {
    let (manifest_all, _) = manifest_actions();
    let arms = dispatch_arm_actions();
    assert!(
        manifest_all == arms,
        "dispatch_action arms and protocol/actions.json disagree (a manifest action without an arm would return 'Not yet implemented'):{}{}",
        diff("in manifest but not dispatched", &manifest_all, &arms),
        diff("dispatched but not in manifest", &arms, &manifest_all),
    );
}

#[test]
fn manifest_chain_steps_have_no_daemon_only_params() {

    let manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    let chain_entry = &manifest["actions"]["chain"];
    assert_eq!(chain_entry["chain"], serde_json::Value::Bool(false));
    let params: Vec<&str> = chain_entry["params"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(params.contains(&"steps"), "chain must accept steps");
}
