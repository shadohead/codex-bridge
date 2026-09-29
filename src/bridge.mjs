// Connection to the shared daemon plus the handful of protocol helpers every command needs.
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { RpcClient } from "./rpc.mjs";
import { ensureDaemon, CLIENT_INFO } from "./daemon.mjs";
import { socketPath } from "./paths.mjs";

/** Notifications we never need (streamed deltas, MCP boot chatter, rate limits ...). */
export const QUIET_METHODS = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification",
  "account/rateLimits/updated",
  "remoteControl/status/changed",
  "thread/tokenUsage/updated",
  "warning",
  "deprecationNotice",
];

/** Server->client requests that mean "the agent is blocked on a human". */
export const BLOCKING_REQUESTS = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file-change",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "question",
  "mcpServer/elicitation/request": "mcp-elicitation",
  execCommandApproval: "command",
  applyPatchApproval: "file-change",
};

export class Bridge extends EventEmitter {
  /** Events: "wake" (threadId), "pending" (request record), "close" */
  constructor(client) {
    super();
    this.client = client;
    this.pending = new Map(); // key `${threadId}#${id}` -> record
    this.closed = false;
    client.on("notification", (m) => this._onNotification(m));
    client.on("request", (m) => this._onRequest(m));
    client.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
  }

  static async open({ autostart = true, quiet = true, onDaemonStart } = {}) {
    if (autostart) await ensureDaemon({ onStart: onDaemonStart });
    const client = await RpcClient.connect(socketPath(), {
      clientInfo: CLIENT_INFO,
      capabilities: quiet ? { optOutNotificationMethods: QUIET_METHODS } : {},
    });
    return new Bridge(client);
  }

  close() {
    this.client.close();
  }

  request(method, params, opts) {
    return this.client.request(method, params, opts);
  }

  _onNotification(m) {
    const p = m.params ?? {};
    if (m.method === "serverRequest/resolved") {
      for (const [k, rec] of this.pending) {
        if (rec.threadId === p.threadId && String(rec.id) === String(p.requestId)) this.pending.delete(k);
      }
    }
    const threadId = p.threadId ?? p.thread?.id ?? p.turn?.threadId;
    this.emit("notification", m);
    if (threadId) this.emit("wake", threadId, m);
  }

  _onRequest(m) {
    const kind = BLOCKING_REQUESTS[m.method];
    if (!kind) {
      // Auth refresh, dynamic tool calls, attestation ...: we support none of them.
      this.client.respondError(m.id, -32601, `codexctl does not support server request ${m.method}`);
      return;
    }
    const p = m.params ?? {};
    const rec = {
      id: m.id,
      method: m.method,
      kind,
      threadId: p.threadId ?? p.conversationId,
      turnId: p.turnId ?? null,
      itemId: p.itemId ?? null,
      params: p,
      receivedAt: Date.now(),
    };
    this.pending.set(`${rec.threadId}#${rec.id}`, rec);
    this.emit("pending", rec);
    this.emit("wake", rec.threadId, m);
  }

  pendingFor(threadId) {
    return [...this.pending.values()].filter((r) => r.threadId === threadId).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  // ---- protocol helpers -------------------------------------------------

  /** thread/read without turns: status, name, cwd, rollout path ... Also works for threads that are not loaded. */
  async readThread(threadId) {
    return (await this.request("thread/read", { threadId })).thread;
  }

  /** Subscribe this connection to a loaded thread (replays pending server requests to us). */
  async attach(threadId) {
    return this.request("thread/resume", { threadId, excludeTurns: true }, { timeoutMs: 60000 });
  }

  /** Recent turns (oldest first) with their completed items. */
  async recentTurns(threadId, limit = 3) {
    const r = await this.request("thread/turns/list", { threadId, limit, sortDirection: "desc", itemsView: "full" });
    return (r.data ?? []).slice().reverse();
  }

  /** Every turn (oldest first) with items, following pagination. */
  async allTurns(threadId) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 200; i++) {
      const r = await this.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 50,
        sortDirection: "asc",
        itemsView: "full",
      });
      out.push(...(r.data ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
}

/** Best-effort token usage from the tail of a thread's rollout file (the RPC API only streams it live). */
export function readTokenUsage(rolloutPath) {
  if (!rolloutPath) return null;
  let fd;
  try {
    fd = fs.openSync(rolloutPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"token_count"')) continue;
      try {
        const info = JSON.parse(l)?.payload?.info;
        if (info?.total_token_usage) {
          return {
            total: info.total_token_usage.total_tokens,
            input: info.total_token_usage.input_tokens,
            cached: info.total_token_usage.cached_input_tokens,
            output: info.total_token_usage.output_tokens,
            reasoning: info.total_token_usage.reasoning_output_tokens,
            lastTurnTotal: info.last_token_usage?.total_tokens ?? null,
            contextWindow: info.model_context_window ?? null,
          };
        }
      } catch {}
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}
