import { previewText } from "./trace.js";

const DEFAULT_WORKSPACE_ROOT = "/workspace";
const DEFAULT_SLEEP_AFTER = "20m";
const DEFAULT_TTY_YIELD_TIME_MS = 1_000;
const TERMINAL_READY_TIMEOUT_MS = 5_000;
const TERMINAL_CLOSE_GRACE_MS = 100;
const TERMINAL_FLUSH_GRACE_MS = 50;
const TERMINAL_SILENT_COMPLETION_GRACE_MS = 1_500;
const DEFAULT_TTY_COLS = 120;
const DEFAULT_TTY_ROWS = 32;
let sandboxModulePromise = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSandboxModule() {
  sandboxModulePromise ??= import("@cloudflare/sandbox");
  return sandboxModulePromise;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function normalizeRoot(root) {
  const value = typeof root === "string" && root.trim() ? root.trim() : DEFAULT_WORKSPACE_ROOT;
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const normalized = withLeadingSlash.replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function workspaceSandboxId(workspaceId) {
  return `workspace-${workspaceId}`;
}

function dirname(path) {
  const normalized = path.replace(/\/+/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    return "/";
  }
  return normalized.slice(0, slashIndex);
}

function normalizeContentEncoding(value) {
  return value === "base64" ? "base64" : "utf8";
}

function cloneBytes(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

function encodeUtf8(text) {
  return textEncoder.encode(typeof text === "string" ? text : String(text ?? ""));
}

function decodeUtf8(bytes) {
  return textDecoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array());
}

function bytesToBase64(bytes) {
  const normalized = cloneBytes(bytes) ?? new Uint8Array();
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized).toString("base64");
  }
  let binary = "";
  for (const byte of normalized) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !value) {
    return new Uint8Array();
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function mapFilesByPath(files) {
  const mapped = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path) {
      continue;
    }
    const contentEncoding = normalizeContentEncoding(file.contentEncoding);
    mapped.set(file.path, {
      path: file.path,
      content: typeof file.content === "string" ? file.content : null,
      contentBase64: typeof file.contentBase64 === "string" ? file.contentBase64 : null,
      contentEncoding,
      contentType: typeof file.contentType === "string" && file.contentType ? file.contentType : null,
    });
  }
  return mapped;
}

function fileRecordToBytes(file) {
  return file.contentEncoding === "base64"
    ? base64ToBytes(file.contentBase64)
    : encodeUtf8(file.content ?? "");
}

function fileRecordsEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.contentEncoding !== right.contentEncoding) {
    return false;
  }
  if (left.contentEncoding === "base64") {
    return (left.contentBase64 ?? "") === (right.contentBase64 ?? "");
  }
  return (left.content ?? "") === (right.content ?? "");
}

function normalizeReadFileResult(read, fallbackContentType = null) {
  const contentType =
    typeof read?.contentType === "string" && read.contentType
      ? read.contentType
      : fallbackContentType;
  if (typeof read?.contentBase64 === "string") {
    return {
      content: null,
      contentBase64: read.contentBase64,
      contentEncoding: "base64",
      contentType,
    };
  }
  const byteContent = cloneBytes(read?.content ?? read?.bytes ?? read?.data ?? read);
  if (byteContent) {
    return {
      content: null,
      contentBase64: bytesToBase64(byteContent),
      contentEncoding: "base64",
      contentType,
    };
  }
  return {
    content: typeof read?.content === "string" ? read.content : "",
    contentBase64: null,
    contentEncoding: "utf8",
    contentType,
  };
}

async function ensureWorkspaceMaterialized(target, root, files) {
  await target.mkdir(root, { recursive: true });

  const existing = await target.listFiles(root, {
    recursive: true,
    includeHidden: true,
  });
  const expected = mapFilesByPath(files);

  for (const entry of existing.files ?? []) {
    if (entry.type !== "file") {
      continue;
    }
    if (!expected.has(entry.absolutePath)) {
      await target.deleteFile(entry.absolutePath).catch(() => {});
    }
  }

  for (const file of expected.values()) {
    await target.mkdir(dirname(file.path), { recursive: true });
    if (file.contentEncoding === "base64") {
      await target.writeFile(file.path, fileRecordToBytes(file));
      continue;
    }
    await target.writeFile(file.path, file.content ?? "", { encoding: "utf-8" });
  }
}

