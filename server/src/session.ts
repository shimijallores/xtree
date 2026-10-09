import { AnalyzeError, Analyzer } from "./analyzer";
import { SummaryCache } from "./cache";
import type { XTreeConfig } from "./config";
import { LlmService } from "./llm/service";
import { type ScanResult, scan } from "./scanner";
import type { CodeSymbol, FileNode, Graph, ServerMessage, StatusInfo } from "./types";

interface Tracked {
  entry: string;
  depth: number;
  graph: Graph;
  files: Set<string>;
  usedAt: number;
}

const MAX_TRACKED = 6;

export interface ChangeBatch {
  changed: Set<string>; // relative paths of modified files
  structural: boolean; // files/dirs added or removed
  configChanged: boolean; // tsconfig / .gitignore
}

/** All per-project state: file tree, analyzer, live graphs and the LLM service. */
export class Session {
  readonly analyzer: Analyzer;
  readonly cache: SummaryCache;
  readonly llm: LlmService;
  private scanResult: ScanResult;
  private tracked = new Map<string, Tracked>();
  private listeners = new Set<(m: ServerMessage) => void>();

  constructor(readonly config: XTreeConfig) {
    this.analyzer = new Analyzer(config.root);
    this.cache = new SummaryCache(config.root);
    this.scanResult = scan(config.root, config.maxFiles);
    this.llm = new LlmService({
      host: config.ollama,
      model: config.model,
      cache: this.cache,
      broadcast: (m) => this.broadcast(m),
      onSummary: (id, hash, summary) => this.setSummary(id, hash, summary),
      onStatusChange: () => this.broadcastStatus(),
    });
  }

  get scan() {
    return this.scanResult;
  }

  subscribe(fn: (m: ServerMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(m: ServerMessage) {
    for (const fn of this.listeners) fn(m);
  }

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces status updates (queue changes fire often while summaries stream). */
  broadcastStatus() {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.broadcast({ type: "status", ...this.status() });
    }, 100);
  }

  status(): StatusInfo {
    let done = 0;
    let total = 0;
    const latest = this.latest();
    if (latest) {
      for (const s of latest.graph.symbols) {
        if (s.kind === "external") continue;
        total++;
        if (s.summary) done++;
      }
    }
    return {
      ollama: this.llm.reachable,
      model: this.llm.model,
      modelInstalled: this.llm.modelInstalled,
      queued: this.llm.queue.size,
      done,
      total,
      root: this.config.root,
      truncated: this.scanResult.truncated,
      fileCount: this.scanResult.files.length,
      maxFiles: this.config.maxFiles,
    };
  }

  files(): { files: FileNode[]; truncated: boolean; fileCount: number; maxFiles: number; root: string } {
    return {
      files: this.scanResult.tree,
      truncated: this.scanResult.truncated,
      fileCount: this.scanResult.files.length,
      maxFiles: this.config.maxFiles,
      root: this.config.root.split("/").pop() ?? this.config.root,
    };
  }

  private latest(): Tracked | undefined {
    let best: Tracked | undefined;
    for (const t of this.tracked.values()) if (!best || t.usedAt > best.usedAt) best = t;
    return best;
  }

  /** Finds the graph that contains a symbol (most recently used first). */
  graphFor(entry: string | undefined, symbolId?: string): Graph | undefined {
    const all = [...this.tracked.values()].sort((a, b) => b.usedAt - a.usedAt);
    if (entry) {
      const hit = all.find((t) => t.entry === entry && (!symbolId || t.graph.symbols.some((s) => s.id === symbolId)));
      if (hit) return hit.graph;
    }
    return all.find((t) => !symbolId || t.graph.symbols.some((s) => s.id === symbolId))?.graph;
  }

  /** Analyzes an entry file, starts background summaries and tracks it for live updates. */
  graph(entry: string, depth = this.config.depth): Graph {
    const key = `${entry}@${depth}`;
    const { graph, files } = this.analyzer.analyze(entry, depth);
    this.llm.fillCached(graph);
    this.tracked.set(key, { entry, depth, graph, files: new Set(files), usedAt: Date.now() });
    while (this.tracked.size > MAX_TRACKED) {
      const oldest = [...this.tracked.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      this.tracked.delete(oldest[0]);
    }
    // the newest graph's summaries take the queue; stale pending work is dropped
    this.llm.retainSummaries(new Set(graph.symbols.map((s) => LlmService.summaryKey(s))));
    this.llm.enqueueSummaries(graph);
    this.broadcastStatus();
    return graph;
  }

  private setSummary(id: string, hash: string, summary: string) {
    for (const t of this.tracked.values()) {
      const s = t.graph.symbols.find((x) => x.id === id && x.hash === hash);
      if (s) s.summary = summary;
    }
  }

  /** Applies a debounced batch of file system changes (watcher). */
  applyChanges(batch: ChangeBatch) {
    if (batch.configChanged) this.analyzer.reload();
    if (batch.structural || batch.configChanged) {
      const before = JSON.stringify(this.scanResult.tree);
      this.scanResult = scan(this.config.root, this.config.maxFiles);
      if (JSON.stringify(this.scanResult.tree) !== before) {
        this.broadcast({ type: "files", files: this.scanResult.tree });
      }
    }
    for (const [key, t] of this.tracked) {
      const touched = batch.structural || batch.configChanged || [...batch.changed].some((f) => t.files.has(f));
      if (!touched) continue;
      let next: { graph: Graph; files: string[] };
      try {
        next = this.analyzer.analyze(t.entry, t.depth);
      } catch (err) {
        // A missing file is often temporary (atomic saves, branch switches): keep tracking and
        // try again on the next change. Anything else (now ignored / outside the project) is final.
        if (!(err instanceof AnalyzeError && err.status === 404)) this.tracked.delete(key);
        continue;
      }
      this.llm.fillCached(next.graph);
      const diff = diffGraphs(t.graph, next.graph);
      t.graph = next.graph;
      t.files = new Set(next.files);
      const errorsChanged = JSON.stringify(diff.prevErrors) !== JSON.stringify(next.graph.errors ?? []);
      if (!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.edgesChanged && !errorsChanged) continue;
      this.broadcast({
        type: "graph.diff",
        entry: t.entry,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        edges: next.graph.edges,
        errors: next.graph.errors ?? [],
      });
      const resummarize = new Set([...diff.added, ...diff.changed].map((s) => s.id));
      if (resummarize.size) this.llm.enqueueSummaries(next.graph, resummarize);
    }
    this.broadcastStatus();
  }

  close() {
    this.llm.stop();
    this.cache.flush();
  }
}

export function diffGraphs(prev: Graph, next: Graph) {
  const before = new Map(prev.symbols.map((s) => [s.id, s]));
  const after = new Map(next.symbols.map((s) => [s.id, s]));
  const added: CodeSymbol[] = [];
  const changed: CodeSymbol[] = [];
  const removed: string[] = [];
  for (const [id, s] of after) {
    const old = before.get(id);
    if (!old) added.push(s);
    else if (old.hash !== s.hash || old.signature !== s.signature || JSON.stringify(old.fields) !== JSON.stringify(s.fields)) {
      changed.push(s);
    }
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  const edgeKey = (g: Graph) =>
    g.edges
      .map((e) => `${e.id}:${e.order ?? ""}`)
      .sort()
      .join("|");
  return { added, changed, removed, edgesChanged: edgeKey(prev) !== edgeKey(next), prevErrors: prev.errors ?? [] };
}
