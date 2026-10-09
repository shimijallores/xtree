import {
  type EdgeProps,
  Handle,
  type NodeProps,
  Position,
  useStore as useFlowStore,
} from "@xyflow/react";
import { type CSSProperties, memo } from "react";
import { clamp, dotRadius, kindColor } from "../../lib/util";
import { useStore } from "../../store";
import type { EdgeKind, SymbolKind } from "../../types";

export interface DotData {
  label: string;
  kind: SymbolKind;
  degree: number;
  nbrs: string[];
  isCenter: boolean; // the entry point at the middle of the layout
  depth: number; // depth in its tree; depth 1 labels stay visible
  [key: string]: unknown;
}

// The entry point is drawn larger so it reads as the root of the tree.
export const CENTER_SCALE = 1.7;
export const nodeRadius = (degree: number, nodeSize: number, isCenter: boolean) =>
  dotRadius(degree, nodeSize) * (isCenter ? CENTER_SCALE : 1);

// A single 1px handle at the dot centre so edges run centre to centre.
export const centerHandle = {
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  opacity: 0,
  border: 0,
  pointerEvents: "none" as const,
};

function DotNodeImpl({ id, data }: NodeProps) {
  const d = data as DotData;
  const nodeSize = useStore((s) => s.display.nodeSize);
  const fade = useStore((s) => s.display.textFadeThreshold);
  // Boolean selectors so a dot re-renders only when its own state flips.
  const selected = useStore((s) => s.selectedId === id);
  const anySelected = useStore((s) => s.selectedId !== null);
  const near = useStore((s) => !!s.selectedId && d.nbrs.includes(s.selectedId));
  const isFlow = useStore((s) => s.highlightId === id);
  const query = useStore((s) => s.symbolQuery.trim().toLowerCase());
  const changedAt = useStore((s) => s.changed[id]);
  // Labels fade out when zoomed out past the threshold (Obsidian "Text fade threshold").
  // The zoom changes on every pan/zoom frame. Subscribing to it directly would
  // re-render every dot 60 times a second, so we only subscribe to the label
  // opacity rounded to 10 steps: dots re-render just when the fade visibly changes.
  const labelOpacity = useFlowStore((s) => {
    const zoom = s.transform[2];
    const cut = fade * 1.2;
    if (cut <= 0.01) return 1;
    const o = clamp((zoom - cut * 0.7) / Math.max(cut * 0.3, 0.01), 0, 1);
    return Math.round(o * 10) / 10;
  });

  const r = nodeRadius(d.degree, nodeSize, d.isCenter);
  const matches = !query || d.label.toLowerCase().includes(query);
  const dimmed = (!!query && !matches) || (anySelected && !selected && !near);
  const pinnedLabel = selected || d.isCenter || d.depth === 1;

  const cls = [
    "dot",
    d.isCenter && "is-center",
    selected && "is-selected",
    near && "is-near",
    isFlow && "is-flow",
    changedAt && "is-changed",
    dimmed && "is-dimmed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      style={{ width: r * 2, height: r * 2, "--kind-color": kindColor[d.kind] } as CSSProperties}
      title={d.label}
    >
      <Handle type="target" position={Position.Top} style={centerHandle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={centerHandle} isConnectable={false} />
      <div className="dot-circle" />
      {d.isCenter ? <span className="dot-entry-ring" /> : null}
      {changedAt ? <span className="dot-ring" /> : null}
      <div className="dot-label" style={{ opacity: pinnedLabel ? 1 : labelOpacity }}>
        {d.isCenter ? <span className="dot-entry-badge">entry</span> : null}
        {d.label}
      </div>
    </div>
  );
}
export const DotNode = memo(DotNodeImpl);

export interface DotEdgeData {
  kind: EdgeKind;
  sr: number; // source radius (px)
  tr: number; // target radius (px)
  tree: boolean; // part of the spanning tree (straight) vs a cross link (faint curve)
  [key: string]: unknown;
}

function DotEdgeImpl({ source, target, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const d = data as DotEdgeData;
  const thickness = useStore((s) => s.display.linkThickness);
  const arrows = useStore((s) => s.display.showArrows);
  // Boolean selectors: an edge re-renders only when its own hot/faded state flips.
  const hot = useStore((s) => {
    const a = s.hoverId ?? s.selectedId;
    return a === source || a === target;
  });
  const anyActive = useStore((s) => (s.hoverId ?? s.selectedId) !== null);

  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const faded = anyActive && !hot;

  if (!d.tree) {
    // Cross link: quadratic curve bowing away from the layout centre (0,0), so it
    // arcs around the tree instead of cutting through it.
    const mx = (sourceX + targetX) / 2;
    const my = (sourceY + targetY) / 2;
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * mx + ny * my < 0) {
      nx = -nx;
      ny = -ny;
    }
    const bend = Math.min(len * 0.35, 160);
    const cx = mx + nx * bend;
    const cy = my + ny * bend;
    // Trim the ends along the curve's tangents so they stop at the dot rims.
    const trim = (px: number, py: number, r: number) => {
      const tx = cx - px;
      const ty = cy - py;
      const tl = Math.hypot(tx, ty) || 1;
      return [px + (tx / tl) * r, py + (ty / tl) * r];
    };
    const [x1, y1] = trim(sourceX, sourceY, d.sr);
    const [x2, y2] = trim(targetX, targetY, d.tr + 1);
    return (
      <path
        d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
        fill="none"
        stroke={hot ? "#cfcfcf" : "#5a5a5a"}
        strokeOpacity={hot ? 0.9 : faded ? 0.05 : 0.18}
        strokeWidth={0.5 + thickness * 1.6}
        strokeDasharray={hot ? undefined : "4 4"}
        markerEnd={arrows && hot ? "url(#xt-arrow-hot)" : undefined}
      />
    );
  }

  const ux = dx / len;
  const uy = dy / len;
  const x1 = sourceX + ux * d.sr;
  const y1 = sourceY + uy * d.sr;
  const x2 = targetX - ux * (d.tr + 1);
  const y2 = targetY - uy * (d.tr + 1);

  return (
    <path
      d={`M ${x1} ${y1} L ${x2} ${y2}`}
      fill="none"
      stroke={hot ? "#cfcfcf" : "#5a5a5a"}
      strokeOpacity={faded ? 0.12 : hot ? 0.95 : 0.7}
      strokeWidth={0.6 + thickness * 2.4}
      markerEnd={arrows ? (hot ? "url(#xt-arrow-hot)" : "url(#xt-arrow)") : undefined}
    />
  );
}
export const DotEdge = memo(DotEdgeImpl);

