// Opportunistic live view. The daemon's read APIs only return *completed* items, so an in-flight command
// (or the agent's plan) is invisible to a stateless `status`. Any `wait` that is attached to the thread sees
// those events live and mirrors them into ~/.codex-bridge/live/NAME.json; `status` shows the file while its
// owner is alive and fresh. Purely a convenience: nothing else depends on it.
import fs from "node:fs";
import path from "node:path";
import { bridgeHome, ensureDir } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./lock.mjs";

const FRESH_MS = 20000;
const TRACKED = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"]);

export const liveFile = (name) => path.join(bridgeHome(), "live", `${encodeURIComponent(name)}.json`);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export class LiveTracker {
  constructor(name, threadId) {
    this.name = name;
    this.threadId = threadId;
    this.inflight = new Map();
    this.plan = null;
    this.dirty = false;
    this.lastWrite = 0;
  }

  handle(m) {
    const p = m.params ?? {};
    if (p.threadId !== this.threadId) return;
    if (m.method === "item/started" && TRACKED.has(p.item?.type)) {
      const it = p.item;
      this.inflight.set(it.id, {
        id: it.id,
        type: it.type,
        command: it.command ?? null,
        tool: it.tool ? `${it.server ? it.server + "." : ""}${it.tool}` : null,
        files: it.changes?.map((c) => c.path) ?? null,
        startedAtMs: p.startedAtMs ?? Date.now(),
      });
      this.dirty = true;
    } else if (m.method === "item/completed" && p.item?.id) {
      if (this.inflight.delete(p.item.id)) this.dirty = true;
    } else if (m.method === "turn/plan/updated") {
      this.plan = (p.plan ?? []).map((s) => ({ step: s.step, status: s.status }));
      this.dirty = true;
    } else if (m.method === "turn/completed" || m.method === "turn/started") {
      this.inflight.clear();
      if (m.method === "turn/completed") this.plan = null;
      this.dirty = true;
    }
    this.flush();
  }

  /** Write if something changed (throttled) or as a heartbeat. */
  flush(force = false) {
    const now = Date.now();
    if (!force && !(this.dirty && now - this.lastWrite > 200)) return;
    try {
      ensureDir(path.dirname(liveFile(this.name)));
      writeJsonAtomic(liveFile(this.name), {
        pid: process.pid,
        threadId: this.threadId,
        updatedAt: now,
        inflight: [...this.inflight.values()],
        plan: this.plan,
      });
      this.dirty = false;
      this.lastWrite = now;
    } catch {}
  }

  close() {
    try {
      const cur = readJson(liveFile(this.name), null);
      if (cur?.pid === process.pid) fs.rmSync(liveFile(this.name), { force: true });
    } catch {}
  }
}

/** The mirrored live state, or null when there is no fresh, owned file. */
export function readLive(name, threadId) {
  try {
    const l = readJson(liveFile(name), null);
    if (!l || l.threadId !== threadId) return null;
    if (Date.now() - l.updatedAt > FRESH_MS || !pidAlive(l.pid)) return null;
    return l;
  } catch {
    return null;
  }
}
