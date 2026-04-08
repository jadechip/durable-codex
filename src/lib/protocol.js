import { previewFromInput } from "./user-input.js";

export const APP_NAME = "durable-codex";
export const APP_VERSION = "0.1.0";
export const APP_CLI_VERSION = `${APP_NAME}/${APP_VERSION}`;
export const DEFAULT_CODEX_HOME = "/worker-codex";
export const DEFAULT_PLATFORM_FAMILY = "unix";
export const DEFAULT_PLATFORM_OS = "linux";

export const DEFAULT_APPROVAL_POLICY = "never";
export const DEFAULT_APPROVALS_REVIEWER = "user";
export const DEFAULT_SANDBOX_POLICY = {
  type: "externalSandbox",
  networkAccess: "enabled",
};

export function unixTimestampSeconds(nowMs) {
  return Math.floor(nowMs / 1000);
}

export function idleThreadStatus() {
  return { type: "idle" };
}

export function activeThreadStatus() {
  return { type: "active", activeFlags: [] };
}

export function systemErrorThreadStatus() {
  return { type: "systemError" };
}

export function createTurnRunnerState() {
  return {
    phase: "queued",
    started: false,
    cycle: 0,
    lastResponseId: null,
    pendingInputs: [],
    pendingServerRequestIds: [],
    startedItemIds: [],
    completedItemIds: [],
    nextExecSessionId: 1,
    execSessions: {},
    historyCommitted: false,
  };
}

export function createThreadRecord({
  id,
  nowMs,
  model,
  modelProvider,
  cwd,
  workspaceId = null,
  workspace = null,
  serviceTier = null,
  approvalPolicy = DEFAULT_APPROVAL_POLICY,
  approvalsReviewer = DEFAULT_APPROVALS_REVIEWER,
  sandbox = DEFAULT_SANDBOX_POLICY,
  reasoningEffort = null,
  baseInstructions = null,
  developerInstructions = null,
  userInstructions = null,
  personality = null,
  collaborationMode = null,
  ephemeral = false,
  dynamicTools = [],
  allowRequestUserInputTool = false,
  currentDate = null,
  timezone = null,
  shell = "zsh",
  firstInput = [],
}) {
  const now = unixTimestampSeconds(nowMs);

  return {
    id,
    preview: previewFromInput(firstInput),
    ephemeral: Boolean(ephemeral),
    modelProvider,
    createdAt: now,
    updatedAt: now,
    status: idleThreadStatus(),
    path: null,
    cwd,
    workspaceId: typeof workspaceId === "string" && workspaceId ? workspaceId : "default",
    workspace: workspace ? structuredClone(workspace) : null,
    cliVersion: APP_CLI_VERSION,
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    model,
    serviceTier,
    approvalPolicy,
    approvalsReviewer,
    sandbox,
    reasoningEffort,
    baseInstructions,
    developerInstructions,
    userInstructions,
    personality,
    collaborationMode,
    dynamicTools,
    allowRequestUserInputTool,
    currentDate,
    timezone,
    shell,
    historyItems: [],
    referenceContext: null,
    previousTurnSettings: null,
    idlePendingInputs: [],
  };
}

export function createTurnRecord(id) {
  return {
    id,
    items: [],
    status: "inProgress",
    error: null,
    runner: createTurnRunnerState(),
    context: null,
  };
}

export function createUserMessageItem(id, input) {
  return {
    type: "userMessage",
    id,
    content: input,
  };
}

