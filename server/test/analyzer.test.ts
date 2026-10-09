import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Analyzer } from "../src/analyzer";
import type { CodeEdge, Graph } from "../src/types";
import { tempShopApp } from "./helpers";

const app = tempShopApp();
afterAll(() => app.cleanup());

const A = "src/AddToCart.ts";
const P = "src/pricing.ts";
const I = "src/inventory.ts";
const O = "src/orders.ts";
const T = "src/types.ts";

const has = (g: Graph, kind: CodeEdge["kind"], from: string, to: string) =>
  g.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
const sym = (g: Graph, id: string) => g.symbols.find((s) => s.id === id);

describe("analyzer on examples/shop-app", () => {
  const analyzer = new Analyzer(app.root);
  const { graph, files } = analyzer.analyze(A, 2);

  test("follows imports to depth 2", () => {
    expect(files[0]).toBe(A);
    expect(new Set(files)).toEqual(new Set([A, I, O, P, T, "src/logger.ts"]));
    expect(analyzer.analyze(A, 0).files).toEqual([A]);
    expect(new Set(analyzer.analyze(A, 1).files)).toEqual(new Set([A, I, O, P, T]));
  });

  test("extracts functions, classes, methods, interfaces, types and enums", () => {
    expect(sym(graph, `${A}#addToCart`)?.kind).toBe("function");
    expect(sym(graph, `${A}#addToCart`)?.signature).toBe("addToCart(cart: Cart, item: OrderItem): Order");
    expect(sym(graph, `${I}#Inventory`)?.kind).toBe("class");
    expect(sym(graph, `${I}#Inventory.reserve`)?.kind).toBe("method");
    expect(sym(graph, `${I}#Inventory.reserve`)?.parentId).toBe(`${I}#Inventory`);
    expect(sym(graph, `${I}#StockStore`)?.kind).toBe("interface");
    expect(sym(graph, `${T}#OrderStatus`)?.kind).toBe("type");
    expect(sym(graph, `${T}#Currency`)?.kind).toBe("enum");
    expect(sym(graph, `${T}#Currency`)?.fields?.map((f) => f.name)).toEqual(["PHP", "USD"]);
  });

  test("records UML visibility for fields and methods", () => {
    const inv = sym(graph, `${I}#Inventory`)!;
    const vis = Object.fromEntries(inv.fields!.map((f) => [f.name, f.visibility]));
    expect(vis).toEqual({ "#stock": "private", "#catalog": "private", warehouse: "public", lowStockThreshold: "protected" });
    expect(sym(graph, `${I}#Inventory.#warnIfLow`)?.visibility).toBe("private");
    expect(sym(graph, `${I}#Inventory.getProduct`)?.visibility).toBe("public");
  });

  test("numbers calls in execution order", () => {
    const calls = graph.edges
      .filter((e) => e.kind === "calls" && e.from === `${A}#addToCart`)
      .sort((a, b) => a.order! - b.order!)
      .map((e) => e.to);
    expect(calls).toEqual([
      `${I}#Inventory.getProduct`,
      "external#Error",
      `${P}#calculateOrderTotal`,
      `${O}#reserveOrderStock`,
      `${O}#processOrder`,
    ]);
  });

  test("builds contains, uses-type, extends, implements and imports edges", () => {
    expect(has(graph, "contains", `${I}#Inventory`, `${I}#Inventory.reserve`)).toBe(true);
    expect(has(graph, "uses-type", `${P}#calculateOrderTotal`, `${T}#Discount`)).toBe(true);
    expect(has(graph, "uses-type", `${T}#Order`, `${T}#OrderStatus`)).toBe(true);
    expect(has(graph, "extends", `${T}#Product`, `${T}#BaseEntity`)).toBe(true);
    expect(has(graph, "implements", `${I}#Inventory`, `${I}#StockStore`)).toBe(true);
    expect(has(graph, "imports", A, P)).toBe(true);
    expect(has(graph, "calls", `${O}#reserveOrderStock`, `${I}#Inventory.reserve`)).toBe(true);
    expect(has(graph, "calls", `${I}#Inventory.reserve`, `${I}#Inventory.#warnIfLow`)).toBe(true);
  });

  test("library calls become external stubs, never guessed project edges", () => {
    expect(sym(graph, "external#Math.round")?.kind).toBe("external");
    expect(sym(graph, "external#Map.get")?.kind).toBe("external");
    expect(sym(graph, "external#Array.reduce")?.kind).toBe("external");
    // every edge endpoint (except file-level imports) is a known symbol
    const ids = new Set(graph.symbols.map((s) => s.id));
    for (const e of graph.edges) if (e.kind !== "imports") expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  test("hashes are deterministic sha256 of the source", () => {
    const again = analyzer.analyze(A, 2).graph;
    expect(sym(again, `${P}#applyDiscount`)?.hash).toBe(sym(graph, `${P}#applyDiscount`)!.hash);
    expect(sym(graph, `${P}#applyDiscount`)!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("keeps the last good symbols when a file has a syntax error", () => {
    const file = join(app.root, P);
    const good = Bun.file(file).text();
    return good.then((text) => {
      writeFileSync(file, text.replace("export function calculateTax", "export function calculateTax(("));
      const broken = analyzer.analyze(A, 2).graph;
      expect(broken.errors?.[0]?.file).toBe(P);
      expect(sym(broken, `${P}#calculateTax`)).toBeDefined();
      writeFileSync(file, text);
      expect(analyzer.analyze(A, 2).graph.errors).toBeUndefined();
    });
  });

  test("rejects unsupported or missing entries", () => {
    expect(() => analyzer.analyze("package.json", 2)).toThrow();
    expect(() => analyzer.analyze("src/missing.ts", 2)).toThrow(/not found/);
  });
});

describe("analyzer on JS and edge cases", () => {
  const extra = tempShopApp();
  afterAll(() => extra.cleanup());
  writeFileSync(
    join(extra.root, "src/util.js"),
    `import { helper } from "./helper.mjs";
export const double = (x) => helper(x) * 2;
export default function main() { return double(2); }
export class Base { run() { return 1; } }
export class Child extends Base { constructor(private_) { super(); } go() { return this.run(); } }
`,
  );
  writeFileSync(join(extra.root, "src/helper.mjs"), "export function helper(x) { return x + 1; }\n");
  const g = new Analyzer(extra.root).analyze("src/util.js", 2).graph;

  test("handles JS, arrow functions, default exports and inheritance", () => {
    expect(sym(g, "src/util.js#double")?.kind).toBe("function");
    expect(sym(g, "src/util.js#main")?.kind).toBe("function");
    expect(has(g, "calls", "src/util.js#main", "src/util.js#double")).toBe(true);
    expect(has(g, "calls", "src/util.js#double", "src/helper.mjs#helper")).toBe(true);
    expect(has(g, "extends", "src/util.js#Child", "src/util.js#Base")).toBe(true);
    expect(has(g, "calls", "src/util.js#Child.go", "src/util.js#Base.run")).toBe(true);
  });
});
