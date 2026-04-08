import { previewText } from "./trace.js";
import { hasUnquotedShellSyntax, tokenizeCommand } from "./command-parsing.js";

export const DYNAMIC_WORKER_DRIVER_NAME = "dynamicWorker";

function encodeBase64Utf8(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function normalizeRoot(root) {
  if (typeof root !== "string" || !root.trim()) {
    return "/workspace";
  }
  const normalized = root.startsWith("/") ? root : `/${root}`;
  const withoutDouble = normalized.replace(/\/+/g, "/");
  return withoutDouble.length > 1 && withoutDouble.endsWith("/") ? withoutDouble.slice(0, -1) : withoutDouble;
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

function dirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function resolvePath(base, next) {
  if (typeof next !== "string" || !next.trim()) {
    return normalizePath(base);
  }
  return next.startsWith("/") ? normalizePath(next) : normalizePath(`${base}/${next}`);
}

function isMaybeScriptPath(token) {
  return typeof token === "string" && !token.startsWith("-") && /\.(c?js)$/.test(token);
}

function isMaybePythonScriptPath(token) {
  return typeof token === "string" && !token.startsWith("-") && /\.py$/.test(token);
}

const PYTHON_SANDBOX_ONLY_MODULES = new Set([
  "ctypes",
  "ensurepip",
  "fcntl",
  "multiprocessing",
  "pip",
  "pty",
  "resource",
  "subprocess",
  "termios",
  "venv",
]);

const PYTHON_SANDBOX_ONLY_PATTERNS = [
  { regex: /\bos\.(system|popen|fork|spawnl|spawnle|spawnlp|spawnlpe|spawnv|spawnve|spawnvp|spawnvpe|execl|execle|execlp|execlpe|execv|execve|execvp|execvpe|posix_spawn)\b/, reason: "python-process-api" },
  { regex: /\basyncio\.create_subprocess_(exec|shell)\b/, reason: "python-async-subprocess" },
];

function buildSnapshotFileMap(snapshot) {
  return Object.fromEntries(
    (Array.isArray(snapshot?.files) ? snapshot.files : [])
      .filter((file) => normalizeContentEncodingForSnapshot(file?.contentEncoding) !== "base64")
      .map((file) => [file.path, typeof file.content === "string" ? file.content : ""]),
  );
}

function buildSnapshotBinaryFileMap(snapshot) {
  return Object.fromEntries(
    (Array.isArray(snapshot?.files) ? snapshot.files : [])
      .filter((file) => normalizeContentEncodingForSnapshot(file?.contentEncoding) === "base64")
      .map((file) => [file.path, typeof file.contentBase64 === "string" ? file.contentBase64 : ""]),
  );
}

function buildSnapshotFileMetadataMap(snapshot) {
  return Object.fromEntries(
    (Array.isArray(snapshot?.files) ? snapshot.files : [])
      .map((file) => [
        file.path,
        {
          contentType: typeof file.contentType === "string" && file.contentType ? file.contentType : null,
          contentEncoding: normalizeContentEncodingForSnapshot(file?.contentEncoding),
        },
      ]),
  );
}

function normalizeContentEncodingForSnapshot(value) {
  return value === "base64" ? "base64" : "utf8";
}

function getSnapshotFile(snapshot, absolutePath) {
  return (Array.isArray(snapshot?.files) ? snapshot.files : []).find((file) => file?.path === absolutePath) ?? null;
}

function getSnapshotTextContent(snapshot, absolutePath) {
  const file = getSnapshotFile(snapshot, absolutePath);
  if (!file || normalizeContentEncodingForSnapshot(file.contentEncoding) === "base64") {
    return null;
  }
  return typeof file.content === "string" ? file.content : "";
}

function collectLocalPythonModules(snapshot, workspaceRoot = "/workspace") {
  const modules = new Set();
  for (const file of Array.isArray(snapshot?.files) ? snapshot.files : []) {
    if (!file || typeof file.path !== "string" || normalizeContentEncodingForSnapshot(file.contentEncoding) === "base64") {
      continue;
    }
    if (!file.path.startsWith(`${workspaceRoot}/`)) {
      continue;
    }
    const relativePath = file.path.slice(workspaceRoot.length + 1);
    if (relativePath.endsWith("/__init__.py")) {
      modules.add(relativePath.slice(0, -"/__init__.py".length).split("/")[0]);
      continue;
    }
    if (relativePath.endsWith(".py")) {
      modules.add(relativePath.slice(0, -3).split("/")[0]);
    }
  }
  return modules;
}

function extractPythonImportRoots(source) {
  const text = typeof source === "string" ? source : "";
  const modules = new Set();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const statement of line.split(";")) {
      const trimmed = statement.trim();
      if (!trimmed) {
        continue;
      }
      const importMatch = trimmed.match(/^import\s+(.+)$/);
      if (importMatch) {
        for (const part of importMatch[1].split(",")) {
          const cleaned = part.trim().replace(/\s+as\s+.+$/, "");
          if (cleaned) {
            modules.add(cleaned.split(".")[0]);
          }
        }
        continue;
      }

      const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/);
      if (fromMatch) {
        modules.add(fromMatch[1].split(".")[0]);
      }
    }
  }
  return modules;
}

