const JSONRPC_VERSION = "2.0";

export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
};

export function parseJsonRpcMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: errorResponse(null, JSONRPC_ERROR.PARSE_ERROR, "Invalid JSON payload"),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: errorResponse(null, JSONRPC_ERROR.INVALID_REQUEST, "JSON-RPC payload must be an object"),
    };
  }

  return {
    ok: true,
    value: parsed,
  };
}

export function resultResponse(id, result) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

export function errorResponse(id, code, message, data) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

export function notification(method, params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    params,
  };
}

export function isRequest(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}
