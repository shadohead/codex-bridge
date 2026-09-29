// The commands, as data-returning functions. cli.mjs renders their results.
import fs from "node:fs";
import path from "node:path";
import { Bridge, readTokenUsage } from "./bridge.mjs";
import { RpcError } from "./rpc.mjs";
import { getAgent, listAgents, updateRegistry, patchAgent, agentLockPath, loadRegistry } from "./registry.mjs";
import { withLock } from "./lock.mjs";
import {
  deriveState,
  targetTurn,
  finalMessage,
  messageQuestions,
  lastCompletedTurn,
  turnSummary,
  flattenEvents,
  encodeCursor,
  decodeCursor,
  agentMessages,
  activeFlags,
} from "./state.mjs";
import { LiveTracker, readLive } from "./live.mjs";

export class UsageError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SANDBOXES = ["read-only", "workspace-write"];
export const APPROVALS = ["never", "on-request"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let daemonNote = null;
/** Set by cli.mjs so ops can report that they started the daemon. */
export function daemonStartNote() {
  return daemonNote;
}
const openBridge = (opts = {}) =>
  Bridge.open({
    ...opts,
    onDaemonStart: (info) => {
      daemonNote = info;
    },
  });

async function withBridge(fn, opts) {
  const bridge = await openBridge(opts);
  try {
    return await fn(bridge);
  } finally {
    bridge.close();
  }
}

export function requireAgent(name) {
  const a = getAgent(name);
  if (!a) {
    const known = listAgents().map((x) => x.name);
    throw new UsageError(
      `no such agent: ${name}` + (known.length ? ` (known: ${known.join(", ")})` : " (no agents registered; use `codexctl start`)"),
    );
  }
  return a;
}

function validateRegex(pattern) {
  try {
    new RegExp(pattern);
  } catch (e) {
    throw new UsageError(`invalid regex ${JSON.stringify(pattern)}: ${e.message}`);
  }
  return pattern;
}

export async function autoRules(name, action = "list", pattern = null, files = false) {
  if (!['add', 'rm', 'list'].includes(action)) throw new UsageError('usage: codexctl auto NAME [add REGEX|rm REGEX|list] [--files]');
  if (action === 'list') {
    if (pattern != null) throw new UsageError('usage: codexctl auto NAME list');
    const a = requireAgent(name);
    return { name, command: a.autoApprove ?? [], files: a.autoApproveFiles ?? [] };
  }
  if (pattern == null) throw new UsageError(`usage: codexctl auto NAME ${action} REGEX [--files]`);
  if (action === 'add') validateRegex(pattern);
  const key = files ? 'autoApproveFiles' : 'autoApprove';
  return updateRegistry((reg) => {
    const a = reg.agents[name];
    if (!a) throw new UsageError(`no such agent: ${name}`);
    const rules = a[key] ?? [];
    a[key] = action === 'add' ? [...new Set([...rules, pattern])] : rules.filter((r) => r !== pattern);
    return { name, command: a.autoApprove ?? [], files: a.autoApproveFiles ?? [] };
  });
}

function filePaths(rec, inflight) {
  const p = rec.params ?? {};
  const item = inflight.find((x) => x.id === rec.itemId && x.type === 'fileChange');
  const changes = p.changes ?? p.fileChanges;
  if (Array.isArray(changes) && changes.some((x) => typeof x !== 'string' && !x?.path)) return null;
  const paths = [
    ...(Array.isArray(changes) ? changes.flatMap((x) => typeof x === 'string' ? [x] : [x?.path, x?.kind?.move_path].filter(Boolean)) : []),
    ...(Array.isArray(p.paths) ? p.paths : []),
    ...(item?.files ?? []),
  ];
  // No path list means the scope of the change is unknown, so never approve it.
  return Array.isArray(paths) && paths.length && paths.every((x) => typeof x === 'string' && x.length) ? paths : null;
}

function matchingAutoApproval(rec, agent, inflight) {
  if (rec.method === 'item/commandExecution/requestApproval' || rec.method === 'execCommandApproval') {
    const command = rec.params?.command;
    if (typeof command !== 'string' || !command.length) return null;
    return (agent.autoApprove ?? []).some((r) => new RegExp(r).test(command)) ? { detail: command } : null;
  }
  if (rec.method === 'item/fileChange/requestApproval' || rec.method === 'applyPatchApproval') {
    const paths = filePaths(rec, inflight);
    if (!paths) return null;
    return (agent.autoApproveFiles ?? []).some((r) => paths.every((p) => new RegExp(r).test(p))) ? { detail: paths.join(', '), paths } : null;
  }
  return null;
}

async function recordAutoApproval(name, rec, detail, paths) {
  const entry = { id: rec.id, kind: rec.kind, turnId: rec.turnId, detail, ...(paths ? { paths } : {}), at: Date.now() };
  await updateRegistry((reg) => {
    const a = reg.agents[name];
    if (a) a.autoApprovals = [...(a.autoApprovals ?? []), entry].slice(-20);
  });
  return entry;
}

// ---- settings -----------------------------------------------------------

export function sandboxPolicy(a) {
  if (a.sandbox === "read-only") return { type: "readOnly", networkAccess: !!a.network };
  return {
    type: "workspaceWrite",
    writableRoots: a.writableRoots ?? [],
    networkAccess: !!a.network,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** Config overrides sent with thread/start and thread/resume. */
function threadConfig(a) {
  const cfg = {};
  if (a.effort) cfg.model_reasoning_effort = a.effort;
  if (a.sandbox === "workspace-write") {
    cfg.sandbox_workspace_write = { writable_roots: a.writableRoots ?? [], network_access: !!a.network };
  }
  return cfg;
}

/** Per-turn overrides that re-assert the registered settings (used on the first turn and after a reload). */
function turnOverrides(a) {
  const o = { cwd: a.cwd, approvalPolicy: a.approval, sandboxPolicy: sandboxPolicy(a) };
  if (a.model) o.model = a.model;
  if (a.effort) o.effort = a.effort;
  return o;
}

const textInput = (text) => [{ type: "text", text, text_elements: [] }];

// ---- start --------------------------------------------------------------

export async function startAgent(o) {
  if (!o.name) throw new UsageError("missing --name NAME");
  if (!NAME_RE.test(o.name)) throw new UsageError("--name must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64 chars)");
  if (!o.prompt || !o.prompt.trim()) throw new UsageError("missing PROMPT (or --prompt-file)");
  if (o.sandbox && !SANDBOXES.includes(o.sandbox)) throw new UsageError(`--sandbox must be one of ${SANDBOXES.join("|")}`);
  if (o.approval && !APPROVALS.includes(o.approval)) throw new UsageError(`--approval must be one of ${APPROVALS.join("|")}`);
  if (o.effort && !EFFORTS.includes(o.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join("|")}`);
  if ((o.writableRoots ?? []).length && (o.sandbox ?? "workspace-write") !== "workspace-write") {
    throw new UsageError("--writable-root only applies to --sandbox workspace-write");
  }
  for (const pattern of [...(o.autoApprove ?? []), ...(o.autoApproveFiles ?? [])]) validateRegex(pattern);
  const cwd = path.resolve(o.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new UsageError(`--cwd is not a directory: ${cwd}`);
  const settings = {
    model: o.model ?? null,
    effort: o.effort ?? null,
    cwd: fs.realpathSync(cwd),
    sandbox: o.sandbox ?? "workspace-write",
    writableRoots: (o.writableRoots ?? []).map((d) => path.resolve(d)),
    network: !!o.network,
    approval: o.approval ?? "never",
  };
  if (getAgent(o.name)) {
    throw new UsageError(`agent "${o.name}" already exists (thread ${getAgent(o.name).threadId}); use send, or rm it first`);
  }

  return withBridge(async (bridge) => {
    const t = await bridge.request(
      "thread/start",
      {
        ...(settings.model ? { model: settings.model } : {}),
        cwd: settings.cwd,
        approvalPolicy: settings.approval,
        sandbox: settings.sandbox,
        config: threadConfig(settings),
        serviceName: "codexctl",
      },
      { timeoutMs: 60000 },
    );
    const threadId = t.thread.id;
    // Record what the daemon really applied (defaults resolved).
    settings.model = t.model ?? settings.model;
    settings.effort = t.reasoningEffort ?? settings.effort;
    const record = {
      name: o.name,
      threadId,
      ...settings,
      createdAt: Date.now(),
      lastTurnId: null,
      lastSendAt: null,
      autoApprove: [...new Set(o.autoApprove ?? [])],
      autoApproveFiles: [...new Set(o.autoApproveFiles ?? [])],
      autoApprovals: [],
    };
    try {
      await updateRegistry((reg) => {
        if (reg.agents[o.name]) throw new UsageError(`agent "${o.name}" was created concurrently by another codexctl`);
        reg.agents[o.name] = record;
      });
    } catch (e) {
      // Lost a race for the name: do not leave an orphan thread behind.
      await bridge.request("thread/archive", { threadId }).catch(() => {});
      throw e;
    }
    try {
      await bridge.request("thread/name/set", { threadId, name: o.name });
    } catch (e) {
      // cosmetic only
    }
    let turn;
    try {
      turn = (
        await bridge.request(
          "turn/start",
          { threadId, input: textInput(o.prompt), ...turnOverrides(settings) },
          { timeoutMs: 60000 },
        )
      ).turn;
    } catch (e) {
      throw new Error(`agent "${o.name}" was created (thread ${threadId}) but its first turn failed to start: ${e.message}`);
    }
    await patchAgent(o.name, { lastTurnId: turn.id, lastSendAt: Date.now() });
    return { name: o.name, threadId, turnId: turn.id, ...settings };
  });
}

// ---- snapshot / status --------------------------------------------------

/** Gather everything status/list/wait need for one agent, tolerating a missing thread. */
export async function snapshotAgent(bridge, agent, { recentTurns = 3, usage = true } = {}) {
  const snap = { name: agent.name, threadId: agent.threadId, settings: pickSettings(agent), autoApprove: agent.autoApprove ?? [], autoApproveFiles: agent.autoApproveFiles ?? [], autoApprovals: (agent.autoApprovals ?? []).slice(-5) };
  try {
    const thread = await bridge.readThread(agent.threadId);
    const turns = await bridge.recentTurns(agent.threadId, recentTurns);
    const fresh = getAgent(agent.name) ?? agent;
    snap.autoApprove = fresh.autoApprove ?? [];
    snap.autoApproveFiles = fresh.autoApproveFiles ?? [];
    snap.autoApprovals = (fresh.autoApprovals ?? []).slice(-5);
    const state = deriveState(thread, turns, fresh);
    const tt = targetTurn(turns, fresh);
    Object.assign(snap, {
      thread,
      turns,
      agent: fresh,
      state,
      flags: activeFlags(thread),
      turn: tt,
    });
    if (usage) snap.usage = readTokenUsage(thread.path);
  } catch (e) {
    snap.state = "error";
    snap.error = /not found|no rollout|does not exist/i.test(e.message)
      ? `thread ${agent.threadId} not found on the daemon (deleted/archived?)`
      : e.message;
  }
  return snap;
}

function pickSettings(a) {
  return {
    model: a.model,
    effort: a.effort,
    cwd: a.cwd,
    sandbox: a.sandbox,
    writableRoots: a.writableRoots,
    network: a.network,
    approval: a.approval,
  };
}

/** Wait (bounded) for the replayed server requests of a blocked thread. */
async function collectPending(bridge, threadId, { maxMs = 5000, quietMs = 350 } = {}) {
  const end = Date.now() + maxMs;
  let firstAt = null;
  while (Date.now() < end) {
    const n = bridge.pendingFor(threadId).length;
    if (n && firstAt === null) firstAt = Date.now();
    if (firstAt !== null && Date.now() - firstAt >= quietMs) break;
    await sleep(60);
  }
  return bridge.pendingFor(threadId);
}

export async function statusOne(name) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const snap = await snapshotAgent(bridge, agent, { recentTurns: 3 });
    if (snap.state === "running" || snap.state.startsWith("waiting")) snap.live = readLive(name, agent.threadId);
    if (snap.state === "waiting-approval" || snap.state === "waiting-input") {
      try {
        await bridge.attach(agent.threadId);
        snap.pending = await collectPending(bridge, agent.threadId);
      } catch (e) {
        snap.pending = [];
      }
    }
    return snap;
  });
}

export async function statusAll() {
  const agents = listAgents();
  if (!agents.length) return [];
  return withBridge(async (bridge) =>
    Promise.all(agents.map((a) => snapshotAgent(bridge, a, { recentTurns: 1, usage: true }))),
  );
}

// ---- send ---------------------------------------------------------------

export async function sendMessage(name, text) {
  if (!text || !text.trim()) throw new UsageError("empty message");
  const agent = requireAgent(name);
  return withLock(agentLockPath(name), () =>
    withBridge(async (bridge) => {
      let reloaded = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const a = getAgent(name) ?? agent;
        const thread = await bridge.readThread(a.threadId);
        if (thread.status.type === "notLoaded") {
          await bridge.request(
            "thread/resume",
            {
              threadId: a.threadId,
              excludeTurns: true,
              cwd: a.cwd,
              approvalPolicy: a.approval,
              sandbox: a.sandbox,
              ...(a.model ? { model: a.model } : {}),
              config: threadConfig(a),
            },
            { timeoutMs: 60000 },
          );
          reloaded = true;
          continue;
        }
        if (thread.status.type === "active") {
          const [cur] = await bridge.recentTurns(a.threadId, 1);
          if (!cur || cur.status !== "inProgress") {
            await sleep(250); // status flipped but the turn list has not caught up yet
            continue;
          }
          try {
            const r = await bridge.request("turn/steer", {
              threadId: a.threadId,
              expectedTurnId: cur.id,
              input: textInput(text),
            });
            await patchAgent(name, { lastTurnId: r.turnId ?? cur.id, lastSendAt: Date.now() });
            return {
              name,
              mode: "steered",
              turnId: r.turnId ?? cur.id,
              blocked: activeFlags(thread),
            };
          } catch (e) {
            if (e instanceof RpcError && /no active turn|expected active turn/i.test(e.message)) {
              await sleep(200);
              continue; // the turn ended under us: start a new one on the next pass
            }
            throw e;
          }
        }
        // idle / systemError: start a new turn
        const params = { threadId: a.threadId, input: textInput(text), ...(reloaded ? turnOverrides(a) : {}) };
        const before = (await bridge.recentTurns(a.threadId, 1))[0];
        let r;
        try {
          r = await bridge.request("turn/start", params, { timeoutMs: 60000 });
        } catch (e) {
          if (e instanceof RpcError && /not loaded|not found|no such thread/i.test(e.message) && attempt < 3) {
            await sleep(200); // the daemon unloaded the idle thread under us: reload on the next pass
            continue;
          }
          throw e;
        }
        const mode = before && before.status === "inProgress" && before.id === r.turn.id ? "steered" : "started";
        await patchAgent(name, { lastTurnId: r.turn.id, lastSendAt: Date.now() });
        return { name, mode, turnId: r.turn.id, blocked: [] };
      }
      throw new Error("could not deliver the message: the agent kept changing state; try again");
    }),
  );
}

// ---- log ----------------------------------------------------------------

export async function logAgent(name, { since = null } = {}) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const thread = await bridge.readThread(agent.threadId);
    const turns = await bridge.allTurns(agent.threadId);
    const events = flattenEvents(turns);
    const { index, note } = decodeCursor(since, events);
    const state = deriveState(thread, turns, getAgent(name) ?? agent);
    return { name, threadId: agent.threadId, state, events: events.slice(index), from: index, cursor: encodeCursor(events), note, thread, autoApprovals: (getAgent(name)?.autoApprovals ?? []).slice(-20) };
  });
}

// ---- result -------------------------------------------------------------

export async function resultOf(name) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const thread = await bridge.readThread(agent.threadId);
    const turns = await bridge.allTurns(agent.threadId);
    const state = deriveState(thread, turns, getAgent(name) ?? agent);
    const done = lastCompletedTurn(turns);
    return {
      name,
      state,
      turn: done,
      text: done ? finalMessage(done) : null,
      questions: done ? messageQuestions(done) : [],
      summary: done ? turnSummary(done) : null,
      running: state === "running" || state === "waiting-approval" || state === "waiting-input",
    };
  });
}

// ---- wait ---------------------------------------------------------------

function sleepOrWake(bridge, threadId, ms) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bridge.off("wake", onWake);
      bridge.off("close", fin);
      resolve();
    };
    const timer = setTimeout(fin, Math.max(0, ms));
    const onWake = (tid) => {
      if (tid === threadId) setTimeout(fin, 40); // let a burst of notifications settle
    };
    bridge.on("wake", onWake);
    bridge.on("close", fin);
  });
}

const RETRYABLE = (e) => !(e instanceof RpcError) || e.code === -1 || /closed|ECONN|ENOENT|EPIPE|timed out/i.test(e.message);

/**
 * Block until the agent reaches the requested condition. Level-triggered: notifications only wake us up,
 * the decision is always made from a fresh read of the thread, so nothing depends on having seen live events.
 */
export async function waitFor(name, { timeoutSec = 0, until = "turn-complete", pollMs = 3000, onAutoApprove = () => {} } = {}) {
  if (!["turn-complete", "any-message", "approval"].includes(until)) {
    throw new UsageError("--until must be turn-complete, any-message or approval");
  }
  const agent = requireAgent(name);
  const started = Date.now();
  const deadline = timeoutSec > 0 ? started + timeoutSec * 1000 : Infinity;
  let bridge = null;
  let attached = false;
  let baseline = null;
  let pendingSince = null;
  let failures = 0;
  const autoApprovals = [];
  const responded = new Set();
  const live = new LiveTracker(name, agent.threadId);
  const onSignal = (sig) => () => {
    live.close();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const onInt = onSignal("SIGINT");
  const onTerm = onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    for (;;) {
      try {
        if (!bridge || bridge.closed) {
          bridge = await openBridge();
          bridge.on("notification", (m) => live.handle(m));
          attached = false;
        }
        let thread = await bridge.readThread(agent.threadId);
        if (!attached && thread.status.type !== "notLoaded") {
          await bridge.attach(agent.threadId); // subscribe: live wake-ups + replay of pending approvals
          attached = true;
          thread = await bridge.readThread(agent.threadId);
        }
        const turns = await bridge.recentTurns(agent.threadId, 4);
        const fresh = getAgent(name) ?? agent;
        const state = deriveState(thread, turns, fresh);
        const tt = targetTurn(turns, fresh);
        if (baseline === null) {
          baseline = new Set(turns.flatMap((t) => agentMessages(t).map((m) => m.id)));
        }
        if (attached && (state === "running" || state.startsWith("waiting"))) live.flush(true); // heartbeat
        const base = {
          name,
          state,
          thread,
          turn: tt,
          waitedMs: Date.now() - started,
          get usage() {
            return readTokenUsage(thread.path); // only read when a result is actually rendered
          },
          get inflight() {
            return [...live.inflight.values()];
          },
          autoApprovals,
        };
        failures = 0;

        const newMsgs = [];
        if (until === "any-message") {
          for (const t of turns) for (const m of agentMessages(t)) if (!baseline.has(m.id)) newMsgs.push(m);
        }
        const asMessage = (extra) => ({ ...base, kind: "message", messages: newMsgs, text: newMsgs.at(-1).text, ...extra });

        if (state === "waiting-approval" || state === "waiting-input") {
          pendingSince ??= Date.now();
          const recs = bridge.pendingFor(agent.threadId);
          let approved = false;
          for (const rec of recs) {
            const key = `${rec.turnId}#${rec.id}`;
            if (responded.has(key)) continue;
            const match = matchingAutoApproval(rec, getAgent(name) ?? fresh, [...live.inflight.values()]);
            if (!match) continue;
            bridge.client.respond(rec.id, approvalResponse(rec, { deny: false, forSession: false, answer: null }));
            responded.add(key);
            const entry = await recordAutoApproval(name, rec, match.detail, match.paths);
            autoApprovals.push(entry);
            onAutoApprove(entry);
            approved = true;
          }
          if (approved) {
            await sleepOrWake(bridge, agent.threadId, 100);
            continue;
          }
          // Give the (replayed) request(s) a moment to arrive so the caller gets the details.
          const age = recs.length ? Date.now() - recs[0].receivedAt : 0;
          if ((recs.length && age >= 300) || Date.now() - pendingSince > 6000) {
            return newMsgs.length ? asMessage({ pending: recs }) : { ...base, kind: "pending", pending: recs };
          }
          await sleepOrWake(bridge, agent.threadId, recs.length ? 300 - age : 400);
          continue;
        } else {
          pendingSince = null;
        }
        if (state === "lost") return { ...base, kind: "lost" };
        if (state === "idle" || state === "error") {
          const qs = tt ? messageQuestions(tt) : [];
          return {
            ...base,
            kind: "complete",
            text: tt ? finalMessage(tt) : null,
            questions: qs,
            summary: tt ? turnSummary(tt) : null,
          };
        }
        if (newMsgs.length) return asMessage({});
        if (Date.now() >= deadline) {
          return { ...base, kind: "timeout", turns };
        }
        await sleepOrWake(bridge, agent.threadId, Math.min(pollMs, deadline - Date.now()));
      } catch (e) {
        if (!RETRYABLE(e) || ++failures > 8) throw e;
        try {
          bridge?.close();
        } catch {}
        bridge = null;
        if (Date.now() >= deadline) throw new Error(`timed out while reconnecting to the daemon (${e.message})`);
        await sleep(Math.min(300 * failures, 3000));
      }
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    live.close();
    try {
      bridge?.close();
    } catch {}
  }
}

