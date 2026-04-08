import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceKernelClient } from "../src/lib/workspace-kernel-client.js";

test("workspace kernel client forwards workspace and command requests to the kernel binding", async () => {
  const calls = [];
  const binding = {
    idFromName(name) {
      calls.push({ type: "id", name });
      return `stub:${name}`;
    },
    get(id) {
      return {
        async fetch(request) {
          const body = JSON.parse(await request.text());
          const pathname = new URL(request.url).pathname;
          calls.push({ type: "fetch", id, pathname, body });
          if (pathname === "/workspace/read") {
            return Response.json({
              workspace: {
                id: body.thread.workspaceId,
                root: "/workspace",
              },
            });
          }
          if (pathname === "/command/execute") {
            return Response.json({
              driver: "workerBuiltin",
              exitCode: 0,
              stdout: "/workspace\n",
              stderr: "",
              outputText: "stdout:\n/workspace\n",
            });
          }
          return Response.json({});
        },
      };
    },
  };

  const client = createWorkspaceKernelClient({
    binding,
  });
  const thread = {
    id: "thr_client",
    workspaceId: "shared-workspace",
    cwd: "/workspace",
    workspace: {
      id: "shared-workspace",
      root: "/workspace",
    },
  };

  const workspace = await client.workspaceStore.readWorkspace(thread);
  const command = await client.sandboxBroker.executeCommand(thread, {
    command: "pwd",
    cwd: "/workspace",
  });

  assert.equal(workspace.id, "shared-workspace");
  assert.equal(command.driver, "workerBuiltin");
  assert.equal(command.exitCode, 0);
  assert.deepEqual(calls.map((entry) => entry.type), ["id", "fetch", "id", "fetch"]);
  assert.equal(calls[1].pathname, "/workspace/read");
  assert.equal(calls[3].pathname, "/command/execute");
  assert.equal(calls[3].body.command, "pwd");
});
