use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::cdp::client::CdpClient;
use super::cdp::types::*;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefLocatorHints {
    pub description: String,
    pub value_text: String,
    pub ancestor_path: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RefEntry {
    pub backend_node_id: Option<i64>,
    pub role: String,
    pub name: String,
    pub nth: Option<usize>,
    pub selector: Option<String>,
    pub hints: RefLocatorHints,
    pub frame_scope: Option<Vec<RefFrame>>,
}

#[derive(Debug, Clone)]
pub struct RefFrame {
    pub frame_id: String,
    pub loader_id: String,
    pub session_id: String,
}

#[derive(Clone)]
pub struct RefMap {
    map: HashMap<String, RefEntry>,
    next_ref: usize,
    capture_scope: Option<Vec<RefFrame>>,
    capture_ref_ids: HashSet<String>,
}

impl RefMap {
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
            next_ref: 1,
            capture_scope: None,
            capture_ref_ids: HashSet::new(),
        }
    }

    pub fn add(
        &mut self,
        ref_id: String,
        backend_node_id: Option<i64>,
        role: &str,
        name: &str,
        nth: Option<usize>,
    ) {
        self.add_with_hints(
            ref_id,
            backend_node_id,
            role,
            name,
            nth,
            RefLocatorHints::default(),
        );
    }

    pub fn add_with_hints(
        &mut self,
        ref_id: String,
        backend_node_id: Option<i64>,
        role: &str,
        name: &str,
        nth: Option<usize>,
        hints: RefLocatorHints,
    ) {
        if self.capture_scope.is_some() {
            self.capture_ref_ids.insert(ref_id.clone());
        }
        self.map.insert(
            ref_id,
            RefEntry {
                backend_node_id,
                role: role.to_string(),
                name: name.to_string(),
                nth,
                selector: None,
                hints,
                frame_scope: self.capture_scope.clone(),
            },
        );
    }

    pub fn add_selector(
        &mut self,
        ref_id: String,
        selector: String,
        role: &str,
        name: &str,
        nth: Option<usize>,
    ) {
        self.map.insert(
            ref_id,
            RefEntry {
                backend_node_id: None,
                role: role.to_string(),
                name: name.to_string(),
                nth,
                selector: Some(selector),
                hints: RefLocatorHints::default(),
                frame_scope: None,
            },
        );
    }

    pub fn get(&self, ref_id: &str) -> Option<&RefEntry> {
        self.map.get(ref_id)
    }

    pub fn set_capture_scope(&mut self, scope: Option<Vec<RefFrame>>) {
        self.capture_scope = scope;
        self.capture_ref_ids.clear();
    }

    pub fn captured_ref_ids(&self) -> &HashSet<String> {
        &self.capture_ref_ids
    }

    pub fn has_capture_scope(&self) -> bool {
        self.capture_scope.is_some()
    }

    pub fn scoped_ref_id(&mut self, backend_id: Option<i64>) -> String {
        let frame = self.capture_scope.as_ref().and_then(|scope| scope.last());
        if let (Some(frame), Some(backend_id)) = (frame, backend_id) {
            if let Some((id, _)) = self.map.iter().find(|(_, entry)| {
                entry.backend_node_id == Some(backend_id)
                    && entry
                        .frame_scope
                        .as_ref()
                        .and_then(|scope| scope.last())
                        .is_some_and(|old| {
                            old.frame_id == frame.frame_id && old.loader_id == frame.loader_id
                        })
            }) {
                return id.clone();
            }
        }
        let id = format!("e{}", self.next_ref);
        self.next_ref += 1;
        id
    }

    pub fn entries_sorted(&self) -> Vec<(String, RefEntry)> {
        let mut entries = self
            .map
            .iter()
            .map(|(ref_id, entry)| (ref_id.clone(), entry.clone()))
            .collect::<Vec<_>>();

        entries.sort_by_key(|(ref_id, _)| {
            ref_id
                .strip_prefix('e')
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(usize::MAX)
        });

        entries
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.next_ref = 1;
        self.capture_scope = None;
        self.capture_ref_ids.clear();
    }

    /// Drop ref entries that were not included in the snapshot returned to
    /// the caller. Snapshot generation can discover more nodes than fit in
    /// the public output budget; keeping those refs would expose handles the
    /// caller never saw and cannot reason about.
    pub fn retain_ids(&mut self, visible_ids: &HashSet<String>) {
        self.map.retain(|ref_id, _| visible_ids.contains(ref_id));
    }

    pub fn next_ref_num(&self) -> usize {
        self.next_ref
    }

    pub fn set_next_ref_num(&mut self, n: usize) {
        self.next_ref = n;
    }
}

