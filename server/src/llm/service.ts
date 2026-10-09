import type { SummaryCache } from "../cache";
import type { ChatMessage, CodeSymbol, FlowStep, Graph, ServerMessage } from "../types";
import { OllamaClient, OllamaError } from "./ollama";
import {
  chatContext,
  chatMessages,
  cleanSummary,
  flowMessages,
  flowSequence,
  indexGraph,
  parseFlow,
  staticFlow,
  summaryMessages,
} from "./prompts";
import { LlmQueue } from "./queue";

export class LlmUnavailableError extends Error {}

/** Entry file symbols first, then breadth-first over outgoing edges (spec F4). */
export function summaryOrder(graph: Graph): CodeSymbol[] {
  const real = graph.symbols.filter((s) => s.kind !== "external");
  const byId = new Map(real.map((s) => [s.id, s]));
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, new Set());
    out.get(e.from)!.add(e.to);
  }
  const seen = new Set<string>();
  const order: CodeSymbol[] = [];
  let frontier = real.filter((s) => s.file === graph.entry).map((s) => s.id);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(byId.get(id)!);
      for (const to of out.get(id) ?? []) if (!seen.has(to)) next.push(to);
    }
    frontier = next;
  }
  for (const s of real) if (!seen.has(s.id)) order.push(s);
  return order;
}

export interface LlmServiceOptions {
  host: string;
  model: string;
  cache: SummaryCache;
  broadcast: (m: ServerMessage) => void;
  onSummary: (id: string, hash: string, summary: string) => void;
  onStatusChange: () => void;
  timeoutMs?: number;
  pollMs?: number;
}

/** Local LLM features: streamed card summaries, Explain flow and grounded chat. */
export class LlmService {
  readonly client: OllamaClient;
  readonly queue: LlmQueue;
  reachable = false;
  modelInstalled = false;
  private poller: ReturnType<typeof setInterval> | null = null;
  private requestSeq = 0;

  constructor(private opts: LlmServiceOptions) {
    this.client = new OllamaClient(opts.host, opts.model);
    this.queue = new LlmQueue(opts.timeoutMs ?? 60_000);
    this.queue.setPaused(true);
    this.queue.onChange = () => opts.onStatusChange();
  }

  get model() {
    return this.opts.model;
  }

  get available() {
    return this.reachable && this.modelInstalled;
  }

