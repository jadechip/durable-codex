import { WORKER_COMMAND_WASM_BASE64 } from "./generated/worker-command-wasm.generated.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let instancePromise = null;

function shouldUseBundledWorkerModule() {
  return typeof WebSocketPair === "function";
}

function decodeBase64(base64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function instantiate() {
  if (!instancePromise) {
    instancePromise = (async () => {
      if (shouldUseBundledWorkerModule()) {
        try {
          const imported = await import("./generated/worker-command.wasm");
          const module = imported?.default ?? imported;
          if (module instanceof WebAssembly.Module) {
            return new WebAssembly.Instance(module, {});
          }
          if (module?.instance) {
            return module.instance;
          }
        } catch {}
      }

      const bytes = decodeBase64(WORKER_COMMAND_WASM_BASE64);
      const result = await WebAssembly.instantiate(bytes, {});
      return result.instance;
    })();
  }
  return instancePromise;
}

function unpackPtrLen(packed) {
  const value = typeof packed === "bigint" ? packed : BigInt(packed);
  return {
    ptr: Number(value >> 32n),
    len: Number(value & 0xffffffffn),
  };
}

function writeInput(memory, alloc, input) {
  const bytes = encoder.encode(JSON.stringify(input));
  const ptr = Number(alloc(bytes.length));
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length };
}

function readOutput(memory, ptr, len) {
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return decoder.decode(bytes.slice());
}

export async function executeWorkerCommandInWasm(input) {
  const instance = await instantiate();
  const { memory, alloc, dealloc, execute_command: executeCommand } = instance.exports;
  const inputBuffer = writeInput(memory, alloc, input);

  try {
    const packed = executeCommand(inputBuffer.ptr, inputBuffer.len);
    const { ptr, len } = unpackPtrLen(packed);
    const json = readOutput(memory, ptr, len);
    dealloc(ptr, len);
    return JSON.parse(json);
  } finally {
    dealloc(inputBuffer.ptr, inputBuffer.len);
  }
}