pub fn ref_frame_scope<'a>(ref_map: &'a RefMap, selector: &str) -> Option<&'a [RefFrame]> {
    let id = parse_ref(selector)?;
    ref_map.get(&id)?.frame_scope.as_deref()
}

/// The `Page.getFrameTree` subtree rooted at `frame_id`, if present.
pub fn find_frame_tree<'a>(tree: &'a Value, frame_id: &str) -> Option<&'a Value> {
    if tree
        .get("frame")
        .and_then(|frame| frame.get("id"))
        .and_then(Value::as_str)
        == Some(frame_id)
    {
        return Some(tree);
    }
    tree.get("childFrames")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|child| find_frame_tree(child, frame_id))
}

/// The frame metadata object for `frame_id`, if present.
pub fn find_frame<'a>(tree: &'a Value, frame_id: &str) -> Option<&'a Value> {
    find_frame_tree(tree, frame_id).and_then(|tree| tree.get("frame"))
}

/// Whether `frame` is still attached to its session and hosts the document
/// it was observed with.
pub async fn frame_is_current(client: &CdpClient, frame: &RefFrame) -> Result<bool, String> {
    let result = client
        .send_command_no_params("Page.getFrameTree", Some(&frame.session_id))
        .await?;
    Ok(result
        .get("frameTree")
        .and_then(|tree| find_frame(tree, &frame.frame_id))
        .and_then(|current| current.get("loaderId"))
        .and_then(Value::as_str)
        == Some(frame.loader_id.as_str()))
}

/// Validate a ref's frame scope and return the CDP session that owns the
/// element: the innermost scoped frame's session, or the tab session for
/// refs without a frame scope.
pub async fn validate_ref_scope<'a>(
    client: &CdpClient,
    session_id: &'a str,
    entry: &'a RefEntry,
) -> Result<&'a str, String> {
    let Some(scope) = &entry.frame_scope else {
        return Ok(session_id);
    };
    if !scope
        .first()
        .is_some_and(|frame| frame.session_id == session_id)
    {
        return Err(
            "This ref belongs to a different browser tab. Capture a new AX snapshot.".into(),
        );
    }
    for frame in scope {
        if !frame_is_current(client, frame).await? {
            return Err("This ref is stale because its document or ancestor frame navigated. Capture a new AX snapshot.".into());
        }
    }
    Ok(scope
        .last()
        .map(|frame| frame.session_id.as_str())
        .unwrap_or(session_id))
}

/// Re-resolve a ref whose cached backendNodeId went stale. Frame-scoped
/// (cross-origin) refs are never re-matched by role/name: a same-named
/// control in another document must not silently become the target.
async fn refresh_backend_node_id(
    client: &CdpClient,
    session_id: &str,
    entry: &RefEntry,
) -> Result<i64, String> {
    if entry.frame_scope.is_some() {
        return Err("This AX ref no longer resolves. Capture a new AX snapshot.".into());
    }
    find_node_id_by_ref_entry(client, session_id, entry).await
}

