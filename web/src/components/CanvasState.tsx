import { useStore } from "../store";

/** Loading / empty / error overlays for the canvas, plus parse-error warnings (spec §13). */
export function CanvasState() {
  const mode = useStore((s) => s.mode);
  const loading = useStore((s) => s.graphLoading);
  const error = useStore((s) => s.graphError);
  const entry = useStore((s) => s.entry);
  const count = useStore((s) => s.graph.symbols.length);
  const errors = useStore((s) => s.graph.errors);
  const fileCount = useStore((s) => s.fileCount);

  if (mode === "loading") {
    return (
      <div className="canvas-state" role="status">
        Connecting to XTree…
      </div>
    );
  }

  let center: React.ReactNode = null;
  if (error) {
    center = (
      <div className="canvas-state is-error" role="alert">
        <strong>Could not analyze {entry}</strong>
        <span>{error}</span>
      </div>
    );
  } else if (loading && count === 0) {
    center = (
      <div className="canvas-state" role="status">
        Analyzing {entry}…
      </div>
    );
  } else if (mode === "live" && !entry) {
    center = (
      <div className="canvas-state">
        {fileCount === 0 ? "No .js / .jsx / .ts / .tsx files found in this project." : "Pick a file on the left to set it as the entry."}
      </div>
    );
  } else if (mode === "live" && !loading && count === 0) {
    center = <div className="canvas-state">No functions, classes or types found in {entry}.</div>;
  }

  return (
    <>
      {center}
      {errors && errors.length > 0 && (
        <div className="banner-warn banner-parse" role="alert">
          {errors.map((e) => (
            <div key={e.file}>
              Parse error in <code>{e.file}</code>: {e.message}. Showing the last good version.
            </div>
          ))}
        </div>
      )}
    </>
  );
}
