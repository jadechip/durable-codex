import { previewText } from "./trace.js";
import {
  hasEnvAssignmentPrefix,
  hasUnquotedShellSyntax,
  tokenizeCommand,
} from "./command-parsing.js";
import { executeWorkerCommandInWasm } from "./worker-command-wasm-runtime.js";

export const WORKER_COMMAND_DRIVER_NAME = "workerBuiltin";

const SIMPLE_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "rg",
]);

const SHELL_OPERATOR_TOKENS = new Set(["|", "||", "&&", ";", "<", ">", ">>", "<<"]);
const GLOB_SYNTAX = /[*?[\]{}]/;
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

function normalizeRoot(root) {
  if (typeof root !== "string" || !root.trim()) {
    return "/workspace";
  }
  const normalized = root.startsWith("/") ? root : `/${root}`;
  return normalized.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function dirname(path) {
  const normalized = path.replace(/\/+/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function basename(path) {
  const normalized = path.replace(/\/+/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function quoteHeader(path) {
  return `==> ${path} <==`;
}

function normalizePath(path) {
  const source = typeof path === "string" && path.trim() ? path.trim() : "/";
  const absolute = source.startsWith("/") ? source : `/${source}`;
  const segments = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}` || "/";
}

function joinPath(base, next) {
  if (next.startsWith("/")) {
    return normalizePath(next);
  }
  return normalizePath(`${base}/${next}`);
}

function resolveWorkspacePath(root, cwd, inputPath = null) {
  const normalizedRoot = normalizeRoot(root);
  const normalizedCwd = normalizePath(cwd ?? normalizedRoot);
  const source = typeof inputPath === "string" && inputPath.trim() ? inputPath.trim() : ".";

  let resolved;
  if (source === ".") {
    resolved = normalizedCwd;
  } else if (source === "..") {
    resolved = dirname(normalizedCwd);
  } else if (source.startsWith("/")) {
    resolved = normalizePath(source);
  } else {
    resolved = joinPath(normalizedCwd, source);
  }

  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Path ${source} is outside workspace root ${normalizedRoot}.`);
  }

  return resolved;
}

function buildSnapshotIndex(snapshot) {
  const files = new Map();
  const directories = new Map();
  const root = normalizeRoot(snapshot?.workspace?.root ?? snapshot?.root ?? "/workspace");

  directories.set(root, {
    path: root,
    name: basename(root),
  });

  for (const file of Array.isArray(snapshot?.files) ? snapshot.files : []) {
    if (!file || typeof file.path !== "string" || !file.path) {
      continue;
    }
    files.set(file.path, file);

    let current = dirname(file.path);
    while (current && !directories.has(current)) {
      directories.set(current, {
        path: current,
        name: basename(current),
      });
      if (current === root || current === "/") {
        break;
      }
      current = dirname(current);
    }
  }

  return {
    root,
    files,
    directories,
  };
}

function detectPathType(index, absolutePath) {
  if (index.files.has(absolutePath)) {
    return "file";
  }
  if (index.directories.has(absolutePath)) {
    return "directory";
  }
  return null;
}

function listChildren(index, directoryPath, { includeHidden = false } = {}) {
  const entries = new Map();

  for (const filePath of index.files.keys()) {
    if (!filePath.startsWith(`${directoryPath}/`)) {
      continue;
    }
    const remainder = filePath.slice(directoryPath.length + 1);
    const [head] = remainder.split("/");
    if (!head) {
      continue;
    }
    const childPath = `${directoryPath}/${head}`.replace(/\/+/g, "/");
    if (entries.has(childPath)) {
      continue;
    }
    const hidden = head.startsWith(".");
    if (!includeHidden && hidden) {
      continue;
    }
    entries.set(childPath, {
      path: childPath,
      name: head,
      type: filePath === childPath ? "file" : "directory",
    });
  }

  return [...entries.values()].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function compileNamePattern(pattern) {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&");
  const regex = escaped
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`);
}

function approximateTokenCount(text) {
  if (typeof text !== "string" || !text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function truncateOutput(text, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
  const value = typeof text === "string" ? text : "";
  const originalTokenCount = approximateTokenCount(value);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return {
      outputText: value,
      originalTokenCount,
    };
  }

  const maxChars = Math.max(1, maxOutputTokens * 4);
  if (value.length <= maxChars) {
    return {
      outputText: value,
      originalTokenCount,
    };
  }

  return {
    outputText: `${value.slice(0, maxChars)}\n...[output truncated]`,
    originalTokenCount,
  };
}

function buildCommandResult({
  stdout = "",
  stderr = "",
  exitCode = 0,
  durationMs = 0,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  route = null,
}) {
  const combined = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
    .filter(Boolean)
    .join("\n\n") || `exit_code: ${exitCode}`;
  const truncated = truncateOutput(combined, maxOutputTokens);
  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    outputText: truncated.outputText,
    durationMs,
    infrastructureError: false,
    sessionOpen: false,
    changedFiles: [],
    removedPaths: [],
    originalTokenCount: truncated.originalTokenCount,
    driver: WORKER_COMMAND_DRIVER_NAME,
    route,
  };
}

function buildCommandError(message, {
  exitCode = 1,
  durationMs = 0,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  route = null,
} = {}) {
  return buildCommandResult({
    stdout: "",
    stderr: `${message}\n`,
    exitCode,
    durationMs,
    maxOutputTokens,
    route,
  });
}

function parseLsArguments(args) {
  const options = {
    includeHidden: false,
    recursive: false,
    singleColumn: false,
    paths: [],
  };

  for (const arg of args) {
    if (arg === "-a") {
      options.includeHidden = true;
      continue;
    }
    if (arg === "-R") {
      options.recursive = true;
      continue;
    }
    if (arg === "-1") {
      options.singleColumn = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    options.paths.push(arg);
  }

  return options;
}

function parseHeadTailArguments(args) {
  const options = {
    lineCount: 10,
    files: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-n") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        return null;
      }
      options.lineCount = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    options.files.push(arg);
  }

  return options;
}

function parseWcArguments(args) {
  const options = {
    countLines: false,
    countWords: false,
    countBytes: false,
    files: [],
  };

  for (const arg of args) {
    if (arg === "-l") {
      options.countLines = true;
      continue;
    }
    if (arg === "-w") {
      options.countWords = true;
      continue;
    }
    if (arg === "-c") {
      options.countBytes = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    options.files.push(arg);
  }

  if (!options.countLines && !options.countWords && !options.countBytes) {
    options.countLines = true;
    options.countWords = true;
    options.countBytes = true;
  }

  return options;
}

function parseFindArguments(args) {
  const options = {
    roots: [],
    type: null,
    namePattern: null,
    maxDepth: null,
  };

  let index = 0;
  while (index < args.length && !args[index].startsWith("-")) {
    options.roots.push(args[index]);
    index += 1;
  }

  while (index < args.length) {
    const arg = args[index];
    if (arg === "-type") {
      const value = args[index + 1];
      if (!value || !["f", "d"].includes(value)) {
        return null;
      }
      options.type = value;
      index += 2;
      continue;
    }
    if (arg === "-name") {
      const value = args[index + 1];
      if (!value) {
        return null;
      }
      options.namePattern = value;
      index += 2;
      continue;
    }
    if (arg === "-maxdepth") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        return null;
      }
      options.maxDepth = Number.parseInt(value, 10);
      index += 2;
      continue;
    }
    return null;
  }

  return options;
}

function parseRgArguments(args) {
  const options = {
    ignoreCase: false,
    fixedStrings: false,
    lineNumber: false,
    pattern: null,
    paths: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-i") {
      options.ignoreCase = true;
      continue;
    }
    if (arg === "-F") {
      options.fixedStrings = true;
      continue;
    }
    if (arg === "-n" || arg === "--line-number") {
      options.lineNumber = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    if (options.pattern == null) {
      options.pattern = arg;
      continue;
    }
    options.paths.push(arg);
  }

  return options.pattern ? options : null;
}

function resolveCommandPlan(command) {
  if (typeof command !== "string" || !command.trim()) {
    return null;
  }
  if (hasUnquotedShellSyntax(command)) {
    return null;
  }

  const tokens = tokenizeCommand(command);
  if (!tokens || hasEnvAssignmentPrefix(tokens) || tokens.some((token) => SHELL_OPERATOR_TOKENS.has(token))) {
    return null;
  }

  const [executable, ...args] = tokens;
  if (!SIMPLE_COMMANDS.has(executable)) {
    return null;
  }

  let parsedArgs = null;
  switch (executable) {
    case "ls":
      parsedArgs = parseLsArguments(args);
      break;
    case "head":
    case "tail":
      parsedArgs = parseHeadTailArguments(args);
      break;
    case "wc":
      parsedArgs = parseWcArguments(args);
      break;
    case "find":
      parsedArgs = parseFindArguments(args);
      break;
    case "rg":
      parsedArgs = parseRgArguments(args);
      break;
    default:
      parsedArgs = { args };
      break;
  }

  if (parsedArgs == null) {
    return null;
  }

  if (["pwd", "ls", "cat", "head", "tail", "wc"].includes(executable) && args.some((arg) => GLOB_SYNTAX.test(arg))) {
    return null;
  }

  if (executable === "find") {
    if ((parsedArgs.roots ?? []).some((arg) => GLOB_SYNTAX.test(arg))) {
      return null;
    }
  }

  return {
    executable,
    args,
    parsedArgs,
    command,
  };
}

function formatWcLine(counts, label = "") {
  const fields = [];
  if (counts.countLines) {
    fields.push(String(counts.lines).padStart(7, " "));
  }
  if (counts.countWords) {
    fields.push(String(counts.words).padStart(7, " "));
  }
  if (counts.countBytes) {
    fields.push(String(counts.bytes).padStart(7, " "));
  }
  return `${fields.join("")}${label ? ` ${label}` : ""}`.trimStart();
}

function countTextStats(text) {
  const value = typeof text === "string" ? text : "";
  return {
    lines: value.length === 0 ? 0 : value.split("\n").length - (value.endsWith("\n") ? 1 : 0),
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
    bytes: new TextEncoder().encode(value).byteLength,
  };
}

function relativeToRoot(root, path) {
  if (path === root) {
    return ".";
  }
  if (path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1);
  }
  return path;
}

export function createWorkerCommandDriver({
  workspaceStore,
  trace = () => {},
  now = () => Date.now(),
} = {}) {
  return {
    name: WORKER_COMMAND_DRIVER_NAME,
    resolve(request) {
      if (!request || typeof request !== "object") {
        return null;
      }
      if (request.tty) {
        return null;
      }
      if (typeof request.shell === "string" && request.shell.trim()) {
        return null;
      }
      return resolveCommandPlan(request.command ?? request.cmd ?? null);
    },
    async execute(thread, {
      command,
      cwd = null,
      maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
      route,
    } = {}) {
      const startedAt = now();
      const snapshot = await workspaceStore.exportWorkspaceSnapshot(thread);
      const index = buildSnapshotIndex(snapshot);
      const resolvedCwd = resolveWorkspacePath(index.root, cwd ?? thread.cwd ?? index.root, ".");

      trace("worker.exec.start", {
        executable: route?.executable ?? null,
        cwd: resolvedCwd,
        commandPreview: previewText(command ?? ""),
      });

      try {
        const wasmResult = await executeWorkerCommandInWasm({
          executable: route?.executable ?? null,
          args: Array.isArray(route?.args) ? route.args : [],
          parsedArgs: route?.parsedArgs ?? {},
          root: index.root,
          cwd: resolvedCwd,
          files: snapshot.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        });
        const result = buildCommandResult({
          stdout: typeof wasmResult?.stdout === "string" ? wasmResult.stdout : "",
          stderr: typeof wasmResult?.stderr === "string" ? wasmResult.stderr : "",
          exitCode: Number.isFinite(wasmResult?.exitCode) ? wasmResult.exitCode : 1,
          durationMs: Math.max(0, now() - startedAt),
          maxOutputTokens,
          route,
        });
        trace("worker.exec.result", {
          executable: route?.executable ?? null,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          outputPreview: previewText(result.outputText ?? ""),
        });
        return result;
      } catch (error) {
        trace("worker.exec.error", {
          executable: route?.executable ?? null,
          error,
        });
        return buildCommandError(error instanceof Error ? error.message : String(error), {
          exitCode: 1,
          durationMs: Math.max(0, now() - startedAt),
          maxOutputTokens,
          route,
        });
      }
    },
  };
}
