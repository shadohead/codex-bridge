// Cross-process advisory locks (mkdir based, with stale-lock recovery) and atomic JSON files.
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Run fn while holding the lock directory `lockPath`. Stale locks (owner process gone,
 * or older than staleMs) are broken. Throws after timeoutMs.
 */
export async function withLock(lockPath, fn, { timeoutMs = 15000, staleMs = 180000 } = {}) {
  ensureDir(path.dirname(lockPath));
  const start = Date.now();
  let delay = 5;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        let owner = NaN;
        try {
          owner = parseInt(fs.readFileSync(path.join(lockPath, "owner"), "utf8"), 10);
        } catch {}
        const age = Date.now() - st.mtimeMs;
        // A lock dir without an owner file is very young (creator between mkdir and write): give it 2s.
        stale = Number.isNaN(owner) ? age > 2000 : !pidAlive(owner) || age > staleMs;
      } catch {
        continue; // vanished between mkdir and stat: retry immediately
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for lock ${lockPath}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    if (e instanceof SyntaxError) {
      // Keep the broken file for inspection instead of silently losing the registry.
      const bak = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, bak);
      } catch {}
      return fallback;
    }
    throw e;
  }
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