// ---- approve ------------------------------------------------------------

function approvalResponse(rec, { deny, forSession, answer }) {
  const p = rec.params ?? {};
  switch (rec.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: deny ? "decline" : forSession ? "acceptForSession" : "accept" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: deny ? "denied" : forSession ? "approved_for_session" : "approved" };
    case "item/permissions/requestApproval":
      return deny
        ? { permissions: {}, scope: "turn" }
        : { permissions: stripNulls(p.permissions ?? {}), scope: forSession ? "session" : "turn" };
    case "mcpServer/elicitation/request":
      return { action: deny ? "decline" : "accept", content: deny ? null : {}, _meta: null };
    case "item/tool/requestUserInput": {
      const qs = p.questions ?? [];
      if (deny) return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [] }])) };
      if (answer == null) throw new UsageError("this is a question, not an approval: answer it with --answer TEXT (or --deny to skip)");
      return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [answer] }])) };
    }
    default:
      throw new Error(`cannot respond to ${rec.method}`);
  }
}

function stripNulls(o) {
  if (Array.isArray(o)) return o;
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, stripNulls(v)]));
  }
  return o;
}

export async function approveAgent(name, { deny = false, id = null, forSession = false, answer = null } = {}) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const thread = await bridge.readThread(agent.threadId);
    const flags = activeFlags(thread);
    if (!flags.length) return { name, kind: "none", state: thread.status.type };
    await bridge.attach(agent.threadId);
    const recs = await collectPending(bridge, agent.threadId, { maxMs: 8000 });
    if (!recs.length) {
      throw new Error("the agent is blocked but the daemon did not hand us its request (another client may hold it); try again");
    }
    const rec = id != null ? recs.find((r) => String(r.id) === String(id)) : recs[0];
    if (!rec) throw new UsageError(`no pending request with id ${id} (pending: ${recs.map((r) => r.id).join(", ")})`);
    const inflight = readLive(name, agent.threadId)?.inflight ?? [];
    const response = approvalResponse(rec, { deny, forSession, answer });
    const resolved = new Promise((resolve) => {
      const t = setTimeout(resolve, 4000);
      const h = (m) => {
        if (m.method === "serverRequest/resolved" && String(m.params?.requestId) === String(rec.id)) {
          clearTimeout(t);
          bridge.off("notification", h);
          resolve(true);
        }
      };
      bridge.on("notification", h);
    });
    bridge.client.respond(rec.id, response);
    const ok = await resolved;
    return {
      name,
      kind: "responded",
      decision: deny ? "denied" : "approved",
      rec,
      confirmed: !!ok,
      inflight,
      remaining: recs.filter((r) => r !== rec),
    };
  });
}

