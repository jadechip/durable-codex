const BASE_URL = process.env.APP_SERVER_BASE_URL || "http://127.0.0.1:8787";
const WORKSPACE_ID = process.env.APP_SERVER_WORKSPACE_ID || `live-smoke-${Date.now()}`;
const TIMEOUT_MS = Number.parseInt(process.env.APP_SERVER_SMOKE_TIMEOUT_MS || "60000", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWsUrl(url) {
  return url.replace(/^https:/, "wss:");
}

async function createSession() {
  const response = await fetch(`${BASE_URL}/sessions`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`session create failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function openClient() {
  const session = await createSession();
  const ws = new WebSocket(normalizeWsUrl(session.websocketUrl));
  const pending = new Map();
  const notifications = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data.toString());
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
      return;
    }
    notifications.push(message);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  async function rpc(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await rpc(1, "initialize", {
    clientInfo: { name: "live-smoke", title: "live-smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const threadStart = await rpc(2, "thread/start", {
    cwd: "/workspace",
    approvalPolicy: "never",
    workspaceId: WORKSPACE_ID,
  });

  return {
    ws,
    rpc,
    notifications,
    threadId: threadStart.result.thread.id,
  };
}

async function waitForTurnCompletion(notifications, turnId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const completed = notifications.find((entry) =>
      entry.method === "turn/completed" && (entry.params?.turn?.id === turnId || entry.params?.turnId === turnId),
    );
    if (completed) {
      return completed;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for turn ${turnId}`);
}

async function runPrompt(client, nextId, prompt) {
  const turnStart = await client.rpc(nextId, "turn/start", {
    threadId: client.threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  });
  const turnId = turnStart.result.turn.id;
  await waitForTurnCompletion(client.notifications, turnId);
  const resumed = await client.rpc(nextId + 1, "thread/resume", {
    threadId: client.threadId,
    persistExtendedHistory: true,
  });
  const turn = resumed.result.thread.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    throw new Error(`turn ${turnId} not found in resume response`);
  }
  return turn;
}

function unwrapRpcResult(message, label) {
  if (message?.error) {
    const detail = typeof message.error?.message === "string" ? message.error.message : JSON.stringify(message.error);
    throw new Error(`${label} failed: ${detail}`);
  }
  if (!message || typeof message !== "object" || !message.result) {
    throw new Error(`${label} returned an invalid RPC payload`);
  }
  return message.result;
}

async function readWorkspaceFile(client, nextId, path) {
  const response = await client.rpc(nextId, "workspace/readFile", {
    threadId: client.threadId,
    path,
  });
  const result = unwrapRpcResult(response, `workspace/readFile ${path}`);
  return result.file.content;
}

function summarizeTurn(turn) {
  const command = turn.items.find((item) => item.type === "commandExecution") ?? null;
  const assistant = turn.items.find((item) => item.type === "agentMessage") ?? null;
  return {
    status: turn.status,
    commandDriver: command?.driver ?? null,
    command: command?.command ?? null,
    commandStatus: command?.status ?? null,
    aggregatedOutput: command?.aggregatedOutput ?? null,
    assistant: assistant?.text ?? null,
  };
}

async function main() {
  const client = await openClient();

  try {
    const tests = [
      {
        name: "workerBuiltin-pwd",
        prompt: "Run pwd using exec_command and then tell me the result.",
      },
      {
        name: "workerBuiltin-shell-wrapper",
        prompt: "Please list /workspace recursively.",
      },
      {
        name: "dynamicWorker-node-eval",
        prompt: "Run node -e \"const fs=require('fs'); fs.writeFileSync('/workspace/dynamic.txt','hello from dynamic\\n'); console.log('dynamic ok')\" and then tell me the result.",
      },
      {
        name: "dynamicWorker-python-eval",
        prompt: "Run python3 -c \"from pathlib import Path; print('python ok'); Path('/workspace/python.txt').write_text('hello from python\\n')\" and then tell me the result.",
      },
      {
        name: "sandbox-python-fallback",
        prompt: "Run python3 -c \"import subprocess; value = subprocess.check_output(['python3','-c','print(42)'], text=True); open('/workspace/python-sandbox.txt','w').write(value); print(value.strip())\" and then tell me the result.",
      },
      {
        name: "sandbox-shell",
        prompt: "Run sh -lc 'printf \"hello from sandbox\\n\" > /workspace/sandbox.txt && cat /workspace/sandbox.txt' and then tell me the result.",
      },
      {
        name: "sandbox-pty",
        prompt: "Use exec_command with tty=true to run /bin/sh -lc 'printf \"ready\\n\"; read line; printf \"%s\\n\" \"$line\" > /workspace/pty.txt; printf \"saved\\n\"', then use write_stdin to send exactly hello via pty followed by a newline, wait for completion, and tell me the result.",
      },
    ];

    const results = [];
    let nextId = 10;
    for (const test of tests) {
      console.error(`[live-smoke] running ${test.name}`);
      const turn = await runPrompt(client, nextId, test.prompt);
      nextId += 10;
      results.push({
        name: test.name,
        ...summarizeTurn(turn),
      });
      console.error(`[live-smoke] completed ${test.name}: driver=${results.at(-1)?.commandDriver ?? "none"} status=${results.at(-1)?.status}`);
    }

    const dynamicRead = await readWorkspaceFile(client, nextId, "/workspace/dynamic.txt");
    const pythonRead = await readWorkspaceFile(client, nextId + 1, "/workspace/python.txt");
    const pythonSandboxRead = await readWorkspaceFile(client, nextId + 2, "/workspace/python-sandbox.txt");
    const sandboxRead = await readWorkspaceFile(client, nextId + 3, "/workspace/sandbox.txt");
    const ptyRead = await readWorkspaceFile(client, nextId + 4, "/workspace/pty.txt");

    console.log(JSON.stringify({
      baseUrl: BASE_URL,
      workspaceId: WORKSPACE_ID,
      results,
      files: {
        dynamic: dynamicRead,
        python: pythonRead,
        pythonSandbox: pythonSandboxRead,
        sandbox: sandboxRead,
        pty: ptyRead,
      },
    }, null, 2));
  } finally {
    client.ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
