import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analyzer, AnalyzeError, MAX_FILE_BYTES } from "../src/analyzer";
import { browserCommand } from "../src/command";
import { resolveConfig } from "../src/config";
import { LlmQueue } from "../src/llm/queue";
import { canonicalRoot } from "../src/paths";
import { watchProject } from "../src/watcher";
import type { Graph } from "../src/types";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const names = (g: Graph) => g.symbols.filter((s) => s.kind !== "external").map((s) => s.id.slice(s.id.indexOf("#") + 1));
const edge = (g: Graph, kind: string, from: string, to: string) =>
  g.edges.some((e) => e.kind === kind && e.from.endsWith(`#${from}`) && e.to.endsWith(`#${to}`));

describe("regression: LLM queue retry", () => {
  test("a failed job can re-enqueue itself from onError", async () => {
    const q = new LlmQueue(1000);
    let runs = 0;
    const job = {
      key: "k",
      run: async () => {
        runs++;
        if (runs === 1) throw new Error("ollama went away");
      },
      onError: () => {
        expect(q.enqueue(job, "background")).toBe(true);
      },
    };
    q.enqueue(job, "background");
    while (runs < 2) await Bun.sleep(5);
    expect(runs).toBe(2);
  });
});

describe("regression: React and CommonJS patterns", () => {
  const root = canonicalRoot(tmp("xt-react-"));
  write(root, "package.json", "{}");
  write(root, "src/Button.tsx", `export function Button(p: { label: string }) { return <button>{p.label}</button>; }\n`);
  write(
    root,
    "src/App.tsx",
    `import { Button } from "./Button";
import { Link } from "react-router";
export default function App() { return <div><Button label="x" /><Link to="/" /></div>; }
export const Wrapped = memo(function Inner() { return <Button label="y" />; });
export const Fancy = forwardRef((p: any, ref: any) => <Wrapped />);
const lower = memo(() => 1);
`,
  );
  write(root, "src/b.js", "exports.b = function () { return 1; };\n");
  write(
    root,
    "src/cjs.js",
    `const { b } = require("./b");
exports.a = function () { return b(); };
module.exports.c = () => 1;
`,
  );
  write(root, "src/lib.js", `function one() { return 1; }\nmodule.exports = { two() { return one(); }, three: () => 3 };\n`);

  test("JSX elements are call edges; lowercase DOM tags are not", () => {
    const g = new Analyzer(root).analyze("src/App.tsx", 2).graph;
    expect(edge(g, "calls", "App", "Button")).toBe(true);
    expect(edge(g, "calls", "Wrapped", "Button")).toBe(true);
    expect(edge(g, "calls", "Fancy", "Wrapped")).toBe(true);
    expect(g.symbols.some((s) => s.id === "external#Link")).toBe(true);
    expect(g.symbols.some((s) => s.id === "external#div")).toBe(false);
  });

  test("components wrapped in memo / forwardRef become symbols (only for capitalised names)", () => {
    const g = new Analyzer(root).analyze("src/App.tsx", 2).graph;
    expect(names(g)).toEqual(expect.arrayContaining(["App", "Wrapped", "Fancy", "Button"]));
    expect(names(g)).not.toContain("lower");
  });

  test("CommonJS exports.x / module.exports.x / module.exports = {…} are functions with resolved calls", () => {
    const a = new Analyzer(root);
    const g = a.analyze("src/cjs.js", 2).graph;
    expect(names(g)).toEqual(expect.arrayContaining(["a", "c", "b"]));
    expect(edge(g, "calls", "a", "b")).toBe(true);
    const lib = a.analyze("src/lib.js", 2).graph;
    expect(names(lib)).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect(edge(lib, "calls", "two", "one")).toBe(true);
  });
});

describe("regression: oversized files", () => {
  const root = canonicalRoot(tmp("xt-big-"));
  const huge = "x".repeat(MAX_FILE_BYTES + 10);
  write(root, "package.json", "{}");
  write(root, "src/bundle.js", `/* ${huge} */\nfunction minified() { return 1; }\n`);
  write(root, "src/app.ts", `import "./bundle.js";\nexport function app() { return 1; }\n`);

  test("an oversized entry is rejected with 413", () => {
    try {
      new Analyzer(root).analyze("src/bundle.js", 2);
      throw new Error("expected AnalyzeError");
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzeError);
      expect((e as AnalyzeError).status).toBe(413);
    }
  });

  test("an oversized import is skipped with a visible warning, the rest still works", () => {
    const g = new Analyzer(root).analyze("src/app.ts", 2).graph;
    expect(names(g)).toEqual(["app"]);
    expect(g.errors?.[0]?.file).toBe("src/bundle.js");
    expect(g.errors?.[0]?.message).toContain("skipped");
  });
});

describe("regression: watcher honours .gitignore", () => {
  test("gitignored folders are not watched, supported files are", async () => {
    const root = canonicalRoot(tmp("xt-watch-"));
    write(root, "package.json", "{}");
    write(root, ".gitignore", "out/\n*.local.ts\n");
    write(root, "src/a.ts", "export const a = 1;\n");
    for (let i = 0; i < 50; i++) write(root, `out/g${i}.js`, `export const g${i} = ${i};\n`);
    const batches: string[][] = [];
    const w = watchProject(root, (b) => batches.push([...b.changed]), 50);
    await new Promise<void>((r) => w.on("ready", () => r()));
    const watched = Object.keys(w.getWatched()).map((p) => p.replace(/\\/g, "/"));
    expect(watched.some((p) => p.endsWith("/out"))).toBe(false);
    expect(watched.some((p) => p.endsWith("/src"))).toBe(true);
    write(root, "out/new.js", "export const n = 1;\n");
    write(root, "src/x.local.ts", "export const n = 1;\n");
    write(root, "src/a.ts", "export const a = 2;\n");
    await Bun.sleep(600);
    await w.close();
    expect(batches.flat()).toEqual(["src/a.ts"]);
  });
});

describe("regression: config and launcher", () => {
  test("a remote Ollama host in xtree.config.json is ignored (untrusted repo), flags and env still work", () => {
    const root = tmp("xt-cfg-");
    write(root, "xtree.config.json", JSON.stringify({ ollama: "http://evil.example:11434", model: "m1" }));
    const cfg = resolveConfig(root, {}, {});
    expect(cfg.ollama).toBe("http://127.0.0.1:11434");
    expect(cfg.model).toBe("m1");
    expect(resolveConfig(root, { ollama: "http://10.0.0.5:11434" }, {}).ollama).toBe("http://10.0.0.5:11434");
    expect(resolveConfig(root, {}, { OLLAMA_HOST: "http://10.0.0.6:11434" }).ollama).toBe("http://10.0.0.6:11434");
    write(root, "xtree.config.json", JSON.stringify({ ollama: "http://localhost:9999" }));
    expect(resolveConfig(root, {}, {}).ollama).toBe("http://localhost:9999");
  });

  test("the browser is opened without a shell on every platform", () => {
    expect(browserCommand("http://localhost:4317", "win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler", "http://localhost:4317"]);
    expect(browserCommand("http://localhost:4317", "darwin")).toEqual(["open", "http://localhost:4317"]);
    expect(browserCommand("http://localhost:4317", "linux")).toEqual(["xdg-open", "http://localhost:4317"]);
  });
});
