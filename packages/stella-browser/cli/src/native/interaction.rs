use serde_json::Value;

use super::cdp::client::CdpClient;
use super::cdp::types::*;
use super::element::{resolve_element_object_id, RefMap};

#[derive(Debug, Clone)]
pub struct ActionablePoint {
    pub object_id: String,
    pub x: f64,
    pub y: f64,
}

const ACTIONABILITY_TIMEOUT_MS: u64 = 2500;

const ACTIONABILITY_POLL_MS: u64 = 150;

const FILL_REPLACE_JS: &str = r#"async function(nextValue) {
    const el = this;
    el.focus();

    const tag = (el.tagName || '').toLowerCase();
    const inputType = tag === 'input' ? String(el.type || 'text').toLowerCase() : null;
    const editable = el.isContentEditable;
    let setter = null;
    if (tag === 'input' && typeof HTMLInputElement !== 'undefined') {
        setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || null;
    } else if (tag === 'textarea' && typeof HTMLTextAreaElement !== 'undefined') {
        setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set || null;
    }
    if (!setter && !editable && !('value' in el)) {
        return { ok: false, reason: 'not-editable', tag, inputType };
    }

    const dispatchInput = (type, init) => {
        try {
            return el.dispatchEvent(new InputEvent(type, init));
        } catch (_) {
            return el.dispatchEvent(new Event(type, {
                bubbles: init && init.bubbles,
                cancelable: init && init.cancelable,
            }));
        }
    };

    dispatchInput('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: nextValue,
        inputType: 'insertReplacementText',
    });

    if (editable) {
        el.textContent = nextValue;
    } else if (setter) {
        setter.call(el, nextValue);
    } else {
        el.value = nextValue;
    }

    dispatchInput('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: nextValue,
        inputType: 'insertReplacementText',
    });
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await Promise.resolve();
    const actual = String(editable ? (el.textContent || '') : (el.value ?? ''));
    return {
        ok: actual === String(nextValue),
        actualLength: [...actual].length,
        tag,
        inputType,
    };
}"#;

