import { useMemo } from "react";
import { useStore, visibleGraph } from "./store";

export function useVisible() {
  const graph = useStore((s) => s.graph);
  const entry = useStore((s) => s.entry);
  const display = useStore((s) => s.display);
  return useMemo(() => visibleGraph(graph, entry, display), [graph, entry, display]);
}
