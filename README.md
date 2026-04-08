# Durable Codex

<p>
  Serverless, Cloudflare-native runtime for persistent coding agents.<br/>
  Workers for the control plane. R2 for the workspace. Wasm and Dynamic Workers for the fast path. Sandboxes only when the task actually needs one.
</p>

<p>
  Build agents that feel like they own a real machine without paying the cost of putting every step in a container.
</p>

## Why This Exists

Most agent stacks make you choose between:

- fast but shallow serverless orchestration
- powerful but expensive sandbox-first execution

Durable Codex takes a different path.

It treats Cloudflare as an agent operating system:

- `Workers` and `Durable Objects` own sessions, threads, streaming, and routing
- `R2` backs a shared virtual filesystem
- `Wasm` handles cheap deterministic commands like `pwd`, `ls`, `cat`, `find`, and `rg`
- `Dynamic Workers` run ephemeral JS and Python
- `Sandboxes` are the compatibility layer for shell, PTY, and real process workloads

The user should not need to know where a step ran.

## What You Get

- Long-lived threads with hidden history and turn state
- App-server-style WebSocket JSON-RPC transport
- Shared `/workspace` persisted through a virtual filesystem
- Codex-style `apply_patch`, `exec_command`, and `write_stdin`
- Binary-safe workspace sync across Worker, Dynamic Worker, and Sandbox
- Automatic Python fallback to Sandbox when code needs real process semantics
- Worker-first cost profile with lazy sandbox creation

## Runtime Stack

