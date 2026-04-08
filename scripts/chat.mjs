import readline from "node:readline/promises";
import process from "node:process";

const port = process.env.APP_SERVER_PORT || process.env.PORT || "8787";
const host = process.env.APP_SERVER_HOST || "127.0.0.1";
const baseUrl = process.env.APP_SERVER_BASE_URL || `http://${host}:${port}`;
const requestedModel = process.env.APP_SERVER_MODEL || null;
const requestedWorkspaceId = process.env.APP_SERVER_WORKSPACE_ID || "default";
const initialEventLogMode = parseEventLogMode(process.env.APP_SERVER_CHAT_DEBUG || "");

function logLine(message = "") {
  process.stdout.write(`${message}\n`);
}

function write(message) {
  process.stdout.write(message);
}

function isTruthy(value) {
  if (typeof value !== "string") {
    return Boolean(value);
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseEventLogMode(value) {
  if (!value) {
    return "off";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || ["0", "off", "false", "no"].includes(normalized)) {
    return "off";
  }
  if (["raw", "json", "full"].includes(normalized)) {
    return "raw";
  }
  if (isTruthy(normalized) || ["summary", "events"].includes(normalized)) {
    return "summary";
  }
  return "off";
}

function timestampLabel() {
  return new Date().toISOString().slice(11, 23);
}

function previewText(value, maxLength = 120) {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function summarizeEnvelope(message) {
  if (message?.method) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      if (message.method === "item/tool/call" || message.method === "item/tool/requestUserInput") {
        return `server-request ${message.method}#${message.id}`;
      }
      return `request ${message.method}#${message.id}`;
    }

    switch (message.method) {
      case "thread/started":
        return `notify thread/started ${message.params?.thread?.id ?? ""}`.trim();
      case "turn/started":
        return `notify turn/started ${message.params?.turn?.id ?? ""}`.trim();
      case "turn/completed":
        return `notify turn/completed status=${message.params?.turn?.status ?? "unknown"}`;
      case "item/started":
      case "item/completed":
        return `${message.method} ${message.params?.item?.type ?? "item"} ${message.params?.item?.id ?? ""}`.trim();
      case "item/agentMessage/delta":
        return `notify item/agentMessage/delta chars=${message.params?.delta?.length ?? 0}`;
      case "item/commandExecution/outputDelta":
        return `notify item/commandExecution/outputDelta chars=${message.params?.delta?.length ?? 0}`;
      case "item/commandExecution/terminalInteraction":
        return `notify item/commandExecution/terminalInteraction process=${message.params?.processId ?? "unknown"}`;
      case "serverRequest/resolved":
        return `notify serverRequest/resolved ${message.params?.requestId ?? ""}`.trim();
      case "error":
        return `notify error ${message.params?.error?.message ?? ""}`.trim();
      default:
        return `notify ${message.method}`;
    }
  }

  if (Object.prototype.hasOwnProperty.call(message ?? {}, "id")) {
    if (message.error) {
      return `response #${message.id} error=${message.error.code ?? "unknown"} ${message.error.message ?? ""}`.trim();
    }
    const resultPreview = previewText(JSON.stringify(message.result ?? {}), 100);
    return `response #${message.id} ok ${resultPreview}`;
  }

  return "message";
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function parseSlashCommand(text) {
  if (!text.startsWith("/")) {
    return null;
  }

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) {
    return {
      command: text,
      rest: "",
    };
  }

  return {
    command: text.slice(0, firstSpace),
    rest: text.slice(firstSpace + 1).trim(),
  };
}

function splitPathAndValue(rest) {
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    return {
      path: rest.trim(),
      value: "",
    };
  }

  return {
    path: rest.slice(0, firstSpace).trim(),
    value: rest.slice(firstSpace + 1),
  };
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

async function createSession() {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function openSocket(url) {
  const ws = new WebSocket(url);

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve();
    };
    const onError = (event) => {
      ws.removeEventListener("open", onOpen);
      reject(event.error ?? new Error("WebSocket connection failed"));
    };

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });

  return ws;
}

