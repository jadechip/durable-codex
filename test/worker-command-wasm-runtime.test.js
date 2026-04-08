import test from "node:test";
import assert from "node:assert/strict";

import { executeWorkerCommandInWasm } from "../src/lib/worker-command-wasm-runtime.js";

test("worker command wasm runtime executes pwd directly in wasm", async () => {
  const result = await executeWorkerCommandInWasm({
    executable: "pwd",
    args: [],
    parsedArgs: { args: [] },
    root: "/workspace",
    cwd: "/workspace/demo",
    files: [],
  });

  assert.equal(result.runtime, "wasm");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "/workspace/demo\n");
  assert.equal(result.stderr, "");
});

test("worker command wasm runtime executes rg over the shared workspace snapshot", async () => {
  const result = await executeWorkerCommandInWasm({
    executable: "rg",
    args: ["-n", "hello", "/workspace/src"],
    parsedArgs: {
      ignoreCase: false,
      fixedStrings: false,
      lineNumber: true,
      pattern: "hello",
      paths: ["/workspace/src"],
    },
    root: "/workspace",
    cwd: "/workspace",
    files: [
      {
        path: "/workspace/src/app.js",
        content: "console.log('hello');\n",
      },
      {
        path: "/workspace/src/lib/util.js",
        content: "export const hello = true;\n",
      },
    ],
  });

  assert.equal(result.runtime, "wasm");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\/workspace\/src\/app\.js:1:console\.log\('hello'\);/);
  assert.match(result.stdout, /\/workspace\/src\/lib\/util\.js:1:export const hello = true;/);
});