pub fn parse_ref(input: &str) -> Option<String> {
    let trimmed = input.trim();

    if let Some(stripped) = trimmed.strip_prefix('@') {
        if stripped.starts_with('e') && stripped[1..].chars().all(|c| c.is_ascii_digit()) {
            return Some(stripped.to_string());
        }
    }

    if let Some(stripped) = trimmed.strip_prefix("ref=") {
        if stripped.starts_with('e') && stripped[1..].chars().all(|c| c.is_ascii_digit()) {
            return Some(stripped.to_string());
        }
    }

    if trimmed.starts_with('e')
        && trimmed.len() > 1
        && trimmed[1..].chars().all(|c| c.is_ascii_digit())
    {
        return Some(trimmed.to_string());
    }

    None
}

pub async fn resolve_element_center(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(f64, f64), String> {
    if let Some(ref_id) = parse_ref(selector_or_ref) {
        let entry = ref_map
            .get(&ref_id)
            .ok_or_else(|| format!("Unknown ref: {}", ref_id))?;

        let session_id = validate_ref_scope(client, session_id, entry).await?;

        // Try cached backend_node_id first (fast path)
        if let Some(backend_node_id) = entry.backend_node_id {
            let result: Result<DomGetBoxModelResult, String> = client
                .send_command_typed(
                    "DOM.getBoxModel",
                    &DomGetBoxModelParams {
                        backend_node_id: Some(backend_node_id),
                        node_id: None,
                        object_id: None,
                    },
                    Some(session_id),
                )
                .await;

            if let Ok(r) = result {
                return Ok(box_model_center(&r.model));
            }
            // backend_node_id is stale; re-query the accessibility tree below
        }

        let fresh_id = refresh_backend_node_id(client, session_id, entry).await?;
        let result: DomGetBoxModelResult = client
            .send_command_typed(
                "DOM.getBoxModel",
                &DomGetBoxModelParams {
                    backend_node_id: Some(fresh_id),
                    node_id: None,
                    object_id: None,
                },
                Some(session_id),
            )
            .await?;
        return Ok(box_model_center(&result.model));
    }

    // Semantic (aria=) or CSS selector: resolve via the unified resolver,
    // then compute the center of the bounding rect.
    let object_id = resolve_selector_object_id(client, session_id, selector_or_ref).await?;
    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    const rect = this.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }"#
                .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    let val = result.result.value.unwrap_or(Value::Null);
    match (
        val.get("x").and_then(|v| v.as_f64()),
        val.get("y").and_then(|v| v.as_f64()),
    ) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(format!("Element not found: {}", selector_or_ref)),
    }
}

