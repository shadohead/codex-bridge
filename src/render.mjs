// Text rendering for agents (and humans). Concise by default.
import { isLostTurn } from "./state.mjs";

export function oneLine(s, max = 160) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

export function clip(s, max) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max)}\n... [${t.length - max} more chars]` : t;
}

export function fmtDur(ms) {
  if (ms == null || Number.isNaN(ms)) return "?";
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtClock(sec) {
  if (!sec) return "?";
  const d = new Date(sec * 1000);
  return d.toTimeString().slice(0, 8);
}

export function fmtAgo(sec, now = Date.now()) {
  if (!sec) return "?";
  return `${fmtDur(now - sec * 1000)} ago`;
}

export function fmtNum(n) {
  return n == null ? "?" : Number(n).toLocaleString("en-US");
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : "?";
}

export function shortPath(p, max = 40) {
  if (!p) return "";
  const home = process.env.HOME;
  let s = home && p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
  if (s.length > max) s = `...${s.slice(s.length - max + 3)}`;
  return s;
}

/** `/bin/zsh -lc 'ls -la'` -> `ls -la` */
export function stripShell(cmd) {
  const m = /^(?:\/\S+\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(String(cmd ?? "").trim());
  if (!m) return String(cmd ?? "");
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, "$1");
}

export function userText(item) {
  return (item.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join(" ");
}

function changeLabel(c) {
  const k = c.kind?.type;
  const verb = k === "add" ? "add" : k === "delete" ? "delete" : c.kind?.move_path ? `move->${c.kind.move_path}` : "edit";
  return `${verb} ${c.path}`;
}

/** One-line description of a thread item, or null when it is not worth showing. */
export function itemLine(item, { full = false, maxMsg = 400 } = {}) {
  switch (item.type) {
    case "userMessage":
      return `you> ${full ? userText(item) : oneLine(userText(item), maxMsg)}`;
    case "agentMessage": {
      if (!(item.text ?? "").trim()) return null;
      const tag = item.phase === "commentary" ? "codex (note)" : "codex";
      return `${tag}> ${full ? item.text : oneLine(item.text, maxMsg)}`;
    }
    case "commandExecution": {
      const cmd = oneLine(stripShell(item.command), full ? 2000 : 140);
      const ex = item.status === "declined" ? "declined" : item.exitCode == null ? item.status : `exit ${item.exitCode}`;
      const dur = item.durationMs != null ? `, ${fmtDur(item.durationMs)}` : "";
      return `$ ${cmd}  [${ex}${dur}]`;
    }
    case "fileChange": {
      const list = (item.changes ?? []).map(changeLabel);
      const shown = full ? list : list.slice(0, 4);
      const more = list.length > shown.length ? ` (+${list.length - shown.length} more)` : "";
      return `files ${item.status}: ${shown.join(", ") || "(none)"}${more}`;
    }
    case "plan":
      return `plan> ${full ? item.text : oneLine(item.text, maxMsg)}`;
    case "mcpToolCall":
      return `mcp ${item.server}.${item.tool}  [${item.status}${item.durationMs != null ? `, ${fmtDur(item.durationMs)}` : ""}]`;
    case "dynamicToolCall":
      return `tool ${item.namespace ? item.namespace + "." : ""}${item.tool}  [${item.status}]`;
    case "webSearch":
      return `web search${item.query ? `: ${oneLine(item.query, 100)}` : ""}`;
    case "reasoning": {
      const t = (item.summary ?? []).join(" ").trim();
      return t ? `thinking> ${full ? t : oneLine(t, 200)}` : null;
    }
    case "contextCompaction":
      return "context compacted";
    case "enteredReviewMode":
    case "exitedReviewMode":
      return `${item.type === "enteredReviewMode" ? "review started" : "review finished"}: ${oneLine(item.review, 120)}`;
    case "imageView":
      return `viewed image ${item.path}`;
    default:
      return item.type ? `(${item.type})` : null;
  }
}

/** Extra detail lines for --full log output (command output, diffs). */
export function itemDetail(item, { maxOut = 2000 } = {}) {
  if (item.type === "commandExecution" && item.aggregatedOutput) {
    const out = item.aggregatedOutput.trimEnd();
    if (!out) return [];
    return clip(out, maxOut).split("\n").map((l) => `    | ${l}`);
  }
  if (item.type === "fileChange") {
    const lines = [];
    for (const c of item.changes ?? []) {
      if (c.diff) for (const l of clip(c.diff, 1500).split("\n")) lines.push(`    ${l}`);
    }
    return lines;
  }
  return [];
}

/** "completed", "interrupted", or "interrupted (lost: the daemon restarted mid-turn)". */
export function turnStatusLabel(turn) {
  if (!turn) return "?";
  return isLostTurn(turn) ? "interrupted (lost: the daemon restarted mid-turn)" : turn.status;
}

export function renderEvent(ev, opts = {}) {
  if (ev.kind === "turn-start") {
    return [`-- turn ${ev.n} started ${fmtClock(ev.turn.startedAt)}`];
  }
  if (ev.kind === "turn-end") {
    const t = ev.turn;
    const dur = t.durationMs != null ? ` in ${fmtDur(t.durationMs)}` : "";
    const err = t.error?.message ? `: ${oneLine(t.error.message, 200)}` : "";
    return [`-- turn ${ev.n} ${turnStatusLabel(t)}${dur}${err}`];
  }
  const line = itemLine(ev.item, opts);
  if (line == null) return [];
  const out = line.split("\n");
  if (opts.full) out.push(...itemDetail(ev.item));
  return out;
}

export function stateLine(state) {
  return state;
}

/** Simple left-aligned table. rows: array of arrays of strings. */
export function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export function describePending(rec, inflight = []) {
  const p = rec.params ?? {};
  const head = `request ${rec.id} (${rec.kind})`;
  switch (rec.kind) {
    case "command": {
      const bits = [`${head}: $ ${oneLine(stripShell(p.command ?? (p.parsedCmd ?? []).join(" ")), 300)}`];
      if (p.cwd) bits.push(`  cwd: ${p.cwd}`);
      if (p.reason) bits.push(`  reason: ${oneLine(p.reason, 300)}`);
      return bits;
    }
    case "file-change": {
      const item = inflight.find((f) => f.id === rec.itemId);
      const files = item?.files?.length ? `: ${item.files.join(", ")}` : "";
      const bits = [`${head}: apply file changes${files}`];
      if (p.grantRoot) bits.push(`  wants write access to: ${p.grantRoot}`);
      if (p.reason) bits.push(`  reason: ${oneLine(p.reason, 300)}`);
      return bits;
    }
    case "permissions": {
      const bits = [`${head}: extra permissions requested`];
      if (p.permissions) bits.push(`  permissions: ${oneLine(JSON.stringify(p.permissions), 300)}`);
      if (p.reason) bits.push(`  reason: ${oneLine(p.reason, 300)}`);
      return bits;
    }
    case "question": {
      const bits = [`${head}: the agent asks:`];
      for (const q of p.questions ?? []) {
        bits.push(`  [${q.id}] ${oneLine(q.question, 400)}`);
        for (const o of q.options ?? []) bits.push(`      - ${o.label}: ${oneLine(o.description, 120)}`);
      }
      return bits;
    }
    case "mcp-elicitation":
      return [`${head}: MCP server "${p.serverName}" asks: ${oneLine(p.message, 300)}`];
    default:
      return [head];
  }
}
