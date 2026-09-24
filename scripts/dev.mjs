// Starts the local API (127.0.0.1:8787) and the web UI (127.0.0.1:5173) together.
// Ctrl+C stops both. Equivalent to running `npm run dev:server` and `npm run dev:web` in two terminals.
import { spawn } from "node:child_process";

const procs = [
  ["api", ["run", "dev:server"]],
  ["web", ["run", "dev:web"]],
].map(([name, args]) => {
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join("\n") + "\n";
  p.stdout.on("data", (c) => process.stdout.write(prefix(c)));
  p.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  p.on("exit", (code) => {
    console.log(`[${name}] stopped (exit ${code ?? 0})`);
    stop();
  });
  return p;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode !== null || !p.pid) continue;
    // On Windows, npm runs through a shell; kill the whole tree so vite/tsx do not linger.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("[app] open http://127.0.0.1:5173 once both are up (Ctrl+C stops both)");
