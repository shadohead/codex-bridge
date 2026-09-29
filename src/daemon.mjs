// Finding / starting the shared local Codex app-server daemon.
//
// `codex app-server daemon start` is the official way, but it needs the "standalone" Codex install.
// When that is missing (e.g. Codex was installed through npm) we start
// `codex app-server --listen unix://` ourselves, detached, on the same default control socket -
// it is the very same server, and `codex agents` / `codex app-server proxy` talk to that socket too.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { RpcClient } from "./rpc.mjs";
import { socketPath, codexBin, daemonLogFile, daemonPidFile, locksDir, bridgeHome, ensureDir } from "./paths.mjs";
import { withLock } from "./lock.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startTimeoutMs = () => Number(process.env.CODEXCTL_DAEMON_START_TIMEOUT_MS) || 20000;

/** Credentials of *other* tools should not leak into the environment agents' shell commands inherit. */
const SCRUB_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
function daemonEnv() {
  const env = { ...process.env };
  for (const k of SCRUB_ENV) delete env[k];
  return env;
}

export const CLIENT_INFO = { name: "codexctl", title: "codexctl (Claude Code bridge)", version: "0.1.0" };

/** Try one connection; resolves to a connected client or null. */
export async function tryConnect(opts = {}) {
  try {
    return await RpcClient.connect(socketPath(), { clientInfo: CLIENT_INFO, timeoutMs: 4000, ...opts });
  } catch {
    return null;
  }
}

function readPid() {
  try {
    return parseInt(fs.readFileSync(daemonPidFile(), "utf8"), 10) || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function tailLog(n = 8) {
  try {
    return fs.readFileSync(daemonLogFile(), "utf8").trim().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function pollConnect(totalMs) {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    const c = await tryConnect();
    if (c) {
      c.close();
      return true;
    }
    await sleep(250);
  }
  return false;
}

/**
 * Make sure a daemon is accepting connections on the control socket.
 * Returns {started: boolean, how?: string, pid?: number}. Throws with a helpful message on failure.
 */
export async function ensureDaemon({ onStart } = {}) {
  const probe = await tryConnect();
  if (probe) {
    probe.close();
    return { started: false };
  }
  ensureDir(bridgeHome());
  try {
    fs.chmodSync(bridgeHome(), 0o700);
  } catch {}
  return withLock(path.join(locksDir(), "daemon.lock"), async () => {
    // Someone else may have started it while we waited for the lock.
    const again = await tryConnect();
    if (again) {
      again.close();
      return { started: false };
    }
    const bin = codexBin();
    const custom = process.env.CODEXCTL_SOCKET;
    // 1. the official managed daemon (only with the standalone install, and only for the default socket)
    if (!custom) {
      const r = spawnSync(bin, ["app-server", "daemon", "start"], { encoding: "utf8", timeout: 30000, env: daemonEnv() });
      if (r.status === 0 && (await pollConnect(8000))) {
        onStart?.({ how: "codex app-server daemon start" });
        return { started: true, how: "managed" };
      }
    }
    // 2. our own detached `codex app-server --listen unix://`
    const listen = custom ? `unix://${custom}` : "unix://";
    const out = fs.openSync(daemonLogFile(), "a", 0o600);
    fs.writeSync(out, `\n--- ${new Date().toISOString()} starting: codex app-server --listen ${listen}\n`);
    const child = spawn(bin, ["app-server", "--listen", listen], {
      detached: true,
      stdio: ["ignore", out, out],
      env: daemonEnv(),
      cwd: process.env.HOME || "/",
    });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(out);
    if (child.pid) fs.writeFileSync(daemonPidFile(), `${child.pid}\n`, { mode: 0o600 });
    if (await pollConnect(startTimeoutMs())) {
      onStart?.({ how: "codex app-server --listen unix://", pid: child.pid });
      return { started: true, how: "own", pid: child.pid };
    }
    throw new Error(
      `could not reach or start the codex app-server daemon (socket ${socketPath()}).\n` +
        `Tried: codex app-server daemon start, codex app-server --listen ${listen}.\n` +
        `Last daemon log lines (${daemonLogFile()}):\n${tailLog()}`,
    );
  }, { timeoutMs: 60000 });
}

export async function daemonStatus() {
  const c = await tryConnect();
  const pid = readPid();
  const out = { running: !!c, socket: socketPath(), ownPid: pidAlive(pid) ? pid : null, log: daemonLogFile() };
  if (c) {
    out.userAgent = c.serverInfo?.userAgent;
    try {
      out.loadedThreads = (await c.request("thread/loaded/list", {}, { timeoutMs: 5000 })).data?.length ?? null;
    } catch {}
    c.close();
  }
  return out;
}

export async function stopDaemon() {
  const results = [];
  const pid = readPid();
  if (pidAlive(pid)) {
    // Only signal it if it really is a codex app-server.
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (/codex/.test(ps.stdout) && /app-server/.test(ps.stdout)) {
      // We spawned it detached, so its pid is also its process group: this reaches the native child too.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      results.push(`sent SIGTERM to app-server pid ${pid}`);
    }
  }
  if (!results.length) {
    const r = spawnSync(codexBin(), ["app-server", "daemon", "stop"], { encoding: "utf8", timeout: 30000 });
    results.push(r.status === 0 ? "ran codex app-server daemon stop" : "no daemon started by codexctl was found");
  }
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const c = await tryConnect({ timeoutMs: 800 });
    if (!c) return { stopped: true, detail: results.join("; ") };
    c.close();
    await sleep(300);
  }
  return { stopped: false, detail: results.join("; ") };
}
