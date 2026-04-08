# Execution Spec

## Goal

Make the Worker-native runtime feel closer to local Codex by introducing a multi-driver execution model:

- the Worker remains the session and workspace authority
- deterministic filesystem-oriented commands run inside the Worker
- heavier process-native commands fall through to Cloudflare Sandbox
- the model continues to see the normal Codex action surface: `exec_command`, `write_stdin`, `apply_patch`

This borrows the `agent-os` idea of a shared filesystem plus multiple execution drivers, without trying to port `agent-os` wholesale into Cloudflare Workers.

## Layers

### Session Layer

- `AppServerSession` Durable Object owns the WebSocket session
- `AppServerSessionEngine` owns turns, hidden history, and tool dispatch

### Workspace Layer

- `WorkspaceKernel` Durable Object now owns each shared workspace
- `createWorkspaceStore()` remains the canonical VFS implementation behind that kernel
- `R2` is the preferred backend
- Durable Object storage remains the local/dev fallback
- the session layer talks to the kernel through `workspace-kernel-client`

### Execution Drivers

The runtime resolves `exec_command` to one of these drivers:

1. `workerBuiltin`
   - runs inside the Worker
   - no real processes
   - operates directly on the shared VFS
   - now executes supported commands through a real Rust-compiled Wasm module
   - current allowlist:
     - `pwd`
     - `ls`
     - `cat`
     - `head`
     - `tail`
     - `wc`
     - `find`
     - `rg`

2. `sandbox`
   - full process execution in Cloudflare Sandbox
   - used for shell semantics, PTY, runtimes, package managers, and unknown commands

3. `dynamicWorker`
   - implemented for a narrow JS/Python runtime today
   - currently handles:
     - `node -e "..."`
     - `node script.js`
     - `python -c "..."`
     - `python script.py`
   - runs through the `worker_loaders` binding with the shared workspace snapshot injected as structured data
   - syncs changed files back into the shared VFS after execution

## Routing Rules

Routing is conservative.

The router resolves commands in this order:

1. `workerBuiltin`
2. `dynamicWorker`
3. `sandbox` fallback

`workerBuiltin` is selected only when all of these are true:

- `tty` is false
- no explicit `shell` override is requested
- the command parses as a simple argv command
- the command does not use shell syntax such as:
  - pipes
  - `&&` / `||`
  - `;`
  - redirection
  - command substitution
  - globbing
- the executable is in the Worker allowlist
- the command-specific parser confirms the flags/shape are supported

There is one important extra rule now:

- simple `sh -lc '...'` / `bash -lc '...'` / `zsh -lc '...'` wrappers are unwrapped first
- if the inner command matches `workerBuiltin` or `dynamicWorker`, it stays off the sandbox path
- only wrappers that still require real shell semantics fall through to `sandbox`

Everything else falls through to `sandbox`.

This keeps the Worker path small and predictable, and makes the sandbox the universal compatibility fallback.

## Driver Responsibilities

### workerBuiltin

- read/search-oriented commands over the shared VFS
- path resolution relative to `cwd`
- command output formatting
- no background processes
- no PTY
- no shell grammar
- backed by a real Wasm command module loaded inside the Worker
- current module is compiled from `wasm/worker-command-wasm`
- the JS side still owns routing and payload marshalling, but command execution itself is no longer implemented in JS

### dynamicWorker

- ephemeral code execution with stronger isolation than the base Worker
- no PTY
- no full POSIX shell
- current narrow target is JS/Python execution for `node -e`, `node script.js`, `python -c`, and `python script.py`
- uses the same workspace snapshot and writes file changes back into the same VFS
- Python execution supports pure-Python workspace programs and binary file I/O, but automatically falls back to sandbox for process APIs or unavailable third-party modules

### sandbox

- `sh`, `bash`, `git`, `npm`, `pnpm`, and all unknown commands not explicitly claimed by `dynamicWorker`
- interactive `tty=true`
- `write_stdin`
- any command requiring real POSIX behavior

## Why This Is Less Brittle

The routing decision is based on executable ownership and a small syntax gate, not on prompt heuristics.

That means:

- we do not need to guess user intent
- we do not need to emulate every shell feature in the Worker
- the Worker path can grow incrementally by adding known-good drivers
- unsupported cases automatically land in the more capable runtime

## Test Plan

This pass should verify:

1. Worker driver executes supported commands without sandbox involvement.
2. Dynamic worker commands execute without sandbox involvement and sync file changes back.
3. Simple shell wrappers can still stay on the Worker or dynamic-worker path when the inner command is safe.
4. Unsupported commands fall through to the sandbox executor.
5. The app-server turn loop records which driver actually handled a command.
6. Existing sandbox-backed PTY behavior keeps working.

## Follow-up

Remaining follow-up after this pass:

1. replace the current custom `apply_patch` parser with a more canonical implementation
2. decide whether to split the current Wasm command engine into multiple command-specific modules
3. expand the Worker and dynamic-worker driver sets only when command fidelity is good enough
4. add deeper shell/runtime compatibility only where it preserves the serverless illusion
