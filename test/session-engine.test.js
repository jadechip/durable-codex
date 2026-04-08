import test from "node:test";
import assert from "node:assert/strict";

import { createDynamicWorkerDriver } from "../src/lib/dynamic-worker-driver.js";
import { AppServerSessionEngine } from "../src/lib/session-engine.js";
import { createSandboxBroker } from "../src/lib/sandbox-broker.js";
import { createWorkspaceStore } from "../src/lib/vfs-store.js";

function createIdFactory() {
  let counter = 0;
  return (prefix) => `${prefix}_${++counter}`;
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

function createReadyConnection(overrides = {}) {
  return {
    phase: "ready",
    experimentalApi: false,
    optOutNotificationMethods: [],
    ...overrides,
  };
}

function createStreamingModelClient(outputs, requests) {
  const queue = [...outputs];

  return {
    async *streamResponse(args) {
      requests.push(args);
      const next = queue.shift() ?? queue[queue.length - 1] ?? "Model response text.";

      if (Array.isArray(next)) {
        for (const event of next) {
          yield event;
        }
        return;
      }

      const text = typeof next === "string" ? next : next?.text ?? "Model response text.";
      const midpoint = Math.ceil(text.length / 2);
      yield {
        type: "output_text.delta",
        delta: text.slice(0, midpoint),
        responseId: "resp_test",
      };
      yield {
        type: "output_text.delta",
        delta: text.slice(midpoint),
        responseId: "resp_test",
      };
      yield {
        type: "completed",
        responseId: "resp_test",
        response: null,
      };
    },
  };
}

function createEngine({
  modelText = "Model response text.",
  modelTexts = null,
  modelClient = null,
  defaultModel = "gpt-5.3-codex",
  defaultModelProvider = null,
  defaultModelByProvider = null,
  sandboxBroker = null,
  workspaceStore = createWorkspaceStore(),
} = {}) {
  let persistedState = null;
  const notifications = [];
  const requests = [];
  const outputs = Array.isArray(modelTexts) && modelTexts.length > 0 ? [...modelTexts] : [modelText];
  const engine = new AppServerSessionEngine({
    loadState: async () => persistedState,
    saveState: async (nextState) => {
      persistedState = structuredClone(nextState);
    },
    modelClient: modelClient ?? createStreamingModelClient(outputs, requests),
    workspaceStore,
    sandboxBroker,
    notify: (envelope) => {
      notifications.push(envelope);
    },
    defaultModel,
    defaultModelProvider,
    defaultModelByProvider,
    now: () => 1_710_000_000_000,
    createId: createIdFactory(),
  });

  return {
    engine,
    notifications,
    requests,
    getPersistedState() {
      return persistedState;
    },
  };
}

function createStubSandboxBroker(workspaceStore, handler) {
  const handlers = typeof handler === "function" ? { executeCommand: handler } : handler;
  return createSandboxBroker({
    workspaceStore,
    now: () => 1_710_000_000_000,
    commandExecutor: {
      async executeCommand(request) {
        return handlers.executeCommand(request);
      },
      ...(typeof handlers.writeStdin === "function"
        ? {
            async writeStdin(request) {
              return handlers.writeStdin(request);
            },
          }
        : {}),
      ...(typeof handlers.closeSession === "function"
        ? {
            async closeSession(request) {
              return handlers.closeSession(request);
            },
          }
        : {}),
    },
  });
}

test("initialize requires the initialized notification before other methods", async () => {
  const { engine } = createEngine();
  const connection = { phase: "uninitialized", experimentalApi: false, optOutNotificationMethods: [] };

  const initializeResponse = await engine.handleRpc({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "test-client",
        title: "Test Client",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    },
  }, connection);

  assert.equal(initializeResponse.result.platformFamily, "unix");
  assert.equal(connection.phase, "awaiting_initialized");

  const rejected = await engine.handleRpc({
    id: 2,
    method: "thread/start",
    params: {},
  }, connection);

  assert.equal(rejected.error.code, -32000);

  await engine.handleRpc({ method: "initialized", params: {} }, connection);
  assert.equal(connection.phase, "ready");
});

