import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, run, sleep, FAKE_CODEX, tmpDir } from "./helpers.mjs";

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => {
  await env.cleanup();
});

const start = (name, prompt, extra = []) => env.run(["start", "--name", name, "--cwd", env.dir, ...extra, prompt]);

test("start registers the agent and wait returns the final message (exit 0)", async () => {
  const r = await start("a1", "FAST hello");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /started agent "a1"\s+thread thr-/);
  const reg = JSON.parse(fs.readFileSync(path.join(env.env.CODEXCTL_HOME, "agents.json"), "utf8"));
  assert.equal(reg.agents.a1.sandbox, "workspace-write");
  assert.equal(reg.agents.a1.approval, "never");
  const w = await env.run(["wait", "a1", "--timeout", "10"]);
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /turn completed/);
  assert.match(w.stdout, /done: FAST hello/);
  const res = await env.run(["result", "a1"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), "done: FAST hello");
});

test("wait right after start does not return the previous turn's answer", async () => {
  await start("a2", "FAST one");
  await env.run(["wait", "a2"]);
  const s = await env.run(["send", "a2", "FAST two"]);
  assert.match(s.stdout, /started new turn/);
  const w = await env.run(["wait", "a2", "--timeout", "10"]); // immediately after send
  assert.match(w.stdout, /done: FAST two/, w.stdout);
});

test("send steers a running turn and starts a new one when idle; steer reaches the agent", async () => {
  await start("a3", "SLOW task");
  await sleep(300);
  const st = await env.run(["status", "a3"]);
  assert.match(st.stdout, /a3\s+running/);
  const s = await env.run(["send", "a3", "change of plan"]);
  assert.match(s.stdout, /steered into the running turn/);
  const wt = await env.run(["wait", "a3", "--timeout", "1"]);
  assert.equal(wt.code, 2, "still running -> timeout exit code 2");
  assert.match(wt.stdout, /timeout after/);
  await env.run(["send", "a3", "FINISH now"]);
  const w = await env.run(["wait", "a3", "--timeout", "10"]);
  assert.equal(w.code, 0);
  assert.match(w.stdout, /steered: FINISH now/);
  const log = await env.run(["log", "a3"]);
  assert.match(log.stdout, /you> change of plan/);
  assert.match(log.stdout, /you> FINISH now/);
});

test("log --since only shows new events and hands back a cursor", async () => {
  await start("a4", "FAST first");
  await env.run(["wait", "a4"]);
  const l1 = await env.run(["log", "a4"]);
  const c1 = /cursor: (\S+)/.exec(l1.stdout)[1];
  assert.match(l1.stdout, /you> FAST first/);
  const none = await env.run(["log", "a4", "--since", c1]);
  assert.match(none.stdout, /\(no new events\)/);
  await env.run(["send", "a4", "FAST second"]);
  await env.run(["wait", "a4"]);
  const l2 = await env.run(["log", "a4", "--since", c1]);
  assert.doesNotMatch(l2.stdout, /FAST first/);
  assert.match(l2.stdout, /you> FAST second/);
  assert.match(l2.stdout, /done: FAST second/);
  const bad = await env.run(["log", "a4", "--since", "5.ffffff"]);
  assert.match(bad.stdout, /showing the full log/);
  assert.match(bad.stdout, /FAST first/);
});

test("approval: wait exits 3 and shows the request; approve unblocks; deny declines", async () => {
  await start("ap1", "APPROVE please", ["--sandbox", "read-only", "--approval", "on-request"]);
  const w = await env.run(["wait", "ap1", "--timeout", "10"]);
  assert.equal(w.code, 3, w.stdout + w.stderr);
  assert.match(w.stdout, /request \d+ \(command\): \$ touch approved\.txt/);
  assert.match(w.stdout, /codexctl approve ap1/);
  const st = await env.run(["status", "ap1"]);
  assert.match(st.stdout, /waiting-approval/);
  assert.match(st.stdout, /blocked on:/);
  const a = await env.run(["approve", "ap1"]);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /approved request/);
  const w2 = await env.run(["wait", "ap1", "--timeout", "10"]);
  assert.equal(w2.code, 0);
  assert.match(w2.stdout, /approved/);

  await start("ap2", "APPROVE deny me");
  const w3 = await env.run(["wait", "ap2", "--until", "approval", "--timeout", "10"]);
  assert.equal(w3.code, 3);
  const d = await env.run(["approve", "ap2", "--deny"]);
  assert.match(d.stdout, /denied request/);
  const w4 = await env.run(["wait", "ap2", "--timeout", "10"]);
  assert.match(w4.stdout, /declined/);
  const none = await env.run(["approve", "ap2"]);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /nothing to approve/);
});