| Layer | What it does | Typical work |
| --- | --- | --- |
| `Session DO` | transport, turn loop, streaming, hidden history | `thread/start`, `turn/start`, deltas |
| `WorkspaceKernel DO` | workspace authority and command routing | `workspace/read`, `command/execute` |
| `Worker Wasm` | deterministic command tier | `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `find`, `rg` |
| `Dynamic Worker` | lightweight code execution tier | `node -e`, `node script.js`, `python -c`, `python script.py` |
| `Sandbox` | full compatibility tier | `sh`, `bash`, `git`, `npm`, PTY, `write_stdin`, Python `subprocess` |

## The Big Idea

The model sees a normal agent surface:

- `apply_patch`
- `exec_command`
- `write_stdin`

It does not need to understand:

- where the workspace is stored
- whether the command ran in Wasm, a Dynamic Worker, or a Sandbox
- how state moves between runtimes

That routing is the framework’s job.

## Workspace Model

The workspace is a shared virtual filesystem rooted at `/workspace`.

- `R2` is the intended durable backend
- Durable Object storage is the fallback for local and dev use
- `apply_patch` writes directly into the VFS
- Dynamic Workers execute against a workspace snapshot and sync their file changes back
- Sandboxes materialize the same workspace and flush changes back after execution
- binary files survive the full round trip

In practice, a file created by Wasm, Dynamic Worker Python, or a sandboxed shell command lands in the same shared workspace.

## Quick Start

```bash
cd worker-app-server
npm install
npm run build:wasm
npm test
npm run dev
```

Create a session:

```bash
curl -X POST http://127.0.0.1:8787/sessions
```

Then connect to the returned `websocketUrl`.

## Development

```bash
cd worker-app-server
npm run build:wasm
npm run check
npm test
npm run dev
npm run demo
npm run chat
npm run tail
```

### Chat Client

```bash
APP_SERVER_BASE_URL="https://<your-worker-domain>" \
APP_SERVER_WORKSPACE_ID="default" \
npm run chat
```

Manual commands:

- `/workspace`
- `/ls [path]`
- `/cat <path>`
- `/write <path> <text>`
- `/rm <path>`
- `/events on|off|raw`
- `/exit`

## Good Test Prompts

Worker Wasm:

```text
Run pwd
Please list /workspace recursively
Run rg "hello" /workspace
```

Dynamic Worker:

```text
Run node -e "const fs=require('fs'); fs.writeFileSync('/workspace/dynamic.txt','hello from dynamic\n'); console.log('dynamic ok')"
Run python3 -c "from pathlib import Path; Path('/workspace/python.txt').write_text('hello from python\n'); print('python ok')"
```

Sandbox fallback:

```text
Run python3 -c "import subprocess; print(subprocess.check_output(['python3','-c','print(42)'], text=True).strip())"
Run sh -lc 'printf "hello from sandbox\n" > /workspace/sandbox.txt && cat /workspace/sandbox.txt'
```

PTY:

```text
Use exec_command with tty=true to run /bin/sh -lc 'printf "ready\n"; read line; printf "%s\n" "$line" > /workspace/pty.txt; printf "saved\n"', then use write_stdin to send exactly hello followed by a newline, wait for completion, and tell me the result
```

## Live Smoke

```bash
APP_SERVER_BASE_URL="https://<your-worker-domain>" \
APP_SERVER_WORKSPACE_ID="prod-smoke-$(date +%s)" \
node scripts/live-smoke.mjs
```

The smoke verifies:

- Worker Wasm commands
- Dynamic Worker Node
- Dynamic Worker Python
- Python fallback to Sandbox
- shell fallback to Sandbox
- PTY + `write_stdin`
- workspace persistence across all of the above

## Configuration

Environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `OPENROUTER_HTTP_REFERER`
- `OPENROUTER_X_TITLE`
- `DEFAULT_MODEL_PROVIDER`
- `DEFAULT_MODEL`
- `OPENROUTER_MODEL`
- `APP_SERVER_TRACE`

Bindings:

- `APP_SERVER_SESSION`
- `APP_WORKSPACE_KERNEL`
- `VFS_BUCKET`
- `Sandbox`
- `LOADER`

Defaults:

- `DEFAULT_MODEL=gpt-5.3-codex`
- `DEFAULT_MODEL_PROVIDER=openai`

## Deploy

```bash
cd worker-app-server
npm run deploy
```

This deploys:

- the Worker app
- the Durable Object control plane
- the Dynamic Worker loader path
- the Sandbox image used for compatibility fallback

## Observability

Use:

```bash
npm run tail
```

Useful trace events:

- `rpc.handle`
- `turn.start`
- `tool.call`
- `command.route`
- `dynamic.exec.start`
- `dynamic.exec.result`
- `dynamic.exec.fallback`
- `command.fallback`
- `sandbox.materialize`
- `sandbox.exec.start`
- `sandbox.exec.result`
- `sandbox.pty.start`
- `sandbox.write_stdin.start`
- `turn.finalize`

If you want to know which runtime handled a command, `command.route` is the first thing to look at.

## Repository Guide

- [EXECUTION_SPEC.md](./EXECUTION_SPEC.md): execution model
- [ROADMAP.md](./ROADMAP.md): broader parity direction
- [`src/lib/session-engine.js`](./src/lib/session-engine.js): turn runner
- [`src/workspace-kernel-do.js`](./src/workspace-kernel-do.js): workspace authority
- [`src/lib/vfs-store.js`](./src/lib/vfs-store.js): virtual filesystem
- [`src/lib/dynamic-worker-driver.js`](./src/lib/dynamic-worker-driver.js): JS/Python dynamic execution
- [`src/lib/sandbox-command-executor.js`](./src/lib/sandbox-command-executor.js): sandbox exec and PTY
- [`wasm/worker-command-wasm`](./wasm/worker-command-wasm): Worker Wasm command runtime

## Status

Today this framework already supports:

- persistent agent sessions
- shared cloud-backed workspaces
- model-visible file editing
- multi-tier command routing
- JS and Python execution without defaulting to containers
- transparent fallback to sandbox when the task needs a real process environment

The main remaining gaps are deeper local-agent parity features like richer approvals, hooks, memories, and broader tool/plugin surfaces.

But the core promise is already real: Cloudflare-native agents with real state, real files, and real execution tiers.
