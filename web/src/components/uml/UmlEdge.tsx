import { EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from "@xyflow/react";
import { memo } from "react";
import { useStore } from "../../store";
import type { EdgeKind } from "../../types";
import type { Pt } from "./layout";

export interface UmlEdgeMember {
  fromId: string;
  toId: string;
  order?: number;
}

export interface UmlEdgeData {
  kind: EdgeKind;
  /** Underlying symbol-level edges merged into this card-to-card path. */
  members: UmlEdgeMember[];
  /** Orthogonal route from ELK (root coordinates), if any. */
  route?: Pt[];
  [key: string]: unknown;
}

const RADIUS = 6;

// Polyline through the points with small rounded corners.
function roundedPath(pts: Pt[]): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y);
    const l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(RADIUS, l1 / 2, l2 / 2);
    if (r <= 0.5) {
      d += ` L ${c.x} ${c.y}`;
      continue;
    }
    const ax = c.x - ((c.x - p.x) / l1) * r;
    const ay = c.y - ((c.y - p.y) / l1) * r;
    const bx = c.x + ((n.x - c.x) / l2) * r;
    const by = c.y + ((n.y - c.y) / l2) * r;
    d += ` L ${ax} ${ay} Q ${c.x} ${c.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last.x} ${last.y}`;
}

function UmlEdgeImpl({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = data as UmlEdgeData;
  const selectedId = useStore((s) => s.selectedId);
  const flowTo = useStore((s) => s.highlightId);
  // Select stable values only. A selector that builds a new array on every call
  // makes React think the store changed each render, causing an infinite loop.
  const flowActive = useStore((s) => s.flowActive);
  const flowSteps = useStore((s) => s.flowSteps);
  const flowPrev = flowActive > 0 ? flowSteps.slice(0, flowActive).map((x) => x.symbolId) : [];

  let path: string;
  let start: Pt;
  if (d.route && d.route.length >= 2) {
    // Snap the vertical end segments to the live handle Y so routes stay attached
    // if a card's real height changes after layout (e.g. source expanded).
    const pts = d.route.map((p) => ({ ...p }));
    pts[0].y = sourceY;
    pts[pts.length - 1].y = targetY;
    path = roundedPath(pts);
    start = pts[0];
  } else {
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: RADIUS,
    });
    start = { x: sourceX, y: sourceY };
  }

  const inFlow =
    !!flowTo && d.members.some((m) => m.toId === flowTo && flowPrev.includes(m.fromId));
  const hot =
    inFlow ||
    (!!selectedId && d.members.some((m) => m.fromId === selectedId || m.toId === selectedId));

  const color = hot ? "#b9a9e8" : d.kind === "calls" ? "#9aa4ae" : "#7d8893";
  const dashed = d.kind === "uses-type" || d.kind === "implements";
  const suffix = hot ? "-hot" : "";
  const marker =
    d.kind === "calls"
      ? `url(#xt-uml-arrow${suffix})`
      : d.kind === "uses-type"
        ? `url(#xt-uml-open${suffix})`
        : `url(#xt-uml-tri${suffix})`;

  const orders = d.members
    .map((m) => m.order)
    .filter((o): o is number => o != null)
    .sort((a, b) => a - b);

  // Call-order badge sits just above the caller's port, like a sequence number.
  const lx = start.x + 14;
  const ly = start.y - 14;

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={hot ? 2 : 1.4}
        strokeDasharray={dashed ? "6 5" : undefined}
        markerEnd={marker}
      />
      {d.kind === "calls" && orders.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className={"call-order" + (hot ? " is-hot" : "") + (orders.length > 1 ? " is-multi" : "")}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            {orders.join(",")}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export const UmlEdge = memo(UmlEdgeImpl);
