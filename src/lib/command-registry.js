import { unwrapShellCommand } from "./command-parsing.js";

export const WORKER_BUILTIN_DRIVER = "workerBuiltin";
export const DYNAMIC_WORKER_DRIVER = "dynamicWorker";
export const SANDBOX_DRIVER = "sandbox";

export function createCommandRegistry({
  drivers = [],
  fallbackDriver = SANDBOX_DRIVER,
} = {}) {
  function resolveRequest(request, { allowShellWrapper = true } = {}) {
    for (const driver of drivers) {
      if (!driver || typeof driver.resolve !== "function") {
        continue;
      }
      const match = driver.resolve(request);
      if (match) {
        return {
          driver: driver.name,
          ...match,
        };
      }
    }

    if (allowShellWrapper) {
      const shellWrapper = unwrapShellCommand(request?.command ?? request?.cmd ?? null);
      if (shellWrapper) {
        const unwrapped = resolveRequest({
          ...request,
          command: shellWrapper.command,
          cmd: shellWrapper.command,
        }, {
          allowShellWrapper: false,
        });

        if (unwrapped.driver !== fallbackDriver) {
          return {
            ...unwrapped,
            shellWrapper: {
              executable: shellWrapper.shell,
              flag: shellWrapper.flag,
            },
            originalCommand:
              typeof request?.command === "string" && request.command
                ? request.command
                : request?.cmd ?? shellWrapper.command,
            reason: unwrapped.reason ?? "shell-wrapper",
          };
        }
      }
    }

    return {
      driver: fallbackDriver,
      executable: null,
      args: [],
      reason: "fallback",
    };
  }

  return {
    resolve(request) {
      return resolveRequest(request);
    },
  };
}