/// Resolve any non-ref selector string (semantic `aria=` payloads or plain
/// CSS) to a Runtime objectId via a single injected resolver script.
///
/// The injected expression evaluates to the matched ELEMENT on success or to
/// a plain STRING error message on failure; the RemoteObject type
/// distinguishes the two.
pub async fn resolve_selector_object_id(
    client: &CdpClient,
    session_id: &str,
    selector: &str,
) -> Result<String, String> {
    let expression = super::selector::resolve_one_expression_for(selector)?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.evaluate",
            &EvaluateParams {
                expression,
                return_by_value: Some(false),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    if let Some(details) = result.exception_details {
        let message = details
            .exception
            .as_ref()
            .and_then(|e| e.description.clone())
            .unwrap_or(details.text);
        return Err(format!("Selector resolution failed: {}", message));
    }

    let object = result.result;
    if object.object_type == "string" {
        return Err(object
            .value
            .as_ref()
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Element not found: {}", selector)));
    }

    object
        .object_id
        .ok_or_else(|| format!("Element not found: {}", selector))
}

/// Resolve a ref or selector to a live Runtime objectId together with the
/// CDP session that owns it (a frame-scoped ref lives in its frame's
/// session; everything else in the tab session).
pub async fn resolve_element_object_id<'a>(
    client: &CdpClient,
    session_id: &'a str,
    ref_map: &'a RefMap,
    selector_or_ref: &str,
) -> Result<(String, &'a str), String> {
    if let Some(ref_id) = parse_ref(selector_or_ref) {
        let entry = ref_map
            .get(&ref_id)
            .ok_or_else(|| format!("Unknown ref: {}", ref_id))?;

        let session_id = validate_ref_scope(client, session_id, entry).await?;

        // Try cached backend_node_id first (fast path)
        if let Some(backend_node_id) = entry.backend_node_id {
            let result: Result<DomResolveNodeResult, String> = client
                .send_command_typed(
                    "DOM.resolveNode",
                    &DomResolveNodeParams {
                        backend_node_id: Some(backend_node_id),
                        node_id: None,
                        object_group: Some("stella-browser".to_string()),
                    },
                    Some(session_id),
                )
                .await;

            if let Ok(r) = result {
                if let Some(oid) = r.object.object_id {
                    return Ok((oid, session_id));
                }
            }
            // backend_node_id is stale; re-query the accessibility tree below
        }

        let fresh_id = refresh_backend_node_id(client, session_id, entry).await?;
        let result: DomResolveNodeResult = client
            .send_command_typed(
                "DOM.resolveNode",
                &DomResolveNodeParams {
                    backend_node_id: Some(fresh_id),
                    node_id: None,
                    object_group: Some("stella-browser".to_string()),
                },
                Some(session_id),
            )
            .await?;
        return result
            .object
            .object_id
            .map(|oid| (oid, session_id))
            .ok_or_else(|| format!("No objectId for ref {}", ref_id));
    }

    // Semantic (aria=) or CSS selector fallback via the unified resolver.
    let object_id = resolve_selector_object_id(client, session_id, selector_or_ref).await?;
    Ok((object_id, session_id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RefCandidate {
    backend_node_id: i64,
    role: String,
    name: String,
    description: String,
    value_text: String,
    ancestor_path: Vec<String>,
}

/// Re-query the accessibility tree and resolve a fresh backendDOMNodeId using
/// progressively broader heuristics:
/// 1. exact role/name/nth parity with the original snapshot
/// 2. scored role-preserving fuzzy match using description/value/ancestor path
async fn find_node_id_by_ref_entry(
    client: &CdpClient,
    session_id: &str,
    entry: &RefEntry,
) -> Result<i64, String> {
    let ax_tree: GetFullAXTreeResult = client
        .send_command_typed(
            "Accessibility.getFullAXTree",
            &serde_json::json!({}),
            Some(session_id),
        )
        .await?;

    let parent_by_idx = build_ax_parent_map(&ax_tree.nodes);
    let expected_name = normalize_locator_text(&entry.name);
    let nth_index = entry.nth.unwrap_or(0);
    let mut exact_matches: Vec<RefCandidate> = Vec::new();
    let mut candidates: Vec<RefCandidate> = Vec::new();

    for (idx, node) in ax_tree.nodes.iter().enumerate() {
        if node.ignored.unwrap_or(false) {
            continue;
        }
        let node_role = extract_ax_string(&node.role);
        if node_role != entry.role {
            continue;
        }
        let Some(backend_node_id) = node.backend_d_o_m_node_id else {
            continue;
        };
        let candidate = RefCandidate {
            backend_node_id,
            role: node_role,
            name: extract_ax_string(&node.name),
            description: extract_ax_string(&node.description),
            value_text: extract_ax_string_opt(&node.value),
            ancestor_path: build_ax_ancestor_path(&ax_tree.nodes, &parent_by_idx, idx, 3),
        };

        let candidate_name = normalize_locator_text(&candidate.name);
        if (expected_name.is_empty() && candidate_name.is_empty())
            || (!expected_name.is_empty() && candidate_name == expected_name)
        {
            exact_matches.push(candidate.clone());
        }
        candidates.push(candidate);
    }

    if let Some(candidate) = exact_matches.get(nth_index) {
        return Ok(candidate.backend_node_id);
    }

    if let Some(candidate) = select_best_candidate(entry, &candidates) {
        return Ok(candidate.backend_node_id);
    }

    Err(format!(
        "Could not locate element with role={} name={}",
        entry.role, entry.name
    ))
}

fn extract_ax_string(value: &Option<AXValue>) -> String {
    match value {
        Some(v) => match &v.value {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b)) => b.to_string(),
            _ => String::new(),
        },
        None => String::new(),
    }
}

fn extract_ax_string_opt(value: &Option<AXValue>) -> String {
    match value {
        Some(v) => match &v.value {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b)) => b.to_string(),
            _ => String::new(),
        },
        None => String::new(),
    }
}

