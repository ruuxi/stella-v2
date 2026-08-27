use serde_json::{json, Value};

use super::actions::{execute_command, DaemonState};

fn assert_success(resp: &Value) {
    assert_eq!(
        resp.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "Expected success but got: {}",
        serde_json::to_string_pretty(resp).unwrap_or_default()
    );
}

fn get_data(resp: &Value) -> &Value {
    resp.get("data").expect("Missing 'data' in response")
}

#[tokio::test]
#[ignore]
async fn e2e_launch_navigate_evaluate_close() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["launched"], true);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(&json!({ "id": "3", "action": "url" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");

    let resp = execute_command(&json!({ "id": "4", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(
        &json!({ "id": "5", "action": "evaluate", "script": "1 + 2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], 3);

    let resp = execute_command(
        &json!({ "id": "6", "action": "evaluate", "script": "document.title" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Example Domain");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore]
async fn e2e_lightpanda_launch_can_open_page() {
    let lightpanda_bin = match std::env::var("LIGHTPANDA_BIN") {
        Ok(path) if !path.is_empty() => path,
        _ => return,
    };

    let mut state = DaemonState::new();

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(20),
        execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "engine": "lightpanda",
                "executablePath": lightpanda_bin,
            }),
            &mut state,
        ),
    )
    .await
    .expect("Lightpanda launch should not hang");

    assert_success(&resp);
    assert_eq!(get_data(&resp)["launched"], true);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(&json!({ "id": "3", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore]
async fn e2e_lightpanda_auto_launch_can_open_page() {
    let lightpanda_bin = match std::env::var("LIGHTPANDA_BIN") {
        Ok(path) if !path.is_empty() => path,
        _ => return,
    };

    let prev_engine = std::env::var("STELLA_BROWSER_ENGINE").ok();
    let prev_path = std::env::var("STELLA_BROWSER_EXECUTABLE_PATH").ok();
    std::env::set_var("STELLA_BROWSER_ENGINE", "lightpanda");
    std::env::set_var("STELLA_BROWSER_EXECUTABLE_PATH", &lightpanda_bin);

    let mut state = DaemonState::new();

    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(20),
        execute_command(
            &json!({ "id": "1", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        ),
    )
    .await
    .expect("Lightpanda auto-launch should not hang");

    match prev_engine {
        Some(value) => std::env::set_var("STELLA_BROWSER_ENGINE", value),
        None => std::env::remove_var("STELLA_BROWSER_ENGINE"),
    }
    match prev_path {
        Some(value) => std::env::set_var("STELLA_BROWSER_EXECUTABLE_PATH", value),
        None => std::env::remove_var("STELLA_BROWSER_EXECUTABLE_PATH"),
    }

    assert_success(&resp);
    assert_eq!(get_data(&resp)["url"], "https://example.com/");
    assert_eq!(get_data(&resp)["title"], "Example Domain");

    let resp = execute_command(&json!({ "id": "2", "action": "close" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closed"], true);
}

#[tokio::test]
#[ignore]
async fn e2e_snapshot_and_click_ref() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snapshot.contains("Example Domain"),
        "Snapshot should contain heading"
    );
    assert!(snapshot.contains("ref=e1"), "Snapshot should have ref e1");
    assert!(snapshot.contains("ref=e2"), "Snapshot should have ref e2");
    assert!(
        snapshot.contains("link"),
        "Snapshot should have a link element"
    );

    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "e2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    let resp = execute_command(&json!({ "id": "5", "action": "url" }), &mut state).await;
    assert_success(&resp);
    let url = get_data(&resp)["url"].as_str().unwrap();
    assert!(
        url.contains("iana.org"),
        "Should have navigated to iana.org, got: {}",
        url
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_screenshot() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "screenshot" }), &mut state).await;
    assert_success(&resp);
    let path = get_data(&resp)["path"].as_str().unwrap();
    assert!(path.ends_with(".png"), "Screenshot path should be .png");
    let metadata = std::fs::metadata(path).expect("Screenshot file should exist");
    assert!(
        metadata.len() > 1000,
        "Screenshot should be non-trivial size"
    );

    let tmp_path = std::env::temp_dir()
        .join("stella-browser-e2e-test-screenshot.png")
        .to_string_lossy()
        .to_string();
    let resp = execute_command(
        &json!({ "id": "4", "action": "screenshot", "path": tmp_path }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(std::path::Path::new(&tmp_path).exists());
    let _ = std::fs::remove_file(&tmp_path);

    let resp = execute_command(
        &json!({
            "id": "5",
            "action": "setcontent",
            "html": r##"
                <html><body>
                  <button onclick="document.getElementById('result').textContent = 'clicked'">Submit</button>
                  <a href="#">Home</a>
                  <div id="result"></div>
                </body></html>
            "##,
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "screenshot", "annotate": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let annotations = get_data(&resp)["annotations"]
        .as_array()
        .expect("Annotated screenshot should return annotations");
    assert!(
        !annotations.is_empty(),
        "Annotated screenshot should have at least one annotation"
    );

    let submit_ref = annotations
        .iter()
        .find(|ann| ann.get("name").and_then(|v| v.as_str()) == Some("Submit"))
        .and_then(|ann| ann.get("ref").and_then(|v| v.as_str()))
        .expect("Expected a Submit annotation");

    let resp = execute_command(
        &json!({
            "id": "7",
            "action": "evaluate",
            "script": "document.getElementById('__stella_browser_annotations__') === null"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], true);

    let resp = execute_command(
        &json!({ "id": "8", "action": "click", "selector": format!("@{}", submit_ref) }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "9",
            "action": "evaluate",
            "script": "document.getElementById('result').textContent"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "clicked");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_form_interaction() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<input id='name' type='text' placeholder='Name'>",
        "<input id='email' type='email'>",
        "<select id='color'><option value='red'>Red</option><option value='blue'>Blue</option></select>",
        "<input id='agree' type='checkbox'>",
        "<textarea id='bio'></textarea>",
        "<button id='submit'>Submit</button>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "10", "action": "fill", "selector": "#name", "value": "John Doe" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "11", "action": "evaluate", "script": "document.getElementById('name').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "John Doe");

    let resp = execute_command(
        &json!({ "id": "12", "action": "type", "selector": "#email", "text": "john@example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "13", "action": "evaluate", "script": "document.getElementById('email').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "john@example.com");

    let resp = execute_command(
        &json!({ "id": "14", "action": "select", "selector": "#color", "values": ["blue"] }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "15", "action": "evaluate", "script": "document.getElementById('color').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "blue");

    let resp = execute_command(
        &json!({ "id": "16", "action": "check", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "17", "action": "ischecked", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], true);

    let resp = execute_command(
        &json!({ "id": "18", "action": "uncheck", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "19", "action": "ischecked", "selector": "#agree" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(&json!({ "id": "20", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snap = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snap.contains("John Doe"),
        "Snapshot should show filled value"
    );
    assert!(snap.contains("textbox"), "Snapshot should show textbox");
    assert!(snap.contains("button"), "Snapshot should show button");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_navigation_history() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Page 1</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "data:text/html,<h1>Page 2</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "4", "action": "back" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 1");

    let resp = execute_command(&json!({ "id": "6", "action": "forward" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 2");

    let resp = execute_command(&json!({ "id": "8", "action": "reload" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "9", "action": "evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Page 2");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_cookies() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({
            "id": "3",
            "action": "cookies_set",
            "name": "test_cookie",
            "value": "hello123"
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "4", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    let found = cookies
        .iter()
        .any(|c| c["name"] == "test_cookie" && c["value"] == "hello123");
    assert!(found, "Should find the set cookie");

    let resp = execute_command(&json!({ "id": "5", "action": "cookies_clear" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "6", "action": "cookies_get" }), &mut state).await;
    assert_success(&resp);
    let cookies = get_data(&resp)["cookies"].as_array().unwrap();
    let found = cookies.iter().any(|c| c["name"] == "test_cookie");
    assert!(!found, "Cookie should be cleared");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_storage() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "storage_set", "type": "local", "key": "mykey", "value": "myvalue" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "storage_get", "type": "local", "key": "mykey" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "myvalue");

    let resp = execute_command(
        &json!({ "id": "5", "action": "storage_get", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["data"]["mykey"], "myvalue");

    let resp = execute_command(
        &json!({ "id": "6", "action": "storage_clear", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "storage_get", "type": "local" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = &get_data(&resp)["data"];
    assert!(
        data.as_object().map(|m| m.is_empty()).unwrap_or(true),
        "Storage should be empty after clear"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_tabs() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Tab 1</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0]["active"], true);

    let resp = execute_command(
        &json!({ "id": "4", "action": "tab_new", "url": "data:text/html,<h1>Tab 2</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["index"], 1);
    let new_tab_id = get_data(&resp)["tabId"].as_u64().unwrap();
    assert!(new_tab_id > 0);

    let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs[1]["active"], true);
    let first_tab_id = tabs[0]["tabId"].as_u64().unwrap();
    let second_tab_id = tabs[1]["tabId"].as_u64().unwrap();
    assert!(first_tab_id > 0);
    assert_eq!(second_tab_id, new_tab_id);
    assert_ne!(first_tab_id, second_tab_id);
    assert_eq!(get_data(&resp)["activeTabId"].as_u64(), Some(second_tab_id));

    let resp = execute_command(&json!({ "id": "5b", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs[0]["tabId"].as_u64(), Some(first_tab_id));
    assert_eq!(tabs[1]["tabId"].as_u64(), Some(second_tab_id));

    let resp = execute_command(
        &json!({ "id": "6", "action": "tab_switch", "tabId": first_tab_id }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["tabId"].as_u64(), Some(first_tab_id));

    let resp = execute_command(
        &json!({ "id": "7", "action": "evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Tab 1");

    let resp = execute_command(
        &json!({ "id": "8", "action": "tab_close", "tabId": second_tab_id }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closedTabId"].as_u64(), Some(second_tab_id));

    let resp = execute_command(&json!({ "id": "9", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_element_queries() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<p id='visible'>Hello World</p>",
        "<p id='hidden' style='display:none'>Hidden</p>",
        "<input id='enabled' value='test'>",
        "<input id='disabled' disabled value='nope'>",
        "<a id='link' href='https://example.com' data-testid='my-link'>Click me</a>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "isvisible", "selector": "#visible" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["visible"], true);

    let resp = execute_command(
        &json!({ "id": "4", "action": "isvisible", "selector": "#hidden" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["visible"], false);

    let resp = execute_command(
        &json!({ "id": "5", "action": "isenabled", "selector": "#enabled" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["enabled"], true);

    let resp = execute_command(
        &json!({ "id": "6", "action": "isenabled", "selector": "#disabled" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["enabled"], false);

    let resp = execute_command(
        &json!({ "id": "7", "action": "gettext", "selector": "#visible" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "Hello World");

    let resp = execute_command(
        &json!({ "id": "8", "action": "getattribute", "selector": "#link", "attribute": "href" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "https://example.com");

    let resp = execute_command(
        &json!({ "id": "9", "action": "getattribute", "selector": "#link", "attribute": "data-testid" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "my-link");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_wait() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<div id='target' style='display:none'>Appeared!</div>",
        "<script>setTimeout(() => document.getElementById('target').style.display='block', 500)</script>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "wait", "selector": "#target", "state": "visible", "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "wait", "text": "Appeared!", "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "5", "action": "wait", "timeout": 200 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(
        start.elapsed().as_millis() >= 150,
        "Timeout wait should sleep at least 150ms"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_viewport_scale_factor() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "about:blank" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "evaluate", "script": "window.devicePixelRatio" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let default_dpr = get_data(&resp)["result"].as_f64().unwrap();
    assert_eq!(default_dpr, 1.0, "Default devicePixelRatio should be 1");

    let resp = execute_command(
        &json!({ "id": "4", "action": "viewport", "width": 1920, "height": 1080, "deviceScaleFactor": 2.0 }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["width"], 1920);
    assert_eq!(get_data(&resp)["height"], 1080);
    assert_eq!(get_data(&resp)["deviceScaleFactor"], 2.0);

    let resp = execute_command(
        &json!({ "id": "5", "action": "evaluate", "script": "window.devicePixelRatio" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let new_dpr = get_data(&resp)["result"].as_f64().unwrap();
    assert_eq!(
        new_dpr, 2.0,
        "devicePixelRatio should be 2 after setting scale factor"
    );

    let resp = execute_command(
        &json!({ "id": "6", "action": "evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let css_width = get_data(&resp)["result"].as_i64().unwrap();
    assert_eq!(css_width, 1920, "CSS width should remain 1920 at 2x scale");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_viewport_emulation() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Viewport</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let initial_width = get_data(&resp)["result"].as_i64().unwrap();

    let resp = execute_command(
        &json!({ "id": "4", "action": "viewport", "width": 375, "height": 812, "deviceScaleFactor": 3.0, "mobile": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["width"], 375);
    assert_eq!(get_data(&resp)["height"], 812);
    assert_eq!(get_data(&resp)["mobile"], true);

    let resp = execute_command(&json!({ "id": "5", "action": "reload" }), &mut state).await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "evaluate", "script": "window.innerWidth" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let new_width = get_data(&resp)["result"].as_i64().unwrap();
    assert!(
        new_width != initial_width || new_width == 375,
        "Viewport should change from {} after setDeviceMetricsOverride (got {})",
        initial_width,
        new_width
    );

    let resp = execute_command(
        &json!({ "id": "5", "action": "user_agent", "userAgent": "TestBot/1.0" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "6", "action": "evaluate", "script": "navigator.userAgent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "TestBot/1.0");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_hover_scroll_press() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body style='height:3000px'>",
        "<button id='btn' onmouseover=\"this.textContent='hovered'\">Hover me</button>",
        "<input id='input' onkeydown=\"this.dataset.key=event.key\">",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "hover", "selector": "#btn" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "4", "action": "scroll", "y": 500 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "evaluate", "script": "window.scrollY" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let scroll_y = get_data(&resp)["result"].as_f64().unwrap();
    assert!(scroll_y > 0.0, "Should have scrolled down");

    let resp = execute_command(
        &json!({ "id": "6", "action": "press", "key": "Enter" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["pressed"], "Enter");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_state_management() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "storage_set", "type": "local", "key": "persist_key", "value": "persist_val" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let tmp_state = std::env::temp_dir()
        .join("stella-browser-e2e-state.json")
        .to_string_lossy()
        .to_string();
    let resp = execute_command(
        &json!({ "id": "4", "action": "state_save", "path": &tmp_state }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(std::path::Path::new(&tmp_state).exists());

    let resp = execute_command(
        &json!({ "id": "5", "action": "state_show", "path": &tmp_state }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let state_data = get_data(&resp);
    assert!(state_data.get("state").is_some());

    let resp = execute_command(&json!({ "id": "6", "action": "state_list" }), &mut state).await;
    assert_success(&resp);
    assert!(get_data(&resp)["files"].is_array());

    let _ = std::fs::remove_file(&tmp_state);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_domain_filter() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    state.domain_filter = Some(super::network::DomainFilter::new("example.com"));

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "3", "action": "navigate", "url": "https://blocked.com" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let error = resp["error"].as_str().unwrap();
    assert!(
        error.contains("blocked") || error.contains("not allowed"),
        "Should reject blocked domain, got: {}",
        error
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_diff_snapshot() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Hello</h1><p>World</p>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let baseline = get_data(&resp)["snapshot"].as_str().unwrap().to_string();

    let resp = execute_command(
        &json!({ "id": "4", "action": "evaluate", "script": "document.querySelector('h1').textContent = 'Changed'" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "5", "action": "diff_snapshot", "baseline": baseline }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["changed"], true, "Diff should detect the h1 change");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_phase8_commands() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",
        "<input id='a' value='original'>",
        "<input id='b' value='other'>",
        "<p class='item'>One</p>",
        "<p class='item'>Two</p>",
        "<p class='item'>Three</p>",
        "<div id='box' style='width:200px;height:100px;background:red'>Box</div>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "10", "action": "focus", "selector": "#a" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "11", "action": "clear", "selector": "#a" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "12", "action": "evaluate", "script": "document.getElementById('a').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "");

    let resp = execute_command(
        &json!({ "id": "13", "action": "setvalue", "selector": "#b", "value": "new-value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "14", "action": "inputvalue", "selector": "#b" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "new-value");

    let resp = execute_command(
        &json!({ "id": "15", "action": "count", "selector": ".item" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["count"], 3);

    let resp = execute_command(
        &json!({ "id": "16", "action": "boundingbox", "selector": "#box" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let bbox = get_data(&resp);
    assert_eq!(bbox["width"], 200.0);
    assert_eq!(bbox["height"], 100.0);
    assert!(bbox["x"].as_f64().is_some());
    assert!(bbox["y"].as_f64().is_some());

    let resp = execute_command(
        &json!({ "id": "17", "action": "innertext", "selector": "#box" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "Box");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_auto_launch() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "navigate", "url": "data:text/html,<h1>Auto</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(state.browser.is_some(), "Browser should be auto-launched");

    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "document.querySelector('h1').textContent" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "Auto");

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_error_handling() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "data:text/html,<h1>Errors</h1>" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "10", "action": "nonexistent_action" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("Not yet implemented"));

    let resp = execute_command(
        &json!({ "id": "11", "action": "fill", "selector": "#x" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"].as_str().unwrap().contains("value"));

    let resp = execute_command(
        &json!({ "id": "12", "action": "click", "selector": "#does-not-exist" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);

    let resp = execute_command(
        &json!({ "id": "13", "action": "evaluate", "script": "}{invalid" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(resp["error"].as_str().unwrap().contains("error"));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_profile_cookie_persistence() {
    let profile_dir = std::env::temp_dir().join(format!(
        "stella-browser-e2e-profile-{}",
        uuid::Uuid::new_v4()
    ));

    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "1",
                "action": "launch",
                "headless": true,
                "profile": profile_dir.to_str().unwrap()
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({
                "id": "3",
                "action": "cookies_set",
                "name": "persist_test",
                "value": "should_survive_restart",
                "domain": ".example.com",
                "path": "/",
                "expires": 2000000000
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "4", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "persist_test" && c["value"] == "should_survive_restart");
        assert!(found, "Cookie should exist before close");

        let resp = execute_command(&json!({ "id": "5", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    {
        let mut state = DaemonState::new();

        let resp = execute_command(
            &json!({
                "id": "10",
                "action": "launch",
                "headless": true,
                "profile": profile_dir.to_str().unwrap()
            }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp = execute_command(
            &json!({ "id": "11", "action": "navigate", "url": "https://example.com" }),
            &mut state,
        )
        .await;
        assert_success(&resp);

        let resp =
            execute_command(&json!({ "id": "12", "action": "cookies_get" }), &mut state).await;
        assert_success(&resp);
        let cookies = get_data(&resp)["cookies"].as_array().unwrap();
        let found = cookies
            .iter()
            .any(|c| c["name"] == "persist_test" && c["value"] == "should_survive_restart");
        assert!(
            found,
            "Cookie should persist across restart with --profile. Cookies found: {:?}",
            cookies
                .iter()
                .map(|c| c["name"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
        );

        let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
        assert_success(&resp);
    }

    let _ = std::fs::remove_dir_all(&profile_dir);
}

#[tokio::test]
#[ignore]
async fn e2e_get_cdp_url() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "2", "action": "cdp_url" }), &mut state).await;
    assert_success(&resp);
    let cdp_url = get_data(&resp)["cdpUrl"]
        .as_str()
        .expect("cdpUrl should be a string");
    assert!(
        cdp_url.starts_with("ws://"),
        "CDP URL should start with ws://, got: {}",
        cdp_url
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_inspect() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": "https://example.com" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "inspect" }), &mut state).await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["opened"], true);
    let url = data["url"]
        .as_str()
        .expect("inspect url should be a string");
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "Inspect URL should be http://127.0.0.1:<port>, got: {}",
        url
    );

    let http_resp = reqwest::get(url).await;
    match http_resp {
        Ok(r) => {
            let final_url = r.url().to_string();
            assert!(
                final_url.contains("devtools/devtools_app.html"),
                "Redirect should point to DevTools frontend, got: {}",
                final_url
            );
        }
        Err(e) => {
            panic!("HTTP GET to inspect URL failed: {}", e);
        }
    }

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_click_stale_ref_falls_back_to_role_name() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = r#"data:text/html,<body>
        <div id="c">
            <button onclick="
                var c = document.getElementById('c');
                c.innerHTML = '';
                var b = document.createElement('button');
                b.textContent = 'Target';
                b.onclick = function() { document.title = 'clicked'; };
                c.appendChild(b);
                document.title = 'replaced';
            ">Replace</button>
            <button>Target</button>
        </div>
    </body>"#;

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "3", "action": "snapshot" }), &mut state).await;
    assert_success(&resp);
    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();
    assert!(
        snapshot.contains("Replace"),
        "Snapshot should contain Replace button"
    );
    assert!(
        snapshot.contains("Target"),
        "Snapshot should contain Target button"
    );

    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "e1" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    let resp = execute_command(&json!({ "id": "5", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["title"], "replaced");

    let resp = execute_command(
        &json!({ "id": "6", "action": "click", "selector": "e2" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    let resp = execute_command(&json!({ "id": "7", "action": "title" }), &mut state).await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["title"],
        "clicked",
        "Stale ref should have been resolved via role/name fallback"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_material_checkbox_check_uncheck() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "data:text/html,<html><body>",

        "<input id='native' type='checkbox'>",

        "<div id='mat' style='position:relative;padding:12px'>",
          "<input id='mat-input' type='checkbox' style='position:absolute;opacity:0;width:1px;height:1px;top:-9999px;left:-9999px;pointer-events:none'>",
          "<div style='position:absolute;top:0;left:0;width:48px;height:48px;pointer-events:all;z-index:10'></div>",
          "<span>Material CB</span>",
        "</div>",

        "<div id='aria' role='checkbox' aria-checked='false' tabindex='0'>ARIA CB</div>",
        "<script>",
          "document.getElementById('aria').addEventListener('click',function(){",
            "var c=this.getAttribute('aria-checked')==='true';",
            "this.setAttribute('aria-checked',String(!c));",
          "});",
        "</script>",
        "</body></html>"
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "navigate", "url": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "10", "action": "ischecked", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "11", "action": "check", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "12", "action": "ischecked", "selector": "#native" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], true, "native check failed");

    let resp = execute_command(
        &json!({ "id": "20", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "21", "action": "check", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "22", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "Material checkbox should be checked after check action (#832)"
    );

    let resp = execute_command(
        &json!({ "id": "23", "action": "check", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "24", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "Material checkbox should stay checked on redundant check"
    );

    let resp = execute_command(
        &json!({ "id": "25", "action": "uncheck", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "26", "action": "ischecked", "selector": "#mat" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        false,
        "Material checkbox should be unchecked after uncheck action"
    );

    let resp = execute_command(
        &json!({ "id": "30", "action": "ischecked", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["checked"], false);

    let resp = execute_command(
        &json!({ "id": "31", "action": "check", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "32", "action": "ischecked", "selector": "#aria" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(
        get_data(&resp)["checked"],
        true,
        "ARIA checkbox should be checked after check action"
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_snapshot_cursor_interactive() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let html = concat!(
        "<html><body>",
        "<a href='#'>Link</a>",
        "<button>Btn</button>",
        "<div style='cursor:pointer' onclick='x()'>ClickDiv</div>",
        "<div tabindex='0'>FocusDiv</div>",
        "<span style='cursor:pointer'>PointerSpan</span>",
        "<div style='cursor:pointer'><span>InheritChild</span></div>",
        "</body></html>",
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "interactive": true, "cursor": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    assert!(
        snapshot.contains("clickable") && snapshot.contains("[cursor:pointer"),
        "Expected v0.19.0-format cursor output with hints:\n{}",
        snapshot,
    );

    assert!(
        snapshot.contains("focusable") && snapshot.contains("[tabindex]"),
        "Expected focusable role for tabindex-only element:\n{}",
        snapshot,
    );

    for line in snapshot.lines() {
        assert!(
            !(line.contains("\"Link\"")
                && (line.contains("clickable")
                    || line.contains("focusable")
                    || line.contains("editable"))),
            "Standard <a> element should not have cursor-interactive info:\n{}",
            line
        );
        assert!(
            !(line.contains("\"Btn\"")
                && (line.contains("clickable")
                    || line.contains("focusable")
                    || line.contains("editable"))),
            "Standard <button> element should not have cursor-interactive info:\n{}",
            line
        );
    }

    assert!(
        elapsed.as_secs() < 5,
        "snapshot -C took {:?}, expected < 5s (Issue #841 regression)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_screenshot_annotate_many_elements() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut html = String::from("<html><body>");
    for i in 1..=50 {
        html.push_str(&format!("<button>Button {}</button>", i));
    }
    html.push_str("</body></html>");

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "screenshot", "annotate": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let annotations = get_data(&resp)["annotations"]
        .as_array()
        .expect("Annotated screenshot should return annotations");

    assert!(
        annotations.len() >= 50,
        "Expected at least 50 annotations, got {}",
        annotations.len(),
    );

    assert!(
        elapsed.as_secs() < 10,
        "screenshot --annotate with 50 elements took {:?}, expected < 10s (Issue #841)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_snapshot_cursor_many_elements() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let mut html = String::from("<html><body>");
    for i in 1..=100 {
        html.push_str(&format!(
            "<div style='cursor:pointer' onclick='x()'>Item {}</div>",
            i,
        ));
    }
    html.push_str("</body></html>");

    let resp = execute_command(
        &json!({ "id": "2", "action": "setcontent", "html": html }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let start = std::time::Instant::now();
    let resp = execute_command(
        &json!({ "id": "3", "action": "snapshot", "interactive": true, "cursor": true }),
        &mut state,
    )
    .await;
    let elapsed = start.elapsed();
    assert_success(&resp);

    let snapshot = get_data(&resp)["snapshot"].as_str().unwrap();

    assert!(
        snapshot.contains("Item 1") && snapshot.contains("Item 100"),
        "Expected all 100 cursor-interactive items in output",
    );

    assert!(
        snapshot.contains("[cursor:pointer, onclick]"),
        "Expected v0.19.0-format hints",
    );

    assert!(
        elapsed.as_secs() < 10,
        "snapshot -C with 100 cursor elements took {:?}, expected < 10s (Issue #841)",
        elapsed,
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

fn aria_selector(payload: Value) -> String {
    let semantic = match payload.get("kind").and_then(|v| v.as_str()) {
        Some("role") => super::selector::SemanticSelector::by_role(
            payload["role"].as_str().unwrap(),
            payload.get("name").and_then(|v| v.as_str()),
            payload
                .get("exact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        )
        .unwrap(),
        Some(kind) => super::selector::SemanticSelector::by_value(
            super::selector::SemanticKind::from_str(kind).unwrap(),
            payload["value"].as_str().unwrap(),
            payload
                .get("exact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        )
        .unwrap(),
        _ => panic!("bad payload"),
    };
    super::selector::encode_semantic_selector(&semantic)
}

async fn launch_with_content(state: &mut DaemonState, html: &str) {
    let resp = execute_command(
        &json!({ "id": "l", "action": "launch", "headless": true }),
        state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "c", "action": "setcontent", "html": html }),
        state,
    )
    .await;
    assert_success(&resp);
}

fn error_text(resp: &Value) -> String {
    resp.get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
#[ignore]
async fn e2e_semantic_selector_click_and_fill() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <button id="save" aria-label="Save changes" onclick="window.__clicked = true">Save</button>
            <label for="email">Email address</label>
            <input id="email" type="email" placeholder="you@example.com">
            <div data-testid="status">idle</div>
        </body></html>"#,
    )
    .await;

    let selector =
        aria_selector(json!({ "kind": "role", "role": "button", "name": "Save changes" }));
    let resp = execute_command(
        &json!({ "id": "1", "action": "click", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "window.__clicked === true" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], true);

    let selector = aria_selector(json!({ "kind": "placeholder", "value": "you@example.com" }));
    let resp = execute_command(
        &json!({ "id": "3", "action": "fill", "selector": selector, "value": "a@b.co" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let selector = aria_selector(json!({ "kind": "label", "value": "Email address" }));
    let resp = execute_command(
        &json!({ "id": "4", "action": "inputvalue", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "a@b.co");

    let selector = aria_selector(json!({ "kind": "testid", "value": "status" }));
    let resp = execute_command(
        &json!({ "id": "5", "action": "gettext", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["text"], "idle");

    let resp = execute_command(
        &json!({ "id": "6", "action": "count", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["count"], 1);

    let selector = aria_selector(json!({ "kind": "role", "role": "button", "name": "Nope" }));
    let resp = execute_command(
        &json!({ "id": "7", "action": "gettext", "selector": selector }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(
        error_text(&resp).contains("No element found with role=\"button\" name=\"Nope\""),
        "unexpected error: {}",
        error_text(&resp)
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_semantic_nth_and_exact() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <button onclick="window.__which='first'">Repeat</button>
            <button onclick="window.__which='second'">Repeat</button>
            <button onclick="window.__which='exactish'">Repeat exactly</button>
        </body></html>"#,
    )
    .await;

    let mut semantic =
        super::selector::SemanticSelector::by_role("button", Some("Repeat"), true).unwrap();
    semantic.nth = Some(1);
    let selector = super::selector::encode_semantic_selector(&semantic);
    let resp = execute_command(
        &json!({ "id": "1", "action": "click", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "window.__which" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], "second");

    let loose = aria_selector(
        json!({ "kind": "role", "role": "button", "name": "Repeat", "exact": false }),
    );
    let resp = execute_command(
        &json!({ "id": "3", "action": "count", "selector": loose }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["count"], 3);
    let strict =
        aria_selector(json!({ "kind": "role", "role": "button", "name": "Repeat", "exact": true }));
    let resp = execute_command(
        &json!({ "id": "4", "action": "count", "selector": strict }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["count"], 2);

    let mut semantic =
        super::selector::SemanticSelector::by_role("button", Some("Repeat"), true).unwrap();
    semantic.nth = Some(9);
    let selector = super::selector::encode_semantic_selector(&semantic);
    let resp = execute_command(
        &json!({ "id": "5", "action": "click", "selector": selector }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(
        error_text(&resp).contains("out of range"),
        "unexpected error: {}",
        error_text(&resp)
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_getby_commands_use_unified_resolver() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <button aria-label="Submit form" onclick="window.__ok = true">Go</button>
            <label>Nickname <input id="nick"></label>
            <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Logo mark" title="Company logo">
        </body></html>"#,
    )
    .await;

    let resp = execute_command(
        &json!({ "id": "1", "action": "getbyrole", "role": "button", "name": "Submit form", "subaction": "click" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "window.__ok === true" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], true);

    let resp = execute_command(
        &json!({ "id": "3", "action": "getbylabel", "label": "Nickname", "subaction": "fill", "value": "zed" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "4", "action": "evaluate", "script": "document.getElementById('nick').value" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], "zed");

    let resp = execute_command(
        &json!({ "id": "5", "action": "getbyalttext", "text": "Logo mark", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "6", "action": "getbytitle", "text": "Company logo", "subaction": "text" }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &json!({ "id": "7", "action": "evaluate", "script": "document.querySelectorAll('[data-stella-browser-located]').length" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], 0);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_actionability_scrolls_below_fold_click() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <div style="height: 4000px">spacer</div>
            <button id="deep" onclick="window.__deep = true">Deep button</button>
        </body></html>"#,
    )
    .await;

    let resp = execute_command(
        &json!({ "id": "1", "action": "click", "selector": "#deep" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "window.__deep === true" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], true);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_actionability_precise_failures() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <button id="covered" onclick="window.__covered = true">Covered</button>
            <div id="overlay" class="modal-backdrop" style="position: fixed; inset: 0; background: rgba(0,0,0,0.4)"></div>
            <button id="invisible" style="display: none">Hidden</button>
            <div id="flat" style="width: 0; height: 0"></div>
        </body></html>"#,
    )
    .await;

    let resp = execute_command(
        &json!({ "id": "1", "action": "click", "selector": "#covered" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let err = error_text(&resp);
    assert!(
        err.contains("covered by <div#overlay.modal-backdrop>"),
        "unexpected error: {}",
        err
    );

    let resp = execute_command(
        &json!({ "id": "2", "action": "evaluate", "script": "window.__covered === true" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["result"], false);

    let resp = execute_command(
        &json!({ "id": "3", "action": "click", "selector": "#invisible" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(
        error_text(&resp).contains("not visible (display: none or visibility: hidden)"),
        "unexpected error: {}",
        error_text(&resp)
    );

    let resp = execute_command(
        &json!({ "id": "4", "action": "click", "selector": "#flat" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(
        error_text(&resp).contains("zero size"),
        "unexpected error: {}",
        error_text(&resp)
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_actionability_custom_checkbox_fallback() {
    let mut state = DaemonState::new();

    launch_with_content(
        &mut state,
        r#"<html><body>
            <label>
                <input id="opt" type="checkbox" style="position: absolute; opacity: 0; width: 0; height: 0">
                <span style="display: inline-block; width: 16px; height: 16px; border: 1px solid #333"></span>
                Enable option
            </label>
        </body></html>"#,
    )
    .await;

    let resp = execute_command(
        &json!({ "id": "1", "action": "check", "selector": "#opt" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "2", "action": "ischecked", "selector": "#opt" }),
        &mut state,
    )
    .await;
    assert_eq!(get_data(&resp)["checked"], true);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_wait_supports_semantic_selectors() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <script>
                setTimeout(() => {
                    const b = document.createElement('button');
                    b.textContent = 'Late button';
                    document.body.appendChild(b);
                }, 300);
            </script>
        </body></html>"#,
    )
    .await;

    let selector =
        aria_selector(json!({ "kind": "role", "role": "button", "name": "Late button" }));
    let resp = execute_command(
        &json!({ "id": "1", "action": "wait", "selector": selector, "timeout": 5000 }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_chain_runs_steps_and_marker_chain_flow() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <div id="results">
                <div class="row">alpha</div>
                <div class="row">beta</div>
                <div class="row">gamma</div>
            </div>
            <input id="out">
        </body></html>"#,
    )
    .await;

    let marker_script = r##"(() => {
        const elements = [...document.querySelectorAll("#results > .row")];
        const element = elements[1];
        if (!element) throw new Error("Locator did not match an element");
        for (const previous of document.querySelectorAll('[data-stella-worker-locator="m1"]')) {
            previous.removeAttribute("data-stella-worker-locator");
        }
        element.setAttribute("data-stella-worker-locator", "m1");
        return true;
    })()"##;
    let resp = execute_command(
        &json!({
            "id": "chain-marker",
            "action": "chain",
            "abortOnError": false,
            "waitForSelector": false,
            "steps": [
                { "action": "evaluate", "script": marker_script },
                { "action": "innertext", "selector": "[data-stella-worker-locator=\"m1\"]" }
            ]
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["completed"], 2);
    assert_eq!(data["total"], 2);
    let results = data["results"].as_array().unwrap();
    assert_eq!(results[0]["step"], 0);
    assert_eq!(results[0]["success"], true);
    assert_eq!(results[0]["data"]["result"], true);
    assert_eq!(results[1]["step"], 1);
    assert_eq!(results[1]["success"], true);
    assert_eq!(results[1]["data"]["text"], "beta");

    let resp = execute_command(
        &json!({
            "id": "chain-cleanup",
            "action": "evaluate",
            "script": r#"(() => {
                for (const element of document.querySelectorAll('[data-stella-worker-locator="m1"]')) {
                    element.removeAttribute("data-stella-worker-locator");
                }
                return document.querySelectorAll("[data-stella-worker-locator]").length;
            })()"#
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], 0);

    let resp = execute_command(
        &json!({
            "id": "chain-fill",
            "action": "chain",
            "returnSnapshot": true,
            "steps": [
                { "action": "fill", "selector": "#out", "value": "done" },
                { "action": "inputvalue", "selector": "#out" }
            ]
        }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["completed"], 2);
    assert_eq!(data["results"][1]["data"]["value"], "done");
    assert!(
        data["snapshot"].is_string(),
        "returnSnapshot must attach the snapshot tree: {}",
        data
    );

    let resp = execute_command(
        &json!({
            "id": "chain-fail",
            "action": "chain",
            "waitTimeout": 500,
            "steps": [
                { "action": "click", "selector": "#does-not-exist" },
                { "action": "title" }
            ]
        }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let error = error_text(&resp);
    assert!(
        error.contains("Chain step 0 (click) failed"),
        "unexpected chain error: {}",
        error
    );
    let data = get_data(&resp);
    assert_eq!(data["completed"], 0);
    assert_eq!(data["total"], 2);
    assert_eq!(data["results"].as_array().unwrap().len(), 1);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

fn with_owner_lease(
    mut command: Value,
    owner_id: &str,
    turn_id: &str,
    lease_id: &str,
    issued_at: u64,
) -> Value {
    let object = command.as_object_mut().unwrap();
    object.insert("ownerId".to_string(), json!(owner_id));
    object.insert("sessionId".to_string(), json!(owner_id));
    object.insert("turnId".to_string(), json!(turn_id));
    object.insert("ownerLeaseId".to_string(), json!(lease_id));
    object.insert("ownerLeaseIssuedAt".to_string(), json!(issued_at));
    command
}

#[tokio::test]
#[ignore]
async fn e2e_owner_finalize_closes_owned_tabs_and_is_idempotent() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "2", "action": "tab_new" }),
            "owner-e2e",
            "turn-e2e",
            "lease-e2e",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let first_tab = get_data(&resp)["tabId"].as_u64().unwrap();
    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "3", "action": "tab_new" }),
            "owner-e2e",
            "turn-e2e",
            "lease-e2e",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let second_tab = get_data(&resp)["tabId"].as_u64().unwrap();

    let resp = execute_command(
        &with_owner_lease(
            json!({
                "id": "4",
                "action": "finalize_tabs",
                "keep": [ { "tabId": first_tab, "status": "handoff" } ],
            }),
            "owner-e2e",
            "turn-e2e",
            "lease-e2e",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let data = get_data(&resp);
    assert_eq!(data["closedTabIds"], json!([second_tab]));
    assert_eq!(data["releasedTabIds"], json!([first_tab]));
    assert_eq!(data["kept"][0]["tabId"], first_tab);

    let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let tabs = get_data(&resp)["tabs"].as_array().unwrap().clone();
    assert!(tabs.iter().any(|tab| tab["tabId"] == first_tab));
    assert!(tabs.iter().all(|tab| tab["tabId"] != second_tab));

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "6", "action": "close_owner" }),
            "owner-e2e",
            "turn-e2e",
            "lease-e2e",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["closedTabIds"], json!([]));

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "7", "action": "release_owner_lease" }),
            "owner-e2e",
            "turn-e2e",
            "lease-e2e",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["released"], true);

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_owner_tab_discovery_and_commands_reject_foreign_tabs() {
    let mut state = DaemonState::new();

    let resp = execute_command(
        &json!({ "id": "1", "action": "launch", "headless": true }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "2", "action": "tab_list" }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let owner_a_tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(owner_a_tabs.len(), 1, "response: {}", resp);
    let owner_a_first_tab = owner_a_tabs[0]["tabId"].as_u64().unwrap();

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "2b", "action": "tab_new" }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let owner_a_tab = get_data(&resp)["tabId"].as_u64().unwrap();

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "3", "action": "tab_new" }),
            "owner-b",
            "turn-b",
            "lease-b",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let owner_b_tab = get_data(&resp)["tabId"].as_u64().unwrap();

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "4", "action": "tab_list" }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let owner_a_tabs_again = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(owner_a_tabs_again.len(), 2, "response: {}", resp);
    assert!(owner_a_tabs_again
        .iter()
        .any(|tab| tab["tabId"] == owner_a_first_tab));
    assert_eq!(get_data(&resp)["activeTabId"].as_u64(), Some(owner_a_tab));
    assert_eq!(
        owner_a_tabs_again
            .iter()
            .find(|tab| tab["tabId"] == owner_a_tab)
            .and_then(|tab| tab["active"].as_bool()),
        Some(true)
    );
    assert!(owner_a_tabs_again
        .iter()
        .all(|tab| tab["tabId"] != owner_b_tab));

    let resp = execute_command(&json!({ "id": "5", "action": "tab_list" }), &mut state).await;
    assert_success(&resp);
    let all_tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert!(all_tabs.iter().any(|tab| tab["tabId"] == owner_a_first_tab));
    assert!(all_tabs.iter().any(|tab| tab["tabId"] == owner_a_tab));
    assert!(all_tabs.iter().any(|tab| tab["tabId"] == owner_b_tab));

    for command in [
        with_owner_lease(
            json!({
                "id": "foreign-per-tab",
                "action": "title",
                "tabId": owner_b_tab,
            }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        with_owner_lease(
            json!({
                "id": "foreign-switch",
                "action": "tab_switch",
                "tabId": owner_b_tab,
            }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        with_owner_lease(
            json!({
                "id": "foreign-close",
                "action": "tab_close",
                "tabId": owner_b_tab,
            }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
    ] {
        let resp = execute_command(&command, &mut state).await;
        assert_eq!(resp["success"], false, "response: {}", resp);
        assert!(resp["error"]
            .as_str()
            .unwrap()
            .contains("another browser owner"));
    }

    let resp = execute_command(
        &with_owner_lease(
            json!({
                "id": "foreign-chain",
                "action": "chain",
                "steps": [{
                    "action": "title",
                    "ownerId": "owner-b",
                    "tabId": owner_b_tab,
                }],
            }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false, "response: {}", resp);
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("another browser owner"));

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "6", "action": "tab_list" }),
            "owner-b",
            "turn-b",
            "lease-b",
            100,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(get_data(&resp)["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tab| tab["tabId"] == owner_b_tab));

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "7", "action": "tab_list" }),
            "owner-a",
            "turn-a-new",
            "lease-a-new",
            200,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let superseding_tabs = get_data(&resp)["tabs"].as_array().unwrap();
    assert_eq!(superseding_tabs.len(), 1, "response: {}", resp);
    assert!(superseding_tabs
        .iter()
        .all(|tab| { tab["tabId"] != owner_a_first_tab && tab["tabId"] != owner_a_tab }));
    let newer_tab = superseding_tabs[0]["tabId"].as_u64().unwrap();

    let stale_cleanup = execute_command(
        &with_owner_lease(
            json!({ "id": "8", "action": "finalize_tabs", "keep": [] }),
            "owner-a",
            "turn-a",
            "lease-a",
            100,
        ),
        &mut state,
    )
    .await;
    assert_eq!(
        stale_cleanup["success"], false,
        "response: {}",
        stale_cleanup
    );
    assert!(stale_cleanup["error"]
        .as_str()
        .unwrap()
        .contains("Stale browser owner lease"));

    let resp = execute_command(
        &with_owner_lease(
            json!({ "id": "9", "action": "tab_list" }),
            "owner-a",
            "turn-a-new",
            "lease-a-new",
            200,
        ),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert!(get_data(&resp)["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tab| tab["tabId"] == newer_tab));

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}

#[tokio::test]
#[ignore]
async fn e2e_same_origin_iframe_resolution_and_input() {
    let mut state = DaemonState::new();
    launch_with_content(
        &mut state,
        r#"<html><body>
            <h1>Top document</h1>
            <div style="height: 40px"></div>
        </body></html>"#,
    )
    .await;

    let resp = execute_command(
        &json!({ "id": "1", "action": "evaluate", "script": r#"
            (() => {
                const same = document.createElement('iframe');
                same.id = 'child';
                same.style.cssText = 'width:400px;height:200px;border:4px solid black;display:block;margin-top:30px';
                document.body.appendChild(same);
                same.contentDocument.body.innerHTML =
                    '<label for="msg">Message</label>' +
                    '<input id="msg" placeholder="frame-input">' +
                    '<button id="fbtn" onclick="document.getElementById(\'msg\').value = \'clicked\'">Frame button</button>';
                const foreign = document.createElement('iframe');
                foreign.id = 'foreign';
                foreign.src = 'data:text/html,<p>opaque</p>';
                document.body.appendChild(foreign);
                return true;
            })()
        "# }),
        &mut state,
    )
    .await;
    assert_success(&resp);

    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;

    let resp = execute_command(
        &json!({ "id": "2", "action": "count", "selector": "#msg" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["count"], 1);

    let resp = execute_command(
        &json!({ "id": "3", "action": "fill", "selector": "#msg", "value": "hello frame" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "4", "action": "evaluate", "script":
            "document.getElementById('child').contentDocument.getElementById('msg').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "hello frame");

    let selector = aria_selector(json!({ "kind": "placeholder", "value": "frame-input" }));
    let resp = execute_command(
        &json!({ "id": "5", "action": "inputvalue", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["value"], "hello frame");

    let selector = aria_selector(json!({ "kind": "label", "value": "Message" }));
    let resp = execute_command(
        &json!({ "id": "6", "action": "count", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["count"], 1);

    let selector =
        aria_selector(json!({ "kind": "role", "role": "button", "name": "Frame button" }));
    let resp = execute_command(
        &json!({ "id": "7", "action": "click", "selector": selector }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    let resp = execute_command(
        &json!({ "id": "8", "action": "evaluate", "script":
            "document.getElementById('child').contentDocument.getElementById('msg').value" }),
        &mut state,
    )
    .await;
    assert_success(&resp);
    assert_eq!(get_data(&resp)["result"], "clicked");

    let resp = execute_command(
        &json!({ "id": "9", "action": "gettext", "selector": "#does-not-exist" }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    assert!(
        error_text(&resp).contains("cross-origin frame(s) could not be searched"),
        "CSS not-found error should mention the unreachable frame: {}",
        error_text(&resp)
    );

    let selector = aria_selector(json!({ "kind": "role", "role": "button", "name": "Nope" }));
    let resp = execute_command(
        &json!({ "id": "10", "action": "gettext", "selector": selector }),
        &mut state,
    )
    .await;
    assert_eq!(resp["success"], false);
    let error = error_text(&resp);
    assert!(
        error.contains("No element found with role=\"button\" name=\"Nope\"")
            && error.contains("cross-origin frame(s) could not be searched"),
        "semantic not-found error should mention the unreachable frame: {}",
        error
    );

    let resp = execute_command(&json!({ "id": "99", "action": "close" }), &mut state).await;
    assert_success(&resp);
}
