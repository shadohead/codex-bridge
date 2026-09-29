// name -> thread registry (~/.codex-bridge/agents.json). All mutations are serialized by a lock.
import path from "node:path";
import { registryFile, locksDir } from "./paths.mjs";
import { withLock, readJson, writeJsonAtomic } from "./lock.mjs";

const EMPTY = () => ({ version: 1, agents: {} });

export function loadRegistry() {
  const reg = readJson(registryFile(), EMPTY());
  if (!reg.agents || typeof reg.agents !== "object") reg.agents = {};
  return reg;
}

export function getAgent(name) {
  return loadRegistry().agents[name] ?? null;
}

export function listAgents() {
  return Object.values(loadRegistry().agents).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Atomically read-modify-write the registry. fn(reg) may mutate and/or return a value. */
export async function updateRegistry(fn) {
  return withLock(path.join(locksDir(), "registry.lock"), async () => {
    const reg = loadRegistry();
    const out = await fn(reg);
    writeJsonAtomic(registryFile(), reg);
    return out;
  });
}

export async function patchAgent(name, patch) {
  return updateRegistry((reg) => {
    const a = reg.agents[name];
    if (!a) throw new Error(`no such agent: ${name}`);
    Object.assign(a, patch);
    return a;
  });
}

export function agentLockPath(name) {
  return path.join(locksDir(), `agent-${encodeURIComponent(name)}.lock`);
}
