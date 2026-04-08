use regex::Regex;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::slice;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    parsed_args: Value,
    root: String,
    cwd: String,
    #[serde(default)]
    files: Vec<FileEntry>,
}

#[derive(Clone, Deserialize)]
struct FileEntry {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    stdout: String,
    stderr: String,
    exit_code: i32,
    runtime: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PathType {
    File,
    Directory,
}

#[derive(Clone)]
struct DirEntry {
    path: String,
    name: String,
    path_type: PathType,
}

#[derive(Clone)]
struct SnapshotIndex {
    root: String,
    files: BTreeMap<String, String>,
    directories: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LsOptions {
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadTailOptions {
    #[serde(default = "default_line_count")]
    line_count: usize,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WcOptions {
    #[serde(default)]
    count_lines: bool,
    #[serde(default)]
    count_words: bool,
    #[serde(default)]
    count_bytes: bool,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindOptions {
    #[serde(default)]
    roots: Vec<String>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
    name_pattern: Option<String>,
    max_depth: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RgOptions {
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    fixed_strings: bool,
    #[serde(default)]
    line_number: bool,
    pattern: String,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Default)]
struct TextStats {
    lines: usize,
    words: usize,
    bytes: usize,
}

fn default_line_count() -> usize {
    10
}

fn normalize_root(root: &str) -> String {
    let trimmed = root.trim();
    let base = if trimmed.is_empty() { "/workspace" } else { trimmed };
    let prefixed = if base.starts_with('/') {
        base.to_string()
    } else {
        format!("/{}", base)
    };
    let collapsed = collapse_slashes(&prefixed);
    if collapsed.len() > 1 && collapsed.ends_with('/') {
        collapsed[..collapsed.len() - 1].to_string()
    } else {
        collapsed
    }
}

fn collapse_slashes(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut last_was_slash = false;
    for ch in input.chars() {
        if ch == '/' {
            if !last_was_slash {
                result.push(ch);
            }
            last_was_slash = true;
        } else {
            result.push(ch);
            last_was_slash = false;
        }
    }
    result
}

fn normalize_path(path: &str) -> String {
    let source = if path.trim().is_empty() { "/" } else { path.trim() };
    let absolute = if source.starts_with('/') {
        source.to_string()
    } else {
        format!("/{}", source)
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in absolute.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    }
}

fn dirname(path: &str) -> String {
    let normalized = normalize_path(path);
    match normalized.rfind('/') {
        Some(index) if index > 0 => normalized[..index].to_string(),
        _ => "/".to_string(),
    }
}

fn basename(path: &str) -> String {
    let normalized = normalize_path(path);
    match normalized.rfind('/') {
        Some(index) => normalized[index + 1..].to_string(),
        None => normalized,
    }
}

fn resolve_workspace_path(root: &str, cwd: &str, input_path: Option<&str>) -> Result<String, String> {
    let normalized_root = normalize_root(root);
    let normalized_cwd = normalize_path(cwd);
    let source = input_path.unwrap_or(".").trim();

    let resolved = if source.is_empty() || source == "." {
        normalized_cwd
    } else if source == ".." {
        dirname(&normalized_cwd)
    } else if source.starts_with('/') {
        normalize_path(source)
    } else {
        normalize_path(&format!("{}/{}", normalized_cwd, source))
    };

    if resolved != normalized_root && !resolved.starts_with(&format!("{}/", normalized_root)) {
        return Err(format!("Path {} is outside workspace root {}.", source, normalized_root));
    }

    Ok(resolved)
}

fn build_snapshot_index(input: &Input) -> SnapshotIndex {
    let root = normalize_root(&input.root);
    let mut files = BTreeMap::new();
    let mut directories = BTreeSet::new();
    directories.insert(root.clone());

    for file in &input.files {
        files.insert(file.path.clone(), file.content.clone());
        let mut current = dirname(&file.path);
        loop {
            directories.insert(current.clone());
            if current == root || current == "/" {
                break;
            }
            current = dirname(&current);
        }
    }

    SnapshotIndex {
        root,
        files,
        directories,
    }
}

fn detect_path_type(index: &SnapshotIndex, path: &str) -> Option<PathType> {
    if index.files.contains_key(path) {
        Some(PathType::File)
    } else if index.directories.contains(path) {
        Some(PathType::Directory)
    } else {
        None
    }
}

fn list_children(index: &SnapshotIndex, directory_path: &str, include_hidden: bool) -> Vec<DirEntry> {
    let mut entries: BTreeMap<String, DirEntry> = BTreeMap::new();
    let prefix = format!("{}/", directory_path);

    for file_path in index.files.keys() {
        if !file_path.starts_with(&prefix) {
            continue;
        }
        let remainder = &file_path[prefix.len()..];
        let head = remainder.split('/').next().unwrap_or_default();
        if head.is_empty() {
            continue;
        }
        if !include_hidden && head.starts_with('.') {
            continue;
        }
        let child_path = normalize_path(&format!("{}/{}", directory_path, head));
        entries.entry(child_path.clone()).or_insert_with(|| DirEntry {
            path: child_path.clone(),
            name: head.to_string(),
            path_type: if file_path == &child_path {
                PathType::File
            } else {
                PathType::Directory
            },
        });
    }

    entries.into_values().collect()
}

fn compile_name_pattern(pattern: &str) -> Regex {
    let mut regex_source = String::from("^");
    for ch in pattern.chars() {
        match ch {
            '*' => regex_source.push_str(".*"),
            '?' => regex_source.push('.'),
            '.' | '+' | '^' | '$' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '\\' => {
                regex_source.push('\\');
                regex_source.push(ch);
            }
            _ => regex_source.push(ch),
        }
    }
    regex_source.push('$');
    Regex::new(&regex_source).unwrap_or_else(|_| Regex::new("^$").unwrap())
}

fn count_text_stats(text: &str) -> TextStats {
    let lines = if text.is_empty() {
        0
    } else {
        let mut count = text.split('\n').count();
        if text.ends_with('\n') {
            count = count.saturating_sub(1);
        }
        count
    };
    let words = if text.trim().is_empty() {
        0
    } else {
        text.split_whitespace().count()
    };
    let bytes = text.as_bytes().len();

    TextStats { lines, words, bytes }
}

fn format_wc_line(counts: &TextStats, options: &WcOptions, label: Option<&str>) -> String {
    let mut fields = Vec::new();
    if options.count_lines {
        fields.push(format!("{:>7}", counts.lines));
    }
    if options.count_words {
        fields.push(format!("{:>7}", counts.words));
    }
    if options.count_bytes {
        fields.push(format!("{:>7}", counts.bytes));
    }
    let mut line = fields.join("");
    if let Some(value) = label {
        if !value.is_empty() {
            line.push(' ');
            line.push_str(value);
        }
    }
    line.trim_start().to_string()
}

fn parse_options<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn command_error(message: impl Into<String>, exit_code: i32) -> Output {
    Output {
        stdout: String::new(),
        stderr: format!("{}\n", message.into()),
        exit_code,
        runtime: "wasm",
    }
}

fn command_success(stdout: String) -> Output {
    Output {
        stdout,
        stderr: String::new(),
        exit_code: 0,
        runtime: "wasm",
    }
}

fn execute_pwd(input: &Input) -> Output {
    command_success(format!("{}\n", normalize_path(&input.cwd)))
}

fn execute_ls(input: &Input, index: &SnapshotIndex) -> Output {
    let options: LsOptions = match parse_options(input.parsed_args.clone()) {
        Ok(value) => value,
        Err(error) => return command_error(format!("ls: {}", error), 2),
    };
    let targets = if options.paths.is_empty() {
        vec![".".to_string()]
    } else {
        options.paths.clone()
    };
    let mut sections = Vec::new();

    for target in targets {
        let resolved = match resolve_workspace_path(&index.root, &input.cwd, Some(&target)) {
            Ok(value) => value,
            Err(error) => return command_error(error, 1),
        };

        match detect_path_type(index, &resolved) {
            Some(PathType::File) => {
                sections.push(basename(&resolved));
            }
            Some(PathType::Directory) => {
                if !options.recursive {
                    let names = list_children(index, &resolved, options.include_hidden)
                        .into_iter()
                        .map(|entry| entry.name)
                        .collect::<Vec<_>>()
                        .join("\n");
                    sections.push(names);
                } else {
                    let mut queue = vec![resolved.clone()];
                    while let Some(current) = queue.first().cloned() {
                        queue.remove(0);
                        let entries = list_children(index, &current, options.include_hidden);
                        sections.push(format!("{}:", current));
                        sections.push(entries.iter().map(|entry| entry.name.clone()).collect::<Vec<_>>().join("\n"));
                        for entry in entries {
                            if entry.path_type == PathType::Directory {
                                queue.push(entry.path);
                            }
                        }
                    }
                }
            }
            None => return command_error(format!("ls: cannot access '{}': No such file or directory", target), 2),
        }
    }

    let filtered = sections.into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>();
    command_success(format!("{}\n", filtered.join("\n\n")))
}

fn execute_cat(input: &Input, index: &SnapshotIndex) -> Output {
    if input.args.is_empty() {
        return command_error("cat: missing file operand", 1);
    }

    let mut outputs = String::new();
    for target in &input.args {
        let resolved = match resolve_workspace_path(&index.root, &input.cwd, Some(target)) {
            Ok(value) => value,
            Err(error) => return command_error(error, 1),
        };
        let file = match index.files.get(&resolved) {
            Some(value) => value,
            None => return command_error(format!("cat: {}: No such file or directory", target), 1),
        };
        outputs.push_str(file);
    }

    command_success(outputs)
}

fn execute_head_tail(input: &Input, index: &SnapshotIndex, mode: &str) -> Output {
    let options: HeadTailOptions = match parse_options(input.parsed_args.clone()) {
        Ok(value) => value,
        Err(error) => return command_error(format!("{}: {}", mode, error), 1),
    };
    if options.files.is_empty() {
        return command_error(format!("{}: missing file operand", mode), 1);
    }

    let mut sections = Vec::new();
    for target in &options.files {
        let resolved = match resolve_workspace_path(&index.root, &input.cwd, Some(target)) {
            Ok(value) => value,
            Err(error) => return command_error(error, 1),
        };
        let file = match index.files.get(&resolved) {
            Some(value) => value,
            None => {
                return command_error(
                    format!("{}: cannot open '{}' for reading: No such file or directory", mode, target),
                    1,
                )
            }
        };

        let mut lines = file.split('\n').map(|line| line.to_string()).collect::<Vec<_>>();
        if lines.last().map(|line| line.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        let selected = if mode == "head" {
            lines.into_iter().take(options.line_count).collect::<Vec<_>>()
        } else {
            let len = lines.len();
            lines.into_iter().skip(len.saturating_sub(options.line_count)).collect::<Vec<_>>()
        };
        if options.files.len() > 1 {
            sections.push(format!("==> {} <==", target));
        }
        sections.push(selected.join("\n"));
    }

    command_success(format!(
        "{}{}",
        sections.join("\n"),
        if sections.is_empty() { "" } else { "\n" }
    ))
}

fn execute_wc(input: &Input, index: &SnapshotIndex) -> Output {
    let mut options: WcOptions = match parse_options(input.parsed_args.clone()) {
        Ok(value) => value,
        Err(error) => return command_error(format!("wc: {}", error), 1),
    };
    if !options.count_lines && !options.count_words && !options.count_bytes {
        options.count_lines = true;
        options.count_words = true;
        options.count_bytes = true;
    }
    if options.files.is_empty() {
        return command_error("wc: missing file operand", 1);
    }

    let mut lines = Vec::new();
    let mut total = TextStats::default();
    for target in &options.files {
        let resolved = match resolve_workspace_path(&index.root, &input.cwd, Some(target)) {
            Ok(value) => value,
            Err(error) => return command_error(error, 1),
        };
        let file = match index.files.get(&resolved) {
            Some(value) => value,
            None => return command_error(format!("wc: {}: No such file or directory", target), 1),
        };
        let stats = count_text_stats(file);
        total.lines += stats.lines;
        total.words += stats.words;
        total.bytes += stats.bytes;
        lines.push(format_wc_line(&stats, &options, Some(target)));
    }

    if options.files.len() > 1 {
        lines.push(format_wc_line(&total, &options, Some("total")));
    }

    command_success(format!("{}\n", lines.join("\n")))
}

fn execute_find(input: &Input, index: &SnapshotIndex) -> Output {
    let options: FindOptions = match parse_options(input.parsed_args.clone()) {
        Ok(value) => value,
        Err(error) => return command_error(format!("find: {}", error), 1),
    };
    let roots = if options.roots.is_empty() {
        vec![".".to_string()]
    } else {
        options.roots.clone()
    };
    let matcher = options.name_pattern.as_deref().map(compile_name_pattern);
    let mut candidates = index
        .directories
        .iter()
        .cloned()
        .chain(index.files.keys().cloned())
        .collect::<Vec<_>>();
    candidates.sort();
    let mut matches = Vec::new();

    for root_target in roots {
        let current_root = match resolve_workspace_path(&index.root, &input.cwd, Some(&root_target)) {
            Ok(value) => value,
            Err(error) => return command_error(error, 1),
        };
        let root_type = detect_path_type(index, &current_root);
        if root_type.is_none() {
            return command_error(format!("find: '{}': No such file or directory", current_root), 1);
        }

        for path in &candidates {
            if path != &current_root && !path.starts_with(&format!("{}/", current_root)) {
                continue;
            }
            let depth = if path == &current_root {
                0
            } else {
                path[current_root.len() + 1..].split('/').count()
            };
            if let Some(max_depth) = options.max_depth {
                if depth > max_depth {
                    continue;
                }
            }
            let entry_type = detect_path_type(index, path).unwrap();
            if options.entry_type.as_deref() == Some("f") && entry_type != PathType::File {
                continue;
            }
            if options.entry_type.as_deref() == Some("d") && entry_type != PathType::Directory {
                continue;
            }
            if let Some(pattern) = &matcher {
                if !pattern.is_match(&basename(path)) {
                    continue;
                }
            }
            matches.push(path.clone());
        }
    }

    command_success(format!(
        "{}{}",
        matches.join("\n"),
        if matches.is_empty() { "" } else { "\n" }
    ))
}

fn execute_rg(input: &Input, index: &SnapshotIndex) -> Output {
    let options: RgOptions = match parse_options(input.parsed_args.clone()) {
        Ok(value) => value,
        Err(error) => return command_error(format!("rg: {}", error), 2),
    };
    let paths = if options.paths.is_empty() {
        vec![".".to_string()]
    } else {
        options.paths.clone()
    };
    let resolved_paths = match paths
        .iter()
        .map(|path| resolve_workspace_path(&index.root, &input.cwd, Some(path)))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(value) => value,
        Err(error) => return command_error(error, 1),
    };

    let matcher = if options.fixed_strings {
        None
    } else {
        let pattern = if options.ignore_case {
            format!("(?i){}", options.pattern)
        } else {
            options.pattern.clone()
        };
        match Regex::new(&pattern) {
            Ok(value) => Some(value),
            Err(error) => return command_error(format!("rg: invalid regex '{}': {}", options.pattern, error), 2),
        }
    };

    let mut matched_lines = Vec::new();
    for (file_path, content) in &index.files {
        let allowed = resolved_paths.iter().any(|target| {
            file_path == target || file_path.starts_with(&format!("{}/", target))
        });
        if !allowed {
            continue;
        }

        for (index_line, line) in content.split('\n').enumerate() {
            let matched = if options.fixed_strings {
                if options.ignore_case {
                    line.to_lowercase().contains(&options.pattern.to_lowercase())
                } else {
                    line.contains(&options.pattern)
                }
            } else {
                matcher.as_ref().map(|value| value.is_match(line)).unwrap_or(false)
            };

            if matched {
                let prefix = if options.line_number || !options.line_number {
                    format!("{}:{}:", file_path, index_line + 1)
                } else {
                    format!("{}:", file_path)
                };
                matched_lines.push(format!("{}{}", prefix, line));
            }
        }
    }

    Output {
        stdout: if matched_lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", matched_lines.join("\n"))
        },
        stderr: String::new(),
        exit_code: if matched_lines.is_empty() { 1 } else { 0 },
        runtime: "wasm",
    }
}

fn execute(input: Input) -> Output {
    let index = build_snapshot_index(&input);
    match input.executable.as_str() {
        "pwd" => execute_pwd(&input),
        "ls" => execute_ls(&input, &index),
        "cat" => execute_cat(&input, &index),
        "head" => execute_head_tail(&input, &index, "head"),
        "tail" => execute_head_tail(&input, &index, "tail"),
        "wc" => execute_wc(&input, &index),
        "find" => execute_find(&input, &index),
        "rg" => execute_rg(&input, &index),
        other => command_error(format!("worker wasm runtime does not support {}", other), 127),
    }
}

fn pack_ptr_len(ptr: *mut u8, len: usize) -> u64 {
    ((ptr as u64) << 32) | (len as u64)
}

fn run(bytes: &[u8]) -> Vec<u8> {
    let output = match serde_json::from_slice::<Input>(bytes) {
        Ok(input) => execute(input),
        Err(error) => command_error(format!("Invalid wasm command payload: {}", error), 1),
    };
    serde_json::to_vec(&output).unwrap_or_else(|error| {
        serde_json::to_vec(&command_error(format!("Failed to serialize wasm output: {}", error), 1))
            .unwrap_or_else(|_| b"{\"stdout\":\"\",\"stderr\":\"serialization failure\\n\",\"exitCode\":1,\"runtime\":\"wasm\"}".to_vec())
    })
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = vec![0u8; len];
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

#[no_mangle]
pub extern "C" fn execute_command(ptr: *const u8, len: usize) -> u64 {
    let input = unsafe { slice::from_raw_parts(ptr, len) };
    let mut output = run(input);
    let out_ptr = output.as_mut_ptr();
    let out_len = output.len();
    std::mem::forget(output);
    pack_ptr_len(out_ptr, out_len)
}
