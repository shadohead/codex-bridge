// Pure functions: turn a daemon snapshot (thread + turns) into agent state, events and summaries.
import crypto from "node:crypto";

export const TERMINAL_TURN = new Set(["completed", "interrupted", "failed"]);

/** After `send`, the new turn may not be listed yet; treat it as running for this long. */
const PENDING_TURN_GRACE_MS = 20000;

export function activeFlags(thread) {
  return thread?.status?.type === "active" ? (thread.status.activeFlags ?? []) : [];
}

/**
 * state: running | waiting-approval | waiting-input | idle | error | lost
 *  - lost: the thread is not loaded by the daemon but its last turn never finished (daemon restarted mid-turn)
 * turns must be oldest first.
 */
export function deriveState(thread, turns, agent = {}, now = Date.now()) {
  const st = thread?.status?.type;
  const last = turns.at(-1) ?? null;
  if (st === "active") {
    const flags = activeFlags(thread);
    if (flags.includes("waitingOnApproval")) return "waiting-approval";
    if (flags.includes("waitingOnUserInput")) return "waiting-input";
    return "running";
  }
  if (st === "systemError") return "error";
  // The turn we just started may not show up in the list yet.
  if (
    agent.lastTurnId &&
    agent.lastSendAt &&
    now - agent.lastSendAt < PENDING_TURN_GRACE_MS &&
    !turns.some((t) => t.id === agent.lastTurnId)
  ) {
    return "running";
  }
  if (last?.status === "inProgress") return st === "notLoaded" ? "lost" : "running";
  if (last?.status === "failed") return "error";
  return "idle";
}

/**
 * The turn a caller cares about: the one we last started/steered, unless a newer turn has begun since
 * (e.g. a human typed into `codex agents`), else simply the newest.
 */
export function targetTurn(turns, agent = {}) {
  const newest = turns.at(-1) ?? null;
  if (agent.lastTurnId) {
    const t = turns.find((x) => x.id === agent.lastTurnId);
    if (t) {
      const newerStart = (newest?.startedAt ?? 0) * 1000;
      if (newest && newest.id !== t.id && newerStart >= (agent.lastSendAt ?? 0) - 2000) return newest;
      return t;
    }
  }
  return newest;
}

/** After a daemon restart the server reports the orphaned turn as interrupted, with no completion time. */
export function isLostTurn(turn) {
  return turn?.status === "interrupted" && !turn.completedAt && turn.durationMs == null;
}

export function agentMessages(turn) {
  return (turn?.items ?? []).filter((i) => i.type === "agentMessage" && (i.text ?? "").trim() !== "");
}

/** The turn's answer: last final_answer message, else the last agent message of any phase. */
export function finalMessage(turn) {
  const msgs = agentMessages(turn);
  if (!msgs.length) return null;
  const fin = msgs.filter((m) => m.phase === "final_answer");
  return (fin.at(-1) ?? msgs.at(-1)).text;
}

/** Asynchronous questions the agent attached to a message (agentMessage.questions). */
export function messageQuestions(turn) {
  const out = [];
  for (const m of agentMessages(turn)) for (const q of m.questions ?? []) out.push(q);
  return out;
}

export function lastCompletedTurn(turns) {
  return [...turns].reverse().find((t) => t.status === "completed") ?? null;
}

export function turnSummary(turn) {
  const items = turn?.items ?? [];
  const cmds = items.filter((i) => i.type === "commandExecution");
  const failed = cmds.filter((c) => c.status === "failed" || (c.exitCode != null && c.exitCode !== 0));
  const files = new Set();
  for (const i of items) if (i.type === "fileChange") for (const c of i.changes ?? []) files.add(c.path);
  return {
    commands: cmds.length,
    commandsFailed: failed.length,
    filesChanged: [...files],
    messages: agentMessages(turn).length,
  };
}

// ---- event log ----------------------------------------------------------

export function flattenEvents(turns) {
  const events = [];
  turns.forEach((turn, idx) => {
    events.push({ id: `t:${turn.id}:start`, kind: "turn-start", turn, n: idx + 1 });
    for (const item of turn.items ?? []) events.push({ id: `i:${item.id}`, kind: "item", item, turn });
    if (TERMINAL_TURN.has(turn.status)) events.push({ id: `t:${turn.id}:end`, kind: "turn-end", turn, n: idx + 1 });
  });
  return events;
}

const hash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 6);

export function encodeCursor(events) {
  if (!events.length) return "0";
  return `${events.length}.${hash(events.at(-1).id)}`;
}

/** Returns {index, note?}: how many leading events the cursor says were already seen. */
export function decodeCursor(cursor, events) {
  if (cursor == null || cursor === "") return { index: 0 };
  const m = /^(\d+)(?:\.([0-9a-f]{6}))?$/.exec(String(cursor));
  if (!m) throw new Error(`invalid cursor: ${cursor}`);
  const n = parseInt(m[1], 10);
  if (!m[2]) return { index: Math.min(n, events.length) };
  if (n >= 1 && n <= events.length && hash(events[n - 1].id) === m[2]) return { index: n };
  // History shifted (compaction/rollback): find the event the cursor pointed at.
  const at = events.findIndex((e) => hash(e.id) === m[2]);
  if (at >= 0) return { index: at + 1, note: "cursor re-anchored" };
  // Never silently drop events: when the cursor cannot be matched, start over.
  return { index: 0, note: "cursor does not match this thread's history; showing the full log" };
}
