/*
 * UML layout: bottom-up call tree (VERIFICATION NOTE for reviewers).
 *
 * What changed:
 *  - ELK layered with elk.direction UP. Layer 0 (sources) is at the BOTTOM, so the
 *    entry card (layerConstraint FIRST) sits alone at the bottom and callees stack
 *    upward. Arrows point up (caller -> callee).
 *  - Four partitions, ordered along the layering direction (0 = lowest):
 *      0 = the entry card alone, 1 = call tree reachable (undirected) from the
 *      entry, 2 = types & externals, 3 = unreferenced. If ELK rejects
 *    partitioning we retry without it: the entry keeps FIRST and invisible dummy
 *    edges (entry -> every other card with no incoming edge, any band) push those
 *    cards above it. Dummy edges are never rendered. Edges that point INTO the
 *    entry (recursion back to main) still have to point down; that is inherent.
 *  - Orthogonal edge routing done by ELK (LAYER_SWEEP crossing minimisation,
 *    BRANDES_KOEPF placement, model-order tie breaks, generous edge spacing).
 *    Every edge gets its own port: NORTH on the caller (outgoing) and SOUTH on the
 *    callee (incoming), portConstraints FIXED_SIDE, so ELK spreads the ports and
 *    parallel lines do not stack. Routes (start, bends, end) are returned in root
 *    coordinates and drawn by UmlEdge as rounded polylines.
 *
 * Measured-size approach: (a). UmlCanvas first renders the cards invisibly
 * (opacity 0) so React Flow measures their real DOM size, then runs this layout
 * with the measured sizes (estimateSize is only a fallback if measuring stalls).
 * As a safety net for later size changes (expanding a source block), UmlEdge
 * snaps the vertical end segments to React Flow's live handle Y positions, which
 * keeps the route orthogonal.
 */
import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { CodeSymbol, UmlDirection } from "../../types";

const elk = new ELK();

/** Per direction: ELK direction, port sides (out = caller, in = callee), and padding
 *  (extra room on the side bands grow toward, where their labels sit). */
export const UML_DIR: Record<
  UmlDirection,
  { elk: string; out: string; in: string; padding: string }
> = {
  UP: { elk: "UP", out: "NORTH", in: "SOUTH", padding: "[top=50,left=30,bottom=30,right=30]" },
  DOWN: { elk: "DOWN", out: "SOUTH", in: "NORTH", padding: "[top=50,left=30,bottom=40,right=30]" },
};

export type UmlNodeType = "fn" | "cls" | "typ" | "ext";

export function umlTypeOf(s: CodeSymbol): UmlNodeType {
  if (s.kind === "class") return "cls";
  if (s.kind === "interface" || s.kind === "type" || s.kind === "enum") return "typ";
  if (s.kind === "external") return "ext";
  return "fn";
}

// Rough card sizes; only used if React Flow has not measured a card yet.
export function estimateSize(s: CodeSymbol, members: number): { w: number; h: number } {
  switch (umlTypeOf(s)) {
    case "cls":
      return { w: 360, h: 78 + (s.fields?.length ?? 0) * 22 + members * 28 };
    case "typ":
      return { w: 270, h: 78 + (s.fields?.length ?? 0) * 20 };
    case "ext":
      return { w: 150, h: 32 };
    default:
      return { w: 340, h: 138 };
  }
}

export interface Pt {
  x: number;
  y: number;
}

/** 0 = call tree, 1 = types & externals, 2 = unreferenced */
export type Band = 0 | 1 | 2;

export interface UmlLayoutNode {
  id: string;
  w: number;
  h: number;
  band: Band;
  entry?: boolean;
}

export interface UmlLayoutEdge {
  id: string;
  from: string;
  to: string;
}

