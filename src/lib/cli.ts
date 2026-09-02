/**
 * Declarative command-line parsing for `/command` handlers.
 *
 * The shell-like tokenizer from `cli-args.ts` splits the raw argument string;
 * this module parses the tokens into positional args plus typed flags. Flags
 * are declared as a typebox object schema: each property is a flag and the
 * property key is the long name (`--key`). The property schema decides the
 * flag kind:
 *
 *   Type.Boolean()                    boolean flag (`--flag`)
 *   Type.String()                     string value flag (`--flag value`)
 *   Type.Number() / Type.Integer()    number value flag (value is coerced)
 *   Type.Union([Type.Literal(...)])   string enum value flag (validated)
 *
 * Supported syntax (common unix CLI conventions):
 *
 *   -s            short boolean flag
 *   -s value      short flag with value (also `-s=value` and `-svalue`)
 *   -abc          combined short boolean flags
 *   --long        long boolean flag
 *   --long=value  long flag with inline value
 *   --long value  long flag consuming the next token
 *   --            everything after is a positional
 *
 * `Type.Optional(...)` marks a flag optional (no error when absent) and a
 * `default` fills in a missing value; both flow through typebox's value
 * pipeline (default → convert → check) so the `ok` result carries
 * `Static<TFlags>` flags plus `string[]` args.
 *
 * `-h`/`--help` is registered automatically unless the schema declares a
 * `help` property or a short `h` alias; it renders a usage/options text as
 * the result so handlers can display it in chat instead of writing stdout.
 */

import type { Static, TObject } from "typebox";
import { Value } from "typebox/value";

import { shlexSplit } from "./cli-args.js";

/** Per-flag CLI metadata on top of the typebox schema. */
export interface FlagMeta {
  /** Optional short alias (single character), e.g. "n" for `-n`. */
  short?: string;
  /** Help line for this flag; defaults to the schema `description`. */
  description?: string;
  /** Placeholder shown for value flags in help, e.g. "<alias>"; defaults to `<key>`. */
  valuePlaceholder?: string;
}

export interface CommandSpec<TFlags extends TObject> {
  /** Command name used in usage/help, e.g. "talk-group-join". */
  name: string;
  /** Usage text after the command name, e.g. "[group name] [options]". */
  usage: string;
  /** One-line description shown under the usage line. */
  description?: string;
  /** Typebox object schema describing the flags (key = long flag name). */
  flags: TFlags;
  /** Per-flag CLI metadata (short alias, help text). */
  flagMeta?: { [K in keyof Static<TFlags>]?: FlagMeta };
  /** Positional count constraints. */
  arity?: { min?: number; max?: number };
  /** Example lines rendered under the help text. */
  examples?: string[];
}

export type CommandResult<TFlags extends TObject> =
  | { kind: "ok"; flags: Static<TFlags>; args: string[] }
  | { kind: "help"; text: string }
  | { kind: "error"; text: string };

/** Runtime view of a flag schema (typebox's `TSchema` is empty at the type level). */
interface FlagSchema {
  "~kind"?: string;
  "~optional"?: boolean;
  type?: string;
  default?: unknown;
  description?: string;
  anyOf?: { type?: string; const?: unknown }[];
}

type FlagKind = "boolean" | "string" | "number" | "enum";

interface FlagInfo {
  key: string;
  kind: FlagKind;
  short?: string;
  required: boolean;
  placeholder: string;
  description: string;
  schema: FlagSchema;
}

function kindOf(key: string, schema: FlagSchema): FlagKind {
  switch (schema["~kind"]) {
    case "Boolean": {
      return "boolean";
    }
    case "String": {
      return "string";
    }
    case "Number":
    case "Integer": {
      return "number";
    }
    case "Union": {
      return "enum";
    }
    default: {
      throw new TypeError(
        `Unsupported flag type for '${key}': ${schema["~kind"] ?? schema.type ?? "unknown"} ` +
          "(use Type.Boolean/String/Number/Integer or a string literal union)",
      );
    }
  }
}

/** Allowed values for a string-literal union flag, or undefined for mixed unions. */
function enumValues(schema: FlagSchema): string[] | undefined {
  const anyOf = schema.anyOf;
  if (!anyOf) return undefined;
  const values = anyOf.map((s) => s.const).filter((c) => typeof c === "string");
  return values.length === anyOf.length ? values : undefined;
}

function buildFlagInfos<TFlags extends TObject>(spec: CommandSpec<TFlags>): FlagInfo[] {
  const meta = spec.flagMeta as Record<string, FlagMeta> | undefined;
  const infos: FlagInfo[] = [];
  for (const [key, rawSchema] of Object.entries(spec.flags.properties)) {
    const schema = rawSchema as unknown as FlagSchema;
    const m = meta?.[key];
    infos.push({
      key,
      kind: kindOf(key, schema),
      short: m?.short,
      required: schema["~optional"] !== true && schema.default === undefined,
      placeholder: m?.valuePlaceholder ?? `<${key}>`,
      description: m?.description ?? schema.description ?? "",
      schema,
    });
  }
  return infos;
}

/** Is this token a flag-like argument (a negative number is a value)? */
function looksLikeFlag(token: string): boolean {
  return token.startsWith("-") && !/^-\d/.test(token);
}

function errorResult<TFlags extends TObject>(
  spec: CommandSpec<TFlags>,
  message: string,
): CommandResult<TFlags> {
  return { kind: "error", text: `${message}\nTry '/${spec.name} --help' for usage.` };
}

