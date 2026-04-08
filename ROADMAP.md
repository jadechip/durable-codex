# Serverless Codex Roadmap

Goal: make `Durable Codex` feel as close to local Codex as possible while keeping the runtime primarily serverless.

## Principles

- The user experiences one persistent Codex session.
- The workspace behaves like one persistent filesystem.
- Worker and sandbox execution should feel interchangeable to the user.
- Sandboxes are an implementation detail, not the default runtime.

## Phase 1: Core Behavior Parity

- Port upstream context and developer-message construction more faithfully.
- Port pending-input, steer, interrupt, and hook semantics more faithfully.
- Add memories and the richer Codex prompt stack.
- Tighten the agentic loop until behavior matches local Codex more closely.

Status:
- Partially underway.
- Intentionally deferred while phases 2 and 3 are built out.

## Phase 2: Filesystem Parity

- Keep a shared VFS as the canonical workspace state.
- Use `R2` as the production source of truth and DO storage as the local fallback.
- Keep file storage invisible to the model so Codex still feels local.
- Materialize the same VFS revision into a sandbox only when a tool truly needs POSIX or process semantics.
- Sync sandbox changes back into the shared VFS so the workspace stays coherent.

Current status:
- Shared VFS exists and is deployed.
- The Worker can persist and mutate files directly against the VFS.
- `R2` is live as the deployed backend.
- Sandbox materialization exists behind the command path, not as the default thread path.

## Phase 3: Tool And Runtime Parity

- Keep the Codex-visible surface aligned with local Codex.
- Add a sandbox broker so command execution can hydrate from the shared VFS and write back.
- Add `exec` and later richer runtime surfaces such as git-ish operations, MCP, and review flows.
- Keep tool behavior stable regardless of whether the underlying executor is the Worker or a sandbox.

Current status:
- Dynamic tools and `request_user_input` exist.
- `apply_patch` now targets the shared VFS directly.
- `exec_command` now routes through the sandbox executor instead of exposing bespoke workspace tools.
- PTY, `write_stdin`, and broader runtime parity are still missing.

## Phase 4: UX Parity

- Preserve the feeling of a persistent machine and workspace.
- Keep streaming, turn continuity, and mid-turn steering consistent.
- Hide serverless boundaries from the user wherever possible.

## Practical Standard

If a user cannot tell whether a step ran in a Worker or in a sandbox, the architecture is doing its job.
