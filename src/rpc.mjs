// JSON-RPC client for the Codex app-server protocol over the daemon's control socket.
import { EventEmitter } from "node:events";
import { UnixWebSocket } from "./ws.mjs";

export class RpcError extends Error {
  constructor(message, code, data, method) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class RpcClient extends EventEmitter {
  /** Events: "notification" ({method, params}), "request" ({id, method, params}), "close" (Error|null) */
  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.on("message", (text) => this._onMessage(text));
    ws.on("close", (err) => this._onClose(err));
  }

  static connect(socketPath, { clientInfo, capabilities, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new UnixWebSocket(socketPath);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${socketPath}`));
      }, timeoutMs);
      ws.once("open", async () => {
        clearTimeout(timer);
        const client = new RpcClient(ws);
        try {
          client.serverInfo = await client.request("initialize", {
            clientInfo: clientInfo ?? { name: "codexctl", title: "codexctl", version: "0.1.0" },
            capabilities: { experimentalApi: false, requestAttestation: false, ...(capabilities ?? {}) },
          }, { timeoutMs });
          client.notify("initialized", {});
          resolve(client);
        } catch (e) {
          client.close();
          reject(e);
        }
      });
      ws.once("close", (err) => {
        clearTimeout(timer);
        reject(err ?? new Error("connection closed during handshake"));
      });
    });
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) return void this.emit("request", msg);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message ?? `${p.method} failed`, msg.error.code, msg.error.data, p.method));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.emit("notification", msg);
  }

  _onClose(err) {
    if (this.closed) return;
    this.closed = true;
    const e = err ?? new Error("connection to the codex app-server closed");
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error("connection to the codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs}ms`, -1, undefined, method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.ws.send(JSON.stringify({ method, params }));
  }

  respond(id, result) {
    if (!this.closed) this.ws.send(JSON.stringify({ id, result }));
  }

  respondError(id, code, message) {
    if (!this.closed) this.ws.send(JSON.stringify({ id, error: { code, message } }));
  }

  close() {
    if (this.closed) return;
    this.ws.close();
  }
}
