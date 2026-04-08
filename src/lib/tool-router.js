function safeParseJson(value) {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {
      __raw: value,
    };
  }
}

export function extractMessageText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

export function parseOutputItem(item) {
  if (!item || typeof item !== "object") {
    return {
      kind: "unknown",
      raw: item,
    };
  }

  switch (item.type) {
    case "message":
      return {
        kind: "message",
        text: extractMessageText(item),
        raw: item,
      };
    case "function_call":
      return {
        kind: "function_call",
        callId:
          typeof item.call_id === "string" && item.call_id
            ? item.call_id
            : typeof item.id === "string" && item.id
              ? item.id
              : null,
        toolName: typeof item.name === "string" ? item.name : null,
        argumentsValue: safeParseJson(item.arguments),
        raw: item,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        summary: Array.isArray(item.summary) ? item.summary : [],
        content: Array.isArray(item.content) ? item.content : [],
        raw: item,
      };
    default:
      return {
        kind: "unknown",
        raw: item,
      };
  }
}
