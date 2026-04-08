function textContent(text) {
  return {
    type: "input_text",
    text,
  };
}

function imageContent(imageUrl) {
  return {
    type: "input_image",
    image_url: imageUrl,
  };
}

export function renderDynamicToolContentItem(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  switch (item.type) {
    case "inputText":
      return typeof item.text === "string" ? item.text : "";
    case "inputImage":
      return typeof item.imageUrl === "string" ? `[Image: ${item.imageUrl}]` : "[Image]";
    default:
      return "";
  }
}

export function renderDynamicToolContentItems(items) {
  if (!Array.isArray(items)) {
    return "";
  }

  return items
    .map(renderDynamicToolContentItem)
    .filter(Boolean)
    .join("\n");
}

export function userEntryToResponseContent(entry) {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  switch (entry.type) {
    case "text":
      return typeof entry.text === "string" && entry.text ? [textContent(entry.text)] : [];
    case "image":
      return typeof entry.url === "string" && entry.url ? [imageContent(entry.url)] : [];
    case "localImage":
      return [
        textContent(
          typeof entry.path === "string"
            ? `[Local image unavailable in Worker runtime: ${entry.path}]`
            : "[Local image unavailable in Worker runtime]",
        ),
      ];
    case "skill":
    case "mention":
      return [textContent(typeof entry.name === "string" ? `@${entry.name}` : "@unknown")];
    default:
      return [];
  }
}

export function buildUserMessageInput(item) {
  const content = Array.isArray(item?.content)
    ? item.content.flatMap((entry) => userEntryToResponseContent(entry))
    : [];

  return {
    type: "message",
    role: "user",
    content: content.length > 0 ? content : [textContent("")],
  };
}

export function buildAssistantMessageInput(item) {
  const text = typeof item?.text === "string" ? item.text : "";
  return {
    type: "message",
    role: "assistant",
    content: text ? [{ type: "output_text", text }] : [],
  };
}

export function buildFunctionToolCallHistoryInputs(item) {
  if (!item || typeof item !== "object" || typeof item.callId !== "string" || !item.callId) {
    return [];
  }

  let toolName =
    typeof item.tool === "string" && item.tool
      ? item.tool
      : typeof item.toolName === "string" && item.toolName
        ? item.toolName
        : null;

  let argumentsValue = item.arguments ?? {};
  let outputValue =
    typeof item.output === "string"
      ? item.output
      : JSON.stringify(item.output ?? item.answers ?? null);

  if (item.type === "commandExecution") {
    toolName = "exec_command";
    argumentsValue = item.request ?? {
      cmd: item.command,
      workdir: item.cwd || undefined,
    };
    outputValue = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  } else if (item.type === "fileChange") {
    toolName = "apply_patch";
    argumentsValue = {
      input: typeof item.patch === "string" ? item.patch : "",
    };
    outputValue = typeof item.output === "string" ? item.output : "";
  }

  if (!toolName) {
    return [];
  }

  const inputs = [
    {
      type: "function_call",
      call_id: item.callId,
      name: toolName,
      arguments: JSON.stringify(argumentsValue),
    },
  ];

  if (item.status === "completed" || item.status === "failed") {
    inputs.push({
      type: "function_call_output",
      call_id: item.callId,
      output: outputValue,
    });
  }

  return inputs;
}

export function buildHistoryInput(thread, { includeInProgressTurnId = null } = {}) {
  const input = [];

  for (const turn of thread.turns ?? []) {
    const isTargetTurn = turn.id === includeInProgressTurnId;
    if (turn.status !== "completed" && !isTargetTurn) {
      continue;
    }

    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        input.push(buildUserMessageInput(item));
        continue;
      }

      if (item.type === "agentMessage") {
        if (typeof item.text === "string" && item.text) {
          input.push(buildAssistantMessageInput(item));
        }
        continue;
      }

      if (
        item.type === "dynamicToolCall" ||
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "toolRequestUserInput" ||
        item.type === "functionToolCall"
      ) {
        input.push(...buildFunctionToolCallHistoryInputs(item));
      }
    }
  }

  return input;
}

function normalizeDynamicToolSpec(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  if (!name || !description) {
    return null;
  }

  const parameters =
    tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema
      : tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema
        : { type: "object", properties: {}, additionalProperties: true };

  const deferLoading = Boolean(tool.deferLoading ?? tool.defer_loading ?? false);

  return {
    name,
    description,
    parameters,
    deferLoading,
  };
}

export function buildDynamicToolDefinitions(thread) {
  const toolSpecs = [];

  for (const tool of Array.isArray(thread.dynamicTools) ? thread.dynamicTools : []) {
    const normalized = normalizeDynamicToolSpec(tool);
    if (!normalized || normalized.deferLoading) {
      continue;
    }

    toolSpecs.push({
      type: "function",
      name: normalized.name,
      description: normalized.description,
      strict: false,
      parameters: normalized.parameters,
    });
  }

  return toolSpecs;
}
