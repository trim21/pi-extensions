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

import { IsKind, type Static, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { shlexSplit } from "./cli-args.js";
import { isRecord, isUnknownArray } from "./narrow.js";

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

type FlagKind = "boolean" | "string" | "number" | "enum";

interface FlagInfo {
  key: string;
  kind: FlagKind;
  short?: string;
  required: boolean;
  placeholder: string;
  description: string;
  schema: TSchema;
}

/** schema 的种类名，仅用于报错文案。 */
function schemaKindLabel(schema: TSchema): string {
  if ("~kind" in schema && typeof schema["~kind"] === "string") return schema["~kind"];
  if ("type" in schema && typeof schema.type === "string") return schema.type;
  return "unknown";
}

function kindOf(key: string, schema: TSchema): FlagKind {
  if (IsKind(schema, "Boolean")) return "boolean";
  if (IsKind(schema, "String")) return "string";
  if (IsKind(schema, "Number") || IsKind(schema, "Integer")) return "number";
  if (IsKind(schema, "Union")) return "enum";
  throw new TypeError(
    `Unsupported flag type for '${key}': ${schemaKindLabel(schema)} ` +
      "(use Type.Boolean/String/Number/Integer or a string literal union)",
  );
}

/** Type.Optional 的 `~optional` 标记：缺省即「不带该 flag 时不报错」。 */
function isOptionalFlag(schema: TSchema): boolean {
  return "~optional" in schema && schema["~optional"] === true;
}

/** schema 声明的 default：有 default 的 flag 缺省时由 typebox 补值，不算 required。 */
function flagDefault(schema: TSchema): unknown {
  return "default" in schema ? schema.default : undefined;
}

function flagDescription(schema: TSchema): string {
  return "description" in schema && typeof schema.description === "string"
    ? schema.description
    : "";
}

/** Allowed values for a string-literal union flag, or undefined for mixed unions. */
function enumValues(schema: TSchema): string[] | undefined {
  if (!("anyOf" in schema) || !isUnknownArray(schema.anyOf)) return undefined;
  const values: string[] = [];
  for (const variant of schema.anyOf) {
    if (!isRecord(variant) || typeof variant.const !== "string") return undefined;
    values.push(variant.const);
  }
  return values;
}

function buildFlagInfos<TFlags extends TObject>(spec: CommandSpec<TFlags>): FlagInfo[] {
  // flagMeta 的键随 flags 泛型变化（映射类型），运行时按字符串键索引需在此收敛一次。
  const meta = spec.flagMeta as Record<string, FlagMeta> | undefined;
  const infos: FlagInfo[] = [];
  for (const [key, schema] of Object.entries(spec.flags.properties)) {
    const m = meta?.[key];
    infos.push({
      key,
      kind: kindOf(key, schema),
      short: m?.short,
      required: !isOptionalFlag(schema) && flagDefault(schema) === undefined,
      placeholder: m?.valuePlaceholder ?? `<${key}>`,
      description: m?.description ?? flagDescription(schema),
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
    const raw = rawFlags[f.key];
    if (typeof raw === "string" && f.kind === "enum") {
      const values = enumValues(f.schema);
      if (values && !values.includes(raw)) {
        return errorResult(
          spec,
          `Invalid value for '--${f.key}': '${raw}' (expected one of: ${values.join(", ")})`,
        );
      }
    }
    if (typeof raw !== "string" || f.kind !== "number") {
      continue;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
      return errorResult(spec, `Invalid value for '--${f.key}': '${raw}'`);
    }
    rawFlags[f.key] = n;
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
