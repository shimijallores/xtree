import { useStore } from "../store";

export function StatusBar() {
  const mode = useStore((s) => s.mode);
  const up = useStore((s) => s.ollamaUp);
  const reachable = useStore((s) => s.ollamaReachable);
  const model = useStore((s) => s.model);
  const connected = useStore((s) => s.connected);
  const setUp = useStore((s) => s.setOllamaUp);
  const project = useStore((s) => s.projectName);
  const done = useStore((s) => s.graph.symbols.filter((x) => x.kind !== "external" && s.summaryDone[x.id]).length);
  const total = useStore((s) =>
    s.mode === "mock"
      ? s.graph.symbols.filter((x) => x.summary).length
      : s.graph.symbols.filter((x) => x.kind !== "external").length,
  );
  const streaming = useStore((s) => s.streaming);

  const pct = total ? Math.round((done / total) * 100) : 0;
  const label = up ? "Ollama connected" : reachable ? "Model not installed" : "Ollama not running";

  return (
    <div className="status-bar" role="status" data-tour="status">
      <div className="status-left">
        <span className="brand">XTree</span>
        {project && (
          <span className="project" title="Project">
            {project}
          </span>
        )}
        <span className="chip" title="Model served by Ollama">
          {model}
        </span>
        {mode === "mock" ? (
          <button
            className={"conn " + (up ? "is-up" : "is-down")}
            onClick={() => setUp(!up)}
            title="Mock mode: click to preview the connected / not running states"
          >
            <span className="dot-status" />
            {label}
          </button>
        ) : (
          <span className={"conn " + (up ? "is-up" : "is-down")}>
            <span className="dot-status" />
            {label}
          </span>
        )}
        {!up && mode === "live" && (
          <span className="hint">
            {reachable ? "Run " : "Start Ollama, then run "}
            <code>ollama pull {model}</code> to enable summaries
          </span>
        )}
        {mode === "live" && !connected && <span className="hint">Reconnecting to XTree…</span>}
        {mode === "mock" && (
          <span className="muted">
            No XTree server found. Run <code>bun bin/xtree.js start examples/shop-app</code> and open localhost:4317
          </span>
        )}
      </div>

      <div className="status-mid" title="Symbols whose plain-English summary has finished generating">
        <span>
          summaries {done}/{total}
        </span>
        <span className="progress" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        {streaming && up && <span className="muted">generating…</span>}
      </div>

      <div className="status-right" />
    </div>
  );
}
