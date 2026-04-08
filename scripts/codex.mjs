#!/usr/bin/env node

import readline from "node:readline/promises";
import process from "node:process";
import { buildExecUsage, parseExecArgs } from "../src/lib/exec-cli.js";

function logStdout(message = "") {
  process.stdout.write(`${message}\n`);
}

function writeStdout(message) {
  process.stdout.write(message);
}

function logStderr(message = "") {
  process.stderr.write(`${message}\n`);
}

function writeStderr(message) {
  process.stderr.write(message);
}

function normalizeWsUrl(url) {
  return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function timestampLabel() {
  return new Date().toISOString().slice(11, 23);
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
      return `request ${message.method}#${message.id}`;
    }
    return `notify ${message.method}`;
  }
  if (Object.prototype.hasOwnProperty.call(message ?? {}, "id")) {
    if (message.error) {
      return `response #${message.id} error=${message.error.code ?? "unknown"} ${message.error.message ?? ""}`.trim();
    }
    return `response #${message.id} ok ${previewText(JSON.stringify(message.result ?? {}), 100)}`;
  }
  return "message";
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function createSession(baseUrl) {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function openSocket(url) {
  const ws = new WebSocket(normalizeWsUrl(url));

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

async function readPromptFromStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text.trim()));
    process.stdin.on("error", reject);
  });
}

async function runExec(rawArgs) {
  const options = parseExecArgs(rawArgs);
  if (options.help) {
    logStdout(buildExecUsage());
    return 0;
  }

  if (!options.prompt) {
    options.prompt = await readPromptFromStdin();
  }
  if (!options.prompt) {
    logStderr(buildExecUsage());
    throw new Error("codex exec requires a prompt");
  }

  const session = await createSession(options.baseUrl);
  const ws = await openSocket(session.websocketUrl);
  const pending = new Map();
  let nextId = 1;
  let activeTurn = null;
  let threadId = null;
  let rl = null;

  function flushStreams() {
    if (!activeTurn) {
      return;
    }
    if (activeTurn.assistantStreaming || activeTurn.commandStreaming) {
      logStdout();
      activeTurn.assistantStreaming = false;
      activeTurn.commandStreaming = false;
    }
  }

  function maybeLogEnvelope(direction, payload) {
    if (!options.rawEvents) {
      return;
    }
    writeStderr(`[${timestampLabel()}] ${direction} ${JSON.stringify(payload)}\n`);
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

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    maybeLogEnvelope("<-", message);

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

    if (message.method === "item/commandExecution/outputDelta" && !options.json) {
      if (activeTurn.assistantStreaming) {
        logStdout();
        activeTurn.assistantStreaming = false;
      }
      if (!activeTurn.commandStreaming) {
        activeTurn.commandStreaming = true;
        logStdout();
        logStdout("command>");
      }
      writeStdout(message.params.delta);
      return;
    }

    if (message.method === "item/commandExecution/terminalInteraction" && !options.json) {
      flushStreams();
      logStdout(`stdin[${message.params.processId}]> ${JSON.stringify(message.params.stdin)}`);
      return;
    }

    if (message.method === "item/agentMessage/delta" && !options.json) {
      if (activeTurn.commandStreaming) {
        logStdout();
        activeTurn.commandStreaming = false;
      }
      if (!activeTurn.assistantStreaming) {
        activeTurn.assistantStreaming = true;
      }
      writeStdout(message.params.delta);
      return;
    }

    if (message.method === "turn/completed") {
      flushStreams();
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
    maybeLogEnvelope("->", payload);
    send(ws, payload);
    return waiter.promise;
  }

  async function handleServerRequest(message) {
    if (options.rawEvents) {
      writeStderr(`[${timestampLabel()}] info ${summarizeEnvelope(message)}\n`);
    }

    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
      const answers = {};

      if (!process.stdin.isTTY) {
        const payload = {
          id: message.id,
          error: {
            code: -32601,
            message: "request_user_input requires an interactive terminal",
          },
        };
        maybeLogEnvelope("->", payload);
        send(ws, payload);
        return;
      }

      rl ??= readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: process.stdin.isTTY,
      });

      flushStreams();
      for (const question of questions) {
        const response = (await rl.question(`tool> ${question.question} `)).trim();
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
      maybeLogEnvelope("->", payload);
      send(ws, payload);
      return;
    }

    const tool = message.params?.tool || "unknown_tool";
    const payload = {
      id: message.id,
      result: {
        contentItems: [
          {
            type: "inputText",
            text: `CLI does not implement dynamic tool ${tool}.`,
          },
        ],
        success: false,
      },
    };
    maybeLogEnvelope("->", payload);
    send(ws, payload);
  }

  try {
    await request("initialize", {
      clientInfo: {
        name: "durable_codex_exec",
        title: "Durable Codex Exec",
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
    maybeLogEnvelope("->", initializedPayload);
    send(ws, initializedPayload);

    const threadStart = await request("thread/start", {
      cwd: options.cwd,
      workspaceId: options.workspaceId,
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ...(options.model ? { model: options.model } : {}),
    });
    threadId = threadStart.thread.id;

    const completion = deferred();
    activeTurn = {
      resolve: completion.resolve,
      reject: completion.reject,
      assistantStreaming: false,
      commandStreaming: false,
    };

    const turnStart = await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: [],
        },
      ],
    });

    const completedTurn = await completion.promise;

    if (options.json) {
      const resumed = await request("thread/resume", {
        threadId,
        persistExtendedHistory: true,
      });
      const turn = resumed.thread.turns.find((entry) => entry.id === turnStart.turn.id);
      logStdout(JSON.stringify(turn ?? completedTurn, null, 2));
    } else if (!completedTurn) {
      logStdout();
    }

    return 0;
  } finally {
    rl?.close();
    try {
      ws.close(1000, "exec-complete");
    } catch {}
  }
}

function buildUsage() {
  return [
    "Usage:",
    "  codex exec [options] <prompt>",
    "",
    "Subcommands:",
    "  exec    Run a one-off task against Durable Codex",
  ].join("\n");
}

async function main() {
  const [, , subcommand, ...args] = process.argv;

  if (!subcommand || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    logStdout(buildUsage());
    return;
  }

  if (subcommand !== "exec") {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }

  process.exitCode = await runExec(args);
}

main().catch((error) => {
  logStderr(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