const ACTIONABILITY_CHECK_JS: &str = r#"function(requireHit) {
    const el = this;
    if (!el.isConnected) return { status: 'detached' };
    const doc = el.ownerDocument;
    const win = doc && doc.defaultView;
    if (!win) return { status: 'detached' };
    const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    const describeNode = node => {
        if (!node) return 'unknown';
        const parts = [node.tagName ? node.tagName.toLowerCase() : 'unknown'];
        if (node.id) parts.push('#' + node.id);
        const cls = typeof node.className === 'string'
            ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
            : [];
        if (cls.length) parts.push('.' + cls.join('.'));
        return parts.join('');
    };
    const composedParent = node => {
        if (!node) return null;
        if (node.parentElement) return node.parentElement;
        const root = node.getRootNode ? node.getRootNode() : null;
        if (root && root.host) return root.host;
        try { return root && root.defaultView ? root.defaultView.frameElement : null; }
        catch (_) { return null; }
    };
    const scrollableAncestor = () => {
        let node = composedParent(el);
        for (let depth = 0; node && depth < 32; depth += 1, node = composedParent(node)) {
            const nodeWin = node.ownerDocument && node.ownerDocument.defaultView;
            if (!nodeWin) continue;
            const s = nodeWin.getComputedStyle(node);
            const overflowY = s.overflowY || s.overflow;
            const overflowX = s.overflowX || s.overflow;
            if ((/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) ||
                (/(auto|scroll|overlay)/.test(overflowX) && node.scrollWidth > node.clientWidth)) {
                return node;
            }
        }
        return null;
    };
    const scrollNestedContainers = () => {
        const chain = [];
        let node = composedParent(el);
        for (let depth = 0; node && depth < 32; depth += 1, node = composedParent(node)) {
            const nodeWin = node.ownerDocument && node.ownerDocument.defaultView;
            if (!nodeWin) continue;
            const s = nodeWin.getComputedStyle(node);
            const overflowY = s.overflowY || s.overflow;
            const overflowX = s.overflowX || s.overflow;
            if ((/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) ||
                (/(auto|scroll|overlay)/.test(overflowX) && node.scrollWidth > node.clientWidth)) {
                chain.push(node);
            }
        }
        for (const container of chain) {
            const er = el.getBoundingClientRect();
            const cr = container.getBoundingClientRect();
            if (er.top < cr.top) container.scrollTop -= cr.top - er.top;
            else if (er.bottom > cr.bottom) container.scrollTop += er.bottom - cr.bottom;
            if (er.left < cr.left) container.scrollLeft -= cr.left - er.left;
            else if (er.right > cr.right) container.scrollLeft += er.right - cr.right;
        }
    };
    const diagnostics = () => {
        const r = el.getBoundingClientRect();
        const scroll = scrollableAncestor();
        return {
            rect: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
            viewport: {
                width: win.innerWidth || doc.documentElement.clientWidth,
                height: win.innerHeight || doc.documentElement.clientHeight,
            },
            scrollContainer: scroll ? {
                node: describeNode(scroll),
                scrollTop: round(scroll.scrollTop),
                scrollLeft: round(scroll.scrollLeft),
                clientWidth: scroll.clientWidth,
                clientHeight: scroll.clientHeight,
                scrollWidth: scroll.scrollWidth,
                scrollHeight: scroll.scrollHeight,
            } : null,
        };
    };
    const fail = (status, extra = {}) => ({ status, ...diagnostics(), ...extra });
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return fail('hidden');
    }
    if (parseFloat(style.opacity) === 0) return fail('transparent');
    if (requireHit && (el.disabled === true || el.getAttribute('aria-disabled') === 'true')) {
        return fail('disabled');
    }
    if (requireHit && style.pointerEvents === 'none') return fail('pointer-events-none');
    let rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return fail('zero-size');
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;

    if (rect.top < 0 || rect.left < 0 || rect.bottom > vh || rect.right > vw) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        scrollNestedContainers();
        rect = el.getBoundingClientRect();
    }
    let cx = rect.left + rect.width / 2;
    let cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        scrollNestedContainers();
    }

    const localPoint = () => {
        const r = el.getBoundingClientRect();
        const left = Math.max(r.left, 0);
        const top = Math.max(r.top, 0);
        const right = Math.min(r.right, vw);
        const bottom = Math.min(r.bottom, vh);
        if (right - left <= 0 || bottom - top <= 0) return null;
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
    };

    const toTop = (x, y) => {
        let w = win;
        for (let depth = 0; depth < 16 && w && w !== w.parent; depth += 1) {
            let frame = null;
            try { frame = w.frameElement; } catch (e) { frame = null; }
            if (!frame) return null;
            const fr = frame.getBoundingClientRect();
            x += fr.left + frame.clientLeft;
            y += fr.top + frame.clientTop;
            w = frame.ownerDocument && frame.ownerDocument.defaultView;
        }
        return w ? { x: x, y: y, win: w } : null;
    };
    let lp = localPoint();
    if (!lp) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        scrollNestedContainers();
        lp = localPoint();
    }
    if (!lp) return fail('offscreen');
    let point = toTop(lp.x, lp.y);
    if (!point) return fail('cross-origin-frame');
    const inTopViewport = p => {
        const tw = p.win.innerWidth || p.win.document.documentElement.clientWidth;
        const th = p.win.innerHeight || p.win.document.documentElement.clientHeight;
        return p.x >= 0 && p.y >= 0 && p.x < tw && p.y < th;
    };

    if (win !== point.win && !inTopViewport(point)) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        scrollNestedContainers();
        lp = localPoint();
        if (!lp) return fail('offscreen');
        point = toTop(lp.x, lp.y);
        if (!point) return fail('cross-origin-frame');
        if (!inTopViewport(point)) return fail('offscreen', {
            point: { x: round(point.x), y: round(point.y) },
            topViewport: {
                width: point.win.innerWidth || point.win.document.documentElement.clientWidth,
                height: point.win.innerHeight || point.win.document.documentElement.clientHeight,
            },
        });
    }
    if (!requireHit) return { status: 'ok', x: point.x, y: point.y };
    const describeHit = describeNode;
    let hit = doc.elementFromPoint(lp.x, lp.y);

    while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(lp.x, lp.y);
        if (!inner || inner === hit) break;
        hit = inner;
    }
    if (!hit) return fail('covered', { by: 'unknown element', x: round(point.x), y: round(point.y) });
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

        const label = hit.closest ? hit.closest('label') : null;
        if (label && label.control === el) related = true;
        const ownLabel = el.closest ? el.closest('label') : null;
        if (ownLabel && (ownLabel === hit || ownLabel.contains(hit))) related = true;
    }
    if (!related) return fail('covered', {
        by: describeHit(hit),
        x: round(point.x),
        y: round(point.y),
    });

    let w = win;
    let px = lp.x;
    let py = lp.y;
    for (let depth = 0; depth < 16 && w && w !== w.parent; depth += 1) {
        let frame = null;
        try { frame = w.frameElement; } catch (e) { frame = null; }
        if (!frame) return fail('cross-origin-frame');
        const fr = frame.getBoundingClientRect();
        px += fr.left + frame.clientLeft;
        py += fr.top + frame.clientTop;
        const parentDoc = frame.ownerDocument;
        if (!parentDoc) return fail('cross-origin-frame');
        let parentHit = parentDoc.elementFromPoint(px, py);
        while (parentHit && parentHit.shadowRoot) {
            const inner = parentHit.shadowRoot.elementFromPoint(px, py);
            if (!inner || inner === parentHit) break;
            parentHit = inner;
        }
        if (!parentHit) return fail('offscreen', { x: round(point.x), y: round(point.y) });
        if (parentHit !== frame && !parentHit.contains(frame) && !frame.contains(parentHit)) {
            return fail('covered', {
                by: describeHit(parentHit),
                x: round(point.x),
                y: round(point.y),
            });
        }
        w = parentDoc.defaultView;
    }
    return { status: 'ok', x: point.x, y: point.y };
}"#;

