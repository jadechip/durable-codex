import { createCommandRegistry, SANDBOX_DRIVER } from "./command-registry.js";
import { createWorkerCommandDriver, WORKER_COMMAND_DRIVER_NAME } from "./worker-command-driver.js";
import {
  attachWorkspaceSandbox,
  invalidateWorkspaceHydration,
  markWorkspaceHydrated,
} from "./vfs-store.js";

function normalizeCommandResult(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const outputText =
    typeof result?.outputText === "string"
      ? result.outputText
      : [
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
        ].filter(Boolean).join("\n\n") || (Number.isFinite(result?.exitCode) ? `exit_code: ${result.exitCode}` : "");

  return {
    ok: result?.sessionOpen ? true : (Number.isFinite(result?.exitCode) ? result.exitCode === 0 : true),
    exitCode: Number.isFinite(result?.exitCode) ? result.exitCode : null,
    stdout,
    stderr,
    outputText,
    infrastructureError: Boolean(result?.infrastructureError),
    processId: typeof result?.processId === "string" && result.processId ? result.processId : null,
    durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
    sandboxId: typeof result?.sandboxId === "string" && result.sandboxId ? result.sandboxId : null,
    sandboxSessionId:
      typeof result?.sandboxSessionId === "string" && result.sandboxSessionId
        ? result.sandboxSessionId
        : null,
    marker: typeof result?.marker === "string" && result.marker ? result.marker : null,
    sessionOpen: Boolean(result?.sessionOpen),
    changedFiles: Array.isArray(result?.changedFiles) ? result.changedFiles : [],
    removedPaths: Array.isArray(result?.removedPaths) ? result.removedPaths : [],
    originalTokenCount: Number.isFinite(result?.originalTokenCount) ? result.originalTokenCount : null,
    driver: typeof result?.driver === "string" && result.driver ? result.driver : null,
    route: result?.route && typeof result.route === "object" ? structuredClone(result.route) : null,
    fallbackSuggested: Boolean(result?.fallbackSuggested),
    fallbackReason: typeof result?.fallbackReason === "string" && result.fallbackReason ? result.fallbackReason : null,
    fallbackMessage: typeof result?.fallbackMessage === "string" && result.fallbackMessage ? result.fallbackMessage : null,
  };
}

