use serde_json::Value;

use super::cdp::client::CdpClient;
use super::cdp::types::*;
use super::element::{resolve_element_object_id, RefMap};

// ---------------------------------------------------------------------------
// Actionability
// ---------------------------------------------------------------------------

/// Result of a successful actionability wait: a live objectId for the element
/// plus the viewport coordinates where pointer input should be dispatched.
#[derive(Debug, Clone)]
pub struct ActionablePoint {
    pub object_id: String,
    pub x: f64,
    pub y: f64,
}

/// Total bounded wait for an element to become actionable.
const ACTIONABILITY_TIMEOUT_MS: u64 = 2500;
/// Poll interval while waiting.
const ACTIONABILITY_POLL_MS: u64 = 150;

/// Page-side actionability probe. Runs against the resolved element
/// (`this`) and returns a JSON status object:
///   { status: 'ok', x, y }          — actionable; (x, y) is the click point
///   { status: 'detached' }          — element no longer in the DOM
///   { status: 'hidden' }            — display:none / visibility:hidden
///   { status: 'transparent' }       — opacity: 0
///   { status: 'zero-size' }         — zero-width/height bounding rect
///   { status: 'offscreen' }         — could not be scrolled into the viewport
///   { status: 'covered', by: 'tag#id.class' } — another element wins the
///     hit-test at the click point
///
/// It scrolls the element into view when needed (block: nearest first, then
/// center as a fallback) before measuring.
const ACTIONABILITY_CHECK_JS: &str = r#"function(requireHit) {
    const el = this;
    if (!el.isConnected) return { status: 'detached' };
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return { status: 'hidden' };
    }
    if (parseFloat(style.opacity) === 0) return { status: 'transparent' };
    let rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { status: 'zero-size' };
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // Minimal scroll if any part is outside the viewport (no-op when fully visible).
    if (rect.top < 0 || rect.left < 0 || rect.bottom > vh || rect.right > vw) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        rect = el.getBoundingClientRect();
    }
    let cx = rect.left + rect.width / 2;
    let cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        rect = el.getBoundingClientRect();
    }
    // Click point: center of the visible (viewport-clipped) part of the element.
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, vw);
    const bottom = Math.min(rect.bottom, vh);
    if (right - left <= 0 || bottom - top <= 0) return { status: 'offscreen' };
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    if (!requireHit) return { status: 'ok', x: x, y: y };
    let hit = document.elementFromPoint(x, y);
    // Descend through open shadow roots to the deepest hit target.
    while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
    }
    if (!hit) return { status: 'covered', by: 'unknown element' };
    let related = false;
    let node = hit;
    while (node) {
        if (node === el) { related = true; break; }
        const root = node.getRootNode ? node.getRootNode() : null;
        node = node.parentElement || (root && root.host ? root.host : null);
    }
    if (!related && el.contains(hit)) related = true;
    if (!related && hit.contains(el)) related = true;
    if (!related) {
        // A <label> hit that targets this control still delivers the click.
        const label = hit.closest ? hit.closest('label') : null;
        if (label && label.control === el) related = true;
        const ownLabel = el.closest ? el.closest('label') : null;
        if (ownLabel && (ownLabel === hit || ownLabel.contains(hit))) related = true;
    }
    if (related) return { status: 'ok', x: x, y: y };
    const parts = [hit.tagName ? hit.tagName.toLowerCase() : 'unknown'];
    if (hit.id) parts.push('#' + hit.id);
    const cls = typeof hit.className === 'string'
        ? hit.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
        : [];
    if (cls.length) parts.push('.' + cls.join('.'));
    return { status: 'covered', by: parts.join(''), x: x, y: y };
}"#;

fn actionability_failure_message(status: &str, by: Option<&str>, selector: &str) -> String {
    match status {
        "detached" => format!("Element is no longer attached to the DOM: {}", selector),
        "hidden" => format!(
            "Element found but not visible (display: none or visibility: hidden): {}",
            selector
        ),
        "transparent" => format!("Element found but not visible (opacity: 0): {}", selector),
        "zero-size" => format!("Element found but has zero size: {}", selector),
        "offscreen" => format!(
            "Element found but could not be scrolled into the viewport: {}",
            selector
        ),
        "covered" => format!(
            "Element found but covered by <{}> at its click point: {}",
            by.unwrap_or("unknown element"),
            selector
        ),
        other => format!("Element is not actionable ({}): {}", other, selector),
    }
}

/// Run one actionability probe against a freshly-resolved element.
/// Outer Err = resolution failure; inner Err = actionability failure message.
async fn actionability_check_once(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    require_hit: bool,
) -> Result<Result<ActionablePoint, String>, String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: ACTIONABILITY_CHECK_JS.to_string(),
                object_id: Some(object_id.clone()),
                arguments: Some(vec![CallArgument {
                    value: Some(serde_json::json!(require_hit)),
                    object_id: None,
                }]),
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    let value = result.result.value.unwrap_or(Value::Null);
    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    if status == "ok" {
        let x = value.get("x").and_then(|v| v.as_f64());
        let y = value.get("y").and_then(|v| v.as_f64());
        if let (Some(x), Some(y)) = (x, y) {
            return Ok(Ok(ActionablePoint { object_id, x, y }));
        }
    }

    let by = value.get("by").and_then(|v| v.as_str());
    Ok(Err(actionability_failure_message(
        status,
        by,
        selector_or_ref,
    )))
}

