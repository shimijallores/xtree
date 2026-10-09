import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, CliError, resolveTarget } from "../src/command";
import type { CliFlags } from "../src/config";
import { ConfigError, DEFAULTS, isLoopbackUrl, resolveConfig } from "../src/config";
import { SHOP_APP } from "./helpers";

async function parse(args: string[]) {
  let got: { path: string | undefined; flags: CliFlags } | null = null;
  const program = buildProgram(async (path, flags) => {
    got = { path, flags };
  });
  program.exitOverride();
  await program.parseAsync(["bun", "xtree", ...args]);
  return got as unknown as { path: string | undefined; flags: CliFlags };
}

describe("command routing (start is the default command)", () => {
  test("xtree start . and xtree . are equivalent", async () => {
    expect((await parse(["start", "."])).path).toBe(".");
    expect((await parse(["."])).path).toBe(".");
  });
  test("bare xtree and xtree start use the current directory", async () => {
    expect((await parse([])).path).toBeUndefined();
    expect((await parse(["start"])).path).toBeUndefined();
  });
  test("flags work in both forms", async () => {
    const a = await parse(["--no-open", "."]);
    const b = await parse(["start", "--no-open", "-p", "5000", "."]);
    expect(a.flags.open).toBe(false);
    expect(a.path).toBe(".");
    expect(b.flags.open).toBe(false);
    expect(b.flags.port).toBe("5000");
  });
  test("a folder named like a command must be written ./start", async () => {
    expect((await parse(["./start"])).path).toBe("./start");
    expect((await parse(["start", "start"])).path).toBe("start");
  });
});

describe("target guards", () => {
  const dir = mkdtempSync(join(tmpdir(), "xtree-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("typo suggests the start command", () => {
    expect(() => resolveTarget("strat", dir, false)).toThrow(/Did you mean "xtree start"/);
    expect(() => resolveTarget("./strat", dir, false)).toThrow(/^Path not found: "\.\/strat"$/);
  });

  test("refuses folders that don't look like a project unless --force", () => {
    const empty = join(dir, "empty");
    mkdirSync(join(empty, "docs"), { recursive: true });
    writeFileSync(join(empty, "docs", "readme.md"), "# hi");
    expect(() => resolveTarget(empty, dir, false)).toThrow(CliError);
    expect(() => resolveTarget(empty, dir, false)).toThrow(/--force/);
    expect(resolveTarget(empty, dir, true)).toContain("empty");
  });

  test("accepts folders with source files two levels down", () => {
    const p = join(dir, "loose");
    mkdirSync(join(p, "a", "b"), { recursive: true });
    writeFileSync(join(p, "a", "b", "x.ts"), "export const x = 1;");
    expect(resolveTarget(p, dir, false)).toContain("loose");
    const deep = join(dir, "deep");
    mkdirSync(join(deep, "a", "b", "c"), { recursive: true });
    writeFileSync(join(deep, "a", "b", "c", "x.ts"), "export const x = 1;");
    expect(() => resolveTarget(deep, dir, false)).toThrow(/doesn't look like/);
  });

  test("accepts the shop-app example and rejects files", () => {
    expect(resolveTarget(SHOP_APP, dir, false)).toMatch(/shop-app$/);
    expect(() => resolveTarget(join(SHOP_APP, "package.json"), dir, false)).toThrow(/Not a directory/);
  });
});

describe("config precedence: flags > env > xtree.config.json > defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "xtree-cfg-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("defaults", () => {
    const c = resolveConfig(root, {}, {});
    expect(c.port).toBe(DEFAULTS.port);
    expect(c.model).toBe("qwen2.5-coder:3b");
    expect(c.depth).toBe(2);
    expect(c.maxFiles).toBe(5000);
    expect(c.open).toBe(true);
    expect(c.ollama).toBe("http://127.0.0.1:11434");
  });

  test("file < env < flags", () => {
    writeFileSync(join(root, "xtree.config.json"), JSON.stringify({ model: "file-model", depth: 3, port: 4400 }));
    expect(resolveConfig(root, {}, {}).model).toBe("file-model");
    expect(resolveConfig(root, {}, { XTREE_MODEL: "env-model" }).model).toBe("env-model");
    expect(resolveConfig(root, { model: "flag-model" }, { XTREE_MODEL: "env-model" }).model).toBe("flag-model");
    expect(resolveConfig(root, {}, {}).depth).toBe(3);
    expect(resolveConfig(root, { port: "4500" }, {}).port).toBe(4500);
    expect(resolveConfig(root, {}, { OLLAMA_HOST: "127.0.0.1:9999" }).ollama).toBe("http://127.0.0.1:9999");
  });

  test("invalid values are rejected", () => {
    expect(() => resolveConfig(root, { port: "abc" }, {})).toThrow(ConfigError);
    expect(() => resolveConfig(root, { maxFiles: "0" }, {})).toThrow(ConfigError);
    expect(() => resolveConfig(root, { ollama: "ftp://x" }, {})).toThrow(ConfigError);
  });

  test("loopback detection for the Ollama host", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434")).toBe(false);
  });
});
