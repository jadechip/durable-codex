export const DEFAULT_WORKSPACE_ROOT = "/workspace";

const MANIFEST_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function cloneBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes);
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes.slice(0));
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return null;
}

function encodeUtf8(text) {
  return textEncoder.encode(typeof text === "string" ? text : String(text ?? ""));
}

function decodeUtf8(bytes) {
  return textDecoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array());
}

function bytesToBase64(bytes) {
  const normalized = cloneBytes(bytes) ?? new Uint8Array();
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized).toString("base64");
  }
  let binary = "";
  for (const byte of normalized) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !value) {
    return new Uint8Array();
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeContentEncoding(value) {
  return value === "base64" ? "base64" : "utf8";
}

function unixTimestampSeconds(nowMs) {
  return Math.floor(nowMs / 1000);
}

function normalizeRoot(root) {
  const value = typeof root === "string" && root.trim() ? root.trim() : DEFAULT_WORKSPACE_ROOT;
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const normalized = withLeadingSlash.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment);
}

function manifestStorageKey(workspaceId) {
  return `vfs/workspaces/${workspaceId}/manifest.json`;
}

function fileStorageKey(workspaceId, relativePath) {
  const encodedPath = relativePath.split("/").map(encodePathSegment).join("/");
  return `vfs/workspaces/${workspaceId}/files/${encodedPath}`;
}

function joinWorkspacePath(root, relativePath = "") {
  const normalizedRoot = normalizeRoot(root);
  if (!relativePath) {
    return normalizedRoot;
  }
  return `${normalizedRoot}/${relativePath}`;
}

