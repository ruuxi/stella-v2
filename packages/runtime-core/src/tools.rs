use serde_json::Value;
use std::sync::LazyLock;
pub static READ: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/tools/read.json"))
        .expect("built-in Read definition")
});
pub static APPLY_PATCH: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/tools/apply-patch.json"))
        .expect("built-in apply_patch definition")
});
pub fn native_definitions(allowed: &[&str]) -> Vec<Value> {
    [&*READ, &*APPLY_PATCH, &*EXEC_COMMAND, &*WRITE_STDIN]
        .into_iter()
        .filter(|definition| allowed.contains(&definition["name"].as_str().unwrap()))
        .cloned()
        .collect()
}
pub static EXEC_COMMAND: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/tools/exec-command.json"))
        .expect("built-in Bash")
});
pub static WRITE_STDIN: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/tools/write-stdin.json"))
        .expect("built-in write_stdin")
});
