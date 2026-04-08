import test from "node:test";
import assert from "node:assert/strict";

import { createDynamicWorkerDriver } from "../src/lib/dynamic-worker-driver.js";
import { createSandboxBroker } from "../src/lib/sandbox-broker.js";
import { createWorkspaceRecord, createWorkspaceStore } from "../src/lib/vfs-store.js";

test("sandbox broker can snapshot and materialize a shared workspace", async () => {
  const workspaceStore = createWorkspaceStore();
  const broker = createSandboxBroker({
    workspaceStore,
    now: () => 1_710_000_000_000,
  });
  const thread = {
    id: "thr_test",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };

  await workspaceStore.writeFile(thread, "/workspace/src/app.js", "export const ok = true;\n");
  await workspaceStore.writeFile(thread, "/workspace/README.md", "# hello\n");

  const snapshot = await broker.prepareWorkspaceSnapshot(thread);
  assert.equal(snapshot.workspace.id, "shared-workspace");
  assert.equal(snapshot.workspace.revision, 2);
  assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.files[0].path, "/workspace/README.md");

  const materialized = await broker.materializeWorkspace(thread, "sbx_test");
  assert.equal(materialized.workspace.attachedSandboxId, "sbx_test");
  assert.equal(materialized.workspace.hydratedRevision, null);
  assert.equal(thread.workspace.attachedSandboxId, "sbx_test");
});

test("sandbox broker routes supported simple commands through the worker driver", async () => {
  const workspaceStore = createWorkspaceStore();
  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand() {
        throw new Error("sandbox executor should not be used for pwd");
      },
    },
  });
  const thread = {
    id: "thr_pwd",
    workspaceId: "shared-workspace",
    cwd: "/workspace/src",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };

  const result = await broker.executeCommand(thread, {
    command: "pwd",
    cwd: "/workspace/src",
  });

  assert.equal(result.driver, "workerBuiltin");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^\/workspace\/src\n$/);
});

test("sandbox broker falls back to the sandbox executor for unsupported commands", async () => {
  const workspaceStore = createWorkspaceStore();
  const executed = [];
  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand(request) {
        executed.push(request);
        return {
          driver: "sandbox",
          outputText: "stdout:\nsandbox ran\n",
          stdout: "sandbox ran\n",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
          removedPaths: [],
          sandboxId: "workspace-shared-workspace",
        };
      },
    },
  });
  const thread = {
    id: "thr_node",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };

  const result = await broker.executeCommand(thread, {
    command: "node -e \"console.log('hello')\"",
    cwd: "/workspace",
  });

  assert.equal(executed.length, 1);
  assert.equal(result.driver, "sandbox");
  assert.equal(result.exitCode, 0);
  assert.match(result.outputText, /sandbox ran/);
});

test("sandbox broker unwraps simple shell wrappers and routes them through the worker driver", async () => {
  const workspaceStore = createWorkspaceStore();
  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand() {
        throw new Error("sandbox executor should not be used for shell-wrapped find");
      },
    },
  });
  const thread = {
    id: "thr_shell_wrapper",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };
  await workspaceStore.writeFile(thread, "/workspace/src/app.js", "console.log('ok');\n");

  const result = await broker.executeCommand(thread, {
    command: "bash -lc 'find /workspace -type f'",
    cwd: "/workspace",
  });

  assert.equal(result.driver, "workerBuiltin");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\/workspace\/src\/app\.js/);
});