fn build_ax_parent_map(nodes: &[AXNode]) -> HashMap<usize, usize> {
    let mut id_to_idx: HashMap<&str, usize> = HashMap::with_capacity(nodes.len());
    for (idx, node) in nodes.iter().enumerate() {
        id_to_idx.insert(node.node_id.as_str(), idx);
    }

    let mut parent_by_idx = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        if let Some(child_ids) = &node.child_ids {
            for child_id in child_ids {
                if let Some(&child_idx) = id_to_idx.get(child_id.as_str()) {
                    parent_by_idx.insert(child_idx, idx);
                }
            }
        }
    }
    parent_by_idx
}

fn build_ax_ancestor_path(
    nodes: &[AXNode],
    parent_by_idx: &HashMap<usize, usize>,
    mut idx: usize,
    max_len: usize,
) -> Vec<String> {
    let mut path = Vec::new();

    while let Some(parent_idx) = parent_by_idx.get(&idx).copied() {
        idx = parent_idx;
        let parent = &nodes[idx];
        if parent.ignored.unwrap_or(false) {
            continue;
        }
        let role = extract_ax_string(&parent.role);
        let name = extract_ax_string(&parent.name);
        if role.is_empty() {
            continue;
        }
        if name.is_empty() && is_low_signal_ax_role(&role) {
            continue;
        }
        path.push(format!("{}:{}", role, name));
        if path.len() >= max_len {
            break;
        }
    }

    path.reverse();
    path
}

fn is_low_signal_ax_role(role: &str) -> bool {
    matches!(
        role,
        "RootWebArea" | "WebArea" | "none" | "generic" | "group" | "presentation"
    )
}

fn normalize_locator_text(value: &str) -> String {
    value
        .split_whitespace()
        .map(|segment| segment.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn longest_common_ancestor_suffix(expected: &[String], actual: &[String]) -> usize {
    let mut matches = 0;
    let mut left = expected.iter().rev();
    let mut right = actual.iter().rev();
    loop {
        match (left.next(), right.next()) {
            (Some(a), Some(b)) if normalize_locator_text(a) == normalize_locator_text(b) => {
                matches += 1;
            }
            _ => return matches,
        }
    }
}

fn score_text_match(expected: &str, actual: &str) -> i32 {
    let expected = normalize_locator_text(expected);
    let actual = normalize_locator_text(actual);

    if expected.is_empty() || actual.is_empty() {
        return 0;
    }
    if expected == actual {
        return 120;
    }
    if actual.contains(&expected) || expected.contains(&actual) {
        return 80;
    }

    let expected_tokens: Vec<&str> = expected.split(' ').collect();
    let actual_tokens: Vec<&str> = actual.split(' ').collect();
    let overlap = expected_tokens
        .iter()
        .filter(|token| !token.is_empty() && actual_tokens.contains(token))
        .count();
    if overlap == 0 {
        return 0;
    }

    (overlap as i32) * 25
}

fn score_candidate(entry: &RefEntry, candidate: &RefCandidate) -> i32 {
    if entry.role != candidate.role {
        return i32::MIN;
    }

    let mut score = 200;
    score += score_text_match(&entry.name, &candidate.name);
    score += score_text_match(&entry.hints.description, &candidate.description) / 2;
    score += score_text_match(&entry.hints.value_text, &candidate.value_text) / 2;

    let ancestor_overlap =
        longest_common_ancestor_suffix(&entry.hints.ancestor_path, &candidate.ancestor_path);
    score += (ancestor_overlap as i32) * 35;

    score
}

fn select_best_candidate<'a>(
    entry: &RefEntry,
    candidates: &'a [RefCandidate],
) -> Option<&'a RefCandidate> {
    let mut best: Option<&RefCandidate> = None;
    let mut best_score = i32::MIN;
    let mut second_best = i32::MIN;

    for candidate in candidates {
        let score = score_candidate(entry, candidate);
        if score > best_score {
            second_best = best_score;
            best_score = score;
            best = Some(candidate);
        } else if score > second_best {
            second_best = score;
        }
    }

    let minimum_score = if normalize_locator_text(&entry.name).is_empty() {
        235
    } else {
        260
    };

    if best_score < minimum_score || best_score == second_best {
        return None;
    }

    best
}

