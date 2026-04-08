import { errorResponse, isRequest, JSONRPC_ERROR, notification, resultResponse } from "./jsonrpc.js";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_APPROVALS_REVIEWER,
  DEFAULT_CODEX_HOME,
  DEFAULT_PLATFORM_FAMILY,
  DEFAULT_PLATFORM_OS,
  DEFAULT_SANDBOX_POLICY,
  activeThreadStatus,
  APP_NAME,
  APP_VERSION,
  buildThreadResponse,
  createAgentMessageItem,
  createCommandExecutionItem,
  createFileChangeItem,
  createFunctionToolCallItem,
  createReasoningItem,
  createThreadRecord,
  createTurnError,
  createTurnRecord,
  createUserMessageItem,
  ensureTurnRunnerState,
  idleThreadStatus,
  serializeTurn,
  splitTextIntoDeltas,
  systemErrorThreadStatus,
} from "./protocol.js";
import { buildHistoryInput, buildUserMessageInput } from "./context-builder.js";
import { resolveModelBaseInstructions } from "./model-catalog.js";
import { normalizeUserInput, previewFromInput } from "./user-input.js";
import { parseOutputItem } from "./tool-router.js";
import {
  buildServerRequestEnvelope,
  buildThreadToolDefinitions,
  APPLY_PATCH_TOOL_NAME,
  EXEC_COMMAND_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  WRITE_STDIN_TOOL_NAME,
  resolveServerRequestResponse,
  startToolCall,
} from "./tool-runtime.js";
import {
  buildContextUpdateMessages,
  buildInitialContextMessages,
  createTurnContext,
} from "./turn-context.js";
import { previewText } from "./trace.js";
import { createWorkspaceStore, invalidateWorkspaceHydration } from "./vfs-store.js";

const STATE_VERSION = 5;
const DEFAULT_MODEL_PROVIDER = "openai";

function initialState() {
  return {
    version: STATE_VERSION,
    threads: {},
    pendingServerRequests: {},
  };
}

function ensureObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function resolveSandboxPolicy(sandboxMode) {
  switch (sandboxMode) {
    case "read-only":
      return {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: [],
        },
        networkAccess: false,
      };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        readOnlyAccess: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: [],
        },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
      return {
        type: "dangerFullAccess",
      };
    default:
      return DEFAULT_SANDBOX_POLICY;
  }
}

function isAbortError(error) {
  if (!error) {
    return false;
  }

  return error.name === "AbortError" || error.code === 20;
}

function runningTurnKey(threadId, turnId) {
  return `${threadId}:${turnId}`;
}

function createNotificationError(message) {
  return {
    error: createTurnError(message),
  };
}

