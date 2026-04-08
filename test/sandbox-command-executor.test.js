import test from "node:test";
import assert from "node:assert/strict";

import { createSandboxCommandExecutor } from "../src/lib/sandbox-command-executor.js";

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

function createFakeSession(id) {
  const files = new Map();

  function listFileEntries(root) {
    return [...files.keys()]
      .filter((path) => path.startsWith(root === "/" ? "/" : `${root}/`) || path === root)
      .sort((left, right) => left.localeCompare(right))
      .map((path) => ({
        name: path.split("/").at(-1),
        absolutePath: path,
        relativePath: path,
        type: "file",
        size: typeof files.get(path) === "string"
          ? Buffer.byteLength(files.get(path), "utf8")
          : cloneBytes(files.get(path))?.byteLength ?? 0,
        modifiedAt: new Date().toISOString(),
        mode: "0644",
        permissions: {
          readable: true,
          writable: true,
          executable: false,
        },
      }));
  }

  return {
    id,
    async mkdir() {},
    async writeFile(path, content) {
      files.set(path, typeof content === "string" ? content : (cloneBytes(content) ?? content));
      return { success: true, path };
    },
    async readFile(path) {
      const value = files.get(path);
      if (typeof value === "string") {
        return {
          success: true,
          path,
          content: value,
        };
      }
      return {
        success: true,
        path,
        content: cloneBytes(value) ?? new Uint8Array(),
      };
    },
    async deleteFile(path) {
      files.delete(path);
      return { success: true, path };
    },
    async listFiles(root) {
      return {
        success: true,
        path: root,
        files: listFileEntries(root),
        count: listFileEntries(root).length,
      };
    },
    async exec(command) {
      assert.equal(command, "sh -lc 'printf \"hello from sandbox\\n\" > /workspace/sandbox.txt && cat /workspace/sandbox.txt'");
      assert.equal(files.get("/workspace/dynamic.txt"), "hello from dynamic\n");
      files.set("/workspace/sandbox.txt", "hello from sandbox\n");
      return {
        stdout: "hello from sandbox\n",
        stderr: "",
        exitCode: 0,
      };
    },
  };
}

test("sandbox command executor runs non-tty execs inside a session-backed materialized workspace", async () => {
  const sessions = [];
  const deletedSessionIds = [];
  const executor = createSandboxCommandExecutor({
    getWorkspaceSandbox: async () => ({
      async createSession() {
        const session = createFakeSession(`sess_${sessions.length + 1}`);
        sessions.push(session);
        return session;
      },
      async deleteSession(sessionId) {
        deletedSessionIds.push(sessionId);
      },
    }),
  });

  const result = await executor.executeCommand({
    workspaceId: "shared-workspace",
    workspaceRoot: "/workspace",
    workspaceRevision: 1,
    hydratedRevision: null,
    cwd: "/workspace",
    command: "sh -lc 'printf \"hello from sandbox\\n\" > /workspace/sandbox.txt && cat /workspace/sandbox.txt'",
    files: [
      {
        path: "/workspace/dynamic.txt",
        content: "hello from dynamic\n",
      },
    ],
  });

  assert.equal(sessions.length, 1);
  assert.deepEqual(deletedSessionIds, ["sess_1"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello from sandbox\n");
  assert.deepEqual(result.changedFiles, [
    {
      path: "/workspace/sandbox.txt",
      content: "hello from sandbox\n",
      contentBase64: null,
      contentEncoding: "utf8",
      contentType: null,
    },
  ]);
  assert.deepEqual(result.removedPaths, []);
});

test("sandbox command executor preserves binary files when materializing and syncing workspace changes", async () => {
  const sessions = [];
  const executor = createSandboxCommandExecutor({
    getWorkspaceSandbox: async () => ({
      async createSession() {
        const session = createFakeSession(`sess_${sessions.length + 1}`);
        session.exec = async (command) => {
          assert.equal(command, "python3 -c \"open('/workspace/out.bin','wb').write(bytes([0, 1, 2, 255]))\"");
          assert.equal((await session.readFile("/workspace/input.txt")).content, "seed\n");
          await session.writeFile("/workspace/out.bin", Uint8Array.from([0, 1, 2, 255]));
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        };
        sessions.push(session);
        return session;
      },
      async deleteSession() {},
    }),
  });

  const result = await executor.executeCommand({
    workspaceId: "shared-workspace",
    workspaceRoot: "/workspace",
    cwd: "/workspace",
    command: "python3 -c \"open('/workspace/out.bin','wb').write(bytes([0, 1, 2, 255]))\"",
    files: [
      {
        path: "/workspace/input.txt",
        content: "seed\n",
        contentEncoding: "utf8",
      },
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.changedFiles, [
    {
      path: "/workspace/out.bin",
      content: null,
      contentBase64: "AAEC/w==",
      contentEncoding: "base64",
      contentType: null,
    },
  ]);
});