test("sandbox broker executes dynamic worker commands and syncs the shared workspace", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = {
    id: "thr_dynamic_broker",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };
  await workspaceStore.writeFile(thread, "/workspace/input.txt", "from snapshot\n");

  const dynamicWorkerDriver = createDynamicWorkerDriver({
    loader: {
      load(definition) {
        return {
          getEntrypoint() {
            return {
              async fetch() {
                const payload = definition.env.PAYLOAD;
                return Response.json({
                  stdout: `ran in ${payload.cwd}\n`,
                  stderr: "",
                  exitCode: 0,
                  changedFiles: [
                    {
                      path: "/workspace/dynamic.txt",
                      content: payload.files["/workspace/input.txt"].toUpperCase(),
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

  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand() {
        throw new Error("sandbox executor should not be used for dynamic worker node eval");
      },
    },
    commandDrivers: [dynamicWorkerDriver],
  });

  const result = await broker.executeCommand(thread, {
    command: "node -e \"console.log('hi');\"",
    cwd: "/workspace",
  });
  const read = await workspaceStore.readFile(thread, "/workspace/dynamic.txt");

  assert.equal(result.driver, "dynamicWorker");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ran in \/workspace/);
  assert.equal(read.file.content, "FROM SNAPSHOT\n");
});

test("sandbox broker invalidates sandbox hydration after direct workspace mutations", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = {
    id: "thr_hydration_regression",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
      workspace: {
        attachedSandboxId: "workspace-shared-workspace",
        hydratedRevision: 0,
      },
    }),
  };

  const dynamicWorkerDriver = createDynamicWorkerDriver({
    loader: {
      load(definition) {
        return {
          getEntrypoint() {
            return {
              async fetch() {
                const payload = definition.env.PAYLOAD;
                return Response.json({
                  stdout: "dynamic ok\n",
                  stderr: "",
                  exitCode: 0,
                  changedFiles: [
                    {
                      path: "/workspace/dynamic.txt",
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

  const executed = [];
  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand(request) {
        executed.push(request);
        return {
          driver: "sandbox",
          stdout: "sandbox ok\n",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
          removedPaths: [],
          sandboxId: "workspace-shared-workspace",
        };
      },
    },
    commandDrivers: [dynamicWorkerDriver],
  });

  const dynamicResult = await broker.executeCommand(thread, {
    command: "node -e \"console.log('hi');\"",
    cwd: "/workspace",
  });

  assert.equal(dynamicResult.driver, "dynamicWorker");
  assert.equal(thread.workspace.hydratedRevision, null);

  await broker.executeCommand(thread, {
    command: "sh -lc 'echo ok'",
    cwd: "/workspace",
  });

  assert.equal(executed.length, 1);
  assert.equal(executed[0].hydratedRevision, null);
  assert.equal(executed[0].files.some((file) => file.path === "/workspace/dynamic.txt"), true);
});

test("sandbox broker reroutes python dynamic worker fallbacks into sandbox execution", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = {
    id: "thr_python_fallback",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "shared-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };

  const dynamicWorkerDriver = createDynamicWorkerDriver({
    loader: {
      load() {
        return {
          getEntrypoint() {
            return {
              async fetch() {
                return Response.json({
                  stdout: "",
                  stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'numpy'\n",
                  exitCode: 1,
                  changedFiles: [],
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

  const executed = [];
  const broker = createSandboxBroker({
    workspaceStore,
    commandExecutor: {
      async executeCommand(request) {
        executed.push(request);
        return {
          driver: "sandbox",
          stdout: "sandbox python ok\n",
          stderr: "",
          exitCode: 0,
          changedFiles: [
            {
              path: "/workspace/python-fallback.txt",
              content: "hello from sandbox python\n",
              contentEncoding: "utf8",
            },
          ],
          removedPaths: [],
          sandboxId: "workspace-shared-workspace",
        };
      },
    },
    commandDrivers: [dynamicWorkerDriver],
  });

  const result = await broker.executeCommand(thread, {
    command: "python3 -c \"import numpy; print('hi')\"",
    cwd: "/workspace",
  });
  const read = await workspaceStore.readFile(thread, "/workspace/python-fallback.txt");

  assert.equal(executed.length, 1);
  assert.equal(executed[0].route.fallbackFrom, "dynamicWorker");
  assert.equal(executed[0].route.fallbackReason, "python-missing-module");
  assert.equal(result.driver, "sandbox");
  assert.equal(result.exitCode, 0);
  assert.equal(read.file.content, "hello from sandbox python\n");
});
