//! Unified selector parsing and page-side resolution.
//!
//! One code path resolves every selector shape the CLI accepts:
//! - snapshot refs (`@e1`, `ref=e1`, `e1`) — handled by `element::parse_ref`
//!   and the `RefMap` (backend node ids), not by this module
//! - semantic selectors (`aria=<urlencoded JSON>`) — the agent-facing contract
//!   produced by worker-api.ts `semanticSelector()` and by the extension's
//!   `lib/selector.js` `encodeSemanticSelector()`
//! - plain CSS selectors — everything else
//!
//! The semantic matching semantics (role map, accessible-name computation,
//! exact vs. substring matching, visibility filtering) intentionally mirror
//! `packages/stella-browser/extension/lib/selector.js` so the CDP backend and
//! the extension backend resolve the same selector to the same element.

use serde_json::Value;

pub const SEMANTIC_SELECTOR_PREFIX: &str = "aria=";
pub const MAX_SEMANTIC_SELECTOR_LENGTH: usize = 8192;
pub const MAX_SEMANTIC_VALUE_LENGTH: usize = 1024;
pub const MAX_SEMANTIC_ROLE_LENGTH: usize = 128;
pub const MAX_SEMANTIC_NTH: u64 = 10_000;

/// Semantic locator kinds. The first five are the wire contract shared with
/// worker-api.ts and the extension. `alttext` and `title` are CLI-internal
/// extensions used by the `getbyalttext` / `getbytitle` commands (the JS side
/// never encodes them, but accepting them keeps the getby* handlers on the
/// same resolver).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticKind {
    Role,
    Text,
    Label,
    Placeholder,
    TestId,
    AltText,
    Title,
}

impl SemanticKind {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "role" => Some(Self::Role),
            "text" => Some(Self::Text),
            "label" => Some(Self::Label),
            "placeholder" => Some(Self::Placeholder),
            "testid" => Some(Self::TestId),
            "alttext" => Some(Self::AltText),
            "title" => Some(Self::Title),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Role => "role",
            Self::Text => "text",
            Self::Label => "label",
            Self::Placeholder => "placeholder",
            Self::TestId => "testid",
            Self::AltText => "alttext",
            Self::Title => "title",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticSelector {
    pub kind: SemanticKind,
    /// Only set for kind == Role.
    pub role: Option<String>,
    /// Optional accessible-name filter, only for kind == Role.
    pub name: Option<String>,
    /// The match value for all non-role kinds.
    pub value: Option<String>,
    pub nth: Option<u64>,
    pub exact: bool,
}

impl SemanticSelector {
    pub fn by_role(role: &str, name: Option<&str>, exact: bool) -> Result<Self, String> {
        validate_bounded_string(role, "role", MAX_SEMANTIC_ROLE_LENGTH)?;
        if !is_valid_role_format(role) {
            return Err("Semantic selector field 'role' has an invalid format".to_string());
        }
        if let Some(n) = name {
            validate_bounded_string(n, "name", MAX_SEMANTIC_VALUE_LENGTH)?;
        }
        Ok(Self {
            kind: SemanticKind::Role,
            role: Some(role.to_string()),
            name: name.map(|n| n.to_string()),
            value: None,
            nth: None,
            exact,
        })
    }

    pub fn by_value(kind: SemanticKind, value: &str, exact: bool) -> Result<Self, String> {
        if kind == SemanticKind::Role {
            return Err("Use by_role for role selectors".to_string());
        }
        validate_bounded_string(value, "value", MAX_SEMANTIC_VALUE_LENGTH)?;
        Ok(Self {
            kind,
            role: None,
            name: None,
            value: Some(value.to_string()),
            nth: None,
            exact,
        })
    }

    /// Human-readable description used in "No element found with ..." errors.
    /// Mirrors the extension's description format:
    ///   role="button" name="Submit"   |   text="Sign in"
    pub fn describe(&self) -> String {
        match self.kind {
            SemanticKind::Role => {
                let role = json_quote(self.role.as_deref().unwrap_or(""));
                match &self.name {
                    Some(name) => format!("role={} name={}", role, json_quote(name)),
                    None => format!("role={}", role),
                }
            }
            _ => format!(
                "{}={}",
                self.kind.as_str(),
                json_quote(self.value.as_deref().unwrap_or(""))
            ),
        }
    }

