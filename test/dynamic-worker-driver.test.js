import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { createDynamicWorkerDriver } from "../src/lib/dynamic-worker-driver.js";
import { createWorkspaceRecord, createWorkspaceStore } from "../src/lib/vfs-store.js";

function createThread() {
  return {
    id: "thr_dynamic_driver",
    cwd: "/workspace",
    workspaceId: "dynamic-driver-workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "dynamic-driver-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };
}

function createLoader(handler) {
  return {
    load(definition) {
      return {
        getEntrypoint() {
          return {
            fetch(request) {
              return handler(definition, request);
            },
          };
        },
      };
    },
  };
}

test("dynamic worker driver resolves node eval commands with semicolons inside quoted code", async () => {
  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => Response.json({ stdout: "", stderr: "", exitCode: 0 })),
    workspaceStore: createWorkspaceStore(),
  });

  const route = driver.resolve({
    command: "node -e \"console.log('hi'); console.log('there')\"",
    cwd: "/workspace",
    tty: false,
  });

  assert.equal(route.executable, "node");
  assert.equal(route.mode, "eval");
  assert.match(route.code, /console\.log\('hi'\);/);
});

test("dynamic worker driver resolves python eval commands", async () => {
  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => Response.json({ stdout: "", stderr: "", exitCode: 0 })),
    workspaceStore: createWorkspaceStore(),
  });

  const route = driver.resolve({
    command: "python3 -c \"print('hello from python')\"",
    cwd: "/workspace",
    tty: false,
  });

  assert.equal(route.executable, "python3");
  assert.equal(route.mode, "eval");
  assert.equal(route.runtime, "python");
  assert.match(route.code, /hello from python/);
});

test("dynamic worker driver resolves python script commands", async () => {
  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => Response.json({ stdout: "", stderr: "", exitCode: 0 })),
    workspaceStore: createWorkspaceStore(),
  });

  const route = driver.resolve({
    command: "python app.py --flag value",
    cwd: "/workspace",
    tty: false,
  });

  assert.equal(route.executable, "python");
  assert.equal(route.mode, "file");
  assert.equal(route.runtime, "python");
  assert.equal(route.entryPath, "app.py");
  assert.deepEqual(route.args, ["--flag", "value"]);
});

test("dynamic worker driver preserves literal backslashes inside double-quoted node eval code", async () => {
  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => Response.json({ stdout: "", stderr: "", exitCode: 0 })),
    workspaceStore: createWorkspaceStore(),
  });

  const route = driver.resolve({
    command: "node -e \"require('fs').writeFileSync('/workspace/out.txt', 'line\\\\n')\"",
    cwd: "/workspace",
    tty: false,
  });

  assert.equal(route.executable, "node");
  assert.equal(route.mode, "eval");
  assert.match(route.code, /line\\n/);
});

test("dynamic worker driver passes workspace snapshots into the loader and surfaces file changes", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  await workspaceStore.writeFile(thread, "/workspace/input.txt", "seed\n");

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async (definition) => {
      const payload = definition.env.PAYLOAD;
      assert.equal(payload.cwd, "/workspace");
      assert.equal(payload.files["/workspace/input.txt"], "seed\n");
      return Response.json({
        stdout: "dynamic stdout\n",
        stderr: "",
        exitCode: 0,
        changedFiles: [
          {
            path: "/workspace/output.txt",
            content: `copied:${payload.files["/workspace/input.txt"]}`,
          },
        ],
        removedPaths: [],
      });
    }),
    workspaceStore,
    now: (() => {
      let value = 0;
      return () => {
        value += 9;
        return value;
      };
    })(),
  });

  const route = driver.resolve({
    command: "node -e \"console.log('dynamic');\"",
    cwd: "/workspace",
    tty: false,
  });
  const result = await driver.execute(thread, {
    command: "node -e \"console.log('dynamic');\"",
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  assert.equal(result.driver, "dynamicWorker");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /dynamic stdout/);
  assert.deepEqual(result.changedFiles, [
    {
      path: "/workspace/output.txt",
      content: "copied:seed\n",
    },
  ]);
});

test("dynamic worker driver passes python load definitions and file execution context into the loader", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  await workspaceStore.writeFile(thread, "/workspace/script.py", "print('hello from script')\n");

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async (definition) => {
      assert.equal(definition.mainModule, "index.py");
      assert.equal(definition.compatibilityFlags[0], "python_workers");
      assert.equal(typeof definition.modules["index.py"]?.py, "string");
      const payload = definition.env.PAYLOAD;
      assert.equal(payload.runtime, "python");
      assert.equal(payload.entryPath, "/workspace/script.py");
      assert.equal(payload.cwd, "/workspace");
      return Response.json({
        stdout: "hello from python\n",
        stderr: "",
        exitCode: 0,
        changedFiles: [
          {
            path: "/workspace/python.txt",
            content: "hello from python\n",
          },
        ],
        removedPaths: [],
      });
    }),
    workspaceStore,
  });

  const route = driver.resolve({
    command: "python /workspace/script.py",
    cwd: "/workspace",
    tty: false,
  });
  const result = await driver.execute(thread, {
    command: "python /workspace/script.py",
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  assert.equal(result.driver, "dynamicWorker");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello from python/);
  assert.deepEqual(result.changedFiles, [
    {
      path: "/workspace/python.txt",
      content: "hello from python\n",
    },
  ]);
});

