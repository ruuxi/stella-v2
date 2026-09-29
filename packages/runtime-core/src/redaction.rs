use regex::{Captures, Regex};
use std::sync::LazyLock;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("built-in redaction pattern")
}
fn mask(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() < 18 {
        "***".into()
    } else {
        format!(
            "{}...{}",
            chars[..6].iter().collect::<String>(),
            chars[chars.len() - 4..].iter().collect::<String>()
        )
    }
}

pub fn memory(text: &str) -> String {
    redact(text, false)
}
pub fn tool_text(text: &str, code_file: bool) -> String {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| {
        pattern(r"(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_])")
    });
    redact(&ANSI.replace_all(text, ""), code_file)
}
fn redact(text: &str, code_file: bool) -> String {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        pattern(
            r"\b((?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|github_pat_|xox[baprs]-|hf_|r8_|npm_|pypi-|AKIA|AIza|ya29\.|syt_)[A-Za-z0-9._:=+/~-]{10,})\b",
        )
    });
    static AUTH: LazyLock<Regex> =
        LazyLock::new(|| pattern(r"(?i)(Authorization:\s*Bearer\s+)(\S+)"));
    static PRIVATE: LazyLock<Regex> = LazyLock::new(|| {
        pattern(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.*?)-----END [A-Z ]*PRIVATE KEY-----")
    });
    static DATABASE: LazyLock<Regex> = LazyLock::new(|| {
        pattern(
            r"(?i)\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s/@]+:)([^@\s]+)(@)",
        )
    });
    static JWT: LazyLock<Regex> = LazyLock::new(|| {
        pattern(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b")
    });
    static USERINFO: LazyLock<Regex> =
        LazyLock::new(|| pattern(r"(?i)\b((?:https?|wss?|ftp)://)([^/\s:@]+):([^@\s/]+)@"));
    static ENV: LazyLock<Regex> = LazyLock::new(|| {
        pattern(
            r#"(?i)\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CLIENT[_-]?SECRET|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(['"]?)([^\s'"]{8,})(['"]?)"#,
        )
    });
    static JSON: LazyLock<Regex> = LazyLock::new(|| {
        pattern(
            r#"(?i)("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer|client_secret)"\s*:\s*")([^"]{8,})(")"#,
        )
    });
    static URL: LazyLock<Regex> = LazyLock::new(|| pattern(r#"(?i)\bhttps?://[^\s"'<>]+"#));
    let text = PREFIX.replace_all(text, |c: &Captures| mask(&c[1]));
    let text = AUTH.replace_all(&text, |c: &Captures| format!("{}{}", &c[1], mask(&c[2])));
    let text = PRIVATE.replace_all(&text, "[REDACTED PRIVATE KEY]");
    let text = DATABASE.replace_all(&text, |c: &Captures| format!("{}***{}", &c[1], &c[3]));
    let text = JWT.replace_all(&text, |c: &Captures| mask(&c[0]));
    let text = USERINFO.replace_all(&text, |c: &Captures| format!("{}{}:***@", &c[1], &c[2]));
    let text = if code_file {
        text.into_owned()
    } else {
        let text = ENV.replace_all(&text, |c: &Captures| {
            format!("{}={}{}{}", &c[1], &c[2], mask(&c[3]), &c[4])
        });
        JSON.replace_all(&text, |c: &Captures| {
            format!("{}{}{}", &c[1], mask(&c[2]), &c[3])
        })
        .into_owned()
    };
    URL.replace_all(&text, |c: &Captures| {
        let Ok(mut url) = url::Url::parse(&c[0]) else {
            return c[0].to_string();
        };
        let mut changed = false;
        let pairs = url
            .query_pairs()
            .map(|(key, value)| {
                let secret = matches!(
                    key.to_lowercase().as_str(),
                    "access_token"
                        | "auth_token"
                        | "api_key"
                        | "apikey"
                        | "code"
                        | "key"
                        | "password"
                        | "secret"
                        | "token"
                ) && value.len() >= 6;
                if secret {
                    changed = true;
                    (key.into_owned(), mask(&value))
                } else {
                    (key.into_owned(), value.into_owned())
                }
            })
            .collect::<Vec<_>>();
        if changed {
            url.query_pairs_mut().clear().extend_pairs(pairs);
            url.into()
        } else {
            c[0].into()
        }
    })
    .into_owned()
}
