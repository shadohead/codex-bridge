# codex-bridge (`codexctl`)

`codexctl` lets a Claude Code agent run and talk to OpenAI Codex agents the way it talks to its own subagents.
You can start an agent, message it (also while it is mid-turn), inspect what it is doing, wait for it to finish or ask something, read its answer, interrupt it, and resume it later.

It is a small zero-dependency Node CLI (Node 20+). Developed and tested on macOS.
It talks JSON-RPC to the Codex app-server daemon, so the threads it creates are ordinary Codex threads: the human can watch and join them in `codex agents`.

## Install

```sh
cd ~/Projects/codex-bridge
./install.sh                                        # symlinks bin/codexctl into ~/.local/bin
codexctl --help
```

Requirements: Codex CLI 0.155+ logged in (ChatGPT or API key), Node 20+.
No `npm install` is needed.

## Quick start

```sh
codexctl start --name reviewer --cwd ~/Projects/app --model gpt-6-sol --effort medium "Review the last commit and list bugs."
codexctl wait reviewer --timeout 600        # blocks; prints the final message; exit 0 done, 2 timeout, 3 approval/question, 1 error
codexctl send reviewer "Now fix the first one."   # steers if a turn is running, starts a new turn otherwise
codexctl status                             # table of all agents
codexctl status reviewer                    # one agent in detail (state, elapsed, recent commands, in-flight command, tokens)
codexctl log reviewer --since 12.ab12cd     # only what is new since the cursor printed by the previous call
codexctl interrupt reviewer
codexctl rm reviewer                        # unregister and archive the thread
```

A Claude agent normally runs `codexctl wait NAME` in a background shell and gets notified when it exits.
The exit code says what happened, the output says why.

## Commands

| command | what it does |
| --- | --- |
| `start --name NAME [--model M] [--effort low\|medium\|high\|xhigh] [--cwd DIR] [--sandbox read-only\|workspace-write] [--writable-root DIR ...] [--network] [--approval never\|on-request] [--auto-approve REGEX ...] [--auto-approve-files REGEX ...] (PROMPT \| --prompt-file F \| -)` | Creates a thread named NAME, starts its first turn, returns immediately with the thread id. Defaults: workspace-write sandbox, approval `never`, model and effort from your Codex config. |
| `send NAME (MESSAGE \| --file F \| -)` | If a turn is running the message is steered into it (`turn/steer`). Otherwise a new turn starts. Returns immediately. Use `--` before a message that starts with dashes. |
| `status [NAME]` | Without NAME a table of all agents. With NAME: state, turn elapsed time, thread and settings, token usage, the last items (commands with exit codes, patched files, agent messages), the in-flight command when a `wait` is attached, and any pending approval. |
| `log NAME [--since CURSOR] [--full]` | Transcript events (turns, messages, commands, patches). Prints a cursor at the end; pass it as `--since` to see only newer events. `--full` shows complete messages, command output and diffs. |
| `wait NAME [--timeout SEC] [--until turn-complete\|any-message\|approval]` | Blocks until the condition holds, then prints the final (or new) agent message and a summary. |
| `result NAME` | The final message of the last completed turn. |
| `approve NAME [--deny] [--id REQ] [--for-session] [--answer TEXT]` | Answers the oldest pending approval (or `--id`). `--deny` declines. `--answer` answers an agent question raised through `request_user_input`. |
| `auto NAME add REGEX [--files]` | Adds a command rule, or a file path rule with `--files`. |
| `auto NAME rm REGEX [--files]` | Removes the exact rule. |
| `auto NAME list` | Lists both sets of rules. |
| `interrupt NAME` | Stops the running turn and waits until it has really stopped. Idempotent. |
| `resume NAME` | Reloads the thread on the daemon after a restart (settings from the registry are re-applied). `send` does this automatically. |
| `list` | Registered agents. |
| `rm NAME [--force]` | Unregisters and archives the thread. A running agent needs `--force` (interrupts first). |
| `threads [--all] [--search T]` | The registered agents' threads as `thread/list` returns them, which is what `codex agents` shows. |
| `daemon [status\|start\|stop]` | Manage the daemon this tool uses. |

Every command accepts `--json`.
Errors are then `{"error": "..."}` on stdout, with the message also on stderr.

