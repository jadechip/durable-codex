export { Sandbox } from "@cloudflare/sandbox";
import { AppServerSession } from "./session-do.js";
import { WorkspaceKernel } from "./workspace-kernel-do.js";

export { AppServerSession };
export { WorkspaceKernel };

const DEFAULT_SESSION_LOCATION_HINT = "enam";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isTruthy(value) {
  if (typeof value !== "string") {
    return Boolean(value);
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolvedSessionLocationHint(env) {
  if (isTruthy(env.APP_SERVER_SESSION_DISABLE_LOCATION_HINT)) {
    return null;
  }

  const configuredHint = env.APP_SERVER_SESSION_LOCATION_HINT ?? DEFAULT_SESSION_LOCATION_HINT;
  if (typeof configuredHint !== "string") {
    return DEFAULT_SESSION_LOCATION_HINT;
  }

  const normalizedHint = configuredHint.trim();
  return normalizedHint || DEFAULT_SESSION_LOCATION_HINT;
}

function sessionStub(env, sessionId) {
  const id = env.APP_SERVER_SESSION.idFromName(sessionId);
  const locationHint = resolvedSessionLocationHint(env);
  if (!locationHint) {
    return env.APP_SERVER_SESSION.get(id);
  }

  return env.APP_SERVER_SESSION.get(id, {
    locationHint,
  });
}

function cloneForDo(request, pathname) {
  const url = new URL(request.url);
  url.hostname = "session.internal";
  url.protocol = "https:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), request);
}

function sessionWebSocketUrl(request, sessionId) {
  const url = new URL(request.url);
  url.pathname = `/ws/${sessionId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "durable-codex",
        routes: {
          createSession: "POST /sessions",
          websocket: "GET /ws/:sessionId",
          healthz: "GET /healthz",
          readyz: "GET /readyz",
        },
        rpcMethods: [
          "initialize",
          "initialized",
          "thread/start",
          "thread/resume",
          "thread/read",
          "workspace/read",
          "workspace/list",
          "workspace/readFile",
          "workspace/writeFile",
          "workspace/deleteFile",
          "turn/start",
          "turn/steer",
          "turn/interrupt",
        ],
        executionLayers: [
          "workerBuiltin",
          "dynamicWorker",
          "sandbox",
        ],
      });
    }

    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      return json({
        ok: true,
        service: "durable-codex",
      });
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const sessionId = crypto.randomUUID();
      return json({
        ok: true,
        sessionId,
        websocketUrl: sessionWebSocketUrl(request, sessionId),
      }, 201);
    }

    if (url.pathname.startsWith("/ws/")) {
      const sessionId = url.pathname.slice("/ws/".length);
      if (!sessionId) {
        return json({
          error: {
            code: "bad_request",
            message: "Missing session id in websocket path.",
          },
        }, 400);
      }

      const stub = sessionStub(env, sessionId);
      return stub.fetch(cloneForDo(request, "/ws"));
    }

    return json({
      error: {
        code: "not_found",
        message: `No route for ${request.method} ${url.pathname}`,
      },
    }, 404);
  },
};
