function isTruthy(value) {
  if (typeof value !== "string") {
    return Boolean(value);
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function truncateText(value, maxLength = 160) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function normalizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array:${value.length}]`;
    }
    return value.slice(0, 10).map((entry) => normalizeValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object]";
    }
    const entries = Object.entries(value).slice(0, 20);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, normalizeValue(entryValue, depth + 1)]),
    );
  }

  return String(value);
}

export function previewText(value, maxLength = 160) {
  return truncateText(value, maxLength);
}

export function createTraceLogger({
  enabled = false,
  prefix = "app-server",
} = {}) {
  if (!isTruthy(enabled)) {
    return () => {};
  }

  return (event, fields = {}) => {
    const payload = {
      ts: new Date().toISOString(),
      event,
      ...normalizeValue(fields),
    };
    console.log(`${prefix} ${JSON.stringify(payload)}`);
  };
}
