import type { ChatMessage, CodeSymbol, FlowStep, Graph } from "../types";
import type { ChatMsg } from "./ollama";

export const SYSTEM =
  "You explain code to a developer. Only describe what the given code does. If information is missing, say so. Never invent functions or calls.";

const MAX_SOURCE = 4000;
const MAX_CHAT_CONTEXT = 24_000; // ~6k tokens at ~4 chars/token
const MAX_FLOW_STEPS = 16;

const clipSource = (s: string, n = MAX_SOURCE) => (s.length > n ? `${s.slice(0, n)}\n// … (truncated)` : s);
// ids are `${file}#${qualifiedName}`; only the first # separates them (#private members).
export const qualified = (id: string) => {
  const i = id.indexOf("#");
  return i >= 0 ? id.slice(i + 1) : id;
};

interface Index {
  byId: Map<string, CodeSymbol>;
  callers: Map<string, string[]>;
  callees: Map<string, { to: string; order: number }[]>;
  types: Map<string, string[]>;
  neighbors: Map<string, Set<string>>;
}

export function indexGraph(graph: Graph): Index {
  const byId = new Map(graph.symbols.map((s) => [s.id, s]));
  const callers = new Map<string, string[]>();
  const callees = new Map<string, { to: string; order: number }[]>();
  const types = new Map<string, string[]>();
  const neighbors = new Map<string, Set<string>>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  const link = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (e.kind === "calls") {
      push(callers, e.to, e.from);
      push(callees, e.from, { to: e.to, order: e.order ?? 0 });
    } else if (e.kind === "uses-type") push(types, e.from, e.to);
    link(e.from, e.to);
    link(e.to, e.from);
  }
  for (const l of callees.values()) l.sort((a, b) => a.order - b.order);
  return { byId, callers, callees, types, neighbors };
}

const names = (ids: string[] | undefined) => (ids?.length ? ids.map(qualified).join(", ") : "none");

// ---------------------------------------------------------------- summaries

export function summaryMessages(sym: CodeSymbol, idx: Index): ChatMsg[] {
  const callees = idx.callees.get(sym.id)?.map((c) => c.to);
  const user = [
    `Summarize this ${sym.kind} in ONE sentence of at most 20 words. No code, no markdown, no preamble.`,
    "",
    `Signature: ${sym.signature}`,
    `Called by: ${names(idx.callers.get(sym.id))}`,
    `Calls: ${names(callees)}`,
    "",
    "Source:",
    "```",
    clipSource(sym.source),
    "```",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

/** Keeps the first sentence, strips markdown / quotes, caps the length. */
export function cleanSummary(text: string): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(summary|this (function|method|class|code))\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "");
  const m = s.match(/^.*?[.!?](\s|$)/);
  if (m) s = m[0].trim();
  const words = s.split(" ");
  if (words.length > 28) s = `${words.slice(0, 28).join(" ")}…`;
  return s;
}

// ---------------------------------------------------------------- flow

/** Depth-first walk over ordered calls from `startId`: the deterministic step order. */
export function flowSequence(graph: Graph, startId: string, idx = indexGraph(graph)): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || out.length >= MAX_FLOW_STEPS) return;
    const s = idx.byId.get(id);
    if (!s || s.kind === "external") return;
    seen.add(id);
    out.push(id);
    for (const c of idx.callees.get(id) ?? []) walk(c.to);
  };
  walk(startId);
  return out;
}

/** Step text built from parser facts only; used when the model is unavailable or invalid. */
export function staticFlow(graph: Graph, seq: string[], idx = indexGraph(graph)): FlowStep[] {
  return seq.map((id, i) => {
    const s = idx.byId.get(id)!;
    const all = idx.callees.get(id) ?? [];
    const project = all.filter((c) => idx.byId.get(c.to)?.kind !== "external").map((c) => qualified(c.to));
    const external = all.filter((c) => idx.byId.get(c.to)?.kind === "external").map((c) => qualified(c.to));
    const caller = seq.slice(0, i).find((p) => idx.callees.get(p)?.some((c) => c.to === id));
    const parts = [
      i === 0 ? `${qualified(id)} is where the flow starts.` : `${caller ? qualified(caller) : "The flow"} calls ${qualified(id)}.`,
      project.length ? `It then calls ${project.join(", ")}.` : "It makes no further project calls.",
    ];
    if (external.length) parts.push(`Library calls: ${external.join(", ")}.`);
    if (s.summary) parts.push(s.summary);
    return { step: i + 1, symbolId: id, text: parts.join(" ") };
  });
}