fn actionability_diagnostic_suffix(details: Option<&Value>) -> String {
    let Some(details) = details else {
        return String::new();
    };
    let mut fields = Vec::new();
    if let Some(rect) = details.get("rect") {
        fields.push(format!(
            "rect=({},{} {}x{})",
            rect.get("x").unwrap_or(&Value::Null),
            rect.get("y").unwrap_or(&Value::Null),
            rect.get("width").unwrap_or(&Value::Null),
            rect.get("height").unwrap_or(&Value::Null),
        ));
    }
    if let Some(viewport) = details.get("viewport") {
        fields.push(format!(
            "viewport={}x{}",
            viewport.get("width").unwrap_or(&Value::Null),
            viewport.get("height").unwrap_or(&Value::Null),
        ));
    }
    if let Some(point_x) = details.get("x") {
        fields.push(format!(
            "click_point=({}, {})",
            point_x,
            details.get("y").unwrap_or(&Value::Null),
        ));
    }
    if let Some(scroll) = details.get("scrollContainer").filter(|v| !v.is_null()) {
        fields.push(format!(
            "scroll_container={} offset=({}, {}) client={}x{} scroll={}x{}",
            scroll
                .get("node")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            scroll.get("scrollLeft").unwrap_or(&Value::Null),
            scroll.get("scrollTop").unwrap_or(&Value::Null),
            scroll.get("clientWidth").unwrap_or(&Value::Null),
            scroll.get("clientHeight").unwrap_or(&Value::Null),
            scroll.get("scrollWidth").unwrap_or(&Value::Null),
            scroll.get("scrollHeight").unwrap_or(&Value::Null),
        ));
    }
    if fields.is_empty() {
        String::new()
    } else {
        format!(" [{}]", fields.join("; "))
    }
}

fn actionability_failure_message(
    status: &str,
    by: Option<&str>,
    selector: &str,
    details: Option<&Value>,
) -> String {
    let base = match status {
        "detached" => format!("Element is no longer attached to the DOM: {}", selector),
        "hidden" => format!(
            "Element found but not visible (display: none or visibility: hidden): {}",
            selector
        ),
        "transparent" => format!("Element found but not visible (opacity: 0): {}", selector),
        "disabled" => format!("Element found but disabled: {}", selector),
        "pointer-events-none" => format!(
            "Element found but cannot receive pointer input (pointer-events: none): {}",
            selector
        ),
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
        "cross-origin-frame" => format!(
            "Element is inside a cross-origin iframe; its coordinates cannot be translated to the top viewport: {}",
            selector
        ),
        other => format!("Element is not actionable ({}): {}", other, selector),
    };
    format!("{}{}", base, actionability_diagnostic_suffix(details))
}

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
        Some(&value),
    )))
}

