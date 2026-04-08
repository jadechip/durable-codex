import { applyPatchToWorkspace } from "./apply-patch.js";
import { buildDynamicToolDefinitions, renderDynamicToolContentItems } from "./context-builder.js";

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
export const EXEC_COMMAND_TOOL_NAME = "exec_command";
export const WRITE_STDIN_TOOL_NAME = "write_stdin";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";

function requestUserInputToolSchema() {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to show the user. Prefer 1 and do not exceed 3",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "header", "question", "options"],
          properties: {
            id: {
              type: "string",
              description: "Stable identifier for mapping answers (snake_case).",
            },
            header: {
              type: "string",
              description: "Short header label shown in the UI (12 or fewer chars).",
            },
            question: {
              type: "string",
              description: "Single-sentence prompt shown to the user.",
            },
            options: {
              type: "array",
              description:
                "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client will add a free-form \"Other\" option automatically.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "description"],
                properties: {
                  label: {
                    type: "string",
                    description: "User-facing label (1-5 words).",
                  },
                  description: {
                    type: "string",
                    description: "One short sentence explaining impact/tradeoff if selected.",
                  },
                },
              },
            },
          },
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };
}

function execCommandSchema() {
  return {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "Shell command to execute.",
      },
      workdir: {
        type: "string",
        description: "Optional working directory to run the command in; defaults to the turn cwd.",
      },
      shell: {
        type: "string",
        description: "Shell binary to launch. Defaults to the user's default shell.",
      },
      login: {
        type: "boolean",
        description: "Whether to run the shell with -l/-i semantics. Defaults to true.",
      },
      tty: {
        type: "boolean",
        description: "Whether to allocate a TTY for the command. Defaults to false (plain pipes).",
      },
      yield_time_ms: {
        type: "integer",
        description: "How long to wait in milliseconds for output before yielding.",
      },
      max_output_tokens: {
        type: "integer",
        description: "Maximum number of tokens to return. Excess output will be truncated.",
      },
      sandbox_permissions: {
        type: "string",
        description: "Per-command sandbox override. Defaults to the turn sandbox policy.",
      },
      justification: {
        type: "string",
        description: "Optional approval justification when elevated permissions are needed.",
      },
      prefix_rule: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Optional approval prefix rule for similar future commands.",
      },
    },
    required: ["cmd"],
    additionalProperties: false,
  };
}