test("matching command rules auto-approve with a plain accept and persist across processes", async () => {
  const r = await start("auto-command", "APPROVE command", ["--approval", "on-request", "--auto-approve", "^/bin/zsh -lc 'touch approved\\.txt'$"]);
  assert.equal(r.code, 0, r.stderr);
  const w = await env.run(["wait", "auto-command", "--timeout", "10"]);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /auto-approved request \d+ \(command\):/);
  assert.match(w.stdout, /turn completed/);
  const response = env.daemon.state.requests.filter((x) => x.method === "response").at(-1);
  assert.deepEqual(response.result, { decision: "accept" });
  const status = await env.run(["status", "auto-command", "--json"]);
  assert.deepEqual(status.json().autoApprove, ["^/bin/zsh -lc 'touch approved\\.txt'$"]);
  assert.equal(status.json().autoApprovals.length, 1);
  const log = await env.run(["log", "auto-command"]);
  assert.match(log.stdout, /auto-approved request/);
  const reg = JSON.parse(fs.readFileSync(path.join(env.env.CODEXCTL_HOME, "agents.json"), "utf8"));
  assert.equal(reg.agents["auto-command"].autoApprovals.length, 1);
});

test("unmatched commands still exit 3; auto add, list and rm work across processes", async () => {
  await start("auto-edit", "APPROVE command", ["--auto-approve", "^no match$"]);
  const list = await env.run(["auto", "auto-edit", "list", "--json"]);
  assert.deepEqual(list.json().command, ["^no match$"]);
  const w = await env.run(["wait", "auto-edit", "--timeout", "10"]);
  assert.equal(w.code, 3, w.stdout + w.stderr);
  assert.equal(env.daemon.state.requests.filter((x) => x.method === "response" && x.id === Number(w.stdout.match(/request (\d+)/)?.[1])).length, 0);
  const add = await env.run(["auto", "auto-edit", "add", "touch approved\\.txt", "--json"]);
  assert.deepEqual(add.json().command, ["^no match$", "touch approved\\.txt"]);
  const rm = await env.run(["auto", "auto-edit", "rm", "^no match$", "--json"]);
  assert.deepEqual(rm.json().command, ["touch approved\\.txt"]);
  const w2 = await env.run(["wait", "auto-edit", "--timeout", "10", "--json"]);
  assert.equal(w2.code, 0, w2.stdout + w2.stderr);
  assert.equal(w2.json().autoApprovals.length, 1);
});

test("file rules require every changed path to match", async () => {
  await start("file-safe", "FILE_SAFE", ["--auto-approve-files", "^/safe/"]);
  const safe = await env.run(["wait", "file-safe", "--timeout", "10"]);
  assert.equal(safe.code, 0, safe.stdout + safe.stderr);
  assert.match(safe.stdout, /auto-approved request \d+ \(file-change\)/);
  await start("file-mix", "FILE_MIX", ["--auto-approve-files", "^/safe/"]);
  const mix = await env.run(["wait", "file-mix", "--timeout", "10"]);
  assert.equal(mix.code, 3, mix.stdout + mix.stderr);
  const added = await env.run(["auto", "file-mix", "add", "^/(safe|other)/", "--files", "--json"]);
  assert.deepEqual(added.json().files, ["^/safe/", "^/(safe|other)/"]);
  const finished = await env.run(["wait", "file-mix", "--timeout", "10"]);
  assert.equal(finished.code, 0, finished.stdout + finished.stderr);
  const removed = await env.run(["auto", "file-mix", "rm", "^/(safe|other)/", "--files", "--json"]);
  assert.deepEqual(removed.json().files, ["^/safe/"]);
});

test("MCP elicitations are never auto-approved and invalid regexes are rejected", async () => {
  const bad = await start("bad-rule", "FAST", ["--auto-approve", "["]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid regex/);
  await start("elicitation", "ELICIT", ["--auto-approve", ".*", "--auto-approve-files", ".*"]);
  const w = await env.run(["wait", "elicitation", "--timeout", "10"]);
  assert.equal(w.code, 3, w.stdout + w.stderr);
  assert.match(w.stdout, /mcp-elicitation/);
  const add = await env.run(["auto", "elicitation", "add", "[", "--json"]);
  assert.equal(add.code, 1);
  assert.match(add.json().error, /invalid regex/);
});