async function readWorkspaceFiles(target, root) {
  const listing = await target.listFiles(root, {
    recursive: true,
    includeHidden: true,
  });
  const files = [];

  for (const entry of (listing.files ?? []).slice().sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))) {
    if (entry.type !== "file") {
      continue;
    }
    const read = await target.readFile(entry.absolutePath);
    const normalized = normalizeReadFileResult(read, typeof entry.contentType === "string" ? entry.contentType : null);
    files.push({
      path: entry.absolutePath,
      content: normalized.content,
      contentBase64: normalized.contentBase64,
      contentEncoding: normalized.contentEncoding,
      contentType: normalized.contentType,
    });
  }

  return files;
}

function diffWorkspaceFiles(beforeFiles, afterFiles) {
  const before = mapFilesByPath(beforeFiles);
  const after = mapFilesByPath(afterFiles);
  const changedFiles = [];
  const removedPaths = [];

  for (const [path, file] of after.entries()) {
    if (!before.has(path) || !fileRecordsEqual(before.get(path), file)) {
      changedFiles.push({
        path,
        content: file.content,
        contentBase64: file.contentBase64,
        contentEncoding: file.contentEncoding,
        contentType: file.contentType,
      });
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) {
      removedPaths.push(path);
    }
  }

  return {
    changedFiles,
    removedPaths,
  };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExitMarker() {
  return `__CODEX_EXIT_${crypto.randomUUID().replace(/-/g, "")}__`;
}

function buildExitMarkerPath(marker) {
  return `/tmp/${marker}.exit`;
}

function buildInteractiveBootstrap({ cwd, command, marker }) {
  const markerPath = buildExitMarkerPath(marker);
  return [
    "export PS1='' PROMPT='' RPROMPT='' >/dev/null 2>&1 || true",
    "stty -echo >/dev/null 2>&1 || true",
    `cd ${shellEscape(cwd)} >/dev/null 2>&1 || true`,
    `rm -f ${shellEscape(markerPath)} >/dev/null 2>&1 || true`,
    "{",
    command,
    "__CODEX_STATUS=$?",
    `printf '%s' \"$__CODEX_STATUS\" > ${shellEscape(markerPath)}`,
    `printf '\\n${marker}:%s\\n' \"$__CODEX_STATUS\"`,
    "}",
    "",
  ].join("\n");
}

function approximateTokenCount(text) {
  if (typeof text !== "string" || !text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function truncateOutputText(text, maxOutputTokens) {
  const output = typeof text === "string" ? text : "";
  const originalTokenCount = approximateTokenCount(output);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return {
      output,
      originalTokenCount,
    };
  }

  const maxChars = Math.max(1, maxOutputTokens * 4);
  if (output.length <= maxChars) {
    return {
      output,
      originalTokenCount,
    };
  }

  return {
    output: `${output.slice(0, maxChars)}\n...[output truncated]`,
    originalTokenCount,
  };
}

async function readExitMarkerFile(session, marker) {
  if (typeof marker !== "string" || !marker) {
    return null;
  }

  try {
    const result = await session.readFile(buildExitMarkerPath(marker), {
      encoding: "utf-8",
    });
    const value = typeof result?.content === "string" ? result.content.trim() : "";
    if (/^-?\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
  } catch {}

  return null;
}

function finalizeTerminalOutput(rawOutput, marker, exitInfo, maxOutputTokens, markerFileExitCode = null) {
  const text = typeof rawOutput === "string" ? rawOutput : "";
  const markerPattern = new RegExp(`(?:\\r?\\n)?${escapeRegex(marker)}:(-?\\d+)\\r?\\n?`);
  const match = text.match(markerPattern);
  const exitCodeFromMarker = match ? Number.parseInt(match[1], 10) : null;
  const cleaned = match ? text.replace(markerPattern, "") : text;
  const truncated = truncateOutputText(cleaned, maxOutputTokens);

  return {
    outputText: truncated.output,
    originalTokenCount: truncated.originalTokenCount,
    completed:
      Number.isFinite(exitCodeFromMarker)
      || Number.isFinite(exitInfo?.code)
      || Number.isFinite(markerFileExitCode),
    exitCode: Number.isFinite(exitCodeFromMarker) ? exitCodeFromMarker : (
      Number.isFinite(exitInfo?.code) ? exitInfo.code : (
        Number.isFinite(markerFileExitCode) ? markerFileExitCode : null
      )
    ),
  };
}

function createTerminalRequest() {
  return new Request("http://localhost/ws/pty", {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
    },
  });
}

function normalizeBinaryData(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

async function connectTerminal(session, {
  shell = undefined,
  cols = DEFAULT_TTY_COLS,
  rows = DEFAULT_TTY_ROWS,
} = {}) {
  const response = await session.terminal(createTerminalRequest(), {
    cols,
    rows,
    ...(typeof shell === "string" && shell ? { shell } : {}),
  });
  if (response.status !== 101) {
    throw new Error(`Sandbox terminal upgrade failed: ${response.status} ${response.statusText}`);
  }
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Sandbox terminal upgrade did not return a WebSocket");
  }
  socket.accept();
  return socket;
}

async function runTerminalExchange(session, {
  shell = undefined,
  input = "",
  marker,
  yieldTimeMs = DEFAULT_TTY_YIELD_TIME_MS,
  trace = () => {},
  traceContext = {},
} = {}) {
  const socket = await connectTerminal(session, { shell });
  const ready = deferred();
  const exited = deferred();
  const closed = deferred();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let rawOutput = "";
  let exitInfo = null;
  let errorMessage = null;
  let readySettled = false;

  socket.addEventListener("message", (event) => {
    const binary = normalizeBinaryData(event.data);
    if (binary) {
      rawOutput += decoder.decode(binary, { stream: true });
      return;
    }

    if (typeof event.data !== "string") {
      return;
    }

    try {
      const payload = JSON.parse(event.data);
      switch (payload?.type) {
        case "ready":
          trace("sandbox.pty.ready", {
            ...traceContext,
            sandboxSessionId: session.id,
          });
          if (!readySettled) {
            readySettled = true;
            ready.resolve();
          }
          break;
        case "error":
          errorMessage = typeof payload?.message === "string" && payload.message
            ? payload.message
            : "Sandbox terminal error";
          trace("sandbox.pty.error", {
            ...traceContext,
            sandboxSessionId: session.id,
            message: errorMessage,
          });
          if (!readySettled) {
            readySettled = true;
            ready.reject(new Error(errorMessage));
          }
          break;
        case "exit":
          exitInfo = {
            code: Number.isFinite(payload?.code) ? payload.code : null,
            signal: typeof payload?.signal === "string" ? payload.signal : null,
          };
          trace("sandbox.pty.exit", {
            ...traceContext,
            sandboxSessionId: session.id,
            exitCode: exitInfo.code,
            signal: exitInfo.signal,
          });
          exited.resolve();
          break;
        default:
          break;
      }
    } catch {
      // Ignore control frames we don't understand.
    }
  });

  socket.addEventListener("close", () => {
    trace("sandbox.pty.socket_close", {
      ...traceContext,
      sandboxSessionId: session.id,
    });
    if (!readySettled) {
      readySettled = true;
      ready.resolve();
    }
    closed.resolve();
  });

  socket.addEventListener("error", () => {
    trace("sandbox.pty.socket_error", {
      ...traceContext,
      sandboxSessionId: session.id,
    });
    if (!readySettled) {
      readySettled = true;
      ready.reject(new Error("Sandbox terminal WebSocket error"));
    }
  });

  await Promise.race([
    ready.promise,
    delay(TERMINAL_READY_TIMEOUT_MS).then(() => {
      throw new Error("Sandbox terminal did not become ready");
    }),
  ]);

  if (typeof input === "string" && input) {
    socket.send(encoder.encode(input));
  }

  await Promise.race([
    exited.promise,
    delay(
      Math.max(
        DEFAULT_TTY_YIELD_TIME_MS,
        Number.isFinite(yieldTimeMs) && yieldTimeMs >= 0 ? yieldTimeMs : DEFAULT_TTY_YIELD_TIME_MS,
      ),
    ),
  ]);
  if (!exitInfo && !rawOutput.trim()) {
    await Promise.race([
      exited.promise,
      delay(TERMINAL_SILENT_COMPLETION_GRACE_MS),
    ]);
  }
  await delay(TERMINAL_FLUSH_GRACE_MS);

  try {
    socket.close(1000, marker ? "codex-yield" : "codex-close");
  } catch {
    // Ignore close failures on already-closed sockets.
  }

  await Promise.race([
    closed.promise,
    delay(TERMINAL_CLOSE_GRACE_MS),
  ]);

  rawOutput += decoder.decode();
  trace("sandbox.pty.yield", {
    ...traceContext,
    sandboxSessionId: session.id,
    rawOutputChars: rawOutput.length,
    exitCode: exitInfo?.code ?? null,
    hadError: Boolean(errorMessage),
  });

  return {
    rawOutput,
    exitInfo,
    errorMessage,
  };
}

export function createSandboxCommandExecutor({
  binding,
  sleepAfter = DEFAULT_SLEEP_AFTER,
  trace = () => {},
  getWorkspaceSandbox: getWorkspaceSandboxOverride = null,
} = {}) {
  if (!binding && typeof getWorkspaceSandboxOverride !== "function") {
    return null;
  }

  async function getWorkspaceSandbox(workspaceId) {
    if (typeof getWorkspaceSandboxOverride === "function") {
      return getWorkspaceSandboxOverride(workspaceId);
    }
    const { getSandbox } = await loadSandboxModule();
    return getSandbox(binding, workspaceSandboxId(workspaceId), {
      sleepAfter,
      normalizeId: true,
    });
  }

  async function executeInteractiveCommand({
    workspaceId,
    workspaceRoot,
    cwd,
    command,
    files,
    shell,
    yieldTimeMs,
    maxOutputTokens,
  }) {
    const sandbox = await getWorkspaceSandbox(workspaceId);
    const session = await sandbox.createSession();
    const marker = buildExitMarker();
    const root = normalizeRoot(workspaceRoot);
    const startedAt = Date.now();
    const sandboxId = workspaceSandboxId(workspaceId);
    trace("sandbox.pty.start", {
      workspaceId,
      sandboxId,
      sandboxSessionId: session.id,
      cwd: typeof cwd === "string" && cwd ? cwd : root,
      shell: typeof shell === "string" && shell ? shell : null,
      command: previewText(command),
      fileCount: files.length,
    });

    await ensureWorkspaceMaterialized(session, root, files);

    const exchange = await runTerminalExchange(session, {
      shell,
      input: buildInteractiveBootstrap({
        cwd: typeof cwd === "string" && cwd ? cwd : root,
        command,
        marker,
      }),
      marker,
      yieldTimeMs,
      trace,
      traceContext: {
        workspaceId,
        sandboxId,
      },
    });
    const markerFileExitCode = await readExitMarkerFile(session, marker);
    const finalized = finalizeTerminalOutput(
      exchange.rawOutput,
      marker,
      exchange.exitInfo,
      maxOutputTokens,
      markerFileExitCode,
    );
    const afterFiles = await readWorkspaceFiles(session, root);
    const diff = diffWorkspaceFiles(files, afterFiles);
    const durationMs = Date.now() - startedAt;

    if (finalized.completed || exchange.errorMessage) {
      await sandbox.deleteSession(session.id).catch(() => {});
    }
    trace("sandbox.pty.result", {
      workspaceId,
      sandboxId,
      sandboxSessionId: finalized.completed || exchange.errorMessage ? null : session.id,
      completed: finalized.completed,
      exitCode: exchange.errorMessage ? 1 : finalized.exitCode,
      sessionOpen: !finalized.completed && !exchange.errorMessage,
      outputChars: finalized.outputText.length,
      changedFiles: diff.changedFiles.length,
      removedPaths: diff.removedPaths.length,
      error: exchange.errorMessage ?? null,
    });

    return {
      sandboxId,
      sandboxSessionId: finalized.completed || exchange.errorMessage ? null : session.id,
      marker: finalized.completed || exchange.errorMessage ? null : marker,
      outputText: exchange.errorMessage
        ? `${finalized.outputText}${finalized.outputText ? "\n" : ""}${exchange.errorMessage}`
        : finalized.outputText,
      exitCode: exchange.errorMessage ? 1 : finalized.exitCode,
      durationMs,
      sessionOpen: !finalized.completed && !exchange.errorMessage,
      infrastructureError: false,
      changedFiles: diff.changedFiles,
      removedPaths: diff.removedPaths,
      originalTokenCount: finalized.originalTokenCount,
    };
  }

  async function executeCommand({
    workspaceId,
    workspaceRoot = DEFAULT_WORKSPACE_ROOT,
    workspaceRevision = null,
    cwd = null,
    command,
    files = [],
    hydratedRevision = null,
    tty = false,
    timeoutMs = null,
    maxOutputTokens = null,
    shell = undefined,
  }) {
    if (tty) {
      return executeInteractiveCommand({
        workspaceId,
        workspaceRoot,
        cwd,
        command,
        files,
        shell,
        yieldTimeMs: timeoutMs,
        maxOutputTokens,
      });
    }

    const sandbox = await getWorkspaceSandbox(workspaceId);
    const session = await sandbox.createSession();
    const root = normalizeRoot(workspaceRoot);
    const sandboxId = workspaceSandboxId(workspaceId);
    trace("sandbox.exec.start", {
      workspaceId,
      sandboxId,
      sandboxSessionId: session.id,
      cwd: typeof cwd === "string" && cwd ? cwd : root,
      command: previewText(command),
      workspaceRevision,
      hydratedRevision,
      fileCount: files.length,
    });

    await ensureWorkspaceMaterialized(session, root, files);

    const startedAt = Date.now();
    const result = await session.exec(command, {
      cwd: typeof cwd === "string" && cwd ? cwd : root,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    });
    const durationMs = Date.now() - startedAt;

    const afterFiles = await readWorkspaceFiles(session, root);
    const diff = diffWorkspaceFiles(files, afterFiles);
    await sandbox.deleteSession(session.id).catch(() => {});
    const combinedOutput = [
      typeof result?.stdout === "string" && result.stdout ? `stdout:\n${result.stdout}` : "",
      typeof result?.stderr === "string" && result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n\n");
    const truncated = truncateOutputText(combinedOutput, maxOutputTokens);
    trace("sandbox.exec.result", {
      workspaceId,
      sandboxId,
      sandboxSessionId: session.id,
      exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
      durationMs,
      stdoutChars: typeof result?.stdout === "string" ? result.stdout.length : 0,
      stderrChars: typeof result?.stderr === "string" ? result.stderr.length : 0,
      changedFiles: diff.changedFiles.length,
      removedPaths: diff.removedPaths.length,
    });

    return {
      sandboxId,
      stdout: typeof result?.stdout === "string" ? result.stdout : "",
      stderr: typeof result?.stderr === "string" ? result.stderr : "",
      outputText: truncated.output,
      exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : 0,
      durationMs,
      sessionOpen: false,
      changedFiles: diff.changedFiles,
      removedPaths: diff.removedPaths,
      originalTokenCount: truncated.originalTokenCount,
    };
  }

  async function writeStdin({
    workspaceId,
    workspaceRoot = DEFAULT_WORKSPACE_ROOT,
    sandboxSessionId,
    chars = "",
    timeoutMs = null,
    maxOutputTokens = null,
    files = [],
    marker,
  }) {
    const sandbox = await getWorkspaceSandbox(workspaceId);
    const session = await sandbox.getSession(sandboxSessionId);
    const root = normalizeRoot(workspaceRoot);
    const startedAt = Date.now();
    const sandboxId = workspaceSandboxId(workspaceId);
    trace("sandbox.write_stdin.start", {
      workspaceId,
      sandboxId,
      sandboxSessionId,
      charsPreview: previewText(chars, 80),
      charCount: typeof chars === "string" ? chars.length : 0,
      marker: marker ?? null,
    });
    const exchange = await runTerminalExchange(session, {
      input: typeof chars === "string" ? chars : "",
      marker,
      yieldTimeMs: timeoutMs,
      trace,
      traceContext: {
        workspaceId,
        sandboxId,
      },
    });
    const markerFileExitCode = await readExitMarkerFile(session, marker);
    const finalized = finalizeTerminalOutput(
      exchange.rawOutput,
      marker,
      exchange.exitInfo,
      maxOutputTokens,
      markerFileExitCode,
    );
    const afterFiles = await readWorkspaceFiles(session, root);
    const diff = diffWorkspaceFiles(files, afterFiles);
    const durationMs = Date.now() - startedAt;

    if (finalized.completed || exchange.errorMessage) {
      await sandbox.deleteSession(session.id).catch(() => {});
    }
    trace("sandbox.write_stdin.result", {
      workspaceId,
      sandboxId,
      sandboxSessionId: finalized.completed || exchange.errorMessage ? null : session.id,
      completed: finalized.completed,
      exitCode: exchange.errorMessage ? 1 : finalized.exitCode,
      sessionOpen: !finalized.completed && !exchange.errorMessage,
      outputChars: finalized.outputText.length,
      changedFiles: diff.changedFiles.length,
      removedPaths: diff.removedPaths.length,
      error: exchange.errorMessage ?? null,
    });

    return {
      sandboxId,
      sandboxSessionId: finalized.completed || exchange.errorMessage ? null : session.id,
      marker: finalized.completed || exchange.errorMessage ? null : marker,
      outputText: exchange.errorMessage
        ? `${finalized.outputText}${finalized.outputText ? "\n" : ""}${exchange.errorMessage}`
        : finalized.outputText,
      exitCode: exchange.errorMessage ? 1 : finalized.exitCode,
      durationMs,
      sessionOpen: !finalized.completed && !exchange.errorMessage,
      infrastructureError: false,
      changedFiles: diff.changedFiles,
      removedPaths: diff.removedPaths,
      originalTokenCount: finalized.originalTokenCount,
    };
  }

  async function closeSession({
    workspaceId,
    workspaceRoot = DEFAULT_WORKSPACE_ROOT,
    sandboxSessionId,
    files = [],
  }) {
    if (!sandboxSessionId) {
      trace("sandbox.session.close", {
        workspaceId,
        sandboxSessionId: null,
        skipped: true,
      });
      return {
        sandboxId: workspaceSandboxId(workspaceId),
        sessionOpen: false,
        changedFiles: [],
        removedPaths: [],
      };
    }

    const sandbox = await getWorkspaceSandbox(workspaceId);
    const session = await sandbox.getSession(sandboxSessionId);
    const root = normalizeRoot(workspaceRoot);
    const afterFiles = await readWorkspaceFiles(session, root).catch(() => []);
    const diff = diffWorkspaceFiles(files, afterFiles);
    await sandbox.deleteSession(sandboxSessionId).catch(() => {});
    trace("sandbox.session.close", {
      workspaceId,
      sandboxSessionId,
      changedFiles: diff.changedFiles.length,
      removedPaths: diff.removedPaths.length,
    });

    return {
      sandboxId: workspaceSandboxId(workspaceId),
      sessionOpen: false,
      changedFiles: diff.changedFiles,
      removedPaths: diff.removedPaths,
    };
  }

  return {
    executeCommand,
    writeStdin,
    closeSession,
  };
}