Command rules match the full command string sent by the daemon, including any shell wrapper.
File rules apply only when every changed path is known and one rule matches every path.
`wait` automatically accepts a matching request for that request only, prints a short line, records the decision in the registry, and keeps waiting.
An unmatched request still exits with code 3.
MCP elicitations, permission requests, and `request_user_input` are never auto-approved.
Use `codexctl status NAME` for recent automatic approvals and `codexctl log NAME` for the recorded list.
For example, `codexctl start --name builder --approval on-request --auto-approve 'blender.*--background' --auto-approve-files '^/tmp/build/' 'Build the model.'` stores both rules with the agent.

### `wait` exit codes

| code | meaning |
| --- | --- |
| 0 | The turn finished (completed, or interrupted by someone). The final message is printed. |
| 1 | Error: unknown agent, failed turn, daemon unreachable, lost turn. |
| 2 | Timeout. The agent is still running; a short status is printed. |
| 3 | The agent is blocked on an approval, or it finished by asking questions. The request(s) and the exact `approve` command are printed. |

`--until any-message` also returns as soon as a new agent message appears (commentary or final) while the turn keeps running.
Every mode returns with exit 3 as soon as the agent is blocked on an approval or a question, because the turn cannot progress until someone answers.
`--until approval` therefore behaves like `turn-complete`; it exists for scripts that state their intent (wait for the agent to need me, or to finish).

## How it works

```
Claude agent --- codexctl (short-lived process, no state of its own beyond a registry)
                     |
                     |  JSON-RPC over WebSocket on ~/.codex/app-server-control/app-server-control.sock
                     v
             shared Codex app-server daemon  <--- codex agents (the human watches / joins the same threads)
```

**Shared daemon, stateless CLI.**
Threads live in the daemon and their history lives in Codex's rollout files.
Every `codexctl` call connects, asks the daemon for the truth (`thread/read`, `thread/turns/list`) and disconnects.
The only local state is `~/.codex-bridge/agents.json`: name, thread id, settings, auto-approval rules and recent decisions, and the id of the last turn we started or steered.
There is no per-agent host process to babysit, and any number of `codexctl` processes can run at once.

**Transport.**
The daemon speaks WebSocket over its unix control socket (`codex app-server proxy` is just a byte relay to it, meant for ssh).
`src/ws.mjs` is a small RFC 6455 client, `src/rpc.mjs` the JSON-RPC layer on top.