pub async fn wait_for_actionable(
    client: &CdpClient,
    session_id: &str,
    ref_map: &RefMap,
    selector_or_ref: &str,
    require_hit: bool,
) -> Result<ActionablePoint, String> {
    let deadline =
        tokio::time::Instant::now() + tokio::time::Duration::from_millis(ACTIONABILITY_TIMEOUT_MS);
    let mut last_error: String;

    loop {
        match actionability_check_once(client, session_id, ref_map, selector_or_ref, require_hit)
            .await
        {
            Ok(Ok(point)) => return Ok(point),
            Ok(Err(not_actionable)) => last_error = not_actionable,

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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
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

    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
    let object_id = point.object_id;

    let result: EvaluateResult = client
        .send_command_typed(
            "Runtime.callFunctionOn",
            &CallFunctionOnParams {
                function_declaration: FILL_REPLACE_JS.to_string(),
                object_id: Some(object_id),
                arguments: Some(vec![CallArgument {
                    value: Some(Value::String(value.to_string())),
                    object_id: None,
                }]),
                return_by_value: Some(true),
                await_promise: Some(true),
            },
            Some(session_id),
        )
        .await?;

    let outcome = result.result.value.unwrap_or(Value::Null);
    if !outcome.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let reason = outcome
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("value-mismatch");
        let tag = outcome
            .get("tag")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let input_type = outcome
            .get("inputType")
            .and_then(Value::as_str)
            .unwrap_or("n/a");
        let actual_length = outcome
            .get("actualLength")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "Fill did not replace the element value (reason={}, tag={}, input_type={}, expected_chars={}, actual_chars={}): {}",
            reason,
            tag,
            input_type,
            value.chars().count(),
            actual_length,
            selector_or_ref
        ));
    }

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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
    let object_id = point.object_id;

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

pub async fn press_key(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let combo = parse_key_combo(key)?;
    dispatch_key_combo(client, session_id, &combo).await
}

pub async fn key_down(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let info = resolve_single_key(key)?;
    dispatch_key_event(client, session_id, "keyDown", &info, 0, true).await
}

pub async fn key_up(client: &CdpClient, session_id: &str, key: &str) -> Result<(), String> {
    let info = resolve_single_key(key)?;
    dispatch_key_event(client, session_id, "keyUp", &info, 0, false).await
}

async fn dispatch_key_event(
    client: &CdpClient,
    session_id: &str,
    event_type: &str,
    info: &KeyInfo,
    modifiers: i32,
    include_text: bool,
) -> Result<(), String> {
    let text = if include_text {
        info.text.clone()
    } else {
        None
    };
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
    dispatch_key_event(
        client,
        session_id,
        "keyDown",
        &combo.key,
        combo.modifiers,
        true,
    )
    .await?;
    dispatch_key_event(
        client,
        session_id,
        "keyUp",
        &combo.key,
        combo.modifiers,
        false,
    )
    .await?;
    for (info, bit) in combo.modifier_keys.iter().rev() {
        held &= !bit;
        dispatch_key_event(client, session_id, "keyUp", info, held, false).await?;
    }
    Ok(())
}

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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;
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

                if !super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    js_click_checkbox(client, session_id, ref_map, selector_or_ref).await?;
                }
            }
            Err(click_error) => {

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

                if super::element::is_element_checked(client, session_id, ref_map, selector_or_ref)
                    .await?
                {
                    js_click_checkbox(client, session_id, ref_map, selector_or_ref).await?;
                }
            }
            Err(click_error) => {

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

            if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
                el.click();
                return;
            }

            var label = tag === 'LABEL' ? el : (el.closest && el.closest('label'));
            if (label && label.tagName && label.tagName.toUpperCase() === 'LABEL' && label.control) {
                label.control.click();
                return;
            }

            var input = el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"]');
            if (input) {
                input.click();
                return;
            }

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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, false).await?;

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
    let point = wait_for_actionable(client, session_id, ref_map, selector_or_ref, true).await?;
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