test("thread/start and turn/start produce persisted state and app-server notifications", async () => {
  const { engine, notifications, getPersistedState } = createEngine({
    modelText: "Hello from the worker-native app-server MVP.",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 10,
    method: "thread/start",
    params: {
      model: "gpt-5.1",
      cwd: "/repo",
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    },
  }, connection);

  assert.equal(threadStart.result.thread.id, "thr_1");
  assert.equal(threadStart.result.thread.status.type, "idle");
  assert.equal(threadStart.result.thread.workspaceId, "default");
  assert.equal(threadStart.result.thread.workspace.id, "default");
  assert.equal(threadStart.result.thread.workspace.root, "/repo");
  assert.equal(threadStart.result.thread.workspace.mode, "virtual");
  assert.equal(threadStart.result.thread.workspace.attachedSandboxId, null);
  assert.equal(notifications[0].method, "thread/started");

  const turnStart = await engine.handleRpc({
    id: 11,
    method: "turn/start",
    params: {
      threadId: "thr_1",
      input: [
        {
          type: "text",
          text: "Explain the current architecture.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  assert.equal(turnStart.result.turn.id, "turn_2");
  assert.equal(turnStart.result.turn.status, "inProgress");

  await engine.waitForIdle();

  const methods = notifications.map((entry) => entry.method);
  assert.deepEqual(methods, [
    "thread/started",
    "turn/started",
    "item/started",
    "item/completed",
    "item/started",
    "item/agentMessage/delta",
    "item/agentMessage/delta",
    "item/completed",
    "turn/completed",
  ]);

  const resumed = await engine.handleRpc({
    id: 12,
    method: "thread/resume",
    params: {
      threadId: "thr_1",
      persistExtendedHistory: true,
    },
  }, connection);

  assert.equal(resumed.result.thread.turns.length, 1);
  assert.equal(resumed.result.thread.turns[0].status, "completed");
  assert.equal(resumed.result.thread.turns[0].items[0].type, "userMessage");
  assert.equal(resumed.result.thread.turns[0].items[1].type, "agentMessage");
  assert.match(resumed.result.thread.turns[0].items[1].text, /worker-native app-server MVP/);
  assert.equal(resumed.result.thread.workspace.root, "/repo");
  assert.equal(getPersistedState().threads.thr_1.turns[0].status, "completed");
});

test("workspace VFS operations persist through the Worker runtime without a sandbox", async () => {
  const { engine } = createEngine();
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 90,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      approvalPolicy: "never",
    },
  }, connection);

  const threadId = threadStart.result.thread.id;

  const write = await engine.handleRpc({
    id: 91,
    method: "workspace/writeFile",
    params: {
      threadId,
      path: "/workspace/notes/todo.md",
      content: "ship the worker vfs",
    },
  }, connection);

  assert.equal(write.result.workspace.revision, 1);
  assert.equal(write.result.file.path, "/workspace/notes/todo.md");

  const list = await engine.handleRpc({
    id: 92,
    method: "workspace/list",
    params: {
      threadId,
      path: "/workspace",
    },
  }, connection);

  assert.deepEqual(list.result.entries, [
    {
      type: "directory",
      path: "/workspace/notes",
      name: "notes",
    },
  ]);

  const readFile = await engine.handleRpc({
    id: 93,
    method: "workspace/readFile",
    params: {
      threadId,
      path: "/workspace/notes/todo.md",
    },
  }, connection);

  assert.equal(readFile.result.file.content, "ship the worker vfs");
  assert.equal(readFile.result.workspace.attachedSandboxId, null);

  const remove = await engine.handleRpc({
    id: 94,
    method: "workspace/deleteFile",
    params: {
      threadId,
      path: "/workspace/notes/todo.md",
    },
  }, connection);

  assert.deepEqual(remove.result.deleted, ["/workspace/notes/todo.md"]);
  assert.equal(remove.result.workspace.revision, 2);
});

test("the apply_patch tool lets the model create files on the shared VFS", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_workspace_tool_1",
      item: {
        type: "function_call",
        call_id: "call_workspace_write_1",
        name: "apply_patch",
        arguments: JSON.stringify({
          input: "*** Begin Patch\n*** Add File: agent.txt\n+created by apply_patch\n*** End Patch\n",
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_workspace_tool_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_text.delta",
      responseId: "resp_workspace_tool_2",
      delta: "I created the file.",
    },
    {
      type: "completed",
      responseId: "resp_workspace_tool_2",
      response: null,
    },
  ];

  const { engine, requests } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo],
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 99,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "shared-tools",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 100,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Create a file in the workspace.",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const read = await engine.handleRpc({
    id: 101,
    method: "workspace/readFile",
    params: {
      threadId: threadStart.result.thread.id,
      path: "/workspace/agent.txt",
    },
  }, connection);
  const resumed = await engine.handleRpc({
    id: 106,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);
  const fileChangeItem = resumed.result.thread.turns[0].items.find((item) => item.type === "fileChange");

  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some((tool) => tool.name === "apply_patch"));
  assert.equal(requests[1].previousResponseId, "resp_workspace_tool_1");
  assert.equal(read.result.file.content, "created by apply_patch\n");
  assert.equal(fileChangeItem.status, "completed");
  assert.equal(fileChangeItem.changes[0].path, "agent.txt");
});