test("approve --id picks a request and rejects an unknown id", async () => {
  await start("ap3", "APPROVE ids");
  await env.run(["wait", "ap3", "--timeout", "10"]);
  const bad = await env.run(["approve", "ap3", "--id", "99999"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no pending request with id 99999/);
  const ok = await env.run(["approve", "ap3"]);
  assert.equal(ok.code, 0);
  await env.run(["wait", "ap3", "--timeout", "10"]);
});

test("agent questions: wait exits 3 after the turn completes", async () => {
  await start("q1", "ASK me");
  const w = await env.run(["wait", "q1", "--timeout", "10"]);
  assert.equal(w.code, 3);
  assert.match(w.stdout, /the agent is asking/);
  assert.match(w.stdout, /Which color\?/);
});

test("interrupt stops a running turn; interrupting an idle agent does not hang", async () => {
  await start("i1", "SLOW forever");
  await sleep(300);
  const r = await env.run(["interrupt", "i1"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /interrupted turn/);
  const w = await env.run(["wait", "i1", "--timeout", "5"]);
  assert.equal(w.code, 0);
  assert.match(w.stdout, /turn interrupted/);
  const t0 = Date.now();
  const again = await env.run(["interrupt", "i1"], { timeoutMs: 8000 });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /no turn is running/);
  assert.ok(Date.now() - t0 < 5000);
});

test("wait --until any-message returns on the first new agent message", async () => {
  await start("m1", "APPROVE msg");
  const w = await env.run(["wait", "m1", "--until", "any-message", "--timeout", "10"]);
  // the commentary message arrives before the approval block
  assert.match(w.stdout, /asking permission/);
  await env.run(["approve", "m1"]);
  await env.run(["wait", "m1", "--timeout", "10"]);
});

test("daemon restart: lost turn is labelled, send reloads the thread and re-applies settings", async () => {
  await start("r1", "SLOW restart-me", ["--writable-root", "/tmp/extra", "--effort", "low"]);
  await sleep(300);
  env.daemon.restart();
  const st = await env.run(["status", "r1"]);
  assert.match(st.stdout, /r1\s+idle/);
  assert.match(st.stdout, /lost: the daemon restarted mid-turn/);
  const w = await env.run(["wait", "r1", "--timeout", "5"]);
  assert.equal(w.code, 0);
  assert.match(w.stdout, /lost: the daemon restarted/);
  const res = await env.run(["resume", "r1"]);
  assert.match(res.stdout, /already loaded|reloaded/);
  env.daemon.restart();
  const s = await env.run(["send", "r1", "FAST after restart"]);
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /started new turn/);
  const startReq = env.daemon.state.requests.filter((q) => q.method === "turn/start").at(-1);
  assert.deepEqual(startReq.params.sandboxPolicy.writableRoots, ["/tmp/extra"]);
  assert.equal(startReq.params.effort, "low");
  const w2 = await env.run(["wait", "r1", "--timeout", "10"]);
  assert.match(w2.stdout, /done: FAST after restart/);
});

test("concurrent sends: one starts the turn, the other steers it", async () => {
  await start("c1", "FAST c1");
  await env.run(["wait", "c1"]);
  const [a, b] = await Promise.all([env.run(["send", "c1", "SLOW parallel-a"]), env.run(["send", "c1", "parallel-b"])]);
  const modes = [a, b].map((x) => (/started new turn/.test(x.stdout) ? "started" : /steered/.test(x.stdout) ? "steered" : `??${x.stdout}${x.stderr}`));
  assert.deepEqual(modes.sort(), ["started", "steered"]);
  await env.run(["interrupt", "c1"]);
});

test("concurrent start with the same name: exactly one wins and no orphan thread is left", async () => {
  const before = [...env.daemon.threads.values()].filter((t) => !t.archived).length;
  const rs = await Promise.all([start("dup", "FAST x"), start("dup", "FAST y"), start("dup", "FAST z")]);
  const ok = rs.filter((r) => r.code === 0);
  assert.equal(ok.length, 1, rs.map((r) => r.stdout + r.stderr).join("\n"));
  const live = [...env.daemon.threads.values()].filter((t) => !t.archived).length;
  assert.equal(live, before + 1, "the losers' threads were archived");
});

