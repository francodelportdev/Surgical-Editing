/**
 * Startup configuration: sandbox root and resource limits.
 *
 * Security rule: any malformed or ambiguous configuration is a fatal error.
 * Nothing here may silently fall back to running without a sandbox; the only
 * way to disable it is the explicit `--unsafe-no-root` flag.
 */
import { realpathSync, statSync } from "node:fs";

export interface Limits {
  /** Max size in bytes of a file to read, and of the edited result to write. */
  maxFileBytes: number;
  /** Max operations (files) per transaction. */
  maxOperations: number;
  /** Max replacements across the whole transaction. */
  maxReplacements: number;
  /** Max characters in a single `find`. */
  maxFindChars: number;
  /** Max characters in a single `replace`. */
  maxReplaceChars: number;
  /** Max characters of an error message returned to the agent. */
  maxDiagnosticChars: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxOperations: 100,
  maxReplacements: 1_000,
  maxFindChars: 100_000,
  maxReplaceChars: 1_000_000,
  maxDiagnosticChars: 2_000,
});

/** Environment variable for each limit. */
export const LIMIT_ENV: Readonly<Record<keyof Limits, string>> = Object.freeze({
  maxFileBytes: "SURGICAL_MAX_FILE_BYTES",
  maxOperations: "SURGICAL_MAX_OPERATIONS",
  maxReplacements: "SURGICAL_MAX_REPLACEMENTS",
  maxFindChars: "SURGICAL_MAX_FIND_CHARS",
  maxReplaceChars: "SURGICAL_MAX_REPLACE_CHARS",
  maxDiagnosticChars: "SURGICAL_MAX_DIAGNOSTIC_CHARS",
});

export interface ServerConfig {
  /** Physical sandbox root, or undefined only when `unsafe` is true. */
  rootDir: string | undefined;
  unsafe: boolean;
  limits: Limits;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const USAGE =
  "Usage: surgical-editing [--root <dir> | --root=<dir> | --unsafe-no-root]\n" +
  "  --root <dir>        Sandbox root (default: SURGICAL_ROOT_DIR, else the current directory).\n" +
  "  --unsafe-no-root    Disable the sandbox. The server may then edit ANY file this user can write.\n" +
  `  Limits (env): ${Object.values(LIMIT_ENV).join(", ")}`;

function resolveRoot(raw: string, source: string): string {
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new ConfigError(`Invalid sandbox root from ${source}: ${raw} does not exist or is not accessible.`);
  }
  if (!statSync(real).isDirectory()) {
    throw new ConfigError(`Invalid sandbox root from ${source}: ${raw} is not a directory.`);
  }
  return real;
}

function parseLimits(env: NodeJS.ProcessEnv): Limits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof Limits)[]) {
    const name = LIMIT_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (!/^[1-9]\d*$/.test(raw.trim())) {
      throw new ConfigError(`Invalid ${name}: ${JSON.stringify(raw)} (expected a positive integer).`);
    }
    const value = Number(raw.trim());
    if (!Number.isSafeInteger(value)) throw new ConfigError(`Invalid ${name}: ${raw} is too large.`);
    limits[key] = value;
  }
  return limits;
}

/**
 * Parses CLI arguments (without node and script path) and environment.
 * Throws ConfigError on any invalid input.
 */
export function parseConfig(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): ServerConfig {
  let rootArg: string | undefined;
  let unsafe = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--unsafe-no-root") {
      if (unsafe) throw new ConfigError("--unsafe-no-root given more than once.");
      unsafe = true;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      if (rootArg !== undefined) throw new ConfigError("--root given more than once.");
      let value: string | undefined;
      if (arg === "--root") {
        value = args[i + 1];
        // A following flag is not a value: "--root --unsafe-no-root" must fail.
        if (value === undefined || value.startsWith("--")) throw new ConfigError("--root requires a directory.");
        i++;
      } else {
        value = arg.slice("--root=".length);
      }
      if (value === "") throw new ConfigError("--root requires a directory.");
      rootArg = value;
    } else {
      throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }

  const limits = parseLimits(env);

  if (unsafe) {
    if (rootArg !== undefined) throw new ConfigError("--root and --unsafe-no-root are mutually exclusive.");
    return { rootDir: undefined, unsafe: true, limits };
  }

  if (rootArg !== undefined) return { rootDir: resolveRoot(rootArg, "--root"), unsafe: false, limits };
  const envRoot = env.SURGICAL_ROOT_DIR;
  if (envRoot !== undefined && envRoot !== "") {
    return { rootDir: resolveRoot(envRoot, "SURGICAL_ROOT_DIR"), unsafe: false, limits };
  }
  return { rootDir: resolveRoot(cwd, "the current directory"), unsafe: false, limits };
}