test("generated python dynamic worker runtime handles pathlib writes against the shared workspace", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  let capturedDefinition = null;

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async (definition) => {
      capturedDefinition = definition;
      return Response.json({
        stdout: "",
        stderr: "",
        exitCode: 0,
        changedFiles: [],
        removedPaths: [],
      });
    }),
    workspaceStore,
  });

  const route = driver.resolve({
    command: "python3 -c \"from pathlib import Path; print('python ok'); Path('/workspace/out.txt').write_text('hello from python\\n')\"",
    cwd: "/workspace",
    tty: false,
  });
  await driver.execute(thread, {
    command: "python3 -c \"from pathlib import Path; print('python ok'); Path('/workspace/out.txt').write_text('hello from python\\n')\"",
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  assert.ok(capturedDefinition);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dynamic-python-runtime-"));
  await writeFile(path.join(tempDir, "workers.py"), `
class WorkerEntrypoint:
    pass

class Response:
    def __init__(self, body="", headers=None, status=200):
        self.body = body
        self.headers = headers or {}
        self.status = status
`);
  await writeFile(
    path.join(tempDir, "runner.py"),
    `${capturedDefinition.modules["index.py"].py}

import asyncio
import sys

async def __run():
    response = await Default().fetch(None)
    sys.__stdout__.write(response.body)

asyncio.run(__run())
`,
  );

  const result = spawnSync("python3", ["runner.py"], {
    cwd: tempDir,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.stdout, "python ok\n");
  assert.deepEqual(payload.changedFiles, [
    {
      path: "/workspace/out.txt",
      content: "hello from python\n",
      contentBase64: null,
      contentEncoding: "utf8",
      contentType: null,
    },
  ]);
});

test("dynamic worker driver preflights python subprocess usage and requests sandbox fallback", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  let loadCount = 0;

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => {
      loadCount += 1;
      return Response.json({ stdout: "", stderr: "", exitCode: 0 });
    }),
    workspaceStore,
  });

  const command = "python3 -c \"import subprocess; subprocess.run(['echo', 'hi'])\"";
  const route = driver.resolve({
    command,
    cwd: "/workspace",
    tty: false,
  });
  const result = await driver.execute(thread, {
    command,
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  assert.equal(loadCount, 0);
  assert.equal(result.fallbackSuggested, true);
  assert.equal(result.fallbackReason, "python-sandbox-only-module");
  assert.match(result.stderr, /sandbox-only module/i);
});

test("dynamic worker driver requests sandbox fallback when python needs an unavailable module", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async () => Response.json({
      stdout: "",
      stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'numpy'\n",
      exitCode: 1,
      changedFiles: [],
      removedPaths: [],
    })),
    workspaceStore,
  });

  const command = "python3 -c \"import numpy; print('ok')\"";
  const route = driver.resolve({
    command,
    cwd: "/workspace",
    tty: false,
  });
  const result = await driver.execute(thread, {
    command,
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  assert.equal(result.fallbackSuggested, true);
  assert.equal(result.fallbackReason, "python-missing-module");
  assert.match(result.fallbackMessage, /numpy/);
});

test("generated python dynamic worker runtime preserves binary writes against the shared workspace", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  let capturedDefinition = null;

  const driver = createDynamicWorkerDriver({
    loader: createLoader(async (definition) => {
      capturedDefinition = definition;
      return Response.json({
        stdout: "",
        stderr: "",
        exitCode: 0,
        changedFiles: [],
        removedPaths: [],
      });
    }),
    workspaceStore,
  });

  const command = "python3 -c \"from pathlib import Path; Path('/workspace/out.bin').write_bytes(bytes([0, 1, 2, 255]))\"";
  const route = driver.resolve({
    command,
    cwd: "/workspace",
    tty: false,
  });
  await driver.execute(thread, {
    command,
    cwd: "/workspace",
    route,
    maxOutputTokens: 4000,
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dynamic-python-binary-runtime-"));
  await writeFile(path.join(tempDir, "workers.py"), `
class WorkerEntrypoint:
    pass

class Response:
    def __init__(self, body="", headers=None, status=200):
        self.body = body
        self.headers = headers or {}
        self.status = status
`);
  await writeFile(
    path.join(tempDir, "runner.py"),
    `${capturedDefinition.modules["index.py"].py}

import asyncio
import sys

async def __run():
    response = await Default().fetch(None)
    sys.__stdout__.write(response.body)

asyncio.run(__run())
`,
  );

  const result = spawnSync("python3", ["runner.py"], {
    cwd: tempDir,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 0);
  assert.deepEqual(payload.changedFiles, [
    {
      path: "/workspace/out.bin",
      content: null,
      contentBase64: "AAEC/w==",
      contentEncoding: "base64",
      contentType: null,
    },
  ]);
});