// ---- interrupt ----------------------------------------------------------

export async function interruptAgent(name) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const thread = await bridge.readThread(agent.threadId);
    if (thread.status.type !== "active") {
      return { name, interrupted: false, state: thread.status.type === "notLoaded" ? "idle" : thread.status.type, note: "no turn is running" };
    }
    const [cur] = await bridge.recentTurns(agent.threadId, 1);
    const turnId = cur?.status === "inProgress" ? cur.id : getAgent(name)?.lastTurnId;
    if (!turnId) throw new Error("agent is active but its current turn could not be identified");
    try {
      // turn/interrupt never answers when nothing is running, so it always gets a short timeout.
      await bridge.request("turn/interrupt", { threadId: agent.threadId, turnId }, { timeoutMs: 10000 });
    } catch (e) {
      const t = await bridge.readThread(agent.threadId);
      if (t.status.type === "active") throw e;
    }
    // Wait for the turn to actually stop.
    const end = Date.now() + 10000;
    let turn = cur;
    while (Date.now() < end) {
      const t = await bridge.readThread(agent.threadId);
      [turn] = await bridge.recentTurns(agent.threadId, 1);
      if (t.status.type !== "active" && turn?.status !== "inProgress") break;
      await sleep(250);
    }
    const stopped = turn?.status !== "inProgress";
    return { name, interrupted: true, turnId, stopped, turnStatus: turn?.status };
  });
}