  async start() {
    await this.checkHealth();
    this.poller = setInterval(() => void this.checkHealth(), this.opts.pollMs ?? 5000);
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  async checkHealth() {
    const h = await this.client.health();
    const changed = h.reachable !== this.reachable || h.modelInstalled !== this.modelInstalled;
    this.reachable = h.reachable;
    this.modelInstalled = h.modelInstalled;
    this.queue.setPaused(!this.available);
    if (changed) this.opts.onStatusChange();
  }

  private markDown(err: OllamaError) {
    if (err.kind !== "unreachable" && err.kind !== "model-missing") return;
    if (err.kind === "unreachable") this.reachable = false;
    if (err.kind === "model-missing") this.modelInstalled = false;
    this.queue.setPaused(true);
    this.opts.onStatusChange();
  }

  nextRequestId() {
    return `r${Date.now().toString(36)}${(++this.requestSeq).toString(36)}`;
  }

  /** Copies cached summaries onto the graph's symbols (instant, no model call). */
  fillCached(graph: Graph) {
    for (const s of graph.symbols) {
      if (s.kind === "external") continue;
      const hit = this.opts.cache.get(s.source, this.opts.model);
      if (hit) s.summary = hit;
      else delete s.summary;
    }
  }

  /** Queues background summaries for symbols without a cached summary. */
  enqueueSummaries(graph: Graph, only?: Set<string>) {
    const idx = indexGraph(graph);
    for (const sym of summaryOrder(graph)) {
      if (only && !only.has(sym.id)) continue;
      if (sym.summary) continue;
      this.queue.enqueue(this.summaryJob(sym, idx), "background");
    }
  }

  /** Keeps only pending summaries that belong to the given graphs. */
  retainSummaries(keys: Set<string>) {
    this.queue.clearBackground((k) => keys.has(k));
  }

  static summaryKey(sym: CodeSymbol) {
    return `sum:${sym.id}:${sym.hash}`;
  }

  private summaryJob(sym: CodeSymbol, idx: ReturnType<typeof indexGraph>) {
    const { cache, broadcast, onSummary, model } = { ...this.opts };
    const job = {
      key: LlmService.summaryKey(sym),
      run: async (signal: AbortSignal) => {
        const cached = cache.get(sym.source, model);
        if (cached) {
          onSummary(sym.id, sym.hash, cached);
          broadcast({ type: "summary.done", symbolId: sym.id, summary: cached, cached: true });
          return;
        }
        const text = await this.client.chat(
          { messages: summaryMessages(sym, idx), temperature: 0.2, numPredict: 60, signal },
          (token) => broadcast({ type: "summary.token", symbolId: sym.id, token }),
        );
        const summary = cleanSummary(text) || "No summary produced.";
        cache.set(sym.source, model, summary);
        onSummary(sym.id, sym.hash, summary);
        broadcast({ type: "summary.done", symbolId: sym.id, summary, cached: false });
      },
      onError: (err: Error) => {
        if (err instanceof OllamaError && (err.kind === "unreachable" || err.kind === "model-missing")) {
          this.markDown(err);
          this.queue.enqueue(job, "background"); // retry once the model is back
          return;
        }
        broadcast({ type: "summary.error", symbolId: sym.id, error: err.message });
      },
    };
    return job;
  }

  /** Re-queues summaries (card retry button). */
  retry(graph: Graph, ids: string[]) {
    const idx = indexGraph(graph);
    for (const id of ids) {
      const sym = idx.byId.get(id);
      if (sym && sym.kind !== "external") this.queue.enqueue(this.summaryJob(sym, idx), "interactive");
    }
  }

  /**
   * Explain flow: the step order comes from static analysis (DFS over ordered calls);
   * the model only writes the text. Without a model, parser-based text is returned.
   */
  explainFlow(graph: Graph, startId: string): { requestId: string; steps: FlowStep[]; llm: boolean } {
    const idx = indexGraph(graph);
    const seq = flowSequence(graph, startId, idx);
    const fallback = staticFlow(graph, seq, idx);
    const requestId = this.nextRequestId();
    if (!this.available || seq.length === 0) return { requestId, steps: fallback, llm: false };
    const { broadcast } = this.opts;
    this.queue.enqueue(
      {
        key: `flow:${requestId}`,
        run: async (signal) => {
          const text = await this.client.chat(
            { messages: flowMessages(graph, seq, idx), temperature: 0.2, format: "json", signal },
            (token) => broadcast({ type: "flow.token", requestId, token }),
          );
          broadcast({ type: "flow.done", requestId, steps: parseFlow(text, seq, fallback) });
        },
        onError: (err) => {
          if (err instanceof OllamaError) this.markDown(err);
          // still give the user a walkthrough built from parser facts
          broadcast({ type: "flow.error", requestId, error: err.message });
          broadcast({ type: "flow.done", requestId, steps: fallback });
        },
      },
      "interactive",
    );
    return { requestId, steps: fallback, llm: true };
  }

  chat(graph: Graph, pinned: string[], history: ChatMessage[], message: string): { requestId: string; contextIds: string[] } {
    if (!this.available) {
      throw new LlmUnavailableError(
        this.reachable
          ? `Model "${this.opts.model}" is not installed. Run: ollama pull ${this.opts.model}`
          : `Ollama is not running at ${this.opts.host}. Start Ollama, then run: ollama pull ${this.opts.model}`,
      );
    }
    const idx = indexGraph(graph);
    const ctx = chatContext(graph, pinned, idx);
    const requestId = this.nextRequestId();
    const { broadcast } = this.opts;
    this.queue.enqueue(
      {
        key: `chat:${requestId}`,
        run: async (signal) => {
          const text = await this.client.chat(
            { messages: chatMessages(ctx.text, history, message), temperature: 0.3, signal },
            (token) => broadcast({ type: "chat.token", requestId, token }),
          );
          broadcast({ type: "chat.done", requestId, text });
        },
        onError: (err) => {
          if (err instanceof OllamaError) this.markDown(err);
          broadcast({ type: "chat.error", requestId, error: err.message });
        },
      },
      "interactive",
    );
    return { requestId, contextIds: ctx.ids };
  }
}