function detectPythonSandboxRequirement(source, localModules = new Set()) {
  const text = typeof source === "string" ? source : "";
  if (!text.trim()) {
    return null;
  }

  for (const moduleName of extractPythonImportRoots(text)) {
    if (localModules.has(moduleName)) {
      continue;
    }
    if (PYTHON_SANDBOX_ONLY_MODULES.has(moduleName)) {
      return {
        kind: "python-sandbox-only-module",
        module: moduleName,
      };
    }
  }

  for (const pattern of PYTHON_SANDBOX_ONLY_PATTERNS) {
    if (pattern.regex.test(text)) {
      return {
        kind: pattern.reason,
      };
    }
  }

  return null;
}

function parsePythonMissingModule(stderr) {
  if (typeof stderr !== "string" || !stderr) {
    return null;
  }
  const match = stderr.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
  return match ? match[1].split(".")[0] : null;
}

function buildCommonJsFactoriesSource(payload) {
  const factories = [];
  const files = payload?.files && typeof payload.files === "object" ? payload.files : {};

  if (payload?.mode === "eval" && typeof payload.code === "string") {
    factories.push(
      `moduleFactories["/workspace/[eval].js"] = function(require, module, exports, __filename, __dirname, process, console) {\n${payload.code}\n};`,
    );
  }

  for (const [path, source] of Object.entries(files)) {
    if (typeof path !== "string" || !path) {
      continue;
    }
    if (path.endsWith(".json")) {
      factories.push(
        `moduleFactories[${JSON.stringify(path)}] = function(require, module, exports) {\nmodule.exports = JSON.parse(${JSON.stringify(source)});\n};`,
      );
      continue;
    }
    if (/\.(c?js)$/.test(path)) {
      factories.push(
        `moduleFactories[${JSON.stringify(path)}] = function(require, module, exports, __filename, __dirname, process, console) {\n${source}\n};`,
      );
    }
  }

  return factories.join("\n");
}