/// Shared pre-action step for all element-targeted input commands:
/// resolve element -> scroll into view if needed -> wait (bounded) for
/// visible + non-zero size -> compute click point -> (optionally) verify the
/// point actually hits the element via elementFromPoint.
///
/// `require_hit` should be true for pointer actions (click, hover, tap, drag
/// source) where an occluding overlay would swallow the event, and false for
/// focus-based actions (fill, type, select, focus) where occlusion is
/// irrelevant.
///
/// On failure returns a precise error describing WHY the element is not
/// actionable instead of silently dispatching input into the void.
pub async fn wait_for_actionable(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    require_hit: bool,
) -> Result<ActionablePoint, String> {
    let deadline = tokio::time::Instant::now()
        + tokio::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS);
    let mut last_error: String;

    loop {
        match actionability_check_once(client, session_id, ref_map, selector_or_ref, require_hit)
            .await
        {
            Ok(Ok(point)) => return Ok(point),
            Ok(Err(not_actionable)) => last_error = not_actionable,
            // Resolution failures (element not found yet, stale node) are
            // retried until the deadline: this gives every input command a
            // short auto-wait for elements that are about to appear.
            Err(resolve_error) => last_error = resolve_error,
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(last_error);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(ACTIONABILITY_POLL_MS)).await;
    }
}

pub async fn click(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    button: &str,
    click_count: i32,
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
    dispatch_click(client, session_id, point.x, point.y, button, click_count).await
}

pub async fn dblclick(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    click(client, session_id, ref_map, selector_or_ref, "left", 2).await
}

pub async fn hover(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mouseMoved".to_string(),
                x: point.x,
                y: point.y,
                button: None,
                buttons: None,
                click_count: None,
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(session_id),
        )
        .await?;
    Ok(())
}