    fn matcher_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "kind".to_string(),
            Value::String(self.kind.as_str().to_string()),
        );
        if let Some(role) = &self.role {
            obj.insert("role".to_string(), Value::String(role.clone()));
        }
        if let Some(name) = &self.name {
            obj.insert("name".to_string(), Value::String(name.clone()));
        }
        if let Some(value) = &self.value {
            obj.insert("value".to_string(), Value::String(value.clone()));
        }
        if let Some(nth) = self.nth {
            obj.insert("nth".to_string(), Value::Number(nth.into()));
        }
        obj.insert("exact".to_string(), Value::Bool(self.exact));
        Value::Object(obj)
    }
}

fn json_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{}\"", value))
}

fn is_valid_role_format(role: &str) -> bool {
    let mut chars = role.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate_bounded_string(value: &str, field: &str, max_length: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!(
            "Semantic selector field '{}' must be a non-empty string",
            field
        ));
    }
    if value.chars().count() > max_length {
        return Err(format!(
            "Semantic selector field '{}' exceeds {} characters",
            field, max_length
        ));
    }
    Ok(())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Percent-decode a string the way `decodeURIComponent` does (strict: invalid
/// escape sequences are an error, `+` is NOT treated as a space).
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[i + 1])?;
            let low = hex_value(bytes[i + 2])?;
            out.push(high * 16 + low);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Percent-encode a string the way `encodeURIComponent` does.
fn percent_encode(input: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// Encode a semantic selector into the `aria=<urlencoded JSON>` wire format.
pub fn encode_semantic_selector(selector: &SemanticSelector) -> String {
    let json = serde_json::to_string(&selector.matcher_json()).unwrap_or_default();
    format!("{}{}", SEMANTIC_SELECTOR_PREFIX, percent_encode(&json))
}

/// Parse an `aria=<urlencoded JSON>` semantic selector.
///
/// Returns `Ok(None)` when the input does not carry the `aria=` prefix (i.e.
/// it should be treated as a CSS selector), `Ok(Some(..))` for a valid
/// semantic selector, and `Err` for a malformed semantic selector. Error
/// messages mirror `extension/lib/selector.js`.
pub fn parse_semantic_selector(selector: &str) -> Result<Option<SemanticSelector>, String> {
    let Some(encoded) = selector.strip_prefix(SEMANTIC_SELECTOR_PREFIX) else {
        return Ok(None);
    };
    if selector.chars().count() > MAX_SEMANTIC_SELECTOR_LENGTH {
        return Err(format!(
            "Semantic selector exceeds the {} character limit",
            MAX_SEMANTIC_SELECTOR_LENGTH
        ));
    }
    if encoded.is_empty() {
        return Err("Semantic selector payload is empty".to_string());
    }
    let decoded = percent_decode(encoded)
        .ok_or_else(|| "Semantic selector payload is not valid percent-encoding".to_string())?;
    let parsed: Value = serde_json::from_str(&decoded)
        .map_err(|_| "Semantic selector payload is not valid JSON".to_string())?;
    normalize_semantic_selector(&parsed).map(Some)
}

fn normalize_semantic_selector(value: &Value) -> Result<SemanticSelector, String> {
    let Value::Object(map) = value else {
        return Err("Semantic selector payload must be a JSON object".to_string());
    };

    let kind_str = match map.get("kind") {
        Some(Value::String(s)) if !s.is_empty() => s.as_str(),
        _ => {
            return Err("Semantic selector field 'kind' must be a non-empty string".to_string());
        }
    };
    let kind = SemanticKind::from_str(kind_str)
        .ok_or_else(|| format!("Unsupported semantic selector kind: {}", kind_str))?;

    let allowed: &[&str] = if kind == SemanticKind::Role {
        &["kind", "role", "name", "nth", "exact"]
    } else {
        &["kind", "value", "nth", "exact"]
    };
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "Unknown semantic selector field '{}' for kind '{}'",
                key, kind_str
            ));
        }
    }

    let nth = match map.get("nth") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => match n.as_u64() {
            Some(v) if v <= MAX_SEMANTIC_NTH && n.is_u64() => Some(v),
            _ => {
                return Err(format!(
                    "Semantic selector field 'nth' must be an integer from 0 to {}",
                    MAX_SEMANTIC_NTH
                ));
            }
        },
        Some(_) => {
            return Err(format!(
                "Semantic selector field 'nth' must be an integer from 0 to {}",
                MAX_SEMANTIC_NTH
            ));
        }
    };

    let exact = match map.get("exact") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err("Semantic selector field 'exact' must be a boolean".to_string());
        }
    };

    let string_field = |field: &str, max: usize, optional: bool| -> Result<Option<String>, String> {
        match map.get(field) {
            None if optional => Ok(None),
            Some(Value::String(s)) => {
                validate_bounded_string(s, field, max)?;
                Ok(Some(s.clone()))
            }
            _ => Err(format!(
                "Semantic selector field '{}' must be a non-empty string",
                field
            )),
        }
    };

    if kind == SemanticKind::Role {
        let role = string_field("role", MAX_SEMANTIC_ROLE_LENGTH, false)?.unwrap_or_default();
        if !is_valid_role_format(&role) {
            return Err("Semantic selector field 'role' has an invalid format".to_string());
        }
        let name = string_field("name", MAX_SEMANTIC_VALUE_LENGTH, true)?;
        return Ok(SemanticSelector {
            kind,
            role: Some(role),
            name,
            value: None,
            nth,
            exact,
        });
    }

    let value = string_field("value", MAX_SEMANTIC_VALUE_LENGTH, false)?;
    Ok(SemanticSelector {
        kind,
        role: None,
        name: None,
        value,
        nth,
        exact,
    })
}

