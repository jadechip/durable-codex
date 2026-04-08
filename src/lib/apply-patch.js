import { invalidateWorkspaceHydration } from "./vfs-store.js";

function normalizeRoot(root) {
  const value = typeof root === "string" && root.trim() ? root.trim() : "/workspace";
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const normalized = withLeadingSlash.replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function ensureRelativePath(path, root = "/workspace") {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("Patch file path is required.");
  }

  const trimmed = path.trim().replace(/\/+/g, "/");
  if (trimmed.startsWith("/")) {
    const normalizedRoot = normalizeRoot(root);
    if (trimmed === normalizedRoot) {
      throw new Error(`Patch file path is invalid: ${path}`);
    }
    const rootPrefix = `${normalizedRoot}/`;
    if (!trimmed.startsWith(rootPrefix)) {
      throw new Error(`Patch file path must stay under ${normalizedRoot}: ${path}`);
    }
    return ensureRelativePath(trimmed.slice(rootPrefix.length), normalizedRoot);
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Patch file path is invalid: ${path}`);
  }

  return segments.join("/");
}

function joinWorkspacePath(root, relativePath) {
  return `${normalizeRoot(root)}/${ensureRelativePath(relativePath, root)}`;
}

function parsePatchLines(patchText) {
  return String(patchText ?? "").replace(/\r\n/g, "\n").split("\n");
}

function extractPatchEnvelope(patchText) {
  const text = String(patchText ?? "").replace(/\r\n/g, "\n");
  const trimmed = text.trim();
  if (trimmed.startsWith("*** Begin Patch")) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }

  const startIndex = text.indexOf("*** Begin Patch");
  if (startIndex === -1) {
    return text;
  }

  const endMarker = "*** End Patch";
  const endIndex = text.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    return text;
  }

  const extracted = text.slice(startIndex, endIndex + endMarker.length).trim();
  return extracted ? `${extracted}\n` : text;
}

function createDiffText(lines) {
  return `${lines.join("\n")}\n`;
}

function looksLikeUnifiedDiffBody(lines) {
  return lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ "));
}

function normalizeUnifiedDiffPath(path, root = "/workspace") {
  const trimmed = String(path ?? "").split("\t")[0].trim();
  if (!trimmed || trimmed === "/dev/null") {
    return null;
  }

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return ensureRelativePath(trimmed.slice(2), root);
  }

  return ensureRelativePath(trimmed, root);
}

function buildAddContentFromHunks(hunks) {
  const lines = [];
  for (const hunk of hunks) {
    for (const line of hunk.diffLines) {
      if (line.kind === " " || line.kind === "+") {
        lines.push(line.text);
      }
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function isPureInsertionHeader(header) {
  return /^@@\s+-0(?:,0)?\s+\+\d+(?:,\d+)?\s+@@/.test(String(header ?? ""));
}

function parseUnifiedDiff(lines, root = "/workspace") {
  const operations = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (!line || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) {
      cursor += 1;
      continue;
    }

    if (!line.startsWith("--- ")) {
      throw new Error(`Unsupported unified diff line: ${line}`);
    }

    const sectionLines = [line];
    const previousPath = line.slice(4);
    cursor += 1;

    const nextLine = lines[cursor];
    if (!nextLine?.startsWith("+++ ")) {
      throw new Error(`Unified diff is missing the '+++ ' header after: ${line}`);
    }
    sectionLines.push(nextLine);
    const nextPath = nextLine.slice(4);
    cursor += 1;

    const hunks = [];
    while (cursor < lines.length) {
      const hunkHeader = lines[cursor];
      if (!hunkHeader) {
        cursor += 1;
        continue;
      }
      if (hunkHeader.startsWith("--- ")) {
        break;
      }
      if (!hunkHeader.startsWith("@@")) {
        throw new Error(`Unified diff is missing a hunk header near: ${hunkHeader}`);
      }

      const hunkLines = [hunkHeader];
      const diffLines = [];
      cursor += 1;

      while (cursor < lines.length) {
        const hunkLine = lines[cursor];
        if (hunkLine === "\\ No newline at end of file") {
          hunkLines.push(hunkLine);
          cursor += 1;
          continue;
        }
        if (hunkLine?.startsWith("@@") || hunkLine?.startsWith("--- ")) {
          break;
        }
        const prefix = hunkLine[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          if (isPureInsertionHeader(hunkHeader)) {
            diffLines.push({
              kind: "+",
              text: hunkLine,
            });
            hunkLines.push(`+${hunkLine}`);
            cursor += 1;
            continue;
          }
          break;
        }
        diffLines.push({
          kind: prefix,
          text: hunkLine.slice(1),
        });
        hunkLines.push(hunkLine);
        cursor += 1;
      }

      sectionLines.push(...hunkLines);
      hunks.push({
        header: hunkHeader,
        diffLines,
      });
    }

    const normalizedPreviousPath = normalizeUnifiedDiffPath(previousPath, root);
    const normalizedNextPath = normalizeUnifiedDiffPath(nextPath, root);

    if (normalizedPreviousPath === null && normalizedNextPath) {
      operations.push({
        type: "add",
        path: normalizedNextPath,
        content: buildAddContentFromHunks(hunks),
        diff: createDiffText(sectionLines),
      });
      continue;
    }

    if (
      normalizedPreviousPath &&
      normalizedNextPath &&
      normalizedPreviousPath === normalizedNextPath &&
      hunks.length > 0 &&
      hunks.every((hunk) => isPureInsertionHeader(hunk.header) && hunk.diffLines.every((line) => line.kind === "+"))
    ) {
      operations.push({
        type: "add",
        path: normalizedNextPath,
        content: buildAddContentFromHunks(hunks),
        diff: createDiffText(sectionLines),
      });
      continue;
    }

    if (normalizedPreviousPath && normalizedNextPath === null) {
      operations.push({
        type: "delete",
        path: normalizedPreviousPath,
        diff: createDiffText(sectionLines),
      });
      continue;
    }

    if (!normalizedPreviousPath || !normalizedNextPath) {
      throw new Error(`Unified diff paths are invalid: ${previousPath} -> ${nextPath}`);
    }

    operations.push({
      type: "update",
      path: normalizedPreviousPath,
      movePath: normalizedPreviousPath !== normalizedNextPath ? normalizedNextPath : null,
      hunks,
      diff: createDiffText(sectionLines),
    });
  }

  return operations;
}

function parseApplyPatch(patchText, root = "/workspace") {
  const lines = parsePatchLines(extractPatchEnvelope(patchText));
  let cursor = 0;

  if (lines[cursor] !== "*** Begin Patch") {
    throw new Error("The first line of the patch must be '*** Begin Patch'.");
  }
  cursor += 1;

  const endPatchIndex = lines.lastIndexOf("*** End Patch");
  const bodyLines = endPatchIndex === -1 ? lines.slice(cursor) : lines.slice(cursor, endPatchIndex);
  if (looksLikeUnifiedDiffBody(bodyLines)) {
    return parseUnifiedDiff(bodyLines, root);
  }

  const operations = [];

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const headerLine = line;
      const path = ensureRelativePath(line.slice("*** Add File: ".length), root);
      cursor += 1;
      const sectionLines = [headerLine];
      const contentLines = [];

      while (cursor < lines.length) {
        const nextLine = lines[cursor];
        if (nextLine.startsWith("*** ")) {
          break;
        }
        if (!nextLine.startsWith("+")) {
          throw new Error(`Added file ${path} contains an invalid line: ${nextLine}`);
        }
        sectionLines.push(nextLine);
        contentLines.push(nextLine.slice(1));
        cursor += 1;
      }

      operations.push({
        type: "add",
        path,
        content: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "",
        diff: createDiffText(sectionLines),
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const path = ensureRelativePath(line.slice("*** Delete File: ".length), root);
      operations.push({
        type: "delete",
        path,
        diff: createDiffText([line]),
      });
      cursor += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const sectionLines = [line];
      const path = ensureRelativePath(line.slice("*** Update File: ".length), root);
      cursor += 1;

      let movePath = null;
      if (lines[cursor]?.startsWith("*** Move to: ")) {
        movePath = ensureRelativePath(lines[cursor].slice("*** Move to: ".length), root);
        sectionLines.push(lines[cursor]);
        cursor += 1;
      }

      const hunks = [];
      while (cursor < lines.length) {
        const nextLine = lines[cursor];
        if (nextLine === "*** End Patch" || nextLine.startsWith("*** Add File: ") || nextLine.startsWith("*** Delete File: ") || nextLine.startsWith("*** Update File: ")) {
          break;
        }
        if (!nextLine.startsWith("@@")) {
          throw new Error(`Update for ${path} is missing a hunk header near: ${nextLine}`);
        }

        const hunkLines = [nextLine];
        const diffLines = [];
        cursor += 1;

        while (cursor < lines.length) {
          const hunkLine = lines[cursor];
          if (hunkLine === "*** End of File") {
            hunkLines.push(hunkLine);
            cursor += 1;
            break;
          }
          if (hunkLine.startsWith("@@") || hunkLine === "*** End Patch" || hunkLine.startsWith("*** Add File: ") || hunkLine.startsWith("*** Delete File: ") || hunkLine.startsWith("*** Update File: ")) {
            break;
          }
          const prefix = hunkLine[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            throw new Error(`Invalid patch line for ${path}: ${hunkLine}`);
          }
          diffLines.push({
            kind: prefix,
            text: hunkLine.slice(1),
          });
          hunkLines.push(hunkLine);
          cursor += 1;
        }

        sectionLines.push(...hunkLines);
        hunks.push({
          header: nextLine,
          diffLines,
        });
      }

      operations.push({
        type: "update",
        path,
        movePath,
        hunks,
        diff: createDiffText(sectionLines),
      });
      continue;
    }

    throw new Error(`Unsupported patch operation: ${line}`);
  }

  throw new Error("The patch is missing the '*** End Patch' marker.");
}

function splitTextContent(text) {
  if (!text) {
    return {
      lines: [],
      trailingNewline: false,
    };
  }

  if (text.endsWith("\n")) {
    const body = text.slice(0, -1);
    return {
      lines: body ? body.split("\n") : [],
      trailingNewline: true,
    };
  }

  return {
    lines: text.split("\n"),
    trailingNewline: false,
  };
}

function joinTextContent(lines, trailingNewline) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return "";
  }

  const text = lines.join("\n");
  return trailingNewline ? `${text}\n` : text;
}

function findMatchingIndex(lines, sourceLines, startIndex) {
  const lastCandidate = lines.length - sourceLines.length;
  for (let index = Math.max(startIndex, 0); index <= lastCandidate; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sourceLines.length; offset += 1) {
      if (lines[index + offset] !== sourceLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

function applyUpdateHunks(content, hunks, path) {
  const { lines: originalLines, trailingNewline } = splitTextContent(content);
  const nextLines = [...originalLines];
  let cursor = 0;

  for (const hunk of hunks) {
    const sourceLines = [];
    const replacementLines = [];

    for (const line of hunk.diffLines) {
      if (line.kind === " " || line.kind === "-") {
        sourceLines.push(line.text);
      }
      if (line.kind === " " || line.kind === "+") {
        replacementLines.push(line.text);
      }
    }

    if (sourceLines.length === 0) {
      throw new Error(`Patch hunk for ${path} has no anchor lines and cannot be applied safely.`);
    }

    let matchIndex = findMatchingIndex(nextLines, sourceLines, cursor);
    if (matchIndex === -1 && cursor > 0) {
      matchIndex = findMatchingIndex(nextLines, sourceLines, 0);
    }
    if (matchIndex === -1) {
      throw new Error(`Failed to apply patch to ${path}; hunk context was not found.`);
    }

    nextLines.splice(matchIndex, sourceLines.length, ...replacementLines);
    cursor = matchIndex + replacementLines.length;
  }

  return joinTextContent(nextLines, trailingNewline);
}

async function readExistingFile(workspaceStore, thread, path) {
  try {
    const result = await workspaceStore.readFile(thread, path);
    return result.file.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("was not found")) {
      return null;
    }
    throw error;
  }
}

function summarizePatchOperations(operations) {
  if (operations.length === 0) {
    return "Success. No file changes were applied.\n";
  }

  const lines = operations.map((operation) => {
    switch (operation.type) {
      case "add":
        return `A ${operation.path}`;
      case "delete":
        return `D ${operation.path}`;
      case "update":
        return operation.movePath ? `M ${operation.path} -> ${operation.movePath}` : `M ${operation.path}`;
      default:
        return operation.path;
    }
  });

  return `Success. Updated the following files:\n${lines.join("\n")}\n`;
}

function toFileChange(operation) {
  switch (operation.type) {
    case "add":
      return {
        path: operation.path,
        kind: { type: "add" },
        diff: operation.diff,
      };
    case "delete":
      return {
        path: operation.path,
        kind: { type: "delete" },
        diff: operation.diff,
      };
    case "update":
      return {
        path: operation.path,
        kind: {
          type: "update",
          move_path: operation.movePath ?? null,
        },
        diff: operation.diff,
      };
    default:
      return null;
  }
}

export async function applyPatchToWorkspace({
  thread,
  patchText,
  workspaceStore,
}) {
  const workspaceRoot = normalizeRoot(thread.workspace?.root ?? thread.cwd ?? "/workspace");
  const operations = parseApplyPatch(patchText, workspaceRoot);

  for (const operation of operations) {
    if (operation.type === "add") {
      const targetPath = joinWorkspacePath(workspaceRoot, operation.path);
      const existing = await readExistingFile(workspaceStore, thread, targetPath);
      if (existing !== null) {
        throw new Error(`Cannot add ${operation.path}; the file already exists.`);
      }
      const result = await workspaceStore.writeFile(thread, targetPath, operation.content);
      thread.workspace = structuredClone(invalidateWorkspaceHydration(result.workspace));
      continue;
    }

    if (operation.type === "delete") {
      const targetPath = joinWorkspacePath(workspaceRoot, operation.path);
      const existing = await readExistingFile(workspaceStore, thread, targetPath);
      if (existing === null) {
        throw new Error(`Cannot delete ${operation.path}; the file does not exist.`);
      }
      const result = await workspaceStore.deleteFile(thread, targetPath);
      thread.workspace = structuredClone(invalidateWorkspaceHydration(result.workspace));
      continue;
    }

    if (operation.type === "update") {
      const sourcePath = joinWorkspacePath(workspaceRoot, operation.path);
      const original = await readExistingFile(workspaceStore, thread, sourcePath);
      if (original === null) {
        throw new Error(`Cannot update ${operation.path}; the file does not exist.`);
      }

      const nextContent = operation.hunks.length > 0
        ? applyUpdateHunks(original, operation.hunks, operation.path)
        : original;

      const targetPath = operation.movePath
        ? joinWorkspacePath(workspaceRoot, operation.movePath)
        : sourcePath;

      const writeResult = await workspaceStore.writeFile(thread, targetPath, nextContent);
      thread.workspace = structuredClone(invalidateWorkspaceHydration(writeResult.workspace));

      if (operation.movePath && targetPath !== sourcePath) {
        const deleteResult = await workspaceStore.deleteFile(thread, sourcePath);
        thread.workspace = structuredClone(invalidateWorkspaceHydration(deleteResult.workspace));
      }
      continue;
    }
  }

  return {
    workspace: thread.workspace ? structuredClone(thread.workspace) : null,
    changes: operations.map(toFileChange).filter(Boolean),
    outputText: summarizePatchOperations(operations),
  };
}
