import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { useVisible } from "../../hooks";
import { pickCenter } from "../../lib/graphModel";
import { useStore } from "../../store";
import { MarkerDefs } from "../MarkerDefs";
import { type Band, estimateSize, layoutUml, type Pt, umlTypeOf } from "./layout";
import { UmlEdge, type UmlEdgeData, type UmlEdgeMember } from "./UmlEdge";
import {
  type BandLabelData,
  BandLabelNode,
  ClassNode,
  ExternalNode,
  FunctionNode,
  TypeNode,
  type UmlData,
} from "./UmlNodes";

const nodeTypes = {
  fn: FunctionNode,
  cls: ClassNode,
  typ: TypeNode,
  ext: ExternalNode,
  band: BandLabelNode,
};
const edgeTypes = { uml: UmlEdge };

const LARGE_GRAPH = 150;
// If React Flow has not measured every card by then, lay out with estimates.
const MEASURE_TIMEOUT = 700;

const BAND_LABEL: Record<number, string> = { 1: "Types & externals", 2: "Unreferenced" };

interface CardEdge {
  id: string;
  source: string;
  target: string;
  data: UmlEdgeData;
}

function Inner() {
  const { symbols, edges } = useVisible();
  const entryFile = useStore((s) => s.entry);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const direction = useStore((s) => s.umlDirection);
  const selectedId = useStore((s) => s.selectedId);
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [routes, setRoutes] = useState<Map<string, Pt[]>>(new Map());
  const [ready, setReady] = useState(false);

  // Methods live inside their class box, so only top-level symbols become nodes.
  const { top, membersOf, nodeFor } = useMemo(() => {
    const members = new Map<string, typeof symbols>();
    const parent = new Map<string, string | undefined>();
    for (const s of symbols) {
      parent.set(s.id, s.parentId);
      if (s.parentId) members.set(s.parentId, [...(members.get(s.parentId) ?? []), s]);
    }
    const top = symbols.filter((s) => !s.parentId);
    const nodeFor = (id: string) => parent.get(id) ?? id;
    return { top, membersOf: members, nodeFor };
  }, [symbols]);

  const entryCard = useMemo(() => {
    const c = pickCenter(symbols, entryFile);
    return c ? nodeFor(c) : null;
  }, [symbols, entryFile, nodeFor]);

  // Card-level edges: method endpoints collapse onto their class card, and
  // identical card->card edges of the same kind merge into one routed path.
  // Self-edges (recursion, calls within one class) are omitted.
  const cardEdges = useMemo<CardEdge[]>(() => {
    const byKey = new Map<string, CardEdge>();
    for (const e of edges) {
      if (e.kind === "contains") continue;
      const source = nodeFor(e.from);
      const target = nodeFor(e.to);
      if (source === target) continue;
      const k = `${source}>${target}>${e.kind}`;
      const member: UmlEdgeMember = { fromId: e.from, toId: e.to, order: e.order };
      const hit = byKey.get(k);
      if (hit) hit.data.members.push(member);
      else byKey.set(k, { id: e.id, source, target, data: { kind: e.kind, members: [member] } });
    }
    return [...byKey.values()];
  }, [edges, nodeFor]);

  // Bands: 0 = call tree reachable (undirected) from the entry through fn/class
  // cards, 1 = types & externals, 2 = everything else.
  const bandOf = useMemo(() => {
    const isType = (s: (typeof top)[number]) => {
      const t = umlTypeOf(s);
      return t === "typ" || t === "ext";
    };
    const typeIds = new Set(top.filter(isType).map((s) => s.id));
    const adj = new Map<string, string[]>();
    for (const e of cardEdges) {
      if (typeIds.has(e.source) || typeIds.has(e.target)) continue;
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
      adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
    }
    const seen = new Set<string>();
    if (entryCard && !typeIds.has(entryCard)) {
      const stack = [entryCard];
      seen.add(entryCard);
      while (stack.length) {
        const id = stack.pop()!;
        for (const n of adj.get(id) ?? []) {
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    const out = new Map<string, Band>();
    for (const s of top) out.set(s.id, typeIds.has(s.id) ? 1 : seen.has(s.id) ? 0 : 2);
    return out;
  }, [top, cardEdges, entryCard]);

  const key = useMemo(
    () =>
      direction + ":" + (entryCard ?? "") + "@" + top.map((s) => s.id).join("|") + "#" + cardEdges.map((e) => e.id).join(","),
    [top, cardEdges, entryCard, direction],
  );

  // Phase 1: render cards invisibly so React Flow measures their real size.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    setReady(false);
    setRoutes(new Map());
    pending.current = key;
    // Keep earlier measurements: React Flow only reports a size when it changes.
    setNodes((prev) => {
      const prevMeasured = new Map(prev.map((n) => [n.id, n.measured]));
      return top.map((s, i) => {
        const data: UmlData = {
          symbol: s,
          members: membersOf.get(s.id) ?? [],
          entry: s.id === entryCard,
        };
        return {
          id: s.id,
          type: umlTypeOf(s),
          position: { x: (i % 8) * 400, y: Math.floor(i / 8) * 400 },
          data,
          draggable: false,
          className: "uml-pending",
          measured: prevMeasured.get(s.id),
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Phase 2: once every card is measured (or after a timeout), run ELK with the
  // measured sizes and reveal the result.
  // Only the phase-1 nodes of the current key count (they all carry uml-pending).
  const allMeasured =
    nodes.length === top.length &&
    nodes.length > 0 &&
    nodes.every((n) => n.className === "uml-pending" && !!n.measured?.width && !!n.measured?.height);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  useEffect(() => {
    const k = key;
    const t = window.setTimeout(() => setTimedOut(k), MEASURE_TIMEOUT);
    return () => window.clearTimeout(t);
  }, [key]);

  // Content-only edits (graph.diff "changed") refresh card data in place, keeping positions.
  const contentKey = useMemo(() => symbols.map((s) => `${s.id}:${s.hash}:${s.signature}`).join("|"), [symbols]);
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const s = top.find((x) => x.id === n.id);
        if (!s) return n;
        const data: UmlData = { symbol: s, members: membersOf.get(s.id) ?? [], entry: s.id === entryCard };
        return { ...n, data };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  useEffect(() => {
    if (pending.current !== key) return;
    if (!allMeasured && timedOut !== key && top.length > 0) return;
    pending.current = null;
    let live = true;
    const measured = new Map(nodes.map((n) => [n.id, n.measured]));
    layoutUml(
      top.map((s) => {
        const m = measured.get(s.id);
        const est = estimateSize(s, membersOf.get(s.id)?.length ?? 0);
        return {
          id: s.id,
          w: m?.width || est.w,
          h: m?.height || est.h,
          band: bandOf.get(s.id) ?? 2,
          entry: s.id === entryCard,
        };
      }),
      cardEdges.map((e) => ({ id: e.id, from: e.source, to: e.target })),
      direction,
    )
      .then(({ pos, routes: r, bands }) => {
        if (!live) return;
        setRoutes(r);
        setNodes((ns) => [
          ...ns
            .filter((n) => n.type !== "band")
            .map((n) => ({ ...n, position: pos.get(n.id) ?? n.position, className: undefined })),
          ...bands.map(
            (b): Node => ({
              id: `__band-${b.band}`,
              type: "band",
              position: { x: b.x, y: b.y - 30 },
              data: { label: BAND_LABEL[b.band] } satisfies BandLabelData,
              draggable: false,
              selectable: false,
              focusable: false,
              connectable: false,
              style: { pointerEvents: "none" },
              zIndex: -1,
            }),
          ),
        ]);
        setReady(true);
        window.setTimeout(() => {
          // Keep the selected card centered across relayouts; otherwise fit all.
          const sel = selectedId ? nodeFor(selectedId) : null;
          const p = sel ? pos.get(sel) : undefined;
          const m = sel ? measured.get(sel) : undefined;
          if (sel && p) {
            rf.setCenter(p.x + (m?.width ?? 320) / 2, p.y + (m?.height ?? 120) / 2, {
              zoom: Math.max(rf.getZoom(), 0.9),
              duration: 400,
            });
          } else rf.fitView({ padding: 0.15, duration: 400 });
        }, 150);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, allMeasured, timedOut]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      ready
        ? cardEdges.map((e) => ({
            id: e.id,
            type: "uml",
            source: e.source,
            target: e.target,
            data: { ...e.data, route: routes.get(e.id) },
            selectable: false,
            focusable: false,
          }))
        : [],
    [ready, cardEdges, routes],
  );

  // Pan to a requested node (also resolves a method to its class box).
  useEffect(() => {
    if (!focus || !ready) return;
    const id = nodeFor(focus.id);
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const w = n.measured?.width ?? 320;
    const h = n.measured?.height ?? 120;
    rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
      zoom: Math.max(rf.getZoom(), 0.9),
      duration: 600,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, ready]);

  return (
    <motion.div
      className="canvas uml-canvas"
      initial={false}
      animate={{ opacity: ready ? 1 : 0 }}
      transition={{ duration: ready ? 0.2 : 0.1 }}
    >
      <MarkerDefs />
      {symbols.length > LARGE_GRAPH && (
        <div className="banner-warn">
          Large graph ({symbols.length} symbols): method bodies are collapsed by default.
        </div>
      )}
      <ReactFlow
        colorMode="dark"
        nodes={nodes}
        edges={rfEdges}
        onNodesChange={(changes) =>
          setNodes((ns) => {
            // Cards are fixed in place; only track measured sizes.
            let next = ns;
            for (const c of changes) {
              if (c.type === "dimensions" && c.dimensions) {
                next = next.map((n) => (n.id === c.id ? { ...n, measured: c.dimensions } : n));
              }
            }
            return next;
          })
        }
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => n.type !== "band" && select(n.id)}
        onPaneClick={() => select(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.15 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2e2e2e" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          style={{ marginBottom: 90 }}
          maskColor="rgba(20,20,20,0.7)"
          nodeColor="#4a4f57"
        />
      </ReactFlow>
    </motion.div>
  );
}

export function UmlCanvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}
