function serializeThread(thread) {
  return {
    id: thread.id,
    workspaceId: thread.workspace?.id ?? thread.workspaceId ?? "default",
    cwd: thread.cwd,
    workspace:
      thread.workspace && typeof thread.workspace === "object" && !Array.isArray(thread.workspace)
        ? structuredClone(thread.workspace)
        : null,
  };
}

function parseKernelResponse(body, pathname) {
  if (body && typeof body === "object" && body.error) {
    throw new Error(body.error.message || `Workspace kernel request failed for ${pathname}`);
  }
  return body;
}

export function createWorkspaceKernelClient({
  binding,
  trace = () => {},
} = {}) {
  function stubForThread(thread) {
    if (!binding || typeof binding.idFromName !== "function" || typeof binding.get !== "function") {
      throw new Error("Workspace kernel binding is not configured on this deployment.");
    }
    const workspaceId = thread.workspace?.id ?? thread.workspaceId ?? "default";
    const id = binding.idFromName(workspaceId);
    return binding.get(id);
  }

  async function post(thread, pathname, payload = {}) {
    const stub = stubForThread(thread);
    const request = new Request(`https://workspace-kernel.internal${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        thread: serializeThread(thread),
        ...payload,
      }),
    });
    const response = await stub.fetch(request);
    const body = await response.json();
    trace("workspaceKernelClient.call", {
      workspaceId: thread.workspace?.id ?? thread.workspaceId ?? "default",
      pathname,
      ok: response.ok,
    });
    return parseKernelResponse(body, pathname);
  }

  const workspaceStore = {
    kind: "workspaceKernelClient",
    async ensureWorkspace(thread) {
      const body = await post(thread, "/workspace/ensure");
      return body.workspace;
    },
    async readWorkspace(thread) {
      const body = await post(thread, "/workspace/read");
      return body.workspace;
    },
    async listFiles(thread, path = null, options = {}) {
      return post(thread, "/workspace/list", {
        path,
        recursive: Boolean(options.recursive),
        limit: Number.isFinite(options.limit) ? options.limit : 200,
      });
    },
    async readFile(thread, path) {
      return post(thread, "/workspace/readFile", { path });
    },
    async writeFile(thread, path, content, contentType = null) {
      return post(thread, "/workspace/writeFile", {
        path,
        content,
        contentType,
      });
    },
    async deleteFile(thread, path, options = {}) {
      return post(thread, "/workspace/deleteFile", {
        path,
        recursive: Boolean(options.recursive),
      });
    },
    async exportWorkspaceSnapshot(thread, options = {}) {
      return post(thread, "/workspace/exportSnapshot", {
        path: options.path ?? null,
      });
    },
    async applyWorkspaceFiles(thread, files, options = {}) {
      return post(thread, "/workspace/applyFiles", {
        files,
        removePaths: options.removePaths ?? [],
      });
    },
  };

  const sandboxBroker = {
    async supportsCommandExecution() {
      return true;
    },
    async executeCommand(thread, options = {}) {
      return post(thread, "/command/execute", {
        command: options.command,
        cwd: options.cwd ?? null,
        tty: Boolean(options.tty),
        timeoutMs: options.timeoutMs ?? null,
        maxOutputTokens: options.maxOutputTokens ?? null,
        shell: options.shell ?? null,
      });
    },
    async writeStdin(thread, execSession, options = {}) {
      return post(thread, "/command/write-stdin", {
        execSession,
        chars: options.chars ?? "",
        timeoutMs: options.timeoutMs ?? null,
        maxOutputTokens: options.maxOutputTokens ?? null,
      });
    },
    async closeCommandSession(thread, execSession) {
      const body = await post(thread, "/command/close-session", {
        execSession,
      });
      return Boolean(body.closed);
    },
  };

  return {
    workspaceStore,
    sandboxBroker,
  };
}
