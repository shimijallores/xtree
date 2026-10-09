import type { CodeEdge, CodeSymbol } from "../types";
import { isCallable, qualified } from "./util";

const ENTRY_NAMES = ["main", "index", "start", "run", "bootstrap"];

const lastSegment = (id: string) => {
  const q = qualified(id);
  const parts = q.split(".");
  return (parts[parts.length - 1] ?? q).toLowerCase();
};

export function pickCenter(symbols: CodeSymbol[], entry: string): string | null {
  if (!symbols.length) return null;
  const inEntry = symbols.filter((s) => s.file === entry);
  const pool = inEntry.length ? inEntry : symbols;
  const callables = pool.filter((s) => isCallable(s.kind));
  for (const name of ENTRY_NAMES) {
    const hit = callables.find((s) => lastSegment(s.id) === name);
    if (hit) return hit.id;
  }
  const exported = callables.find((s) => s.visibility === undefined || s.visibility === "public");
  if (exported) return exported.id;
  if (callables[0]) return callables[0].id;
  return pool[0]?.id ?? symbols[0].id;
}

export interface LayoutOptions {
  ring: number; // px between depth rings
  spread: number; // 0..1, extra angular gap between sibling wedges
  compact: number; // 0..1, pulls the whole layout (and the outer ring) inward
  radiusOf: (id: string) => number; // dot radius in px
}

export interface RadialLayout {
  centerId: string | null;
  depth: Map<string, number>; // depth inside the node's own tree (0 = a root)
  pos: Map<string, { x: number; y: number }>; // dot centres
  treeEdges: Set<string>; // edge ids that form the spanning trees
}

interface TNode {
  id: string;
  children: TNode[];
  depth: number;
  weight: number;
  angle: number;
}

/**
 * Deterministic radial tree layout.
 *
 * A spanning tree is grown by BFS from the root; outgoing calls claim a node before
 * incoming ones, so the tree reads "caller -> callee" outward from the middle. Each
 * node owns an angular wedge proportional to its subtree's leaf weight, so tree edges
 * never cross. Ring radii grow when a ring would be too crowded for its dots + labels.
 */