function normalizeRelativePath(root, inputPath, { allowRoot = false } = {}) {
  const normalizedRoot = normalizeRoot(root);
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    if (allowRoot) {
      return "";
    }
    throw new Error("A workspace path is required.");
  }

  const trimmed = inputPath.trim().replace(/\/+/g, "/");
  let candidate = trimmed;

  if (trimmed === normalizedRoot) {
    candidate = "";
  } else if (trimmed.startsWith(`${normalizedRoot}/`)) {
    candidate = trimmed.slice(normalizedRoot.length + 1);
  } else if (trimmed.startsWith("/")) {
    throw new Error(`Path ${trimmed} is outside workspace root ${normalizedRoot}.`);
  }

  const segments = candidate.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Path ${inputPath} is invalid.`);
    }
  }

  const relativePath = segments.join("/");
  if (!relativePath && !allowRoot) {
    throw new Error("The workspace root is not a file path.");
  }
  return relativePath;
}

function detectTextContentType(path) {
  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (path.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }
  if (path.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (path.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    return "text/plain; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function detectContentType(path, contentEncoding = "utf8") {
  if (normalizeContentEncoding(contentEncoding) === "base64") {
    return "application/octet-stream";
  }
  return detectTextContentType(path);
}

async function sha256Hex(bytes) {
  const normalized = cloneBytes(bytes) ?? encodeUtf8(bytes);
  const digest = await crypto.subtle.digest("SHA-256", normalized);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeFilePayload(path, {
  content = null,
  contentBase64 = null,
  contentEncoding = null,
  contentType = null,
} = {}) {
  const normalizedEncoding = normalizeContentEncoding(contentEncoding ?? (typeof contentBase64 === "string" ? "base64" : "utf8"));
  const bytes = normalizedEncoding === "base64"
    ? base64ToBytes(contentBase64)
    : encodeUtf8(content);

  return {
    bytes,
    contentEncoding: normalizedEncoding,
    contentType:
      typeof contentType === "string" && contentType
        ? contentType
        : detectContentType(path, normalizedEncoding),
  };
}

function decodeFilePayload(bytes, entry) {
  const contentEncoding = normalizeContentEncoding(entry?.contentEncoding);
  if (contentEncoding === "base64") {
    return {
      content: null,
      contentBase64: bytesToBase64(bytes),
      contentEncoding,
      isBinary: true,
    };
  }
  return {
    content: decodeUtf8(bytes),
    contentBase64: null,
    contentEncoding,
    isBinary: false,
  };
}

function cloneFileEntry(entry) {
  return {
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    updatedAt: entry.updatedAt,
    contentType: entry.contentType,
    contentEncoding: normalizeContentEncoding(entry.contentEncoding),
  };
}

function cloneWorkspaceFile(file) {
  return {
    path: file.path,
    content: typeof file.content === "string" ? file.content : null,
    contentBase64: typeof file.contentBase64 === "string" ? file.contentBase64 : null,
    contentEncoding: normalizeContentEncoding(file.contentEncoding),
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256,
    updatedAt: file.updatedAt,
  };
}

function ensureManifestShape(manifest, workspace, nowMs) {
  const base = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? structuredClone(manifest)
    : {};
  const createdAtMs = Number.isFinite(base.createdAtMs) ? base.createdAtMs : nowMs;
  const updatedAtMs = Number.isFinite(base.updatedAtMs) ? base.updatedAtMs : createdAtMs;
  const files = {};

  if (base.files && typeof base.files === "object" && !Array.isArray(base.files)) {
    for (const [relativePath, entry] of Object.entries(base.files)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      files[relativePath] = {
        path: relativePath,
        size: Number.isFinite(entry.size) ? entry.size : 0,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : unixTimestampSeconds(updatedAtMs),
        contentType:
          typeof entry.contentType === "string" && entry.contentType
            ? entry.contentType
            : detectContentType(relativePath, entry.contentEncoding),
        contentEncoding: normalizeContentEncoding(entry.contentEncoding),
      };
    }
  }

  return {
    version: MANIFEST_VERSION,
    workspaceId: workspace.id,
    root: workspace.root,
    revision: Number.isFinite(base.revision) ? base.revision : 0,
    createdAtMs,
    updatedAtMs,
    files,
  };
}

function summarizeManifest(manifest) {
  let byteSize = 0;
  let fileCount = 0;
  for (const entry of Object.values(manifest.files)) {
    fileCount += 1;
    byteSize += Number.isFinite(entry.size) ? entry.size : 0;
  }
  return { fileCount, byteSize };
}

function workspaceBackendFromStoreKind(kind) {
  switch (kind) {
    case "r2":
      return "r2VirtualFilesystem";
    case "durableObjectStorage":
      return "durableObjectVirtualFilesystem";
    default:
      return "memoryVirtualFilesystem";
  }
}

function createWorkspaceMetadata(workspace, manifest, backend, nowMs) {
  const summary = summarizeManifest(manifest);
  const createdAt = Number.isFinite(workspace.createdAt)
    ? workspace.createdAt
    : unixTimestampSeconds(manifest.createdAtMs ?? nowMs);
  const updatedAt = unixTimestampSeconds(manifest.updatedAtMs ?? nowMs);

  return {
    id: workspace.id,
    root: manifest.root,
    mode: "virtual",
    backend,
    sourceOfTruth:
      backend === "r2VirtualFilesystem"
        ? "r2"
        : backend === "durableObjectVirtualFilesystem"
          ? "durableObject"
          : "memory",
    revision: manifest.revision,
    fileCount: summary.fileCount,
    byteSize: summary.byteSize,
    status: "ready",
    createdAt,
    updatedAt,
    attachedSandboxId:
      typeof workspace.attachedSandboxId === "string" && workspace.attachedSandboxId
        ? workspace.attachedSandboxId
        : null,
    hydratedRevision: Number.isFinite(workspace.hydratedRevision) ? workspace.hydratedRevision : null,
  };
}

function createMemoryObjectStore() {
  const values = new Map();
  return {
    kind: "memory",
    async getJson(key) {
      const value = values.get(key);
      return value == null ? null : structuredClone(value);
    },
    async putJson(key, value) {
      values.set(key, structuredClone(value));
    },
    async getText(key) {
      const value = values.get(key);
      if (typeof value === "string") {
        return value;
      }
      const bytes = cloneBytes(value);
      return bytes ? decodeUtf8(bytes) : null;
    },
    async putText(key, value) {
      values.set(key, value);
    },
    async getBytes(key) {
      const value = values.get(key);
      if (typeof value === "string") {
        return encodeUtf8(value);
      }
      return cloneBytes(value);
    },
    async putBytes(key, value) {
      const bytes = cloneBytes(value) ?? new Uint8Array();
      values.set(key, bytes);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function createDurableObjectObjectStore(storage) {
  return {
    kind: "durableObjectStorage",
    async getJson(key) {
      const value = await storage.get(key);
      return value == null ? null : structuredClone(value);
    },
    async putJson(key, value) {
      await storage.put(key, structuredClone(value));
    },
    async getText(key) {
      const value = await storage.get(key);
      if (typeof value === "string") {
        return value;
      }
      const bytes = cloneBytes(value);
      return bytes ? decodeUtf8(bytes) : null;
    },
    async putText(key, value) {
      await storage.put(key, value);
    },
    async getBytes(key) {
      const value = await storage.get(key);
      if (typeof value === "string") {
        return encodeUtf8(value);
      }
      return cloneBytes(value);
    },
    async putBytes(key, value) {
      const bytes = cloneBytes(value) ?? new Uint8Array();
      await storage.put(key, bytes);
    },
    async delete(key) {
      await storage.delete(key);
    },
  };
}

function createR2ObjectStore(bucket) {
  return {
    kind: "r2",
    async getJson(key) {
      const object = await bucket.get(key);
      if (!object) {
        return null;
      }
      return object.json();
    },
    async putJson(key, value) {
      await bucket.put(key, JSON.stringify(value, null, 2), {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
        },
      });
    },
    async getText(key) {
      const object = await bucket.get(key);
      if (!object) {
        return null;
      }
      return object.text();
    },
    async putText(key, value, contentType = "text/plain; charset=utf-8") {
      await bucket.put(key, value, {
        httpMetadata: {
          contentType,
        },
      });
    },
    async getBytes(key) {
      const object = await bucket.get(key);
      if (!object) {
        return null;
      }
      return new Uint8Array(await object.arrayBuffer());
    },
    async putBytes(key, value, contentType = "application/octet-stream") {
      const bytes = cloneBytes(value) ?? new Uint8Array();
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType,
        },
      });
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export function createWorkspaceRecord({
  workspaceId = null,
  threadId,
  cwd,
  workspace = null,
  backend = "memoryVirtualFilesystem",
  nowMs = Date.now(),
} = {}) {
  const input = workspace && typeof workspace === "object" && !Array.isArray(workspace)
    ? workspace
    : {};
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : unixTimestampSeconds(nowMs);

  return {
    id:
      typeof input.id === "string" && input.id
        ? input.id
        : typeof workspaceId === "string" && workspaceId
          ? workspaceId
          : "default",
    root: normalizeRoot(typeof input.root === "string" && input.root ? input.root : cwd),
    mode: "virtual",
    backend: typeof input.backend === "string" && input.backend ? input.backend : backend,
    sourceOfTruth:
      typeof input.sourceOfTruth === "string" && input.sourceOfTruth
        ? input.sourceOfTruth
        : backend === "r2VirtualFilesystem"
          ? "r2"
          : backend === "durableObjectVirtualFilesystem"
            ? "durableObject"
            : "memory",
    revision: Number.isFinite(input.revision) ? input.revision : 0,
    fileCount: Number.isFinite(input.fileCount) ? input.fileCount : 0,
    byteSize: Number.isFinite(input.byteSize) ? input.byteSize : 0,
    status: typeof input.status === "string" && input.status ? input.status : "ready",
    createdAt,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : createdAt,
    attachedSandboxId:
      typeof input.attachedSandboxId === "string" && input.attachedSandboxId
        ? input.attachedSandboxId
        : null,
    hydratedRevision: Number.isFinite(input.hydratedRevision) ? input.hydratedRevision : null,
  };
}

export function attachWorkspaceSandbox(workspace, sandboxId = null) {
  if (!workspace || typeof workspace !== "object") {
    return workspace;
  }
  return {
    ...workspace,
    attachedSandboxId:
      typeof sandboxId === "string" && sandboxId
        ? sandboxId
        : workspace.attachedSandboxId ?? null,
  };
}

export function invalidateWorkspaceHydration(workspace) {
  if (!workspace || typeof workspace !== "object") {
    return workspace;
  }
  return {
    ...workspace,
    hydratedRevision: null,
  };
}

export function markWorkspaceHydrated(workspace, {
  sandboxId = null,
  revision = null,
} = {}) {
  if (!workspace || typeof workspace !== "object") {
    return workspace;
  }
  return {
    ...workspace,
    attachedSandboxId:
      typeof sandboxId === "string" && sandboxId
        ? sandboxId
        : workspace.attachedSandboxId ?? null,
    hydratedRevision: Number.isFinite(revision) ? revision : null,
  };
}

export function buildWorkspaceResponse(workspace) {
  return workspace ? structuredClone(workspace) : null;
}

export function createWorkspaceStore({
  bucket = null,
  localStorage = null,
  objectStore = null,
  now = () => Date.now(),
} = {}) {
  const storage =
    objectStore ??
    (bucket
      ? createR2ObjectStore(bucket)
      : localStorage
        ? createDurableObjectObjectStore(localStorage)
        : createMemoryObjectStore());
  const backend = workspaceBackendFromStoreKind(storage.kind);

  async function loadManifest(workspace) {
    const key = manifestStorageKey(workspace.id);
    const existing = await storage.getJson(key);
    const manifest = ensureManifestShape(existing, workspace, now());
    if (!existing) {
      await storage.putJson(key, manifest);
    }
    return manifest;
  }

  async function saveManifest(workspace, manifest) {
    await storage.putJson(manifestStorageKey(workspace.id), manifest);
  }

  async function ensureWorkspace(thread) {
    const workspace = createWorkspaceRecord({
      workspaceId: thread.workspace?.id ?? thread.workspaceId ?? null,
      threadId: thread.id,
      cwd: thread.workspace?.root ?? thread.cwd,
      workspace: thread.workspace,
      backend,
      nowMs: now(),
    });
    const manifest = await loadManifest(workspace);
    return createWorkspaceMetadata(workspace, manifest, backend, now());
  }

  async function readWorkspace(thread) {
    return ensureWorkspace(thread);
  }

  async function listFiles(thread, path = null, { recursive = false, limit = 200 } = {}) {
    const workspace = await ensureWorkspace(thread);
    const manifest = await loadManifest(workspace);
    const relativePath = normalizeRelativePath(workspace.root, path ?? workspace.root, { allowRoot: true });
    const prefix = relativePath ? `${relativePath}/` : "";
    const directories = new Map();
    const files = [];

    for (const entry of Object.values(manifest.files)) {
      if (relativePath && entry.path !== relativePath && !entry.path.startsWith(prefix)) {
        continue;
      }

      if (recursive) {
        files.push({
          type: "file",
          path: joinWorkspacePath(workspace.root, entry.path),
          ...cloneFileEntry(entry),
        });
        continue;
      }

      const remainder = relativePath && entry.path === relativePath
        ? entry.path.split("/").slice(-1)[0]
        : relativePath
          ? entry.path.slice(prefix.length)
          : entry.path;
      const segments = remainder.split("/").filter(Boolean);

      if (segments.length <= 1) {
        files.push({
          type: "file",
          path: joinWorkspacePath(workspace.root, entry.path),
          ...cloneFileEntry(entry),
        });
        continue;
      }

      const directoryRelativePath = relativePath
        ? `${relativePath}/${segments[0]}`
        : segments[0];
      if (!directories.has(directoryRelativePath)) {
        directories.set(directoryRelativePath, {
          type: "directory",
          path: joinWorkspacePath(workspace.root, directoryRelativePath),
          name: segments[0],
        });
      }
    }

    const entries = [
      ...Array.from(directories.values()).sort((left, right) => left.path.localeCompare(right.path)),
      ...files.sort((left, right) => left.path.localeCompare(right.path)),
    ].slice(0, limit);

    return {
      workspace,
      path: relativePath ? joinWorkspacePath(workspace.root, relativePath) : workspace.root,
      recursive: Boolean(recursive),
      entries,
    };
  }

  async function readFile(thread, path) {
    const workspace = await ensureWorkspace(thread);
    const manifest = await loadManifest(workspace);
    const relativePath = normalizeRelativePath(workspace.root, path);
    const entry = manifest.files[relativePath];
    if (!entry) {
      throw new Error(`File ${joinWorkspacePath(workspace.root, relativePath)} was not found.`);
    }
    const bytes = await storage.getBytes(fileStorageKey(workspace.id, relativePath));
    if (bytes == null) {
      throw new Error(`File contents for ${joinWorkspacePath(workspace.root, relativePath)} are unavailable.`);
    }
    const decoded = decodeFilePayload(bytes, entry);
    return {
      workspace,
      file: {
        ...cloneFileEntry(entry),
        path: joinWorkspacePath(workspace.root, relativePath),
        ...decoded,
      },
    };
  }

  async function exportWorkspaceSnapshot(thread, { path = null } = {}) {
    const workspace = await ensureWorkspace(thread);
    const manifest = await loadManifest(workspace);
    const relativePath = normalizeRelativePath(workspace.root, path ?? workspace.root, { allowRoot: true });
    const prefix = relativePath ? `${relativePath}/` : "";
    const selectedEntries = Object.values(manifest.files)
      .filter((entry) => !relativePath || entry.path === relativePath || entry.path.startsWith(prefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    const files = [];

    for (const entry of selectedEntries) {
      const bytes = await storage.getBytes(fileStorageKey(workspace.id, entry.path));
      if (bytes == null) {
        continue;
      }
      const decoded = decodeFilePayload(bytes, entry);
      files.push({
        path: joinWorkspacePath(workspace.root, entry.path),
        relativePath: entry.path,
        ...decoded,
        contentType: entry.contentType,
        size: entry.size,
        sha256: entry.sha256,
        updatedAt: entry.updatedAt,
      });
    }

    return {
      workspace,
      root: relativePath ? joinWorkspacePath(workspace.root, relativePath) : workspace.root,
      files: files.map((file) => structuredClone(file)),
    };
  }

  async function writeFile(thread, path, content, contentType = null, options = {}) {
    const workspace = await ensureWorkspace(thread);
    const manifest = await loadManifest(workspace);
    const relativePath = normalizeRelativePath(workspace.root, path);
    const payload = normalizeFilePayload(relativePath, {
      content,
      contentBase64: options.contentBase64 ?? null,
      contentEncoding: options.contentEncoding ?? null,
      contentType,
    });
    const nowMs = now();
    const updatedAt = unixTimestampSeconds(nowMs);
    const entry = {
      path: relativePath,
      size: payload.bytes.byteLength,
      sha256: await sha256Hex(payload.bytes),
      updatedAt,
      contentType: payload.contentType,
      contentEncoding: payload.contentEncoding,
    };

    await storage.putBytes(fileStorageKey(workspace.id, relativePath), payload.bytes, entry.contentType);

    manifest.files[relativePath] = entry;
    manifest.revision += 1;
    manifest.updatedAtMs = nowMs;
    await saveManifest(workspace, manifest);

    return {
      workspace: createWorkspaceMetadata(workspace, manifest, backend, nowMs),
      file: {
        ...cloneFileEntry(entry),
        path: joinWorkspacePath(workspace.root, relativePath),
      },
    };
  }

  async function deleteFile(thread, path, { recursive = false } = {}) {
    const workspace = await ensureWorkspace(thread);
    const manifest = await loadManifest(workspace);
    const relativePath = normalizeRelativePath(workspace.root, path);
    const exactMatch = manifest.files[relativePath];
    const prefix = `${relativePath}/`;
    const descendantPaths = Object.keys(manifest.files).filter((entryPath) => entryPath.startsWith(prefix));

    if (!exactMatch && descendantPaths.length === 0) {
      throw new Error(`Path ${joinWorkspacePath(workspace.root, relativePath)} was not found.`);
    }

    if (!exactMatch && descendantPaths.length > 0 && !recursive) {
      throw new Error(`Path ${joinWorkspacePath(workspace.root, relativePath)} is a directory. Pass recursive=true to delete it.`);
    }

    const pathsToDelete = exactMatch
      ? [relativePath]
      : descendantPaths;

    for (const filePath of pathsToDelete) {
      delete manifest.files[filePath];
      await storage.delete(fileStorageKey(workspace.id, filePath));
    }

    manifest.revision += 1;
    manifest.updatedAtMs = now();
    await saveManifest(workspace, manifest);

    return {
      workspace: createWorkspaceMetadata(workspace, manifest, backend, now()),
      deleted: pathsToDelete.map((filePath) => joinWorkspacePath(workspace.root, filePath)),
    };
  }

  async function applyWorkspaceFiles(thread, files, { removePaths = [] } = {}) {
    const workspace = await ensureWorkspace(thread);
    for (const file of Array.isArray(files) ? files : []) {
      if (!file || typeof file !== "object") {
        continue;
      }
      await writeFile(
        thread,
        typeof file.path === "string" && file.path ? file.path : joinWorkspacePath(workspace.root, file.relativePath ?? ""),
        typeof file.content === "string" ? file.content : "",
        typeof file.contentType === "string" && file.contentType ? file.contentType : null,
        {
          contentBase64: typeof file.contentBase64 === "string" ? file.contentBase64 : null,
          contentEncoding: typeof file.contentEncoding === "string" ? file.contentEncoding : null,
        },
      );
    }

    for (const path of Array.isArray(removePaths) ? removePaths : []) {
      if (typeof path !== "string" || !path) {
        continue;
      }
      await deleteFile(thread, path, { recursive: true });
    }

    const nextWorkspace = await ensureWorkspace(thread);
    return {
      workspace: nextWorkspace,
      files: (Array.isArray(files) ? files : []).map((file) => cloneWorkspaceFile(file)),
      removed: Array.isArray(removePaths) ? [...removePaths] : [],
    };
  }

  return {
    kind: backend,
    ensureWorkspace,
    readWorkspace,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    exportWorkspaceSnapshot,
    applyWorkspaceFiles,
  };
}