function writeStdinSchema() {
  return {
    type: "object",
    properties: {
      session_id: {
        type: "integer",
        description: "Identifier of the running unified exec session.",
      },
      chars: {
        type: "string",
        description: "Bytes to write to stdin (may be empty to poll).",
      },
      yield_time_ms: {
        type: "integer",
        description: "How long to wait in milliseconds for output before yielding.",
      },
      max_output_tokens: {
        type: "integer",
        description: "Maximum number of tokens to return. Excess output will be truncated.",
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  };
}

function applyPatchSchema() {
  return {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The full patch text. It must contain a valid apply_patch block starting with '*** Begin Patch' and ending with '*** End Patch'. Do not include explanatory prose outside the patch unless unavoidable.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  };
}

function builtInToolDefinitions() {
  return [
    {
      type: "function",
      name: EXEC_COMMAND_TOOL_NAME,
      description:
        "Runs a command in a PTY, returning output or a session ID for ongoing interaction. Use this when the user asks you to run code, scripts, tests, or shell commands. If the user asked for a multi-step task, continue with the remaining requested steps in the same turn when possible instead of stopping after an edit.",
      strict: false,
      parameters: execCommandSchema(),
    },
    {
      type: "function",
      name: WRITE_STDIN_TOOL_NAME,
      description: "Writes characters to an existing unified exec session and returns recent output.",
      strict: false,
      parameters: writeStdinSchema(),
    },
    {
      type: "function",
      name: APPLY_PATCH_TOOL_NAME,
      description:
        "Use this tool to edit files by sending a valid apply_patch block. Prefer this for deterministic file edits. The patch should start with '*** Begin Patch' and end with '*** End Patch'. After a successful patch, continue with any remaining requested steps in the same turn unless you are blocked or need clarification.",
      strict: false,
      parameters: applyPatchSchema(),
    },
  ];
}

export function buildThreadToolDefinitions(thread) {
  const tools = [
    ...builtInToolDefinitions(),
    ...buildDynamicToolDefinitions(thread),
  ];

  if (thread.allowRequestUserInputTool) {
    tools.push({
      type: "function",
      name: REQUEST_USER_INPUT_TOOL_NAME,
      description: "Prompt the user for short structured answers before continuing the turn.",
      strict: false,
      parameters: requestUserInputToolSchema(),
    });
  }

  return tools;
}

function validateDynamicToolResult(result) {
  const contentItems = Array.isArray(result?.contentItems)
    ? result.contentItems.filter((item) => item && typeof item === "object")
    : [];

  return {
    contentItems,
    success: result?.success !== false,
    outputText: renderDynamicToolContentItems(contentItems),
  };
}

function validateRequestUserInputResult(result) {
  const answers = {};
  const source = result?.answers && typeof result.answers === "object" ? result.answers : {};

  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    answers[key] = {
      answers: Array.isArray(value.answers)
        ? value.answers.filter((entry) => typeof entry === "string")
        : [],
    };
  }

  return {
    answers,
    outputText: JSON.stringify(answers),
  };
}

function buildExternalRequestRecord({ id, threadId, turnId, itemId, callId, method, kind, params, nowMs }) {
  return {
    id,
    threadId,
    turnId,
    itemId,
    callId,
    method,
    kind,
    params,
    createdAtMs: nowMs,
  };
}

export function buildServerRequestEnvelope(record) {
  return {
    jsonrpc: "2.0",
    id: record.id,
    method: record.method,
    params: record.params,
  };
}

function isDynamicToolAvailable(thread, toolName) {
  return buildDynamicToolDefinitions(thread).some((tool) => tool.name === toolName);
}

function toolNameFromItem(item) {
  if (typeof item?.tool === "string" && item.tool) {
    return item.tool;
  }
  if (typeof item?.toolName === "string" && item.toolName) {
    return item.toolName;
  }
  return null;
}

function jsonOutput(value) {
  return JSON.stringify(value, null, 2);
}

function buildExecToolOutput({
  outputText,
  durationMs = null,
  exitCode = null,
  sessionId = null,
  originalTokenCount = null,
  driver = null,
} = {}) {
  const payload = {
    wall_time_seconds: Number.isFinite(durationMs) ? durationMs / 1000 : 0,
    output: typeof outputText === "string" ? outputText : "",
  };

  if (Number.isFinite(exitCode)) {
    payload.exit_code = exitCode;
  }
  if (Number.isFinite(sessionId)) {
    payload.session_id = sessionId;
  }
  if (Number.isFinite(originalTokenCount)) {
    payload.original_token_count = originalTokenCount;
  }
  if (typeof driver === "string" && driver) {
    payload.driver = driver;
  }

  return payload;
}

function immediateToolResult(callId, outputValue, {
  success = true,
  status = success ? "completed" : "failed",
  contentItems = null,
  answers = null,
} = {}) {
  const outputText = typeof outputValue === "string" ? outputValue : jsonOutput(outputValue);
  return {
    kind: "immediate",
    result: {
      status,
      success,
      contentItems,
      answers,
      outputText,
      nextInputItem: {
        type: "function_call_output",
        call_id: callId,
        output: outputText,
      },
    },
  };
}

async function runBuiltInToolCall({
  thread,
  item,
  workspaceStore,
  sandboxBroker,
  resolveExecSession = () => null,
}) {
  if (item.type === "commandExecution") {
    if (!sandboxBroker) {
      return {
        kind: "immediate",
        result: {
          status: "failed",
          outputText: "Command execution is not configured on this deployment.",
          exitCode: null,
          processId: null,
          durationMs: null,
          nextInputItem: {
            type: "function_call_output",
            call_id: item.callId,
            output: "Command execution is not configured on this deployment.",
          },
        },
      };
    }

    const request = item.request ?? {};
    const result = await sandboxBroker.executeCommand(thread, {
      command: typeof request.cmd === "string" ? request.cmd : item.command,
      cwd: typeof request.workdir === "string" && request.workdir ? request.workdir : item.cwd,
      tty: Boolean(request.tty),
      timeoutMs: Number.isFinite(request.yield_time_ms) ? request.yield_time_ms : null,
      maxOutputTokens: Number.isFinite(request.max_output_tokens) ? request.max_output_tokens : null,
      shell: typeof request.shell === "string" && request.shell ? request.shell : undefined,
    });
    const toolPayload = buildExecToolOutput({
      outputText: result.outputText,
      durationMs: result.durationMs,
      exitCode: result.sessionOpen ? null : result.exitCode,
      sessionId: result.sessionOpen ? result.sessionId : null,
      originalTokenCount: result.originalTokenCount ?? null,
      driver: result.driver ?? null,
    });

    return {
      kind: "immediate",
      result: {
        status:
          result.sessionOpen
            ? "inProgress"
            : result.infrastructureError
              ? "failed"
              : "completed",
        outputText: result.outputText,
        toolOutputText: jsonOutput(toolPayload),
        exitCode: result.exitCode,
        processId: result.processId ?? null,
        durationMs: result.durationMs ?? null,
        sessionId: result.sessionId ?? null,
        sandboxSessionId: result.sandboxSessionId ?? null,
        sandboxId: result.sandboxId ?? null,
        marker: result.marker ?? null,
        sessionOpen: Boolean(result.sessionOpen),
        driver: result.driver ?? null,
        nextInputItem: {
          type: "function_call_output",
          call_id: item.callId,
          output: jsonOutput(toolPayload),
        },
      },
    };
  }

  if (item.type === "functionToolCall" && item.kind === "writeStdin") {
    if (!sandboxBroker) {
      const outputText = "Command execution is not configured on this deployment.";
      return immediateToolResult(item.callId, outputText, {
        success: false,
        status: "failed",
      });
    }

    const requestedSessionId = Number(item.arguments?.session_id);
    if (!Number.isFinite(requestedSessionId)) {
      const outputText = "write_stdin requires a numeric session_id";
      return immediateToolResult(item.callId, outputText, {
        success: false,
        status: "failed",
      });
    }

    const execSession = resolveExecSession(requestedSessionId);
    if (!execSession) {
      const outputText = `Unknown process id ${requestedSessionId}`;
      return immediateToolResult(item.callId, outputText, {
        success: false,
        status: "failed",
      });
    }
    if (execSession.status !== "running") {
      const outputText = "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
      return immediateToolResult(item.callId, outputText, {
        success: false,
        status: "failed",
      });
    }

    const chars = typeof item.arguments?.chars === "string" ? item.arguments.chars : "";
    const result = await sandboxBroker.writeStdin(thread, execSession, {
      chars,
      timeoutMs: Number.isFinite(item.arguments?.yield_time_ms) ? item.arguments.yield_time_ms : null,
      maxOutputTokens: Number.isFinite(item.arguments?.max_output_tokens)
        ? item.arguments.max_output_tokens
        : null,
    });
    const toolPayload = buildExecToolOutput({
      outputText: result.outputText,
      durationMs: result.durationMs,
      exitCode: result.sessionOpen ? null : result.exitCode,
      sessionId: result.sessionOpen ? requestedSessionId : null,
      originalTokenCount: result.originalTokenCount ?? null,
      driver: result.driver ?? null,
    });

    return {
      kind: "immediate",
      result: {
        status: result.infrastructureError ? "failed" : "completed",
        outputText: result.outputText,
        toolOutputText: jsonOutput(toolPayload),
        durationMs: result.durationMs ?? null,
        terminalInteraction: chars
          ? {
              processId: String(requestedSessionId),
              stdin: chars,
            }
          : null,
        commandUpdate: {
          sessionId: requestedSessionId,
          outputText: result.outputText,
          durationMs: result.durationMs ?? null,
          exitCode: result.exitCode,
          processId: String(requestedSessionId),
          status:
            result.sessionOpen
              ? "inProgress"
              : result.infrastructureError
                ? "failed"
                : "completed",
          driver: result.driver ?? execSession.driver ?? null,
          sandboxSessionId: result.sandboxSessionId ?? execSession.sandboxSessionId ?? null,
          sandboxId: result.sandboxId ?? execSession.sandboxId ?? null,
          marker: result.marker ?? execSession.marker ?? null,
          sessionOpen: Boolean(result.sessionOpen),
        },
        nextInputItem: {
          type: "function_call_output",
          call_id: item.callId,
          output: jsonOutput(toolPayload),
        },
      },
    };
  }

  if (item.type === "fileChange") {
    const result = await applyPatchToWorkspace({
      thread,
      patchText: item.patch,
      workspaceStore,
    });
    return {
      kind: "immediate",
      result: {
        status: "completed",
        outputText: result.outputText,
        changes: result.changes,
        nextInputItem: {
          type: "function_call_output",
          call_id: item.callId,
          output: result.outputText,
        },
      },
    };
  }

  return null;
}

export async function startToolCall({
  thread,
  threadId,
  turnId,
  item,
  requestId,
  nowMs,
  workspaceStore,
  sandboxBroker = null,
  resolveExecSession = () => null,
}) {
  if (item.type === "toolRequestUserInput") {
    return {
      kind: "external",
      requestRecord: buildExternalRequestRecord({
        id: requestId,
        threadId,
        turnId,
        itemId: item.id,
        callId: item.callId,
        method: "item/tool/requestUserInput",
        kind: "requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: item.id,
          questions: item.questions,
        },
        nowMs,
      }),
    };
  }

  const builtInResult = await runBuiltInToolCall({
    thread,
    item,
    workspaceStore,
    sandboxBroker,
    resolveExecSession,
  });
  if (builtInResult) {
    return builtInResult;
  }

  if (item.type === "dynamicToolCall") {
    if (!isDynamicToolAvailable(thread, item.tool)) {
      return {
        kind: "immediate",
        result: {
          status: "failed",
          outputText: `Dynamic tool ${item.tool} is not registered on this thread.`,
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Dynamic tool ${item.tool} is not registered on this thread.`,
            },
          ],
          nextInputItem: {
            type: "function_call_output",
            call_id: item.callId,
            output: `Dynamic tool ${item.tool} is not registered on this thread.`,
          },
        },
      };
    }

    return {
      kind: "external",
      requestRecord: buildExternalRequestRecord({
        id: requestId,
        threadId,
        turnId,
        itemId: item.id,
        callId: item.callId,
        method: "item/tool/call",
        kind: "dynamicTool",
        params: {
          threadId,
          turnId,
          callId: item.callId,
          tool: item.tool,
          arguments: item.arguments ?? {},
        },
        nowMs,
      }),
    };
  }

  return {
    kind: "immediate",
    result: {
      status: "failed",
      outputText: `Unsupported tool call item type: ${item.type}`,
      nextInputItem: {
        type: "function_call_output",
        call_id: item.callId,
        output: `Unsupported tool call item type: ${item.type}`,
      },
    },
  };
}

export function resolveServerRequestResponse(record, message) {
  if (record.kind === "dynamicTool") {
    if (message?.error) {
      const outputText = message.error.message || "Dynamic tool call failed";
      return {
        status: "failed",
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: outputText,
          },
        ],
        outputText,
        nextInputItem: {
          type: "function_call_output",
          call_id: record.callId,
          output: outputText,
        },
      };
    }

    const normalized = validateDynamicToolResult(message?.result);
    return {
      status: normalized.success ? "completed" : "failed",
      success: normalized.success,
      contentItems: normalized.contentItems,
      outputText: normalized.outputText,
      nextInputItem: {
        type: "function_call_output",
        call_id: record.callId,
        output: normalized.outputText,
      },
    };
  }

  if (record.kind === "requestUserInput") {
    if (message?.error) {
      const outputText = message.error.message || "request_user_input failed";
      return {
        status: "failed",
        answers: {},
        outputText,
        nextInputItem: {
          type: "function_call_output",
          call_id: record.callId,
          output: outputText,
        },
      };
    }

    const normalized = validateRequestUserInputResult(message?.result);
    return {
      status: "completed",
      answers: normalized.answers,
      outputText: normalized.outputText,
      nextInputItem: {
        type: "function_call_output",
        call_id: record.callId,
        output: normalized.outputText,
      },
    };
  }

  const outputText = `Unsupported pending request kind: ${record.kind}`;
  return {
    status: "failed",
    outputText,
    nextInputItem: {
      type: "function_call_output",
      call_id: record.callId,
      output: outputText,
    },
  };
}
