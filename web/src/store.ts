import { create } from "zustand";
import { fileTree, flowSteps as mockFlowSteps, shopGraph } from "./fixtures/shopApp";
import { api, connectSocket } from "./lib/api";
import type {
  CodeEdge,
  CodeSymbol,
  DisplaySettings,
  FileNode,
  FlowStep,
  Graph,
  ServerMessage,
  UmlDirection,
  ViewMode,
} from "./types";

const UML_DIR_KEY = "xtree.uml.direction";
function loadUmlDirection(): UmlDirection {
  try {
    const v = localStorage.getItem(UML_DIR_KEY);
    if (v === "UP" || v === "DOWN") return v;
  } catch {
    // storage unavailable
  }
  return "UP";
}

export const DEFAULT_MODEL = "qwen2.5-coder:3b";
const CHANGED_FADE_MS = 10_000;

interface FocusRequest {
  id: string;
  nonce: number;
}

export interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  requestId?: string;
}

/**
 * "live": talking to the XTree server started by the CLI.
 * "mock": no backend reachable (UI developed in isolation with `bun dev`), fixtures + simulation.
 */
export type AppMode = "loading" | "live" | "mock";

interface State {
  mode: AppMode;
  connected: boolean;
  graph: Graph;
  files: FileNode[];
  projectName: string;
  filesTruncated: boolean;
  fileCount: number;
  maxFiles: number;
  entry: string;
  graphLoading: boolean;
  graphError: string | null;
  view: ViewMode;
  selectedId: string | null;
  highlightId: string | null; // node highlighted by Explain flow
  focus: FocusRequest | null;
  display: DisplaySettings;
  panelOpen: boolean;
  sections: { filters: boolean; display: boolean; forces: boolean; uml: boolean };
  umlDirection: UmlDirection;
  setUmlDirection: (d: UmlDirection) => void;
  fileQuery: string;
  symbolQuery: string;
  fileSidebarOpen: boolean;
  flowOpen: boolean;
  flowSteps: FlowStep[];
  flowActive: number; // index into flowSteps, -1 = none
  flowLoading: boolean;
  flowRequestId: string | null;
  flowError: string | null;
  // summaries (streamed from the local model, or simulated in mock mode)
  summaries: Record<string, string>; // streamed text so far
  summaryDone: Record<string, boolean>;
  summaryError: Record<string, string>;
  streaming: boolean;
  // live updates: id -> timestamp of the last change
  changed: Record<string, number>;
  // status
  model: string;
  ollamaReachable: boolean;
  ollamaUp: boolean; // reachable and model installed: summaries can run
  queued: number;
  animateNonce: number;
  hoverId: string | null; // UI-only: node under the pointer in the graph view
  // chat
  chatOpen: boolean;
  chat: ChatEntry[];
  chatPending: string | null; // requestId being streamed
  chatError: string | null;
  pinned: string[];

  init: () => Promise<void>;
  setHover: (id: string | null) => void;
  setEntry: (path: string) => void;
  setView: (v: ViewMode) => void;
  select: (id: string | null) => void;
  focusNode: (id: string) => void;
  openInUml: (id: string) => void;
  setDisplay: (patch: Partial<DisplaySettings>) => void;
  resetDisplay: () => void;
  togglePanel: () => void;
  toggleSection: (k: "filters" | "display" | "forces" | "uml") => void;
  setFileQuery: (q: string) => void;
  setSymbolQuery: (q: string) => void;
  toggleFileSidebar: () => void;
  setFlowOpen: (open: boolean) => void;
  stepFlow: (delta: number) => void;
  startFlowFor: (id: string) => void;
  setOllamaUp: (up: boolean) => void;
  animate: () => void;
  simulateEdit: () => void;
  startSummaries: () => void;
  retrySummary: (id: string) => void;
  setChatOpen: (open: boolean) => void;
  sendChat: (text: string) => void;
  clearChat: () => void;
  togglePin: (id: string) => void;

