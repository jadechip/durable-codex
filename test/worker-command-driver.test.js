import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceRecord, createWorkspaceStore } from "../src/lib/vfs-store.js";
import { createWorkerCommandDriver } from "../src/lib/worker-command-driver.js";

function createThread() {
  return {
    id: "thr_worker_driver",
    cwd: "/workspace",
    workspaceId: "driver-workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "driver-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };
}

test("worker command driver resolves supported simple commands", async () => {
  const driver = createWorkerCommandDriver({
    workspaceStore: createWorkspaceStore(),
  });

  const rgRoute = driver.resolve({
    command: "rg -n hello src",
    cwd: "/workspace",
    tty: false,
  });
  const shellRoute = driver.resolve({
    command: "sh -lc 'rg hello src'",
    cwd: "/workspace",
    tty: false,
  });

  assert.equal(rgRoute.executable, "rg");
  assert.equal(shellRoute, null);
});

test("worker command driver executes VFS-backed ls and rg without a sandbox", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();
  await workspaceStore.writeFile(thread, "/workspace/src/app.js", "console.log('hello');\n");
  await workspaceStore.writeFile(thread, "/workspace/src/lib/util.js", "export const hello = true;\n");
  const driver = createWorkerCommandDriver({
    workspaceStore,
    now: (() => {
      let value = 0;
      return () => {
        value += 5;
        return value;
      };
    })(),
  });

  const lsRoute = driver.resolve({
    command: "ls -R /workspace/src",
    cwd: "/workspace",
    tty: false,
  });
  const lsResult = await driver.execute(thread, {
    command: "ls -R /workspace/src",
    cwd: "/workspace",
    route: lsRoute,
    maxOutputTokens: 4000,
  });

  const rgRoute = driver.resolve({
    command: "rg -n hello /workspace/src",
    cwd: "/workspace",
    tty: false,
  });
  const rgResult = await driver.execute(thread, {
    command: "rg -n hello /workspace/src",
    cwd: "/workspace",
    route: rgRoute,
    maxOutputTokens: 4000,
  });

  assert.equal(lsResult.driver, "workerBuiltin");
  assert.equal(lsResult.exitCode, 0);
  assert.match(lsResult.stdout, /\/workspace\/src:/);
  assert.match(lsResult.stdout, /app\.js/);
  assert.match(lsResult.stdout, /lib/);
  assert.equal(rgResult.driver, "workerBuiltin");
  assert.equal(rgResult.exitCode, 0);
  assert.match(rgResult.stdout, /\/workspace\/src\/app\.js:1:console\.log\('hello'\);/);
  assert.match(rgResult.stdout, /\/workspace\/src\/lib\/util\.js:1:export const hello = true;/);
});