// ---- resume / rm / list -------------------------------------------------

export async function resumeAgent(name) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    const thread = await bridge.readThread(agent.threadId);
    if (thread.status.type !== "notLoaded") {
      const turns = await bridge.recentTurns(agent.threadId, 2);
      return { name, reloaded: false, state: deriveState(thread, turns, agent) };
    }
    await bridge.request(
      "thread/resume",
      {
        threadId: agent.threadId,
        excludeTurns: true,
        cwd: agent.cwd,
        approvalPolicy: agent.approval,
        sandbox: agent.sandbox,
        ...(agent.model ? { model: agent.model } : {}),
        config: threadConfig(agent),
      },
      { timeoutMs: 60000 },
    );
    const t2 = await bridge.readThread(agent.threadId);
    const turns = await bridge.recentTurns(agent.threadId, 2);
    return { name, reloaded: true, state: deriveState(t2, turns, agent), lastTurn: turns.at(-1)?.status ?? null };
  });
}

export async function removeAgent(name, { force = false } = {}) {
  const agent = requireAgent(name);
  return withBridge(async (bridge) => {
    let interrupted = false;
    try {
      const thread = await bridge.readThread(agent.threadId);
      if (thread.status.type === "active") {
        if (!force) {
          throw new UsageError(`agent "${name}" is still running; interrupt it first or use rm --force`);
        }
        await interruptAgentWith(bridge, agent);
        interrupted = true;
      }
    } catch (e) {
      if (e instanceof UsageError) throw e;
      // thread unreadable (already gone): fall through to unregister
    }
    let archived = false;
    let note = null;
    try {
      await bridge.request("thread/archive", { threadId: agent.threadId });
      archived = true;
    } catch (e) {
      note = `thread not archived: ${e.message}`;
    }
    await updateRegistry((reg) => {
      delete reg.agents[name];
    });
    return { name, threadId: agent.threadId, archived, interrupted, note };
  });
}

async function interruptAgentWith(bridge, agent) {
  const [cur] = await bridge.recentTurns(agent.threadId, 1);
  if (cur?.status === "inProgress") {
    try {
      await bridge.request("turn/interrupt", { threadId: agent.threadId, turnId: cur.id }, { timeoutMs: 10000 });
    } catch {}
    for (let i = 0; i < 20; i++) {
      const t = await bridge.readThread(agent.threadId);
      if (t.status.type !== "active") return;
      await sleep(250);
    }
  }
}

export async function listThreadsOnDaemon(searchTerm = null) {
  return withBridge(async (bridge) => {
    const r = await bridge.request("thread/list", { limit: 100, sortKey: "updated_at", ...(searchTerm ? { searchTerm } : {}) });
    return r.data ?? [];
  });
}

export { loadRegistry };
