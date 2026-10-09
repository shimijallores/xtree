import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FSWatcher } from "chokidar";
import { resolveConfig } from "../src/config";
import { type StartedServer, startServer } from "../src/server";
import { Session } from "../src/session";
import type { Graph, ServerMessage } from "../src/types";
import { watchProject } from "../src/watcher";
import { type MockOllama, startMockOllama, tempShopApp, waitFor } from "./helpers";

let app: ReturnType<typeof tempShopApp>;
let ollama: MockOllama;
let session: Session;
let srv: StartedServer;
let watcher: FSWatcher;
let ws: WebSocket;
const messages: ServerMessage[] = [];

let base = "";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  app = tempShopApp();
  ollama = startMockOllama();
  const config = resolveConfig(app.root, { ollama: ollama.url, port: "47317", open: false }, {});
  session = new Session(config);
  srv = startServer(session, config.port);
  base = `http://127.0.0.1:${srv.port}`;
  watcher = watchProject(app.root, (b) => session.applyChanges(b));
  await new Promise<void>((r) => watcher.on("ready", () => r()));
  await session.llm.start();
  ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
});

afterAll(async () => {
  ws?.close();
  srv?.stop();
  session?.close();
  await watcher?.close();
  ollama?.stop();
  app?.cleanup();
});