test("the exec_command tool routes through the sandbox broker and syncs files back", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_exec_tool_1",
      item: {
        type: "function_call",
        call_id: "call_exec_1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "printf 'from exec\\n' > /workspace/from-command.txt",
          workdir: "/workspace",
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_exec_tool_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_text.delta",
      responseId: "resp_exec_tool_2",
      delta: "The command completed.",
    },
    {
      type: "completed",
      responseId: "resp_exec_tool_2",
      response: null,
    },
  ];

  const workspaceStore = createWorkspaceStore();
  const sandboxBroker = createStubSandboxBroker(workspaceStore, async (request) => ({
    sandboxId: `workspace-${request.workspaceId}`,
    stdout: "",
    stderr: "",
    exitCode: 0,
    changedFiles: [
      {
        path: "/workspace/from-command.txt",
        content: "from exec\n",
      },
    ],
    removedPaths: [],
  }));

  const { engine, requests } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo],
    sandboxBroker,
    workspaceStore,
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 102,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "shared-exec",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 103,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Create a file using exec_command.",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const read = await engine.handleRpc({
    id: 104,
    method: "workspace/readFile",
    params: {
      threadId: threadStart.result.thread.id,
      path: "/workspace/from-command.txt",
    },
  }, connection);

  const resumed = await engine.handleRpc({
    id: 105,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);

  const commandItem = resumed.result.thread.turns[0].items.find((item) => item.type === "commandExecution");

  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some((tool) => tool.name === "exec_command"));
  assert.equal(read.result.file.content, "from exec\n");
  assert.equal(commandItem.status, "completed");
  assert.equal(commandItem.command, "printf 'from exec\\n' > /workspace/from-command.txt");
});

test("tty exec_command sessions can continue with write_stdin and complete the original command item", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_exec_tty_1",
      item: {
        type: "function_call",
        call_id: "call_exec_tty_1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "python -i /workspace/repl.py",
          workdir: "/workspace",
          tty: true,
          yield_time_ms: 50,
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_exec_tty_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_item.done",
      responseId: "resp_exec_tty_2",
      item: {
        type: "function_call",
        call_id: "call_exec_tty_2",
        name: "write_stdin",
        arguments: JSON.stringify({
          session_id: 1,
          chars: "hello from stdin\\n",
          yield_time_ms: 50,
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_exec_tty_2",
      response: null,
    },
  ];
  const toolCycleThree = [
    {
      type: "output_text.delta",
      responseId: "resp_exec_tty_3",
      delta: "Interactive command finished.",
    },
    {
      type: "completed",
      responseId: "resp_exec_tty_3",
      response: null,
    },
  ];

  const workspaceStore = createWorkspaceStore();
  const sandboxBroker = createStubSandboxBroker(workspaceStore, {
    async executeCommand(request) {
      return {
        sandboxId: `workspace-${request.workspaceId}`,
        sandboxSessionId: "sandbox-session-1",
        marker: "__CODEX_EXIT_MARKER__",
        sessionOpen: true,
        outputText: "ready for stdin\n",
        exitCode: null,
        changedFiles: [],
        removedPaths: [],
      };
    },
    async writeStdin(request) {
      assert.equal(request.sandboxSessionId, "sandbox-session-1");
      assert.equal(request.marker, "__CODEX_EXIT_MARKER__");
      return {
        sandboxId: `workspace-${request.workspaceId}`,
        sandboxSessionId: null,
        marker: null,
        sessionOpen: false,
        outputText: "echo: hello from stdin\n",
        exitCode: 0,
        changedFiles: [
          {
            path: "/workspace/repl.txt",
            content: "echo: hello from stdin\n",
          },
        ],
        removedPaths: [],
      };
    },
  });

  const { engine, requests, notifications } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo, toolCycleThree],
    sandboxBroker,
    workspaceStore,
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 106,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "tty-shared",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 107,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Open an interactive command and send input to it.",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 108,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);
  const read = await engine.handleRpc({
    id: 109,
    method: "workspace/readFile",
    params: {
      threadId: threadStart.result.thread.id,
      path: "/workspace/repl.txt",
    },
  }, connection);

  const turn = resumed.result.thread.turns[0];
  const commandItem = turn.items.find((item) => item.type === "commandExecution");
  const stdinItem = turn.items.find((item) => item.type === "functionToolCall" && item.toolName === "write_stdin");

  assert.equal(requests.length, 3);
  assert.ok(requests[0].tools.some((tool) => tool.name === "write_stdin"));
  assert.ok(
    requests[1].input.some((item) => item.type === "function_call_output" && /"session_id": 1/.test(item.output)),
  );
  assert.equal(commandItem.status, "completed");
  assert.equal(commandItem.processId, "1");
  assert.equal(commandItem.sessionId, 1);
  assert.match(commandItem.aggregatedOutput, /ready for stdin/);
  assert.match(commandItem.aggregatedOutput, /echo: hello from stdin/);
  assert.equal(stdinItem.status, "completed");
  assert.equal(read.result.file.content, "echo: hello from stdin\n");
  assert.ok(notifications.some((entry) => entry.method === "item/commandExecution/outputDelta"));
  assert.ok(notifications.some((entry) => entry.method === "item/commandExecution/terminalInteraction"));
});

