import fs from "node:fs";
import * as ops from "./ops.mjs";
import { UsageError } from "./ops.mjs";
import { parseArgs } from "./args.mjs";
import { ensureDaemon, daemonStatus, stopDaemon } from "./daemon.mjs";
import { daemonLogFile } from "./paths.mjs";
import { RpcError } from "./rpc.mjs";
import { turnSummary, isLostTurn } from "./state.mjs";
import {
  renderEvent,
  itemLine,
  oneLine,
  fmtDur,
  fmtNum,
  fmtAgo,
  shortId,
  shortPath,
  table,
  describePending,
  stateLine,
  turnStatusLabel,
  stripShell,
} from "./render.mjs";

const HELP = `codexctl - drive OpenAI Codex agents from a shell (start, message, inspect, wait, interrupt, resume)

usage: codexctl <command> [options]

  start --name NAME [--model M] [--effort low|medium|high|xhigh] [--cwd DIR]
        [--sandbox read-only|workspace-write] [--writable-root DIR ...] [--network]
        [--approval never|on-request] (PROMPT | --prompt-file F | -)
                                 create an agent and start its first turn (returns immediately)
  send NAME (MESSAGE | --file F | -)   steer the running turn, or start a new turn if idle
  status [NAME]                  one agent in detail, or a table of all agents
  log NAME [--since CURSOR] [--full]   transcript since a cursor (prints the next cursor)
  wait NAME [--timeout SEC] [--until turn-complete|any-message|approval]
                                 block; exit 0 done, 2 timeout, 3 approval/question pending, 1 error
  result NAME                    final message of the last completed turn
  approve NAME [--deny] [--id REQ] [--for-session] [--answer TEXT]
  interrupt NAME
  resume NAME                    reload the thread after a daemon restart
  list                           registered agents
  rm NAME [--force]              unregister and archive the thread
  threads [--all] [--search TEXT]   your agents' threads as the daemon lists them (as \`codex agents\` does)
  daemon [status|start|stop]

global: --json (machine-readable output)  -h/--help
state: ~/.codex-bridge/agents.json   daemon: ~/.codex/app-server-control/app-server-control.sock
`;

const GLOBAL = { json: { type: "bool" }, help: { type: "bool", alias: "h" } };

const COMMANDS = {
  start: {
    flags: {
      name: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      cwd: { type: "string" },
      sandbox: { type: "string" },
      "writable-root": { type: "list" },
      network: { type: "bool" },
      approval: { type: "string" },
      "prompt-file": { type: "string" },
    },
  },
  send: { flags: { file: { type: "string", alias: "f" } } },
  status: { flags: {} },
  log: { flags: { since: { type: "string" }, full: { type: "bool" } } },
  wait: { flags: { timeout: { type: "number" }, until: { type: "string" } } },
  result: { flags: {} },
  approve: {
    flags: { deny: { type: "bool" }, id: { type: "string" }, "for-session": { type: "bool" }, answer: { type: "string" } },
  },
  interrupt: { flags: {} },
  resume: { flags: {} },
  list: { flags: {} },
  rm: { flags: { force: { type: "bool" } } },
  threads: { flags: { search: { type: "string" }, all: { type: "bool" } } },
  daemon: { flags: {} },
};

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readTextArg(positional, file, what) {
  if (file != null) {
    try {
      return file === "-" ? readStdin() : fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new UsageError(`cannot read ${what} file ${file}: ${e.message}`);
    }
  }
  if (positional.length === 1 && positional[0] === "-") return readStdin();
  return positional.join(" ");
}