function helpResult<TFlags extends TObject>(
  spec: CommandSpec<TFlags>,
  flags: FlagInfo[],
  autoHelp: boolean,
): CommandResult<TFlags> {
  const lines = [`Usage: /${spec.name} ${spec.usage}`];
  if (spec.description) lines.push("", spec.description);
  const rows = flags.map((f) => ({
    rawName:
      (f.short ? `-${f.short}, ` : "") +
      `--${f.key}` +
      (f.kind === "boolean" ? "" : ` ${f.placeholder}`),
    description: f.description,
  }));
  if (autoHelp) rows.push({ rawName: "-h, --help", description: "Display this message" });
  if (rows.length > 0) {
    lines.push("", "Options:");
    const width = Math.max(...rows.map((r) => r.rawName.length));
    for (const r of rows) lines.push(`  ${r.rawName.padEnd(width)}  ${r.description}`);
  }
  if (spec.examples?.length) {
    lines.push("", "Examples:");
    for (const e of spec.examples) lines.push(`  ${e}`);
  }
  return { kind: "help", text: lines.join("\n") };
}

export function parseCommand<TFlags extends TObject>(
  spec: CommandSpec<TFlags>,
  raw: string,
): CommandResult<TFlags> {
  const flags = buildFlagInfos(spec);
  const byLong = new Map(flags.map((f) => [f.key, f]));
  const byShort = new Map<string, FlagInfo>();
  for (const f of flags) {
    if (!f.short) {
      continue;
    }

    if (byShort.has(f.short)) {
      throw new TypeError(`Duplicate short option '-${f.short}' in /${spec.name}`);
    }
    byShort.set(f.short, f);
  }
  const autoHelp = !byLong.has("help") && !byShort.has("h");

  let tokens: string[];
  try {
    tokens = shlexSplit(raw);
  } catch (error) {
    return errorResult(spec, error instanceof Error ? error.message : String(error));
  }

  const rawFlags: Record<string, unknown> = {};
  const args: string[] = [];
  let positionalOnly = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (positionalOnly) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token === "-") {
      args.push(token);
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (autoHelp && name === "help") return helpResult(spec, flags, autoHelp);
      const info = byLong.get(name);
      if (!info) return errorResult(spec, `Unknown option '--${name}'`);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);
      if (inline !== undefined) {
        rawFlags[info.key] = inline;
      } else if (info.kind === "boolean") {
        rawFlags[info.key] = true;
      } else {
        const next = tokens.at(i + 1);
        if (next !== undefined && !looksLikeFlag(next)) {
          rawFlags[info.key] = next;
          i++;
        } else if (autoHelp && next !== undefined && (next === "--help" || next === "-h")) {
          return helpResult(spec, flags, autoHelp);
        } else {
          return errorResult(spec, `Option '--${name}' requires a value`);
        }
      }
      continue;
    }
    if (token.startsWith("-")) {
      const rest = token.slice(1);
      for (let j = 0; j < rest.length; j++) {
        const c = rest[j];
        if (autoHelp && c === "h") return helpResult(spec, flags, autoHelp);
        const info = byShort.get(c);
        if (!info) return errorResult(spec, `Unknown option '-${c}'`);
        if (info.kind === "boolean") {
          rawFlags[info.key] = true;
          continue;
        }
        if (rest[j + 1] === "=") {
          rawFlags[info.key] = rest.slice(j + 2);
        } else if (j + 1 < rest.length) {
          rawFlags[info.key] = rest.slice(j + 1);
        } else {
          const next = tokens.at(i + 1);
          if (next !== undefined && !looksLikeFlag(next)) {
            rawFlags[info.key] = next;
            i++;
          } else if (autoHelp && next !== undefined && (next === "--help" || next === "-h")) {
            return helpResult(spec, flags, autoHelp);
          } else {
            return errorResult(spec, `Option '-${c}' requires a value`);
          }
        }
        break;
      }
      continue;
    }
    args.push(token);
  }

  for (const f of flags) {
    if (f.required && !(f.key in rawFlags)) {
      return errorResult(spec, `Missing required option '--${f.key}'`);
    }
  }

  for (const f of flags) {
    if (f.kind === "enum" && typeof rawFlags[f.key] === "string") {
      const values = enumValues(f.schema);
      if (values && !values.includes(rawFlags[f.key] as string)) {
        return errorResult(
          spec,
          `Invalid value for '--${f.key}': '${String(rawFlags[f.key])}' (expected one of: ${values.join(", ")})`,
        );
      }
    }
    if (f.kind === "number" && typeof rawFlags[f.key] === "string") {
      const n = Number(rawFlags[f.key]);
      if (Number.isNaN(n)) {
        return errorResult(spec, `Invalid value for '--${f.key}': '${String(rawFlags[f.key])}'`);
      }
      rawFlags[f.key] = n;
    }
  }

  const { min, max } = spec.arity ?? {};
  if (max !== undefined && args.length > max) {
    const extra = args
      .slice(max)
      .map((a) => `'${a}'`)
      .join(", ");
    return errorResult(spec, `Too many arguments: ${extra} (expected at most ${max})`);
  }
  if (min !== undefined && args.length < min) {
    return errorResult(spec, `Missing required argument: expected ${spec.usage}`);
  }

  // typebox value pipeline: defaults → coercion → check.
  let parsed: unknown;
  try {
    parsed = Value.Default(spec.flags, rawFlags);
    parsed = Value.Convert(spec.flags, Value.Clone(parsed));
    if (!Value.Check(spec.flags, parsed)) {
      const [first] = [...Value.Errors(spec.flags, parsed)];
      return errorResult(spec, `Invalid arguments: ${first.message}`);
    }
  } catch {
    return errorResult(spec, "Invalid arguments");
  }

  return { kind: "ok", flags: parsed, args };
}