  // onboarding tour (UI-only state; no backend involvement)
  tourOpen: boolean;
  tourStep: number;
  startTour: () => void;
  /** total = number of steps, so the store stays independent of the step list */
  nextTour: (total: number) => void;
  prevTour: () => void;
  endTour: () => void;
}

const TOUR_STORAGE_KEY = "xtree.tour.v1";
const ENTRY_NAMES = [
  "src/index.ts",
  "src/index.tsx",
  "src/main.ts",
  "src/main.tsx",
  "src/App.tsx",
  "src/app.ts",
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "src/index.js",
  "src/main.js",
];

export const defaultDisplay: DisplaySettings = {
  showArrows: true,
  textFadeThreshold: 0.25,
  nodeSize: 0.55,
  linkThickness: 0.35,
  showTypes: true,
  showExternals: true,
  showOrphans: true,
  centerForce: 0.5,
  repelForce: 0.5,
  linkDistance: 0.5,
};

const emptyGraph: Graph = { entry: "", symbols: [], edges: [] };

let focusNonce = 0;
let timers: number[] = [];
const clearTimers = () => {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
};
let graphSeq = 0;
let disconnect: (() => void) | null = null;

function flatFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    else if (n.children) flatFiles(n.children, out);
  }
  return out;
}

function pickInitialEntry(files: FileNode[], project: string): string {
  const all = flatFiles(files);
  try {
    const saved = localStorage.getItem(`xtree.entry:${project}`);
    if (saved && all.includes(saved)) return saved;
  } catch {
    // storage unavailable
  }
  for (const name of ENTRY_NAMES) {
    const hit = all.find((f) => f.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return all.find((f) => /AddToCart|index|main|app/i.test(f)) ?? all[0] ?? "";
}

/** Summary state seeded from summaries the server already had cached. */
function summariesFrom(graph: Graph) {
  const summaries: Record<string, string> = {};
  const summaryDone: Record<string, boolean> = {};
  for (const s of graph.symbols) {
    if (s.summary) {
      summaries[s.id] = s.summary;
      summaryDone[s.id] = true;
    }
  }
  return { summaries, summaryDone };
}

export const useStore = create<State>((set, get) => ({
  mode: "loading",
  connected: false,
  graph: emptyGraph,
  files: [],
  projectName: "",
  filesTruncated: false,
  fileCount: 0,
  maxFiles: 0,
  entry: "",
  graphLoading: false,
  graphError: null,
  view: "graph",
  selectedId: null,
  highlightId: null,
  focus: null,
  display: defaultDisplay,
  panelOpen: true,
  sections: { filters: true, display: true, forces: true, uml: true },
  umlDirection: loadUmlDirection(),
  setUmlDirection: (umlDirection) => {
    try {
      localStorage.setItem(UML_DIR_KEY, umlDirection);
    } catch {
      // storage unavailable; choice lasts for this session only
    }
    set({ umlDirection });
  },
  fileQuery: "",
  symbolQuery: "",
  fileSidebarOpen: true,
  flowOpen: false,
  flowSteps: [],
  flowActive: -1,
  flowLoading: false,
  flowRequestId: null,
  flowError: null,
  summaries: {},
  summaryDone: {},
  summaryError: {},
  streaming: false,
  changed: {},
  model: DEFAULT_MODEL,
  ollamaReachable: false,
  ollamaUp: false,
  queued: 0,
  animateNonce: 0,
  hoverId: null,
  chatOpen: false,
  chat: [],
  chatPending: null,
  chatError: null,
  pinned: [],

  init: async () => {
    if (get().mode !== "loading") return;
    let res: Awaited<ReturnType<typeof api.files>>;
    try {
      res = await api.files(AbortSignal.timeout(4000));
    } catch {
      // No backend: run the UI on fixtures (offline UI development).
      set({
        mode: "mock",
        graph: shopGraph,
        files: fileTree,
        entry: shopGraph.entry,
        projectName: "shop-app (mock)",
        flowSteps: mockFlowSteps,
        ollamaUp: true,
        ollamaReachable: true,
        model: "mock model",
      });
      get().startSummaries();
      return;
    }
    set({
      mode: "live",
      files: res.files,
      projectName: res.root,
      filesTruncated: res.truncated,
      fileCount: res.fileCount,
      maxFiles: res.maxFiles,
    });
    disconnect?.();
    let everConnected = false;
    disconnect = connectSocket(handleMessage, (connected) => {
      const reconnected = connected && everConnected;
      if (connected) everConnected = true;
      set({ connected });
      if (reconnected) void resync();
    });
    const first = pickInitialEntry(res.files, res.root);
    if (first) get().setEntry(first);
  },

  setHover: (hoverId) => {
    if (get().hoverId !== hoverId) set({ hoverId });
  },
  setEntry: (path) => {
    const { mode, projectName } = get();
    set({
      entry: path,
      selectedId: null,
      highlightId: null,
      flowActive: -1,
      flowOpen: false,
      flowSteps: mode === "mock" ? get().flowSteps : [],
      pinned: [],
    });
    if (mode !== "live") return;
    try {
      localStorage.setItem(`xtree.entry:${projectName}`, path);
    } catch {
      // storage unavailable
    }
    const seq = ++graphSeq;
    set({ graphLoading: true, graphError: null });
    api
      .graph(path)
      .then((graph) => {
        if (seq !== graphSeq) return; // a newer selection won
        clearTimers();
        set({ graph, graphLoading: false, changed: {}, summaryError: {}, ...summariesFrom(graph) });
      })
      .catch((err: Error) => {
        if (seq !== graphSeq) return;
        set({ graphLoading: false, graphError: err.message, graph: { ...emptyGraph, entry: path } });
      });
  },
  setView: (view) => set({ view }),
  select: (selectedId) => set({ selectedId }),
  focusNode: (id) => set({ focus: { id, nonce: ++focusNonce }, selectedId: id }),
  openInUml: (id) => set({ view: "uml", selectedId: id, focus: { id, nonce: ++focusNonce } }),
  setDisplay: (patch) => set((s) => ({ display: { ...s.display, ...patch } })),
  resetDisplay: () => set({ display: defaultDisplay }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleSection: (k) => set((s) => ({ sections: { ...s.sections, [k]: !s.sections[k] } })),
  setFileQuery: (fileQuery) => set({ fileQuery }),
  setSymbolQuery: (symbolQuery) => set({ symbolQuery }),
  toggleFileSidebar: () => set((s) => ({ fileSidebarOpen: !s.fileSidebarOpen })),
  setFlowOpen: (flowOpen) =>
    set({
      flowOpen,
      ...(flowOpen ? { chatOpen: false } : { highlightId: null, flowActive: -1, flowLoading: false, flowRequestId: null }),
    }),
  stepFlow: (delta) => {
    const { flowActive, flowSteps: steps } = get();
    if (!steps.length) return;
    const next = Math.min(steps.length - 1, Math.max(0, flowActive + delta));
    const id = steps[next]?.symbolId ?? null;
    set({
      flowActive: next,
      highlightId: id,
      selectedId: id,
      focus: id ? { id, nonce: ++focusNonce } : null,
    });
  },
  startFlowFor: (id) => {
    const { mode, entry } = get();
    if (mode === "mock") {
      const first = get().flowSteps[0]?.symbolId ?? id;
      set({
        flowOpen: true,
        chatOpen: false,
        flowActive: 0,
        highlightId: first,
        selectedId: first,
        focus: { id: first, nonce: ++focusNonce },
      });
      return;
    }
    if (!id) {
      set({ flowOpen: true, chatOpen: false, flowSteps: [], flowError: "Select a function or method first." });
      return;
    }
    set({ flowOpen: true, chatOpen: false, flowLoading: true, flowError: null, flowSteps: [], flowActive: -1 });
    api
      .explainFlow(id, entry)
      .then((r) => {
        const first = r.steps[0]?.symbolId ?? null;
        set({
          flowSteps: r.steps,
          flowRequestId: r.requestId,
          flowLoading: r.llm,
          flowActive: r.steps.length ? 0 : -1,
          highlightId: first,
          selectedId: first,
          focus: first ? { id: first, nonce: ++focusNonce } : null,
        });
      })
      .catch((err: Error) => set({ flowLoading: false, flowError: err.message }));
  },
  setOllamaUp: (ollamaUp) => {
    // only meaningful in mock mode (preview the connected / not running states)
    if (get().mode === "mock") set({ ollamaUp, ollamaReachable: ollamaUp });
  },
  animate: () => set((s) => ({ animateNonce: s.animateNonce + 1 })),

  simulateEdit: () => {
    if (get().mode !== "mock") return;
    const target = "src/pricing.ts#applyDiscount";
    const now = Date.now();
    set((s) => ({
      changed: { ...s.changed, [target]: now },
      summaries: { ...s.summaries, [target]: "" },
      summaryDone: { ...s.summaryDone, [target]: false },
    }));
    const full = get().graph.symbols.find((x) => x.id === target)?.summary ?? "";
    typeInto(target, `${full} (updated)`, 0);
    fadeChanged([target]);
  },

  startSummaries: () => {
    if (get().mode !== "mock") return;
    clearTimers();
    const { graph, entry } = get();
    set({ summaries: {}, summaryDone: {}, streaming: true });
    const order = summaryOrder(graph, entry);
    let delay = 400;
    for (const s of order) {
      const text = s.summary ?? "";
      typeInto(s.id, text, delay);
      delay += text.split(" ").length * 35 + 150;
    }
    timers.push(window.setTimeout(() => set({ streaming: false }), delay));
  },

  retrySummary: (id) => {
    const { mode, entry } = get();
    if (mode !== "live") return;
    set((s) => {
      const summaryError = { ...s.summaryError };
      delete summaryError[id];
      return { summaryError, summaries: { ...s.summaries, [id]: "" }, summaryDone: { ...s.summaryDone, [id]: false } };
    });
    api.summarize([id], entry).catch((err: Error) => set((s) => ({ summaryError: { ...s.summaryError, [id]: err.message } })));
  },

  setChatOpen: (chatOpen) => set({ chatOpen, ...(chatOpen ? { flowOpen: false, highlightId: null, flowActive: -1 } : {}) }),
  clearChat: () => set({ chat: [], chatPending: null, chatError: null }),
  togglePin: (id) =>
    set((s) => ({ pinned: s.pinned.includes(id) ? s.pinned.filter((x) => x !== id) : [...s.pinned, id] })),
  sendChat: (text) => {
    const message = text.trim();
    const { mode, chat, pinned, entry, chatPending } = get();
    if (!message || chatPending) return;
    const history = chat.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    if (mode !== "live") {
      set({
        chat: [
          ...chat,
          { role: "user", content: message },
          { role: "assistant", content: "Chat needs the XTree server and a local model (mock mode).", error: true },
        ],
      });
      return;
    }
    set({ chat: [...chat, { role: "user", content: message }], chatError: null, chatPending: "pending" });
    api
      .chat(message, pinned, history, entry)
      .then((r) => {
        set((s) => ({
          chatPending: r.requestId,
          chat: [...s.chat, { role: "assistant", content: "", requestId: r.requestId }],
        }));
      })
      .catch((err: Error) =>
        set((s) => ({
          chatPending: null,
          chat: [...s.chat, { role: "assistant", content: err.message, error: true }],
        })),
      );
  },

  tourOpen: false,
  tourStep: 0,
  startTour: () => set({ tourOpen: true, tourStep: 0 }),
  nextTour: (total) => set((s) => ({ tourStep: Math.min(total - 1, s.tourStep + 1) })),
  prevTour: () => set((s) => ({ tourStep: Math.max(0, s.tourStep - 1) })),
  endTour: () => {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, "done");
    } catch {
      // storage unavailable; tour will simply show again next visit
    }
    set({ tourOpen: false, tourStep: 0 });
  },
}));

/**
 * After the server restarts it has forgotten which entry is open (so no live diffs or summary
 * jobs for it). Reload the file tree and re-open the current entry without resetting the UI.
 */
async function resync() {
  const { entry } = useStore.getState();
  try {
    const files = await api.files();
    useStore.setState({
      files: files.files,
      filesTruncated: files.truncated,
      fileCount: files.fileCount,
      maxFiles: files.maxFiles,
    });
    if (!entry) return;
    const graph = await api.graph(entry);
    if (useStore.getState().entry !== entry) return; // the user moved on meanwhile
    useStore.setState((s) => {
      const known = summariesFrom(graph);
      return {
        graph,
        graphError: null,
        // keep summaries already on screen for unchanged symbols until fresh ones stream in
        summaries: { ...s.summaries, ...known.summaries },
        summaryDone: { ...s.summaryDone, ...known.summaryDone },
      };
    });
  } catch {
    // the socket will drop again and retry; nothing to do here
  }
}

/** Marks ids as changed and clears the badge after 10 seconds (spec F5). */
function fadeChanged(ids: string[]) {
  if (!ids.length) return;
  const now = Date.now();
  useStore.setState((s) => {
    const changed = { ...s.changed };
    for (const id of ids) changed[id] = now;
    return { changed };
  });
  timers.push(
    window.setTimeout(() => {
      useStore.setState((s) => {
        const changed = { ...s.changed };
        for (const id of ids) if (changed[id] === now) delete changed[id];
        return { changed };
      });
    }, CHANGED_FADE_MS),
  );
}

function updateChatEntry(requestId: string, fn: (e: ChatEntry) => ChatEntry) {
  useStore.setState((s) => ({ chat: s.chat.map((e) => (e.requestId === requestId ? fn(e) : e)) }));
}

function handleMessage(m: ServerMessage) {
  const st = useStore.getState();
  switch (m.type) {
    case "summary.token":
      useStore.setState((s) => ({
        summaries: { ...s.summaries, [m.symbolId]: (s.summaryDone[m.symbolId] ? "" : (s.summaries[m.symbolId] ?? "")) + m.token },
        summaryDone: { ...s.summaryDone, [m.symbolId]: false },
      }));
      return;
    case "summary.done":
      useStore.setState((s) => {
        const summaryError = { ...s.summaryError };
        delete summaryError[m.symbolId];
        return {
          summaries: { ...s.summaries, [m.symbolId]: m.summary },
          summaryDone: { ...s.summaryDone, [m.symbolId]: true },
          summaryError,
          graph: {
            ...s.graph,
            symbols: s.graph.symbols.map((x) => (x.id === m.symbolId ? { ...x, summary: m.summary } : x)),
          },
        };
      });
      return;
    case "summary.error":
      useStore.setState((s) => ({ summaryError: { ...s.summaryError, [m.symbolId]: m.error } }));
      return;
    case "files":
      useStore.setState({ files: m.files });
      return;
    case "graph.diff": {
      if (m.entry !== st.entry) return;
      const removed = new Set(m.removed);
      const changedById = new Map(m.changed.map((s) => [s.id, s]));
      const symbols = st.graph.symbols
        .filter((s) => !removed.has(s.id))
        .map((s) => changedById.get(s.id) ?? s)
        .concat(m.added);
      const fresh = [...m.added, ...m.changed].filter((s) => s.kind !== "external");
      useStore.setState((s) => {
        const summaries = { ...s.summaries };
        const summaryDone = { ...s.summaryDone };
        for (const sym of fresh) {
          summaries[sym.id] = sym.summary ?? "";
          summaryDone[sym.id] = !!sym.summary;
        }
        for (const id of removed) {
          delete summaries[id];
          delete summaryDone[id];
        }
        return {
          graph: { ...s.graph, symbols, edges: m.edges, errors: m.errors },
          summaries,
          summaryDone,
          selectedId: s.selectedId && removed.has(s.selectedId) ? null : s.selectedId,
          pinned: s.pinned.filter((id) => !removed.has(id)),
        };
      });
      fadeChanged(fresh.map((s) => s.id));
      return;
    }
    case "flow.token":
      return;
    case "flow.done":
      if (m.requestId !== st.flowRequestId) return;
      useStore.setState((s) => ({
        flowSteps: m.steps,
        flowLoading: false,
        flowActive: Math.min(Math.max(s.flowActive, 0), m.steps.length - 1),
      }));
      return;
    case "flow.error":
      if (m.requestId !== st.flowRequestId) return;
      useStore.setState({ flowError: `Local model failed (${m.error}); showing parser-based steps.` });
      return;
    case "chat.token":
      updateChatEntry(m.requestId, (e) => ({ ...e, content: e.content + m.token }));
      return;
    case "chat.done":
      updateChatEntry(m.requestId, (e) => ({ ...e, content: m.text }));
      if (st.chatPending === m.requestId) useStore.setState({ chatPending: null });
      return;
    case "chat.error":
      updateChatEntry(m.requestId, (e) => ({ ...e, content: e.content || m.error, error: !e.content }));
      if (st.chatPending === m.requestId) useStore.setState({ chatPending: null });
      return;
    case "status":
      useStore.setState({
        model: m.model,
        ollamaReachable: m.ollama,
        ollamaUp: m.ollama && m.modelInstalled,
        queued: m.queued,
        streaming: m.queued > 0,
        filesTruncated: m.truncated,
        fileCount: m.fileCount,
        maxFiles: m.maxFiles,
      });
      return;
  }
}

function typeInto(id: string, text: string, startDelay: number) {
  const words = text.split(" ");
  words.forEach((_, i) => {
    timers.push(
      window.setTimeout(
        () => {
          useStore.setState((s) => ({
            summaries: { ...s.summaries, [id]: words.slice(0, i + 1).join(" ") },
            summaryDone: { ...s.summaryDone, [id]: i === words.length - 1 },
          }));
        },
        startDelay + i * 35,
      ),
    );
  });
}

// Entry file first, then breadth-first over outgoing edges.
export function summaryOrder(graph: Graph, entry: string): CodeSymbol[] {
  const real = graph.symbols.filter((s) => s.kind !== "external");
  const seen = new Set<string>();
  const out: CodeSymbol[] = [];
  let frontier = real.filter((s) => s.file === entry).map((s) => s.id);
  if (!frontier.length) frontier = real.map((s) => s.id);
  while (frontier.length) {
    const next: string[] = [];
    for (const sid of frontier) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const s = real.find((x) => x.id === sid);
      if (s) out.push(s);
      for (const ed of graph.edges) if (ed.from === sid && !seen.has(ed.to)) next.push(ed.to);
    }
    frontier = next;
  }
  for (const s of real) if (!seen.has(s.id)) out.push(s);
  return out.filter((s) => s.summary);
}

