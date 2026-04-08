import test from "node:test";
import assert from "node:assert/strict";

import { applyPatchToWorkspace } from "../src/lib/apply-patch.js";
import { createWorkspaceStore } from "../src/lib/vfs-store.js";

function createThread() {
  return {
    id: "thr_patch",
    workspaceId: "patch-workspace",
    cwd: "/workspace",
    workspace: null,
  };
}

test("applyPatchToWorkspace adds a new file", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: "*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch\n",
  });

  const read = await workspaceStore.readFile(thread, "/workspace/notes.txt");

  assert.equal(result.changes[0].kind.type, "add");
  assert.equal(
    result.outputText,
    "Success. Updated the following files:\nA notes.txt\n",
  );
  assert.equal(read.file.content, "hello\n");
});

test("applyPatchToWorkspace accepts absolute workspace paths", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: "*** Begin Patch\n*** Add File: /workspace/absolute.txt\n+hello from absolute path\n*** End Patch\n",
  });

  const read = await workspaceStore.readFile(thread, "/workspace/absolute.txt");

  assert.equal(result.changes[0].path, "absolute.txt");
  assert.equal(read.file.content, "hello from absolute path\n");
});

test("applyPatchToWorkspace extracts a valid patch from surrounding prose", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: [
      "I'll create the file now.",
      "```patch",
      "*** Begin Patch",
      "*** Add File: wrapped.txt",
      "+wrapped patch body",
      "*** End Patch",
      "```",
    ].join("\n"),
  });

  const read = await workspaceStore.readFile(thread, "/workspace/wrapped.txt");

  assert.equal(result.changes[0].path, "wrapped.txt");
  assert.equal(read.file.content, "wrapped patch body\n");
});

test("applyPatchToWorkspace accepts a unified diff inside the patch envelope", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: [
      "*** Begin Patch",
      "--- /dev/null",
      "+++ /workspace/unified.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+from unified diff",
      "*** End Patch",
      "",
    ].join("\n"),
  });

  const read = await workspaceStore.readFile(thread, "/workspace/unified.txt");

  assert.equal(result.changes[0].path, "unified.txt");
  assert.equal(read.file.content, "hello\nfrom unified diff\n");
});

test("applyPatchToWorkspace accepts a pure insertion unified diff without + prefixes", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: [
      "*** Begin Patch",
      "--- /workspace/raw-unified.txt",
      "+++ /workspace/raw-unified.txt",
      "@@ -0,0 +1,2 @@",
      "hello",
      "without explicit plus prefixes",
      "*** End Patch",
      "",
    ].join("\n"),
  });

  const read = await workspaceStore.readFile(thread, "/workspace/raw-unified.txt");

  assert.equal(result.changes[0].path, "raw-unified.txt");
  assert.equal(read.file.content, "hello\nwithout explicit plus prefixes\n");
});

test("applyPatchToWorkspace updates and renames an existing file", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  await workspaceStore.writeFile(thread, "/workspace/src/app.js", "export const value = 1;\n");

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: [
      "*** Begin Patch",
      "*** Update File: src/app.js",
      "*** Move to: src/main.js",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
      "",
    ].join("\n"),
  });

  const read = await workspaceStore.readFile(thread, "/workspace/src/main.js");

  await assert.rejects(
    () => workspaceStore.readFile(thread, "/workspace/src/app.js"),
    /was not found/,
  );
  assert.equal(result.changes[0].kind.type, "update");
  assert.equal(result.changes[0].kind.move_path, "src/main.js");
  assert.equal(read.file.content, "export const value = 2;\n");
});

test("applyPatchToWorkspace deletes an existing file", async () => {
  const workspaceStore = createWorkspaceStore();
  const thread = createThread();

  await workspaceStore.writeFile(thread, "/workspace/delete-me.txt", "bye\n");

  const result = await applyPatchToWorkspace({
    thread,
    workspaceStore,
    patchText: "*** Begin Patch\n*** Delete File: delete-me.txt\n*** End Patch\n",
  });

  await assert.rejects(
    () => workspaceStore.readFile(thread, "/workspace/delete-me.txt"),
    /was not found/,
  );
  assert.equal(result.changes[0].kind.type, "delete");
});
