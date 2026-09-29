//! Static catastrophic-command guard. This analyzes commands without running
//! expansions; it is deliberately not a shell sandbox or an approval policy.
use base64::Engine;
use regex::Regex;
use std::collections::BTreeMap;
fn re(pattern: &'static str) -> Regex {
    static PATTERNS: std::sync::LazyLock<std::sync::Mutex<BTreeMap<&'static str, Regex>>> =
        std::sync::LazyLock::new(Default::default);
    PATTERNS
        .lock()
        .unwrap()
        .entry(pattern)
        .or_insert_with(|| Regex::new(pattern).expect("compiled shell guard pattern"))
        .clone()
}
#[derive(Clone)]
struct Token {
    word: bool,
    value: String,
}
#[derive(Default)]
struct Lexed {
    tokens: Vec<Token>,
    nested: Vec<String>,
    expressions: BTreeMap<String, String>,
}
#[derive(Clone)]
struct State {
    cwd: String,
    home: String,
    vars: BTreeMap<String, String>,
}
impl State {
    fn set(&mut self, name: &str, value: String) {
        self.vars.insert(name.to_lowercase(), value);
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(&name.to_lowercase()).map(String::as_str)
    }
}
fn balanced(input: &[char], start: usize, backtick: bool) -> Option<(String, usize)> {
    let mut depth = 1;
    let mut quote = None;
    let mut escaped = false;
    for i in start..input.len() {
        let c = input[i];
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if backtick {
            if c == '`' {
                return Some((input[start..i].iter().collect(), i));
            }
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            continue;
        }
        if c == '(' {
            depth += 1;
        }
        if c == ')' {
            depth -= 1;
            if depth == 0 {
                return Some((input[start..i].iter().collect(), i));
            }
        }
    }
    None
}
fn flush(tokens: &mut Vec<Token>, word: &mut String, started: &mut bool) {
    if *started {
        tokens.push(Token {
            word: true,
            value: std::mem::take(word),
        });
        *started = false;
    }
}
fn expression(out: &mut Lexed, word: &mut String, content: String, nested: bool) {
    if nested {
        out.nested.push(content.clone());
    }
    let key = format!("__stella_static_{}__", out.expressions.len());
    word.push_str(&key);
    out.expressions.insert(key, content);
}
fn lex(input: &str) -> Lexed {
    let chars = input.chars().collect::<Vec<_>>();
    let mut out = Lexed::default();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if quote.is_none() && c == '#' && !started {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            if i < chars.len() {
                out.tokens.push(Token {
                    word: false,
                    value: "\n".into(),
                });
            }
            i += 1;
            continue;
        }
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            } else {
                word.push(c);
            }
            started = true;
            i += 1;
            continue;
        }
        let nested = if c == '`' {
            balanced(&chars, i + 1, true)
        } else if c == '$' && next == Some('(') && chars.get(i + 2) != Some(&'(')
            || quote.is_none() && matches!(c, '<' | '>') && next == Some('(')
        {
            balanced(&chars, i + 2, false)
        } else {
            None
        };
        if let Some((content, end)) = nested {
            expression(&mut out, &mut word, content, true);
            started = true;
            i = end + 1;
            continue;
        }
        if c == '"' {
            quote = if quote == Some('"') { None } else { Some('"') };
            started = true;
            i += 1;
            continue;
        }
        if quote.is_none() && c == '\'' {
            quote = Some(c);
            started = true;
            i += 1;
            continue;
        }
        if quote.is_none() && c == '$' && matches!(next, Some('\'' | '"')) {
            quote = next;
            started = true;
            i += 2;
            continue;
        }
        if c == '\\' {
            if let Some(n) = next {
                if quote.is_none()
                    && (re(r"^[A-Za-z]:").is_match(&word) || word.starts_with("//"))
                    && n.is_whitespace()
                {
                    word.push(c);
                } else if quote == Some('"') || n.is_whitespace() || "'\"`$;&|<>(){}\\".contains(n)
                {
                    word.push(n);
                    i += 1;
                } else {
                    word.push(c);
                }
            } else {
                word.push(c);
            }
            started = true;
            i += 1;
            continue;
        }
        if quote.is_none() && matches!(c, ' ' | '\t' | '\r') {
            flush(&mut out.tokens, &mut word, &mut started);
            i += 1;
            continue;
        }
        if quote.is_none()
            && c == '('
            && !started
            && let Some((content, end)) = balanced(&chars, i + 1, false)
            && re(r"(?i)^\s*(Resolve-Path|realpath|readlink|pwd)\b").is_match(&content)
        {
            expression(&mut out, &mut word, content, false);
            started = true;
            i = end + 1;
            continue;
        }
        if quote.is_none() && ";&|\n()<>".contains(c) {
            flush(&mut out.tokens, &mut word, &mut started);
            let mut value = c.to_string();
            if "&|<>".contains(c) && next == Some(c) {
                value.push(c);
                i += 1;
            }
            out.tokens.push(Token { word: false, value });
            i += 1;
            continue;
        }
        word.push(c);
        started = true;
        i += 1;
    }
    flush(&mut out.tokens, &mut word, &mut started);
    out
}
fn segments(tokens: &[Token]) -> Vec<(Vec<Token>, String)> {
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut previous = String::new();
    for t in tokens {
        if !t.word && !matches!(t.value.as_str(), ">" | ">>" | "<" | "<<") {
            if !current.is_empty() {
                result.push((std::mem::take(&mut current), previous));
            }
            previous = t.value.clone();
        } else {
            current.push(t.clone());
        }
    }
    if !current.is_empty() {
        result.push((current, previous));
    }
    result
}
fn words(tokens: &[Token]) -> Vec<String> {
    tokens
        .iter()
        .filter(|t| t.word)
        .map(|t| t.value.clone())
        .collect()
}
fn executable(word: &str) -> String {
    let name = if re(r"^[A-Za-z]:\\|^\\\\").is_match(word) {
        word.rsplit(['\\', '/']).next().unwrap_or("").into()
    } else {
        re(r"\\([A-Za-z])")
            .replace_all(word.rsplit('/').next().unwrap_or(""), "$1")
            .into_owned()
    };
    re(r"(?i)\.(com|cmd|exe)$")
        .replace(&name, "")
        .to_lowercase()
}
fn assignment(word: &str) -> Option<(&str, &str)> {
    let (name, value) = word.split_once('=')?;
    if re(r"^[A-Za-z_][A-Za-z0-9_]*$").is_match(name) {
        Some((name, value))
    } else {
        None
    }
}
fn skip(words: &[String], mut i: usize, arguments: &[&str]) -> usize {
    while i < words.len() {
        let value = words[i].to_lowercase();
        if value == "--" {
            return i + 1;
        }
        if !value.starts_with('-') {
            break;
        }
        i += 1;
        if !value.contains('=') && arguments.contains(&value.as_str()) {
            i += 1;
        }
    }
    i.min(words.len())
}
fn unwrap(words: &[String]) -> Option<(String, Vec<String>)> {
    let mut i = 0;
    while i < words.len() && assignment(&words[i]).is_some() {
        i += 1;
    }
    for _ in 0..12 {
        let name = executable(words.get(i)?);
        let options: &[&str] = match name.as_str() {
            "sudo" => &[
                "-c",
                "--close-from",
                "-d",
                "--chdir",
                "-g",
                "--group",
                "-h",
                "--host",
                "-p",
                "--prompt",
                "-r",
                "--role",
                "-t",
                "--type",
                "-u",
                "--user",
            ],
            "env" => &["-c", "--chdir", "-u", "--unset"],
            "command" | "exec" | "nohup" | "setsid" => &[],
            "time" => &["-f", "--format", "-o", "--output"],
            "nice" => &["-n", "--adjustment"],
            _ => return Some((name, words[i + 1..].to_vec())),
        };
        i = skip(words, i + 1, options);
        if name == "env" {
            while i < words.len() && assignment(&words[i]).is_some() {
                i += 1;
            }
        }
    }
    None
}
fn resolve(
    word: &str,
    state: &State,
    expressions: &BTreeMap<String, String>,
    depth: usize,
) -> String {
    let mut value = word.to_owned();
    if depth <= 8 {
        for (key, expression) in expressions {
            if value.contains(key)
                && let Some(resolved) = evaluate(expression, state, depth + 1)
            {
                value = value
                    .replace(&format!("{key}.Path"), &resolved)
                    .replace(key, &resolved);
            }
        }
    }
    value=re(r"(?i)\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-+?=][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%").replace_all(&value,|cap:&regex::Captures|{(1..=4).find_map(|i|cap.get(i)).and_then(|m|state.get(m.as_str())).unwrap_or(&cap[0]).to_owned()}).into_owned();
    if value == "~" || value.starts_with("~/") {
        value = state.home.clone() + &value[1..];
    }
    value
}
fn normalize(value: &str) -> String {
    let absolute = value.starts_with('/');
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}
fn candidate(word: &str, state: &State, expressions: &BTreeMap<String, String>) -> String {
    let mut value = resolve(word, state, expressions, 0)
        .trim()
        .replace('\\', "/");
    if (value.starts_with("//?/") || value.starts_with("//./"))
        && re(r"^[A-Za-z]:/").is_match(&value[4..])
    {
        value = value[4..].into();
    }
    value=re(r"(?i)^(~[^/]*|\$\{(HOME|USERPROFILE)(?::[-+?=][^}]*)?\}|\$(HOME|USERPROFILE)|%USERPROFILE%|\$env:USERPROFILE)(/|$)").replace(&value,"/Users/__stella_home__$4").into_owned();
    loop {
        let trimmed = re(r"/(\{\*,\.\*\}|\*|\.\*|\*\.\*)/?$")
            .replace(&value, "")
            .into_owned();
        if trimmed == value {
            break;
        }
        value = trimmed;
    }
    if value.is_empty() && word.starts_with('/') {
        return "/".into();
    }
    if re(r"^[A-Za-z]:$").is_match(&value) {
        return value.to_lowercase();
    }
    if re(r"^[A-Za-z]:/").is_match(&value) {
        return format!("{}{}", &value[..2], normalize(&value[2..])).to_lowercase();
    }
    if !value.starts_with('/') {
        value = format!("{}/{}", state.cwd.replace('\\', "/"), value);
    }
    if re(r"^[A-Za-z]:/").is_match(&value) {
        return format!("{}{}", &value[..2], normalize(&value[2..])).to_lowercase();
    }
    normalize(&value)
        .trim_end_matches('/')
        .to_lowercase()
        .pipe_root()
}
trait RootString {
    fn pipe_root(self) -> String;
}
impl RootString for String {
    fn pipe_root(self) -> String {
        if self.is_empty() { "/".into() } else { self }
    }
}
fn critical(
    word: &str,
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<&'static str> {
    let value = candidate(word, state, expressions);
    if re(r"(?i)^/dev/(block/\d+:\d+|mapper/[^/]+|r?disk\d+(s\d+)?|sd[a-z]\d*|hd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|loop\d+)$").is_match(&value) || re(r"(?i)^//[.?]/(physicaldrive\d+$|globalroot/device/harddisk)").is_match(&word.replace('\\',"/")){return Some("raw-device");}
    if value == "/" || re(r"^[a-z]:/$").is_match(&value) {
        return Some("root");
    }
    if [
        "/applications",
        "/bin",
        "/boot",
        "/etc",
        "/home",
        "/lib",
        "/library",
        "/mnt",
        "/private",
        "/root",
        "/sbin",
        "/system",
        "/users",
        "/usr",
        "/var",
        "/volumes",
    ]
    .contains(&value.as_str())
        || re(r"^[a-z]:/(program files|program files \(x86\)|programdata|users|windows)$")
            .is_match(&value)
    {
        return Some("system");
    }
    if value == "/system/volumes/data" || re(r"^/(volumes|mnt)/[^/]+$").is_match(&value) {
        return Some("volume");
    }
    if re(r"^/(users|home)/[^/]+$|^[a-z]:/users/[^/]+$").is_match(&value)
        || value == normalize(&state.home.replace('\\', "/")).to_lowercase()
    {
        return Some("home");
    }
    None
}
fn first_critical<'a>(
    args: &[String],
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<&'a str> {
    args.iter()
        .filter(|arg| !arg.starts_with('-'))
        .find_map(|arg| critical(arg, state, expressions))
}
fn deletion(kind: &str, find: bool) -> String {
    match kind {
        "root" => "recursive delete of root filesystem",
        "home" if find => "recursive delete of a home directory via find",
        "home" => "recursive delete of home directory",
        "volume" => "recursive delete of mounted volume root",
        "raw-device" => "destructive write to raw device",
        _ => "recursive delete of a system or all-users directory",
    }
    .into()
}
fn delete(
    name: &str,
    args: &[String],
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<String> {
    let recursive = match name {
        "rm" => args
            .iter()
            .any(|s| s.eq_ignore_ascii_case("--recursive") || re(r"(?i)^-[^-]*r").is_match(s)),
        "remove-item" | "ri" => args
            .iter()
            .any(|s| re(r"(?i)^-recurse(:\$?true)?$").is_match(s)),
        "del" | "erase" | "rd" | "rmdir" => args
            .iter()
            .any(|s| re(r"(?i)^(/s|-recurse(:\$?true)?)$").is_match(s)),
        _ => false,
    };
    if recursive {
        first_critical(args, state, expressions).map(|kind| deletion(kind, false))
    } else {
        None
    }
}
fn literal(name: &str, args: &[String]) -> Option<String> {
    if ["bash", "dash", "fish", "ksh", "sh", "zsh"].contains(&name) {
        let i = args
            .iter()
            .position(|s| s == "-c" || re(r"^-[A-Za-z]+$").is_match(s) && s[1..].contains('c'))?;
        return args.get(i + 1).cloned();
    }
    if ["powershell", "pwsh"].contains(&name) {
        if let Some(i) = args
            .iter()
            .position(|s| re(r"(?i)^(-c|-command)$").is_match(s))
        {
            return Some(args[i + 1..].join(" "));
        }
        if let Some(i) = args
            .iter()
            .position(|s| re(r"(?i)^(-e|-enc|-encodedcommand)$").is_match(s))
        {
            let data = base64::engine::general_purpose::STANDARD
                .decode(args.get(i + 1)?)
                .ok()?;
            return Some(String::from_utf16_lossy(
                &data
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            ));
        }
    }
    if name == "cmd" {
        let i = args.iter().position(|s| re(r"(?i)^/[ck]$").is_match(s))?;
        return Some(args[i + 1..].join(" "));
    }
    if name == "eval" {
        return Some(args.join(" "));
    }
    None
}
fn record(words: &[String], state: &mut State, expressions: &BTreeMap<String, String>) {
    fn set(state: &mut State, name: &str, value: &str, expressions: &BTreeMap<String, String>) {
        let value = resolve(value, state, expressions, 0);
        state.set(name, value);
    }
    for word in words {
        if let Some((name, value)) = assignment(word) {
            set(state, name, value, expressions);
        } else {
            break;
        }
    }
    if let Some(i) = words.iter().position(|w| executable(w) == "env") {
        for word in &words[i + 1..] {
            if let Some((name, value)) = assignment(word) {
                set(state, name, value, expressions);
            }
        }
    }
    let name = words.first().map(|s| executable(s)).unwrap_or_default();
    if ["declare", "export", "readonly", "typeset"].contains(&name.as_str()) {
        for word in &words[1..] {
            if let Some((name, value)) = assignment(word) {
                set(state, name, value, expressions);
            }
        }
    }
    if name == "set"
        && words.len() > 1
        && let Some((name, value)) = assignment(&words[1..].join(" "))
    {
        set(state, name, value, expressions);
    }
    if words.len() >= 3
        && words[1] == "="
        && re(r"(?i)^\$(env:)?[A-Za-z_][A-Za-z0-9_]*$").is_match(&words[0])
    {
        let name = re(r"(?i)^\$(env:)?").replace(&words[0], "");
        set(state, &name, &words[2..].join(" "), expressions);
    }
    if name == "set-variable"
        && let Some(i) = words
            .iter()
            .position(|w| re(r"(?i)^-(name|n)$").is_match(w))
        && let Some(j) = words
            .iter()
            .position(|w| re(r"(?i)^-(value|v)$").is_match(w))
        && let (Some(name), Some(value)) = (words.get(i + 1), words.get(j + 1))
    {
        set(state, name, value, expressions);
    }
}
fn cd(
    name: &str,
    args: &[String],
    state: &mut State,
    expressions: &BTreeMap<String, String>,
) -> bool {
    if !["cd", "chdir", "pushd", "set-location", "sl"].contains(&name) {
        return false;
    }
    let target = args
        .iter()
        .find(|s| *s != "/d" && !s.starts_with('-'))
        .map(String::as_str)
        .unwrap_or(&state.home);
    state.cwd = candidate(target, state, expressions);
    state.set("PWD", state.cwd.clone());
    true
}
fn evaluate_command(
    name: &str,
    args: &[String],
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<String> {
    if ["pwd", "get-location"].contains(&name) {
        return Some(state.cwd.clone());
    }
    let args = args
        .iter()
        .map(|s| resolve(s, state, expressions, 0))
        .collect::<Vec<_>>();
    let target = args.iter().find(|s| !s.starts_with('-'));
    if ["resolve-path", "realpath"].contains(&name)
        || name == "readlink" && args.iter().any(|s| s == "-f")
    {
        return target.map(|s| candidate(s, state, &BTreeMap::new()));
    }
    if name == "dirname" {
        let normalized = candidate(target?, state, &BTreeMap::new());
        let parent = normalized.rsplit_once('/').map(|(p, _)| p).unwrap_or(".");
        return Some(if parent.is_empty() {
            "/".into()
        } else if re(r"^[a-z]:$").is_match(parent) {
            format!("{parent}/")
        } else {
            parent.into()
        });
    }
    if name == "echo" {
        return Some(
            args.iter()
                .filter(|s| *s != "-n")
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    if name == "printf" {
        let values = args
            .iter()
            .filter(|s| !s.starts_with("--"))
            .collect::<Vec<_>>();
        let format = values.first()?;
        if !format.contains('%') {
            return Some(format.strip_suffix("\\n").unwrap_or(format).to_string());
        }
        if matches!(format.as_str(), "%s" | "%s\\n") {
            return values.get(1).map(|s| (*s).clone());
        }
    }
    None
}
fn evaluate(expression: &str, state: &State, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    let mut state = state.clone();
    let lexed = lex(expression);
    let mut output = None;
    for (tokens, _) in segments(&lexed.tokens) {
        let words = words(&tokens);
        record(&words, &mut state, &lexed.expressions);
        let Some((name, args)) = unwrap(&words) else {
            continue;
        };
        if cd(&name, &args, &mut state, &lexed.expressions) {
            output = None;
        } else {
            output = evaluate_command(&name, &args, &state, &lexed.expressions);
        }
    }
    output
}
fn contains_delete(command: &str, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    for (tokens, _) in segments(&lex(command).tokens) {
        if let Some((name, args)) = unwrap(&words(&tokens)) {
            if ["rm", "unlink", "rmdir", "remove-item"].contains(&name.as_str())
                || literal(&name, &args).is_some_and(|s| contains_delete(&s, depth + 1))
            {
                return true;
            }
        }
    }
    false
}
fn xargs(args: &[String], state: &State, depth: usize, piped: Option<&str>) -> Option<String> {
    let i = skip(
        args,
        0,
        &[
            "-a",
            "--arg-file",
            "-e",
            "--eof",
            "-i",
            "--replace",
            "-l",
            "--max-lines",
            "-n",
            "--max-args",
            "-p",
            "--max-procs",
            "-s",
            "--max-chars",
        ],
    );
    let mut nested = args[i..].to_vec();
    if let Some(value) = piped {
        nested.push(value.into());
    }
    if nested.is_empty() {
        return None;
    }
    inspect(&nested.join(" "), state.clone(), depth + 1)
}
fn find(
    args: &[String],
    state: &State,
    expressions: &BTreeMap<String, String>,
    depth: usize,
) -> Option<String> {
    let start = usize::from(args.first().is_some_and(|s| s == "--"));
    let targets = args[start..]
        .iter()
        .take_while(|s| s.as_str() != "!" && s.as_str() != "(" && !s.starts_with('-'))
        .cloned()
        .collect::<Vec<_>>();
    let kind = first_critical(&targets, state, expressions)?;
    let mut destructive = args.iter().any(|s| s.eq_ignore_ascii_case("-delete"));
    for (i, arg) in args.iter().enumerate() {
        if !matches!(arg.to_lowercase().as_str(), "-exec" | "-execdir") {
            continue;
        }
        let end = args[i + 1..]
            .iter()
            .position(|s| matches!(s.as_str(), ";" | "+" | "\\;"))
            .map(|offset| offset + i + 1)
            .unwrap_or(args.len());
        let nested = &args[i + 1..end];
        if let Some((name, nested_args)) = unwrap(nested) {
            destructive |= ["rm", "unlink", "rmdir"].contains(&name.as_str())
                || literal(&name, &nested_args).is_some_and(|s| contains_delete(&s, depth + 1))
                || inspect(&nested.join(" "), state.clone(), depth + 1).is_some();
        }
    }
    if destructive {
        Some(deletion(kind, true))
    } else {
        None
    }
}
fn erase(
    name: &str,
    args: &[String],
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<String> {
    let raw = args
        .iter()
        .any(|s| critical(s, state, expressions) == Some("raw-device"));
    let reason = if re(r"^(mkfs(\..+)?|mke2fs|newfs(_.+)?)$").is_match(name) && raw {
        Some("format filesystem on raw device")
    } else if name == "format" && args.iter().any(|s| re(r"^[A-Za-z]:$").is_match(s)) {
        Some("format drive")
    } else if name == "diskutil"
        && args.iter().find(|s| !s.starts_with('-')).is_some_and(|s| {
            [
                "erasedisk",
                "erasevolume",
                "secureerase",
                "zerodisk",
                "randomdisk",
            ]
            .contains(&s.to_lowercase().as_str())
        })
    {
        Some("erase disk or volume")
    } else if name == "clear-disk"
        && !args
            .iter()
            .any(|s| re(r"(?i)^-(whatif|confirm:\$false)$").is_match(s))
    {
        Some("erase disk")
    } else if ["blkdiscard", "wipefs"].contains(&name) && raw {
        Some("erase raw block device")
    } else {
        None
    };
    reason.map(str::to_owned)
}
fn raw_write(
    name: &str,
    args: &[String],
    tokens: &[Token],
    state: &State,
    expressions: &BTreeMap<String, String>,
) -> Option<String> {
    if name == "dd"
        && args
            .iter()
            .find(|s| s.to_lowercase().starts_with("of="))
            .is_some_and(|s| critical(&s[3..], state, expressions) == Some("raw-device"))
    {
        return Some("dd to raw block device".into());
    }
    if ["cp", "install", "mv", "shred", "tee"].contains(&name)
        && args
            .iter()
            .any(|s| critical(s, state, expressions) == Some("raw-device"))
    {
        return Some("destructive write to raw device".into());
    }
    for (i, t) in tokens.iter().enumerate() {
        if !t.word
            && matches!(t.value.as_str(), ">" | ">>")
            && tokens[i + 1..]
                .iter()
                .find(|t| t.word)
                .is_some_and(|t| critical(&t.value, state, expressions) == Some("raw-device"))
        {
            return Some("redirect to raw block device".into());
        }
    }
    None
}
fn disruption(name: &str, args: &[String]) -> Option<String> {
    let help = !args.is_empty()
        && args
            .iter()
            .all(|s| re(r"(?i)^(--help|--version|/?\?)$").is_match(s));
    if name == "shutdown"
        && !help
        && !args
            .iter()
            .any(|s| re(r"(?i)^(-c|--cancel|/a)$").is_match(s))
        || ["reboot", "halt", "poweroff"].contains(&name) && !help
        || ["restart-computer", "stop-computer"].contains(&name)
            && !args
                .iter()
                .any(|s| re(r"(?i)^-(whatif|confirm:\$false)$").is_match(s))
        || ["init", "telinit"].contains(&name) && args.iter().any(|s| s == "0" || s == "6")
    {
        return Some("system shutdown/reboot".into());
    }
    if name == "systemctl"
        && !args.iter().any(|s| s == "--dry-run")
        && args.iter().find(|s| !s.starts_with('-')).is_some_and(|s| {
            ["halt", "kexec", "poweroff", "reboot"].contains(&s.to_lowercase().as_str())
        })
    {
        return Some("systemctl poweroff/reboot".into());
    }
    if name == "killall5"
        || name == "kill"
            && (args.len() >= 2 && args.last().is_some_and(|s| s == "-1")
                || args
                    .iter()
                    .position(|s| s == "--")
                    .is_some_and(|i| args[i + 1..].iter().any(|s| s == "-1")))
        || name == "taskkill"
            && args.iter().any(|s| re(r"(?i)^/(im|fi)$").is_match(s))
            && args.iter().any(|s| s == "*")
    {
        return Some("kill all processes".into());
    }
    None
}
fn pipelines(lexed: &Lexed, mut state: State, depth: usize) -> Option<String> {
    let mut prior = None::<String>;
    for (tokens, preceding) in segments(&lexed.tokens) {
        let words = words(&tokens);
        record(&words, &mut state, &lexed.expressions);
        let Some((name, args)) = unwrap(&words) else {
            prior = None;
            continue;
        };
        if preceding == "|" {
            if name == "xargs"
                && let Some(reason) = xargs(&args, &state, depth, prior.as_deref())
            {
                return Some(reason);
            }
            if let Some(value) = &prior {
                let mut augmented = args.clone();
                augmented.push(value.clone());
                if let Some(reason) = delete(&name, &augmented, &state, &lexed.expressions) {
                    return Some(reason);
                }
            }
        }
        prior = if cd(&name, &args, &mut state, &lexed.expressions) {
            None
        } else {
            evaluate_command(&name, &args, &state, &lexed.expressions)
        };
    }
    None
}
fn inspect(command: &str, mut state: State, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if re(r"^\s*:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\s*$").is_match(command) {
        return Some("fork bomb".into());
    }
    let lexed = lex(command);
    if let Some(reason) = pipelines(&lexed, state.clone(), depth) {
        return Some(reason);
    }
    for command in &lexed.nested {
        if let Some(reason) = inspect(command, state.clone(), depth + 1) {
            return Some(reason);
        }
    }
    for (tokens, _) in segments(&lexed.tokens) {
        let words = words(&tokens);
        if words.is_empty() {
            continue;
        }
        record(&words, &mut state, &lexed.expressions);
        if let Some(i) = words.iter().position(|word| executable(word) == "env") {
            let args = &words[i + 1..];
            let split = args
                .iter()
                .position(|s| s == "-S" || s == "--split-string")
                .and_then(|j| args.get(j + 1).cloned())
                .or_else(|| {
                    args.iter().find_map(|s| {
                        s.strip_prefix("--split-string=")
                            .or_else(|| s.strip_prefix("-S").filter(|s| !s.is_empty()))
                            .map(str::to_owned)
                    })
                });
            if let Some(split) = split
                && let Some(reason) = inspect(&split, state.clone(), depth + 1)
            {
                return Some(reason);
            }
        }
        let Some((name, args)) = unwrap(&words) else {
            continue;
        };
        if cd(&name, &args, &mut state, &lexed.expressions) {
            continue;
        }
        if let Some(command) = literal(&name, &args)
            && let Some(reason) = inspect(&command, state.clone(), depth + 1)
        {
            return Some(reason);
        }
        let reason = delete(&name, &args, &state, &lexed.expressions)
            .or_else(|| {
                if name == "find" {
                    find(&args, &state, &lexed.expressions, depth)
                } else {
                    None
                }
            })
            .or_else(|| {
                if name == "xargs" {
                    xargs(&args, &state, depth, None)
                } else {
                    None
                }
            })
            .or_else(|| erase(&name, &args, &state, &lexed.expressions))
            .or_else(|| raw_write(&name, &args, &tokens, &state, &lexed.expressions))
            .or_else(|| disruption(&name, &args));
        if reason.is_some() {
            return reason;
        }
    }
    None
}
pub fn reason(
    command: &str,
    cwd: &str,
    home: &str,
    environment: &BTreeMap<String, String>,
) -> Option<String> {
    let mut state = State {
        cwd: cwd.into(),
        home: home.into(),
        vars: BTreeMap::new(),
    };
    for (name, default) in [
        ("HOME", home),
        ("USERPROFILE", home),
        ("SystemRoot", "C:\\Windows"),
        ("SystemDrive", "C:"),
        ("PWD", cwd),
    ] {
        state.set(
            name,
            environment
                .get(name)
                .map(String::as_str)
                .unwrap_or(default)
                .into(),
        );
    }
    inspect(command, state, 0)
}
