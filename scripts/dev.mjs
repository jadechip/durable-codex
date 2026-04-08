import { spawn } from "node:child_process";

const port = process.env.APP_SERVER_PORT || process.env.PORT || "8787";
const host = process.env.APP_SERVER_HOST || "127.0.0.1";

const child = spawn(
  "npx",
  ["wrangler", "dev", "--config", "wrangler.jsonc", "--ip", host, "--port", port],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
