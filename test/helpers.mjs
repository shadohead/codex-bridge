import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeDaemon } from "./fake-daemon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.join(here, "..", "bin", "codexctl");
export const FAKE_CODEX = path.join(here, "fake-codex");

export function tmpDir(prefix = "codexctl-test-") {
  // unix socket paths are short-limited on macOS, so keep it under /tmp
  return fs.mkdtempSync(path.join("/tmp", prefix));
}

/** A fake daemon + an isolated CODEXCTL_HOME. */
export async function setup() {
  const dir = tmpDir();
  const sock = path.join(dir, "d.sock");
  const daemon = await startFakeDaemon(sock);
  const env = { CODEXCTL_HOME: path.join(dir, "home"), CODEXCTL_SOCKET: sock, CODEXCTL_DAEMON_START_TIMEOUT_MS: "2000" };
  return {
    dir,
    sock,
    env,
    daemon,
    run: (args, opts = {}) => run(args, { ...opts, env: { ...env, ...(opts.env ?? {}) } }),
    async cleanup() {
      await daemon.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function run(args, { env = {}, input = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