function buildDynamicWorkerSource(payload) {
  const entryPath = payload?.mode === "eval"
    ? "/workspace/[eval].js"
    : (typeof payload?.entryPath === "string" ? payload.entryPath : null);
  return `
const PAYLOAD = ${JSON.stringify(payload)};
const ENTRY_PATH = ${JSON.stringify(entryPath)};
const moduleFactories = Object.create(null);
${buildCommonJsFactoriesSource(payload)}

function normalizePath(path) {
  const source = typeof path === "string" && path.trim() ? path.trim() : "/";
  const absolute = source.startsWith("/") ? source : \`/\${source}\`;
  const segments = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return \`/\${segments.join("/")}\` || "/";
}
function dirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}
function resolvePath(base, next) {
  if (typeof next !== "string" || !next.trim()) return normalizePath(base);
  return next.startsWith("/") ? normalizePath(next) : normalizePath(base + "/" + next);
}
function basename(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}
function extname(path) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

function createRuntime(payload) {
  const originalFiles = new Map(Object.entries(payload.files || {}));
  const files = new Map(originalFiles);
  const stdout = [];
  const stderr = [];
  const moduleCache = new Map();

  function capture(stream, args) {
    const text = args.map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }).join(" ");
    stream.push(text);
  }

  const consoleShim = {
    log: (...args) => capture(stdout, args),
    error: (...args) => capture(stderr, args),
    warn: (...args) => capture(stderr, args),
  };

  function listDirectory(target) {
    const normalized = normalizePath(target);
    const names = new Set();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(normalized === "/" ? "/" : normalized + "/")) continue;
      const remainder = normalized === "/" ? filePath.slice(1) : filePath.slice(normalized.length + 1);
      const [head] = remainder.split("/");
      if (head) names.add(head);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  const fsShim = {
    readFileSync(path, encoding = "utf8") {
      const resolved = resolvePath(payload.cwd, path);
      if (!files.has(resolved)) throw new Error(\`ENOENT: no such file or directory, open '\${resolved}'\`);
      const value = files.get(resolved);
      if (encoding === "utf8" || encoding === "utf-8") return value;
      return value;
    },
    writeFileSync(path, value) {
      const resolved = resolvePath(payload.cwd, path);
      files.set(resolved, typeof value === "string" ? value : String(value ?? ""));
    },
    appendFileSync(path, value) {
      const resolved = resolvePath(payload.cwd, path);
      const next = (files.get(resolved) ?? "") + (typeof value === "string" ? value : String(value ?? ""));
      files.set(resolved, next);
    },
    existsSync(path) {
      const resolved = resolvePath(payload.cwd, path);
      if (files.has(resolved)) return true;
      return listDirectory(resolved).length > 0;
    },
    mkdirSync() {},
    readdirSync(path) {
      return listDirectory(resolvePath(payload.cwd, path));
    },
    rmSync(path, options = {}) {
      const resolved = resolvePath(payload.cwd, path);
      if (files.has(resolved)) {
        files.delete(resolved);
        return;
      }
      if (!options.recursive) {
        throw new Error(\`ENOENT: no such file or directory, lstat '\${resolved}'\`);
      }
      for (const filePath of [...files.keys()]) {
        if (filePath.startsWith(resolved === "/" ? "/" : resolved + "/")) {
          files.delete(filePath);
        }
      }
    },
    statSync(path) {
      const resolved = resolvePath(payload.cwd, path);
      if (files.has(resolved)) {
        const content = files.get(resolved);
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: new TextEncoder().encode(content).byteLength,
        };
      }
      const isDirectory = listDirectory(resolved).length > 0;
      if (isDirectory) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
        };
      }
      throw new Error(\`ENOENT: no such file or directory, stat '\${resolved}'\`);
    },
  };

  const pathShim = {
    join: (...parts) => normalizePath(parts.join("/")),
    resolve: (...parts) => normalizePath(parts.join("/")),
    dirname,
    basename,
    extname,
  };

  const processShim = {
    argv: ["node", payload.entryPath ?? "[eval]", ...(payload.args ?? [])],
    env: payload.env ?? {},
    cwd() {
      return payload.cwd;
    },
    exit(code = 0) {
      const error = new Error("__PROCESS_EXIT__");
      error.exitCode = code;
      throw error;
    },
  };

  const specialModules = {
    fs: fsShim,
    "node:fs": fsShim,
    path: pathShim,
    "node:path": pathShim,
    process: processShim,
    "node:process": processShim,
  };

  function resolveModule(specifier, parentPath) {
    if (specialModules[specifier]) return { type: "builtin", value: specialModules[specifier] };
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      throw new Error(\`Unsupported dynamic worker module: \${specifier}\`);
    }
    const baseDir = parentPath ? dirname(parentPath) : payload.cwd;
    const resolved = resolvePath(baseDir, specifier);
    const candidates = [resolved];
    if (!resolved.endsWith(".js") && !resolved.endsWith(".cjs") && !resolved.endsWith(".json")) {
      candidates.push(\`\${resolved}.js\`, \`\${resolved}.cjs\`, \`\${resolved}.json\`);
    }
    for (const candidate of candidates) {
      if (moduleFactories[candidate] || files.has(candidate)) return { type: "file", value: candidate };
    }
    throw new Error(\`Cannot resolve module '\${specifier}' from '\${parentPath ?? payload.cwd}'\`);
  }

  function runModule(path) {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const module = { exports: {} };
    moduleCache.set(path, module);
    const localRequire = (specifier) => {
      const resolved = resolveModule(specifier, path);
      if (resolved.type === "builtin") return resolved.value;
      return runModule(resolved.value);
    };
    const factory = moduleFactories[path];
    if (typeof factory !== "function") {
      throw new Error(\`Unsupported dynamic worker module format for '\${path}'\`);
    }
    factory(localRequire, module, module.exports, path, dirname(path), processShim, consoleShim);
    return module.exports;
  }

  async function run() {
    let exitCode = 0;
    try {
      if (!ENTRY_PATH) throw new Error("Dynamic worker has no entry module.");
      runModule(ENTRY_PATH);
    } catch (error) {
      if (error && error.message === "__PROCESS_EXIT__") {
        exitCode = Number.isFinite(error.exitCode) ? error.exitCode : 0;
      } else {
        exitCode = 1;
        capture(stderr, [error && error.stack ? error.stack : String(error)]);
      }
    }

    const changedFiles = [];
    const removedPaths = [];
    for (const [path, content] of files.entries()) {
      if (originalFiles.get(path) !== content) {
        changedFiles.push({ path, content });
      }
    }
    for (const path of originalFiles.keys()) {
      if (!files.has(path)) removedPaths.push(path);
    }

    const stdoutText = stdout.length > 0 ? stdout.join("\\n") + "\\n" : "";
    const stderrText = stderr.length > 0 ? stderr.join("\\n") + "\\n" : "";
    return {
      stdout: stdoutText,
      stderr: stderrText,
      exitCode,
      changedFiles,
      removedPaths,
    };
  }

  return { run };
}

export default {
  async fetch() {
    const runtime = createRuntime(PAYLOAD);
    const result = await runtime.run();
    return Response.json(result);
  },
};
`;
}

