function renderEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  switch (entry.type) {
    case "text":
      return typeof entry.text === "string" ? entry.text : "";
    case "image":
      return typeof entry.url === "string" ? `[Image URL: ${entry.url}]` : "[Image URL]";
    case "localImage":
      return typeof entry.path === "string"
        ? `[Local image unavailable in Worker runtime: ${entry.path}]`
        : "[Local image unavailable in Worker runtime]";
    case "skill":
    case "mention":
      return typeof entry.name === "string" ? `@${entry.name}` : "@unknown";
    default:
      return "";
  }
}

export function normalizeUserInput(input) {
  if (!Array.isArray(input)) {
    throw new Error("turn/start params.input must be an array");
  }

  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("turn/start params.input entries must be objects");
    }
    return entry;
  });
}

export function previewFromInput(input) {
  for (const entry of input) {
    const rendered = renderEntry(entry).trim();
    if (rendered) {
      return rendered.slice(0, 120);
    }
  }

  return "New thread";
}

export function renderUserInput(input) {
  return input
    .map(renderEntry)
    .filter(Boolean)
    .join("\n");
}

export function buildTranscriptPrompt(thread) {
  const lines = [];

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const rendered = renderUserInput(item.content);
        if (rendered) {
          lines.push(`User:\n${rendered}`);
        }
      } else if (item.type === "agentMessage" && item.text) {
        lines.push(`Assistant:\n${item.text}`);
      }
    }
  }

  return lines.join("\n\n");
}
