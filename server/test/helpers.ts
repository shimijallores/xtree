import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { canonicalRoot } from "../src/paths";

export const SHOP_APP = resolve(import.meta.dir, "../../examples/shop-app");

/** Copies examples/shop-app to a temp dir so tests can edit files freely. */
export function tempShopApp(): { root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "xtree-test-"));
  // Never inherit a summary cache (.xtree) from a previous manual run of the demo project.
  cpSync(SHOP_APP, dir, { recursive: true, filter: (src) => !src.replace(/\\/g, "/").includes("/.xtree") });
  const root = canonicalRoot(dir);
  return { root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface MockOllama {
  url: string;
  requests: { model: string; messages: { role: string; content: string }[]; format?: string }[];
  /** Override the reply for the next requests. */
  reply: (body: MockRequest) => string;
  installed: string[];
  failChat: boolean;
  delayMs: number;
  stop: () => void;
}

export interface MockRequest {
  model: string;
  messages: { role: string; content: string }[];
  format?: string;
}

/** Tiny Ollama stand-in: /api/tags and streaming NDJSON /api/chat. */
export function startMockOllama(): MockOllama {
  const state: MockOllama = {
    url: "",
    requests: [],
    installed: ["qwen2.5-coder:3b"],
    failChat: false,
    delayMs: 0,
    reply: (body) => {
      if (body.format === "json") {
        const ids = [...body.messages[1].content.matchAll(/symbolId "([^"]+)"/g)].map((m) => m[1]);
        return JSON.stringify({
          steps: [
            ...ids.map((id, i) => ({ step: i + 1, symbolId: id, text: `LLM step for ${id}` })),
            { step: 99, symbolId: "src/nope.ts#invented", text: "hallucinated" },
          ],
        });
      }
      const sys = body.messages[0]?.content ?? "";
      if (sys.includes("# Code context")) return "When stock runs out, Inventory.reserve throws and addToCart stops.";
      return "Adds numbers together and returns the total for the order. Extra sentence ignored.";
    },
    stop: () => {},
  };
  const server: Server<unknown> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tags") {
        return Response.json({ models: state.installed.map((name) => ({ name, model: name })) });
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const body = (await req.json()) as MockRequest;
        state.requests.push(body);
        if (!state.installed.includes(body.model)) {
          return Response.json({ error: `model "${body.model}" not found, try pulling it first` }, { status: 404 });
        }
        if (state.failChat) return new Response("boom", { status: 500 });
        const text = state.reply(body);
        const chunks = text.match(/.{1,12}/gs) ?? [];
        const enc = new TextEncoder();
        const delay = state.delayMs;
        const stream = new ReadableStream({
          async start(ctrl) {
            for (const c of chunks) {
              if (delay) await Bun.sleep(delay);
              ctrl.enqueue(enc.encode(`${JSON.stringify({ message: { role: "assistant", content: c }, done: false })}\n`));
            }
            ctrl.enqueue(enc.encode(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true })}\n`));
            ctrl.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 5000, stepMs = 25): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(stepMs);
  }
}
