//! Patch envelopes and context matching shared by native and Worker file tools.
use anyhow::{Context, Result, bail};

#[derive(Debug)]
pub enum Operation {
    Add {
        path: String,
        lines: Vec<String>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        moved_to: Option<String>,
        hunks: Vec<Hunk>,
    },
}
impl Operation {
    pub fn paths(&self) -> Vec<&str> {
        match self {
            Self::Add { path, .. } | Self::Delete { path } => vec![path],
            Self::Update { path, moved_to, .. } => std::iter::once(path.as_str())
                .chain(moved_to.as_deref())
                .collect(),
        }
    }
}
#[derive(Debug, Default)]
pub struct Hunk {
    header: Option<String>,
    lines: Vec<(char, String)>,
    eof: bool,
}
fn path(raw: &str) -> Result<String> {
    let value = raw.trim();
    if value.is_empty() {
        bail!("apply_patch requires a file path");
    }
    Ok(value.into())
}
pub fn parse(input: &str) -> Result<Vec<Operation>> {
    let normalized = input.replace("\r\n", "\n");
    let mut lines = normalized.trim().lines().collect::<Vec<_>>();
    if lines.len() >= 4
        && matches!(lines[0], "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
        && lines.last().is_some_and(|s| s.ends_with("EOF"))
    {
        lines = lines[1..lines.len() - 1].to_vec();
    }
    if lines.first().map(|s| s.trim()) != Some("*** Begin Patch") {
        bail!("apply_patch input must start with *** Begin Patch");
    }
    let mut i = 1;
    let mut operations = Vec::new();
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.trim() == "*** End Patch" {
            return Ok(operations);
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(raw) = line.strip_prefix("*** Add File: ") {
            let path = path(raw)?;
            let mut added = Vec::new();
            while i < lines.len() && !lines[i].starts_with("*** ") {
                added.push(
                    lines[i]
                        .strip_prefix('+')
                        .context("Add File lines must start with +")?
                        .to_string(),
                );
                i += 1;
            }
            operations.push(Operation::Add { path, lines: added });
            continue;
        }
        if let Some(raw) = line.strip_prefix("*** Delete File: ") {
            operations.push(Operation::Delete { path: path(raw)? });
            continue;
        }
        if let Some(raw) = line.strip_prefix("*** Update File: ") {
            let file = path(raw)?;
            let moved_to =
                if let Some(raw) = lines.get(i).and_then(|s| s.strip_prefix("*** Move to: ")) {
                    i += 1;
                    Some(path(raw)?)
                } else {
                    None
                };
            let mut hunks = Vec::new();
            while i < lines.len() {
                let next = lines[i];
                if next.starts_with("*** ") && next != "*** End of File" {
                    break;
                }
                if next.trim().is_empty() {
                    i += 1;
                    continue;
                }
                let mut hunk = Hunk::default();
                if let Some(header) = next.strip_prefix("@@") {
                    if !header.trim().is_empty() {
                        hunk.header = Some(header.trim().into());
                    }
                    i += 1;
                } else if !hunks.is_empty() {
                    bail!("Expected @@ header in Update File {file}");
                }
                while i < lines.len() {
                    let candidate = lines[i];
                    if candidate == "*** End of File" {
                        hunk.eof = true;
                        i += 1;
                        break;
                    }
                    if candidate.starts_with("*** ") || candidate.starts_with("@@") {
                        break;
                    }
                    if candidate.is_empty() {
                        hunk.lines.push((' ', String::new()));
                    } else {
                        let head = candidate.chars().next().unwrap();
                        if !matches!(head, '+' | '-' | ' ') {
                            bail!("Hunk lines must start with +, -, or space: {candidate}");
                        }
                        hunk.lines.push((head, candidate[1..].into()));
                    }
                    i += 1;
                }
                if hunk.lines.is_empty() && !hunk.eof {
                    bail!("Empty hunk in {file}");
                }
                hunks.push(hunk);
            }
            if hunks.is_empty() {
                bail!("Update File {file} has no hunks");
            }
            operations.push(Operation::Update {
                path: file,
                moved_to,
                hunks,
            });
            continue;
        }
        bail!("Unexpected patch line: {line}");
    }
    bail!("Missing *** End Patch terminator")
}
fn fuzzy(line: &str) -> String {
    line.trim()
        .chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{2018}'..='\u{201b}' => '\'',
            '\u{201c}'..='\u{201f}' => '"',
            '\u{a0}' | '\u{2002}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}
fn seek(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    let last = lines.len().checked_sub(pattern.len())?;
    let start = if eof { last } else { start };
    for mode in 0..4 {
        for at in start..=last {
            if lines[at..at + pattern.len()]
                .iter()
                .zip(pattern)
                .all(|(a, b)| match mode {
                    0 => a == b,
                    1 => a.trim_end() == b.trim_end(),
                    2 => a.trim() == b.trim(),
                    _ => fuzzy(a) == fuzzy(b),
                })
            {
                return Some(at);
            }
        }
    }
    None
}
fn exact_contains(lines: &[String], pattern: &[String]) -> bool {
    !pattern.is_empty() && lines.windows(pattern.len()).any(|window| window == pattern)
}
/// None denotes the existing already-applied receipt. It does not rewrite or
/// move a file when all requested hunks are already present.
pub fn update(original: &str, hunks: &[Hunk]) -> Result<Option<String>> {
    let trailing = original.ends_with('\n');
    let mut lines = original.split('\n').map(str::to_owned).collect::<Vec<_>>();
    if trailing {
        lines.pop();
    }
    let mut replacements = Vec::new();
    let mut cursor = 0;
    let mut already = 0;
    for hunk in hunks {
        if let Some(header) = &hunk.header {
            cursor=seek(&lines,std::slice::from_ref(header),cursor,false).with_context(||format!("Failed to find context '{header}'; re-read the file and retry with current context"))?+1;
        }
        let mut old = hunk
            .lines
            .iter()
            .filter(|(kind, _)| *kind != '+')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let mut new = hunk
            .lines
            .iter()
            .filter(|(kind, _)| *kind != '-')
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        if old.is_empty() {
            cursor = lines.len();
            replacements.push((cursor, 0, new));
            continue;
        }
        let mut found = seek(&lines, &old, cursor, hunk.eof);
        if found.is_none() && old.last().is_some_and(String::is_empty) {
            let retry = seek(&lines, &old[..old.len() - 1], cursor, hunk.eof);
            if retry.is_some() {
                old.pop();
                if new.last().is_some_and(String::is_empty) {
                    new.pop();
                }
                found = retry;
            }
        }
        let Some(at) = found else {
            if new.join("\n").encode_utf16().count() >= 8
                && exact_contains(&lines, &new)
                && !exact_contains(&lines, &old)
            {
                already += 1;
                continue;
            }
            bail!(
                "Failed to find expected lines:\n{}\nRe-read the file and retry with current context.",
                old.join("\n")
            );
        };
        if at < cursor {
            bail!("Patch hunks overlap or are out of order");
        }
        cursor = at + old.len();
        replacements.push((at, old.len(), new));
    }
    if replacements.is_empty() && already > 0 {
        return Ok(None);
    }
    replacements.sort_by_key(|(at, _, _)| *at);
    for (at, len, new) in replacements.into_iter().rev() {
        lines.splice(at..at + len, new);
    }
    let mut output = lines.join("\n");
    if trailing {
        output.push('\n');
    }
    Ok(Some(output))
}