function buildPythonDynamicWorkerSource(payload) {
  const payloadBase64 = encodeBase64Utf8(JSON.stringify(payload));
  return `
from workers import WorkerEntrypoint, Response
import base64
import builtins
import importlib.abc
import importlib.util
import io
import json
import os
import posixpath
import sys
import traceback

PAYLOAD = json.loads(base64.b64decode("${payloadBase64}").decode("utf-8"))

def coerce_path(value):
    if isinstance(value, str):
        return value
    if hasattr(value, "__fspath__"):
        return value.__fspath__()
    if value is None:
        return ""
    return str(value)

def normalize_path(path):
    raw = coerce_path(path)
    source = raw.strip() if isinstance(raw, str) and raw.strip() else "/"
    absolute = source if source.startswith("/") else "/" + source
    normalized = posixpath.normpath(absolute)
    return normalized if normalized.startswith("/") else "/" + normalized

def dirname(path):
    normalized = normalize_path(path)
    if normalized == "/":
        return "/"
    parent = posixpath.dirname(normalized)
    return parent if parent else "/"

def resolve_path(base, next_path):
    candidate = coerce_path(next_path)
    if not isinstance(candidate, str) or not candidate.strip():
        return normalize_path(base)
    return normalize_path(candidate if candidate.startswith("/") else posixpath.join(base, candidate))

ROOT = normalize_path(PAYLOAD.get("root") or "/workspace")
CWD = normalize_path(PAYLOAD.get("cwd") or ROOT)

def text_record(content, content_type=None):
    return {
        "contentEncoding": "utf8",
        "content": content if isinstance(content, str) else str(content if content is not None else ""),
        "contentBase64": None,
        "contentType": content_type,
    }

def binary_record(content_base64, content_type=None):
    return {
        "contentEncoding": "base64",
        "content": None,
        "contentBase64": content_base64 if isinstance(content_base64, str) else "",
        "contentType": content_type,
    }

def clone_record(record):
    return {
        "contentEncoding": "base64" if record.get("contentEncoding") == "base64" else "utf8",
        "content": record.get("content"),
        "contentBase64": record.get("contentBase64"),
        "contentType": record.get("contentType"),
    }

def record_to_bytes(record):
    if record.get("contentEncoding") == "base64":
        return base64.b64decode(record.get("contentBase64") or "")
    return (record.get("content") or "").encode("utf-8")

def record_to_text(record):
    if record.get("contentEncoding") == "base64":
        return record_to_bytes(record).decode("utf-8")
    return record.get("content") or ""

ORIGINAL_FILES = {}
for path, content in (PAYLOAD.get("files") or {}).items():
    metadata = (PAYLOAD.get("fileMetadata") or {}).get(path) or {}
    ORIGINAL_FILES[normalize_path(path)] = text_record(content, metadata.get("contentType"))
for path, content_base64 in (PAYLOAD.get("binaryFiles") or {}).items():
    metadata = (PAYLOAD.get("fileMetadata") or {}).get(path) or {}
    ORIGINAL_FILES[normalize_path(path)] = binary_record(content_base64, metadata.get("contentType"))
FILES = {path: clone_record(record) for path, record in ORIGINAL_FILES.items()}
STDOUT = []
STDERR = []

def build_directory_set():
    directories = {"/", ROOT}
    for file_path in FILES.keys():
        current = dirname(file_path)
        while True:
            directories.add(current)
            if current == "/":
                break
            current = dirname(current)
    return directories

DIRECTORIES = build_directory_set()

def ensure_parent_exists(path):
    parent = dirname(path)
    if parent not in DIRECTORIES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{parent}'")

def list_directory(path):
    normalized = normalize_path(path)
    names = set()
    for directory in DIRECTORIES:
        if directory == normalized:
            continue
        if directory.startswith(normalized if normalized == "/" else normalized + "/"):
            remainder = directory[1:] if normalized == "/" else directory[len(normalized) + 1:]
            head = remainder.split("/", 1)[0]
            if head:
                names.add(head)
    for file_path in FILES.keys():
        if file_path.startswith(normalized if normalized == "/" else normalized + "/"):
            remainder = file_path[1:] if normalized == "/" else file_path[len(normalized) + 1:]
            head = remainder.split("/", 1)[0]
            if head:
                names.add(head)
    return sorted(names)

def path_exists(path):
    normalized = normalize_path(path)
    return normalized in FILES or normalized in DIRECTORIES

def is_dir(path):
    return normalize_path(path) in DIRECTORIES

def is_file(path):
    return normalize_path(path) in FILES

def get_size(path):
    normalized = normalize_path(path)
    if normalized in FILES:
        return len(record_to_bytes(FILES[normalized]))
    return 0

def capture(stream, text):
    stream.append(text)

def print_shim(*values, sep=" ", end="\\n", file=None, flush=False):
    text = sep.join(str(value) for value in values) + end
    target = STDERR if file is sys.stderr else STDOUT
    capture(target, text)

class CapturedStream(io.StringIO):
    def __init__(self, target):
        super().__init__()
        self._target = target

    def write(self, value):
        text = value if isinstance(value, str) else str(value)
        capture(self._target, text)
        return len(text)

class VirtualTextFile(io.StringIO):
    def __init__(self, path, mode, initial_value=""):
        super().__init__(initial_value)
        self._path = path
        self._mode = mode
        if "a" in mode:
            self.seek(0, io.SEEK_END)

    def close(self):
        if not self.closed and any(flag in self._mode for flag in ("w", "a", "x", "+")):
            FILES[self._path] = text_record(self.getvalue())
            DIRECTORIES.add(dirname(self._path))
        super().close()

class VirtualBinaryFile(io.BytesIO):
    def __init__(self, path, mode, initial_value=b""):
        super().__init__(initial_value)
        self._path = path
        self._mode = mode
        if "a" in mode:
            self.seek(0, io.SEEK_END)

    def close(self):
        if not self.closed and any(flag in self._mode for flag in ("w", "a", "x", "+")):
            FILES[self._path] = binary_record(base64.b64encode(self.getvalue()).decode("ascii"))
            DIRECTORIES.add(dirname(self._path))
        super().close()

def open_shim(path, mode="r", buffering=-1, encoding="utf-8", errors=None, newline=None, closefd=True, opener=None):
    resolved = resolve_path(CWD, path)
    write_mode = any(flag in mode for flag in ("w", "a", "x", "+"))
    if "x" in mode and resolved in FILES:
        raise FileExistsError(f"[Errno 17] File exists: '{resolved}'")
    if resolved not in FILES and any(flag in mode for flag in ("r", "+")) and "w" not in mode and "a" not in mode and "x" not in mode:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")
    if write_mode:
        ensure_parent_exists(resolved)
    if "b" in mode:
        if "w" in mode:
            initial_value = b""
        elif "a" in mode:
            initial_value = record_to_bytes(FILES[resolved]) if resolved in FILES else b""
        else:
            initial_value = record_to_bytes(FILES[resolved]) if resolved in FILES else b""
        return VirtualBinaryFile(resolved, mode, initial_value)
    if "w" in mode:
        initial_value = ""
    elif "a" in mode:
        initial_value = record_to_text(FILES[resolved]) if resolved in FILES else ""
    else:
        initial_value = record_to_text(FILES[resolved]) if resolved in FILES else ""
    return VirtualTextFile(resolved, mode, initial_value)

def os_getcwd():
    return CWD

def os_chdir(path):
    global CWD
    resolved = resolve_path(CWD, path)
    if resolved not in DIRECTORIES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")
    CWD = resolved

def os_listdir(path="."):
    resolved = resolve_path(CWD, path)
    if resolved not in DIRECTORIES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")
    return list_directory(resolved)

def os_mkdir(path, mode=0o777):
    resolved = resolve_path(CWD, path)
    parent = dirname(resolved)
    if parent not in DIRECTORIES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{parent}'")
    DIRECTORIES.add(resolved)

def os_makedirs(path, mode=0o777, exist_ok=False):
    resolved = resolve_path(CWD, path)
    if resolved in DIRECTORIES:
        if exist_ok:
            return
        raise FileExistsError(f"[Errno 17] File exists: '{resolved}'")
    current = "/"
    for segment in [part for part in resolved.split("/") if part]:
        current = normalize_path(posixpath.join(current, segment))
        if current in DIRECTORIES:
            continue
        parent = dirname(current)
        if parent not in DIRECTORIES:
            raise FileNotFoundError(f"[Errno 2] No such file or directory: '{parent}'")
        DIRECTORIES.add(current)
def os_remove(path):
    resolved = resolve_path(CWD, path)
    if resolved not in FILES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")
    del FILES[resolved]

def os_unlink(path):
    return os_remove(path)

def os_rmdir(path):
    resolved = resolve_path(CWD, path)
    if resolved not in DIRECTORIES:
        raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")
    if list_directory(resolved):
        raise OSError(f"[Errno 39] Directory not empty: '{resolved}'")
    if resolved != ROOT:
        DIRECTORIES.discard(resolved)

def os_stat(path):
    resolved = resolve_path(CWD, path)
    if resolved in FILES:
        return type("StatResult", (), {
            "st_size": get_size(resolved),
        })()
    if resolved in DIRECTORIES:
        return type("StatResult", (), {
            "st_size": 0,
        })()
    raise FileNotFoundError(f"[Errno 2] No such file or directory: '{resolved}'")

class PathShim:
    @staticmethod
    def exists(path):
        return path_exists(resolve_path(CWD, path))

    @staticmethod
    def isfile(path):
        return is_file(resolve_path(CWD, path))

    @staticmethod
    def isdir(path):
        return is_dir(resolve_path(CWD, path))

    @staticmethod
    def getsize(path):
        return get_size(resolve_path(CWD, path))

class WorkspaceModuleLoader(importlib.abc.Loader):
    def __init__(self, module_name, module_path, is_package):
        self.module_name = module_name
        self.module_path = module_path
        self.is_package = is_package

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__file__ = self.module_path
        module.__package__ = self.module_name if self.is_package else self.module_name.rpartition(".")[0]
        if self.is_package:
            module.__path__ = [dirname(self.module_path)]
        source = record_to_text(FILES[self.module_path])
        code = compile(source, self.module_path, "exec")
        exec(code, module.__dict__)

class WorkspaceModuleFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        segments = fullname.split(".")
        module_base = normalize_path(posixpath.join(ROOT, *segments))
        package_path = normalize_path(posixpath.join(module_base, "__init__.py"))
        module_path = normalize_path(module_base + ".py")
        if package_path in FILES:
            loader = WorkspaceModuleLoader(fullname, package_path, True)
            return importlib.util.spec_from_loader(fullname, loader, origin=package_path, is_package=True)
        if module_path in FILES:
            loader = WorkspaceModuleLoader(fullname, module_path, False)
            return importlib.util.spec_from_loader(fullname, loader, origin=module_path, is_package=False)
        return None

def apply_runtime_shims():
    builtins.print = print_shim
    builtins.open = open_shim
    io.open = open_shim
    os.getcwd = os_getcwd
    os.chdir = os_chdir
    os.listdir = os_listdir
    os.mkdir = os_mkdir
    os.makedirs = os_makedirs
    os.remove = os_remove
    os.unlink = os_unlink
    os.rmdir = os_rmdir
    os.stat = os_stat
    os.path.exists = PathShim.exists
    os.path.isfile = PathShim.isfile
    os.path.isdir = PathShim.isdir
    os.path.getsize = PathShim.getsize
    sys.stdout = CapturedStream(STDOUT)
    sys.stderr = CapturedStream(STDERR)
    if not any(type(finder).__name__ == "WorkspaceModuleFinder" for finder in sys.meta_path):
        sys.meta_path.insert(0, WorkspaceModuleFinder())

def run_payload():
    apply_runtime_shims()
    exit_code = 0
    entry_path = PAYLOAD.get("entryPath")
    mode = PAYLOAD.get("mode")
    args = PAYLOAD.get("args") or []

    try:
        if mode == "eval":
            sys.argv = ["python", "-c", *args]
            globals_dict = {
                "__name__": "__main__",
                "__file__": "<string>",
                "__package__": None,
            }
            exec(compile(PAYLOAD.get("code") or "", "<string>", "exec"), globals_dict, globals_dict)
        elif mode == "file":
            if not isinstance(entry_path, str) or entry_path not in FILES:
                raise FileNotFoundError(f"[Errno 2] No such file or directory: '{entry_path}'")
            sys.argv = [entry_path, *args]
            globals_dict = {
                "__name__": "__main__",
                "__file__": entry_path,
                "__package__": None,
            }
            exec(compile(record_to_text(FILES[entry_path]), entry_path, "exec"), globals_dict, globals_dict)
        else:
            raise RuntimeError(f"Unsupported Python dynamic worker mode: {mode}")
    except SystemExit as error:
        code = error.code
        exit_code = code if isinstance(code, int) else 0
    except BaseException:
        exit_code = 1
        capture(STDERR, traceback.format_exc())

    changed_files = []
    removed_paths = []
    for path, record in FILES.items():
        if ORIGINAL_FILES.get(path) != record:
            if record.get("contentEncoding") == "base64":
                changed_files.append({
                    "path": path,
                    "content": None,
                    "contentBase64": record.get("contentBase64"),
                    "contentEncoding": "base64",
                    "contentType": record.get("contentType"),
                })
            else:
                changed_files.append({
                    "path": path,
                    "content": record.get("content") or "",
                    "contentBase64": None,
                    "contentEncoding": "utf8",
                    "contentType": record.get("contentType"),
                })
    for path in ORIGINAL_FILES.keys():
        if path not in FILES:
            removed_paths.append(path)

    return {
        "stdout": "".join(STDOUT),
        "stderr": "".join(STDERR),
        "exitCode": exit_code,
        "changedFiles": changed_files,
        "removedPaths": removed_paths,
    }

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        result = run_payload()
        return Response(json.dumps(result), headers={"content-type": "application/json"})
`;
}

