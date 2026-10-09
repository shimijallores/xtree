import {
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import "@xyflow/react/dist/style.css";
import { useVisible } from "../../hooks";
import { buildRadialLayout, pickCenter } from "../../lib/graphModel";
import { degreeMap, kindColor, neighborMap, qualified } from "../../lib/util";
import { useStore } from "../../store";
import type { CodeEdge, CodeSymbol, DisplaySettings } from "../../types";
import { MarkerDefs } from "../MarkerDefs";
import { type DotData, DotEdge, type DotEdgeData, DotNode, nodeRadius } from "./DotNode";

const nodeTypes = { dot: DotNode };
const edgeTypes = { dot: DotEdge };

const RING = 170; // px between depth rings at the default link distance
const SLIDER_DEBOUNCE_MS = 120;
const TWEEN_MS = 400;

type Pt = { x: number; y: number };

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// cubic-bezier(0.22, 1, 0.36, 1): the "enter" curve, solved for y at time x.
function easeEnter(x: number) {
  const x1 = 0.22, y1 = 1, x2 = 0.36, y2 = 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 20; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < x) lo = t;
    else hi = t;
  }
  return by(t);
}

// Slider mapping (no physics anymore):
//  - Link distance -> ring spacing
//  - Repel force   -> angular gap between sibling wedges (spread)
//  - Center force  -> overall radial compaction, incl. how close the outer ring of
//                     disconnected nodes sits to the main tree
function computeLayout(symbols: CodeSymbol[], edges: CodeEdge[], entry: string, d: DisplaySettings) {
  const deg = degreeMap(edges);
  const centerId = pickCenter(symbols, entry);
  const radius = new Map<string, number>();
  for (const s of symbols) {
    radius.set(s.id, nodeRadius(deg.get(s.id) ?? 0, d.nodeSize, s.id === centerId));
  }
  const layout = buildRadialLayout(symbols, edges, entry, {
    ring: RING * (0.5 + d.linkDistance),
    spread: d.repelForce,
    compact: d.centerForce,
    radiusOf: (id) => radius.get(id) ?? 8,
  });
  return { layout, radius, deg };
}