export function createAgentMessageItem(id, text = "") {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

export function createReasoningItem(id) {
  return {
    type: "reasoning",
    id,
    summary: [],
    content: [],
  };
}

function classifyCommandActions(command) {
  const value = typeof command === "string" ? command.trim() : "";
  if (!value) {
    return [
      {
        type: "unknown",
        command: "",
      },
    ];
  }

  if (/^(cat|head|tail|sed\b.*-n|wc)\b/.test(value)) {
    const parts = value.split(/\s+/);
    const path = parts.at(-1) ?? null;
    return [
      {
        type: "read",
        command: value,
        name: parts[0],
        path: typeof path === "string" ? path : null,
      },
    ];
  }

  if (/^(ls|find)\b/.test(value)) {
    return [
      {
        type: "listFiles",
        command: value,
        path: null,
      },
    ];
  }

  if (/^(rg|grep)\b/.test(value)) {
    return [
      {
        type: "search",
        command: value,
        query: null,
        path: null,
      },
    ];
  }

  return [
    {
      type: "unknown",
      command: value,
    },
  ];
}

export function createCommandExecutionItem(id, callId, argumentsValue = {}) {
  const command = typeof argumentsValue?.cmd === "string" ? argumentsValue.cmd : "";
  const cwd = typeof argumentsValue?.workdir === "string" && argumentsValue.workdir
    ? argumentsValue.workdir
    : "";

  return {
    type: "commandExecution",
    id,
    callId,
    command,
    cwd,
    driver: null,
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: classifyCommandActions(command),
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    sessionId: null,
    request: structuredClone(argumentsValue ?? {}),
  };
}

export function createFileChangeItem(id, callId, argumentsValue = {}) {
  return {
    type: "fileChange",
    id,
    callId,
    changes: [],
    status: "inProgress",
    patch: typeof argumentsValue?.input === "string" ? argumentsValue.input : "",
    output: null,
  };
}

export function createFunctionToolCallItem(id, callId, toolName, argumentsValue, kind = "dynamic") {
  const base = {
    id,
    callId,
    status: "inProgress",
    durationMs: null,
  };

  if (kind === "dynamic") {
    return {
      ...base,
      type: "dynamicToolCall",
      tool: toolName,
      arguments: argumentsValue,
      contentItems: [],
      success: null,
      output: null,
    };
  }

  if (kind === "requestUserInput") {
    return {
      ...base,
      type: "toolRequestUserInput",
      questions: Array.isArray(argumentsValue?.questions) ? argumentsValue.questions : [],
      answers: null,
      output: null,
    };
  }

  return {
    ...base,
    type: "functionToolCall",
    toolName,
    kind,
    arguments: argumentsValue,
    output: null,
    success: null,
  };
}

export function createTurnError(message) {
  return {
    message,
    codexErrorInfo: null,
    additionalDetails: null,
  };
}

export function ensureTurnRunnerState(turn) {
  if (!turn.runner || typeof turn.runner !== "object" || Array.isArray(turn.runner)) {
    turn.runner = createTurnRunnerState();
    return turn.runner;
  }

  if (!Array.isArray(turn.runner.pendingInputs)) {
    turn.runner.pendingInputs = [];
  }
  if (!Array.isArray(turn.runner.pendingServerRequestIds)) {
    turn.runner.pendingServerRequestIds = [];
  }
  if (!Array.isArray(turn.runner.startedItemIds)) {
    turn.runner.startedItemIds = [];
  }
  if (!Array.isArray(turn.runner.completedItemIds)) {
    turn.runner.completedItemIds = [];
  }
  if (
    !turn.runner.execSessions ||
    typeof turn.runner.execSessions !== "object" ||
    Array.isArray(turn.runner.execSessions)
  ) {
    turn.runner.execSessions = {};
  }
  if (
    typeof turn.runner.nextExecSessionId !== "number" ||
    !Number.isFinite(turn.runner.nextExecSessionId) ||
    turn.runner.nextExecSessionId < 1
  ) {
    turn.runner.nextExecSessionId = 1;
  }
  if (typeof turn.runner.historyCommitted !== "boolean") {
    turn.runner.historyCommitted = false;
  }
  if (typeof turn.runner.phase !== "string" || !turn.runner.phase) {
    turn.runner.phase = "queued";
  }
  if (typeof turn.runner.started !== "boolean") {
    turn.runner.started = false;
  }
  if (typeof turn.runner.cycle !== "number" || !Number.isFinite(turn.runner.cycle)) {
    turn.runner.cycle = 0;
  }
  if (turn.runner.lastResponseId !== null && typeof turn.runner.lastResponseId !== "string") {
    turn.runner.lastResponseId = null;
  }
  if (!turn.context || typeof turn.context !== "object" || Array.isArray(turn.context)) {
    turn.context = null;
  }

  return turn.runner;
}

export function serializeTurn(turn, { includeItems = false } = {}) {
  return {
    id: turn.id,
    items: includeItems ? structuredClone(turn.items) : [],
    status: turn.status,
    error: turn.error,
  };
}

export function serializeThread(thread, { includeTurns = false } = {}) {
  return {
    id: thread.id,
    preview: thread.preview,
    ephemeral: thread.ephemeral,
    modelProvider: thread.modelProvider,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: structuredClone(thread.status),
    path: thread.path,
    cwd: thread.cwd,
    workspaceId: thread.workspaceId,
    workspace: thread.workspace ? structuredClone(thread.workspace) : null,
    cliVersion: thread.cliVersion,
    source: thread.source,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    gitInfo: thread.gitInfo,
    name: thread.name,
    turns: includeTurns ? thread.turns.map((turn) => serializeTurn(turn, { includeItems: true })) : [],
  };
}

export function buildThreadResponse(thread, { includeTurns = false } = {}) {
  return {
    thread: serializeThread(thread, { includeTurns }),
    model: thread.model,
    modelProvider: thread.modelProvider,
    serviceTier: thread.serviceTier,
    cwd: thread.cwd,
    workspaceId: thread.workspaceId,
    workspace: thread.workspace ? structuredClone(thread.workspace) : null,
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: thread.approvalsReviewer,
    sandbox: structuredClone(thread.sandbox),
    reasoningEffort: thread.reasoningEffort,
  };
}

export function splitTextIntoDeltas(text, maxChunkLength = 32) {
  if (!text) {
    return [];
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxChunkLength));
    cursor += maxChunkLength;
  }
  return chunks;
}
