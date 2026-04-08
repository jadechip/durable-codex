import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceRecord, createWorkspaceStore } from "../src/lib/vfs-store.js";

function createThread() {
  return {
    id: "thr_vfs_store",
    cwd: "/workspace",
    workspaceId: "vfs-binary-workspace",
    workspace: createWorkspaceRecord({
      workspaceId: "vfs-binary-workspace",
      cwd: "/workspace",
      nowMs: 1_710_000_000_000,
    }),
  };
}

test("workspace store preserves binary content across write, read, export, and apply", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  await workspaceStore.writeFile(
    thread,
    "/workspace/image.bin",
    "",
    "application/octet-stream",
    {
      contentBase64: "AAEC/w==",
      contentEncoding: "base64",
    },
  );

  const read = await workspaceStore.readFile(thread, "/workspace/image.bin");
  assert.equal(read.file.content, null);
  assert.equal(read.file.contentBase64, "AAEC/w==");
  assert.equal(read.file.contentEncoding, "base64");

  const snapshot = await workspaceStore.exportWorkspaceSnapshot(thread);
  assert.deepEqual(snapshot.files, [
    {
      path: "/workspace/image.bin",
      relativePath: "image.bin",
      content: null,
      contentBase64: "AAEC/w==",
      contentEncoding: "base64",
      isBinary: true,
      contentType: "application/octet-stream",
      size: 4,
      sha256: read.file.sha256,
      updatedAt: read.file.updatedAt,
    },
  ]);

  await workspaceStore.applyWorkspaceFiles(thread, [
    {
      path: "/workspace/image.bin",
      content: null,
      contentBase64: "//79/A==",
      contentEncoding: "base64",
      contentType: "application/octet-stream",
    },
  ]);

  const updated = await workspaceStore.readFile(thread, "/workspace/image.bin");
  assert.equal(updated.file.contentBase64, "//79/A==");
  assert.equal(updated.file.contentEncoding, "base64");
});
