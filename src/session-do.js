import { DurableObject } from "cloudflare:workers";
import { errorResponse, parseJsonRpcMessage } from "./lib/jsonrpc.js";
import { createModelClient } from "./lib/model-client.js";
import { createTraceLogger } from "./lib/trace.js";
import { createWorkspaceKernelClient } from "./lib/workspace-kernel-client.js";
import { AppServerSessionEngine } from "./lib/session-engine.js";

const SESSION_STATE_KEY = "worker-app-server-state";
const DEFAULT_MODEL_PROVIDER = "openai";

function normalizeModelProvider(value) {
  if (typeof value !== "string") {
    return DEFAULT_MODEL_PROVIDER;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || DEFAULT_MODEL_PROVIDER;
}

function resolveDefaultModelProvider(env) {
  if (typeof env?.DEFAULT_MODEL_PROVIDER === "string" && env.DEFAULT_MODEL_PROVIDER.trim()) {
    return normalizeModelProvider(env.DEFAULT_MODEL_PROVIDER);
  }

  if (typeof env?.OPENROUTER_PREFERRED_PROVIDER === "string" && env.OPENROUTER_PREFERRED_PROVIDER.trim()) {
    return normalizeModelProvider(env.OPENROUTER_PREFERRED_PROVIDER);
  }

  return DEFAULT_MODEL_PROVIDER;
}

function resolveDefaultModelByProvider(env) {
  const byProvider = {};

  if (typeof env?.OPENROUTER_MODEL === "string" && env.OPENROUTER_MODEL.trim()) {
    byProvider.openrouter = env.OPENROUTER_MODEL.trim();
  }

  return byProvider;
}

function connectionStateDefaults() {
  return {
    phase: "uninitialized",
    experimentalApi: false,
    optOutNotificationMethods: [],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export class AppServerSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.trace = createTraceLogger({
      enabled: env?.APP_SERVER_TRACE,
      prefix: "worker-app-server",
    });
    this.connections = new Map();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    const kernelClient = createWorkspaceKernelClient({
      binding: env?.APP_WORKSPACE_KERNEL,
      trace: this.trace,
    });
    this.engine = new AppServerSessionEngine({
      loadState: async () => this.ctx.storage.get(SESSION_STATE_KEY),
      saveState: async (state) => this.ctx.storage.put(SESSION_STATE_KEY, state),
      modelClient: createModelClient(env),
      workspaceStore: kernelClient.workspaceStore,
      sandboxBroker: kernelClient.sandboxBroker,
      notify: (envelope) => this.broadcast(envelope),
      defaultModel:
        typeof env?.DEFAULT_MODEL === "string" && env.DEFAULT_MODEL.trim()
          ? env.DEFAULT_MODEL.trim()
          : undefined,
      defaultModelProvider: resolveDefaultModelProvider(env),
      defaultModelByProvider: resolveDefaultModelByProvider(env),
      trace: this.trace,
    });

    // Rehydrate per-connection metadata after a hibernated DO wakes up.
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socket.deserializeAttachment() ?? connectionStateDefaults();
      this.connections.set(socket, meta);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({
          error: {
            code: "websocket_required",
            message: "This route only accepts WebSocket upgrades.",
          },
        }, 426);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const meta = connectionStateDefaults();

      // `acceptWebSocket()` is the DO hibernation API. Unlike `ws.accept()`, it
      // allows Cloudflare to evict the DO while keeping the socket connected.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(meta);
      this.connections.set(server, meta);
      this.trace("ws.accept", {
        connectionCount: this.connections.size,
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      await this.engine.ensureState();
      return json({
        ok: true,
        sessionThreads: Object.keys(this.engine.state.threads),
      });
    }

    return json({
      error: {
        code: "not_found",
        message: `No route for ${request.method} ${url.pathname}`,
      },
    }, 404);
  }

  connectionState(socket) {
    let meta = this.connections.get(socket);
    if (!meta) {
      meta = socket.deserializeAttachment() ?? connectionStateDefaults();
      this.connections.set(socket, meta);
    }
    return meta;
  }

  persistConnectionState(socket, meta) {
    socket.serializeAttachment(meta);
    this.connections.set(socket, meta);
  }

  broadcast(envelope) {
    const serialized = JSON.stringify(envelope);
    for (const [socket, meta] of this.connections.entries()) {
      if (meta.phase !== "ready") {
        continue;
      }
      if (
        !Object.prototype.hasOwnProperty.call(envelope, "id") &&
        meta.optOutNotificationMethods?.includes(envelope.method)
      ) {
        continue;
      }
      try {
        socket.send(serialized);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async webSocketMessage(socket, message) {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = parseJsonRpcMessage(raw);
    if (!parsed.ok) {
      socket.send(JSON.stringify(parsed.error));
      return;
    }

    const meta = this.connectionState(socket);
    const response = await this.engine.handleRpc(parsed.value, meta);
    this.persistConnectionState(socket, meta);

    if (response) {
      socket.send(JSON.stringify(response));
    }
  }

  webSocketError(socket) {
    this.connections.delete(socket);
    this.trace("ws.error", {
      connectionCount: this.connections.size,
    });
  }

  webSocketClose(socket) {
    this.connections.delete(socket);
    this.trace("ws.close", {
      connectionCount: this.connections.size,
    });
  }
}
