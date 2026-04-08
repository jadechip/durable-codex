import test from "node:test";
import assert from "node:assert/strict";

import { buildExecUsage, parseExecArgs } from "../src/lib/exec-cli.js";

test("parseExecArgs uses env defaults and positional prompt", () => {
  const options = parseExecArgs(["Run", "pwd"], {
    APP_SERVER_BASE_URL: "https://example.com",
    APP_SERVER_WORKSPACE_ID: "repo-a",
    APP_SERVER_MODEL: "gpt-test",
    APP_SERVER_CWD: "/workspace/subdir",
  });

  assert.deepEqual(options, {
    baseUrl: "https://example.com",
    workspaceId: "repo-a",
    model: "gpt-test",
    cwd: "/workspace/subdir",
    json: false,
    rawEvents: false,
    help: false,
    prompt: "Run pwd",
  });
});

test("parseExecArgs parses flags and supports positional-only separator", () => {
  const options = parseExecArgs([
    "--base-url", "http://127.0.0.1:9999",
    "--workspace", "repo-b",
    "--model", "gpt-5.3-codex",
    "--cwd", "/workspace",
    "--json",
    "--raw-events",
    "--",
    "--not-a-flag",
    "prompt",
  ]);

  assert.equal(options.baseUrl, "http://127.0.0.1:9999");
  assert.equal(options.workspaceId, "repo-b");
  assert.equal(options.model, "gpt-5.3-codex");
  assert.equal(options.cwd, "/workspace");
  assert.equal(options.json, true);
  assert.equal(options.rawEvents, true);
  assert.equal(options.prompt, "--not-a-flag prompt");
});

test("parseExecArgs rejects missing flag values", () => {
  assert.throws(() => parseExecArgs(["--workspace"]), /--workspace requires a value/);
  assert.throws(() => parseExecArgs(["--base-url"]), /--base-url requires a value/);
  assert.throws(() => parseExecArgs(["--model"]), /--model requires a value/);
  assert.throws(() => parseExecArgs(["--cwd"]), /--cwd requires a value/);
});

test("buildExecUsage documents codex exec", () => {
  const usage = buildExecUsage();
  assert.match(usage, /codex exec \[options\] <prompt>/);
  assert.match(usage, /--json/);
  assert.match(usage, /--workspace/);
});