**Starting the daemon.**
If nothing listens on the socket, `codexctl` tries `codex app-server daemon start`.
That command needs the standalone Codex install (`~/.codex/packages/standalone`), which an npm-installed Codex does not have.
In that case `codexctl` starts `codex app-server --listen unix://` itself, detached, logging to `~/.codex-bridge/daemon.log` (pid in `daemon.pid`), on the same default socket.
It is the same server, so `codex agents` sees the same threads.
Concurrent callers are serialized by a lock so only one daemon is started, and a stale socket file from a crashed daemon is replaced by Codex itself.
`codexctl daemon stop` stops the one it started.
Credentials of other tools (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are removed from the environment the daemon starts with.

**`wait` is level-triggered.**
It subscribes to the thread (`thread/resume`) only to be woken up quickly and to receive pending approval requests.
Every decision is made from a fresh read of the thread, with a poll every 3 seconds as a safety net.
So it does not matter whether `wait` was attached when the turn finished, or whether notifications were missed.
If the connection drops it reconnects (restarting the daemon if needed) and re-reads.
After `send`, `wait` targets the turn id recorded by `send`, so it never returns the previous turn's answer while the new turn is not listed yet.

**`send`** decides from the thread state under a per-agent lock.
Active thread: `turn/steer` with the current turn id as precondition.
Idle thread: `turn/start`.
Thread unloaded by the daemon (idle, nobody subscribed): `thread/resume` with the registered model, sandbox, writable roots and approval policy first, then `turn/start`.
Two concurrent `send` calls therefore become one new turn plus one steer.

**Approvals.**
A blocked turn stays blocked with no client attached.
When any connection calls `thread/resume` on the running thread, the daemon replays the pending request with its original id.
`wait` (exit 3), `status` and `approve` use that, so approving works from a fresh process, and works even if the caller was restarted in between.
`approve` answers command, file-change, permission, MCP-elicitation and `request_user_input` requests (see Limitations for which are verified).
`wait` checks command and file-change rules from the registry before returning a pending approval.

**Live view.**
The daemon's read APIs only return completed items, so an in-flight command is invisible to a stateless `status`.
A `wait` that is attached mirrors `item/started`, `item/completed` and plan updates into `~/.codex-bridge/live/NAME.json` (removed on exit, ignored when stale or when the owner pid is dead).
`status` shows it as "in flight".

**Log cursors.**
Events are the flattened sequence turn start, items, turn end.
The cursor is `<events seen>.<hash of the last seen event id>`, so it is cheap to pass around, and it re-anchors or restarts from the beginning (never silently skips) if history was rewritten.

### Protocol behaviour this relies on (verified against Codex 0.155.1)

- A turn keeps running when the client that started it disconnects.
- A pending approval is replayed, with the same request id, to a connection that resumes the thread.
- `turn/start` on a thread that already has an active turn behaves like a steer (same turn id). `codexctl` still uses `turn/steer` with `expectedTurnId`, which fails loudly on a race.
- A steer is picked up at the agent's next step boundary. A command that is already running finishes first.
- `turn/interrupt` on an idle thread never answers. `codexctl` only sends it to an active thread and gives it a timeout.
- Idle threads with no subscriber are unloaded (`notLoaded`); reads still work from disk.
- After a daemon restart the orphaned turn is reported as `interrupted` with no completion time. `codexctl` labels it "lost: the daemon restarted mid-turn".
- `thread/turns/list` only contains completed items; token usage is only streamed live, so `codexctl` reads the last `token_count` from the tail of the thread's rollout file (best effort).

## On disk

| path | content |
| --- | --- |
| `~/.codex-bridge/agents.json` | name to thread id plus settings, auto-approval rules, recent auto-approvals and last turn id. Written atomically under a lock. |
| `~/.codex-bridge/daemon.log`, `daemon.pid` | only when `codexctl` started the daemon. |
| `~/.codex-bridge/live/NAME.json` | live view mirrored by an attached `wait`. |
| `~/.codex-bridge/locks/` | registry, per-agent and daemon-start locks (stale locks from dead processes are broken). |

Environment overrides (mostly for tests): `CODEXCTL_HOME`, `CODEXCTL_SOCKET`, `CODEXCTL_CODEX_BIN`, `CODEXCTL_DAEMON_START_TIMEOUT_MS`, `CODEXCTL_DEBUG=1` (stack traces).

## Tests

```sh
npm test          # offline: unit tests plus the real CLI against a scripted fake daemon (test/fake-daemon.mjs)
npm run lint      # node --check on every file
test/e2e-real.sh  # the end-to-end run below, against the real Codex (spends a few tokens)
```

The fake daemon implements just enough of the app-server protocol to test: waiting and exit codes, steer versus start, cursors, approvals and deny, questions, interrupt (including the interrupt-on-idle hang), daemon crash and restart with settings re-applied, concurrent `send` and `start`, registry races, prompt from file and stdin, and daemon autostart including stale sockets and a missing `codex` binary.

## Verified end to end against the real Codex

Run with `test/e2e-real.sh` on Codex 0.155.1, model gpt-6-sol at low effort, working directories under `/tmp/claude-501/codexbridge_test`.
This is the exact output (the `[exit N]` lines are printed by the script).

```
### 1. start an agent that creates a file, then waits for further instructions

$ codexctl start --name maker --model gpt-6-sol --effort low --cwd /tmp/claude-501/codexbridge_test/e2e/work "Create a file named notes.txt in the current directory containing the single line: alpha. Then reply with the word ready and stop. More instructions will follow in a later message."
started agent "maker"  thread 01a0ee3e-0c74-76d2-80f3-c628fc6b502d  turn 01a0ee3e
model gpt-6-sol/low  sandbox workspace-write  approval never  cwd /private/tmp/claude-501/codexbridge_test/e2e/work
next: codexctl wait maker   |   codexctl status maker   |   codexctl send maker "..."
[exit 0]


### 2. wait until the turn completes

$ codexctl wait maker --timeout 180
maker: turn completed in 7.9s - 1 command
--- final message
ready
---
tokens: 45,356 total (30,464 cached input, 82 output), context window 258,400
[exit 0]

$ cat notes.txt
alpha
[exit 0]


### 3. follow-up that depends on the earlier context

$ codexctl send maker "Append the line beta to the file you just created, then show me its full contents."
maker: started new turn 01a0ee3e
[exit 0]

$ codexctl wait maker --timeout 180
maker: turn completed in 9s - 1 command
--- final message
```text
alpha
beta
```
---
tokens: 90,987 total (75,520 cached input, 173 output), context window 258,400
[exit 0]

$ cat notes.txt
alpha
beta
[exit 0]


### 4. a slow multi-command task, steered mid-turn (wait runs in the background, like a Claude agent would run it)

$ codexctl start --name slow --model gpt-6-sol --effort low --cwd /tmp/claude-501/codexbridge_test/e2e/files "There are 20 files named file01.txt to file20.txt in the current directory. Read them strictly in order, ONE shell command per file, and each command must be exactly: sleep 3; cat fileNN.txt (for example: sleep 3; cat file01.txt). Never batch files together. After reading all of them, reply with a one-line summary of each file."
started agent "slow"  thread 01a0ee3e-519a-70c2-8890-91a41d2d350c  turn 01a0ee3e
model gpt-6-sol/low  sandbox workspace-write  approval never  cwd /private/tmp/claude-501/codexbridge_test/e2e/files
next: codexctl wait slow   |   codexctl status slow   |   codexctl send slow "..."
[exit 0]

$ codexctl wait slow --timeout 300 > wait.out 2>&1 &     # background, notified when it exits

$ sleep 35

$ codexctl status slow
slow  running  |  turn running 35.3s
thread 01a0ee3e-519a-70c2-8890-91a41d2d350c  gpt-6-sol/low  sandbox workspace-write  approval never  cwd /private/tmp/claude-501/codexbridge_test/e2e/files
tokens: 114,210 total (98,304 cached input, 200 output), context window 258,400
this turn: 5 commands
recent:
  codex (note)> I’ll read the files in order with one exact command per file, then give a one-line summary of each.
  $ sleep 3; cat file01.txt  [exit 0, 2.9s]
  $ sleep 3; cat file02.txt  [exit 0, 2.9s]
  $ sleep 3; cat file03.txt  [exit 0, 2.9s]
  $ sleep 3; cat file04.txt  [exit 0, 2.9s]
  $ sleep 3; cat file05.txt  [exit 0, 2.9s]
[exit 0]

$ codexctl log slow
# slow  state=running
-- turn 1 started 10:37:37
you> There are 20 files named file01.txt to file20.txt in the current directory. Read them strictly in order, ONE shell command per file, and each command must be exactly: sleep 3; cat fileNN.txt (for example: sleep 3; cat file01.txt). Never batch files together. After reading all of them, reply with a one-line summary of each file.
codex (note)> I’ll read the files in order with one exact command per file, then give a one-line summary of each.
$ sleep 3; cat file01.txt  [exit 0, 2.9s]
$ sleep 3; cat file02.txt  [exit 0, 2.9s]
$ sleep 3; cat file03.txt  [exit 0, 2.9s]
$ sleep 3; cat file04.txt  [exit 0, 2.9s]
$ sleep 3; cat file05.txt  [exit 0, 2.9s]
cursor: 8.e011f5   next: codexctl log slow --since 8.e011f5
[exit 0]

$ codexctl send slow "Change of plan: STOP reading files now and do not run any more commands. Reply with only: STEERED: read N files, where N is how many files you have read so far."
slow: message steered into the running turn 01a0ee3e
[exit 0]

$ cat wait.out      # what the background wait printed when the turn finished
slow: turn completed in 41.1s - 6 commands
--- final message
STEERED: read 6 files
---
tokens: 160,434 total (144,000 cached input, 246 output), context window 258,400
[exit 0]


### 5. status and incremental log

$ codexctl log slow --since 8.e011f5
# slow  state=idle
$ sleep 3; cat file06.txt  [exit 0, 2.9s]
you> Change of plan: STOP reading files now and do not run any more commands. Reply with only: STEERED: read N files, where N is how many files you have read so far.
codex> STEERED: read 6 files
-- turn 1 completed in 41.1s
cursor: 12.3f64a7   next: codexctl log slow --since 12.3f64a7
[exit 0]

$ codexctl status
NAME   STATE  TURN  MODEL          UPDATED    LAST
maker  idle   -     gpt-6-sol/low  42.5s ago  codex> ```text alpha beta ```
slow   idle   -     gpt-6-sol/low  0.5s ago   codex> STEERED: read 6 files
[exit 0]


### 6. inspect and interrupt a running turn

$ codexctl send slow "Run exactly this shell command: sleep 120. Then reply finished."
slow: started new turn 01a0ee3e
[exit 0]

$ codexctl wait slow --timeout 300 > wait2.out 2>&1 &

$ sleep 15

$ codexctl status slow
slow  running  |  turn running 15.7s
thread 01a0ee3e-519a-70c2-8890-91a41d2d350c  gpt-6-sol/low  sandbox workspace-write  approval never  cwd /private/tmp/claude-501/codexbridge_test/e2e/files
tokens: 183,669 total (166,912 cached input, 301 output), context window 258,400
this turn: 0 commands
recent:
  $ sleep 3; cat file05.txt  [exit 0, 2.9s]
  $ sleep 3; cat file06.txt  [exit 0, 2.9s]
  you> Change of plan: STOP reading files now and do not run any more commands. Reply with only: STEERED: read N files, where N is how many files you have read so far.
  codex> STEERED: read 6 files
  you> Run exactly this shell command: sleep 120. Then reply finished.
  codex (note)> I’ll run `sleep 120` and reply when it finishes.
in flight:
  $ sleep 120  (running 12.3s)
[exit 0]

$ codexctl interrupt slow
slow: interrupted turn 01a0ee3e - turn is now interrupted
[exit 0]

$ cat wait2.out
slow: turn interrupted in 15.1s - 0 commands
--- last message (the turn did not finish)
I’ll run `sleep 120` and reply when it finishes.
---
tokens: 206,999 total (189,952 cached input, 339 output), context window 258,400
[exit 0]

$ codexctl status slow
slow  idle  |  last turn interrupted 0.8s ago (took 15.1s)
thread 01a0ee3e-519a-70c2-8890-91a41d2d350c  gpt-6-sol/low  sandbox workspace-write  approval never  cwd /private/tmp/claude-501/codexbridge_test/e2e/files
tokens: 206,999 total (189,952 cached input, 339 output), context window 258,400
this turn: 0 commands
recent:
  $ sleep 3; cat file05.txt  [exit 0, 2.9s]
  $ sleep 3; cat file06.txt  [exit 0, 2.9s]
  you> Change of plan: STOP reading files now and do not run any more commands. Reply with only: STEERED: read N files, where N is how many files you have read so far.
  codex> STEERED: read 6 files
  you> Run exactly this shell command: sleep 120. Then reply finished.
  codex (note)> I’ll run `sleep 120` and reply when it finishes.
[exit 0]


### 7. the threads are visible on the shared daemon (what codex agents lists)

$ codexctl threads
THREAD                                NAME   STATUS  REGISTERED AS  CWD
01a0ee3e-519a-70c2-8890-91a41d2d350c  slow   idle    slow           ...tmp/claude-501/codexbridge_test/e2e/files
01a0ee3e-0c74-76d2-80f3-c628fc6b502d  maker  idle    maker          .../tmp/claude-501/codexbridge_test/e2e/work
[exit 0]

$ codexctl daemon status
daemon running  socket /Users/mingj/.codex/app-server-control/app-server-control.sock  loaded threads: 2  pid 26175 (started by codexctl)
[exit 0]


### 8. approvals: a read-only agent asks to write, the caller approves

$ codexctl start --name gate --model gpt-6-sol --effort low --cwd /tmp/claude-501/codexbridge_test/e2e/work --sandbox read-only --approval on-request "Use a shell command to create a file named gate.txt containing ok. If the sandbox blocks it, ask for permission to run it outside the sandbox. Then report the result."
started agent "gate"  thread 01a0ee3f-38d5-7dc3-8647-6494c7983b37  turn 01a0ee3f
model gpt-6-sol/low  sandbox read-only  approval on-request  cwd /private/tmp/claude-501/codexbridge_test/e2e/work
next: codexctl wait gate   |   codexctl status gate   |   codexctl send gate "..."
[exit 0]

$ codexctl wait gate --timeout 180
gate: blocked, waiting for approval after 8.2s
request 4 (command): $ printf 'ok' > gate.txt
  cwd: /private/tmp/claude-501/codexbridge_test/e2e/work
  reason: May I run the shell command outside the read-only sandbox to create gate.txt containing ok?
approve: codexctl approve gate    deny: codexctl approve gate --deny
[exit 3]

$ codexctl approve gate
gate: approved request 4 (command)
  request 4 (command): $ printf 'ok' > gate.txt
    cwd: /private/tmp/claude-501/codexbridge_test/e2e/work
    reason: May I run the shell command outside the read-only sandbox to create gate.txt containing ok?
[exit 0]

$ codexctl wait gate --timeout 180
gate: turn completed in 12.8s - 2 commands
--- final message
Created [gate.txt](/private/tmp/claude-501/codexbridge_test/e2e/work/gate.txt) outside the sandbox after permission was granted. I verified it contains `ok`.
---
tokens: 98,386 total (85,504 cached input, 252 output), context window 258,400
[exit 0]

$ cat gate.txt
ok[exit 0]


### cleanup

$ codexctl rm maker
maker: unregistered, thread archived
[exit 0]

$ codexctl rm slow
slow: unregistered, thread archived
[exit 0]

$ codexctl rm gate
gate: unregistered, thread archived
[exit 0]
```

What this shows:

1. `start` returns at once with the thread id; the agent creates `notes.txt`.
2. `wait` blocks until the turn is done and prints the final message.
3. The follow-up "the file you just created" works, so context is kept across turns (and across daemon restarts, see below).
4. A steer sent while the slow task was running changed its behaviour (it stopped after the command that was already running and answered `STEERED: read N files`), while a background `wait` was notified when the turn finished.
5. `status` shows elapsed time, tokens and the last commands with exit codes; `log --since` shows only what happened after the cursor.
6. `interrupt` stops a running turn (also verified while the turn was blocked on an approval); `status` shows the in-flight command while a `wait` is attached.
7. `codexctl threads` lists the threads as the daemon's `thread/list` returns them. Separately, `codex agents` (the TUI) was run in a pty during development and listed the agents by name.
8. An approval round trip: `wait` exits 3 with the request, `approve` answers it from a fresh process, `wait` then completes.

Also verified manually: killing the daemon with `kill -9` (stale socket), stopping it while a `wait` was running (the `wait` reconnects and reports the lost turn), `resume` and `send` after a restart (the agent still remembers the earlier conversation), writable roots (a write inside the extra root succeeded, one outside it was denied by the sandbox).

## Limitations

- **Token usage** is read from the rollout file, not from the API, so it is best effort and only shows the thread total.
- **`log`** re-reads the whole thread on every call (the output is incremental, the transfer is not). Fine for normal threads, wasteful for very long ones.
- **In-flight commands and plans** are only visible while some `wait` is attached to the agent.
- **A steer lands at the next step boundary.** If the agent is inside one long command it will not see the message until that command ends. `interrupt` then `send` if it is urgent.
- **A daemon restart kills running turns.** That is Codex behaviour. The thread survives; `send` (or `resume`) reloads it and a new turn continues the conversation.
- **Daemon environment** is fixed when the daemon starts. Agents' shell commands inherit that environment, not the caller's.
- **Approval kinds.** Command and file-change (`apply_patch`) approvals are verified against the real server. Permission requests, MCP elicitations and `request_user_input` answers are implemented from the protocol schema but were not exercised against a real server (I could not get Codex to raise one).
- **Sandbox modes** are `read-only` and `workspace-write` only. `danger-full-access` is deliberately not offered. `--network` enables network in either mode.
- **Denying** an approval declines that one action; the agent carries on and may try something else. Use `interrupt` to stop it.
- **`wait --until any-message`** only counts messages that appear after the `wait` started; if the agent is already idle it returns the last final message immediately.
- The app-server protocol is marked experimental in Codex 0.155.1 and may change.
- Unix sockets only (macOS and Linux).