function buildLoadDefinition(payload) {
  if (payload?.runtime === "python") {
    return {
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["python_workers"],
      mainModule: "index.py",
      modules: {
        "index.py": { py: buildPythonDynamicWorkerSource(payload) },
      },
      env: {
        PAYLOAD: payload,
      },
      globalOutbound: null,
    };
  }

  return {
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: {
      "index.js": buildDynamicWorkerSource(payload),
    },
    env: {
      PAYLOAD: payload,
    },
    globalOutbound: null,
  };
}

function truncateOutput(text, maxOutputTokens = 4000) {
  const value = typeof text === "string" ? text : "";
  const originalTokenCount = Math.ceil(value.length / 4);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0 || value.length <= maxOutputTokens * 4) {
    return {
      outputText: value,
      originalTokenCount,
    };
  }
  return {
    outputText: `${value.slice(0, maxOutputTokens * 4)}\n...[output truncated]`,
    originalTokenCount,
  };
}

function buildPythonFallbackResult({
  reason,
  message,
  startedAt,
  now,
  route,
  maxOutputTokens,
  stdout = "",
  stderr = "",
  exitCode = 1,
  infrastructureError = false,
} = {}) {
  const combined = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
    .filter(Boolean)
    .join("\n\n") || `exit_code: ${exitCode}`;
  const truncated = truncateOutput(combined, maxOutputTokens);
  return {
    ok: false,
    exitCode,
    stdout,
    stderr,
    outputText: truncated.outputText,
    durationMs: Math.max(0, now() - startedAt),
    infrastructureError,
    sessionOpen: false,
    changedFiles: [],
    removedPaths: [],
    originalTokenCount: truncated.originalTokenCount,
    driver: DYNAMIC_WORKER_DRIVER_NAME,
    route,
    fallbackSuggested: true,
    fallbackReason: reason ?? "python-sandbox-fallback",
    fallbackMessage: typeof message === "string" && message ? message : null,
  };
}