function Inner() {
  const { symbols, edges } = useVisible();
  const entry = useStore((s) => s.entry);
  const display = useStore((s) => s.display);
  const animateNonce = useStore((s) => s.animateNonce);
  const focus = useStore((s) => s.focus);
  const select = useStore((s) => s.select);
  const openInUml = useStore((s) => s.openInUml);
  const setHover = useStore((s) => s.setHover);
  const rf = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const curRef = useRef<Map<string, Pt>>(new Map()); // dot centres as shown now
  const radiusRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef(0);
  const draggingRef = useRef<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef(display);
  displayRef.current = display;
  const inputRef = useRef({ symbols, edges, entry });
  inputRef.current = { symbols, edges, entry };

  const structureKey = useMemo(
    () =>
      entry + "@" + symbols.map((s) => s.id).join("|") + "#" + edges.map((e) => e.id).join(","),
    [symbols, edges, entry],
  );

  const writePositions = (ps: Map<string, Pt>) => {
    const dragging = draggingRef.current;
    const radius = radiusRef.current;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === dragging) return n;
        const p = ps.get(n.id);
        if (!p) return n;
        const r = radius.get(n.id) ?? 0;
        return { ...n, position: { x: p.x - r, y: p.y - r } };
      }),
    );
  };

  // Move every node from `from` to `target`. Transform-only (React Flow positions
  // nodes with translate), one React update per frame, skipped under reduced motion.
  const tweenTo = (target: Map<string, Pt>, from: Map<string, Pt>) => {
    cancelAnimationFrame(rafRef.current);
    if (prefersReducedMotion() || from.size === 0) {
      curRef.current = new Map(target);
      writePositions(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min((now - start) / TWEEN_MS, 1);
      const e = easeEnter(k);
      const ps = new Map<string, Pt>();
      for (const [id, t] of target) {
        const f = from.get(id) ?? { x: 0, y: 0 };
        ps.set(id, { x: f.x + (t.x - f.x) * e, y: f.y + (t.y - f.y) * e });
      }
      const dragging = draggingRef.current;
      if (dragging && curRef.current.has(dragging)) ps.set(dragging, curRef.current.get(dragging)!);
      curRef.current = ps;
      writePositions(ps);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // Rebuild nodes/edges when the visible graph or entry point changes.
  useEffect(() => {
    const d = displayRef.current;
    const { layout, radius, deg } = computeLayout(symbols, edges, entry, d);
    const nbrs = neighborMap(edges);
    radiusRef.current = radius;
    const first = curRef.current.size === 0;
    const from = new Map(curRef.current);

    const posOf = (id: string): Pt => {
      if (first) return layout.pos.get(id) ?? { x: 0, y: 0 };
      return from.get(id) ?? { x: 0, y: 0 }; // new nodes grow out of the middle
    };
    setNodes(
      symbols.map((s) => {
        const p = posOf(s.id);
        const r = radius.get(s.id) ?? 0;
        const data: DotData = {
          label: qualified(s.id),
          kind: s.kind,
          degree: deg.get(s.id) ?? 0,
          nbrs: nbrs.get(s.id) ?? [],
          isCenter: s.id === layout.centerId,
          depth: s.id === layout.centerId ? 0 : (layout.depth.get(s.id) ?? 99),
        };
        return {
          id: s.id,
          type: "dot",
          position: { x: p.x - r, y: p.y - r },
          data,
          zIndex: s.id === layout.centerId ? 2 : 1,
        };
      }),
    );
    setEdges(
      edges.map((e) => {
        const data: DotEdgeData = {
          kind: e.kind,
          sr: radius.get(e.from) ?? 0,
          tr: radius.get(e.to) ?? 0,
          tree: layout.treeEdges.has(e.id),
        };
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "dot",
          data,
          selectable: false,
          focusable: false,
          zIndex: data.tree ? 0 : -1,
        };
      }),
    );

    if (first) curRef.current = new Map(layout.pos);
    else {
      const start = new Map<string, Pt>();
      for (const s of symbols) start.set(s.id, posOf(s.id));
      tweenTo(layout.pos, start);
    }

    const t = window.setTimeout(() => rf.fitView({ padding: 0.25, duration: 400 }), 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // Sliders: re-run the deterministic layout once the slider rests, then tween.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      const { symbols: s, edges: e, entry: en } = inputRef.current;
      const { layout, radius } = computeLayout(s, e, en, display);
      radiusRef.current = radius;
      setEdges((es) =>
        es.map((x) => {
          const data = x.data as DotEdgeData;
          const sr = radius.get(x.source) ?? 0;
          const tr = radius.get(x.target) ?? 0;
          if (data.sr === sr && data.tr === tr) return x;
          return { ...x, data: { ...data, sr, tr } };
        }),
      );
      tweenTo(layout.pos, new Map(curRef.current));
    }, SLIDER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display.centerForce, display.repelForce, display.linkDistance, display.nodeSize]);

  // "Animate" button: re-run the layout and grow every node out from the centre.
  useEffect(() => {
    if (animateNonce === 0) return;
    const { symbols: s, edges: e, entry: en } = inputRef.current;
    const { layout } = computeLayout(s, e, en, displayRef.current);
    const from = new Map<string, Pt>();
    for (const id of layout.pos.keys()) from.set(id, { x: 0, y: 0 });
    tweenTo(layout.pos, prefersReducedMotion() ? new Map() : from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animateNonce]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Pan/zoom to a requested node (search, Explain flow, select card).
  useEffect(() => {
    if (!focus) return;
    const p = curRef.current.get(focus.id);
    if (!p) return;
    rf.setCenter(p.x, p.y, { zoom: Math.max(rf.getZoom(), 1.1), duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Dragging: React Flow moves only the held node, locked to the pointer.
  const onDragStart = (_: unknown, node: Node) => {
    draggingRef.current = node.id;
    wrapRef.current?.classList.add("is-dragging");
    setHover(null);
  };
  const onDragStop = (_: unknown, node: Node) => {
    const r = radiusRef.current.get(node.id) ?? 0;
    curRef.current.set(node.id, { x: node.position.x + r, y: node.position.y + r });
    draggingRef.current = null;
    wrapRef.current?.classList.remove("is-dragging");
  };

  return (
    <div className="canvas graph-canvas" ref={wrapRef}>
      <MarkerDefs />
      <ReactFlow
        colorMode="dark"
        nodes={nodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => select(n.id)}
        onNodeDoubleClick={(_, n) => openInUml(n.id)}
        onNodeMouseEnter={(_, n) => {
          if (!draggingRef.current) setHover(n.id);
        }}
        onNodeMouseLeave={() => {
          if (!draggingRef.current) setHover(null);
        }}
        onPaneClick={() => select(null)}
        onNodeDragStart={onDragStart}
        onNodeDragStop={onDragStop}
        zoomOnDoubleClick={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.15}
        maxZoom={3}
        onlyRenderVisibleElements
        fitView
        fitViewOptions={{ padding: 0.25 }}
      >
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ marginBottom: 90 }}
          maskColor="rgba(20,20,20,0.7)"
          nodeColor={(n) => kindColor[(n.data as DotData).kind] ?? "#999"}
        />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}
