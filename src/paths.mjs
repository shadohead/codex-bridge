import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function bridgeHome() {
  return process.env.CODEXCTL_HOME || path.join(os.homedir(), ".codex-bridge");
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Control socket of the shared app-server daemon (same default as `codex app-server proxy`). */
export function socketPath() {
  return process.env.CODEXCTL_SOCKET || path.join(codexHome(), "app-server-control", "app-server-control.sock");
}

export function registryFile() {
  return path.join(bridgeHome(), "agents.json");
}

export function locksDir() {
  return path.join(bridgeHome(), "locks");
}

export function daemonLogFile() {
  return path.join(bridgeHome(), "daemon.log");
}

export function daemonPidFile() {
  return path.join(bridgeHome(), "daemon.pid");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Resolve the codex binary: $CODEXCTL_CODEX_BIN, then PATH, then ~/.local/bin/codex. */
export function codexBin() {
  if (process.env.CODEXCTL_CODEX_BIN) return process.env.CODEXCTL_CODEX_BIN;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "codex");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "codex");
  return fallback;
}