// Spec F2: follow relationships from the entry file up to depth 2.
export function visibleGraph(
  graph: Graph,
  entry: string,
  display: DisplaySettings,
): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const isSource = graph.symbols.some((s) => s.file === entry);
  const keep = new Set<string>();
  if (!isSource) for (const s of graph.symbols) keep.add(s.id);
  else {
    let frontier = graph.symbols.filter((s) => s.file === entry).map((s) => s.id);
    for (const x of frontier) keep.add(x);
    for (let depth = 0; depth < 2; depth++) {
      const next: string[] = [];
      for (const ed of graph.edges) {
        if (frontier.includes(ed.from) && !keep.has(ed.to)) {
          keep.add(ed.to);
          next.push(ed.to);
        }
      }
      frontier = next;
    }
    // a kept method pulls in its class, and a kept class pulls in its members
    for (const s of graph.symbols) if (s.parentId && keep.has(s.id)) keep.add(s.parentId);
    for (const s of graph.symbols) if (s.parentId && keep.has(s.parentId)) keep.add(s.id);
  }

  let symbols = graph.symbols.filter((s) => keep.has(s.id));
  if (!display.showTypes) symbols = symbols.filter((s) => !["interface", "type", "enum"].includes(s.kind));
  if (!display.showExternals) symbols = symbols.filter((s) => s.kind !== "external");

  let ids = new Set(symbols.map((s) => s.id));
  let edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  if (!display.showOrphans) {
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.from);
      linked.add(e.to);
    }
    symbols = symbols.filter((s) => linked.has(s.id));
    ids = new Set(symbols.map((s) => s.id));
    edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }
  return { symbols, edges };
}