async function main() {
  const session = await createSession();
  const ws = await openSocket(session.websocketUrl);
  const pending = new Map();
  let nextId = 1;
  let activeTurn = null;
  let closed = false;
  let rl;
  let eventLogMode = initialEventLogMode;

  function closeSocket() {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ws.close(1000, "chat-complete");
    } catch {
      // Ignore late close failures during shutdown.
    }
  }

  function rejectPending(error) {
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
    if (activeTurn) {
      activeTurn.reject(error);
      activeTurn = null;
    }
  }

  function flushActiveOutput() {
    if (!activeTurn) {
      return;
    }
    if (activeTurn.streaming || activeTurn.commandStreaming) {
      logLine();
      activeTurn.streaming = false;
      activeTurn.commandStreaming = false;
    }
  }

  function logEnvelope(direction, message) {
    if (eventLogMode === "off") {
      return;
    }

    flushActiveOutput();
    if (eventLogMode === "raw") {
      logLine(`[${timestampLabel()}] ${direction} ${JSON.stringify(message)}`);
      return;
    }

    logLine(`[${timestampLabel()}] ${direction} ${summarizeEnvelope(message)}`);
  }

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    logEnvelope("<-", message);

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      void handleServerRequest(message);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const waiter = pending.get(message.id);
      if (!waiter) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "JSON-RPC request failed"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (!message.method || !activeTurn) {
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      if (activeTurn.streaming) {
        logLine();
        activeTurn.streaming = false;
      }
      if (!activeTurn.commandStreaming) {
        activeTurn.commandStreaming = true;
        logLine();
        logLine("command>");
      }
      write(message.params.delta);
      return;
    }

    if (message.method === "item/commandExecution/terminalInteraction") {
      if (activeTurn.streaming || activeTurn.commandStreaming) {
        logLine();
        activeTurn.streaming = false;
        activeTurn.commandStreaming = false;
      }
      logLine(`stdin[${message.params.processId}]> ${JSON.stringify(message.params.stdin)}`);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      if (activeTurn.commandStreaming) {
        logLine();
        activeTurn.commandStreaming = false;
      }
      if (!activeTurn.streaming) {
        activeTurn.streaming = true;
        logLine();
        logLine("assistant>");
      }
      write(message.params.delta);
      return;
    }

    if (message.method === "turn/completed") {
      if (activeTurn.streaming || activeTurn.commandStreaming) {
        logLine();
      }

      const status = message.params.turn.status;
      if (status !== "completed") {
        const errorMessage = message.params.turn.error?.message || `Turn ended with status ${status}`;
        activeTurn.reject(new Error(errorMessage));
      } else {
        activeTurn.resolve(message.params.turn);
      }
      activeTurn = null;
    }
  });

  ws.addEventListener("close", () => {
    closed = true;
    rejectPending(new Error("WebSocket closed"));
  });

  ws.addEventListener("error", (event) => {
    rejectPending(event.error ?? new Error("WebSocket error"));
  });

  async function request(method, params) {
    const id = nextId++;
    const waiter = deferred();
    pending.set(id, waiter);
    const payload = { id, method, params };
    logEnvelope("->", payload);
    send(ws, payload);
    return waiter.promise;
  }

  await request("initialize", {
    clientInfo: {
      name: "worker_app_server_chat",
      title: "Worker App Server Chat",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  const initializedPayload = {
    method: "initialized",
    params: {},
  };
  logEnvelope("->", initializedPayload);
  send(ws, initializedPayload);

  const threadStart = await request("thread/start", {
    cwd: "/workspace",
    workspaceId: requestedWorkspaceId,
    approvalPolicy: "never",
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    ...(requestedModel ? { model: requestedModel } : {}),
  });
  const threadId = threadStart.thread.id;

  logLine(`connected: ${baseUrl}`);
  logLine(`thread: ${threadId}`);
  logLine(`workspace: ${requestedWorkspaceId}`);
  logLine("Type a message and press Enter.");
  logLine("Commands: /workspace, /ls [path], /cat <path>, /write <path> <text>, /rm <path>, /events [on|off|raw], /exit");
  if (eventLogMode !== "off") {
    logLine(`event-log: ${eventLogMode}`);
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  async function handleServerRequest(message) {
    if (activeTurn?.streaming) {
      logLine();
    }

    if (message.method === "item/tool/requestUserInput") {
      const answers = {};
      const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
      for (const question of questions) {
        const choices = Array.isArray(question.options)
          ? question.options.map((option) => option.label).filter(Boolean)
          : [];
        if (choices.length > 0) {
          logLine(`tool> ${question.header || question.id}: ${choices.join(" | ")}`);
        }
        const response = process.stdin.isTTY
          ? (await rl.question(`tool> ${question.question} `)).trim()
          : choices[0] || "";
        answers[question.id] = {
          answers: response ? [response] : [],
        };
      }

      const payload = {
        id: message.id,
        result: {
          answers,
        },
      };
      logEnvelope("->", payload);
      send(ws, payload);
      return;
    }

    if (message.method === "item/tool/call") {
      const tool = message.params?.tool || "unknown_tool";
      logLine(`tool> client does not implement dynamic tool ${tool}`);
      const payload = {
        id: message.id,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: `Client does not implement dynamic tool ${tool}.`,
            },
          ],
          success: false,
        },
      };
      logEnvelope("->", payload);
      send(ws, payload);
      return;
    }

    logLine(`tool> unsupported server request ${message.method}`);
    const payload = {
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${message.method}`,
      },
    };
    logEnvelope("->", payload);
    send(ws, payload);
  }

  async function shutdown(code = 0) {
    rl.close();
    closeSocket();
    process.exitCode = code;
  }

  process.on("SIGINT", () => {
    void shutdown(130);
  });

  try {
    while (true) {
      const input = await rl.question("\nyou> ");
      const text = input.trim();

      if (!text) {
        continue;
      }
      if (text === "/exit" || text === "/quit") {
        break;
      }

      const slashCommand = parseSlashCommand(text);
      if (slashCommand) {
        try {
          switch (slashCommand.command) {
            case "/workspace": {
              const result = await request("workspace/read", { threadId });
              logLine(JSON.stringify(result.workspace, null, 2));
              continue;
            }
            case "/ls": {
              const result = await request("workspace/list", {
                threadId,
                path: slashCommand.rest || "/workspace",
              });
              if (!result.entries.length) {
                logLine("(empty)");
                continue;
              }
              for (const entry of result.entries) {
                if (entry.type === "directory") {
                  logLine(`dir  ${entry.path}`);
                } else {
                  logLine(`file ${entry.path} (${entry.size} bytes)`);
                }
              }
              continue;
            }
            case "/cat": {
              if (!slashCommand.rest) {
                throw new Error("Usage: /cat <path>");
              }
              const result = await request("workspace/readFile", {
                threadId,
                path: slashCommand.rest,
              });
              logLine(result.file.content);
              continue;
            }
            case "/write": {
              const { path, value } = splitPathAndValue(slashCommand.rest);
              if (!path) {
                throw new Error("Usage: /write <path> <text>");
              }
              const result = await request("workspace/writeFile", {
                threadId,
                path,
                content: value,
              });
              logLine(`wrote ${result.file.path} @ rev ${result.workspace.revision}`);
              continue;
            }
            case "/rm": {
              if (!slashCommand.rest) {
                throw new Error("Usage: /rm <path>");
              }
              const result = await request("workspace/deleteFile", {
                threadId,
                path: slashCommand.rest,
              });
              logLine(`deleted ${result.deleted.join(", ")}`);
              continue;
            }
            case "/events": {
              const nextMode = parseEventLogMode(slashCommand.rest || "summary");
              eventLogMode = nextMode;
              logLine(`event-log: ${eventLogMode}`);
              continue;
            }
            default:
              throw new Error(`Unknown command: ${slashCommand.command}`);
          }
        } catch (error) {
          logLine(`error: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      const completion = deferred();
      activeTurn = {
        resolve: completion.resolve,
        reject: completion.reject,
        streaming: false,
        commandStreaming: false,
      };

      try {
        await request("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text,
              text_elements: [],
            },
          ],
        });
        await completion.promise;
      } catch (error) {
        activeTurn = null;
        logLine();
        logLine(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