test("exec_command can complete entirely inside the worker driver without sandbox execution", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_worker_exec_1",
      item: {
        type: "function_call",
        call_id: "call_worker_exec_1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "pwd",
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_worker_exec_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_text.delta",
      responseId: "resp_worker_exec_2",
      delta: "Checked the working directory.",
    },
    {
      type: "completed",
      responseId: "resp_worker_exec_2",
      response: null,
    },
  ];

  const workspaceStore = createWorkspaceStore();
  const sandboxBroker = createSandboxBroker({
    workspaceStore,
  });
  const { engine, requests } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo],
    sandboxBroker,
    workspaceStore,
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 1001,
    method: "thread/start",
    params: {
      cwd: "/workspace/demo",
      workspaceId: "worker-exec",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 1002,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Run pwd and then confirm you checked it.",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 1003,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);

  const turn = resumed.result.thread.turns[0];
  const commandItem = turn.items.find((item) => item.type === "commandExecution");

  assert.equal(requests.length, 2);
  assert.ok(
    requests[1].input.some((item) => item.type === "function_call_output" && /"driver": "workerBuiltin"/.test(item.output)),
  );
  assert.equal(commandItem.driver, "workerBuiltin");
  assert.equal(commandItem.status, "completed");
  assert.match(commandItem.aggregatedOutput, /\/workspace\/demo/);
});