fn punctuation_key_info(ch: char) -> (&'static str, i32) {
    match ch {

        ';' | ':' => ("Semicolon", 186),

        '=' | '+' => ("Equal", 187),

        ',' | '<' => ("Comma", 188),

        '-' | '_' => ("Minus", 189),

        '.' | '>' => ("Period", 190),

        '/' | '?' => ("Slash", 191),

        '`' | '~' => ("Backquote", 192),

        '[' | '{' => ("BracketLeft", 219),

        '\\' | '|' => ("Backslash", 220),

        ']' | '}' => ("BracketRight", 221),

        '\'' | '"' => ("Quote", 222),
        _ => ("", 0),
    }
}

fn named_key_info(key: &str) -> (String, String, i32) {
    match resolve_single_key(key) {
        Ok(info) => (info.key, info.code, info.key_code),

        Err(_) => (key.to_string(), key.to_string(), 0),
    }
}

pub const MODIFIER_ALT: i32 = 1;
pub const MODIFIER_CTRL: i32 = 2;
pub const MODIFIER_META: i32 = 4;
pub const MODIFIER_SHIFT: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub key: String,
    pub code: String,
    pub key_code: i32,
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {

    pub modifier_keys: Vec<(KeyInfo, i32)>,

    pub modifiers: i32,

    pub key: KeyInfo,
}

