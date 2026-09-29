use serde_json::Value;
use std::sync::LazyLock;
pub static READ: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/tools/read.json"))
        .expect("built-in Read definition")
});