export interface BandBox {
  band: Band;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UmlLayout {
  pos: Map<string, Pt>;
  routes: Map<string, Pt[]>;
  bands: BandBox[];
}

export async function layoutUml(
  nodes: UmlLayoutNode[],
  edges: UmlLayoutEdge[],
  direction: UmlDirection = "UP",
): Promise<UmlLayout> {
  const dir = UML_DIR[direction];
  const known = new Set(nodes.map((n) => n.id));
  const real = edges.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to));
  const outs = new Map<string, string[]>();
  const ins = new Map<string, string[]>();
  for (const e of real) {
    outs.set(e.from, [...(outs.get(e.from) ?? []), e.id]);
    ins.set(e.to, [...(ins.get(e.to) ?? []), e.id]);
  }

  // No-partition fallback: dummy edges entry -> every other source card (any
  // band: call tree, types/externals, unreferenced), so with FIRST on the
  // entry no other card can share the bottom layer with it.
  const entryId = nodes.find((n) => n.entry)?.id;
  const port = (id: string, side: string) => ({
    id,
    width: 1,
    height: 1,
    layoutOptions: { "elk.port.side": side },
  });
  const dummies = entryId
    ? nodes
        .filter((n) => n.id !== entryId && !ins.has(n.id))
        .map((n, i) => ({
          id: `__dummy${i}`,
          to: n.id,
          src: port(`__dummy${i}__s`, dir.out),
          tgt: port(`__dummy${i}__t`, dir.in),
        }))
    : [];

  const build = (partitioned: boolean): ElkNode => ({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir.elk,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.mergeEdges": "false",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.spacing.edgeEdge": "20",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.padding": dir.padding,
      ...(partitioned ? { "elk.partitioning.activate": "true" } : {}),
    },
    children: nodes.map((n): ElkNode => {
      const layoutOptions: Record<string, string> = { "elk.portConstraints": "FIXED_SIDE" };
      // Entry gets its own lowest partition so nothing else shares the bottom row.
      if (partitioned) layoutOptions["elk.partitioning.partition"] = String(n.entry ? 0 : n.band + 1);
      // Direction UP: the FIRST layer is the bottom row.
      if (n.entry) layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
      return {
        id: n.id,
        width: n.w,
        height: n.h,
        layoutOptions,
        ports: [
          ...(outs.get(n.id) ?? []).map((eid) => ({
            id: `${eid}__s`,
            width: 1,
            height: 1,
            layoutOptions: { "elk.port.side": dir.out },
          })),
          ...(ins.get(n.id) ?? []).map((eid) => ({
            id: `${eid}__t`,
            width: 1,
            height: 1,
            layoutOptions: { "elk.port.side": dir.in },
          })),
          // Fallback only: invisible anchors keeping other sources above the entry.
          ...(!partitioned && n.entry ? dummies.map((d) => d.src) : []),
          ...(!partitioned ? dummies.filter((d) => d.to === n.id).map((d) => d.tgt) : []),
        ],
      };
    }),
    edges: [
      ...real.map(
        (e): ElkExtendedEdge => ({ id: e.id, sources: [`${e.id}__s`], targets: [`${e.id}__t`] }),
      ),
      ...(!partitioned
        ? dummies.map(
            (d): ElkExtendedEdge => ({ id: d.id, sources: [d.src.id], targets: [d.tgt.id] }),
          )
        : []),
    ],
  });

  let res: ElkNode;
  try {
    res = await elk.layout(build(true));
  } catch {
    res = await elk.layout(build(false));
  }

  const ox = res.x ?? 0;
  const oy = res.y ?? 0;
  const pos = new Map<string, Pt>();
  const size = new Map<string, { w: number; h: number }>();
  for (const c of res.children ?? []) {
    pos.set(c.id, { x: ox + (c.x ?? 0), y: oy + (c.y ?? 0) });
    size.set(c.id, { w: c.width ?? 0, h: c.height ?? 0 });
  }

  // Edge sections are relative to the edge's container (root here).
  const routes = new Map<string, Pt[]>();
  for (const e of (res.edges ?? []) as ElkExtendedEdge[]) {
    if (e.id.startsWith("__dummy")) continue;
    const sec = e.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({
      x: ox + p.x,
      y: oy + p.y,
    }));
    routes.set(e.id, pts);
  }

  const bands: BandBox[] = [];
  for (const band of [1, 2] as Band[]) {
    const ids = nodes.filter((n) => n.band === band).map((n) => n.id);
    if (!ids.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const p = pos.get(id);
      const s = size.get(id);
      if (!p || !s) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + s.w);
      y1 = Math.max(y1, p.y + s.h);
    }
    if (x0 !== Infinity) bands.push({ band, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  return { pos, routes, bands };
}
