# Plane placement — findings for a viz_sandbox library change

This prototype puts whole viz_sandbox visualizers onto planes other than world X-Y, as a
consumer-side workaround ([src/app/plane_placement.js](../src/app/plane_placement.js)). This file
records what the workaround needed. Each item is a candidate requirement for a library feature.

Test scene: three `BoundedHeatmapVisualizer` walls, animated between one continuous horizontal strip
on the X-Y plane and an upright room around a floor. Each wall's placement is interpolated rigidly
(origin lerp, orientation slerp) every frame. Verified in the running app, 2026-11-04, against
viz_sandbox `main` and deck.gl 9.1.1.

## What worked without library changes

| Mechanism | Result |
|---|---|
| `setLayerProps({ modelMatrix })` on every LayerDescription | Every built-in heatmap layer (cells, labels, titles, hit layers, scrollbar/hit area) and the custom layers picked up the placement. The audit found no misses. |
| Bounded clipping on a placed plot | Correct. The clip test uses pre-placement coordinates. |
| Object picking (tooltips, `dataHoverFunction`) on a placed plot | Correct in both fold states. Picking is GPU color-based. |
| Camera fit with `expandTargetViewStateToWorldPoints` | Correct, given placed 3D corners. |
| Re-placing every layer of 3 walls every frame | 60 fps over the transition animation (worst frame 18 ms). |

## What needed workarounds

### 1. No placement concept on the visualizer
Placement had to be pushed into each LayerDescription. A custom generator that doesn't spread its
passthrough props would silently stay on the X-Y plane. That is why `auditPlacement` exists.

**Wanted:** a per-visualizer placement matrix on `appState`, applied as the outermost transform to
every layer, composed with any `modelMatrix` a layer already carries. Example:
`viz.setPlacement(matrix)`.

### 2. Quad offsets ignore `modelMatrix` — a deck.gl behavior
deck.gl applies `modelMatrix` to anchor positions only. Text glyphs (IconLayer under TextLayer) and
scatter discs add their corner offset in common space after the model transform
(`project32`'s `project_position_to_clipspace`). Placed text stayed parallel to the floor while its
anchor moved onto the wall. Setting `billboard: true` instead turns it to face the camera, which
doesn't help either.

**Workaround:** `PlaneOffsetExtension`, a `LayerExtension` that rotates the offset by `modelMatrix`
through the `DECKGL_FILTER_SIZE` hook. It is limited to IconLayer and ScatterplotLayer, because
path and line layers also call that hook with offsets that are already correct.

**Wanted:** the same idea, but using the placement's rotation only, as its own uniform. Using
`modelMatrix` is wrong for bounded layers, whose composed matrix also carries pan/zoom scale.

### 3. BoundedScatterplotLayer composes in the opposite order (bug)
`BoundedSolidPolygonLayer`, `BoundedLineLayer`, `BoundedPathLayer` and `BoundedBoxLayer` compute
`modelMatrix · bounds · p`. `BoundedScatterplotLayer` (via `composeBoundsModelMatrix`) computes
`bounds · modelMatrix · p`. Under any non-identity placement, its points get the plot offset added
in world space after placement.

**Reproduce:** `?probe=scatter`. The magenta scatter dots leave the white polygon squares that mark
the same cell centers and land on the floor.

**Wanted:** make `BoundedScatterplotLayer` compose like the others.

### 4. Plot-relative cursor coordinate assumes z = 0
`VisualizerDeckManager.onHoverHandler` computes `plotRelativeCoordinate` as `info.coordinate` minus
the X/Y offset. `info.coordinate` is the pick ray's intersection with world z = 0, not with the
plot's plane. Measured on the back wall:

| State | Ray–plane intersection | deck `plotRelativeCoordinate` |
|---|---|---|
| Flat | (12.00, 1.80) | (12.00, 17.80) — off by the 16 m the back wall sits from the origin |
| Room | (10.08, 2.10) | (12.65, 11.53) |

The ray–plane value matched the GPU-picked cell's region in both cases.
Wheel-zoom focus, plot drag and scrollbar reveal all consume this value. The walls are not
navigable in this prototype for that reason.

**Wanted:** intersect the pick ray with the placed plane, then apply the inverse placement
(`placedCoordinateAtPixel`).

### 5. Extents are pre-placement
`getHeatmapWorldExtents()` / `getWorldExtents()` return the X-Y rect, so a camera fit on them frames
the wrong region.

**Wanted:** placed extents (`placedCorners`), or a flag on the existing methods.

## Related limits hit along the way (not placement)

- **Orthographic-only view.** `VisualizerDeckManager.generateView()` hard-codes
  `orthographic: true`. A room seen from outside therefore always shows one side wall edge-on or
  from behind. Here, any wall facing away from the camera fades out (`updateWallFacing`). A
  perspective view from inside the room (a visitor's eye) would need the view to be configurable,
  and the fit/unproject helpers that build their own viewport from `this.view` would need to
  follow it.
- **Orbit target pinned to z = 0** (`constrainViewStateTarget`). Fine for a room standing on the
  floor plane. It would matter for content centered above it.
- **Cell gaps alias at small cell sizes.** At ~2 px per genome bin, the inter-cell gap lands on
  whole pixel columns and rows in a beat pattern. Those pixels pick the plot hit area, not a cell
  (correct behavior, but it looks like dead columns when probing picking by hand). Not
  placement-related. A zero-gap option for dense heatmaps would remove it.
- **Column axis title sits below the plot.** On a hinged wall, below the plot is past the hinge:
  the title lands under the floor when folded. Worked around with
  `setColumnLabelPosition("top")`. A per-axis title side would be cleaner.

## Proposed API (sketch)

```js
viz.setPlacement(matrix4)        // outermost transform for all layers; null = X-Y plane
viz.getPlacement()
viz.getPlacedWorldCorners()      // 4 world-space corners of the plot rect
// deck manager: plotRelativeCoordinate becomes plane-aware for placed visualizers
// bounded layers: a placement uniform separate from the bounds transform, used for both
//   position (outermost) and quad-offset rotation
```
