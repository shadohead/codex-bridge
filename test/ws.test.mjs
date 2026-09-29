import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { UnixWebSocket } from "../src/ws.mjs";
import { tmpDir } from "./helpers.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function rawFrame(opcode, payload, { fin = true } = {}) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  else if (len < 65536) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Server that completes the handshake and then runs script(sock). */
async function server(script) {
  const dir = tmpDir();
  const sockPath = path.join(dir, "ws.sock");
  const received = [];
  const srv = net.createServer((sock) => {
    let upgraded = false;
    let buf = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /sec-websocket-key:\s*(.*)/i.exec(buf.subarray(0, end).toString())[1].trim();
        buf = buf.subarray(end + 4);
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
        upgraded = true;
        script(sock);
      }
      // record client frames (must be masked)
      while (upgraded && buf.length >= 2) {
        assert.ok(buf[1] & 0x80, "client frames must be masked");
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) {
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + 4 + len) break;
        const mask = buf.subarray(off, off + 4);
        const p = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        received.push({ opcode: buf[0] & 15, payload: p });
        buf = buf.subarray(off + 4 + len);
      }
    });
  });
  await new Promise((r) => srv.listen(sockPath, r));
  return { sockPath, received, close: () => new Promise((r) => srv.close(r)), dir };
}

test("ws client: big frames, fragmentation across tcp chunks, ping/pong, masked client frames", async () => {
  const big = "x".repeat(70000) + "é€😀";
  const s = await server(async (sock) => {
    sock.write(rawFrame(1, Buffer.from(big)));
    // fragmented text message delivered one byte at a time
    const frag = Buffer.concat([rawFrame(1, Buffer.from('{"a":'), { fin: false }), rawFrame(0, Buffer.from("1}"), { fin: true })]);
    for (const b of frag) {
      sock.write(Buffer.from([b]));
      await new Promise((r) => setTimeout(r, 1));
    }
    sock.write(rawFrame(9, Buffer.from("hi"))); // ping
    sock.write(rawFrame(1, Buffer.from("after-ping")));
  });
  const ws = new UnixWebSocket(s.sockPath);
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on("message", (m) => {
      messages.push(m);
      if (m === "after-ping") resolve();
    });
    ws.on("close", (e) => reject(e ?? new Error("closed early")));
    ws.on("open", () => ws.send("y".repeat(200000))); // 64-bit length path, client side
  });
  assert.equal(messages[0], big);
  assert.equal(messages[1], '{"a":1}');
  assert.equal(messages[2], "after-ping");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(s.received.some((f) => f.opcode === 10 && f.payload.toString() === "hi"), "pong echoes the ping payload");
  assert.ok(s.received.some((f) => f.opcode === 1 && f.payload.length === 200000));
  ws.close();
  await s.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test("ws client: a refused upgrade or a dead socket surfaces as a close with an error", async () => {
  const dir = tmpDir();
  const sockPath = path.join(dir, "bad.sock");
  const srv = net.createServer((sock) => sock.on("data", () => sock.end("HTTP/1.1 403 Forbidden\r\n\r\n")));
  await new Promise((r) => srv.listen(sockPath, r));
  const err = await new Promise((resolve) => {
    const ws = new UnixWebSocket(sockPath);
    ws.on("close", resolve);
  });
  assert.match(err.message, /upgrade refused: HTTP\/1.1 403/);
  await new Promise((r) => srv.close(r));
  const err2 = await new Promise((resolve) => new UnixWebSocket(path.join(dir, "nothing.sock")).on("close", resolve));
  assert.equal(err2.code, "ENOENT");
  fs.rmSync(dir, { recursive: true, force: true });
});
