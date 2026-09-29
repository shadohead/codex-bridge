// Tiny argument parser: --flag value, --flag=value, boolean flags, repeatable list flags, `--` terminator.
import { UsageError } from "./ops.mjs";

/**
 * spec: { flagName: { type: "string"|"bool"|"list"|"number", alias?: "x" } }
 * Returns { flags, positionals }.
 */
export function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  const aliases = {};
  for (const [k, v] of Object.entries(spec)) if (v.alias) aliases[v.alias] = k;
  for (const [k, v] of Object.entries(spec)) if (v.type === "list") flags[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name = null;
    let inline = null;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : null;
    } else if (/^-[A-Za-z]$/.test(a)) {
      name = aliases[a.slice(1)] ?? null;
      if (!name) throw new UsageError(`unknown option: ${a}`);
    } else {
      positionals.push(a);
      continue;
    }
    const def = spec[name];
    if (!def) throw new UsageError(`unknown option: --${name} (use \`--\` before a message that starts with dashes)`);
    if (def.type === "bool") {
      flags[name] = inline == null ? true : !/^(0|false|no)$/i.test(inline);
      continue;
    }
    let val = inline;
    if (val == null) {
      if (i + 1 >= argv.length) throw new UsageError(`option --${name} needs a value`);
      val = argv[++i];
    }
    if (def.type === "number") {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`option --${name} needs a non-negative number, got "${val}"`);
      flags[name] = n;
    } else if (def.type === "list") flags[name].push(val);
    else flags[name] = val;
  }
  return { flags, positionals };
}