describe("server", () => {
  test("binds to 127.0.0.1 and moves to the next port when busy", () => {
    expect(srv.server.hostname).toBe("127.0.0.1");
    const second = startServer(session, srv.port);
    try {
      expect(second.port).toBe(srv.port + 1);
    } finally {
      second.stop();
    }
  });

  test("GET /api/files returns the project tree", async () => {
    const r: any = await (await fetch(`${base}/api/files`)).json();
    expect(r.files[0].name).toBe("src");
    expect(r.fileCount).toBe(6);
    expect(r.truncated).toBe(false);
  });

  test("rejects foreign Host / Origin headers (DNS rebinding, cross-site)", async () => {
    expect((await fetch(`${base}/api/files`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/files`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/files`, { headers: { origin: `http://localhost:${srv.port}` } })).status).toBe(200);
    const bad = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { origin: "http://evil.example" } } as never);
    const closed = await new Promise<boolean>((r) => {
      bad.onopen = () => r(false);
      bad.onerror = () => r(true);
      bad.onclose = () => r(true);
    });
    expect(closed).toBe(true);
  });

  test("rejects path traversal, non-JSON bodies and unsupported files", async () => {
    expect((await post("/api/graph", { entry: "../../etc/passwd" })).status).toBe(400);
    expect((await post("/api/graph", { entry: "C:/Windows/win.ini" })).status).toBe(400);
    expect((await post("/api/graph", { entry: "package.json" })).status).toBe(400);
    expect((await post("/api/graph", { entry: "src/missing.ts" })).status).toBe(404);
    const form = await fetch(`${base}/api/graph`, { method: "POST", body: "entry=src/AddToCart.ts" });
    expect(form.status).toBe(415);
  });

  test("POST /api/graph returns the graph and streams summaries over WebSocket", async () => {
    const res = await post("/api/graph", { entry: "src/AddToCart.ts", depth: 2 });
    expect(res.status).toBe(200);
    const graph = (await res.json()) as Graph;
    expect(graph.symbols.some((s) => s.id === "src/AddToCart.ts#addToCart")).toBe(true);
    const real = graph.symbols.filter((s) => s.kind !== "external");
    await waitFor(
      () => real.every((s) => messages.some((m) => m.type === "summary.done" && m.symbolId === s.id)),
      15_000,
    );
    expect(messages.some((m) => m.type === "summary.token")).toBe(true);
    const done = messages.find((m) => m.type === "summary.done" && m.symbolId === "src/AddToCart.ts#addToCart");
    expect(done && done.type === "summary.done" && done.summary).toBe("Adds numbers together and returns the total for the order.");
    // the first request is the entry function (breadth-first from the entry file)
    expect(ollama.requests[0].messages[1].content).toContain("addToCart(cart: Cart, item: OrderItem): Order");
    expect(ollama.requests[0].model).toBe("qwen2.5-coder:3b");
  });

  test("summaries are cached on disk and served without calling the model", async () => {
    session.cache.flush();
    expect(existsSync(join(app.root, ".xtree", "cache.json"))).toBe(true);
    expect(readFileSync(join(app.root, ".xtree", ".gitignore"), "utf8")).toBe("*\n");
    const before = ollama.requests.length;
    const graph = (await (await post("/api/graph", { entry: "src/AddToCart.ts" })).json()) as Graph;
    const real = graph.symbols.filter((s) => s.kind !== "external");
    expect(real.every((s) => !!s.summary)).toBe(true);
    await Bun.sleep(200);
    expect(ollama.requests.length).toBe(before);
  });

  test("editing a file pushes graph.diff with only the changed symbol, then re-summarizes it", async () => {
    const file = join(app.root, "src/pricing.ts");
    const text = readFileSync(file, "utf8");
    const mark = messages.length;
    writeFileSync(file, text.replace("return discounted + calculateTax(discounted);", "return Math.round(discounted + calculateTax(discounted));"));
    const diff = await waitFor(() => messages.slice(mark).find((m) => m.type === "graph.diff"), 8000);
    if (diff.type !== "graph.diff") throw new Error("unexpected");
    expect(diff.entry).toBe("src/AddToCart.ts");
    expect(diff.changed.map((s) => s.id)).toEqual(["src/pricing.ts#calculateOrderTotal"]);
    expect(diff.removed).toEqual([]);
    expect(diff.edges.some((e) => e.from === "src/pricing.ts#calculateOrderTotal" && e.to === "external#Math.round")).toBe(true);
    await waitFor(
      () => messages.slice(mark).find((m) => m.type === "summary.done" && m.symbolId === "src/pricing.ts#calculateOrderTotal" && !m.cached),
      8000,
    );
  });

  test("adding a function shows up as added", async () => {
    const file = join(app.root, "src/pricing.ts");
    const mark = messages.length;
    writeFileSync(file, `${readFileSync(file, "utf8")}\nexport function roundCents(n: number): number {\n  return Math.round(n * 100) / 100;\n}\n`);
    const diff = await waitFor(() => messages.slice(mark).find((m) => m.type === "graph.diff"), 8000);
    if (diff.type !== "graph.diff") throw new Error("unexpected");
    expect(diff.added.map((s) => s.id)).toContain("src/pricing.ts#roundCents");
  });

  test("Explain flow returns parser steps immediately and LLM text over WebSocket", async () => {
    const res = await post("/api/explain-flow", { symbolId: "src/AddToCart.ts#addToCart", entry: "src/AddToCart.ts" });
    const body: any = await res.json();
    expect(body.llm).toBe(true);
    expect(body.steps[0].symbolId).toBe("src/AddToCart.ts#addToCart");
    const done = await waitFor(() => messages.find((m) => m.type === "flow.done" && m.requestId === body.requestId), 8000);
    if (done.type !== "flow.done") throw new Error("unexpected");
    expect(done.steps[0].text).toBe("LLM step for src/AddToCart.ts#addToCart");
    // the invented symbolId from the model is dropped
    expect(done.steps.some((s) => s.symbolId === "src/nope.ts#invented")).toBe(false);
    expect(done.steps.map((s) => s.symbolId)).toEqual(body.steps.map((s: { symbolId: string }) => s.symbolId));
    const flowReq = ollama.requests.find((r) => r.format === "json");
    expect(flowReq).toBeDefined();
  });

  test("Explain flow rejects non-callables", async () => {
    expect((await post("/api/explain-flow", { symbolId: "src/types.ts#Order", entry: "src/AddToCart.ts" })).status).toBe(400);
  });

  test("chat streams a grounded answer for pinned symbols", async () => {
    const res = await post("/api/chat", {
      message: "What happens if stock runs out?",
      pinned: ["src/inventory.ts#Inventory.reserve"],
      history: [],
      entry: "src/AddToCart.ts",
    });
    expect(res.status).toBe(200);
    const { requestId, contextIds }: any = await res.json();
    expect(contextIds[0]).toBe("src/inventory.ts#Inventory.reserve");
    const done = await waitFor(() => messages.find((m) => m.type === "chat.done" && m.requestId === requestId), 8000);
    if (done.type !== "chat.done") throw new Error("unexpected");
    expect(done.text).toContain("Inventory.reserve");
    expect(messages.some((m) => m.type === "chat.token" && m.requestId === requestId)).toBe(true);
    const req = ollama.requests.at(-1)!;
    expect(req.messages[0].content).toContain("### Inventory.reserve");
    expect(req.messages.at(-1)!.content).toBe("What happens if stock runs out?");
  });

  test("without the model: status reports it, chat answers 503, flow falls back to parser steps", async () => {
    ollama.installed = [];
    await session.llm.checkHealth();
    const status: any = await (await fetch(`${base}/api/status`)).json();
    expect(status.ollama).toBe(true);
    expect(status.modelInstalled).toBe(false);
    const chat = await post("/api/chat", { message: "hi", entry: "src/AddToCart.ts" });
    expect(chat.status).toBe(503);
    expect(((await chat.json()) as { error: string }).error).toContain("ollama pull qwen2.5-coder:3b");
    const flow: any = await (await post("/api/explain-flow", { symbolId: "src/AddToCart.ts#addToCart" })).json();
    expect(flow.llm).toBe(false);
    expect(flow.steps.length).toBeGreaterThan(3);
    // the graph still works
    expect((await post("/api/graph", { entry: "src/orders.ts" })).status).toBe(200);
    ollama.installed = ["qwen2.5-coder:3b"];
    await session.llm.checkHealth();
  });

  test("serves the SPA with index.html fallback", async () => {
    const res = await fetch(`${base}/some/route`);
    // 200 with the built UI, 503 with a hint when web/dist has not been built yet
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });
});
