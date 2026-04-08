const SHELL_WRAPPER_EXECUTABLES = new Set(["sh", "bash", "zsh"]);

export function tokenizeCommand(input) {
  const source = typeof input === "string" ? input.trim() : "";
  if (!source) {
    return null;
  }

  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
        continue;
      }
      if (char === "\\") {
        const next = source[index + 1];
        if (next && "\"\\$`\n".includes(next)) {
          current += next;
          index += 1;
          continue;
        }
        current += char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === "\\") {
      const next = source[index + 1];
      if (next) {
        current += next;
        index += 1;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens.length > 0 ? tokens : null;
}

export function hasEnvAssignmentPrefix(tokens) {
  if (!Array.isArray(tokens)) {
    return false;
  }

  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      return true;
    }
    break;
  }

  return false;
}

export function hasUnquotedShellSyntax(input) {
  const source = typeof input === "string" ? input : "";
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
        continue;
      }
      if (char === "\\") {
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      return true;
    }

    if ("|;&<>`".includes(char)) {
      return true;
    }

    if (char === "$") {
      const next = source[index + 1];
      if (next === "(" || next === "{") {
        return true;
      }
    }
  }

  return false;
}

export function unwrapShellCommand(input) {
  const tokens = tokenizeCommand(input);
  if (!tokens || tokens.length < 3) {
    return null;
  }

  const [executable, flag, command, ...rest] = tokens;
  if (!SHELL_WRAPPER_EXECUTABLES.has(executable)) {
    return null;
  }

  if (!["-c", "-lc"].includes(flag)) {
    return null;
  }

  if (rest.length > 0) {
    return null;
  }

  if (typeof command !== "string" || !command.trim()) {
    return null;
  }

  return {
    shell: executable,
    flag,
    command: command.trim(),
  };
}
