// A scriptable stand-in for the Codex app-server daemon (JSON-RPC over WebSocket on a unix socket),
// implementing just enough of the protocol to exercise codexctl deterministically and offline.
//
// Behaviour is keyed off the prompt text:
//   FAST          turn completes after ~150ms with "done: <prompt>"
//   SLOW          turn stays in progress until interrupted (steers are recorded; a steer containing FINISH ends it)
//   APPROVE       turn blocks on a command approval; accept -> "approved", decline -> "declined"
//   ASK           turn completes with an agent message that carries async questions
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let seq = 0;
const uid = (p) => `${p}-${String(++seq).padStart(4, "0")}`;

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : null;
  if (!head) {
    const h = Buffer.alloc(10);
    h[0] = 0x80 | opcode;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return Buffer.concat([h, payload]);
  }
  return Buffer.concat([head, payload]);
}

export async function startFakeDaemon(sockPath, { log = () => {} } = {}) {
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {}
  const threads = new Map();
  const conns = new Set();
  const state = { requests: [], log };

  const send = (c, obj) => {
    if (!c.sock.destroyed) c.sock.write(frame(1, Buffer.from(JSON.stringify(obj))));
  };
  const notify = (thread, method, params) => {
    for (const c of conns) if (c.subs.has(thread.id) && !c.optOut.has(method)) send(c, { method, params });
  };
  const setStatus = (t, type, flags = []) => {
    t.status = type === "active" ? { type: "active", activeFlags: flags } : { type };
    notify(t, "thread/status/changed", { threadId: t.id, status: t.status });
    t.updatedAt = Math.floor(Date.now() / 1000);
  };
  const threadView = (t, withTurns = false) => ({
    id: t.id,
    name: t.name,
    preview: t.preview,
    status: t.loaded ? t.status : { type: "notLoaded" },
    cwd: t.cwd,
    path: null,
    model: t.model,
    reasoningEffort: t.effort,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    turns: withTurns ? t.turns : [],
  });
  const cur = (t) => t.turns.at(-1);
  const addItem = (t, turn, item) => {
    turn.items.push(item);
    notify(t, "item/completed", { threadId: t.id, turnId: turn.id, item });
  };
  const finish = (t, turn, status, text) => {
    if (text) addItem(t, turn, { type: "agentMessage", id: uid("msg"), text, phase: "final_answer", questions: turn.questions ?? null });
    turn.status = status;
    turn.completedAt = Math.floor(Date.now() / 1000);
    turn.durationMs = Date.now() - turn.startMs;
    t.pending = null;
    setStatus(t, "idle");
    notify(t, "turn/completed", { threadId: t.id, turn });
    if (![...conns].some((c) => c.subs.has(t.id))) t.loaded = false; // unloaded when nobody listens
  };
  const userItem = (text) => ({ type: "userMessage", id: uid("usr"), content: [{ type: "text", text }] });

  function startTurn(t, text) {
    const turn = { id: uid("turn"), status: "inProgress", items: [], itemsView: "full", startedAt: Math.floor(Date.now() / 1000), startMs: Date.now(), completedAt: null, durationMs: null, error: null };
    t.turns.push(turn);
    t.preview ||= text;
    setStatus(t, "active");
    notify(t, "turn/started", { threadId: t.id, turn });
    addItem(t, turn, userItem(text));
    if (/FAST/.test(text)) {
      setTimeout(() => finish(t, turn, "completed", `done: ${text}`), 150);
    } else if (/ASK/.test(text)) {
      turn.questions = [{ title: "Which color?", options: ["red", "blue"] }];
      setTimeout(() => finish(t, turn, "completed", "I need to know something."), 150);
    } else if (/APPROVE/.test(text)) {
      setTimeout(() => {
        addItem(t, turn, { type: "agentMessage", id: uid("msg"), text: "asking permission", phase: "commentary" });
        setStatus(t, "active", ["waitingOnApproval"]);
        const req = { id: seq++, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: t.id, turnId: turn.id, itemId: uid("exec"), command: "/bin/zsh -lc 'touch approved.txt'", cwd: t.cwd, reason: "needs write access" }, turn };
        t.pending = req;
        for (const c of conns) if (c.subs.has(t.id)) send(c, { id: req.id, method: req.method, params: req.params });
      }, 100);
    } else if (/SLOW/.test(text)) {
      // stays in progress
    } else {
      setTimeout(() => finish(t, turn, "completed", `echo: ${text}`), 150);
    }
    return turn;
  }

  const handlers = {
    initialize: () => ({ userAgent: "fake-codex/0.0.0", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }),
    "thread/start": (c, p) => {
      const t = { id: uid("thr"), name: null, preview: "", cwd: p.cwd, model: p.model ?? "gpt-fake", effort: p.config?.model_reasoning_effort ?? "medium", createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), status: { type: "idle" }, loaded: true, turns: [], pending: null, archived: false };
      threads.set(t.id, t);
      c.subs.add(t.id);
      return { thread: threadView(t), model: t.model, reasoningEffort: t.effort, cwd: t.cwd, approvalPolicy: p.approvalPolicy ?? "never" };
    },
    "thread/name/set": (c, p) => {
      get(p.threadId).name = p.name;
      return {};
    },
    "thread/read": (c, p) => ({ thread: threadView(get(p.threadId), p.includeTurns) }),
    "thread/resume": (c, p) => {
      const t = get(p.threadId);
      t.loaded = true;
      c.subs.add(t.id);
      if (t.pending) setTimeout(() => send(c, { id: t.pending.id, method: t.pending.method, params: t.pending.params }), 30);
      return { thread: threadView(t), model: t.model, reasoningEffort: t.effort, cwd: t.cwd };
    },
    "thread/turns/list": (c, p) => {
      const t = get(p.threadId);
      let list = t.turns.slice();
      if (p.sortDirection !== "asc") list.reverse();
      const start = p.cursor ? parseInt(p.cursor, 10) : 0;
      const limit = p.limit ?? 25;
      const page = list.slice(start, start + limit);
      return { data: page, nextCursor: start + limit < list.length ? String(start + limit) : null, backwardsCursor: null };
    },
    "turn/start": (c, p) => {
      const t = get(p.threadId);
      if (!t.loaded) throw rpcErr(-32600, `thread not loaded: ${t.id}`);
      state.requests.push({ method: "turn/start", params: p });
      const text = p.input.map((i) => i.text).join(" ");
      if (t.status.type === "active") return steer(t, text);
      return { turn: startTurn(t, text) };
    },
    "turn/steer": (c, p) => {
      const t = get(p.threadId);
      state.requests.push({ method: "turn/steer", params: p });
      if (t.status.type !== "active") throw rpcErr(-32600, "no active turn to steer");
      if (cur(t).id !== p.expectedTurnId) throw rpcErr(-32600, `expected active turn id \`${p.expectedTurnId}\` but found \`${cur(t).id}\``);
      return steer(t, p.input.map((i) => i.text).join(" "));
    },
    "turn/interrupt": (c, p) => {
      const t = get(p.threadId);
      if (t.status.type !== "active") return NEVER; // the real server never answers here
      finish(t, cur(t), "interrupted", null);
      return {};
    },
    "thread/archive": (c, p) => {
      get(p.threadId).archived = true;
      return {};
    },
    "thread/list": () => ({ data: [...threads.values()].filter((t) => !t.archived).map((t) => threadView(t)), nextCursor: null }),
    "thread/loaded/list": () => ({ data: [...threads.values()].filter((t) => t.loaded).map((t) => t.id), nextCursor: null }),
  };
  const NEVER = Symbol("never");
  const rpcErr = (code, message) => Object.assign(new Error(message), { rpcCode: code });
  const get = (id) => {
    const t = threads.get(id);
    if (!t) throw rpcErr(-32600, `thread not found: ${id}`);
    return t;
  };
  function steer(t, text) {
    const turn = cur(t);
    addItem(t, turn, userItem(text));
    if (/FINISH/.test(text)) setTimeout(() => finish(t, turn, "completed", `steered: ${text}`), 100);
    return { turnId: turn.id, turn };
  }

  function onMessage(c, text) {
    const msg = JSON.parse(text);
    if (msg.method === "initialize") c.optOut = new Set(msg.params?.capabilities?.optOutNotificationMethods ?? []);
    if (msg.id !== undefined && !msg.method) {
      // response to one of our server requests (approval)
      state.requests.push({ method: "response", id: msg.id, result: msg.result });
      for (const t of threads.values()) {
        if (t.pending && t.pending.id === msg.id) {
          const turn = t.pending.turn;
          const accepted = msg.result?.decision === "accept" || msg.result?.decision === "acceptForSession";
          t.pending = null;
          notify(t, "serverRequest/resolved", { threadId: t.id, requestId: msg.id });
          setStatus(t, "active");
          setTimeout(() => finish(t, turn, "completed", accepted ? "approved" : "declined"), 100);
        }
      }
      return;
    }
    if (msg.id === undefined) return;
    const h = handlers[msg.method];
    try {
      if (!h) throw rpcErr(-32601, `unknown method ${msg.method}`);
      const result = h(c, msg.params ?? {});
      if (result !== NEVER) send(c, { id: msg.id, result });
    } catch (e) {
      send(c, { id: msg.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
  }

  const server = net.createServer((sock) => {
    const c = { sock, subs: new Set(), optOut: new Set(), buf: Buffer.alloc(0), upgraded: false };
    conns.add(c);
    sock.on("error", () => {});
    sock.on("close", () => {
      conns.delete(c);
      for (const id of c.subs) {
        const t = threads.get(id);
        if (t && t.status.type === "idle" && ![...conns].some((x) => x.subs.has(id))) t.loaded = false;
      }
    });
    sock.on("data", (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      if (!c.upgraded) {
        const end = c.buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = c.buf.subarray(0, end).toString();
        c.buf = c.buf.subarray(end + 4);
        const key = /sec-websocket-key:\s*(.*)/i.exec(head)[1].trim();
        const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
        c.upgraded = true;
      }
      for (;;) {
        const b = c.buf;
        if (b.length < 2) return;
        const opcode = b[0] & 15;
        let len = b[1] & 127;
        let off = 2;
        if (len === 126) {
          if (b.length < 4) return;
          len = b.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (b.length < 10) return;
          len = Number(b.readBigUInt64BE(2));
          off = 10;
        }
        if (b.length < off + 4 + len) return;
        const mask = b.subarray(off, off + 4);
        const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        c.buf = b.subarray(off + 4 + len);
        if (opcode === 1) onMessage(c, payload.toString());
        else if (opcode === 8) {
          sock.end(frame(8, Buffer.alloc(0)));
          return;
        } else if (opcode === 9) sock.write(frame(10, payload));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  return {
    sockPath,
    threads,
    state,
    /** Simulate a daemon crash + restart: everything unloads, running turns become orphaned "interrupted" turns. */
    restart() {
      for (const c of conns) c.sock.destroy();
      for (const t of threads.values()) {
        t.loaded = false;
        t.pending = null;
        t.status = { type: "idle" };
        const last = cur(t);
        if (last?.status === "inProgress") last.status = "interrupted";
      }
    },
    async close() {
      for (const c of conns) c.sock.destroy();
      await new Promise((r) => server.close(r));
      fs.rmSync(sockPath, { force: true });
    },
  };
}

/** Behave like `codex app-server --listen unix://PATH` (used by test/fake-codex). */
export async function runFakeCodex(argv) {
  if (argv[2] === "app-server" && argv[3] === "daemon") {
    process.stderr.write("Error: managed standalone Codex install not found\n");
    process.exit(1);
  }
  const listen = argv[argv.indexOf("--listen") + 1] ?? "";
  const sock = listen.replace(/^unix:\/\//, "");
  if (!sock) process.exit(2);
  await startFakeDaemon(sock);
}
