export function buildExecUsage() {
  return [
    "Usage:",
    "  codex exec [options] <prompt>",
    "",
    "Options:",
    "  --base-url <url>         App server base URL",
    "  --workspace <id>         Workspace id to attach to",
    "  --model <model>          Model override for thread/start",
    "  --cwd <path>             Workspace root for the thread (default: /workspace)",
    "  --json                   Print the final completed turn as JSON",
    "  --raw-events             Print raw JSON-RPC envelopes to stderr",
    "  -h, --help               Show this help",
    "",
    "Examples:",
    "  codex exec \"Run pwd\"",
    "  codex exec --workspace repo-a \"Fix the failing test\"",
    "  codex exec --json \"Summarize this project\"",
  ].join("\n");
}

function defaultBaseUrl(env = process.env) {
  if (typeof env.APP_SERVER_BASE_URL === "string" && env.APP_SERVER_BASE_URL) {
    return env.APP_SERVER_BASE_URL;
  }
  const port = env.APP_SERVER_PORT || env.PORT || "8787";
  const host = env.APP_SERVER_HOST || "127.0.0.1";
  return `http://${host}:${port}`;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (typeof value !== "string" || !value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseExecArgs(argv, env = process.env) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    baseUrl: defaultBaseUrl(env),
    workspaceId: env.APP_SERVER_WORKSPACE_ID || "default",
    model: env.APP_SERVER_MODEL || null,
    cwd: env.APP_SERVER_CWD || "/workspace",
    json: false,
    rawEvents: false,
    help: false,
    prompt: "",
  };

  const promptParts = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && (token === "-h" || token === "--help")) {
      options.help = true;
      continue;
    }
    if (!positionalOnly && token === "--json") {
      options.json = true;
      continue;
    }
    if (!positionalOnly && token === "--raw-events") {
      options.rawEvents = true;
      continue;
    }
    if (!positionalOnly && token === "--base-url") {
      options.baseUrl = takeValue(args, index, token);
      index += 1;
      continue;
    }
    if (!positionalOnly && (token === "--workspace" || token === "--workspace-id")) {
      options.workspaceId = takeValue(args, index, token);
      index += 1;
      continue;
    }
    if (!positionalOnly && token === "--model") {
      options.model = takeValue(args, index, token);
      index += 1;
      continue;
    }
    if (!positionalOnly && token === "--cwd") {
      options.cwd = takeValue(args, index, token);
      index += 1;
      continue;
    }
    promptParts.push(token);
  }

  options.prompt = promptParts.join(" ").trim();
  return options;
}
