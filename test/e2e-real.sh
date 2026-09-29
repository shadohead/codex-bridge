#!/usr/bin/env bash
# End-to-end run against the REAL Codex daemon (gpt-6-sol, low effort). Not part of `npm test`: it needs a
# logged-in Codex and spends a few tokens. Prints the transcript that the README embeds.
#   usage: test/e2e-real.sh [scratch-dir]      (default /tmp/claude-501/codexbridge_test/e2e)
set -u
ROOT="${1:-/tmp/claude-501/codexbridge_test/e2e}"
export PATH="$(cd "$(dirname "$0")/../bin" && pwd):$PATH"

# run 'command': print the command as typed, run it, print its exit status
run() { printf '$ %s\n' "$1"; eval "$1"; printf '[exit %s]\n\n' "$?"; }
step() { printf '\n### %s\n\n' "$1"; }

for n in maker slow gate; do codexctl rm "$n" --force >/dev/null 2>&1; done
rm -rf "$ROOT" && mkdir -p "$ROOT/work" "$ROOT/files"
cd "$ROOT/work" || exit 1

step "1. start an agent that creates a file, then waits for further instructions"
run 'codexctl start --name maker --model gpt-6-sol --effort low --cwd '"$ROOT/work"' "Create a file named notes.txt in the current directory containing the single line: alpha. Then reply with the word ready and stop. More instructions will follow in a later message."'

step "2. wait until the turn completes"
run 'codexctl wait maker --timeout 180'
run 'cat notes.txt'

step "3. follow-up that depends on the earlier context"
run 'codexctl send maker "Append the line beta to the file you just created, then show me its full contents."'
run 'codexctl wait maker --timeout 180'
run 'cat notes.txt'

step "4. a slow multi-command task, steered mid-turn (wait runs in the background, like a Claude agent would run it)"
for i in $(seq -w 1 20); do printf 'File %s: the number is %s.\nSecond line of file %s.\n' "$i" "$i" "$i" > "$ROOT/files/file$i.txt"; done
run 'codexctl start --name slow --model gpt-6-sol --effort low --cwd '"$ROOT/files"' "There are 20 files named file01.txt to file20.txt in the current directory. Read them strictly in order, ONE shell command per file, and each command must be exactly: sleep 3; cat fileNN.txt (for example: sleep 3; cat file01.txt). Never batch files together. After reading all of them, reply with a one-line summary of each file."'
printf '$ codexctl wait slow --timeout 300 > wait.out 2>&1 &     # background, notified when it exits\n\n'
( codexctl wait slow --timeout 300 > "$ROOT/wait.out" 2>&1; echo "[exit $?]" >> "$ROOT/wait.out" ) &
BGWAIT=$!
printf '$ sleep 35\n\n'; sleep 35
run 'codexctl status slow'
CUR=$(codexctl log slow | sed -n 's/^cursor: \([^ ]*\).*/\1/p')
run 'codexctl log slow'
run 'codexctl send slow "Change of plan: STOP reading files now and do not run any more commands. Reply with only: STEERED: read N files, where N is how many files you have read so far."'
wait "$BGWAIT"
printf '$ cat wait.out      # what the background wait printed when the turn finished\n'; cat "$ROOT/wait.out"; printf '\n'

step "5. status and incremental log"
run "codexctl log slow --since $CUR"
run 'codexctl status'

step "6. inspect and interrupt a running turn"
run 'codexctl send slow "Run exactly this shell command: sleep 120. Then reply finished."'
printf '$ codexctl wait slow --timeout 300 > wait2.out 2>&1 &\n\n'
( codexctl wait slow --timeout 300 > "$ROOT/wait2.out" 2>&1; echo "[exit $?]" >> "$ROOT/wait2.out" ) &
BGWAIT2=$!
printf '$ sleep 15\n\n'; sleep 15
run 'codexctl status slow'
run 'codexctl interrupt slow'
wait "$BGWAIT2"
printf '$ cat wait2.out\n'; cat "$ROOT/wait2.out"; printf '\n'
run 'codexctl status slow'

step "7. the threads are visible on the shared daemon (what codex agents lists)"
run 'codexctl threads'
run 'codexctl daemon status'

step "8. approvals: a read-only agent asks to write, the caller approves"
run 'codexctl start --name gate --model gpt-6-sol --effort low --cwd '"$ROOT/work"' --sandbox read-only --approval on-request "Use a shell command to create a file named gate.txt containing ok. If the sandbox blocks it, ask for permission to run it outside the sandbox. Then report the result."'
run 'codexctl wait gate --timeout 180'
run 'codexctl approve gate'
run 'codexctl wait gate --timeout 180'
run 'cat gate.txt'

step "cleanup"
run 'codexctl rm maker'
run 'codexctl rm slow'
run 'codexctl rm gate'
