import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveState, targetTurn, finalMessage, flattenEvents, encodeCursor, decodeCursor, isLostTurn } from "../src/state.mjs";
import { stripShell, fmtDur, itemLine } from "../src/render.mjs";
import { parseArgs } from "../src/args.mjs";
import { withLock, readJson, writeJsonAtomic } from "../src/lock.mjs";
import { tmpDir } from "./helpers.mjs";

const turn = (id, status, items = [], extra = {}) => ({ id, status, items, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: 1000, ...extra });
const msg = (id, text, phase = "final_answer") => ({ type: "agentMessage", id, text, phase });

test("deriveState covers running, blocked, idle, error and lost", () => {
  const idle = { status: { type: "idle" } };
  assert.equal(deriveState({ status: { type: "active", activeFlags: [] } }, [turn("t", "inProgress")]), "running");
  assert.equal(deriveState({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }, [turn("t", "inProgress")]), "waiting-approval");
  assert.equal(deriveState({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }, [turn("t", "inProgress")]), "waiting-input");
  assert.equal(deriveState(idle, [turn("t", "completed")]), "idle");
  assert.equal(deriveState(idle, [turn("t", "interrupted")]), "idle");
  assert.equal(deriveState(idle, [turn("t", "failed")]), "error");
  assert.equal(deriveState({ status: { type: "systemError" } }, []), "error");
  assert.equal(deriveState({ status: { type: "notLoaded" } }, [turn("t", "inProgress")]), "lost");
  // a just-sent turn that the daemon has not listed yet counts as running
  const now = Date.now();
  assert.equal(deriveState(idle, [turn("old", "completed")], { lastTurnId: "new", lastSendAt: now - 1000 }, now), "running");
  assert.equal(deriveState(idle, [turn("old", "completed")], { lastTurnId: "new", lastSendAt: now - 60000 }, now), "idle");
});

test("isLostTurn recognises the orphaned turn a restarted daemon reports", () => {
  assert.equal(isLostTurn({ status: "interrupted", completedAt: null, durationMs: null }), true);
  assert.equal(isLostTurn({ status: "interrupted", completedAt: 5, durationMs: 100 }), false);
});

test("finalMessage prefers the final_answer phase, falls back to the last message", () => {
  assert.equal(finalMessage(turn("t", "completed", [msg("1", "note", "commentary"), msg("2", "answer"), msg("3", "late note", "commentary")])), "answer");
  assert.equal(finalMessage(turn("t", "interrupted", [msg("1", "only note", "commentary")])), "only note");
  assert.equal(finalMessage(turn("t", "completed", [])), null);
});

test("cursors: incremental, stable and self-healing", () => {
  const t1 = turn("t1", "completed", [msg("m1", "a")]);
  const ev1 = flattenEvents([t1]);
  const c1 = encodeCursor(ev1);
  assert.equal(decodeCursor(c1, ev1).index, ev1.length);
  const ev2 = flattenEvents([t1, turn("t2", "inProgress", [msg("m2", "b")])]);
  assert.equal(decodeCursor(c1, ev2).index, ev1.length);
  assert.ok(ev2.length > ev1.length);
  assert.equal(decodeCursor("0", ev2).index, 0);
  assert.equal(decodeCursor(null, ev2).index, 0);
  assert.throws(() => decodeCursor("nonsense", ev2), /invalid cursor/);
  const mismatch = decodeCursor("3.abcdef", ev2);
  assert.equal(mismatch.index, 0);
  assert.match(mismatch.note, /full log/);
  // an in-flight turn's end event only appears once it completes
  assert.ok(!ev2.some((e) => e.id === "t:t2:end"));
});

test("stripShell unwraps the shell wrapper Codex puts around commands", () => {
  assert.equal(stripShell("/bin/zsh -lc 'ls -la'"), "ls -la");
  assert.equal(stripShell(`/bin/zsh -lc 'echo '\\''hi'\\'''`), "echo 'hi'");
  assert.equal(stripShell("python3 x.py"), "python3 x.py");
  assert.equal(fmtDur(2900), "2.9s");
  assert.equal(fmtDur(125000), "2m05s");
});

test("itemLine renders commands with exit codes and skips empty messages", () => {
  assert.match(itemLine({ type: "commandExecution", command: "/bin/zsh -lc 'ls'", status: "completed", exitCode: 2, durationMs: 1500 }), /^\$ ls {2}\[exit 2, 1.5s\]$/);
  assert.equal(itemLine(msg("1", "  ")), null);
  assert.match(itemLine({ type: "fileChange", status: "completed", changes: [{ path: "/a/b.txt", kind: { type: "add" } }] }), /files completed: add \/a\/b\.txt/);
});

test("parseArgs handles values, =, lists, booleans, aliases and --", () => {
  const spec = { name: { type: "string" }, root: { type: "list" }, force: { type: "bool" }, n: { type: "number" }, file: { type: "string", alias: "f" } };
  const r = parseArgs(["a", "--name=x", "--root", "1", "--root", "2", "--force", "-f", "F", "--n", "3", "--", "--raw"], spec);
  assert.deepEqual(r.flags, { root: ["1", "2"], name: "x", force: true, file: "F", n: 3 });
  assert.deepEqual(r.positionals, ["a", "--raw"]);
  assert.throws(() => parseArgs(["--nope"], spec), /unknown option/);
  assert.throws(() => parseArgs(["--name"], spec), /needs a value/);
  assert.throws(() => parseArgs(["--n", "abc"], spec), /non-negative number/);
});

test("withLock serializes concurrent writers and breaks stale locks", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "counter.json");
  writeJsonAtomic(file, { n: 0 });
  await Promise.all(
    Array.from({ length: 25 }, () =>
      withLock(path.join(dir, "l.lock"), async () => {
        const cur = readJson(file, { n: 0 });
        await new Promise((r) => setTimeout(r, 2));
        writeJsonAtomic(file, { n: cur.n + 1 });
      }),
    ),
  );
  assert.equal(readJson(file).n, 25);
  // a lock left behind by a dead process is broken
  fs.mkdirSync(path.join(dir, "dead.lock"));
  fs.writeFileSync(path.join(dir, "dead.lock", "owner"), "999999\n");
  let ran = false;
  await withLock(path.join(dir, "dead.lock"), async () => {
    ran = true;
  });
  assert.ok(ran);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJson keeps a corrupt file aside instead of losing it silently", () => {
  const dir = tmpDir();
  const f = path.join(dir, "x.json");
  fs.writeFileSync(f, "{not json");
  assert.deepEqual(readJson(f, { ok: 1 }), { ok: 1 });
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("x.json.corrupt-")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("targetTurn follows the turn we sent, unless a newer one started afterwards", () => {
  const a = turn("a", "completed", [], { startedAt: 100 });
  const b = turn("b", "inProgress", [], { startedAt: 200 });
  assert.equal(targetTurn([a, b], { lastTurnId: "a", lastSendAt: 100_000 }).id, "b");
  assert.equal(targetTurn([a, b], { lastTurnId: "b", lastSendAt: 200_000 }).id, "b");
  assert.equal(targetTurn([a], { lastTurnId: "zzz", lastSendAt: 1 }).id, "a");
  assert.equal(targetTurn([], {}), null);
  const c = turn("c", "completed", [], { startedAt: 100 });
  const d = turn("d", "completed", [], { startedAt: 100 });
  assert.equal(targetTurn([c, d], { lastTurnId: "c", lastSendAt: 500_000 }).id, "c", "an older newest turn does not override");
});