fn box_model_center(model: &BoxModel) -> (f64, f64) {
    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    if model.content.len() >= 8 {
        let x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4.0;
        let y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4.0;
        (x, y)
    } else {
        (0.0, 0.0)
    }
}

pub async fn get_element_text(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<String, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration:
                    "function() { return this.innerText || this.textContent || ''; }".to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

pub async fn get_element_attribute(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    attribute: &str,
) -> Result<Value, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: format!(
                    "function() {{ return this.getAttribute({}); }}",
                    serde_json::to_string(attribute).unwrap_or_default()
                ),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result.result.value.unwrap_or(Value::Null))
}

pub async fn is_element_visible(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<bool, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    const rect = this.getBoundingClientRect();
                    const style = window.getComputedStyle(this);
                    return rect.width > 0 && rect.height > 0 &&
                           style.visibility !== 'hidden' &&
                           style.display !== 'none' &&
                           parseFloat(style.opacity) > 0;
                }"#
                .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

pub async fn is_element_enabled(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<bool, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { return !this.disabled; }".to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_bool())
        .unwrap_or(true))
}

pub async fn is_element_checked(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<bool, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    // Mirrors Playwright's getChecked() with follow-label retargeting:
    // 1. If element is a native checkbox/radio input, return .checked
    // 2. If element has an ARIA checked role, return aria-checked
    // 3. Follow label → input association (label.control)
    // 4. Check for nested checkbox/radio input as last resort
    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    var el = this;
                    // Native checkbox/radio input
                    var tag = el.tagName && el.tagName.toUpperCase();
                    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                        return el.checked;
                    }
                    // ARIA role-based checked state
                    var role = el.getAttribute && el.getAttribute('role');
                    var ariaCheckedRoles = ['checkbox','radio','switch','menuitemcheckbox','menuitemradio','option','treeitem'];
                    if (role && ariaCheckedRoles.indexOf(role) !== -1) {
                        return el.getAttribute('aria-checked') === 'true';
                    }
                    // Follow label association (Playwright follow-label retarget)
                    var label = el;
                    if (tag !== 'LABEL') {
                        label = el.closest && el.closest('label');
                    }
                    if (label && label.tagName && label.tagName.toUpperCase() === 'LABEL' && label.control) {
                        var ctrl = label.control;
                        if (ctrl.type === 'checkbox' || ctrl.type === 'radio') {
                            return ctrl.checked;
                        }
                    }
                    // Check for nested native input
                    var input = el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"]');
                    if (input) return input.checked;
                    return false;
                }"#.to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