export function createSandboxBroker({
  workspaceStore,
  commandExecutor = null,
  workerCommandDriver = null,
  commandDrivers = [],
  trace = () => {},
  now = () => Date.now(),
} = {}) {
  const resolvedWorkerCommandDriver = workerCommandDriver ?? createWorkerCommandDriver({
    workspaceStore,
    trace,
    now,
  });
  const routedDrivers = [resolvedWorkerCommandDriver, ...commandDrivers].filter(Boolean);
  const directDriverMap = new Map(
    routedDrivers
      .filter((driver) => typeof driver?.name === "string" && driver.name && typeof driver.execute === "function")
      .map((driver) => [driver.name, driver]),
  );
  const commandRegistry = createCommandRegistry({
    drivers: routedDrivers,
    fallbackDriver: SANDBOX_DRIVER,
  });

  async function prepareWorkspaceSnapshot(thread) {
    const snapshot = await workspaceStore.exportWorkspaceSnapshot(thread);
    return {
      preparedAt: Math.floor(now() / 1000),
      workspace: structuredClone(snapshot.workspace),
      root: snapshot.root,
      files: snapshot.files.map((file) => structuredClone(file)),
    };
  }

  async function materializeWorkspace(thread, sandboxId = null) {
    const snapshot = await prepareWorkspaceSnapshot(thread);
    const workspace = attachWorkspaceSandbox(snapshot.workspace, sandboxId);
    thread.workspace = structuredClone(workspace);
    trace("sandbox.materialize", {
      workspaceId: workspace.id,
      sandboxId,
      revision: workspace.revision,
      fileCount: snapshot.files.length,
    });
    return {
      workspace,
      snapshot,
    };
  }

  function supportsCommandExecution() {
    return (
      directDriverMap.size > 0
      || (commandExecutor && typeof commandExecutor.executeCommand === "function")
    );
  }

  async function applyWorkspaceDiff(
    thread,
    workspace,
    normalized,
    {
      fallbackSandboxId = null,
      markHydrated: shouldMarkHydrated = false,
      invalidateHydration: shouldInvalidateHydration = false,
    } = {},
  ) {
    trace("sandbox.sync", {
      workspaceId: workspace.id,
      revision: workspace.revision,
      changedFiles: normalized.changedFiles.length,
      removedPaths: normalized.removedPaths.length,
      sandboxId: normalized.sandboxId ?? fallbackSandboxId ?? null,
    });
    if (normalized.changedFiles.length > 0 || normalized.removedPaths.length > 0) {
      const applied = await workspaceStore.applyWorkspaceFiles(thread, normalized.changedFiles, {
        removePaths: normalized.removedPaths,
      });
      const nextWorkspace = attachWorkspaceSandbox(
        applied.workspace,
        normalized.sandboxId ?? fallbackSandboxId ?? thread.workspace?.attachedSandboxId ?? null,
      );
      thread.workspace = shouldMarkHydrated
        ? markWorkspaceHydrated(nextWorkspace, {
          sandboxId: normalized.sandboxId ?? fallbackSandboxId ?? null,
          revision: applied.workspace.revision,
        })
        : shouldInvalidateHydration
          ? invalidateWorkspaceHydration(nextWorkspace)
          : nextWorkspace;
    } else {
      const nextWorkspace = attachWorkspaceSandbox(
        workspace,
        normalized.sandboxId ?? fallbackSandboxId ?? thread.workspace?.attachedSandboxId ?? null,
      );
      thread.workspace = shouldMarkHydrated
        ? markWorkspaceHydrated(nextWorkspace, {
          sandboxId: normalized.sandboxId ?? fallbackSandboxId ?? null,
          revision: workspace.revision,
        })
        : shouldInvalidateHydration
          ? invalidateWorkspaceHydration(nextWorkspace)
          : nextWorkspace;
    }
  }

  async function executeDirectDriver(thread, driver, {
    command,
    cwd,
    maxOutputTokens,
    route,
    timeoutMs = null,
    shell = undefined,
    tty = false,
  }) {
    const workspace = await workspaceStore.ensureWorkspace(thread);
    thread.workspace = structuredClone(workspace);

    const normalized = normalizeCommandResult({
      ...(await driver.execute(thread, {
        command,
        cwd,
        maxOutputTokens,
        route,
      })),
      driver: driver.name,
      route,
    });

    if (normalized.fallbackSuggested) {
      trace("command.fallback", {
        workspaceId: workspace.id,
        fromDriver: driver.name,
        toDriver: SANDBOX_DRIVER,
        reason: normalized.fallbackReason ?? null,
        message: normalized.fallbackMessage ?? null,
        command,
      });
      return executeSandboxCommand(thread, {
        command,
        cwd,
        tty,
        timeoutMs,
        maxOutputTokens,
        shell,
        route: {
          ...route,
          driver: SANDBOX_DRIVER,
          fallbackFrom: driver.name,
          fallbackReason: normalized.fallbackReason ?? null,
        },
      });
    }

    if (normalized.changedFiles.length > 0 || normalized.removedPaths.length > 0) {
      await applyWorkspaceDiff(
        thread,
        workspace,
        normalized,
        {
          fallbackSandboxId: thread.workspace?.attachedSandboxId ?? null,
          invalidateHydration: true,
        },
      );
    }

    return {
      ...normalized,
      workspace: thread.workspace ? structuredClone(thread.workspace) : structuredClone(workspace),
    };
  }

  async function executeSandboxCommand(thread, {
    command,
    cwd = null,
    tty = false,
    timeoutMs = null,
    maxOutputTokens = null,
    shell = undefined,
    route = null,
  } = {}) {
    if (!commandExecutor || typeof commandExecutor.executeCommand !== "function") {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        outputText: "Sandbox command execution is not configured on this deployment.",
        workspace: thread.workspace ? structuredClone(thread.workspace) : null,
        infrastructureError: true,
        sessionOpen: false,
        driver: SANDBOX_DRIVER,
        route,
      };
    }

    const { snapshot, workspace } = await materializeWorkspace(thread);
    const rawResult = await commandExecutor.executeCommand({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      workspaceRevision: workspace.revision,
      hydratedRevision: thread.workspace?.hydratedRevision ?? null,
      cwd: typeof cwd === "string" && cwd ? cwd : workspace.root,
      command,
      files: snapshot.files.map((file) => structuredClone(file)),
      tty,
      timeoutMs,
      maxOutputTokens,
      shell,
      route,
    });
    const normalized = normalizeCommandResult({
      ...rawResult,
      driver: rawResult?.driver ?? SANDBOX_DRIVER,
      route,
    });

    await applyWorkspaceDiff(thread, workspace, normalized, {
      fallbackSandboxId: normalized.sandboxId ?? null,
      markHydrated: true,
    });

    return {
      ...normalized,
      workspace: structuredClone(thread.workspace),
    };
  }

  async function executeCommand(thread, {
    command,
    cwd = null,
    tty = false,
    timeoutMs = null,
    maxOutputTokens = null,
    shell = undefined,
  } = {}) {
    if (!supportsCommandExecution()) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        outputText: "Sandbox command execution is not configured on this deployment.",
        workspace: thread.workspace ? structuredClone(thread.workspace) : null,
        infrastructureError: true,
        sessionOpen: false,
      };
    }

    const route = commandRegistry.resolve({
      command,
      cwd,
      tty,
      shell,
    });
    trace("command.route", {
      workspaceId: thread.workspace?.id ?? thread.workspaceId ?? null,
      driver: route.driver,
      executable: route.executable ?? null,
      reason: route.reason ?? null,
      cwd: typeof cwd === "string" && cwd ? cwd : thread.workspace?.root ?? thread.cwd ?? null,
      command,
    });

    if (route.driver !== SANDBOX_DRIVER) {
      const driver = directDriverMap.get(route.driver);
      if (!driver) {
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          outputText: `Command driver ${route.driver} is not configured on this deployment.`,
          workspace: thread.workspace ? structuredClone(thread.workspace) : null,
          infrastructureError: true,
          sessionOpen: false,
          driver: route.driver,
          route,
        };
      }

      return executeDirectDriver(thread, driver, {
        command,
        cwd: typeof cwd === "string" && cwd ? cwd : thread.workspace?.root ?? thread.cwd ?? null,
        maxOutputTokens,
        route,
        timeoutMs,
        shell,
        tty,
      });
    }
    return executeSandboxCommand(thread, {
      command,
      cwd,
      tty,
      timeoutMs,
      maxOutputTokens,
      shell,
      route,
    });
  }

  async function writeStdin(thread, execSession, {
    chars = "",
    timeoutMs = null,
    maxOutputTokens = null,
  } = {}) {
    if (!commandExecutor || typeof commandExecutor.writeStdin !== "function") {
      return {
        outputText: "Interactive command execution is not configured on this deployment.",
        exitCode: 1,
        infrastructureError: true,
        sessionOpen: false,
        changedFiles: [],
        removedPaths: [],
      };
    }

    const snapshot = await prepareWorkspaceSnapshot(thread);
    const workspace = snapshot.workspace;
    thread.workspace = structuredClone(workspace);

    const rawResult = await commandExecutor.writeStdin({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      sandboxSessionId: execSession.sandboxSessionId,
      sandboxId: execSession.sandboxId ?? null,
      chars,
      timeoutMs,
      maxOutputTokens,
      files: snapshot.files.map((file) => structuredClone(file)),
      marker: execSession.marker ?? null,
    });
    const normalized = normalizeCommandResult(rawResult);

    await applyWorkspaceDiff(
      thread,
      workspace,
      normalized,
      {
        fallbackSandboxId: execSession.sandboxId ?? normalized.sandboxId ?? null,
        markHydrated: true,
      },
    );

    return {
      ...normalized,
      workspace: structuredClone(thread.workspace),
    };
  }

  async function closeCommandSession(thread, execSession) {
    if (!commandExecutor || typeof commandExecutor.closeSession !== "function") {
      return false;
    }

    const snapshot = await prepareWorkspaceSnapshot(thread);
    const workspace = snapshot.workspace;
    thread.workspace = structuredClone(workspace);

    const rawResult = await commandExecutor.closeSession({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      sandboxSessionId: execSession.sandboxSessionId,
      sandboxId: execSession.sandboxId ?? null,
      files: snapshot.files.map((file) => structuredClone(file)),
    });
    const normalized = normalizeCommandResult(rawResult ?? {});

    await applyWorkspaceDiff(
      thread,
      workspace,
      normalized,
      {
        fallbackSandboxId: execSession.sandboxId ?? normalized.sandboxId ?? null,
        markHydrated: true,
      },
    );

    return true;
  }

  return {
    registry: commandRegistry,
    prepareWorkspaceSnapshot,
    materializeWorkspace,
    supportsCommandExecution,
    executeCommand,
    writeStdin,
    closeCommandSession,
  };
}