pub async fn fill(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    value: &str,
) -> Result<(), String> {
    // Actionability: visible + non-zero size (occlusion does not matter for
    // focus-based input, so require_hit is false).
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
    let object_id = point.object_id;

    // Focus the element
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(object_id.clone()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    // Select all + delete to clear
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.select && this.select();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
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

    // Insert text
    client
        .send_command_typed::<_, Value>(
            "Input.insertText",
            &InsertTextParams {
                text: value.to_string(),
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn type_text(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    text: &str,
    clear: bool,
    delay_ms: Option<u64>,
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
    let object_id = point.object_id;

    // Focus
    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(object_id.clone()),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    if clear {
        client
            .send_command_typed::<_, Value>(
                "Runtime.callFunctionOn",
                &CallFunctionOnParams {
                    function_declaration: r#"function() {
                        this.select && this.select();
                        this.value = '';
                        this.dispatchEvent(new Event('input', { bubbles: true }));
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
    }

    let delay = delay_ms.unwrap_or(0);

    for ch in text.chars() {
        let text_str = ch.to_string();
        let (key, code, key_code) = char_to_key_info(ch);

        // Characters that have no US-keyboard mapping (key_code == 0 and empty
        // code) are inserted via `Input.insertText`, matching Playwright's
        // keyboard.type() fallback behaviour.  This handles emoji, CJK, and
        // other characters that don't correspond to a physical key.
        if key_code == 0 && code.is_empty() {
            client
                .send_command_typed::<_, Value>(
                    "Input.insertText",
                    &InsertTextParams { text: text_str },
                    Some(session_id),
                )
                .await?;
        } else {
            client
                .send_command_typed::<_, Value>(
                    "Input.dispatchKeyEvent",
                    &DispatchKeyEventParams {
                        event_type: "keyDown".to_string(),
                        key: Some(key.clone()),
                        code: Some(code.clone()),
                        text: Some(text_str.clone()),
                        unmodified_text: Some(text_str.clone()),
                        windows_virtual_key_code: Some(key_code),
                        native_virtual_key_code: Some(key_code),
                        modifiers: None,
                    },
                    Some(session_id),
                )
                .await?;

            client
                .send_command_typed::<_, Value>(
                    "Input.dispatchKeyEvent",
                    &DispatchKeyEventParams {
                        event_type: "keyUp".to_string(),
                        key: Some(key),
                        code: Some(code),
                        text: None,
                        unmodified_text: None,
                        windows_virtual_key_code: Some(key_code),
                        native_virtual_key_code: Some(key_code),
                        modifiers: None,
                    },
                    Some(session_id),
                )
                .await?;
        }

        if delay > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;
        }
    }

    Ok(())
}

/// Press a key or a modifier combination ("Enter", "Control+a",
/// "Meta+Shift+P"). Unknown key names and unknown modifiers are hard errors —
/// they must never silently dispatch a no-op event that reports success.
///
/// Combos are dispatched Playwright-style: keyDown for each modifier (with an
/// accumulating modifiers bitmask), keyDown+keyUp for the final key with the
/// full bitmask, then keyUp for the modifiers in reverse order.
pub async fn press_key(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let combo = parse_key_combo(key)?;
    dispatch_key_combo(client, session_id, &combo).await
}

/// Dispatch an enriched keyDown for a single key (no combo syntax). Errors on
/// unknown key names.
pub async fn key_down(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let info = resolve_single_key(key)?;
    dispatch_key_event(client, session_id, "keyDown", &info, 0, true).await
}

/// Dispatch an enriched keyUp for a single key (no combo syntax). Errors on
/// unknown key names.
pub async fn key_up(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let info = resolve_single_key(key)?;
    dispatch_key_event(client, session_id, "keyUp", &info, 0, false).await
}

/// Send one Input.dispatchKeyEvent with full key/code/vk/text enrichment.
/// `include_text` only matters for keyDown: CDP generates keypress/`keyCode`
/// semantics from the `text` field, so keyUp events never carry text.
async fn dispatch_key_event(
    client: &CdpClient,
    session_id: &str,
    event_type: &str,
    info: &KeyInfo,
    modifiers: i32,
    include_text: bool,
) -> Result<(), String> {
    let text = if include_text { info.text.clone() } else { None };
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchKeyEvent",
            &DispatchKeyEventParams {
                event_type: event_type.to_string(),
                key: Some(info.key.clone()),
                code: Some(info.code.clone()),
                text: text.clone(),
                unmodified_text: text,
                windows_virtual_key_code: Some(info.key_code),
                native_virtual_key_code: Some(info.key_code),
                modifiers: Some(modifiers),
            },
            Some(session_id),
        )
        .await?;
    Ok(())
}

/// Dispatch a parsed key combination as a full modifier press sequence.
async fn dispatch_key_combo(
    client: &CdpClient,
    session_id: &str,
    combo: &KeyCombo,
) -> Result<(), String> {
    let mut held = 0;
    for (info, bit) in &combo.modifier_keys {
        held |= bit;
        dispatch_key_event(client, session_id, "keyDown", info, held, false).await?;
    }
    dispatch_key_event(client, session_id, "keyDown", &combo.key, combo.modifiers, true).await?;
    dispatch_key_event(client, session_id, "keyUp", &combo.key, combo.modifiers, false).await?;
    for (info, bit) in combo.modifier_keys.iter().rev() {
        held &= !bit;
        dispatch_key_event(client, session_id, "keyUp", info, held, false).await?;
    }
    Ok(())
}

/// Dispatch a keyDown+keyUp sequence for `key` with an optional CDP modifier bitmask.
///
/// Modifier values follow the CDP `Input.dispatchKeyEvent` spec:
/// 1 = Alt, 2 = Control, 4 = Meta (Cmd), 8 = Shift.
///
/// Callers that need a platform-appropriate modifier (e.g. Cmd on macOS,
/// Ctrl elsewhere) must choose the value themselves -- see `cfg!(target_os)`.
pub async fn press_key_with_modifiers(
    client: &CdpClient,
    session_id: &str,
    key: &str,
    modifiers: Option<i32>,
) -> Result<(), String> {
    let (key_name, code, key_code) = named_key_info(key);

    client
        .send_command_typed::<_, Value>(
            "Input.dispatchKeyEvent",
            &DispatchKeyEventParams {
                event_type: "keyDown".to_string(),
                key: Some(key_name.clone()),
                code: Some(code.clone()),
                text: None,
                unmodified_text: None,
                windows_virtual_key_code: Some(key_code),
                native_virtual_key_code: Some(key_code),
                modifiers,
            },
            Some(session_id),
        )
        .await?;

    client
        .send_command_typed::<_, Value>(
            "Input.dispatchKeyEvent",
            &DispatchKeyEventParams {
                event_type: "keyUp".to_string(),
                key: Some(key_name),
                code: Some(code),
                text: None,
                unmodified_text: None,
                windows_virtual_key_code: Some(key_code),
                native_virtual_key_code: Some(key_code),
                modifiers,
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn scroll(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: Option<&str>,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    if let Some(sel) = selector_or_ref {
        let object_id = resolve_element_object_id(client, session_id, ref_map, sel).await?;
        let js = "function(dx, dy) { this.scrollBy(dx, dy); }".to_string();
        client
            .send_command_typed::<_, Value>(
                "Runtime.callFunctionOn",
                &CallFunctionOnParams {
                    function_declaration: js,
                    object_id: Some(object_id),
                    arguments: Some(vec![
                        CallArgument {
                            value: Some(serde_json::json!(delta_x)),
                            object_id: None,
                        },
                        CallArgument {
                            value: Some(serde_json::json!(delta_y)),
                            object_id: None,
                        },
                    ]),
                    return_by_value: Some(true),
                    await_promise: Some(false),
                },
                Some(session_id),
            )
            .await?;
    } else {
        let js = format!("window.scrollBy({}, {})", delta_x, delta_y);
        client
            .send_command_typed::<_, Value>(
                "Runtime.evaluate",
                &EvaluateParams {
                    expression: js,
                    return_by_value: Some(true),
                    await_promise: Some(false),
                },
                Some(session_id),
            )
            .await?;
    }
    Ok(())
}

pub async fn select_option(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    values: &[String],
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
    let object_id = point.object_id;

    let js = r#"function(vals) {
            const options = Array.from(this.options);
            for (const opt of options) {
                opt.selected = vals.includes(opt.value) || vals.includes(opt.textContent.trim());
            }
            this.dispatchEvent(new Event('change', { bubbles: true }));
        }"#
    .to_string();

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js,
                object_id: Some(object_id),
                arguments: Some(vec![CallArgument {
                    value: Some(serde_json::json!(values)),
                    object_id: None,
                }]),
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn check(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let is_checked =
        super::element::is_element_checked(client, session_id, ref_map, selector_or_ref).await?;
    if !is_checked {
        match click(client, session_id, ref_map, selector_or_ref, "left", 1).await {
            Ok(()) => {
                // Verify the click changed the state (Playwright parity:
                // _setChecked re-checks). If the coordinate-based click missed,
                // retry with a JS .click() on the associated input.
                if !super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    js_click_checkbox(client, session_id, ref_map, selector_or_ref).await?;
                }
            }
            Err(click_error) => {
                // Custom checkboxes commonly hide the native input (opacity: 0,
                // zero size, or covered by a styled span), which the
                // actionability layer rejects. Fall back to a DOM click and only
                // surface the original error if that fails to toggle the state.
                js_click_checkbox(client, session_id, ref_map, selector_or_ref)
                    .await
                    .map_err(|_| click_error.clone())?;
                if !super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    return Err(click_error);
                }
            }
        }
    }
    Ok(())
}

pub async fn uncheck(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let is_checked =
        super::element::is_element_checked(client, session_id, ref_map, selector_or_ref).await?;
    if is_checked {
        match click(client, session_id, ref_map, selector_or_ref, "left", 1).await {
            Ok(()) => {
                // Same verify-and-retry as check().
                if super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    js_click_checkbox(client, session_id, ref_map, selector_or_ref).await?;
                }
            }
            Err(click_error) => {
                // Same hidden-native-input fallback as check().
                js_click_checkbox(client, session_id, ref_map, selector_or_ref)
                    .await
                    .map_err(|_| click_error.clone())?;
                if super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    return Err(click_error);
                }
            }
        }
    }
    Ok(())
}

/// Fallback for when the coordinate-based CDP click did not toggle the
/// checkbox/radio state. This mirrors how Playwright dispatches clicks
/// through the DOM rather than via raw Input.dispatchMouseEvent coordinates.
///
/// Uses the same follow-label resolution as `is_element_checked`:
/// 1. If the element is a native input → `.click()` it directly.
/// 2. If the element is inside a `<label>` → `.click()` the label's `.control`.
/// 3. If the element has a nested `<input>` → `.click()` that input.
/// 4. Otherwise → `.click()` the element itself (handles ARIA role controls).
async fn js_click_checkbox(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let js = r#"function() {
            var el = this;
            var tag = el.tagName && el.tagName.toUpperCase();
            // 1. Native input — click it directly
            if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                el.click();
                return;
            }
            // 2. Follow label → control association
            var label = tag === 'LABEL' ? el : (el.closest && el.closest('label'));
            if (label && label.tagName && label.tagName.toUpperCase() === 'LABEL' && label.control) {
                label.control.click();
                return;
            }
            // 3. Nested native input
            var input = el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"]');
            if (input) {
                input.click();
                return;
            }
            // 4. ARIA role control — click the element itself
            el.click();
        }"#;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: js.to_string(),
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

pub async fn focus(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: "function() { this.focus(); }".to_string(),
                object_id: Some(point.object_id),
                arguments: None,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

pub async fn clear(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.focus();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                    this.dispatchEvent(new Event('change', { bubbles: true }));
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

    Ok(())
}

pub async fn select_all(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.focus();
                    if (typeof this.select === 'function') {
                        this.select();
                    } else {
                        const range = document.createRange();
                        range.selectNodeContents(this);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
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

    Ok(())
}

pub async fn scroll_into_view(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration:
                    "function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }"
                        .to_string(),
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

pub async fn dispatch_event(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    event_type: &str,
    event_init: Option<&Value>,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    let init_json = event_init
        .map(|v| serde_json::to_string(v).unwrap_or("{}".to_string()))
        .unwrap_or_else(|| "{ bubbles: true }".to_string());

    let js = format!(
        "function() {{ this.dispatchEvent(new Event({}, {})); }}",
        serde_json::to_string(event_type).unwrap_or_default(),
        init_json
    );

    client
        .send_command_typed::<_, Value>(
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

pub async fn highlight(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let object_id = resolve_element_object_id(client, session_id, ref_map, selector_or_ref).await?;

    client
        .send_command_typed::<_, Value>(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: r#"function() {
                    this.style.outline = '2px solid red';
                    this.style.outlineOffset = '2px';
                    const el = this;
                    setTimeout(() => {
                        el.style.outline = '';
                        el.style.outlineOffset = '';
                    }, 3000);
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

    Ok(())
}

pub async fn tap_touch(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
) -> Result<(), String> {
    let point =
        wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
    let (x, y) = (point.x, point.y);

    client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(serde_json::json!({
                "type": "touchStart",
                "touchPoints": [{ "x": x, "y": y }],
            })),
            Some(session_id),
        )
        .await?;

    client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(serde_json::json!({
                "type": "touchEnd",
                "touchPoints": [],
            })),
            Some(session_id),
        )
        .await?;

    Ok(())
}

async fn dispatch_click(
    client: &CdpClient,
    session_id: &str,
    x: f64,
    y: f64,
    button: &str,
    click_count: i32,
) -> Result<(), String> {
    // Move
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mouseMoved".to_string(),
                x,
                y,
                button: None,
                buttons: None,
                click_count: None,
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(session_id),
        )
        .await?;

    let button_value = match button {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    };

    // Press
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mousePressed".to_string(),
                x,
                y,
                button: Some(button.to_string()),
                buttons: Some(button_value),
                click_count: Some(click_count),
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(session_id),
        )
        .await?;

    // Release
    client
        .send_command_typed::<_, Value>(
            "Input.dispatchMouseEvent",
            &DispatchMouseEventParams {
                event_type: "mouseReleased".to_string(),
                x,
                y,
                button: Some(button.to_string()),
                buttons: Some(0),
                click_count: Some(click_count),
                delta_x: None,
                delta_y: None,
                modifiers: None,
            },
            Some(session_id),
        )
        .await?;

    Ok(())
}

fn char_to_key_info(ch: char) -> (String, String, i32) {
    match ch {
        '\n' | '\r' => ("Enter".to_string(), "Enter".to_string(), 13),
        '\t' => ("Tab".to_string(), "Tab".to_string(), 9),
        ' ' => (" ".to_string(), "Space".to_string(), 32),
        _ => {
            let key = ch.to_string();
            if ch.is_ascii_alphabetic() {
                // For letters the Windows VK code equals the uppercase ASCII value.
                let upper = ch.to_ascii_uppercase();
                let code = format!("Key{}", upper);
                let key_code = upper as i32;
                (key, code, key_code)
            } else if ch.is_ascii_digit() {
                let code = format!("Digit{}", ch);
                let key_code = ch as i32;
                (key, code, key_code)
            } else {
                let (code, key_code) = punctuation_key_info(ch);
                (key, code.to_string(), key_code)
            }
        }
    }
}

/// Return the DOM `KeyboardEvent.code` value and Windows virtual-key code for
/// a punctuation / symbol character assuming a US keyboard layout.
///
/// The Windows virtual-key codes (VK_OEM_*) differ from ASCII values for
/// punctuation.  Using the raw ASCII code would misidentify characters – e.g.
/// '.' (ASCII 46) collides with VK_DELETE (0x2E = 46), causing the period to
/// be swallowed.
fn punctuation_key_info(ch: char) -> (&'static str, i32) {
    match ch {
        // VK_OEM_1 (0xBA = 186) — ";:" key on US layout
        ';' | ':' => ("Semicolon", 186),
        // VK_OEM_PLUS (0xBB = 187) — "=+" key
        '=' | '+' => ("Equal", 187),
        // VK_OEM_COMMA (0xBC = 188) — ",<" key
        ',' | '<' => ("Comma", 188),
        // VK_OEM_MINUS (0xBD = 189) — "-_" key
        '-' | '_' => ("Minus", 189),
        // VK_OEM_PERIOD (0xBE = 190) — ".>" key
        '.' | '>' => ("Period", 190),
        // VK_OEM_2 (0xBF = 191) — "/?" key
        '/' | '?' => ("Slash", 191),
        // VK_OEM_3 (0xC0 = 192) — "`~" key
        '`' | '~' => ("Backquote", 192),
        // VK_OEM_4 (0xDB = 219) — "[{" key
        '[' | '{' => ("BracketLeft", 219),
        // VK_OEM_5 (0xDC = 220) — "\\|" key
        '\\' | '|' => ("Backslash", 220),
        // VK_OEM_6 (0xDD = 221) — "]}" key
        ']' | '}' => ("BracketRight", 221),
        // VK_OEM_7 (0xDE = 222) — "'\""" key
        '\'' | '"' => ("Quote", 222),
        _ => ("", 0),
    }
}

fn named_key_info(key: &str) -> (String, String, i32) {
    match resolve_single_key(key) {
        Ok(info) => (info.key, info.code, info.key_code),
        // Legacy catch-all, kept for press_key_with_modifiers callers only.
        Err(_) => (key.to_string(), key.to_string(), 0),
    }
}

// ---------------------------------------------------------------------------
// Keyboard: key resolution and modifier-combo parsing
// ---------------------------------------------------------------------------

/// CDP `Input.dispatchKeyEvent` modifier bits.
pub const MODIFIER_ALT: i32 = 1;
pub const MODIFIER_CTRL: i32 = 2;
pub const MODIFIER_META: i32 = 4;
pub const MODIFIER_SHIFT: i32 = 8;

/// Fully-resolved dispatch info for one key: DOM `key`, DOM `code`, Windows
/// virtual key code, and the text the key generates when pressed without
/// Ctrl/Alt/Meta (used for keyDown `text` so pages see keypress/`keyCode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub key: String,
    pub code: String,
    pub key_code: i32,
    pub text: Option<String>,
}

/// A parsed key combination such as "Control+Shift+P".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    /// Modifier keys to hold, in the order given (deduplicated), each with
    /// its CDP modifier bit.
    pub modifier_keys: Vec<(KeyInfo, i32)>,
    /// Full CDP modifiers bitmask for the final key events.
    pub modifiers: i32,
    /// The non-modifier key to press while the modifiers are held.
    pub key: KeyInfo,
}

/// Map a modifier name (case-insensitive) to its CDP modifier bit.
fn modifier_bit(name: &str) -> Option<i32> {
    match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Some(MODIFIER_CTRL),
        "shift" => Some(MODIFIER_SHIFT),
        "alt" | "option" => Some(MODIFIER_ALT),
        "meta" | "cmd" | "command" => Some(MODIFIER_META),
        _ => None,
    }
}

/// Dispatch info for a modifier key itself (left-side variants, matching
/// Playwright's US keyboard layout).
fn modifier_key_info(bit: i32) -> KeyInfo {
    let (key, code, key_code) = match bit {
        MODIFIER_ALT => ("Alt", "AltLeft", 18),
        MODIFIER_CTRL => ("Control", "ControlLeft", 17),
        MODIFIER_META => ("Meta", "MetaLeft", 91),
        _ => ("Shift", "ShiftLeft", 16),
    };
    KeyInfo {
        key: key.to_string(),
        code: code.to_string(),
        key_code,
        text: None,
    }
}

/// Resolve a single key name (named key or single character) to dispatch
/// info. Unknown multi-character names are an error — silently dispatching
/// key:"Bogus", vk:0 would be a no-op that reports success.
pub fn resolve_single_key(key: &str) -> Result<KeyInfo, String> {
    let named = |k: &str, c: &str, vk: i32, text: Option<&str>| -> KeyInfo {
        KeyInfo {
            key: k.to_string(),
            code: c.to_string(),
            key_code: vk,
            text: text.map(String::from),
        }
    };
    let lower = key.to_lowercase();
    let info = match lower.as_str() {
        "enter" | "return" => named("Enter", "Enter", 13, Some("\r")),
        "tab" => named("Tab", "Tab", 9, None),
        "escape" | "esc" => named("Escape", "Escape", 27, None),
        "backspace" => named("Backspace", "Backspace", 8, None),
        "delete" => named("Delete", "Delete", 46, None),
        "insert" => named("Insert", "Insert", 45, None),
        "arrowup" | "up" => named("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => named("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => named("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => named("ArrowRight", "ArrowRight", 39, None),
        "home" => named("Home", "Home", 36, None),
        "end" => named("End", "End", 35, None),
        "pageup" => named("PageUp", "PageUp", 33, None),
        "pagedown" => named("PageDown", "PageDown", 34, None),
        "space" | " " => named(" ", "Space", 32, Some(" ")),
        "capslock" => named("CapsLock", "CapsLock", 20, None),
        "control" | "ctrl" => modifier_key_info(MODIFIER_CTRL),
        "shift" => modifier_key_info(MODIFIER_SHIFT),
        "alt" | "option" => modifier_key_info(MODIFIER_ALT),
        "meta" | "cmd" | "command" => modifier_key_info(MODIFIER_META),
        "f1" => named("F1", "F1", 112, None),
        "f2" => named("F2", "F2", 113, None),
        "f3" => named("F3", "F3", 114, None),
        "f4" => named("F4", "F4", 115, None),
        "f5" => named("F5", "F5", 116, None),
        "f6" => named("F6", "F6", 117, None),
        "f7" => named("F7", "F7", 118, None),
        "f8" => named("F8", "F8", 119, None),
        "f9" => named("F9", "F9", 120, None),
        "f10" => named("F10", "F10", 121, None),
        "f11" => named("F11", "F11", 122, None),
        "f12" => named("F12", "F12", 123, None),
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                // Exactly one character: map through the US keyboard layout.
                // Characters without a physical key (emoji, CJK) still
                // dispatch with `text` so they insert correctly.
                (Some(ch), None) => {
                    let (k, code, vk) = char_to_key_info(ch);
                    KeyInfo {
                        key: k,
                        code,
                        key_code: vk,
                        text: Some(ch.to_string()),
                    }
                }
                _ => {
                    return Err(format!(
                        "Unknown key: '{}'. Use a named key (Enter, Tab, Escape, ArrowDown, F1-F12, ...), \
                         a single character, or a modifier combo like 'Control+a'.",
                        key
                    ));
                }
            }
        }
    };
    Ok(info)
}

/// Parse a key string that may contain modifiers, e.g. "Control+a",
/// "Meta+Shift+P", "Alt+ArrowLeft", or a bare key such as "Enter" or "+".
///
/// Split rules follow Playwright: '+' separates tokens, but a '+' at the
/// start of a token is the literal '+' key ("Control++" presses Ctrl and
/// the "+" key). Every token before the last must be a known modifier
/// (Control/Ctrl, Shift, Alt/Option, Meta/Cmd/Command), case-insensitive.
/// Ctrl/Alt/Meta suppress generated text on the final key (Shift does not).
pub fn parse_key_combo(input: &str) -> Result<KeyCombo, String> {
    if input.is_empty() {
        return Err("Key must be a non-empty string".to_string());
    }

    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in input.chars() {
        if ch == '+' && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);

    let key_part = parts.pop().unwrap_or_default();
    if key_part.is_empty() {
        return Err(format!(
            "Invalid key combination '{}': missing key after '+'",
            input
        ));
    }

    let mut modifiers = 0;
    let mut modifier_keys: Vec<(KeyInfo, i32)> = Vec::new();
    for part in &parts {
        let bit = modifier_bit(part).ok_or_else(|| {
            format!(
                "Unknown modifier '{}' in key combination '{}'. \
                 Supported modifiers: Control/Ctrl, Shift, Alt/Option, Meta/Cmd/Command.",
                part, input
            )
        })?;
        if modifiers & bit == 0 {
            modifiers |= bit;
            modifier_keys.push((modifier_key_info(bit), bit));
        }
    }

    let mut key = resolve_single_key(&key_part)?;
    // Ctrl/Alt/Meta suppress generated text (Playwright parity: only Shift
    // may be held for the key to still produce text).
    if modifiers & !MODIFIER_SHIFT != 0 {
        key.text = None;
    }

    Ok(KeyCombo {
        modifier_keys,
        modifiers,
        key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that `char_to_key_info` returns the correct (key, code,
    /// windowsVirtualKeyCode) triple for every character in Playwright's
    /// USKeyboardLayout.  The expected values below are taken verbatim from
    /// playwright-core/lib/server/usKeyboardLayout.js so that any drift from
    /// Playwright's behaviour is caught immediately.
    #[test]
    fn test_char_to_key_info_matches_playwright_layout() {
        // (character, expected_code, expected_vk_code)
        let cases: &[(char, &str, i32)] = &[
            // Letters – VK code must equal the uppercase ASCII value.
            ('a', "KeyA", 65),
            ('z', "KeyZ", 90),
            ('A', "KeyA", 65),
            // Digits
            ('0', "Digit0", 48),
            ('9', "Digit9", 57),
            // Punctuation – these are the values from Playwright's layout.
            // The bug that prompted this test sent '.' as VK 46 (= VK_DELETE).
            ('.', "Period", 190),
            (',', "Comma", 188),
            ('/', "Slash", 191),
            (';', "Semicolon", 186),
            ('\'', "Quote", 222),
            ('[', "BracketLeft", 219),
            (']', "BracketRight", 221),
            ('\\', "Backslash", 220),
            ('`', "Backquote", 192),
            ('-', "Minus", 189),
            ('=', "Equal", 187),
            // Shifted variants produced by the same physical keys.
            ('>', "Period", 190),
            ('<', "Comma", 188),
            ('?', "Slash", 191),
            (':', "Semicolon", 186),
            ('"', "Quote", 222),
            ('{', "BracketLeft", 219),
            ('}', "BracketRight", 221),
            ('|', "Backslash", 220),
            ('~', "Backquote", 192),
            ('_', "Minus", 189),
            ('+', "Equal", 187),
            // Whitespace / control
            (' ', "Space", 32),
            ('\n', "Enter", 13),
            ('\t', "Tab", 9),
        ];

        for &(ch, expected_code, expected_vk) in cases {
            let (key, code, vk) = char_to_key_info(ch);
            assert_eq!(
                code, expected_code,
                "char {:?}: expected code {:?}, got {:?}",
                ch, expected_code, code
            );
            assert_eq!(
                vk, expected_vk,
                "char {:?}: expected VK {}, got {} (ASCII would be {})",
                ch, expected_vk, vk, ch as i32
            );
            // key should be the character itself (except control chars).
            if !ch.is_control() {
                assert_eq!(key, ch.to_string(), "char {:?}: key mismatch", ch);
            }
        }
    }

    /// Regression test: period must NEVER map to VK 46 (VK_DELETE).
    #[test]
    fn test_period_is_not_vk_delete() {
        let (_, _, vk) = char_to_key_info('.');
        assert_ne!(
            vk, 46,
            "Period must not use VK code 46 (VK_DELETE); expected 190 (VK_OEM_PERIOD)"
        );
        assert_eq!(vk, 190);
    }

    // -- actionability -------------------------------------------------------

    #[test]
    fn test_actionability_failure_messages() {
        assert_eq!(
            actionability_failure_message("zero-size", None, "#a"),
            "Element found but has zero size: #a"
        );
        assert_eq!(
            actionability_failure_message("hidden", None, "#a"),
            "Element found but not visible (display: none or visibility: hidden): #a"
        );
        assert_eq!(
            actionability_failure_message("transparent", None, "#a"),
            "Element found but not visible (opacity: 0): #a"
        );
        assert_eq!(
            actionability_failure_message("covered", Some("div.overlay"), "#a"),
            "Element found but covered by <div.overlay> at its click point: #a"
        );
        assert_eq!(
            actionability_failure_message("covered", None, "#a"),
            "Element found but covered by <unknown element> at its click point: #a"
        );
        assert_eq!(
            actionability_failure_message("detached", None, "@e3"),
            "Element is no longer attached to the DOM: @e3"
        );
        assert_eq!(
            actionability_failure_message("offscreen", None, "#a"),
            "Element found but could not be scrolled into the viewport: #a"
        );
        assert_eq!(
            actionability_failure_message("weird", None, "#a"),
            "Element is not actionable (weird): #a"
        );
    }

    /// The injected probe must include every stage of the shared pre-action
    /// pipeline: scroll-into-view, size/visibility checks, and the
    /// elementFromPoint occlusion verification.
    #[test]
    fn test_actionability_check_js_structure() {
        assert!(ACTIONABILITY_CHECK_JS.starts_with("function(requireHit)"));
        assert!(ACTIONABILITY_CHECK_JS.contains("scrollIntoView"));
        assert!(ACTIONABILITY_CHECK_JS.contains("getBoundingClientRect"));
        assert!(ACTIONABILITY_CHECK_JS.contains("elementFromPoint"));
        assert!(ACTIONABILITY_CHECK_JS.contains("getComputedStyle"));
        for status in [
            "'detached'",
            "'hidden'",
            "'transparent'",
            "'zero-size'",
            "'offscreen'",
            "'covered'",
            "'ok'",
        ] {
            assert!(
                ACTIONABILITY_CHECK_JS.contains(status),
                "probe JS missing status {}",
                status
            );
        }
    }

    #[test]
    fn test_actionability_bounds() {
        // Bounded wait: a handful of short polls, roughly 2-3 seconds total.
        assert!(ACTIONABILITY_TIMEOUT_MS >= 2000 && ACTIONABILITY_TIMEOUT_MS <= 3000);
        assert!(ACTIONABILITY_POLL_MS >= 50 && ACTIONABILITY_POLL_MS <= 500);
    }

    /// Characters outside the US keyboard layout should return (key, "", 0)
    /// so that `type_text` falls back to `Input.insertText`.
    #[test]
    fn test_unmapped_chars_return_zero_keycode() {
        for ch in ['@', '#', '$', '%', '^', '&', '*', '(', ')', '€', '£', '你'] {
            let (key, code, vk) = char_to_key_info(ch);
            assert_eq!(
                code, "",
                "char {:?}: unmapped char should have empty code, got {:?}",
                ch, code
            );
            assert_eq!(
                vk, 0,
                "char {:?}: unmapped char should have VK 0, got {}",
                ch, vk
            );
            assert_eq!(key, ch.to_string());
        }
    }

    // -----------------------------------------------------------------------
    // parse_key_combo / resolve_single_key
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_combo_control_a() {
        let combo = parse_key_combo("Control+a").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_CTRL);
        assert_eq!(combo.modifier_keys.len(), 1);
        assert_eq!(combo.modifier_keys[0].0.key, "Control");
        assert_eq!(combo.modifier_keys[0].0.code, "ControlLeft");
        assert_eq!(combo.modifier_keys[0].0.key_code, 17);
        assert_eq!(combo.modifier_keys[0].1, MODIFIER_CTRL);
        assert_eq!(combo.key.key, "a");
        assert_eq!(combo.key.code, "KeyA");
        assert_eq!(combo.key.key_code, 65);
        // Ctrl suppresses generated text.
        assert_eq!(combo.key.text, None);
    }

    #[test]
    fn test_parse_combo_meta_shift_p() {
        let combo = parse_key_combo("Meta+Shift+P").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_META | MODIFIER_SHIFT);
        assert_eq!(combo.modifier_keys.len(), 2);
        // Order preserved: Meta first, then Shift.
        assert_eq!(combo.modifier_keys[0].0.key, "Meta");
        assert_eq!(combo.modifier_keys[0].0.key_code, 91);
        assert_eq!(combo.modifier_keys[1].0.key, "Shift");
        assert_eq!(combo.modifier_keys[1].0.key_code, 16);
        assert_eq!(combo.key.key, "P");
        assert_eq!(combo.key.code, "KeyP");
        assert_eq!(combo.key.key_code, 80);
        assert_eq!(combo.key.text, None);
    }

    #[test]
    fn test_parse_combo_alt_arrowleft() {
        let combo = parse_key_combo("Alt+ArrowLeft").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_ALT);
        assert_eq!(combo.key.key, "ArrowLeft");
        assert_eq!(combo.key.code, "ArrowLeft");
        assert_eq!(combo.key.key_code, 37);
    }

    #[test]
    fn test_parse_combo_case_and_alias_variants() {
        for input in ["ctrl+a", "CONTROL+a", "Ctrl+A", "control+a"] {
            let combo = parse_key_combo(input).unwrap();
            assert_eq!(combo.modifiers, MODIFIER_CTRL, "input {:?}", input);
            assert_eq!(combo.key.code, "KeyA", "input {:?}", input);
        }
        assert_eq!(parse_key_combo("Cmd+c").unwrap().modifiers, MODIFIER_META);
        assert_eq!(
            parse_key_combo("Command+c").unwrap().modifiers,
            MODIFIER_META
        );
        assert_eq!(
            parse_key_combo("Option+ArrowLeft").unwrap().modifiers,
            MODIFIER_ALT
        );
    }

    #[test]
    fn test_parse_single_keys() {
        let enter = parse_key_combo("Enter").unwrap();
        assert_eq!(enter.modifiers, 0);
        assert!(enter.modifier_keys.is_empty());
        assert_eq!(enter.key.key, "Enter");
        assert_eq!(enter.key.key_code, 13);
        // Enter generates text so pages see keypress events.
        assert_eq!(enter.key.text.as_deref(), Some("\r"));

        let a = parse_key_combo("a").unwrap();
        assert_eq!(a.key.code, "KeyA");
        assert_eq!(a.key.text.as_deref(), Some("a"));

        let esc = parse_key_combo("Escape").unwrap();
        assert_eq!(esc.key.key_code, 27);
        assert_eq!(esc.key.text, None);
    }

    #[test]
    fn test_shift_keeps_text_other_modifiers_suppress_it() {
        assert_eq!(
            parse_key_combo("Shift+a").unwrap().key.text.as_deref(),
            Some("a")
        );
        assert_eq!(parse_key_combo("Control+a").unwrap().key.text, None);
        assert_eq!(parse_key_combo("Alt+a").unwrap().key.text, None);
        assert_eq!(parse_key_combo("Meta+Enter").unwrap().key.text, None);
    }

    #[test]
    fn test_parse_combo_literal_plus_key() {
        // "Control++" = Ctrl held while pressing the "+" key.
        let combo = parse_key_combo("Control++").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_CTRL);
        assert_eq!(combo.key.key, "+");
        assert_eq!(combo.key.code, "Equal");
        assert_eq!(combo.key.key_code, 187);

        // Bare "+" is the plus key with no modifiers.
        let plus = parse_key_combo("+").unwrap();
        assert_eq!(plus.modifiers, 0);
        assert_eq!(plus.key.code, "Equal");
    }

    #[test]
    fn test_parse_combo_modifier_alone_and_dedupe() {
        // Pressing a modifier key by itself is valid.
        let ctrl = parse_key_combo("Control").unwrap();
        assert_eq!(ctrl.modifiers, 0);
        assert_eq!(ctrl.key.key, "Control");
        assert_eq!(ctrl.key.code, "ControlLeft");
        assert_eq!(ctrl.key.key_code, 17);

        // Repeated modifiers collapse to one held key.
        let combo = parse_key_combo("Control+Ctrl+a").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_CTRL);
        assert_eq!(combo.modifier_keys.len(), 1);
    }

    #[test]
    fn test_parse_combo_errors() {
        // Unknown final key must ERROR, never silently no-op.
        let err = parse_key_combo("Bogus").unwrap_err();
        assert!(err.contains("Unknown key"), "got: {}", err);

        let err = parse_key_combo("Control+Fizz").unwrap_err();
        assert!(err.contains("Unknown key"), "got: {}", err);

        // Unknown modifier.
        let err = parse_key_combo("Hyper+a").unwrap_err();
        assert!(err.contains("Unknown modifier"), "got: {}", err);

        // A non-modifier in a modifier position is an error too.
        let err = parse_key_combo("a+Control").unwrap_err();
        assert!(err.contains("Unknown modifier"), "got: {}", err);

        // Trailing '+' after a completed token.
        let err = parse_key_combo("Control+").unwrap_err();
        assert!(err.contains("missing key"), "got: {}", err);

        // Empty input.
        assert!(parse_key_combo("").is_err());
    }

    /// keydown/keyup enrichment: `resolve_single_key` must supply the
    /// key/code/vk/text that handle_keydown/handle_keyup dispatch, instead of
    /// the old bare {type, key} events.
    #[test]
    fn test_resolve_single_key_enrichment() {
        let a = resolve_single_key("a").unwrap();
        assert_eq!((a.key.as_str(), a.code.as_str(), a.key_code), ("a", "KeyA", 65));
        assert_eq!(a.text.as_deref(), Some("a"));

        let enter = resolve_single_key("Enter").unwrap();
        assert_eq!(enter.code, "Enter");
        assert_eq!(enter.key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));

        let f5 = resolve_single_key("F5").unwrap();
        assert_eq!((f5.key.as_str(), f5.code.as_str(), f5.key_code), ("F5", "F5", 116));

        let shift = resolve_single_key("Shift").unwrap();
        assert_eq!(shift.code, "ShiftLeft");
        assert_eq!(shift.key_code, 16);

        // Unmapped single characters still dispatch with text (insert path).
        let euro = resolve_single_key("€").unwrap();
        assert_eq!(euro.key, "€");
        assert_eq!(euro.code, "");
        assert_eq!(euro.key_code, 0);
        assert_eq!(euro.text.as_deref(), Some("€"));

        // Unknown multi-character names are hard errors.
        assert!(resolve_single_key("NotAKey").is_err());
    }

    /// The legacy helper keeps its lenient contract for
    /// press_key_with_modifiers callers, but now resolves named keys through
    /// the shared machinery.
    #[test]
    fn test_named_key_info_backcompat() {
        assert_eq!(
            named_key_info("enter"),
            ("Enter".to_string(), "Enter".to_string(), 13)
        );
        assert_eq!(named_key_info("c"), ("c".to_string(), "KeyC".to_string(), 67));
        // Unknown names keep the old passthrough shape.
        assert_eq!(
            named_key_info("Whatever"),
            ("Whatever".to_string(), "Whatever".to_string(), 0)
        );
    }
}
