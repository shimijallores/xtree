# Bottom-up orthogonal UML call tree with fixed cards

The UML view now uses ELK layered with `elk.direction: UP`, so the entry card sits alone at the bottom and callees stack upward. Every card-to-card edge gets its own port: NORTH on the caller, SOUTH on the callee, with `portConstraints: FIXED_SIDE`. ELK does the orthogonal routing (LAYER_SWEEP, BRANDES_KOEPF, NODES_AND_EDGES model order, 20/24 px edge spacing), and its sections are drawn as rounded polylines. Cards are first rendered invisibly so React Flow can measure them, and the layout then runs on those real sizes. Dragging is off everywhere. Watch for: cards whose size changes after layout (source expand) can overlap their neighbours, and the snapped end segment can then fold back on itself (likely, edge case). Recursion and calls within a single class are no longer drawn (confirmed).

**Verdict**: APPROVED

## High-level view

Layout is now a proper bottom-up tree. Partitions run in the layering direction: 0 is the entry alone, 1 is the call tree, 2 is types and externals, 3 is unreferenced. The entry also carries `layerConstraint FIRST`. With direction UP, FIRST is the bottom row, so the entry stays at the bottom whether or not partitioning succeeds. If ELK throws, the fallback adds invisible dummy edges from the entry to every source card, so nothing shares its row and all arrows still point up. Dummy edges are skipped when routes are extracted.

The way edges are built rules out stacking. Symbol-level edges collapse onto cards and merge per (source, target, kind). Each merged edge has its own port pair, so parallel lines get spread out instead of sharing one handle. The route coordinates add the root offset. `getSmoothStepPath` is used only when an edge has no route.

The measure-then-layout pass uses approach (a), with estimateSize kept as a 700 ms timeout fallback. On top of that, UmlEdge snaps the first and last points' Y to the live handle positions. Highlighting, flow, and call-order badges now read a `members` array, so a merged edge lights up if any member matches, and its badge shows every order number joined.

## Issues

1. **Post-layout resize overlap** (likely, non-blocking): expanding a source block grows a card downward without a relayout. Because cards can no longer be dragged, the overlap stays. The snapped target Y can also land below the last bend, which makes the final segment double back. Consider re-running layout when a measured size changes by more than a threshold.
2. **Self-edges dropped** (confirmed, non-blocking): recursion and calls inside one class no longer render (`if (source === target) continue`). Consider a small self-loop glyph or a badge so this information isn't silently lost.
3. **Partition back-edges** (possible): edges that run against partition order (call-tree card → entry, unreferenced → type) depend on ELK accepting them. If ELK rejects them, the no-partition fallback takes over, which is acceptable. Worth checking with a recursive-main fixture.

<details><summary>Details</summary>

### Port distribution and route rendering

Ports are named `${edgeId}__s` / `${edgeId}__t`, so no two edges share an anchor. With FIXED_SIDE, ELK can reorder ports along each side to reduce crossings. `roundedPath` caps the corner radius at half of each segment, so short jogs don't overshoot. The badge now sits 14 px above the source port rather than partway along a bezier, which reads well on vertical routes.

### Measurement gating

Phase 1 tags every node `uml-pending` (opacity 0) and keeps any earlier `measured` values, because React Flow only reports changes. Phase 2 starts only when every pending node has a width and height, or when the per-key timeout fires. After that, `className` is cleared, so `allMeasured` can't trigger a second run. The key now also covers the entry and the edge ids. Expanding or collapsing a card doesn't change the key, so it doesn't trigger a relayout. That is the cause of Issue 1.

### Interaction and motion

`nodesDraggable={false}`, per-node `draggable:false`, and the removed position branch together lock the cards. Dimension tracking, click-to-select (band labels excluded), and pane deselect all remain. `nodrag` stays on the member buttons. The CSS transitions animate opacity only, include a reduced-motion override, and set `cursor: default` on cards. Focus centering, fitView, and the large-graph banner code are unchanged.

### Scope

Only five files under `web/src/components/uml` and `styles.css` changed, plus the untracked `.agents` folder. Nothing is staged, and fixtures, store, backend, and package.json are untouched.

</details>

<details><summary>File map</summary>

- `uml/layout.ts`: ELK UP plus orthogonal routing, per-edge ports, partitions and dummy-edge fallback, routes and band boxes returned.
- `uml/UmlCanvas.tsx`: card-edge merging, band computation, measure-then-layout phases, dragging disabled, band label nodes.
- `uml/UmlEdge.tsx`: rounded polyline from route, smooth-step fallback, multi-member highlighting and badges.
- `uml/UmlNodes.tsx`: Top/Bottom handles, entry badge, member handles removed, BandLabelNode.
- `styles.css`: entry/badge/band styles, opacity crossfade, cursor default.

Full diff: `git diff -- web/src`.

</details>