export function createDynamicWorkerDriver({
  loader = null,
  workspaceStore,
  trace = () => {},
  now = () => Date.now(),
} = {}) {
  return {
    name: DYNAMIC_WORKER_DRIVER_NAME,
    resolve(request) {
      if (!loader || !request || typeof request !== "object") {
        return null;
      }
      if (request.tty) {
        return null;
      }
      if (typeof request.shell === "string" && request.shell.trim()) {
        return null;
      }
      const command = typeof request.command === "string" ? request.command.trim() : "";
      if (!command || hasUnquotedShellSyntax(command)) {
        return null;
      }
      const tokens = tokenizeCommand(command);
      if (!tokens) {
        return null;
      }

      const executable = tokens[0];
      if (executable !== "node" && executable !== "python" && executable !== "python3") {
        return null;
      }

      if ((executable === "node" && (tokens[1] === "-e" || tokens[1] === "--eval"))
        || ((executable === "python" || executable === "python3") && tokens[1] === "-c")) {
        const code = tokens[2];
        if (typeof code !== "string") {
          return null;
        }
        return {
          executable,
          mode: "eval",
          code,
          args: tokens.slice(3),
          runtime: executable === "node" ? "javascript" : "python",
          reason: executable === "node" ? "node-eval" : "python-eval",
        };
      }

      if (executable === "node" && isMaybeScriptPath(tokens[1])) {
        return {
          executable,
          mode: "file",
          entryPath: tokens[1],
          args: tokens.slice(2),
          runtime: "javascript",
          reason: "node-script",
        };
      }

      if ((executable === "python" || executable === "python3") && isMaybePythonScriptPath(tokens[1])) {
        return {
          executable,
          mode: "file",
          entryPath: tokens[1],
          args: tokens.slice(2),
          runtime: "python",
          reason: "python-script",
        };
      }

      return null;
    },
    async execute(thread, {
      command,
      cwd = null,
      route,
      maxOutputTokens = 4000,
    } = {}) {
      if (!loader) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          outputText: "Dynamic Worker execution is not configured on this deployment.",
          durationMs: 0,
          infrastructureError: true,
          sessionOpen: false,
          changedFiles: [],
          removedPaths: [],
          originalTokenCount: 0,
          driver: DYNAMIC_WORKER_DRIVER_NAME,
          route,
        };
      }

      const startedAt = now();
      const snapshot = await workspaceStore.exportWorkspaceSnapshot(thread);
      const root = normalizeRoot(snapshot.root ?? thread.workspace?.root ?? thread.cwd);
      const resolvedCwd = normalizePath(cwd ?? thread.cwd ?? root);
      const entryPath = route?.mode === "file" ? resolvePath(resolvedCwd, route.entryPath) : null;
      const runtime = route?.runtime ?? (route?.executable === "node" ? "javascript" : route?.executable?.startsWith("python") ? "python" : null);

      if (entryPath) {
        const target = (snapshot.files ?? []).find((file) => file.path === entryPath);
        if (!target) {
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "",
            outputText: `Dynamic Worker could not find ${entryPath}`,
            durationMs: Math.max(0, now() - startedAt),
            infrastructureError: false,
            sessionOpen: false,
            changedFiles: [],
            removedPaths: [],
            originalTokenCount: 0,
            driver: DYNAMIC_WORKER_DRIVER_NAME,
            route,
          };
        }
      }

      let pythonLocalModules = null;
      if (runtime === "python") {
        const source = route?.mode === "eval"
          ? (typeof route?.code === "string" ? route.code : "")
          : getSnapshotTextContent(snapshot, entryPath);
        pythonLocalModules = collectLocalPythonModules(snapshot, root);
        if (source == null) {
          const message = entryPath
            ? `Python script ${entryPath} is not available as UTF-8 text in the Dynamic Worker runtime. Falling back to sandbox execution.`
            : "Python source is unavailable in the Dynamic Worker runtime. Falling back to sandbox execution.";
          trace("dynamic.exec.fallback", {
            reason: "python-non-text-entry",
            entryPath,
            cwd: resolvedCwd,
          });
          return buildPythonFallbackResult({
            reason: "python-non-text-entry",
            message,
            startedAt,
            now,
            route,
            maxOutputTokens,
            stderr: `${message}\n`,
          });
        }
        const requirement = detectPythonSandboxRequirement(source, pythonLocalModules);
        if (requirement) {
          const message = requirement.module
            ? `Python code requires sandbox-only module '${requirement.module}'. Falling back to sandbox execution.`
            : "Python code requires sandbox-only process semantics. Falling back to sandbox execution.";
          trace("dynamic.exec.fallback", {
            reason: requirement.kind,
            module: requirement.module ?? null,
            entryPath,
            cwd: resolvedCwd,
          });
          return buildPythonFallbackResult({
            reason: requirement.kind,
            message,
            startedAt,
            now,
            route,
            maxOutputTokens,
            stderr: `${message}\n`,
          });
        }
      }

      const payload = {
        runtime,
        mode: route?.mode,
        code: route?.code ?? null,
        entryPath,
        args: route?.args ?? [],
        cwd: resolvedCwd,
        root,
        files: buildSnapshotFileMap(snapshot),
        binaryFiles: buildSnapshotBinaryFileMap(snapshot),
        fileMetadata: buildSnapshotFileMetadataMap(snapshot),
        env: {},
      };

      trace("dynamic.exec.start", {
        commandPreview: previewText(command ?? ""),
        cwd: resolvedCwd,
        mode: route?.mode ?? null,
      });

      try {
        const worker = loader.load(buildLoadDefinition(payload));
        const response = await worker.getEntrypoint().fetch(new Request("https://dynamic.internal/run"));
        const result = await response.json();
        const stdout = typeof result?.stdout === "string" ? result.stdout : "";
        const stderr = typeof result?.stderr === "string" ? result.stderr : "";
        const combined = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n\n") || `exit_code: ${Number.isFinite(result?.exitCode) ? result.exitCode : 1}`;
        const truncated = truncateOutput(combined, maxOutputTokens);
        const normalized = {
          ok: Number.isFinite(result?.exitCode) ? result.exitCode === 0 : true,
          exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
          stdout,
          stderr,
          outputText: truncated.outputText,
          durationMs: Math.max(0, now() - startedAt),
          infrastructureError: false,
          sessionOpen: false,
          changedFiles: Array.isArray(result?.changedFiles) ? result.changedFiles : [],
          removedPaths: Array.isArray(result?.removedPaths) ? result.removedPaths : [],
          originalTokenCount: truncated.originalTokenCount,
          driver: DYNAMIC_WORKER_DRIVER_NAME,
          route,
        };
        if (runtime === "python" && normalized.exitCode !== 0) {
          const missingModule = parsePythonMissingModule(stderr);
          if (missingModule && !pythonLocalModules?.has(missingModule)) {
            const message = `Python Dynamic Worker is missing module '${missingModule}'. Falling back to sandbox execution.`;
            trace("dynamic.exec.fallback", {
              reason: "python-missing-module",
              module: missingModule,
              cwd: resolvedCwd,
              entryPath,
            });
            return {
              ...normalized,
              fallbackSuggested: true,
              fallbackReason: "python-missing-module",
              fallbackMessage: message,
            };
          }
        }
        trace("dynamic.exec.result", {
          exitCode: normalized.exitCode,
          durationMs: normalized.durationMs,
          changedFiles: normalized.changedFiles.length,
          removedPaths: normalized.removedPaths.length,
          outputPreview: previewText(normalized.outputText),
        });
        return normalized;
      } catch (error) {
        trace("dynamic.exec.error", {
          error,
        });
        const combined = `stderr:\n${error instanceof Error ? error.message : String(error)}\n`;
        const truncated = truncateOutput(combined, maxOutputTokens);
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
          outputText: truncated.outputText,
          durationMs: Math.max(0, now() - startedAt),
          infrastructureError: true,
          sessionOpen: false,
          changedFiles: [],
          removedPaths: [],
          originalTokenCount: truncated.originalTokenCount,
          driver: DYNAMIC_WORKER_DRIVER_NAME,
          route,
        };
      }
    },
  };
}