export function flowMessages(graph: Graph, seq: string[], idx = indexGraph(graph)): ChatMsg[] {
  let budget = 14_000;
  const blocks = seq.map((id, i) => {
    const s = idx.byId.get(id)!;
    const callees = (idx.callees.get(id) ?? []).map((c) => `${c.order}. ${qualified(c.to)}`).join("; ");
    const src = clipSource(s.source, Math.max(300, Math.min(2000, budget)));
    budget -= src.length;
    return [`Step ${i + 1}: symbolId "${id}"`, `Signature: ${s.signature}`, `Calls in order: ${callees || "none"}`, "```", src, "```"].join("\n");
  });
  const user = [
    "Explain this call flow as a numbered walkthrough. The steps are already fixed by static analysis; write one or two short sentences per step describing what happens there and why it matters for the flow.",
    'Reply with JSON only: {"steps":[{"step":1,"symbolId":"<exact symbolId>","text":"..."}]}. Use exactly the given symbolIds, in the given order.',
    "",
    ...blocks,
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

/** Parses the model's JSON; drops steps with unknown symbolIds; falls back to static text per step. */
export function parseFlow(text: string, seq: string[], fallback: FlowStep[]): FlowStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return fallback;
    try {
      raw = JSON.parse(m[0]);
    } catch {
      return fallback;
    }
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { steps?: unknown })?.steps) ? (raw as { steps: unknown[] }).steps : null;
  if (!arr) return fallback;
  const valid = new Set(seq);
  const texts = new Map<string, string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { symbolId, text: t } = item as { symbolId?: unknown; text?: unknown };
    if (typeof symbolId !== "string" || !valid.has(symbolId) || typeof t !== "string" || !t.trim()) continue;
    if (!texts.has(symbolId)) texts.set(symbolId, t.trim().replace(/\s+/g, " "));
  }
  if (!texts.size) return fallback;
  return fallback.map((st) => ({ ...st, text: texts.get(st.symbolId) ?? st.text }));
}

// ---------------------------------------------------------------- chat

function symbolBlock(s: CodeSymbol, idx: Index, withSource: boolean): string {
  const callees = idx.callees.get(s.id)?.map((c) => c.to);
  const lines = [
    `### ${qualified(s.id)} (${s.kind}, ${s.file}:${s.range.start}-${s.range.end})`,
    `Signature: ${s.signature}`,
    `Called by: ${names(idx.callers.get(s.id))}`,
    `Calls: ${names(callees)}`,
    `Types used: ${names(idx.types.get(s.id))}`,
  ];
  if (s.summary) lines.push(`Summary: ${s.summary}`);
  if (withSource && s.source) lines.push("```", clipSource(s.source, 3000), "```");
  return lines.join("\n");
}

/**
 * Context = pinned symbols + their direct neighbours (or the entry flow if nothing is
 * pinned), capped at ~6k tokens. Farthest symbols are trimmed first.
 */
export function chatContext(graph: Graph, pinned: string[], idx = indexGraph(graph)): { text: string; ids: string[] } {
  const valid = pinned.filter((id) => idx.byId.has(id));
  let core: string[];
  if (valid.length) core = valid;
  else {
    const start =
      graph.symbols.find((s) => s.file === graph.entry && (s.kind === "function" || s.kind === "method")) ??
      graph.symbols.find((s) => s.file === graph.entry);
    core = start ? flowSequence(graph, start.id, idx) : [];
    if (!core.length) core = graph.symbols.filter((s) => s.file === graph.entry).map((s) => s.id);
  }
  const ordered: { id: string; source: boolean }[] = core.map((id) => ({ id, source: true }));
  const seen = new Set(core);
  for (const id of core) {
    for (const n of idx.neighbors.get(id) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      ordered.push({ id: n, source: idx.byId.get(n)?.kind !== "external" });
    }
  }
  const parts: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const o of ordered) {
    const s = idx.byId.get(o.id);
    if (!s) continue;
    let block = symbolBlock(s, idx, o.source);
    if (used + block.length > MAX_CHAT_CONTEXT) {
      block = symbolBlock(s, idx, false); // keep facts, drop source
      if (used + block.length > MAX_CHAT_CONTEXT) break;
    }
    parts.push(block);
    ids.push(o.id);
    used += block.length;
  }
  return { text: parts.join("\n\n"), ids };
}

export function chatMessages(context: string, history: ChatMessage[], message: string): ChatMsg[] {
  const sys = `${SYSTEM}
Answer questions using only the code context below. Refer to symbols by their exact names (for example Inventory.reserve). Use short markdown. If the context does not contain the answer, say so.

# Code context
${context || "(no symbols in context)"}`;
  const hist = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  return [{ role: "system", content: sys }, ...hist, { role: "user", content: message }];
}