test("exec_command can route through the dynamic worker driver and sync files back", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_dynamic_exec_1",
      item: {
        type: "function_call",
        call_id: "call_dynamic_exec_1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "node -e \"console.log('dynamic');\"",
          workdir: "/workspace",
        }),
      },
    },
    {
      type: "completed",
      responseId: "resp_dynamic_exec_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_text.delta",
      responseId: "resp_dynamic_exec_2",
      delta: "The dynamic command completed.",
    },
    {
      type: "completed",
      responseId: "resp_dynamic_exec_2",
      response: null,
    },
  ];

  const workspaceStore = createWorkspaceStore();
  const dynamicWorkerDriver = createDynamicWorkerDriver({
    loader: {
      load(definition) {
        return {
          getEntrypoint() {
            return {
              async fetch() {
                const payload = definition.env.PAYLOAD;
                return Response.json({
                  stdout: "dynamic worker ran\n",
                  stderr: "",
                  exitCode: 0,
                  changedFiles: [
                    {
                      path: "/workspace/from-dynamic.txt",
                      content: `cwd:${payload.cwd}\n`,
                    },
                  ],
                  removedPaths: [],
                });
              },
            };
          },
        };
      },
    },
    workspaceStore,
  });
  const sandboxBroker = createSandboxBroker({
    workspaceStore,
    commandDrivers: [dynamicWorkerDriver],
    commandExecutor: {
      async executeCommand() {
        throw new Error("sandbox executor should not be used for direct node eval");
      },
    },
  });
  const { engine, requests } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo],
    sandboxBroker,
    workspaceStore,
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 1004,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "dynamic-exec",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 1005,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Run a node eval command and sync its file change.",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 1006,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);
  const read = await engine.handleRpc({
    id: 1007,
    method: "workspace/readFile",
    params: {
      threadId: threadStart.result.thread.id,
      path: "/workspace/from-dynamic.txt",
    },
  }, connection);

  const turn = resumed.result.thread.turns[0];
  const commandItem = turn.items.find((item) => item.type === "commandExecution");

  assert.equal(requests.length, 2);
  assert.ok(
    requests[1].input.some((item) => item.type === "function_call_output" && /"driver": "dynamicWorker"/.test(item.output)),
  );
  assert.equal(commandItem.driver, "dynamicWorker");
  assert.equal(commandItem.status, "completed");
  assert.match(commandItem.aggregatedOutput, /dynamic worker ran/);
  assert.equal(read.result.file.content, "cwd:/workspace\n");
});

test("multiple threads can share the same workspace id", async () => {
  const { engine } = createEngine();
  const connection = createReadyConnection();

  const firstThread = await engine.handleRpc({
    id: 95,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "shared",
      approvalPolicy: "never",
    },
  }, connection);

  const secondThread = await engine.handleRpc({
    id: 96,
    method: "thread/start",
    params: {
      cwd: "/workspace",
      workspaceId: "shared",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 97,
    method: "workspace/writeFile",
    params: {
      threadId: firstThread.result.thread.id,
      path: "/workspace/shared.txt",
      content: "visible across threads",
    },
  }, connection);

  const read = await engine.handleRpc({
    id: 98,
    method: "workspace/readFile",
    params: {
      threadId: secondThread.result.thread.id,
      path: "/workspace/shared.txt",
    },
  }, connection);

  assert.equal(firstThread.result.thread.workspaceId, "shared");
  assert.equal(secondThread.result.thread.workspaceId, "shared");
  assert.equal(read.result.workspace.id, "shared");
  assert.equal(read.result.file.content, "visible across threads");
});