// ---------------------------------------------------------------------------
// Page-side resolution scripts
// ---------------------------------------------------------------------------

/// Build a page-context IIFE that evaluates to an ARRAY of all elements
/// matching a semantic selector. Semantics mirror
/// `extension/lib/selector.js#buildRoleMatcherAllScript`.
pub fn match_all_expression(selector: &SemanticSelector) -> String {
    let matcher = serde_json::to_string(&selector.matcher_json()).unwrap_or_default();
    format!(
        r#"(() => {{
      const ROLE_TAG_MAP = {{
        button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]'],
        link: ['a[href]', '[role="link"]'],
        textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
        checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]'],
        combobox: ['select', '[role="combobox"]'],
        listbox: ['select[multiple]', '[role="listbox"]'],
        menuitem: ['[role="menuitem"]'],
        option: ['option', '[role="option"]'],
        searchbox: ['input[type="search"]', '[role="searchbox"]'],
        slider: ['input[type="range"]', '[role="slider"]'],
        spinbutton: ['input[type="number"]', '[role="spinbutton"]'],
        switch: ['[role="switch"]'],
        tab: ['[role="tab"]'],
        treeitem: ['[role="treeitem"]'],
        heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
        img: ['img[alt]', '[role="img"]'],
        cell: ['td', '[role="cell"]', '[role="gridcell"]'],
        row: ['tr', '[role="row"]'],
        navigation: ['nav', '[role="navigation"]'],
        main: ['main', '[role="main"]'],
        region: ['section[aria-label]', '[role="region"]'],
        article: ['article', '[role="article"]'],
        clickable: ['[onclick]', '[tabindex]:not([tabindex="-1"])'],
        focusable: ['[tabindex]:not([tabindex="-1"])'],
      }};

      const matcher = {matcher};
      const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const stringMatches = (actual, expected) => {{
        const actualValue = normalize(actual);
        const expectedValue = normalize(expected);
        return matcher.exact
          ? actualValue === expectedValue
          : actualValue.toLocaleLowerCase().includes(expectedValue.toLocaleLowerCase());
      }};
      const isVisible = el =>
        el.tagName === 'BODY' || el.getClientRects().length > 0;
      const uniqueVisible = elements =>
        [...new Set(elements)].filter(isVisible);
      const labelledText = el => {{
        const labelledBy = el.getAttribute('aria-labelledby');
        if (!labelledBy) return '';
        return labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.textContent || '')
          .join(' ');
      }};
      const accessibleName = el => {{
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const labelled = labelledText(el);
        if (labelled) return labelled;
        if (el.id) {{
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) return label.textContent || '';
        }}
        return el.alt || el.value || el.title || el.placeholder || el.textContent || '';
      }};

      let matches = [];
      if (matcher.kind === 'role') {{
        const selectors = ROLE_TAG_MAP[matcher.role] || ['[role="' + matcher.role + '"]'];
        const candidates = uniqueVisible(
          selectors.flatMap(sel => [...document.querySelectorAll(sel)]),
        );
        matches = matcher.name === undefined
          ? candidates
          : candidates.filter(el => stringMatches(accessibleName(el), matcher.name));
      }} else if (matcher.kind === 'text') {{
        const candidates = uniqueVisible(document.querySelectorAll('body *'));
        matches = candidates.filter(el => {{
          if (!stringMatches(el.textContent, matcher.value)) return false;
          return ![...el.children].some(
            child => isVisible(child) && stringMatches(child.textContent, matcher.value),
          );
        }});
      }} else if (matcher.kind === 'label') {{
        const controls = [];
        for (const label of document.querySelectorAll('label')) {{
          if (!stringMatches(label.textContent, matcher.value)) continue;
          const control = label.control || label.querySelector('input, textarea, select, button');
          if (control) controls.push(control);
        }}
        for (const el of document.querySelectorAll('[aria-label], [aria-labelledby]')) {{
          if (stringMatches(accessibleName(el), matcher.value)) controls.push(el);
        }}
        matches = uniqueVisible(controls);
      }} else if (matcher.kind === 'placeholder') {{
        matches = uniqueVisible(document.querySelectorAll('[placeholder]'))
          .filter(el => stringMatches(el.getAttribute('placeholder'), matcher.value));
      }} else if (matcher.kind === 'testid') {{
        matches = uniqueVisible(document.querySelectorAll('[data-testid]'))
          .filter(el => stringMatches(el.getAttribute('data-testid'), matcher.value));
      }} else if (matcher.kind === 'alttext') {{
        matches = uniqueVisible(document.querySelectorAll('[alt]'))
          .filter(el => stringMatches(el.getAttribute('alt'), matcher.value));
      }} else if (matcher.kind === 'title') {{
        matches = uniqueVisible(document.querySelectorAll('[title]'))
          .filter(el => stringMatches(el.getAttribute('title'), matcher.value));
      }}

      return matches;
    }})()"#,
        matcher = matcher,
    )
}

