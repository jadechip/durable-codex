import { DurableObject } from "cloudflare:workers";
import { createSandboxBroker } from "./lib/sandbox-broker.js";
import { createSandboxCommandExecutor } from "./lib/sandbox-command-executor.js";
import { createDynamicWorkerDriver } from "./lib/dynamic-worker-driver.js";
import { createTraceLogger } from "./lib/trace.js";
import { createWorkspaceStore } from "./lib/vfs-store.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function buildThreadRecord(payload = {}) {
  return {
    id: typeof payload.id === "string" && payload.id ? payload.id : "thr_kernel",
    workspaceId: typeof payload.workspaceId === "string" && payload.workspaceId ? payload.workspaceId : (
      typeof payload.workspace?.id === "string" && payload.workspace.id ? payload.workspace.id : "default"
    ),
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : (
      typeof payload.workspace?.root === "string" && payload.workspace.root ? payload.workspace.root : "/workspace"
    ),
    workspace:
      payload.workspace && typeof payload.workspace === "object" && !Array.isArray(payload.workspace)
        ? structuredClone(payload.workspace)
        : null,
  };
}

export class WorkspaceKernel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.trace = createTraceLogger({
      enabled: env?.APP_SERVER_TRACE,
      prefix: "workspace-kernel",
    });
    this.workspaceStore = createWorkspaceStore({
      bucket: env?.VFS_BUCKET ?? null,
      localStorage: this.ctx.storage,
    });
    const sandboxCommandExecutor = createSandboxCommandExecutor({
      binding: env?.Sandbox ?? null,
      trace: this.trace,
    });
    const dynamicWorkerDriver = createDynamicWorkerDriver({
      loader: env?.LOADER ?? null,
      workspaceStore: this.workspaceStore,
      trace: this.trace,
    });
    this.commandRuntime = createSandboxBroker({
      workspaceStore: this.workspaceStore,
      commandExecutor: sandboxCommandExecutor,
      commandDrivers: [dynamicWorkerDriver],
      trace: this.trace,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await readJson(request);
    const thread = buildThreadRecord(body.thread);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /workspace/ensure": {
          const workspace = await this.workspaceStore.ensureWorkspace(thread);
          return json({ workspace });
        }
        case "POST /workspace/read": {
          const workspace = await this.workspaceStore.readWorkspace(thread);
          return json({ workspace });
        }
        case "POST /workspace/list": {
          const result = await this.workspaceStore.listFiles(thread, body.path ?? null, {
            recursive: Boolean(body.recursive),
            limit: Number.isFinite(body.limit) ? body.limit : 200,
          });
          return json(result);
        }
        case "POST /workspace/readFile": {
          const result = await this.workspaceStore.readFile(thread, body.path);
          return json(result);
        }
        case "POST /workspace/writeFile": {
          const result = await this.workspaceStore.writeFile(
            thread,
            body.path,
            typeof body.content === "string" ? body.content : "",
            typeof body.contentType === "string" && body.contentType ? body.contentType : null,
          );
          return json(result);
        }
        case "POST /workspace/deleteFile": {
          const result = await this.workspaceStore.deleteFile(thread, body.path, {
            recursive: Boolean(body.recursive),
          });
          return json(result);
        }
        case "POST /workspace/exportSnapshot": {
          const result = await this.workspaceStore.exportWorkspaceSnapshot(thread, {
            path: body.path ?? null,
          });
          return json(result);
        }
        case "POST /workspace/applyFiles": {
          const result = await this.workspaceStore.applyWorkspaceFiles(thread, body.files ?? [], {
            removePaths: body.removePaths ?? [],
          });
          return json(result);
        }
        case "POST /command/execute": {
          const result = await this.commandRuntime.executeCommand(thread, {
            command: body.command,
            cwd: body.cwd ?? null,
            tty: Boolean(body.tty),
            timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : null,
            maxOutputTokens: Number.isFinite(body.maxOutputTokens) ? body.maxOutputTokens : null,
            shell: typeof body.shell === "string" && body.shell ? body.shell : undefined,
          });
          return json(result);
        }
        case "POST /command/write-stdin": {
          const result = await this.commandRuntime.writeStdin(thread, body.execSession ?? {}, {
            chars: typeof body.chars === "string" ? body.chars : "",
            timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : null,
            maxOutputTokens: Number.isFinite(body.maxOutputTokens) ? body.maxOutputTokens : null,
          });
          return json(result);
        }
        case "POST /command/close-session": {
          const closed = await this.commandRuntime.closeCommandSession(thread, body.execSession ?? {});
          return json({ closed: Boolean(closed) });
        }
        default:
          return json({
            error: {
              code: "not_found",
              message: `No route for ${request.method} ${url.pathname}`,
            },
          }, 404);
      }
    } catch (error) {
      return json({
        error: {
          code: "kernel_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, 500);
    }
  }
}