function out(s = "") {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

function printJson(obj) {
  out(JSON.stringify(obj, null, 2));
}

// ---- rendering helpers ---------------------------------------------------

function turnElapsed(turn, agent, now = Date.now()) {
  const start = turn?.startedAt ? turn.startedAt * 1000 : agent?.lastSendAt;
  return start ? now - start : null;
}

function tokensLine(u) {
  if (!u) return null;
  const ctx = u.contextWindow ? `, context window ${fmtNum(u.contextWindow)}` : "";
  return `tokens: ${fmtNum(u.total)} total (${fmtNum(u.cached)} cached input, ${fmtNum(u.output)} output)${ctx}`;
}

function recentItemLines(turns, n = 6) {
  const lines = [];
  for (const t of turns) for (const it of t.items ?? []) {
    const l = itemLine(it, { maxMsg: 220 });
    if (l != null) lines.push(l);
  }
  return lines.slice(-n);
}

function summaryLine(turn) {
  if (!turn) return null;
  const s = turnSummary(turn);
  const parts = [`${s.commands} command${s.commands === 1 ? "" : "s"}${s.commandsFailed ? ` (${s.commandsFailed} failed)` : ""}`];
  if (s.filesChanged.length) {
    const shown = s.filesChanged.slice(0, 5).map((f) => shortPath(f, 60)).join(", ");
    parts.push(`patched ${s.filesChanged.length} file${s.filesChanged.length > 1 ? "s" : ""} (${shown}${s.filesChanged.length > 5 ? ", ..." : ""})`);
  }
  return parts.join(", ");
}

function pendingBlock(name, pending, inflight = []) {
  const lines = [];
  for (const rec of pending) lines.push(...describePending(rec, inflight));
  if (pending.length) {
    const first = pending[0];
    lines.push(
      first.kind === "question"
        ? `answer: codexctl approve ${name} --answer "..."   skip: codexctl approve ${name} --deny`
        : `approve: codexctl approve ${name}    deny: codexctl approve ${name} --deny${pending.length > 1 ? "    (--id REQ picks one; default is the first)" : ""}`,
    );
  }
  return lines;
}

function snapJson(snap) {
  const t = snap.turn;
  return {
    name: snap.name,
    threadId: snap.threadId,
    state: snap.state,
    flags: snap.flags,
    error: snap.error ?? null,
    settings: snap.settings,
    turn: t
      ? {
          id: t.id,
          status: t.status,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
          durationMs: t.durationMs,
          elapsedMs: t.status === "inProgress" || snap.state === "running" ? turnElapsed(t, snap.agent) : null,
          error: t.error?.message ?? null,
          summary: turnSummary(t),
        }
      : null,
    inFlight: snap.live?.inflight ?? [],
    plan: snap.live?.plan ?? null,
    usage: snap.usage ?? null,
    updatedAt: snap.thread?.updatedAt ?? null,
    recent: snap.turns ? recentItemLines(snap.turns, 6) : [],
    pending: (snap.pending ?? []).map((r) => ({ id: r.id, kind: r.kind, method: r.method, params: r.params })),
  };
}

// ---- command handlers ----------------------------------------------------

async function cmdStart({ flags, positionals }, json) {
  const prompt = readTextArg(positionals, flags["prompt-file"], "prompt");
  const r = await ops.startAgent({
    name: flags.name,
    prompt,
    model: flags.model,
    effort: flags.effort,
    cwd: flags.cwd,
    sandbox: flags.sandbox,
    writableRoots: flags["writable-root"],
    network: flags.network,
    approval: flags.approval,
  });
  if (json) return printJson(r);
  out(`started agent "${r.name}"  thread ${r.threadId}  turn ${shortId(r.turnId)}`);
  out(
    `model ${r.model ?? "default"}${r.effort ? "/" + r.effort : ""}  sandbox ${r.sandbox}${r.writableRoots?.length ? ` (+${r.writableRoots.join(",")})` : ""}${r.network ? "+network" : ""}  approval ${r.approval}  cwd ${r.cwd}`,
  );
  out(`next: codexctl wait ${r.name}   |   codexctl status ${r.name}   |   codexctl send ${r.name} "..."`);
}

async function cmdSend({ flags, positionals }, json) {
  const [name, ...rest] = positionals;
  if (!name) throw new UsageError("usage: codexctl send NAME (MESSAGE | --file F | -)");
  const text = readTextArg(rest, flags.file, "message");
  const r = await ops.sendMessage(name, text);
  if (json) return printJson(r);
  if (r.mode === "steered") {
    out(`${name}: message steered into the running turn ${shortId(r.turnId)}${r.blocked?.length ? ` (agent is blocked on ${r.blocked.join(",")}; it will read the message afterwards)` : ""}`);
  } else {
    out(`${name}: started new turn ${shortId(r.turnId)}`);
  }
}

async function cmdStatus({ positionals }, json) {
  const [name] = positionals;
  if (!name) {
    const snaps = await ops.statusAll();
    if (json) return printJson(snaps.map(snapJson));
    if (!snaps.length) return out("no agents registered (use `codexctl start`)");
    const rows = snaps.map((s) => {
      const last = s.turns ? recentItemLines(s.turns, 1)[0] ?? "" : s.error ?? "";
      const running = s.state === "running" || s.state.startsWith("waiting");
      return [
        s.name,
        stateLine(s.state),
        running ? fmtDur(turnElapsed(s.turn, s.agent)) : "-",
        `${s.settings.model ?? "?"}${s.settings.effort ? "/" + s.settings.effort : ""}`,
        s.thread ? fmtAgo(s.thread.updatedAt) : "?",
        oneLine(last, 70),
      ];
    });
    return out(table(["NAME", "STATE", "TURN", "MODEL", "UPDATED", "LAST"], rows));
  }
  const s = await ops.statusOne(name);
  if (json) return printJson(snapJson(s));
  if (s.error) {
    out(`${s.name}  error  ${s.error}`);
    return;
  }
  const running = s.state === "running" || s.state.startsWith("waiting");
  const head = [`${s.name}  ${stateLine(s.state)}`];
  if (running) head.push(`turn running ${fmtDur(turnElapsed(s.turn, s.agent))}`);
  else if (s.turn?.completedAt) head.push(`last turn ${turnStatusLabel(s.turn)} ${fmtAgo(s.turn.completedAt)}${s.turn.durationMs != null ? ` (took ${fmtDur(s.turn.durationMs)})` : ""}`);
  else if (isLostTurn(s.turn)) head.push(`last turn ${turnStatusLabel(s.turn)}`);
  out(head.join("  |  "));
  out(
    `thread ${s.threadId}  ${s.settings.model ?? "?"}${s.settings.effort ? "/" + s.settings.effort : ""}  sandbox ${s.settings.sandbox}  approval ${s.settings.approval}  cwd ${shortPath(s.settings.cwd, 60)}`,
  );
  const tl = tokensLine(s.usage);
  if (tl) out(tl);
  if (s.turn) out(`this turn: ${summaryLine(s.turn)}`);
  if (s.state === "lost") out("the daemon lost this turn (restarted mid-turn); run `codexctl resume " + s.name + "`");
  if (s.turn?.error?.message) out(`error: ${oneLine(s.turn.error.message, 300)}`);
  const recent = recentItemLines(s.turns, 6);
  if (recent.length) {
    out("recent:");
    for (const l of recent) out("  " + l);
  }
  if (s.live?.inflight?.length) {
    out("in flight:");
    for (const f of s.live.inflight) {
      const what = f.command ? `$ ${oneLine(stripShell(f.command), 140)}` : f.tool ? `${f.type} ${f.tool}` : f.files ? `patching ${f.files.join(", ")}` : f.type;
      out(`  ${what}  (running ${fmtDur(Date.now() - f.startedAtMs)})`);
    }
  }
  if (s.live?.plan?.length) {
    out("plan:");
    for (const st of s.live.plan) out(`  [${st.status === "completed" ? "x" : st.status === "inProgress" ? ">" : " "}] ${oneLine(st.step, 120)}`);
  }
  if (s.pending?.length) {
    out("blocked on:");
    for (const l of pendingBlock(s.name, s.pending, s.live?.inflight)) out("  " + l);
  } else if (s.state.startsWith("waiting")) {
    out(`blocked (${s.flags.join(",")}) - run \`codexctl approve ${s.name}\` to see the request`);
  }
}

async function cmdLog({ flags, positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl log NAME [--since CURSOR] [--full]");
  const r = await ops.logAgent(name, { since: flags.since ?? null });
  if (json) {
    return printJson({
      name: r.name,
      state: r.state,
      cursor: r.cursor,
      note: r.note ?? null,
      events: r.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        turnId: e.turn.id,
        text: renderEvent(e, { full: flags.full }).join("\n"),
        item: flags.full ? e.item : undefined,
      })),
    });
  }
  out(`# ${r.name}  state=${r.state}${r.note ? `  (${r.note})` : ""}`);
  let shown = 0;
  for (const ev of r.events) {
    for (const l of renderEvent(ev, { full: flags.full })) {
      out(l);
      shown++;
    }
  }
  if (!shown) out("(no new events)");
  out(`cursor: ${r.cursor}   next: codexctl log ${r.name} --since ${r.cursor}`);
}

