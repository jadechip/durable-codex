const port = process.env.APP_SERVER_PORT || process.env.PORT || "8787";
const host = process.env.APP_SERVER_HOST || "127.0.0.1";
const baseUrl = process.env.APP_SERVER_BASE_URL || `http://${host}:${port}`;
const prompt =
  process.env.APP_SERVER_PROMPT ||
  "Write a clear five-paragraph explanation of this worker app-server architecture so the streamed output is visibly incremental.";
const rawMode = process.env.APP_SERVER_DEMO_RAW === "1";
const requestedModel = process.env.APP_SERVER_MODEL || null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logJson(message) {
  console.log(JSON.stringify(message, null, 2));
}

function logLine(message = "") {
  process.stdout.write(`${message}\n`);
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
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

async function main() {
  const session = await createSession();
  const ws = new WebSocket(session.websocketUrl);

  let threadId = null;
  let finalTurnSeen = false;
  let closing = false;
  let assistantStreaming = false;
  let turnQueued = false;
  let pendingTurnStartedId = null;

  ws.addEventListener("open", () => {
    if (!rawMode) {
      logLine(`connected: ${session.websocketUrl}`);
    }
    send(ws, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "worker_app_server_demo",
          title: "Worker App Server Demo",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });
  });

  ws.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      if (!rawMode) {
        logLine(`server request: ${message.method}`);
      }

      if (message.method === "item/tool/requestUserInput") {
        const answers = {};
        const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
        for (const question of questions) {
          const label = Array.isArray(question.options) && question.options[0]?.label
            ? question.options[0].label
            : "Demo answer";
          answers[question.id] = {
            answers: [label],
          };
        }
        send(ws, {
          id: message.id,
          result: {
            answers,
          },
        });
        return;
      }

      if (message.method === "item/tool/call") {
        send(ws, {
          id: message.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: `Demo client does not implement dynamic tool ${message.params?.tool || "unknown_tool"}.`,
              },
            ],
            success: false,
          },
        });
        return;
      }

      send(ws, {
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${message.method}`,
        },
      });
      return;
    }

    if (rawMode) {
      logJson(message);
    } else if (message.id === 1) {
      logLine("initialized");
    } else if (message.id === 2) {
      logLine(`thread started: ${message.result.thread.id}`);
    } else if (message.id === 3) {
      turnQueued = true;
      logLine(`turn queued: ${message.result.turn.id}`);
      if (pendingTurnStartedId) {
        logLine(`turn started: ${pendingTurnStartedId}`);
        pendingTurnStartedId = null;
      }
    } else if (message.method === "turn/started") {
      if (turnQueued) {
        logLine(`turn started: ${message.params.turn.id}`);
      } else {
        pendingTurnStartedId = message.params.turn.id;
      }
    } else if (message.method === "item/agentMessage/delta") {
      if (!assistantStreaming) {
        assistantStreaming = true;
        logLine();
        logLine("assistant>");
      }
      process.stdout.write(message.params.delta);
    } else if (message.method === "turn/completed") {
      if (assistantStreaming) {
        logLine();
      }
      logLine(`turn completed: ${message.params.turn.status}`);
      if (message.params.turn.error?.message) {
        logLine(`error: ${message.params.turn.error.message}`);
      }
    }

    if (message.id === 1) {
      send(ws, {
        method: "initialized",
        params: {},
      });
      send(ws, {
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/workspace",
          approvalPolicy: "never",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          ...(requestedModel ? { model: requestedModel } : {}),
        },
      });
      return;
    }

    if (message.id === 2) {
      threadId = message.result.thread.id;
      send(ws, {
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [
            {
              type: "text",
              text: prompt,
              text_elements: [],
            },
          ],
        },
      });
      return;
    }

    if (message.method === "turn/completed") {
      finalTurnSeen = true;
      closing = true;
      await delay(100);
      ws.close(1000, "demo-complete");
    }
  });

  ws.addEventListener("close", () => {
    if (!finalTurnSeen) {
      process.exitCode = 1;
    }
  });

  ws.addEventListener("error", (error) => {
    if (finalTurnSeen || closing) {
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
