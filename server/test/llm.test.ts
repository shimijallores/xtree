import { describe, expect, test } from "bun:test";
import { LlmQueue } from "../src/llm/queue";
import { chatContext, cleanSummary, flowSequence, parseFlow, staticFlow } from "../src/llm/prompts";
import { summaryOrder } from "../src/llm/service";
import { Analyzer } from "../src/analyzer";
import { canonicalRoot } from "../src/paths";
import { SHOP_APP } from "./helpers";

describe("LlmQueue", () => {
  test("runs one job at a time, interactive before background", async () => {
    const q = new LlmQueue(1000);
    q.setPaused(true);
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (key: string) => ({
      key,
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(5);
        order.push(key);
        running--;
      },
    });
    q.enqueue(job("bg1"), "background");
    q.enqueue(job("bg2"), "background");
    q.enqueue(job("chat"), "interactive");
    expect(q.enqueue(job("bg1"), "background")).toBe(false); // deduplicated
    q.setPaused(false);
    while (order.length < 3) await Bun.sleep(5);
    expect(order).toEqual(["chat", "bg1", "bg2"]);
    expect(maxRunning).toBe(1);
  });

  test("times out stuck jobs and keeps working", async () => {
    const q = new LlmQueue(30);
    q.setPaused(false);
    const errors: string[] = [];
    let ran = false;
    q.enqueue(
      {
        key: "stuck",
        run: (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
        onError: (e) => errors.push(e.message),
      },
      "background",
    );
    q.enqueue({ key: "next", run: async () => void (ran = true) }, "background");
    while (!ran) await Bun.sleep(5);
    expect(errors[0]).toMatch(/Timed out/);
  });
});

describe("prompts", () => {
  const graph = new Analyzer(canonicalRoot(SHOP_APP)).analyze("src/AddToCart.ts", 2).graph;
  const start = "src/AddToCart.ts#addToCart";

  test("cleanSummary keeps one short plain sentence", () => {
    expect(cleanSummary("Summary: `Adds` items. Then more.")).toBe("Adds items.");
    expect(cleanSummary("```ts\ncode\n```\nComputes tax")).toBe("Computes tax");
  });

  test("flow order follows ordered calls depth-first and skips externals", () => {
    const seq = flowSequence(graph, start);
    expect(seq.slice(0, 6)).toEqual([
      start,
      "src/inventory.ts#Inventory.getProduct",
      "src/pricing.ts#calculateOrderTotal",
      "src/pricing.ts#applyDiscount",
      "src/pricing.ts#calculateTax",
      "src/orders.ts#reserveOrderStock",
    ]);
    expect(seq.every((id) => !id.startsWith("external#"))).toBe(true);
  });

  test("parseFlow drops invented symbolIds and falls back on bad JSON", () => {
    const seq = flowSequence(graph, start);
    const fallback = staticFlow(graph, seq);
    const steps = parseFlow(
      JSON.stringify({ steps: [{ step: 1, symbolId: start, text: "Starts here." }, { step: 2, symbolId: "x#fake", text: "nope" }] }),
      seq,
      fallback,
    );
    expect(steps.map((s) => s.symbolId)).toEqual(seq);
    expect(steps[0].text).toBe("Starts here.");
    expect(steps.some((s) => s.symbolId === "x#fake")).toBe(false);
    expect(parseFlow("not json", seq, fallback)).toBe(fallback);
  });

  test("chat context uses pinned symbols plus neighbours, capped in size", () => {
    const ctx = chatContext(graph, ["src/inventory.ts#Inventory.reserve"]);
    expect(ctx.ids[0]).toBe("src/inventory.ts#Inventory.reserve");
    expect(ctx.ids).toContain("src/orders.ts#reserveOrderStock"); // caller
    expect(ctx.text).toContain("Called by: reserveOrderStock");
    expect(ctx.text.length).toBeLessThan(24_500);
    const entryCtx = chatContext(graph, []);
    expect(entryCtx.ids[0]).toBe(start);
  });

  test("summary order starts with the entry file, breadth-first", () => {
    const order = summaryOrder(graph).map((s) => s.id);
    expect(order[0]).toBe(start);
    expect(order.indexOf("src/pricing.ts#calculateOrderTotal")).toBeLessThan(order.indexOf("src/pricing.ts#calculateTax"));
    expect(order.some((id) => id.startsWith("external#"))).toBe(false);
  });
});