export function buildRadialLayout(
  symbols: CodeSymbol[],
  edges: CodeEdge[],
  entry: string,
  opts: LayoutOptions,
): RadialLayout {
  const centerId = pickCenter(symbols, entry);
  const ids = new Set(symbols.map((s) => s.id));
  const name = (id: string) => qualified(id);
  const byName = (a: string, b: string) => name(a).localeCompare(name(b)) || a.localeCompare(b);

  const out = new Map<string, { to: string; edge: string }[]>();
  const inc = new Map<string, { to: string; edge: string }[]>();
  const push = (m: typeof out, k: string, v: { to: string; edge: string }) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    push(out, e.from, { to: e.to, edge: e.id });
    push(inc, e.to, { to: e.from, edge: e.id });
  }
  const sortAdj = (m: typeof out) => {
    for (const l of m.values()) l.sort((a, b) => byName(a.to, b.to));
  };
  sortAdj(out);
  sortAdj(inc);

  const depth = new Map<string, number>();
  const treeEdges = new Set<string>();
  const pad = opts.spread * 0.8; // wedge units of gap between neighbouring siblings

  const grow = (rootId: string): TNode => {
    const root: TNode = { id: rootId, children: [], depth: 0, weight: 1, angle: 0 };
    depth.set(rootId, 0);
    let frontier = [root];
    while (frontier.length) {
      const next: TNode[] = [];
      const claim = (p: TNode, to: string, edge: string) => {
        if (depth.has(to)) return;
        const c: TNode = { id: to, children: [], depth: p.depth + 1, weight: 1, angle: 0 };
        depth.set(to, c.depth);
        treeEdges.add(edge);
        p.children.push(c);
        next.push(c);
      };
      // Whole frontier claims via outgoing calls first, then via incoming ones.
      for (const p of frontier) for (const a of out.get(p.id) ?? []) claim(p, a.to, a.edge);
      for (const p of frontier) for (const a of inc.get(p.id) ?? []) claim(p, a.to, a.edge);
      frontier = next;
    }
    const weigh = (n: TNode): number => {
      if (!n.children.length) return (n.weight = 1);
      let w = 0;
      for (const c of n.children) w += weigh(c);
      n.children.sort((a, b) => b.weight - a.weight || byName(a.id, b.id));
      return (n.weight = w + pad * (n.children.length - 1));
    };
    weigh(root);
    return root;
  };

  // Assign angles: children split the parent's wedge by weight, with gaps between.
  const assign = (n: TNode, a0: number, a1: number) => {
    n.angle = (a0 + a1) / 2;
    if (!n.children.length) return;
    const total = n.weight;
    const unit = (a1 - a0) / total;
    let a = a0;
    for (const c of n.children) {
      const w = c.weight * unit;
      assign(c, a, a + w);
      a += w + pad * unit;
    }
  };

  // Ring radii: at least `ring` apart, and wide enough that the tightest pair of
  // neighbours on that ring (smallest wedge) still has room for dot + label.
  const placeTree = (root: TNode, pos: Map<string, { x: number; y: number }>) => {
    // Root's children wrap the full circle; the gap after the last child closes it.
    const full = Math.PI * 2;
    if (root.children.length) {
      const total = root.weight + pad;
      const unit = full / total;
      let a = -Math.PI / 2;
      for (const c of root.children) {
        const w = c.weight * unit;
        assign(c, a, a + w);
        a += w + pad * unit;
      }
    }
    const minWedge = new Map<number, number>();
    const maxR = new Map<number, number>();
    const all: TNode[] = [];
    const walk = (n: TNode, wedge: number) => {
      all.push(n);
      const d = n.depth;
      minWedge.set(d, Math.min(minWedge.get(d) ?? Infinity, wedge));
      maxR.set(d, Math.max(maxR.get(d) ?? 0, opts.radiusOf(n.id)));
      const total = n === root ? n.weight + pad : n.weight;
      const unit = n.children.length ? wedge / total : 0;
      for (const c of n.children) walk(c, c.weight * unit);
    };
    walk(root, full);
    const radius = [0];
    const maxDepth = Math.max(...all.map((n) => n.depth));
    for (let d = 1; d <= maxDepth; d++) {
      const r = maxR.get(d) ?? 8;
      const need = (r * 2 + 34 + opts.spread * 30) / Math.max(minWedge.get(d) ?? full, 1e-3);
      const gap = Math.max(opts.ring, (maxR.get(d - 1) ?? 0) + r + 40);
      radius[d] = Math.max(radius[d - 1] + gap, need);
    }
    for (const n of all) {
      const r = radius[n.depth];
      pos.set(n.id, { x: Math.cos(n.angle) * r, y: Math.sin(n.angle) * r });
    }
    return radius[maxDepth] + (maxR.get(maxDepth) ?? 8) + 40; // footprint radius incl. labels
  };

  const pos = new Map<string, { x: number; y: number }>();
  let mainR = 0;
  if (centerId) mainR = placeTree(grow(centerId), pos);

  // Disconnected components: each becomes its own small radial tree, rooted at its
  // busiest node, and the trees sit side by side on one ring outside the main tree.
  const rest = symbols.map((s) => s.id).filter((id) => !depth.has(id));
  const degree = (id: string) => (out.get(id)?.length ?? 0) + (inc.get(id)?.length ?? 0);
  rest.sort((a, b) => degree(b) - degree(a) || byName(a, b));
  const comps: { pos: Map<string, { x: number; y: number }>; r: number }[] = [];
  for (const id of rest) {
    if (depth.has(id)) continue;
    const local = new Map<string, { x: number; y: number }>();
    const r = Math.max(placeTree(grow(id), local), opts.radiusOf(id) + 46);
    comps.push({ pos: local, r });
  }
  if (comps.length) {
    // Center force tightens the gap between the main tree and the outer ring.
    const gap = 40 + (1 - opts.compact) * 120;
    const circumference = comps.reduce((s, c) => s + c.r * 2 + 12, 0);
    const maxC = Math.max(...comps.map((c) => c.r));
    const R = Math.max(mainR + gap + maxC, circumference / (Math.PI * 2));
    let a = -Math.PI / 2;
    for (const c of comps) {
      const half = (c.r + 6) / R; // angle for half the component's chord (approx)
      a += half;
      const cx = Math.cos(a) * R;
      const cy = Math.sin(a) * R;
      for (const [k, p] of c.pos) pos.set(k, { x: p.x + cx, y: p.y + cy });
      a += half;
    }
  }

  // Overall compaction (center force): 0 -> roomy, 1 -> tight. Never squeeze below
  // the spacing guaranteed above by more than ~20%, so dots still don't collide.
  const scale = 1.1 - opts.compact * 0.3;
  for (const p of pos.values()) {
    p.x *= scale;
    p.y *= scale;
  }

  return { centerId, depth, pos, treeEdges };
}
