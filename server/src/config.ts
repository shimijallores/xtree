import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface XTreeConfig {
  root: string;
  port: number;
  depth: number;
  model: string;
  ollama: string;
  open: boolean;
  force: boolean;
  maxFiles: number;
}

/** Raw CLI flags. Undefined means "not passed", so lower-precedence sources can fill in. */
export interface CliFlags {
  port?: string;
  depth?: string;
  model?: string;
  ollama?: string;
  open?: boolean;
  force?: boolean;
  maxFiles?: string;
}

export const DEFAULTS = {
  port: 4317,
  depth: 2,
  model: "qwen2.5-coder:3b",
  ollama: "http://127.0.0.1:11434",
  maxFiles: 5000,
} as const;

export class ConfigError extends Error {}

function int(name: string, raw: unknown, min: number, max: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`Invalid ${name}: "${raw}" (expected an integer from ${min} to ${max})`);
  }
  return n;
}

function url(name: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw);
  try {
    const u = new URL(s.includes("://") ? s : `http://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    return u.origin;
  } catch {
    throw new ConfigError(`Invalid ${name}: "${s}" (expected an http(s) URL)`);
  }
}

function readConfigFile(root: string): Record<string, unknown> {
  const file = join(root, "xtree.config.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`Could not parse ${file}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  // The config file lives inside the project being analysed, so an untrusted repo must not be
  // able to send your source code to another machine. Remote Ollama hosts need --ollama or OLLAMA_HOST.
  if (cfg.ollama !== undefined) {
    const u = url("ollama in xtree.config.json", cfg.ollama);
    if (u && !isLoopbackUrl(u)) {
      console.warn(
        `  ! Ignoring "ollama": "${u}" in xtree.config.json. Remote Ollama hosts must be set with --ollama or OLLAMA_HOST.`,
      );
      delete cfg.ollama;
    }
  }
  return cfg;
}

/** Precedence: flags > env vars > xtree.config.json > defaults. */
export function resolveConfig(
  root: string,
  flags: CliFlags,
  env: Record<string, string | undefined> = process.env,
): XTreeConfig {
  const file = readConfigFile(root);
  const pick = <T>(...vals: (T | undefined)[]) => vals.find((v) => v !== undefined);

  const port =
    pick(int("--port", flags.port, 1, 65535), int("XTREE_PORT", env.XTREE_PORT, 1, 65535), int("port in xtree.config.json", file.port, 1, 65535)) ??
    DEFAULTS.port;
  const depth =
    pick(int("--depth", flags.depth, 0, 10), int("XTREE_DEPTH", env.XTREE_DEPTH, 0, 10), int("depth in xtree.config.json", file.depth, 0, 10)) ??
    DEFAULTS.depth;
  const maxFiles =
    pick(
      int("--max-files", flags.maxFiles, 1, 1_000_000),
      int("XTREE_MAX_FILES", env.XTREE_MAX_FILES, 1, 1_000_000),
      int("maxFiles in xtree.config.json", file.maxFiles, 1, 1_000_000),
    ) ?? DEFAULTS.maxFiles;
  const model =
    pick(flags.model || undefined, env.XTREE_MODEL || undefined, typeof file.model === "string" ? file.model : undefined) ??
    DEFAULTS.model;
  const ollama =
    pick(url("--ollama", flags.ollama), url("OLLAMA_HOST", env.OLLAMA_HOST), url("ollama in xtree.config.json", file.ollama)) ??
    DEFAULTS.ollama;

  return {
    root,
    port,
    depth,
    model,
    ollama,
    open: flags.open !== false,
    force: flags.force === true,
    maxFiles,
  };
}

export function isLoopbackUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}