test("thread/start uses the configured default model when none is provided", async () => {
  const { engine } = createEngine({
    defaultModel: "gpt-5.3-codex",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 13,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  assert.equal(threadStart.result.model, "gpt-5.3-codex");
});

test("default model requests include upstream Codex base instructions", async () => {
  const { engine, requests } = createEngine({
    defaultModel: "gpt-5.3-codex",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 14,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 15,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Who are you?",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-5.3-codex");
  assert.match(requests[0].baseInstructions, /^You are Codex,/);
});

test("thread modelProvider is forwarded to the model request", async () => {
  const { engine, requests } = createEngine();
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 100,
    method: "thread/start",
    params: {
      model: "openrouter/auto",
      modelProvider: "openrouter",
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 101,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Who are you?",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "openrouter/auto");
  assert.equal(requests[0].modelProvider, "openrouter");
});

test("thread start uses configured default provider and provider model", async () => {
  const { engine } = createEngine({
    defaultModel: "gpt-5.3-codex",
    defaultModelProvider: "openrouter",
    defaultModelByProvider: {
      openrouter: "openrouter/auto",
      openai: "gpt-5.3-codex",
    },
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 900,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  assert.equal(threadStart.result.modelProvider, "openrouter");
  assert.equal(threadStart.result.model, "openrouter/auto");
});

test("first turn injects Codex-style developer and contextual user messages", async () => {
  const { engine, requests } = createEngine({
    defaultModel: "gpt-5.3-codex",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 16,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
      developerInstructions: "Stay precise.",
      userInstructions: "Always prefer minimal patches.",
      collaborationMode: {
        settings: {
          developerInstructions: "Use terse updates.",
        },
      },
      shell: "zsh",
      timezone: "Asia/Bangkok",
      currentDate: "2026-04-02",
    },
  }, connection);

  await engine.handleRpc({
    id: 17,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Who are you?",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].developerInstructions, undefined);
  assert.equal(requests[0].input.length, 3);
  assert.equal(requests[0].input[0].role, "developer");
  assert.ok(requests[0].input[0].content.some((part) => part.text.includes("<permissions instructions>")));
  assert.ok(requests[0].input[0].content.some((part) => part.text.includes("Stay precise.")));
  assert.ok(requests[0].input[0].content.some((part) => part.text.includes("<collaboration_mode>")));
  assert.equal(requests[0].input[1].role, "user");
  assert.match(requests[0].input[1].content[0].text, /^# AGENTS\.md instructions for \/repo/);
  assert.match(requests[0].input[1].content[1].text, /^<environment_context>/);
  assert.doesNotMatch(requests[0].input[1].content[1].text, /<workspace>/);
  assert.equal(requests[0].input[2].role, "user");
  assert.equal(requests[0].input[2].content[0].text, "Who are you?");
});

test("later turns reuse hidden history without reinjecting full unchanged context", async () => {
  const { engine, requests } = createEngine({
    modelTexts: ["First reply.", "Second reply."],
    defaultModel: "gpt-5.3-codex",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 18,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
      userInstructions: "Always prefer minimal patches.",
    },
  }, connection);

  await engine.handleRpc({
    id: 19,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "First question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  await engine.handleRpc({
    id: 20,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Second question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.length, 5);
  assert.equal(requests[1].input[3].role, "assistant");
  assert.equal(requests[1].input[3].content[0].text, "First reply.");
  assert.equal(requests[1].input[4].role, "user");
  assert.equal(requests[1].input[4].content[0].text, "Second question");
});

test("model changes inject a model_switch developer update on the next turn", async () => {
  const { engine, requests } = createEngine({
    modelTexts: ["First reply.", "Second reply."],
    defaultModel: "gpt-5.3-codex",
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 21,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  await engine.handleRpc({
    id: 22,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "First question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  await engine.handleRpc({
    id: 23,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      model: "gpt-5.1",
      input: [
        {
          type: "text",
          text: "Second question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const latestDeveloperMessage = [...requests[1].input].reverse().find((item) => item.role === "developer");
  assert.ok(latestDeveloperMessage);
  assert.ok(latestDeveloperMessage.content.some((part) => part.text.includes("<model_switch>")));
});

test("a thread can run multiple completed turns sequentially", async () => {
  const { engine } = createEngine({
    modelTexts: ["First reply.", "Second reply."],
  });
  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 20,
    method: "thread/start",
    params: {
      model: "gpt-5.1",
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  const threadId = threadStart.result.thread.id;

  await engine.handleRpc({
    id: 21,
    method: "turn/start",
    params: {
      threadId,
      input: [
        {
          type: "text",
          text: "First question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  await engine.handleRpc({
    id: 22,
    method: "turn/start",
    params: {
      threadId,
      input: [
        {
          type: "text",
          text: "Second question",
          text_elements: [],
        },
      ],
    },
  }, connection);
  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 23,
    method: "thread/resume",
    params: {
      threadId,
      persistExtendedHistory: true,
    },
  }, connection);

  assert.equal(resumed.result.thread.turns.length, 2);
  assert.equal(resumed.result.thread.turns[0].status, "completed");
  assert.equal(resumed.result.thread.turns[1].status, "completed");
  assert.equal(resumed.result.thread.turns[0].items[1].text, "First reply.");
  assert.equal(resumed.result.thread.turns[1].items[1].text, "Second reply.");
});

test("dynamic tool calls pause the turn and resume after a client response", async () => {
  const toolCycleOne = [
    {
      type: "output_item.done",
      responseId: "resp_tool_1",
      item: {
        type: "function_call",
        call_id: "call_lookup_1",
        name: "lookup_ticket",
        arguments: JSON.stringify({ id: "ABC-123" }),
      },
    },
    {
      type: "completed",
      responseId: "resp_tool_1",
      response: null,
    },
  ];
  const toolCycleTwo = [
    {
      type: "output_text.delta",
      responseId: "resp_tool_2",
      delta: "Ticket ABC-123 is open.",
    },
    {
      type: "completed",
      responseId: "resp_tool_2",
      response: null,
    },
  ];

  const { engine, notifications, requests } = createEngine({
    modelTexts: [toolCycleOne, toolCycleTwo],
  });
  const connection = createReadyConnection({ experimentalApi: true });

  const threadStart = await engine.handleRpc({
    id: 30,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
      dynamicTools: [
        {
          name: "lookup_ticket",
          description: "Fetch a ticket from the tracker.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      ],
    },
  }, connection);

  const turnStart = await engine.handleRpc({
    id: 31,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Check ticket ABC-123.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  await engine.waitForIdle();

  const requestEnvelope = notifications.find((entry) => entry.method === "item/tool/call");
  assert.ok(requestEnvelope);
  assert.equal(requestEnvelope.params.tool, "lookup_ticket");
  assert.deepEqual(requestEnvelope.params.arguments, { id: "ABC-123" });

  await engine.handleRpc({
    id: requestEnvelope.id,
    result: {
      contentItems: [
        {
          type: "inputText",
          text: "Ticket ABC-123 is open.",
        },
      ],
      success: true,
    },
  }, connection);

  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 32,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);

  assert.equal(turnStart.result.turn.id, "turn_2");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previousResponseId, "resp_tool_1");
  assert.deepEqual(requests[1].input, [
    {
      type: "function_call_output",
      call_id: "call_lookup_1",
      output: "Ticket ABC-123 is open.",
    },
  ]);
  assert.equal(resumed.result.thread.turns[0].status, "completed");
  assert.equal(resumed.result.thread.turns[0].items[1].text, "Ticket ABC-123 is open.");

  const dynamicToolItem = resumed.result.thread.turns[0].items.find((item) => item.type === "dynamicToolCall");
  assert.ok(dynamicToolItem);
  assert.equal(dynamicToolItem.status, "completed");
  assert.equal(dynamicToolItem.success, true);
});

test("turn/interrupt clears pending external requests and marks the turn interrupted", async () => {
  const { engine, notifications } = createEngine({
    modelTexts: [[
      {
        type: "output_item.done",
        responseId: "resp_tool_interrupt",
        item: {
          type: "function_call",
          call_id: "call_lookup_2",
          name: "lookup_ticket",
          arguments: JSON.stringify({ id: "XYZ-999" }),
        },
      },
      {
        type: "completed",
        responseId: "resp_tool_interrupt",
        response: null,
      },
    ]],
  });
  const connection = createReadyConnection({ experimentalApi: true });

  const threadStart = await engine.handleRpc({
    id: 40,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
      dynamicTools: [
        {
          name: "lookup_ticket",
          description: "Fetch a ticket from the tracker.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
          },
        },
      ],
    },
  }, connection);

  const turnStart = await engine.handleRpc({
    id: 41,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Check ticket XYZ-999.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  await engine.waitForIdle();

  await engine.handleRpc({
    id: 42,
    method: "turn/interrupt",
    params: {
      threadId: threadStart.result.thread.id,
      turnId: turnStart.result.turn.id,
    },
  }, connection);

  await engine.waitForIdle();

  const resumed = await engine.handleRpc({
    id: 43,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);

  assert.equal(resumed.result.thread.turns[0].status, "interrupted");
  const resolvedNotifications = notifications.filter((entry) => entry.method === "serverRequest/resolved");
  assert.equal(resolvedNotifications.length, 1);
});

test("turn/steer queues extra user input for a follow-up model cycle", async () => {
  const firstCycleRelease = deferred();
  const requests = [];
  const modelClient = {
    async *streamResponse(args) {
      requests.push(args);

      if (requests.length === 1) {
        yield {
          type: "output_text.delta",
          responseId: "resp_steer_1",
          delta: "Working on it.",
        };
        await firstCycleRelease.promise;
        yield {
          type: "completed",
          responseId: "resp_steer_1",
          response: null,
        };
        return;
      }

      yield {
        type: "output_text.delta",
        responseId: "resp_steer_2",
        delta: " Updated with the extra detail.",
      };
      yield {
        type: "completed",
        responseId: "resp_steer_2",
        response: null,
      };
    },
  };

  let persistedState = null;
  const notifications = [];
  const engine = new AppServerSessionEngine({
    loadState: async () => persistedState,
    saveState: async (nextState) => {
      persistedState = structuredClone(nextState);
    },
    modelClient,
    notify: (envelope) => {
      notifications.push(envelope);
    },
    defaultModel: "gpt-5.3-codex",
    now: () => 1_710_000_000_000,
    createId: createIdFactory(),
  });

  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 50,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  const turnStart = await engine.handleRpc({
    id: 51,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Start the answer.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  await Promise.resolve();

  const steerResponse = await engine.handleRpc({
    id: 52,
    method: "turn/steer",
    params: {
      threadId: threadStart.result.thread.id,
      turnId: turnStart.result.turn.id,
      input: [
        {
          type: "text",
          text: "Add one more detail.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  assert.equal(steerResponse.result.turnId, turnStart.result.turn.id);

  firstCycleRelease.resolve();
  await engine.waitForIdle();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].previousResponseId, "resp_steer_1");
  assert.deepEqual(requests[1].input, [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Add one more detail.",
        },
      ],
    },
  ]);

  const resumed = await engine.handleRpc({
    id: 53,
    method: "thread/resume",
    params: {
      threadId: threadStart.result.thread.id,
      persistExtendedHistory: true,
    },
  }, connection);

  assert.equal(resumed.result.thread.turns[0].status, "completed");
  assert.equal(resumed.result.thread.turns[0].items[1].text, "Working on it. Updated with the extra detail.");
  assert.ok(notifications.some((entry) => entry.method === "item/agentMessage/delta"));
});

test("blocked pending input records developer context and requeues the older tail ahead of newer input", async () => {
  const firstCycleRelease = deferred();
  const requests = [];
  const modelClient = {
    async *streamResponse(args) {
      requests.push(args);

      if (requests.length === 1) {
        yield {
          type: "output_text.delta",
          responseId: "resp_block_1",
          delta: "Working on it.",
        };
        await firstCycleRelease.promise;
        yield {
          type: "completed",
          responseId: "resp_block_1",
          response: null,
        };
        return;
      }

      yield {
        type: "output_text.delta",
        responseId: "resp_block_2",
        delta: " Continuing with the allowed detail.",
      };
      yield {
        type: "completed",
        responseId: "resp_block_2",
        response: null,
      };
    },
  };

  let persistedState = null;
  const engine = new AppServerSessionEngine({
    loadState: async () => persistedState,
    saveState: async (nextState) => {
      persistedState = structuredClone(nextState);
    },
    modelClient,
    notify: () => {},
    defaultModel: "gpt-5.3-codex",
    now: () => 1_710_000_000_000,
    createId: createIdFactory(),
  });

  engine.inspectPendingInputRecord = (_thread, _turn, entry) => {
    const contentText = JSON.stringify(entry.inputItem);
    if (contentText.includes("blocked queued prompt")) {
      return {
        disposition: "blocked",
        entry,
        additionalContexts: ["Pending input was blocked by a hook."],
      };
    }

    return {
      disposition: "accepted",
      entry,
      additionalContexts: [],
    };
  };

  const connection = createReadyConnection();

  const threadStart = await engine.handleRpc({
    id: 60,
    method: "thread/start",
    params: {
      cwd: "/repo",
      approvalPolicy: "never",
    },
  }, connection);

  const turnStart = await engine.handleRpc({
    id: 61,
    method: "turn/start",
    params: {
      threadId: threadStart.result.thread.id,
      input: [
        {
          type: "text",
          text: "Start the answer.",
          text_elements: [],
        },
      ],
    },
  }, connection);

  await Promise.resolve();

  await engine.handleRpc({
    id: 62,
    method: "turn/steer",
    params: {
      threadId: threadStart.result.thread.id,
      turnId: turnStart.result.turn.id,
      input: [
        {
          type: "text",
          text: "blocked queued prompt",
          text_elements: [],
        },
      ],
    },
  }, connection);

  await engine.handleRpc({
    id: 63,
    method: "turn/steer",
    params: {
      threadId: threadStart.result.thread.id,
      turnId: turnStart.result.turn.id,
      input: [
        {
          type: "text",
          text: "later queued prompt",
          text_elements: [],
        },
      ],
    },
  }, connection);

  firstCycleRelease.resolve();
  await engine.waitForIdle();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].previousResponseId, "resp_block_1");
  assert.equal(requests[1].input[0].role, "developer");
  assert.equal(requests[1].input[0].content[0].text, "Pending input was blocked by a hook.");
  assert.equal(requests[1].input[1].role, "user");
  assert.equal(requests[1].input[1].content[0].text, "later queued prompt");
});