/// Expression evaluating to the number of semantic matches.
pub fn count_expression(selector: &SemanticSelector) -> String {
    format!("{}.length", match_all_expression(selector))
}

/// Expression that evaluates to the matched ELEMENT on success or to a plain
/// STRING error message on failure. The caller inspects the RemoteObject type
/// to distinguish the two (elements come back as objects with subtype "node",
/// failures come back as type "string").
pub fn resolve_one_expression(selector: &SemanticSelector) -> String {
    let not_found = json_quote(&format!("No element found with {}", selector.describe()));
    format!(
        r#"(() => {{
      const matches = {all};
      if (matches.length === 0) return {not_found};
      const index = {nth};
      if (index >= matches.length) {{
        return 'Element index ' + index + ' out of range, found ' + matches.length + ' matches';
      }}
      return matches[index];
    }})()"#,
        all = match_all_expression(selector),
        not_found = not_found,
        nth = selector.nth.unwrap_or(0),
    )
}

/// Same success-or-string protocol for plain CSS selectors.
pub fn resolve_one_css_expression(css_selector: &str) -> String {
    let sel = json_quote(css_selector);
    let not_found = json_quote(&format!("Element not found: {}", css_selector));
    format!(
        r#"(() => {{
      const el = document.querySelector({sel});
      if (!el) return {not_found};
      return el;
    }})()"#,
        sel = sel,
        not_found = not_found,
    )
}