function normalizeModelProvider(value) {
  if (typeof value !== "string") {
    return DEFAULT_MODEL_PROVIDER;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || DEFAULT_MODEL_PROVIDER;
}

function removeFromArray(values, target) {
  return values.filter((value) => value !== target);
}

export class AppServerSessionEngine {
  constructor({
    loadState,
    saveState,
    modelClient,
    workspaceStore = createWorkspaceStore(),
    sandboxBroker = null,
    notify,
    defaultModel = "gpt-5.3-codex",
    defaultModelProvider = DEFAULT_MODEL_PROVIDER,
    defaultModelByProvider = null,
    trace = () => {},
    now = () => Date.now(),
    createId = (prefix) => `${prefix}_${crypto.randomUUID()}`,
  }) {
    this.loadState = loadState;
    this.saveState = saveState;
    this.modelClient = modelClient;
    this.workspaceStore = workspaceStore;
    this.sandboxBroker = sandboxBroker;
    this.notify = notify;
    this.defaultModel = defaultModel;
    this.defaultModelProvider = normalizeModelProvider(defaultModelProvider);
    this.defaultModelByProvider = defaultModelByProvider && typeof defaultModelByProvider === "object"
      ? defaultModelByProvider
      : null;
    this.trace = trace;
    this.now = now;
    this.createId = createId;
    this.state = null;
    this.backgroundTasks = new Set();
    this.runningTurns = new Map();
  }

  resolveBaseInstructions(thread) {
    if (typeof thread.baseInstructions === "string" && thread.baseInstructions) {
      return thread.baseInstructions;
    }

    return resolveModelBaseInstructions(thread.model, thread.personality) ?? null;
  }

  resolveDefaultBaseInstructions(thread) {
    return resolveModelBaseInstructions(thread.model, null) ?? null;
  }

  resolvePersonalityMessage(thread) {
    if (!thread.personality) {
      return null;
    }

    const base = this.resolveBaseInstructions(thread);
    const defaultBase = this.resolveDefaultBaseInstructions(thread);
    if (!thread.baseInstructions && base && base !== defaultBase) {
      return null;
    }

    if (thread.baseInstructions) {
      const personalityBase = resolveModelBaseInstructions(thread.model, thread.personality);
      if (typeof personalityBase === "string" && personalityBase === thread.baseInstructions) {
        return null;
      }
    }

    return `Use the configured ${String(thread.personality)} personality style.`;
  }

  ensureThreadState(thread) {
    let mutated = false;

    if (!Array.isArray(thread.historyItems)) {
      thread.historyItems = buildHistoryInput(thread);
      mutated = true;
    }
    if (!thread.referenceContext || typeof thread.referenceContext !== "object" || Array.isArray(thread.referenceContext)) {
      thread.referenceContext = null;
      mutated = true;
    }
    if (!thread.previousTurnSettings || typeof thread.previousTurnSettings !== "object" || Array.isArray(thread.previousTurnSettings)) {
      thread.previousTurnSettings = null;
      mutated = true;
    }
    if (!Array.isArray(thread.idlePendingInputs)) {
      thread.idlePendingInputs = [];
      mutated = true;
    }
    if (typeof thread.workspaceId !== "string" || !thread.workspaceId) {
      thread.workspaceId = thread.workspace?.id ?? "default";
      mutated = true;
    }
    if (thread.workspace !== null && (typeof thread.workspace !== "object" || Array.isArray(thread.workspace))) {
      thread.workspace = null;
      mutated = true;
    }
    if (thread.userInstructions !== null && typeof thread.userInstructions !== "string") {
      thread.userInstructions = null;
      mutated = true;
    }
    if (thread.collaborationMode !== null && (typeof thread.collaborationMode !== "object" || Array.isArray(thread.collaborationMode))) {
      thread.collaborationMode = null;
      mutated = true;
    }
    if (thread.currentDate !== null && typeof thread.currentDate !== "string") {
      thread.currentDate = null;
      mutated = true;
    }
    if (thread.timezone !== null && typeof thread.timezone !== "string") {
      thread.timezone = null;
      mutated = true;
    }
    if (typeof thread.shell !== "string" || !thread.shell) {
      thread.shell = "zsh";
      mutated = true;
    }

    return mutated;
  }

  async ensureState() {
    if (this.state) {
      return this.state;
    }

    const loaded = (await this.loadState()) ?? initialState();
    this.state = ensureObject(loaded, "Persisted session state is invalid");
    if (!this.state.threads || typeof this.state.threads !== "object") {
      this.state.threads = {};
    }
    if (!this.state.pendingServerRequests || typeof this.state.pendingServerRequests !== "object") {
      this.state.pendingServerRequests = {};
    }

    let mutated = false;
    if (this.state.version !== STATE_VERSION) {
      this.state.version = STATE_VERSION;
      mutated = true;
    }

    for (const thread of Object.values(this.state.threads)) {
      if (!thread || typeof thread !== "object") {
        continue;
      }

      if (this.ensureThreadState(thread)) {
        mutated = true;
      }

      let activeTurn = null;
      for (const turn of thread.turns ?? []) {
        const runner = ensureTurnRunnerState(turn);

        if (turn.status !== "inProgress") {
          continue;
        }

        activeTurn = turn;
        if (runner.phase === "waitingExternal" && runner.pendingServerRequestIds.length > 0) {
          thread.status = activeThreadStatus();
          continue;
        }

        turn.status = "failed";
        turn.error = createTurnError("Worker restarted while the turn was still running");
        runner.phase = "failed";
        thread.status = systemErrorThreadStatus();
        mutated = true;
      }

      if (!activeTurn && thread.status?.type === "active") {
        thread.status = idleThreadStatus();
        mutated = true;
      }
    }

    if (mutated) {
      await this.persist();
    }

    return this.state;
  }

  async persist() {
    await this.saveState(this.state);
  }

  spawnBackground(promise) {
    this.backgroundTasks.add(promise);
    promise.catch(() => {}).finally(() => {
      this.backgroundTasks.delete(promise);
    });
  }

  async waitForIdle() {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundTasks));
    }
  }

  async handleRpc(message, connectionState) {
    await this.ensureState();

    const method = typeof message?.method === "string" ? message.method : null;
    const id = Object.prototype.hasOwnProperty.call(message ?? {}, "id") ? message.id : null;
    this.trace("rpc.handle", {
      method,
      id,
      phase: connectionState?.phase ?? null,
      hasResult: Object.prototype.hasOwnProperty.call(message ?? {}, "result"),
      hasError: Object.prototype.hasOwnProperty.call(message ?? {}, "error"),
    });

    if (!method && id !== null && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      await this.handleServerRequestResponse(message);
      return null;
    }

    if (!method) {
      return errorResponse(id, JSONRPC_ERROR.INVALID_REQUEST, "Missing JSON-RPC method");
    }

    if (method === "initialize") {
      return this.handleInitialize(message, connectionState);
    }

    if (method === "initialized") {
      if (connectionState.phase === "awaiting_initialized") {
        connectionState.phase = "ready";
      }
      await this.replayPendingServerRequests();
      return null;
    }

    if (connectionState.phase === "uninitialized") {
      return isRequest(message)
        ? errorResponse(id, JSONRPC_ERROR.SERVER_ERROR, "Not initialized")
        : null;
    }

    if (connectionState.phase === "awaiting_initialized") {
      return isRequest(message)
        ? errorResponse(id, JSONRPC_ERROR.SERVER_ERROR, "Client must send initialized notification before using other methods")
        : null;
    }

    try {
      switch (method) {
        case "thread/start":
          return await this.handleThreadStart(message, connectionState);
        case "thread/resume":
          return await this.handleThreadResume(message);
        case "thread/read":
          return await this.handleThreadRead(message);
        case "workspace/read":
          return await this.handleWorkspaceRead(message);
        case "workspace/list":
          return await this.handleWorkspaceList(message);
        case "workspace/readFile":
          return await this.handleWorkspaceReadFile(message);
        case "workspace/writeFile":
          return await this.handleWorkspaceWriteFile(message);
        case "workspace/deleteFile":
          return await this.handleWorkspaceDeleteFile(message);
        case "turn/start":
          return await this.handleTurnStart(message);
        case "turn/interrupt":
          return await this.handleTurnInterrupt(message);
        case "turn/steer":
          return await this.handleTurnSteer(message);
        default:
          return errorResponse(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (error) {
      return errorResponse(
        id,
        JSONRPC_ERROR.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  handleInitialize(message, connectionState) {
    const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;

    if (connectionState.phase !== "uninitialized") {
      return errorResponse(id, JSONRPC_ERROR.SERVER_ERROR, "Already initialized");
    }

    const params = ensureObject(message.params ?? {}, "initialize params must be an object");
    ensureObject(params.clientInfo, "initialize params.clientInfo must be an object");
    const capabilities = params.capabilities;

    connectionState.phase = "awaiting_initialized";
    connectionState.experimentalApi = Boolean(capabilities?.experimentalApi);
    connectionState.optOutNotificationMethods = Array.isArray(capabilities?.optOutNotificationMethods)
      ? capabilities.optOutNotificationMethods.filter((value) => typeof value === "string")
      : [];

    return resultResponse(id, {
      userAgent: `${APP_NAME}/${APP_VERSION}`,
      codexHome: DEFAULT_CODEX_HOME,
      platformFamily: DEFAULT_PLATFORM_FAMILY,
      platformOs: DEFAULT_PLATFORM_OS,
    });
  }

  getThreadById(threadId) {
    const thread = this.state.threads[threadId];
    if (!thread) {
      throw new Error(`thread ${threadId} was not found`);
    }
    this.ensureThreadState(thread);
    return thread;
  }

  getTurnById(thread, turnId) {
    const turn = (thread.turns ?? []).find((entry) => entry.id === turnId);
    if (!turn) {
      throw new Error(`turn ${turnId} was not found`);
    }
    return turn;
  }

  getActiveTurn(thread) {
    return (thread.turns ?? []).find((turn) => turn.status === "inProgress") ?? null;
  }

  findPendingServerRequest(requestId) {
    const record = this.state.pendingServerRequests?.[requestId];
    return record && typeof record === "object" ? record : null;
  }

  async replayPendingServerRequests() {
    for (const record of Object.values(this.state.pendingServerRequests)) {
      if (!record || typeof record !== "object") {
        continue;
      }
      this.notify(buildServerRequestEnvelope(record));
    }
  }

  appendThreadHistoryItem(thread, inputItem) {
    if (!inputItem || typeof inputItem !== "object") {
      return;
    }

    if (!Array.isArray(thread.historyItems)) {
      thread.historyItems = [];
    }

    const nextItem = structuredClone(inputItem);
    if (nextItem.type === "function_call") {
      const exists = thread.historyItems.some(
        (item) => item?.type === "function_call" && item.call_id === nextItem.call_id,
      );
      if (exists) {
        return;
      }
    }

    if (nextItem.type === "function_call_output") {
      const exists = thread.historyItems.some(
        (item) => item?.type === "function_call_output" && item.call_id === nextItem.call_id,
      );
      if (exists) {
        return;
      }
    }

    thread.historyItems.push(nextItem);
  }

  async ensureWorkspace(thread) {
    if (!this.workspaceStore) {
      return thread.workspace ?? null;
    }

    const workspace = await this.workspaceStore.ensureWorkspace(thread);
    thread.workspace = structuredClone(workspace);
    if (!thread.path) {
      thread.path = workspace.root;
    }
    return thread.workspace;
  }

  buildCurrentTurnContext(thread, turn) {
    if (turn.context && typeof turn.context === "object" && !Array.isArray(turn.context)) {
      return turn.context;
    }

    const turnContext = createTurnContext(thread, {
      nowMs: this.now(),
    });
    turn.context = turnContext;
    return turnContext;
  }

  injectTurnContext(thread, turn) {
    const turnContext = this.buildCurrentTurnContext(thread, turn);
    const modelSwitchInstructions = this.resolveBaseInstructions(thread);
    const personalityMessage = this.resolvePersonalityMessage(thread);
    const contextItems = thread.referenceContext
      ? buildContextUpdateMessages({
          previousContext: thread.referenceContext,
          previousTurnSettings: thread.previousTurnSettings,
          turnContext,
          modelSwitchInstructions,
          personalityMessage,
        })
      : buildInitialContextMessages({
          referenceContext: thread.referenceContext,
          previousTurnSettings: thread.previousTurnSettings,
          turnContext,
          modelSwitchInstructions,
          personalityMessage,
        });

    for (const item of contextItems) {
      this.appendThreadHistoryItem(thread, item);
    }

    thread.referenceContext = structuredClone(turnContext);
    thread.previousTurnSettings = {
      model: turnContext.model,
      realtimeActive: turnContext.realtimeActive,
    };
  }

  buildDeveloperMessageInput(text) {
    if (typeof text !== "string" || !text) {
      return null;
    }

    return {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text,
        },
      ],
    };
  }

  createPendingInputRecord(kind, inputItem, meta = {}) {
    return {
      kind,
      inputItem,
      ...meta,
    };
  }

  prependPendingInputs(turn, entries) {
    const runner = ensureTurnRunnerState(turn);
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    runner.pendingInputs = [...entries, ...runner.pendingInputs];
  }

  takePendingInputs(turn) {
    const runner = ensureTurnRunnerState(turn);
    if (!Array.isArray(runner.pendingInputs) || runner.pendingInputs.length === 0) {
      return [];
    }

    const entries = runner.pendingInputs;
    runner.pendingInputs = [];
    return entries;
  }

  inspectPendingInputRecord(_thread, _turn, entry) {
    return {
      disposition: "accepted",
      entry,
      additionalContexts: [],
    };
  }

  recordPendingInput(thread, turn, entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const inputItem = entry.inputItem;
    if (!inputItem || typeof inputItem !== "object") {
      return null;
    }

    this.appendThreadHistoryItem(thread, inputItem);

    if (entry.kind === "userMessage" && entry.visibleItemId) {
      const item = (turn.items ?? []).find((turnItem) => turnItem.id === entry.visibleItemId);
      if (item) {
        this.markItemStarted(thread.id, turn.id, turn, item);
        this.markItemCompleted(thread.id, turn.id, turn, item);
      }
    }

    return structuredClone(inputItem);
  }

  drainAcceptedPendingInputs(thread, turn) {
    const pendingEntries = this.takePendingInputs(turn);
    if (pendingEntries.length === 0) {
      return {
        action: "run",
        acceptedInputs: [],
      };
    }

    const acceptedInputs = [];
    const additionalContexts = [];
    let blocked = false;
    let blockedTail = [];

    for (let index = 0; index < pendingEntries.length; index += 1) {
      const entry = pendingEntries[index];
      const inspected = this.inspectPendingInputRecord(thread, turn, entry);
      if (inspected.disposition === "accepted") {
        const recorded = this.recordPendingInput(thread, turn, inspected.entry);
        if (recorded) {
          acceptedInputs.push(recorded);
        }
        if (Array.isArray(inspected.additionalContexts)) {
          additionalContexts.push(...inspected.additionalContexts);
        }
      } else if (inspected.disposition === "blocked") {
        blocked = true;
        blockedTail = pendingEntries.slice(index + 1);
        if (Array.isArray(inspected.additionalContexts)) {
          additionalContexts.push(...inspected.additionalContexts);
        }
        break;
      }
    }

    const contextInputs = [];
    for (const contextText of additionalContexts) {
      const developerMessage = this.buildDeveloperMessageInput(contextText);
      if (developerMessage) {
        this.appendThreadHistoryItem(thread, developerMessage);
        contextInputs.push(structuredClone(developerMessage));
      }
    }

    if (blocked && acceptedInputs.length === 0) {
      if (blockedTail.length > 0) {
        const contextEntries = contextInputs.map((inputItem) => this.createPendingInputRecord(
          "conversationItem",
          inputItem,
        ));
        this.prependPendingInputs(turn, [...contextEntries, ...blockedTail]);
      }
      return {
        action: blockedTail.length > 0 ? "continue" : "stop",
        acceptedInputs: [],
      };
    }

    if (blockedTail.length > 0) {
      this.prependPendingInputs(turn, blockedTail);
    }

    return {
      action: "run",
      acceptedInputs: [...acceptedInputs, ...contextInputs],
    };
  }

  resolveModelProvider(rawProvider) {
    return normalizeModelProvider(rawProvider || this.defaultModelProvider);
  }

  resolveThreadModel(paramsModel, rawModelProvider) {
    if (typeof paramsModel === "string" && paramsModel.trim()) {
      return paramsModel.trim();
    }

    const provider = this.resolveModelProvider(rawModelProvider);
    const byProvider = this.defaultModelByProvider?.[provider];
    if (typeof byProvider === "string" && byProvider.trim()) {
      return byProvider.trim();
    }

    return this.defaultModel;
  }

  async handleThreadStart(message, connectionState) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "thread/start params must be an object");
    const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools : [];

    if (dynamicTools.length > 0 && !connectionState.experimentalApi) {
      throw new Error("thread/start dynamicTools requires initialize.params.capabilities.experimentalApi = true");
    }

    if (params.allowRequestUserInputTool && !connectionState.experimentalApi) {
      throw new Error("thread/start allowRequestUserInputTool requires initialize.params.capabilities.experimentalApi = true");
    }

    const firstInput = [];
    const nowMs = this.now();
    const threadId = this.createId("thr");
    const thread = createThreadRecord({
      id: threadId,
      nowMs,
      modelProvider: this.resolveModelProvider(params.modelProvider),
      model: this.resolveThreadModel(
        params.model,
        params.modelProvider,
      ),
      cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : "/workspace",
      workspaceId:
        typeof params.workspaceId === "string" && params.workspaceId
          ? params.workspaceId
          : params.workspace?.id,
      workspace:
        params.workspace && typeof params.workspace === "object" && !Array.isArray(params.workspace)
          ? structuredClone(params.workspace)
          : null,
      serviceTier: params.serviceTier ?? null,
      approvalPolicy: params.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: params.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: resolveSandboxPolicy(params.sandbox),
      reasoningEffort: params.config?.model_reasoning_effort ?? null,
      baseInstructions:
        typeof params.baseInstructions === "string" && params.baseInstructions
          ? params.baseInstructions
          : null,
      developerInstructions:
        typeof params.developerInstructions === "string" && params.developerInstructions
          ? params.developerInstructions
          : null,
      userInstructions:
        typeof params.userInstructions === "string" && params.userInstructions
          ? params.userInstructions
          : null,
      personality: params.personality ?? null,
      collaborationMode:
        params.collaborationMode && typeof params.collaborationMode === "object"
          ? structuredClone(params.collaborationMode)
          : null,
      ephemeral: params.ephemeral ?? false,
      dynamicTools,
      allowRequestUserInputTool: Boolean(params.allowRequestUserInputTool),
      currentDate: typeof params.currentDate === "string" && params.currentDate ? params.currentDate : null,
      timezone: typeof params.timezone === "string" && params.timezone ? params.timezone : null,
      shell: typeof params.shell === "string" && params.shell ? params.shell : "zsh",
      firstInput,
    });

    await this.ensureWorkspace(thread);
    this.state.threads[thread.id] = thread;
    await this.persist();
    this.trace("thread.start", {
      threadId: thread.id,
      workspaceId: thread.workspace?.id ?? thread.workspaceId,
      model: thread.model,
      cwd: thread.cwd,
    });

    this.notify(notification("thread/started", { thread: buildThreadResponse(thread).thread }));
    return resultResponse(id, buildThreadResponse(thread));
  }

  async handleThreadResume(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "thread/resume params must be an object");
    const thread = this.getThreadById(params.threadId);
    await this.ensureWorkspace(thread);
    await this.persist();
    return resultResponse(id, buildThreadResponse(thread, { includeTurns: true }));
  }

  async handleThreadRead(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "thread/read params must be an object");
    const thread = this.getThreadById(params.threadId);
    await this.ensureWorkspace(thread);
    await this.persist();
    return resultResponse(id, {
      thread: buildThreadResponse(thread, { includeTurns: Boolean(params.includeTurns) }).thread,
    });
  }

  async handleWorkspaceRead(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "workspace/read params must be an object");
    const thread = this.getThreadById(params.threadId);
    const workspace = await this.workspaceStore.readWorkspace(thread);
    thread.workspace = structuredClone(workspace);
    if (!thread.path) {
      thread.path = workspace.root;
    }
    await this.persist();
    return resultResponse(id, {
      threadId: thread.id,
      workspace: structuredClone(workspace),
    });
  }

  async handleWorkspaceList(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "workspace/list params must be an object");
    const thread = this.getThreadById(params.threadId);
    const result = await this.workspaceStore.listFiles(thread, params.path ?? null, {
      recursive: Boolean(params.recursive),
      limit: Number.isFinite(params.limit) ? params.limit : 200,
    });
    thread.workspace = structuredClone(result.workspace);
    if (!thread.path) {
      thread.path = result.workspace.root;
    }
    await this.persist();
    return resultResponse(id, {
      threadId: thread.id,
      workspace: structuredClone(result.workspace),
      path: result.path,
      recursive: result.recursive,
      entries: result.entries,
    });
  }

  async handleWorkspaceReadFile(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "workspace/readFile params must be an object");
    const thread = this.getThreadById(params.threadId);
    const result = await this.workspaceStore.readFile(thread, params.path);
    thread.workspace = structuredClone(result.workspace);
    if (!thread.path) {
      thread.path = result.workspace.root;
    }
    await this.persist();
    return resultResponse(id, {
      threadId: thread.id,
      workspace: structuredClone(result.workspace),
      file: result.file,
    });
  }

  async handleWorkspaceWriteFile(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "workspace/writeFile params must be an object");
    const thread = this.getThreadById(params.threadId);
    const result = await this.workspaceStore.writeFile(
      thread,
      params.path,
      typeof params.content === "string" ? params.content : "",
      typeof params.contentType === "string" && params.contentType ? params.contentType : null,
    );
    thread.workspace = structuredClone(invalidateWorkspaceHydration(result.workspace));
    if (!thread.path) {
      thread.path = result.workspace.root;
    }
    thread.updatedAt = Math.floor(this.now() / 1000);
    await this.persist();
    return resultResponse(id, {
      threadId: thread.id,
      workspace: structuredClone(result.workspace),
      file: result.file,
    });
  }

  async handleWorkspaceDeleteFile(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "workspace/deleteFile params must be an object");
    const thread = this.getThreadById(params.threadId);
    const result = await this.workspaceStore.deleteFile(thread, params.path, {
      recursive: Boolean(params.recursive),
    });
    thread.workspace = structuredClone(invalidateWorkspaceHydration(result.workspace));
    if (!thread.path) {
      thread.path = result.workspace.root;
    }
    thread.updatedAt = Math.floor(this.now() / 1000);
    await this.persist();
    return resultResponse(id, {
      threadId: thread.id,
      workspace: structuredClone(result.workspace),
      deleted: result.deleted,
    });
  }

  async handleTurnStart(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "turn/start params must be an object");
    const thread = this.getThreadById(params.threadId);

    if (thread.status?.type === "active") {
      throw new Error(`thread ${thread.id} already has a turn in progress`);
    }

    const input = normalizeUserInput(params.input);
    const turn = createTurnRecord(this.createId("turn"));
    const userItem = createUserMessageItem(this.createId("item"), input);
    const assistantItem = createAgentMessageItem(this.createId("item"));

    if (typeof params.cwd === "string" && params.cwd) {
      thread.cwd = params.cwd;
    }
    if (typeof params.model === "string" && params.model) {
      thread.model = params.model;
    }
    if (params.serviceTier !== undefined) {
      thread.serviceTier = params.serviceTier;
    }

    await this.ensureWorkspace(thread);
    turn.items.push(userItem, assistantItem);
    turn.context = createTurnContext(thread, {
      nowMs: this.now(),
    });

    if (Array.isArray(thread.idlePendingInputs) && thread.idlePendingInputs.length > 0) {
      const runner = ensureTurnRunnerState(turn);
      runner.pendingInputs = [...thread.idlePendingInputs, ...runner.pendingInputs];
      thread.idlePendingInputs = [];
    }

    thread.turns.push(turn);
    this.injectTurnContext(thread, turn);
    this.appendThreadHistoryItem(thread, buildUserMessageInput(userItem));
    thread.updatedAt = Math.floor(this.now() / 1000);
    thread.status = activeThreadStatus();
    if (!thread.preview || thread.preview === "New thread") {
      thread.preview = previewFromInput(input);
    }

    await this.persist();
    this.trace("turn.start", {
      threadId: thread.id,
      turnId: turn.id,
      workspaceId: thread.workspace?.id ?? thread.workspaceId,
      model: thread.model,
      preview: previewFromInput(input),
    });

    this.spawnBackground(this.executeTurn(thread.id, turn.id));
    return resultResponse(id, {
      turn: serializeTurn(turn),
    });
  }

  async handleTurnSteer(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "turn/steer params must be an object");
    const thread = this.getThreadById(params.threadId);
    const turn = this.getTurnById(thread, params.turnId);
    const runner = ensureTurnRunnerState(turn);

    if (thread.status?.type !== "active" || turn.status !== "inProgress") {
      throw new Error(`turn ${turn.id} is not active`);
    }

    const input = normalizeUserInput(params.input);
    const userItem = createUserMessageItem(this.createId("item"), input);
    turn.items.push(userItem);
    runner.pendingInputs.push(this.createPendingInputRecord(
      "userMessage",
      buildUserMessageInput(userItem),
      { visibleItemId: userItem.id },
    ));
    thread.updatedAt = Math.floor(this.now() / 1000);

    await this.persist();
    this.trace("turn.steer", {
      threadId: thread.id,
      turnId: turn.id,
      preview: previewFromInput(input),
    });
    if (runner.phase === "waitingExternal" && runner.pendingServerRequestIds.length === 0) {
      runner.phase = "queued";
      await this.persist();
      this.spawnBackground(this.executeTurn(thread.id, turn.id));
    }

    return resultResponse(id, {
      turnId: turn.id,
    });
  }

  async handleTurnInterrupt(message) {
    const id = message.id;
    const params = ensureObject(message.params ?? {}, "turn/interrupt params must be an object");
    const thread = this.getThreadById(params.threadId);
    const turn = this.getTurnById(thread, params.turnId);
    const runner = ensureTurnRunnerState(turn);

    if (turn.status !== "inProgress") {
      throw new Error(`turn ${turn.id} is not active`);
    }

    runner.phase = "interrupted";
    this.trace("turn.interrupt", {
      threadId: thread.id,
      turnId: turn.id,
    });
    const controller = this.runningTurns.get(runningTurnKey(thread.id, turn.id));
    if (controller) {
      controller.abort();
    } else if (runner.pendingServerRequestIds.length > 0) {
      this.clearPendingServerRequests(thread.id, turn);
      await this.finalizeTurn(thread, turn, "interrupted");
    } else {
      await this.finalizeTurn(thread, turn, "interrupted");
    }

    return resultResponse(id, {});
  }

  async handleServerRequestResponse(message) {
    const record = this.findPendingServerRequest(message.id);
    if (!record) {
      return;
    }
    this.trace("server_request.response", {
      requestId: message.id,
      threadId: record.threadId ?? null,
      turnId: record.turnId ?? null,
      method: record.method ?? null,
      hasResult: Object.prototype.hasOwnProperty.call(message ?? {}, "result"),
      hasError: Object.prototype.hasOwnProperty.call(message ?? {}, "error"),
    });

    const thread = this.state.threads[record.threadId];
    if (!thread) {
      delete this.state.pendingServerRequests[record.id];
      await this.persist();
      return;
    }

    const turn = (thread.turns ?? []).find((entry) => entry.id === record.turnId);
    if (!turn) {
      delete this.state.pendingServerRequests[record.id];
      await this.persist();
      return;
    }

    const runner = ensureTurnRunnerState(turn);
    const item = (turn.items ?? []).find((entry) => entry.id === record.itemId);
    const resolved = resolveServerRequestResponse(record, message);
    const nowMs = this.now();

    delete this.state.pendingServerRequests[record.id];
    runner.pendingServerRequestIds = removeFromArray(runner.pendingServerRequestIds, record.id);

    if (item) {
      item.durationMs = Math.max(0, nowMs - (record.createdAtMs ?? nowMs));
      item.output = resolved.outputText ?? null;
      if (item.type === "dynamicToolCall") {
        item.contentItems = resolved.contentItems ?? [];
        item.success = resolved.success ?? false;
      }
      if (item.type === "toolRequestUserInput") {
        item.answers = resolved.answers ?? {};
      }
      item.status = resolved.status ?? "completed";
      this.markItemCompleted(thread.id, turn.id, turn, item);
    }

    if (resolved.nextInputItem) {
      runner.pendingInputs.push(this.createPendingInputRecord(
        "conversationItem",
        resolved.nextInputItem,
        { sourceItemId: item?.id ?? null },
      ));
    }

    this.notify(notification("serverRequest/resolved", {
      threadId: thread.id,
      requestId: record.id,
    }));

    thread.updatedAt = Math.floor(nowMs / 1000);
    await this.persist();

    if (turn.status !== "inProgress") {
      return;
    }

    if (runner.phase === "interrupted") {
      this.clearPendingServerRequests(thread.id, turn);
      await this.finalizeTurn(thread, turn, "interrupted");
      return;
    }

    if (runner.pendingServerRequestIds.length === 0) {
      runner.phase = "queued";
      await this.persist();
      this.spawnBackground(this.executeTurn(thread.id, turn.id));
    }
  }

  getAssistantItem(turn) {
    return (turn.items ?? []).find((item) => item.type === "agentMessage") ?? null;
  }

  getOrCreateReasoningItem(turn) {
    let item = (turn.items ?? []).find((entry) => entry.type === "reasoning") ?? null;
    if (item) {
      return item;
    }

    item = createReasoningItem(this.createId("item"));
    turn.items.push(item);
    return item;
  }

  markItemStarted(threadId, turnId, turn, item) {
    const runner = ensureTurnRunnerState(turn);
    if (runner.startedItemIds.includes(item.id)) {
      return;
    }
    runner.startedItemIds.push(item.id);
    this.notify(notification("item/started", {
      threadId,
      turnId,
      item: structuredClone(item),
    }));
  }

  markItemCompleted(threadId, turnId, turn, item) {
    const runner = ensureTurnRunnerState(turn);
    if (runner.completedItemIds.includes(item.id)) {
      return;
    }
    runner.completedItemIds.push(item.id);
    this.notify(notification("item/completed", {
      threadId,
      turnId,
      item: structuredClone(item),
    }));
  }

  ensureTurnStarted(threadId, turn) {
    const runner = ensureTurnRunnerState(turn);
    if (runner.started) {
      return;
    }

    runner.started = true;
    this.notify(notification("turn/started", {
      threadId,
      turn: serializeTurn(turn),
    }));

    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        this.markItemStarted(threadId, turn.id, turn, item);
        this.markItemCompleted(threadId, turn.id, turn, item);
      }
    }

    const assistantItem = this.getAssistantItem(turn);
    if (assistantItem) {
      this.markItemStarted(threadId, turn.id, turn, assistantItem);
    }
  }

  appendAssistantDelta(threadId, turnId, assistantItem, delta) {
    if (typeof delta !== "string" || !delta) {
      return;
    }

    assistantItem.text += delta;
    this.notify(notification("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: assistantItem.id,
      delta,
    }));
  }

  mergeAssistantText(threadId, turnId, assistantItem, text) {
    if (typeof text !== "string" || !text) {
      return;
    }

    if (!assistantItem.text) {
      this.appendAssistantDelta(threadId, turnId, assistantItem, text);
      return;
    }

    if (text === assistantItem.text) {
      return;
    }

    if (text.startsWith(assistantItem.text)) {
      this.appendAssistantDelta(threadId, turnId, assistantItem, text.slice(assistantItem.text.length));
    }
  }

  appendReasoningSummary(threadId, turnId, turn, delta, summaryIndex) {
    const reasoningItem = this.getOrCreateReasoningItem(turn);
    this.markItemStarted(threadId, turnId, turn, reasoningItem);

    while (reasoningItem.summary.length <= summaryIndex) {
      reasoningItem.summary.push("");
    }

    reasoningItem.summary[summaryIndex] += delta;
    this.notify(notification("item/reasoning/summaryTextDelta", {
      threadId,
      turnId,
      itemId: reasoningItem.id,
      summaryIndex,
      delta,
    }));
  }

  addReasoningSummaryPart(threadId, turnId, turn, summaryIndex) {
    const reasoningItem = this.getOrCreateReasoningItem(turn);
    this.markItemStarted(threadId, turnId, turn, reasoningItem);

    while (reasoningItem.summary.length <= summaryIndex) {
      reasoningItem.summary.push("");
    }

    this.notify(notification("item/reasoning/summaryPartAdded", {
      threadId,
      turnId,
      itemId: reasoningItem.id,
      summaryIndex,
    }));
  }

  appendReasoningText(threadId, turnId, turn, delta, contentIndex) {
    const reasoningItem = this.getOrCreateReasoningItem(turn);
    this.markItemStarted(threadId, turnId, turn, reasoningItem);

    while (reasoningItem.content.length <= contentIndex) {
      reasoningItem.content.push("");
    }

    reasoningItem.content[contentIndex] += delta;
    this.notify(notification("item/reasoning/textDelta", {
      threadId,
      turnId,
      itemId: reasoningItem.id,
      contentIndex,
      delta,
    }));
  }

  createToolCallItem(parsed) {
    if (!parsed.callId || !parsed.toolName) {
      return null;
    }

    if (parsed.toolName === EXEC_COMMAND_TOOL_NAME) {
      return createCommandExecutionItem(
        this.createId("item"),
        parsed.callId,
        parsed.argumentsValue ?? {},
      );
    }

    if (parsed.toolName === APPLY_PATCH_TOOL_NAME) {
      return createFileChangeItem(
        this.createId("item"),
        parsed.callId,
        parsed.argumentsValue ?? {},
      );
    }

    if (parsed.toolName === WRITE_STDIN_TOOL_NAME) {
      return createFunctionToolCallItem(
        this.createId("item"),
        parsed.callId,
        parsed.toolName,
        parsed.argumentsValue ?? {},
        "writeStdin",
      );
    }

    const kind = parsed.toolName === REQUEST_USER_INPUT_TOOL_NAME ? "requestUserInput" : "dynamic";
    return createFunctionToolCallItem(
      this.createId("item"),
      parsed.callId,
      parsed.toolName,
      parsed.argumentsValue ?? {},
      kind,
    );
  }

  buildCycleInput(thread, turn, runner) {
    if (typeof runner.lastResponseId === "string" && runner.lastResponseId) {
      return this.drainAcceptedPendingInputs(thread, turn);
    }

    return {
      action: "run",
      acceptedInputs: Array.isArray(thread.historyItems)
        ? thread.historyItems.map((item) => structuredClone(item))
        : buildHistoryInput(thread, {
            includeInProgressTurnId: turn.id,
          }),
    };
  }

  buildModelRequest(thread, _turn, runner, signal, input) {
    const tools = buildThreadToolDefinitions(thread);
    return {
      model: thread.model,
      modelProvider: thread.modelProvider,
      input,
      baseInstructions: this.resolveBaseInstructions(thread),
      tools,
      previousResponseId: runner.lastResponseId,
      toolChoice: tools.length > 0 ? "auto" : undefined,
      parallelToolCalls: false,
      signal,
    };
  }

  clearPendingServerRequests(threadId, turn) {
    const runner = ensureTurnRunnerState(turn);
    for (const requestId of [...runner.pendingServerRequestIds]) {
      delete this.state.pendingServerRequests[requestId];
      this.notify(notification("serverRequest/resolved", {
        threadId,
        requestId,
      }));
    }
    runner.pendingServerRequestIds = [];
  }

  allocateExecSession(turn, itemId, actualSession) {
    const runner = ensureTurnRunnerState(turn);
    const sessionId = runner.nextExecSessionId;
    runner.nextExecSessionId += 1;
    runner.execSessions[String(sessionId)] = {
      sessionId,
      itemId,
      driver: actualSession?.driver ?? null,
      processId: String(sessionId),
      sandboxSessionId: actualSession?.sandboxSessionId ?? null,
      sandboxId: actualSession?.sandboxId ?? null,
      marker: actualSession?.marker ?? null,
      startedAtMs: this.now(),
      status: "running",
    };
    return runner.execSessions[String(sessionId)];
  }

  getExecSession(turn, sessionId) {
    const runner = ensureTurnRunnerState(turn);
    if (!Number.isFinite(sessionId)) {
      return null;
    }
    return runner.execSessions[String(sessionId)] ?? null;
  }

  updateExecSession(turn, sessionId, updates = {}) {
    const runner = ensureTurnRunnerState(turn);
    const key = String(sessionId);
    const current = runner.execSessions[key];
    if (!current) {
      return null;
    }
    runner.execSessions[key] = {
      ...current,
      ...updates,
    };
    return runner.execSessions[key];
  }

  findItemById(turn, itemId) {
    return (turn.items ?? []).find((item) => item.id === itemId) ?? null;
  }

  appendCommandOutputDeltas(threadId, turnId, itemId, text) {
    for (const delta of splitTextIntoDeltas(text)) {
      this.notify(notification("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId,
        delta,
      }));
    }
  }

  notifyTerminalInteraction(threadId, turnId, itemId, processId, stdin) {
    this.notify(notification("item/commandExecution/terminalInteraction", {
      threadId,
      turnId,
      itemId,
      processId,
      stdin,
    }));
  }

  applyCommandUpdate(threadId, turnId, turn, commandUpdate) {
    if (!commandUpdate || typeof commandUpdate !== "object") {
      return;
    }

    const sessionId = Number(commandUpdate.sessionId);
    const execSession = this.getExecSession(turn, sessionId);
    const targetItem = execSession ? this.findItemById(turn, execSession.itemId) : null;
    if (!targetItem || targetItem.type !== "commandExecution") {
      return;
    }

    const nextOutput = typeof commandUpdate.outputText === "string" ? commandUpdate.outputText : "";
    if (nextOutput) {
      targetItem.aggregatedOutput = `${targetItem.aggregatedOutput ?? ""}${nextOutput}`;
      this.appendCommandOutputDeltas(threadId, turnId, targetItem.id, nextOutput);
    }

    if (typeof commandUpdate.processId === "string" && commandUpdate.processId) {
      targetItem.processId = commandUpdate.processId;
    }
    if (typeof commandUpdate.driver === "string" && commandUpdate.driver) {
      targetItem.driver = commandUpdate.driver;
    }
    if (Number.isFinite(sessionId)) {
      targetItem.sessionId = sessionId;
    }
    if (Number.isFinite(commandUpdate.exitCode)) {
      targetItem.exitCode = commandUpdate.exitCode;
    }

    const status = typeof commandUpdate.status === "string" && commandUpdate.status
      ? commandUpdate.status
      : targetItem.status;
    targetItem.status = status;

    if (execSession) {
      const startedAtMs = Number.isFinite(execSession.startedAtMs) ? execSession.startedAtMs : this.now();
      targetItem.durationMs = Math.max(0, this.now() - startedAtMs);
      this.updateExecSession(turn, sessionId, {
        status: commandUpdate.sessionOpen ? "running" : "closed",
        driver: commandUpdate.driver ?? execSession.driver ?? null,
        sandboxSessionId: commandUpdate.sandboxSessionId ?? execSession.sandboxSessionId ?? null,
        sandboxId: commandUpdate.sandboxId ?? execSession.sandboxId ?? null,
        marker: commandUpdate.marker ?? execSession.marker ?? null,
      });
    } else if (Number.isFinite(commandUpdate.durationMs)) {
      targetItem.durationMs = commandUpdate.durationMs;
    }

    if (status !== "inProgress") {
      this.markItemCompleted(threadId, turnId, turn, targetItem);
    }
  }

  async closeExecSessions(thread, turn) {
    const runner = ensureTurnRunnerState(turn);
    if (!this.sandboxBroker || typeof this.sandboxBroker.closeCommandSession !== "function") {
      return;
    }

    for (const session of Object.values(runner.execSessions)) {
      if (!session || session.status !== "running") {
        continue;
      }
      await this.sandboxBroker.closeCommandSession(thread, session).catch(() => {});
      session.status = "closed";
    }
  }

  commitTurnHistory(thread, turn) {
    const runner = ensureTurnRunnerState(turn);
    if (runner.historyCommitted) {
      return;
    }

    const assistantItem = this.getAssistantItem(turn);
    if (assistantItem?.text) {
      this.appendThreadHistoryItem(thread, {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: assistantItem.text,
          },
        ],
      });
    }

    runner.historyCommitted = true;
  }

  async finalizeTurn(thread, turn, status, errorMessage = null) {
    const runner = ensureTurnRunnerState(turn);
    const threadId = thread.id;
    const turnId = turn.id;

    await this.closeExecSessions(thread, turn);

    if (runner.pendingServerRequestIds.length > 0) {
      this.clearPendingServerRequests(threadId, turn);
    }

    turn.status = status;
    turn.error = errorMessage ? createTurnError(errorMessage) : null;
    runner.phase = status;
    thread.status = status === "completed" ? idleThreadStatus() : status === "interrupted" ? idleThreadStatus() : systemErrorThreadStatus();
    thread.updatedAt = Math.floor(this.now() / 1000);

    for (const item of turn.items ?? []) {
      if (
        item.type === "dynamicToolCall" &&
        item.status === "inProgress"
      ) {
        item.status = "failed";
        item.success = false;
        item.output = item.output || `Turn ${status} before the tool call completed.`;
      }
      if (
        item.type === "toolRequestUserInput" &&
        item.status === "inProgress"
      ) {
        item.status = "failed";
        item.output = item.output || `Turn ${status} before user input was returned.`;
      }
      if (
        item.type === "commandExecution" &&
        item.status === "inProgress"
      ) {
        item.status = "failed";
        item.aggregatedOutput = item.aggregatedOutput || `Turn ${status} before the command completed.`;
      }
      if (
        item.type === "fileChange" &&
        item.status === "inProgress"
      ) {
        item.status = "failed";
        item.output = item.output || `Turn ${status} before the patch completed.`;
      }
    }

    this.commitTurnHistory(thread, turn);
    await this.persist();
    this.trace("turn.finalize", {
      threadId,
      turnId,
      status,
      error: errorMessage,
      itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
      pendingInputs: runner.pendingInputs.length,
      pendingServerRequests: runner.pendingServerRequestIds.length,
      execSessions: Object.keys(runner.execSessions ?? {}).length,
    });

    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" || item.type === "reasoning" || item.status) {
        this.markItemCompleted(threadId, turnId, turn, item);
      }
    }

    if (errorMessage) {
      this.notify(notification("error", createNotificationError(errorMessage)));
    }

    this.notify(notification("turn/completed", {
      threadId,
      turn: serializeTurn(turn),
    }));
  }

  async executeTurn(threadId, turnId) {
    const runKey = runningTurnKey(threadId, turnId);
    if (this.runningTurns.has(runKey)) {
      return;
    }

    const marker = Symbol(runKey);
    this.runningTurns.set(runKey, marker);

    try {
      while (true) {
        const thread = this.getThreadById(threadId);
        const turn = this.getTurnById(thread, turnId);
        const runner = ensureTurnRunnerState(turn);

        if (turn.status !== "inProgress") {
          return;
        }

        if (runner.phase === "waitingExternal") {
          return;
        }

        if (runner.phase === "interrupted") {
          await this.finalizeTurn(thread, turn, "interrupted");
          return;
        }

        this.ensureTurnStarted(threadId, turn);
        runner.phase = "modelRunning";
        runner.cycle += 1;
        await this.persist();

        const assistantItem = this.getAssistantItem(turn);
        if (!assistantItem) {
          throw new Error(`turn ${turn.id} is missing its assistant item`);
        }

        const cycleInput = this.buildCycleInput(thread, turn, runner);
        if (cycleInput.action === "continue") {
          runner.phase = "queued";
          await this.persist();
          continue;
        }
        if (cycleInput.action === "stop") {
          await this.finalizeTurn(thread, turn, "completed");
          return;
        }

        const controller = new AbortController();
        this.runningTurns.set(runKey, controller);

        const externalRequests = [];
        let latestResponseId = runner.lastResponseId;
        this.trace("turn.cycle.start", {
          threadId,
          turnId: turn.id,
          cycle: runner.cycle,
          responseId: runner.lastResponseId ?? null,
        });

        try {
          const request = this.buildModelRequest(
            thread,
            turn,
            runner,
            controller.signal,
            cycleInput.acceptedInputs,
          );
          const stream = typeof this.modelClient?.streamResponse === "function"
            ? this.modelClient.streamResponse(request)
            : this.modelClient.streamText(request);

          for await (const event of stream) {
            latestResponseId = event?.responseId ?? latestResponseId;

            switch (event?.type) {
              case "output_text.delta":
                this.appendAssistantDelta(threadId, turn.id, assistantItem, event.delta);
                break;
              case "reasoning.summary_part_added":
                this.addReasoningSummaryPart(threadId, turn.id, turn, event.summaryIndex ?? 0);
                break;
              case "reasoning.summary_text.delta":
                this.appendReasoningSummary(threadId, turn.id, turn, event.delta ?? "", event.summaryIndex ?? 0);
                break;
              case "reasoning.text.delta":
                this.appendReasoningText(threadId, turn.id, turn, event.delta ?? "", event.contentIndex ?? 0);
                break;
              case "output_item.done": {
                const parsed = parseOutputItem(event.item);
                if (parsed.kind === "message") {
                  this.mergeAssistantText(threadId, turn.id, assistantItem, parsed.text);
                  break;
                }

                if (parsed.kind === "reasoning") {
                  const reasoningItem = this.getOrCreateReasoningItem(turn);
                  this.markItemStarted(threadId, turn.id, turn, reasoningItem);
                  for (let index = 0; index < parsed.summary.length; index += 1) {
                    const section = parsed.summary[index];
                    const summaryText = typeof section?.text === "string" ? section.text : "";
                    if (summaryText && !reasoningItem.summary[index]) {
                      this.addReasoningSummaryPart(threadId, turn.id, turn, index);
                      this.appendReasoningSummary(threadId, turn.id, turn, summaryText, index);
                    }
                  }
                  for (let index = 0; index < parsed.content.length; index += 1) {
                    const block = parsed.content[index];
                    const contentText = typeof block?.text === "string" ? block.text : "";
                    if (contentText && !reasoningItem.content[index]) {
                      this.appendReasoningText(threadId, turn.id, turn, contentText, index);
                    }
                  }
                  break;
                }

                if (parsed.kind === "function_call") {
                  if (turn.items.some((existingItem) => existingItem?.callId === parsed.callId)) {
                    this.trace("tool.call.duplicate", {
                      threadId,
                      turnId: turn.id,
                      toolName: parsed.toolName,
                      callId: parsed.callId,
                    });
                    break;
                  }
                  this.trace("tool.call", {
                    threadId,
                    turnId: turn.id,
                    toolName: parsed.toolName,
                    callId: parsed.callId,
                    argumentsPreview: previewText(JSON.stringify(parsed.argumentsValue ?? {})),
                  });
                  const toolItem = this.createToolCallItem(parsed);
                  if (!toolItem) {
                    break;
                  }

                  this.appendThreadHistoryItem(thread, {
                    type: "function_call",
                    call_id: parsed.callId,
                    name: parsed.toolName,
                    arguments: JSON.stringify(parsed.argumentsValue ?? {}),
                  });
                  turn.items.push(toolItem);
                  this.markItemStarted(threadId, turn.id, turn, toolItem);

                  const toolStart = await startToolCall({
                    thread,
                    threadId,
                    turnId: turn.id,
                    item: toolItem,
                    requestId: this.createId("req"),
                    nowMs: this.now(),
                    workspaceStore: this.workspaceStore,
                    sandboxBroker: this.sandboxBroker,
                    resolveExecSession: (sessionId) => this.getExecSession(turn, Number(sessionId)),
                  });

                  if (toolStart.kind === "external") {
                    externalRequests.push(toolStart.requestRecord);
                    break;
                  }

                  toolItem.status = toolStart.result.status;
                  if (toolItem.type === "dynamicToolCall") {
                    toolItem.output = toolStart.result.outputText ?? null;
                    toolItem.durationMs = 0;
                    toolItem.contentItems = toolStart.result.contentItems ?? [];
                    toolItem.success = toolStart.result.success ?? false;
                  }
                  if (toolItem.type === "toolRequestUserInput") {
                    toolItem.output = toolStart.result.outputText ?? null;
                    toolItem.durationMs = 0;
                    toolItem.answers = toolStart.result.answers ?? {};
                  }
                  if (toolItem.type === "commandExecution") {
                    toolItem.aggregatedOutput = toolStart.result.outputText ?? null;
                    toolItem.exitCode =
                      Number.isFinite(toolStart.result.exitCode) ? toolStart.result.exitCode : null;
                    toolItem.processId =
                      typeof toolStart.result.processId === "string" && toolStart.result.processId
                        ? toolStart.result.processId
                        : null;
                    toolItem.driver =
                      typeof toolStart.result.driver === "string" && toolStart.result.driver
                        ? toolStart.result.driver
                        : null;
                    toolItem.durationMs =
                      Number.isFinite(toolStart.result.durationMs) ? toolStart.result.durationMs : 0;
                    if (toolStart.result.sessionOpen) {
                      const execSession = this.allocateExecSession(turn, toolItem.id, {
                        driver: toolStart.result.driver ?? null,
                        sandboxSessionId: toolStart.result.sandboxSessionId ?? null,
                        sandboxId: toolStart.result.sandboxId ?? null,
                        marker: toolStart.result.marker ?? null,
                      });
                      toolItem.sessionId = execSession.sessionId;
                      toolItem.processId = execSession.processId;
                      if (toolStart.result.nextInputItem) {
                        toolStart.result.nextInputItem.output = JSON.stringify({
                          wall_time_seconds: Number.isFinite(toolStart.result.durationMs)
                            ? toolStart.result.durationMs / 1000
                            : 0,
                          output: toolStart.result.outputText ?? "",
                          session_id: execSession.sessionId,
                          ...(toolStart.result.driver ? { driver: toolStart.result.driver } : {}),
                        }, null, 2);
                      }
                    }
                    if (toolItem.aggregatedOutput) {
                      this.appendCommandOutputDeltas(threadId, turn.id, toolItem.id, toolItem.aggregatedOutput);
                    }
                  }
                  if (toolItem.type === "fileChange") {
                    toolItem.output = toolStart.result.outputText ?? null;
                    toolItem.changes = Array.isArray(toolStart.result.changes)
                      ? toolStart.result.changes
                      : [];
                  }
                  if (toolItem.type === "functionToolCall" && toolItem.kind === "writeStdin") {
                    toolItem.output = toolStart.result.outputText ?? null;
                    toolItem.durationMs =
                      Number.isFinite(toolStart.result.durationMs) ? toolStart.result.durationMs : 0;
                    toolItem.success = toolStart.result.status !== "failed";
                    if (toolStart.result.terminalInteraction) {
                      const { processId, stdin } = toolStart.result.terminalInteraction;
                      const commandSession = this.getExecSession(
                        turn,
                        Number(toolItem.arguments?.session_id ?? null),
                      );
                      const targetItemId = commandSession?.itemId ?? null;
                      if (targetItemId && typeof processId === "string" && typeof stdin === "string" && stdin) {
                        this.notifyTerminalInteraction(threadId, turn.id, targetItemId, processId, stdin);
                      }
                    }
                    this.applyCommandUpdate(threadId, turn.id, turn, toolStart.result.commandUpdate);
                  }
                  if (!(toolItem.type === "commandExecution" && toolItem.status === "inProgress")) {
                    this.markItemCompleted(threadId, turn.id, turn, toolItem);
                  }
                  this.trace("tool.result", {
                    threadId,
                    turnId: turn.id,
                    toolName: parsed.toolName,
                    itemType: toolItem.type,
                    itemStatus: toolItem.status ?? null,
                    sessionOpen: Boolean(toolStart.result.sessionOpen),
                    exitCode: toolStart.result.exitCode ?? null,
                    driver: toolStart.result.driver ?? null,
                    processId: toolStart.result.processId ?? null,
                    sessionId: toolItem.sessionId ?? null,
                    outputPreview: previewText(toolStart.result.outputText ?? ""),
                  });
                  if (toolStart.result.nextInputItem) {
                    runner.pendingInputs.push(this.createPendingInputRecord(
                      "conversationItem",
                      toolStart.result.nextInputItem,
                      { sourceItemId: toolItem.id },
                    ));
                  }
                }
                break;
              }
              case "completed":
                latestResponseId = event.responseId ?? latestResponseId;
                break;
              default:
                break;
            }
          }
        } catch (error) {
          if (isAbortError(error)) {
            if (runner.phase === "interrupted") {
              await this.finalizeTurn(thread, turn, "interrupted");
              return;
            }
            throw error;
          }
          throw error;
        } finally {
          if (this.runningTurns.get(runKey) === controller) {
            this.runningTurns.delete(runKey);
          }
        }

        runner.lastResponseId = latestResponseId;
        thread.updatedAt = Math.floor(this.now() / 1000);

        if (runner.phase === "interrupted") {
          await this.finalizeTurn(thread, turn, "interrupted");
          return;
        }

        if (externalRequests.length > 0) {
          runner.phase = "waitingExternal";
          this.trace("turn.waiting_external", {
            threadId,
            turnId: turn.id,
            requests: externalRequests.length,
          });
          for (const record of externalRequests) {
            runner.pendingServerRequestIds.push(record.id);
            this.state.pendingServerRequests[record.id] = record;
          }
          await this.persist();

          for (const record of externalRequests) {
            this.notify(buildServerRequestEnvelope(record));
          }
          return;
        }

        if (runner.pendingInputs.length > 0) {
          runner.phase = "queued";
          await this.persist();
          continue;
        }

        await this.finalizeTurn(thread, turn, "completed");
        return;
      }
    } catch (error) {
      const thread = this.state.threads[threadId];
      const turn = thread ? (thread.turns ?? []).find((entry) => entry.id === turnId) : null;
      if (thread && turn && turn.status === "inProgress") {
        const message = error instanceof Error ? error.message : String(error);
        await this.finalizeTurn(thread, turn, "failed", message);
      }
    } finally {
      if (this.runningTurns.get(runKey)) {
        this.runningTurns.delete(runKey);
      }
    }
  }
}