function waitExit(r) {
  if (r.kind === "timeout") return 2;
  if (r.kind === "pending" || r.pending?.length) return 3;
  if (r.kind === "lost") return 1;
  if (r.kind === "complete") {
    if (r.state === "error" || r.turn?.status === "failed") return 1;
    if (r.questions?.length) return 3;
  }
  return 0;
}

async function cmdWait({ flags, positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl wait NAME [--timeout SEC] [--until turn-complete|any-message|approval]");
  const r = await ops.waitFor(name, { timeoutSec: flags.timeout ?? 0, until: flags.until ?? "turn-complete" });
  const code = waitExit(r);
  if (json) {
    printJson({
      name,
      result: r.kind,
      exitCode: code,
      state: r.state,
      waitedMs: r.waitedMs,
      turn: r.turn ? { id: r.turn.id, status: r.turn.status, durationMs: r.turn.durationMs, error: r.turn.error?.message ?? null } : null,
      text: r.text ?? null,
      messages: r.messages?.map((m) => m.text),
      questions: r.questions ?? [],
      summary: r.summary ?? null,
      pending: (r.pending ?? []).map((p) => ({ id: p.id, kind: p.kind, method: p.method, params: p.params })),
      usage: r.usage ?? null,
    });
    return code;
  }
  const dur = r.turn?.durationMs != null ? ` in ${fmtDur(r.turn.durationMs)}` : "";
  switch (r.kind) {
    case "complete": {
      const st = r.turn ? turnStatusLabel(r.turn) : "completed";
      const finished = r.turn?.status === "completed";
      out(`${name}: turn ${st}${dur}${r.turn ? ` - ${summaryLine(r.turn)}` : ""}`);
      if (r.turn?.error?.message) out(`error: ${oneLine(r.turn.error.message, 400)}`);
      if (r.text) {
        out(finished ? "--- final message" : "--- last message (the turn did not finish)");
        out(r.text.trimEnd());
        out("---");
      } else out("(no agent message)");
      if (r.questions?.length) {
        out("the agent is asking:");
        for (const q of r.questions) out(`  ? ${q.title}${q.options?.length ? `  [${q.options.join(" | ")}]` : ""}`);
        out(`reply: codexctl send ${name} "..."`);
      }
      const tl = tokensLine(r.usage);
      if (tl) out(tl);
      break;
    }
    case "message":
      out(`${name}: new message (turn ${r.state === "running" ? "still running" : r.state}, ${fmtDur(turnElapsed(r.turn, ops.requireAgent(name)))})`);
      out("--- message");
      out(r.text.trimEnd());
      out("---");
      if (r.pending?.length) {
        out("the agent is now blocked:");
        for (const l of pendingBlock(name, r.pending, r.inflight)) out(l);
      }
      break;
    case "pending":
      out(`${name}: blocked, waiting for ${r.state === "waiting-input" ? "input" : "approval"} after ${fmtDur(r.waitedMs)}`);
      if (r.pending.length) for (const l of pendingBlock(name, r.pending, r.inflight)) out(l);
      else out(`(request details not available; run \`codexctl approve ${name}\`)`);
      break;
    case "lost":
      out(`${name}: the turn was lost (daemon restarted mid-turn); run \`codexctl resume ${name}\` then \`codexctl send ${name} "continue"\``);
      break;
    case "timeout": {
      out(`${name}: timeout after ${fmtDur(r.waitedMs)}; agent still ${r.state} (turn running ${fmtDur(turnElapsed(r.turn, ops.requireAgent(name)))})`);
      const recent = recentItemLines(r.turns ?? [], 4);
      if (recent.length) {
        out("recent:");
        for (const l of recent) out("  " + l);
      }
      break;
    }
  }
  return code;
}

async function cmdResult({ positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl result NAME");
  const r = await ops.resultOf(name);
  if (json) {
    printJson({ name, state: r.state, running: r.running, text: r.text, questions: r.questions, summary: r.summary, turnId: r.turn?.id ?? null });
    return r.text == null ? 1 : 0;
  }
  if (r.text == null) {
    process.stderr.write(`${name}: no completed turn with an agent message yet (state: ${r.state})\n`);
    return 1;
  }
  if (r.running) process.stderr.write(`${name}: a turn is still ${r.state}; showing the last completed turn\n`);
  out(r.text.trimEnd());
  return 0;
}

async function cmdApprove({ flags, positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl approve NAME [--deny] [--id REQ] [--for-session] [--answer TEXT]");
  const r = await ops.approveAgent(name, {
    deny: flags.deny,
    id: flags.id ?? null,
    forSession: flags["for-session"],
    answer: flags.answer ?? null,
  });
  if (json) {
    printJson({
      name,
      result: r.kind,
      decision: r.decision ?? null,
      confirmed: r.confirmed ?? null,
      request: r.rec ? { id: r.rec.id, kind: r.rec.kind, params: r.rec.params } : null,
      remaining: (r.remaining ?? []).map((x) => ({ id: x.id, kind: x.kind })),
    });
    return r.kind === "none" ? 1 : 0;
  }
  if (r.kind === "none") {
    out(`${name}: nothing to approve (agent is ${r.state})`);
    return 1;
  }
  out(`${name}: ${r.decision} request ${r.rec.id} (${r.rec.kind})${r.confirmed ? "" : " - response sent, not yet confirmed by the daemon"}`);
  for (const l of describePending(r.rec, r.inflight).slice(0, 3)) out("  " + l);
  if (r.remaining.length) out(`${r.remaining.length} more pending: ${r.remaining.map((x) => x.id).join(", ")}`);
  return 0;
}

async function cmdInterrupt({ positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl interrupt NAME");
  const r = await ops.interruptAgent(name);
  if (json) return printJson(r);
  if (!r.interrupted) return out(`${name}: ${r.note} (state: ${r.state})`);
  out(`${name}: interrupted turn ${shortId(r.turnId)} - ${r.stopped ? `turn is now ${r.turnStatus}` : "stop requested, the turn is still winding down"}`);
}

async function cmdResume({ positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl resume NAME");
  const r = await ops.resumeAgent(name);
  if (json) return printJson(r);
  out(
    r.reloaded
      ? `${name}: thread reloaded on the daemon (state: ${r.state}${r.lastTurn ? `, last turn ${r.lastTurn}` : ""})`
      : `${name}: thread already loaded on the daemon (state: ${r.state})`,
  );
}

async function cmdList({}, json) {
  const snaps = await ops.statusAll();
  if (json) return printJson(snaps.map(snapJson));
  if (!snaps.length) return out("no agents registered (use `codexctl start`)");
  out(
    table(
      ["NAME", "STATE", "THREAD", "MODEL", "SANDBOX", "CWD"],
      snaps.map((s) => [
        s.name,
        s.state,
        s.threadId,
        `${s.settings.model ?? "?"}${s.settings.effort ? "/" + s.settings.effort : ""}`,
        `${s.settings.sandbox}/${s.settings.approval}`,
        shortPath(s.settings.cwd, 44),
      ]),
    ),
  );
}

async function cmdRm({ flags, positionals }, json) {
  const [name] = positionals;
  if (!name) throw new UsageError("usage: codexctl rm NAME [--force]");
  const r = await ops.removeAgent(name, { force: flags.force });
  if (json) return printJson(r);
  out(`${name}: unregistered${r.archived ? ", thread archived" : ""}${r.interrupted ? " (running turn interrupted first)" : ""}${r.note ? ` (${r.note})` : ""}`);
}

async function cmdThreads({ flags }, json) {
  const threads = await ops.listThreadsOnDaemon(flags.search ?? null);
  const reg = new Map(Object.values(ops.loadRegistry().agents).map((a) => [a.threadId, a.name]));
  const rows = flags.all ? threads : threads.filter((t) => reg.has(t.id));
  const missing = [...reg].filter(([id]) => !threads.some((t) => t.id === id)).map(([, name]) => name);
  if (json) {
    return printJson({
      threads: rows.map((t) => ({ id: t.id, name: t.name, status: t.status?.type, cwd: t.cwd, updatedAt: t.updatedAt, registeredAs: reg.get(t.id) ?? null })),
      registeredButNotListed: missing,
    });
  }
  if (!rows.length) out(flags.all ? "no threads on the daemon" : "none of the registered agents' threads are listed by the daemon");
  else {
    out(
      table(
        ["THREAD", "NAME", "STATUS", "REGISTERED AS", "CWD"],
        rows.slice(0, 40).map((t) => [t.id, oneLine(t.name ?? t.preview, 36), t.status?.type ?? "?", reg.get(t.id) ?? "", shortPath(t.cwd, 44)]),
      ),
    );
    if (rows.length > 40) out(`... and ${rows.length - 40} more`);
  }
  if (missing.length) out(`registered but not listed by thread/list: ${missing.join(", ")}`);
}

async function cmdDaemon({ positionals }, json) {
  const sub = positionals[0] ?? "status";
  if (sub === "start") {
    const r = await ensureDaemon();
    const s = await daemonStatus();
    if (json) return printJson({ ...s, startedNow: r.started, how: r.how ?? null });
    return out(r.started ? `daemon started (${r.how})  socket ${s.socket}${s.ownPid ? `  pid ${s.ownPid}  log ${daemonLogFile()}` : ""}` : `daemon already running  socket ${s.socket}`);
  }
  if (sub === "stop") {
    const r = await stopDaemon();
    if (json) return printJson(r);
    return out(r.stopped ? `daemon stopped (${r.detail})` : `daemon did not stop: ${r.detail}`);
  }
  if (sub !== "status") throw new UsageError("usage: codexctl daemon [status|start|stop]");
  const s = await daemonStatus();
  if (json) return printJson(s);
  out(s.running ? `daemon running  socket ${s.socket}  loaded threads: ${s.loadedThreads ?? "?"}${s.ownPid ? `  pid ${s.ownPid} (started by codexctl)` : ""}` : `daemon not running  socket ${s.socket}`);
  return s.running ? 0 : 1;
}

const HANDLERS = {
  start: cmdStart,
  send: cmdSend,
  status: cmdStatus,
  log: cmdLog,
  wait: cmdWait,
  result: cmdResult,
  approve: cmdApprove,
  interrupt: cmdInterrupt,
  resume: cmdResume,
  list: cmdList,
  rm: cmdRm,
  threads: cmdThreads,
  daemon: cmdDaemon,
};

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === "--version" || cmd === "version") {
    out("codexctl 0.1.0");
    return 0;
  }
  const def = COMMANDS[cmd];
  if (!def) {
    process.stderr.write(`codexctl: unknown command "${cmd}"\n\n${HELP}`);
    return 1;
  }
  const wantsJson = rest.includes("--json");
  try {
    const parsed = parseArgs(rest, { ...GLOBAL, ...def.flags });
    if (parsed.flags.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const json = !!parsed.flags.json;
    const code = await HANDLERS[cmd](parsed, json);
    const note = ops.daemonStartNote();
    if (note) {
      process.stderr.write(`codexctl: started the codex app-server daemon (${note.how}${note.pid ? `, pid ${note.pid}` : ""}); stop it with \`codexctl daemon stop\`\n`);
    }
    return typeof code === "number" ? code : 0;
  } catch (e) {
    const detail = e instanceof UsageError ? e.message : e instanceof RpcError ? `${e.message} (${e.method}, code ${e.code})` : e.message;
    if (wantsJson) printJson({ error: detail });
    process.stderr.write(e instanceof UsageError ? `codexctl: ${detail}\n` : `codexctl: error: ${detail}\n`);
    if (process.env.CODEXCTL_DEBUG) process.stderr.write(`${e.stack}\n`);
    return 1;
  }
}
