import type { CodeEdge, SymbolKind, Visibility } from "../types";

export function degreeMap(edges: CodeEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    m.set(e.from, (m.get(e.from) ?? 0) + 1);
    m.set(e.to, (m.get(e.to) ?? 0) + 1);
  }
  return m;
}

export function neighborMap(edges: CodeEdge[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    const list = m.get(a);
    if (list) list.push(b);
    else m.set(a, [b]);
  };
  for (const e of edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return m;
}

// Obsidian-style: more connections, bigger dot.
export function dotRadius(degree: number, nodeSize: number): number {
  const base = 5 + nodeSize * 7;
  return base + Math.sqrt(degree) * (1.5 + nodeSize * 2.5);
}

export const visMark: Record<Visibility, string> = {
  public: "+",
  private: "-",
  protected: "#",
};

export const isCallable = (k: SymbolKind) => k === "function" || k === "method";

export const kindColor: Record<SymbolKind, string> = {
  function: "#b4b4b4",
  method: "#9a9a9a",
  class: "#b9a9e8",
  interface: "#8fb3c9",
  type: "#8fb3c9",
  enum: "#8fb3c9",
  external: "#5c5c5c",
};

// ids are `${file}#${qualifiedName}`; only the first # separates them (#private members).
export const qualified = (id: string) => {
  const i = id.indexOf("#");
  return i >= 0 ? id.slice(i + 1) : id;
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