/// Build the resolve-one expression for any non-ref selector string
/// (semantic `aria=` payloads and plain CSS).
pub fn resolve_one_expression_for(selector: &str) -> Result<String, String> {
    match parse_semantic_selector(selector)? {
        Some(semantic) => Ok(resolve_one_expression(&semantic)),
        None => Ok(resolve_one_css_expression(selector)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_payload(json: &str) -> String {
        format!("{}{}", SEMANTIC_SELECTOR_PREFIX, percent_encode(json))
    }

    // -- parsing: happy paths ------------------------------------------------

    #[test]
    fn test_parse_role_selector_full() {
        let selector =
            encode_payload(r#"{"kind":"role","role":"button","name":"Submit","exact":true,"nth":2}"#);
        let parsed = parse_semantic_selector(&selector).unwrap().unwrap();
        assert_eq!(parsed.kind, SemanticKind::Role);
        assert_eq!(parsed.role.as_deref(), Some("button"));
        assert_eq!(parsed.name.as_deref(), Some("Submit"));
        assert_eq!(parsed.nth, Some(2));
        assert!(parsed.exact);
    }

    #[test]
    fn test_parse_role_selector_without_name() {
        let selector = encode_payload(r#"{"kind":"role","role":"textbox","exact":false}"#);
        let parsed = parse_semantic_selector(&selector).unwrap().unwrap();
        assert_eq!(parsed.role.as_deref(), Some("textbox"));
        assert_eq!(parsed.name, None);
        assert_eq!(parsed.nth, None);
        assert!(!parsed.exact);
    }

    #[test]
    fn test_parse_value_kinds() {
        for kind in ["text", "label", "placeholder", "testid"] {
            let selector =
                encode_payload(&format!(r#"{{"kind":"{}","value":"Sign in","exact":false}}"#, kind));
            let parsed = parse_semantic_selector(&selector).unwrap().unwrap();
            assert_eq!(parsed.kind.as_str(), kind);
            assert_eq!(parsed.value.as_deref(), Some("Sign in"));
        }
    }

    #[test]
    fn test_parse_matches_worker_api_encoding() {
        // Exactly what worker-api.ts semanticSelector() produces for
        // getByRole("button", { name: "Save & Continue" })
        let payload = serde_json::json!({
            "kind": "role",
            "role": "button",
            "name": "Save & Continue",
            "exact": false,
        });
        let encoded = encode_payload(&serde_json::to_string(&payload).unwrap());
        let parsed = parse_semantic_selector(&encoded).unwrap().unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Save & Continue"));
    }

    #[test]
    fn test_parse_unicode_value_roundtrip() {
        let original = SemanticSelector::by_value(SemanticKind::Text, "héllo — 世界", true).unwrap();
        let encoded = encode_semantic_selector(&original);
        let parsed = parse_semantic_selector(&encoded).unwrap().unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn test_encode_roundtrip_role() {
        let mut original = SemanticSelector::by_role("button", Some("Submit"), true).unwrap();
        original.nth = Some(3);
        let encoded = encode_semantic_selector(&original);
        assert!(encoded.starts_with("aria="));
        let parsed = parse_semantic_selector(&encoded).unwrap().unwrap();
        assert_eq!(parsed, original);
    }

    // -- parsing: passthrough ------------------------------------------------

    #[test]
    fn test_non_semantic_selectors_pass_through() {
        assert_eq!(parse_semantic_selector("#login .btn").unwrap(), None);
        assert_eq!(parse_semantic_selector("button[type=submit]").unwrap(), None);
        assert_eq!(parse_semantic_selector("@e1").unwrap(), None);
        assert_eq!(parse_semantic_selector("e12").unwrap(), None);
        // "aria" without "=" is CSS
        assert_eq!(parse_semantic_selector("[aria-label]").unwrap(), None);
    }

    // -- parsing: error paths ------------------------------------------------

    #[test]
    fn test_parse_empty_payload() {
        assert_eq!(
            parse_semantic_selector("aria=").unwrap_err(),
            "Semantic selector payload is empty"
        );
    }

    #[test]
    fn test_parse_bad_percent_encoding() {
        assert_eq!(
            parse_semantic_selector("aria=%ZZ").unwrap_err(),
            "Semantic selector payload is not valid percent-encoding"
        );
        assert_eq!(
            parse_semantic_selector("aria=%7").unwrap_err(),
            "Semantic selector payload is not valid percent-encoding"
        );
    }

    #[test]
    fn test_parse_bad_json() {
        assert_eq!(
            parse_semantic_selector("aria=not-json").unwrap_err(),
            "Semantic selector payload is not valid JSON"
        );
    }

    #[test]
    fn test_parse_non_object_payload() {
        assert_eq!(
            parse_semantic_selector(&encode_payload("[1,2]")).unwrap_err(),
            "Semantic selector payload must be a JSON object"
        );
    }

    #[test]
    fn test_parse_unsupported_kind() {
        assert_eq!(
            parse_semantic_selector(&encode_payload(r#"{"kind":"css","value":"x"}"#)).unwrap_err(),
            "Unsupported semantic selector kind: css"
        );
    }

    #[test]
    fn test_parse_missing_kind() {
        assert_eq!(
            parse_semantic_selector(&encode_payload(r#"{"value":"x"}"#)).unwrap_err(),
            "Semantic selector field 'kind' must be a non-empty string"
        );
    }

    #[test]
    fn test_parse_unknown_field_rejected() {
        let err = parse_semantic_selector(&encode_payload(
            r#"{"kind":"text","value":"x","css":"div"}"#,
        ))
        .unwrap_err();
        assert_eq!(err, "Unknown semantic selector field 'css' for kind 'text'");
        // "name" is only valid for role selectors
        let err = parse_semantic_selector(&encode_payload(
            r#"{"kind":"text","value":"x","name":"y"}"#,
        ))
        .unwrap_err();
        assert_eq!(err, "Unknown semantic selector field 'name' for kind 'text'");
    }

    #[test]
    fn test_parse_invalid_nth() {
        for payload in [
            r#"{"kind":"text","value":"x","nth":-1}"#,
            r#"{"kind":"text","value":"x","nth":1.5}"#,
            r#"{"kind":"text","value":"x","nth":10001}"#,
            r#"{"kind":"text","value":"x","nth":"2"}"#,
        ] {
            let err = parse_semantic_selector(&encode_payload(payload)).unwrap_err();
            assert_eq!(
                err,
                "Semantic selector field 'nth' must be an integer from 0 to 10000",
                "payload: {}",
                payload
            );
        }
    }

    #[test]
    fn test_parse_invalid_exact() {
        assert_eq!(
            parse_semantic_selector(&encode_payload(r#"{"kind":"text","value":"x","exact":"yes"}"#))
                .unwrap_err(),
            "Semantic selector field 'exact' must be a boolean"
        );
    }

    #[test]
    fn test_parse_invalid_role_format() {
        for role in ["Button", "1button", "button!", ""] {
            let payload = format!(r#"{{"kind":"role","role":{}}}"#, json_quote(role));
            let err = parse_semantic_selector(&encode_payload(&payload)).unwrap_err();
            assert!(
                err.contains("'role'"),
                "role {:?} should be rejected, got: {}",
                role,
                err
            );
        }
    }

    #[test]
    fn test_parse_value_too_long() {
        let long = "x".repeat(MAX_SEMANTIC_VALUE_LENGTH + 1);
        let payload = format!(r#"{{"kind":"text","value":"{}"}}"#, long);
        assert_eq!(
            parse_semantic_selector(&encode_payload(&payload)).unwrap_err(),
            format!(
                "Semantic selector field 'value' exceeds {} characters",
                MAX_SEMANTIC_VALUE_LENGTH
            )
        );
    }

    #[test]
    fn test_parse_selector_too_long() {
        let selector = format!("aria={}", "a".repeat(MAX_SEMANTIC_SELECTOR_LENGTH));
        assert_eq!(
            parse_semantic_selector(&selector).unwrap_err(),
            format!(
                "Semantic selector exceeds the {} character limit",
                MAX_SEMANTIC_SELECTOR_LENGTH
            )
        );
    }

    // -- JS generation --------------------------------------------------------

    #[test]
    fn test_match_all_expression_embeds_matcher_json() {
        let sel = SemanticSelector::by_role("button", Some("Submit"), true).unwrap();
        let js = match_all_expression(&sel);
        assert!(js.contains(r#""kind":"role""#));
        assert!(js.contains(r#""role":"button""#));
        assert!(js.contains(r#""name":"Submit""#));
        assert!(js.contains(r#""exact":true"#));
        assert!(js.contains("ROLE_TAG_MAP"));
        assert!(js.contains("accessibleName"));
        assert!(js.starts_with("(() => {"));
        assert!(js.ends_with("})()"));
    }

    #[test]
    fn test_match_all_expression_escapes_hostile_values() {
        // A value that would break out of a naive string splice must stay
        // inside the JSON literal.
        let sel = SemanticSelector::by_value(
            SemanticKind::Text,
            r#"'; alert(1); //</script>"#,
            false,
        )
        .unwrap();
        let js = match_all_expression(&sel);
        assert!(js.contains(r#""value":"'; alert(1); //</script>""#));
        // The raw (unquoted) payload must not appear outside the JSON string.
        assert!(!js.contains("\n'; alert(1);"));
    }

    #[test]
    fn test_resolve_one_expression_structure() {
        let mut sel = SemanticSelector::by_value(SemanticKind::Placeholder, "Email", false).unwrap();
        sel.nth = Some(4);
        let js = resolve_one_expression(&sel);
        assert!(js.contains("const index = 4;"));
        assert!(js.contains(r#"No element found with placeholder=\"Email\""#));
        assert!(js.contains("out of range"));
    }

    #[test]
    fn test_resolve_one_css_expression_structure() {
        let js = resolve_one_css_expression("#login > .btn");
        assert!(js.contains(r##"document.querySelector("#login > .btn")"##));
        assert!(js.contains("Element not found: #login > .btn"));
    }

    #[test]
    fn test_resolve_one_expression_for_routing() {
        // aria= routes to the semantic resolver
        let aria = encode_semantic_selector(
            &SemanticSelector::by_role("link", Some("Docs"), false).unwrap(),
        );
        let js = resolve_one_expression_for(&aria).unwrap();
        assert!(js.contains("ROLE_TAG_MAP"));
        // CSS routes to querySelector
        let js = resolve_one_expression_for(".card button").unwrap();
        assert!(js.contains("document.querySelector"));
        assert!(!js.contains("ROLE_TAG_MAP"));
        // malformed aria= is an error, not silently CSS
        assert!(resolve_one_expression_for("aria=%ZZ").is_err());
    }

    #[test]
    fn test_count_expression() {
        let sel = SemanticSelector::by_value(SemanticKind::TestId, "row", false).unwrap();
        let js = count_expression(&sel);
        assert!(js.ends_with(".length"));
    }

    #[test]
    fn test_describe_formats() {
        let role = SemanticSelector::by_role("button", Some("Submit"), false).unwrap();
        assert_eq!(role.describe(), r#"role="button" name="Submit""#);
        let bare = SemanticSelector::by_role("button", None, false).unwrap();
        assert_eq!(bare.describe(), r#"role="button""#);
        let text = SemanticSelector::by_value(SemanticKind::Text, "Sign in", false).unwrap();
        assert_eq!(text.describe(), r#"text="Sign in""#);
    }

    #[test]
    fn test_percent_decode_utf8() {
        assert_eq!(
            percent_decode("%E4%B8%96%E7%95%8C").as_deref(),
            Some("世界")
        );
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        // '+' passes through untouched, matching decodeURIComponent
        assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
        assert_eq!(percent_decode("%"), None);
        assert_eq!(percent_decode("%f"), None);
        // invalid UTF-8 after decoding
        assert_eq!(percent_decode("%FF"), None);
    }
}