fn modifier_bit(name: &str) -> Option<i32> {
    match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Some(MODIFIER_CTRL),
        "shift" => Some(MODIFIER_SHIFT),
        "alt" | "option" => Some(MODIFIER_ALT),
        "meta" | "cmd" | "command" => Some(MODIFIER_META),
        _ => None,
    }
}

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

    #[test]
    fn test_char_to_key_info_matches_playwright_layout() {

        let cases: &[(char, &str, i32)] = &[

            ('a', "KeyA", 65),
            ('z', "KeyZ", 90),
            ('A', "KeyA", 65),

            ('0', "Digit0", 48),
            ('9', "Digit9", 57),

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

            if !ch.is_control() {
                assert_eq!(key, ch.to_string(), "char {:?}: key mismatch", ch);
            }
        }
    }

    #[test]
    fn test_period_is_not_vk_delete() {
        let (_, _, vk) = char_to_key_info('.');
        assert_ne!(
            vk, 46,
            "Period must not use VK code 46 (VK_DELETE); expected 190 (VK_OEM_PERIOD)"
        );
        assert_eq!(vk, 190);
    }

    #[test]
    fn test_actionability_failure_messages() {
        assert_eq!(
            actionability_failure_message("zero-size", None, "#a", None),
            "Element found but has zero size: #a"
        );
        assert_eq!(
            actionability_failure_message("hidden", None, "#a", None),
            "Element found but not visible (display: none or visibility: hidden): #a"
        );
        assert_eq!(
            actionability_failure_message("transparent", None, "#a", None),
            "Element found but not visible (opacity: 0): #a"
        );
        assert_eq!(
            actionability_failure_message("disabled", None, "#a", None),
            "Element found but disabled: #a"
        );
        assert_eq!(
            actionability_failure_message("pointer-events-none", None, "#a", None),
            "Element found but cannot receive pointer input (pointer-events: none): #a"
        );
        assert_eq!(
            actionability_failure_message("covered", Some("div.overlay"), "#a", None),
            "Element found but covered by <div.overlay> at its click point: #a"
        );
        assert_eq!(
            actionability_failure_message("covered", None, "#a", None),
            "Element found but covered by <unknown element> at its click point: #a"
        );
        assert_eq!(
            actionability_failure_message("detached", None, "@e3", None),
            "Element is no longer attached to the DOM: @e3"
        );
        assert_eq!(
            actionability_failure_message("offscreen", None, "#a", None),
            "Element found but could not be scrolled into the viewport: #a"
        );
        assert_eq!(
            actionability_failure_message("cross-origin-frame", None, "#a", None),
            "Element is inside a cross-origin iframe; its coordinates cannot be translated to the top viewport: #a"
        );
        assert_eq!(
            actionability_failure_message("weird", None, "#a", None),
            "Element is not actionable (weird): #a"
        );
    }

    #[test]
    fn test_actionability_failure_includes_geometry_and_scroll_context() {
        let details = serde_json::json!({
            "rect": { "x": 12, "y": 940, "width": 220, "height": 40 },
            "viewport": { "width": 1280, "height": 720 },
            "x": 122,
            "y": 700,
            "scrollContainer": {
                "node": "div.virtual-table",
                "scrollLeft": 0,
                "scrollTop": 480,
                "clientWidth": 900,
                "clientHeight": 520,
                "scrollWidth": 900,
                "scrollHeight": 3200
            }
        });
        let message = actionability_failure_message(
            "covered",
            Some("div.sticky-header"),
            "@e12",
            Some(&details),
        );
        assert!(message.contains("covered by <div.sticky-header>"));
        assert!(message.contains("rect=(12,940 220x40)"));
        assert!(message.contains("viewport=1280x720"));
        assert!(message.contains("click_point=(122, 700)"));
        assert!(message.contains("scroll_container=div.virtual-table"));
        assert!(message.contains("client=900x520"));
        assert!(message.contains("scroll=900x3200"));
    }

    #[test]
    fn test_actionability_check_js_structure() {
        assert!(ACTIONABILITY_CHECK_JS.starts_with("function(requireHit)"));
        assert!(ACTIONABILITY_CHECK_JS.contains("scrollIntoView"));
        assert!(ACTIONABILITY_CHECK_JS.contains("scrollNestedContainers"));
        assert!(ACTIONABILITY_CHECK_JS.contains("scrollContainer"));
        assert!(ACTIONABILITY_CHECK_JS.contains("getBoundingClientRect"));
        assert!(ACTIONABILITY_CHECK_JS.contains("elementFromPoint"));
        assert!(ACTIONABILITY_CHECK_JS.contains("getComputedStyle"));
        for status in [
            "'detached'",
            "'hidden'",
            "'transparent'",
            "'disabled'",
            "'pointer-events-none'",
            "'zero-size'",
            "'offscreen'",
            "'covered'",
            "'cross-origin-frame'",
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
    fn test_fill_uses_atomic_native_setter_and_verifies_the_result() {
        assert!(FILL_REPLACE_JS.starts_with("async function(nextValue)"));
        assert!(FILL_REPLACE_JS.contains("HTMLInputElement.prototype"));
        assert!(FILL_REPLACE_JS.contains("HTMLTextAreaElement.prototype"));
        assert!(FILL_REPLACE_JS.contains("insertReplacementText"));
        assert!(FILL_REPLACE_JS.contains("beforeinput"));
        assert!(FILL_REPLACE_JS.contains("new InputEvent"));
        assert!(FILL_REPLACE_JS.contains("new Event('change'"));
        assert!(FILL_REPLACE_JS.contains("actual === String(nextValue)"));
        assert!(FILL_REPLACE_JS.contains("actualLength: [...actual].length"));
        assert!(!FILL_REPLACE_JS.contains("actual,"));
    }

    #[test]
    fn test_actionability_check_js_is_frame_aware() {
        assert!(ACTIONABILITY_CHECK_JS.contains("el.ownerDocument"));
        assert!(ACTIONABILITY_CHECK_JS.contains("frameElement"));
        assert!(ACTIONABILITY_CHECK_JS.contains("root.defaultView"));
        assert!(ACTIONABILITY_CHECK_JS.contains("clientLeft"));
        assert!(ACTIONABILITY_CHECK_JS.contains("clientTop"));

        assert!(ACTIONABILITY_CHECK_JS.contains("win.getComputedStyle(el)"));
        assert!(ACTIONABILITY_CHECK_JS.contains("doc.elementFromPoint"));
        assert!(!ACTIONABILITY_CHECK_JS.contains("window.getComputedStyle"));
        assert!(!ACTIONABILITY_CHECK_JS.contains("document.elementFromPoint"));

        assert!(ACTIONABILITY_CHECK_JS.contains("parentDoc.elementFromPoint"));
    }

    #[test]
    fn test_actionability_bounds() {

        assert!(ACTIONABILITY_TIMEOUT_MS >= 2000 && ACTIONABILITY_TIMEOUT_MS <= 3000);
        assert!(ACTIONABILITY_POLL_MS >= 50 && ACTIONABILITY_POLL_MS <= 500);
    }

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

        assert_eq!(combo.key.text, None);
    }

    #[test]
    fn test_parse_combo_meta_shift_p() {
        let combo = parse_key_combo("Meta+Shift+P").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_META | MODIFIER_SHIFT);
        assert_eq!(combo.modifier_keys.len(), 2);

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

        let combo = parse_key_combo("Control++").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_CTRL);
        assert_eq!(combo.key.key, "+");
        assert_eq!(combo.key.code, "Equal");
        assert_eq!(combo.key.key_code, 187);

        let plus = parse_key_combo("+").unwrap();
        assert_eq!(plus.modifiers, 0);
        assert_eq!(plus.key.code, "Equal");
    }

    #[test]
    fn test_parse_combo_modifier_alone_and_dedupe() {

        let ctrl = parse_key_combo("Control").unwrap();
        assert_eq!(ctrl.modifiers, 0);
        assert_eq!(ctrl.key.key, "Control");
        assert_eq!(ctrl.key.code, "ControlLeft");
        assert_eq!(ctrl.key.key_code, 17);

        let combo = parse_key_combo("Control+Ctrl+a").unwrap();
        assert_eq!(combo.modifiers, MODIFIER_CTRL);
        assert_eq!(combo.modifier_keys.len(), 1);
    }

    #[test]
    fn test_parse_combo_errors() {

        let err = parse_key_combo("Bogus").unwrap_err();
        assert!(err.contains("Unknown key"), "got: {}", err);

        let err = parse_key_combo("Control+Fizz").unwrap_err();
        assert!(err.contains("Unknown key"), "got: {}", err);

        let err = parse_key_combo("Hyper+a").unwrap_err();
        assert!(err.contains("Unknown modifier"), "got: {}", err);

        let err = parse_key_combo("a+Control").unwrap_err();
        assert!(err.contains("Unknown modifier"), "got: {}", err);

        let err = parse_key_combo("Control+").unwrap_err();
        assert!(err.contains("missing key"), "got: {}", err);

        assert!(parse_key_combo("").is_err());
    }

    #[test]
    fn test_resolve_single_key_enrichment() {
        let a = resolve_single_key("a").unwrap();
        assert_eq!(
            (a.key.as_str(), a.code.as_str(), a.key_code),
            ("a", "KeyA", 65)
        );
        assert_eq!(a.text.as_deref(), Some("a"));

        let enter = resolve_single_key("Enter").unwrap();
        assert_eq!(enter.code, "Enter");
        assert_eq!(enter.key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));

        let f5 = resolve_single_key("F5").unwrap();
        assert_eq!(
            (f5.key.as_str(), f5.code.as_str(), f5.key_code),
            ("F5", "F5", 116)
        );

        let shift = resolve_single_key("Shift").unwrap();
        assert_eq!(shift.code, "ShiftLeft");
        assert_eq!(shift.key_code, 16);

        let euro = resolve_single_key("€").unwrap();
        assert_eq!(euro.key, "€");
        assert_eq!(euro.code, "");
        assert_eq!(euro.key_code, 0);
        assert_eq!(euro.text.as_deref(), Some("€"));

        assert!(resolve_single_key("NotAKey").is_err());
    }

    #[test]
    fn test_named_key_info_backcompat() {
        assert_eq!(
            named_key_info("enter"),
            ("Enter".to_string(), "Enter".to_string(), 13)
        );
        assert_eq!(
            named_key_info("c"),
            ("c".to_string(), "KeyC".to_string(), 67)
        );

        assert_eq!(
            named_key_info("Whatever"),
            ("Whatever".to_string(), "Whatever".to_string(), 0)
        );
    }
}
