/**
 * Plane placement for viz_sandbox visualizers — CONSUMER-SIDE WORKAROUND.
 *
 * viz_sandbox lays every plot out in the world X-Y plane at z = 0. This module puts a whole
 * visualizer onto an arbitrary plane by giving every one of its layers the same deck.gl
 * `modelMatrix` (the "placement"). It is written in the shape a library feature would take, so
 * the friction it hits is the spec for that feature. See docs/LIBRARY_NOTES.md.
 *
 * The placement maps a visualizer's pre-placement world coordinates — the ones viz_sandbox
 * computes today, including globalPositionOffsetX/Y — onto the plane:
 *     world = placement · (x, y, 0, 1)
 * so the plot keeps its own X-Y frame and the plane is a pure outer transform.
 */
import { LayerExtension } from "@deck.gl/core";
import { IconLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Matrix4, Vector3 } from "math.gl";

/**
 * deck.gl applies `modelMatrix` to a layer's anchor positions only. Layers that draw a quad
 * around each anchor — text glyphs (IconLayer underneath TextLayer) and scatter discs — add the
 * quad's corner offset in common space AFTER the model transform (project32's
 * project_position_to_clipspace), so the quads stay in the world X-Y plane while their anchors
 * move onto the plane. This extension rotates that offset by the same matrix, through the
 * DECKGL_FILTER_SIZE hook both layers call on it.
 *
 * Correct only while the layer's modelMatrix is a rigid placement. A bounded layer's composed
 * matrix also carries the plot's pan/zoom scale, which would stretch the quads.
 */
class PlaneOffsetExtension extends LayerExtension {
  getShaders() {
    // Called with `this` bound to the layer. Other layer types also call DECKGL_FILTER_SIZE
    // (paths, lines) with offsets that are already in the right frame — leave them alone.
    if (!(this instanceof IconLayer || this instanceof ScatterplotLayer)) return null;
    return {
      inject: {
        "vs:DECKGL_FILTER_SIZE": "size = (project.modelMatrix * vec4(size, 0.0)).xyz;",
      },
    };
  }
}
PlaneOffsetExtension.extensionName = "PlaneOffsetExtension";
const PLANE_OFFSET_EXTENSION = new PlaneOffsetExtension();

/** Matrix taking plane-local (x, y, 0) to world: origin + x·u + y·v. u and v must be orthonormal. */
export function makePlaneMatrix(origin, u, v) {
  const n = new Vector3(u).cross(v);
  // Column-major: columns are u, v, n, origin.
  return new Matrix4([
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    n[0], n[1], n[2], 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

/**
 * Put every layer of `viz` on the plane `placement`.
 *
 * Workaround mechanics: `setLayerProps` on each LayerDescription. That only reaches the deck.gl
 * layer if the generator spreads its passthrough props — the built-in generators do, a custom
 * generator must. `billboard: false` lays text flat on the plane instead of turning it to face
 * the camera; it is a no-op on layer types that don't read it. The offset extension turns the
 * flat glyphs into the plane (see PlaneOffsetExtension).
 */
export function placeVisualizer(viz, placement, { redraw = true } = {}) {
  viz.appState.planePlacement = placement; // workaround stash; a library version would own this
  for (const id of viz.appState.orderedLayerIds) {
    viz.appState.layerDescriptions[id].setLayerProps({
      modelMatrix: placement,
      billboard: false,
      extensions: [PLANE_OFFSET_EXTENSION],
    });
  }
  if (redraw) viz.updatePlot();
}

/**
 * Layer ids whose generated deck.gl layer did NOT pick up the placement — i.e. generators that
 * drop passthrough props, or set `modelMatrix` themselves after the spread. Run after the first
 * placement; anything listed here renders on the X-Y plane while the rest of its plot is placed.
 */
export function auditPlacement(viz) {
  const placement = viz.appState.planePlacement;
  const missed = [];
  for (const id of viz.appState.orderedLayerIds) {
    const desc = viz.appState.layerDescriptions[id];
    if (!desc.enabled) continue;
    const layer = desc.getLayer(false);
    if (!layer) continue;
    if (layer.props.modelMatrix !== placement) missed.push({ id, reason: "modelMatrix not applied" });
    else if (layer.props.billboard === true) missed.push({ id, reason: "still billboarded" });
    else if (!layer.props.extensions?.includes(PLANE_OFFSET_EXTENSION)) {
      missed.push({ id, reason: "offset extension overridden" });
    }
  }
  return missed;
}

/**
 * The plot rect's four corners in world space, after placement.
 *
 * Workaround for getHeatmapWorldExtents()/getWorldExtents(), which report the pre-placement
 * X-Y rect. `rect` overrides the plot rect (e.g. to frame a backdrop larger than the plot).
 */
export function placedCorners(viz, rect = null) {
  const placement = viz.appState.planePlacement || new Matrix4();
  let x0, y0, x1, y1;
  if (rect) {
    [x0, y0, x1, y1] = rect;
  } else {
    const { topLeft, bottomRight } = viz.getHeatmapWorldExtents();
    [x0, y1] = topLeft;
    [x1, y0] = bottomRight;
  }
  return [
    [x0, y0, 0],
    [x1, y0, 0],
    [x1, y1, 0],
    [x0, y1, 0],
  ].map((p) => placement.transformAsPoint(p));
}

/**
 * Pre-placement X-Y coordinate under a screen pixel, by intersecting the pick ray with the plane.
 *
 * Workaround for the deck manager's `plotRelativeCoordinate`, which uses deck's `info.coordinate`
 * — the ray's intersection with world z = 0, not with the plot's plane — and then subtracts the
 * X/Y offset. Wrong for any placed plot; this is the value wheel-zoom focus, plot drag and
 * scrollbar reveal would need. Returns null when the ray is parallel to the plane.
 */
export function placedCoordinateAtPixel(viz, viewport, pixel) {
  const placement = viz.appState.planePlacement;
  if (!placement) return null;
  const inverse = new Matrix4(placement).invert();
  // Two points along the pick ray (different depths), carried into plane-local space where the
  // plane is z = 0.
  const a = inverse.transformAsPoint(viewport.unproject([pixel[0], pixel[1], 0]));
  const b = inverse.transformAsPoint(viewport.unproject([pixel[0], pixel[1], 0.5]));
  const dz = b[2] - a[2];
  if (Math.abs(dz) < 1e-12) return null;
  const t = -a[2] / dz;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
