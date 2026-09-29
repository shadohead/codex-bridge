// Minimal RFC 6455 WebSocket client over a unix domain socket (text frames only).
// The Codex app-server daemon speaks JSON-RPC over WebSocket on
// ~/.codex/app-server-control/app-server-control.sock, and Node has no built-in
// way to open a WebSocket over a unix socket, so we do the (small) protocol ourselves.
import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class UnixWebSocket extends EventEmitter {
  /** Events: "open", "message" (string), "close" (Error|null), "error" */
  constructor(socketPath, { host = "localhost", path = "/" } = {}) {
    super();
    this.socketPath = socketPath;
    this.readyState = "connecting";
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this._frags = [];
    this._fragOpcode = 0;
    this._closed = false;
    const key = crypto.randomBytes(16).toString("base64");
    this._expectAccept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    this.sock = net.createConnection({ path: socketPath });
    this.sock.on("connect", () => {
      this.sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("error", (e) => this._fail(e));
    this.sock.on("close", () => this._fail(null));
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = "closed";
    this.sock.destroy();
    this.emit("close", err);
  }

  _onData(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    if (!this._handshakeDone) {
      const end = this._buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this._buf.subarray(0, end).toString("latin1");
      this._buf = this._buf.subarray(end + 4);
      const lines = head.split("\r\n");
      if (!/^HTTP\/1\.1 101/.test(lines[0])) return this._fail(new Error(`websocket upgrade refused: ${lines[0]}`));
      const accept = lines.map((l) => /^sec-websocket-accept:\s*(.*)$/i.exec(l)).find(Boolean)?.[1]?.trim();
      if (accept !== this._expectAccept) return this._fail(new Error("websocket upgrade: bad Sec-WebSocket-Accept"));
      this._handshakeDone = true;
      this.readyState = "open";
      this.emit("open");
    }
    for (;;) {
      const f = this._parseFrame();
      if (!f) break;
      this._onFrame(f);
      if (this._closed) return;
    }
  }

  _parseFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: // binary
        if (opcode !== 0) {
          this._frags = [];
          this._fragOpcode = opcode;
        }
        this._frags.push(payload);
        if (fin) {
          const whole = Buffer.concat(this._frags);
          this._frags = [];
          this.emit("message", whole.toString("utf8"));
        }
        break;
      case 0x8: // close
        this._sendFrame(0x8, payload.subarray(0, 2));
        this._fail(null);
        break;
      case 0x9: // ping
        this._sendFrame(0xa, payload);
        break;
      default: // pong and unknown: ignore
        break;
    }
  }

  _sendFrame(opcode, payload) {
    if (this._closed || !this.sock.writable) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text) {
    if (this.readyState !== "open") throw new Error("websocket is not open");
    this._sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    if (this._closed) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch {}
    // give the close frame a moment to flush, then drop the socket
    this.sock.end();
    setTimeout(() => this._fail(null), 200).unref();
  }
}
