//! Parity tests for the native daemon's command interface.
//!
//! These tests cover credential persistence and validation, state cleanup,
//! and domain filtering without a browser.

use serde_json::json;

use super::actions::{execute_command, DaemonState};

const ENCRYPTION_KEY_ENV: &str = "STELLA_BROWSER_ENCRYPTION_KEY";

struct TestKeyGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    original: Option<String>,
}

impl TestKeyGuard {
    fn new() -> Self {
        let lock = super::auth::AUTH_TEST_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let original = std::env::var(ENCRYPTION_KEY_ENV).ok();
        // SAFETY: AUTH_TEST_MUTEX serializes all test access so no concurrent mutation.
        unsafe { std::env::set_var(ENCRYPTION_KEY_ENV, "a".repeat(64)) };
        Self {
            _lock: lock,
            original,
        }
    }
}

impl Drop for TestKeyGuard {
    fn drop(&mut self) {
        // SAFETY: AUTH_TEST_MUTEX is held via _lock.
        match &self.original {
            Some(val) => unsafe { std::env::set_var(ENCRYPTION_KEY_ENV, val) },
            None => unsafe { std::env::remove_var(ENCRYPTION_KEY_ENV) },
        }
    }
}

#[tokio::test]
async fn test_auth_profile_name_validation() {
    use super::auth;
    let _key_guard = TestKeyGuard::new();
    let valid = auth::credentials_set("valid-name_123", "u", "p", None);
    assert!(valid.is_ok());
    let invalid = auth::credentials_set("invalid/name", "u", "p", None);
    assert!(invalid.is_err());
    let invalid2 = auth::credentials_set("", "u", "p", None);
    assert!(invalid2.is_err());
    let invalid3 = auth::credentials_set("has space", "u", "p", None);
    assert!(invalid3.is_err());
    // Cleanup
    let _ = auth::credentials_delete("valid-name_123");
}

#[tokio::test]
async fn test_auth_save_and_show() {
    use super::auth;
    let _key_guard = TestKeyGuard::new();
    let result = auth::auth_save(
        "parity-roundtrip",
        "https://example.com",
        "user",
        "pass",
        Some("input#user"),
        None,
        None,
    );
    assert!(result.is_ok());

    let show = auth::auth_show("parity-roundtrip");
    assert!(show.is_ok());
    let data = show.unwrap();
    assert_eq!(data["profile"]["username"], "user");
    assert_eq!(data["profile"]["usernameSelector"], "input#user");

    let full = auth::credentials_get_full("parity-roundtrip");
    assert!(full.is_ok());
    assert_eq!(full.unwrap().password, "pass");

    // Cleanup
    let _ = auth::credentials_delete("parity-roundtrip");
}

#[tokio::test]
async fn test_state_clean_action() {
    let mut state = DaemonState::new();
    let cmd = json!({ "action": "state_clean", "id": "clean-1", "days": 30 });
    let result = execute_command(&cmd, &mut state).await;
    assert_eq!(result["success"], true);
}

#[tokio::test]
async fn test_domain_filter_sanitize() {
    use super::network::DomainFilter;
    let filter = DomainFilter::new("example.com");
    assert!(filter.is_allowed("example.com"));
    assert!(!filter.is_allowed("evil.com"));
    filter.check_url("https://example.com/path").unwrap();
    assert!(filter.check_url("https://evil.com").is_err());
}

#[tokio::test]
async fn test_state_find_auto_returns_none_for_nonexistent() {
    use super::state;
    let result = state::find_auto_state_file("nonexistent-session-xyz");
    assert!(result.is_none());
}