test("concurrent registry updates do not lose writes", async () => {
  const names = Array.from({ length: 6 }, (_, i) => `p${i}`);
  const rs = await Promise.all(names.map((n) => start(n, `FAST ${n}`)));
  assert.ok(rs.every((r) => r.code === 0), rs.map((r) => r.stderr).join("\n"));
  const list = await env.run(["list", "--json"]);
  const got = list.json().map((x) => x.name);
  for (const n of names) assert.ok(got.includes(n), `${n} missing from ${got}`);
});

test("rm archives and unregisters; a running agent needs --force", async () => {
  await start("rm1", "SLOW rm");
  await sleep(200);
  const denied = await env.run(["rm", "rm1"]);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /still running/);
  const r = await env.run(["rm", "rm1", "--force"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unregistered, thread archived/);
  const st = await env.run(["status", "rm1"]);
  assert.equal(st.code, 1);
  assert.match(st.stderr, /no such agent/);
});

test("threads shows the registered agents as the daemon lists them", async () => {
  const r = await env.run(["threads"]);
  assert.match(r.stdout, /a1/);
  assert.match(r.stdout, /THREAD\s+NAME\s+STATUS/);
});

test("--json output is parseable and errors are json too", async () => {
  const s = await env.run(["status", "a1", "--json"]);
  const j = s.json();
  assert.equal(j.name, "a1");
  assert.equal(j.state, "idle");
  const w = await env.run(["wait", "a1", "--json"]);
  assert.equal(w.json().result, "complete");
  assert.match(w.json().text, /done: FAST hello/);
  const bad = await env.run(["status", "ghost", "--json"]);
  assert.equal(bad.code, 1);
  assert.match(bad.json().error, /no such agent: ghost/);
});

test("usage errors: unknown option, missing args, prompt from file and stdin", async () => {
  const a = await env.run(["send", "a1", "--bogus"]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /unknown option: --bogus/);
  const b = await env.run(["start", "--name", "x y", "FAST"]);
  assert.match(b.stderr, /--name must match/);
  const c = await env.run(["start", "--name", "fromstdin", "--cwd", env.dir, "-"], { input: "FAST via stdin" });
  assert.equal(c.code, 0, c.stderr);
  const f = path.join(env.dir, "prompt.txt");
  fs.writeFileSync(f, "FAST via file");
  const d = await env.run(["start", "--name", "fromfile", "--cwd", env.dir, "--prompt-file", f]);
  assert.equal(d.code, 0, d.stderr);
  const e = await env.run(["send", "a1", "--", "--dashes are fine"]);
  assert.equal(e.code, 0, e.stderr);
  await env.run(["wait", "a1"]);
  const log = await env.run(["log", "a1"]);
  assert.match(log.stdout, /you> --dashes are fine/);
});

test("daemon autostart: a missing daemon is started (and stale sockets are replaced), failure is explained", async () => {
  const dir = tmpDir();
  const sock = path.join(dir, "auto.sock");
  const base = { CODEXCTL_HOME: path.join(dir, "home"), CODEXCTL_SOCKET: sock, CODEXCTL_DAEMON_START_TIMEOUT_MS: "8000" };
  // no codex binary at all
  const bad = await run(["daemon", "start"], { env: { ...base, CODEXCTL_CODEX_BIN: "/nonexistent/codex", CODEXCTL_DAEMON_START_TIMEOUT_MS: "1200" } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /could not reach or start the codex app-server daemon/);
  // a stale socket file with nothing behind it, plus a working (fake) codex
  fs.writeFileSync(sock, "");
  const good = await run(["daemon", "start"], { env: { ...base, CODEXCTL_CODEX_BIN: FAKE_CODEX } });
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /daemon started/);
  const st = await run(["daemon", "status"], { env: base });
  assert.match(st.stdout, /daemon running/);
  const stop = await run(["daemon", "stop"], { env: base });
  assert.match(stop.stdout, /daemon stopped/);
  const after = await run(["daemon", "status"], { env: { ...base, CODEXCTL_CODEX_BIN: "/nonexistent/codex" } });
  assert.match(after.stdout, /daemon not running/);
  fs.rmSync(dir, { recursive: true, force: true });
});