pub async fn get_element_inner_text(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<String, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { return this.innerText || ''; }".to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

pub async fn get_element_inner_html(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<String, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { return this.innerHTML || ''; }".to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

pub async fn get_element_input_value(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<String, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration:
                    "function() { return typeof this.value === 'string' ? this.value : ''; }"
                        .to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result
        .result
        .value
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default())
}

pub async fn set_element_value(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    value: &str,
) -> Result<(), String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let js = format!(
        "function() {{ this.value = {}; this.dispatchEvent(new Event('input', {{bubbles: true}})); this.dispatchEvent(new Event('change', {{bubbles: true}})); }}",
        serde_json::to_string(value).unwrap_or_default()
    );

    client
        .send_command_typed::<_, EvaluateResult>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js,
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn get_element_bounding_box(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<Value, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: BOUNDING_BOX_JS.to_string(),
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    result
        .result
        .value
        .ok_or_else(|| format!("Could not get bounding box for: {}", selector_or_ref))
}

/// Return geometry in top-viewport coordinates, matching coordinate actions
/// and the extension backend. `getBoundingClientRect()` is frame-local, so a
/// same-origin iframe result must accumulate every ancestor frame's content
/// offset and border before it is exposed to callers.
const BOUNDING_BOX_JS: &str = r#"function() {
    const r = this.getBoundingClientRect();
    let x = r.x;
    let y = r.y;
    let win = this.ownerDocument && this.ownerDocument.defaultView;
    for (let depth = 0; depth < 16 && win && win !== win.parent; depth += 1) {
        let frame = null;
        try { frame = win.frameElement; } catch (_) { frame = null; }
        if (!frame) break;
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.left + frame.clientLeft;
        y += frameRect.top + frame.clientTop;
        win = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return { x, y, width: r.width, height: r.height };
}"#;

pub async fn get_element_count(
    client: &CdpClient,
    session_id: &str,
    selector: &str,
) -> Result<i64, String> {
    // Semantic selectors (aria=) count matches through the unified resolver;
    // plain CSS counts across every reachable document (top document,
    // same-origin iframes, open shadow roots) via the same root walk.
    let js = match super::selector::parse_semantic_selector(selector)? {
        Some(semantic) => super::selector::count_expression(&semantic),
        None => format!(
            "{}.length",
            super::selector::css_match_all_expression(selector)
        ),
    };

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.evaluate",
            &EvaluateParams {
                expression: js,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result.result.value.and_then(|v| v.as_i64()).unwrap_or(0))
}

pub async fn get_element_styles(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    properties: Option<Vec<String>>,
) -> Result<Value, String> {
    let (object_id, session_id) =
        resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let js = match properties {
        Some(props) => {
            let props_json = serde_json::to_string(&props).unwrap_or("[]".to_string());
            format!(
                r#"function() {{
                    const s = window.getComputedStyle(this);
                    const props = {};
                    const result = {{}};
                    for (const p of props) result[p] = s.getPropertyValue(p);
                    return result;
                }}"#,
                props_json
            )
        }
        None => r#"function() {
                    const s = window.getComputedStyle(this);
                    const result = {};
                    for (let i = 0; i < s.length; i++) {
                        const p = s[i];
                        result[p] = s.getPropertyValue(p);
                    }
                    return result;
                }"#
        .to_string(),
    };

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js,
                object_id: Some(object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(result.result.value.unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounding_box_geometry_is_top_viewport_relative() {
        assert!(BOUNDING_BOX_JS.contains("this.ownerDocument"));
        assert!(BOUNDING_BOX_JS.contains("win.frameElement"));
        assert!(BOUNDING_BOX_JS.contains("frameRect.left + frame.clientLeft"));
        assert!(BOUNDING_BOX_JS.contains("frameRect.top + frame.clientTop"));
    }

    fn make_ref_entry(
        role: &str,
        name: &str,
        description: &str,
        value_text: &str,
        ancestor_path: &[&str],
    ) -> RefEntry {
        RefEntry {
            backend_node_id: None,
            role: role.to_string(),
            name: name.to_string(),
            nth: None,
            selector: None,
            frame_scope: None,
            hints: RefLocatorHints {
                description: description.to_string(),
                value_text: value_text.to_string(),
                ancestor_path: ancestor_path
                    .iter()
                    .map(|segment| segment.to_string())
                    .collect(),
            },
        }
    }

    fn make_candidate(
        backend_node_id: i64,
        role: &str,
        name: &str,
        description: &str,
        value_text: &str,
        ancestor_path: &[&str],
    ) -> RefCandidate {
        RefCandidate {
            backend_node_id,
            role: role.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            value_text: value_text.to_string(),
            ancestor_path: ancestor_path
                .iter()
                .map(|segment| segment.to_string())
                .collect(),
        }
    }

    #[test]
    fn test_parse_ref_at_prefix() {
        assert_eq!(parse_ref("@e1"), Some("e1".to_string()));
        assert_eq!(parse_ref("@e123"), Some("e123".to_string()));
    }

    #[test]
    fn test_parse_ref_equals_prefix() {
        assert_eq!(parse_ref("ref=e1"), Some("e1".to_string()));
    }

    #[test]
    fn test_parse_ref_bare() {
        assert_eq!(parse_ref("e1"), Some("e1".to_string()));
        assert_eq!(parse_ref("e42"), Some("e42".to_string()));
    }

    #[test]
    fn test_parse_ref_invalid() {
        assert_eq!(parse_ref("button"), None);
        assert_eq!(parse_ref("e"), None);
        assert_eq!(parse_ref("1"), None);
        assert_eq!(parse_ref(""), None);
    }

    #[test]
    fn test_ref_map_basic() {
        let mut map = RefMap::new();
        map.add("e1".to_string(), Some(42), "button", "Submit", None);
        assert!(map.get("e1").is_some());
        assert_eq!(map.get("e1").unwrap().role, "button");
        assert!(map.get("e2").is_none());
    }

    #[test]
    fn test_box_model_center() {
        let model = BoxModel {
            content: vec![10.0, 20.0, 110.0, 20.0, 110.0, 60.0, 10.0, 60.0],
            padding: vec![],
            border: vec![],
            margin: vec![],
            width: 100,
            height: 40,
        };
        let (x, y) = box_model_center(&model);
        assert!((x - 60.0).abs() < 0.01);
        assert!((y - 40.0).abs() < 0.01);
    }

    #[test]
    fn test_select_best_candidate_prefers_matching_ancestor_path() {
        let entry = make_ref_entry("button", "Save", "", "", &["dialog:Billing"]);
        let candidates = vec![
            make_candidate(1, "button", "Save", "", "", &["dialog:Profile"]),
            make_candidate(2, "button", "Save", "", "", &["dialog:Billing"]),
        ];

        let selected = select_best_candidate(&entry, &candidates).expect("candidate");
        assert_eq!(selected.backend_node_id, 2);
    }

    #[test]
    fn test_select_best_candidate_allows_name_drift_with_context() {
        let entry = make_ref_entry(
            "button",
            "Continue",
            "Proceed to checkout",
            "",
            &["form:Checkout"],
        );
        let candidates = vec![
            make_candidate(
                1,
                "button",
                "Continue to payment",
                "Proceed to checkout",
                "",
                &["form:Checkout"],
            ),
            make_candidate(
                2,
                "button",
                "Continue to payment",
                "",
                "",
                &["form:Profile"],
            ),
        ];

        let selected = select_best_candidate(&entry, &candidates).expect("candidate");
        assert_eq!(selected.backend_node_id, 1);
    }

    #[test]
    fn test_select_best_candidate_rejects_ambiguous_tie() {
        let entry = make_ref_entry("button", "Save", "", "", &["dialog:Billing"]);
        let candidates = vec![
            make_candidate(1, "button", "Save", "", "", &["dialog:Billing"]),
            make_candidate(2, "button", "Save", "", "", &["dialog:Billing"]),
        ];

        assert!(select_best_candidate(&entry, &candidates).is_none());
    }
}
