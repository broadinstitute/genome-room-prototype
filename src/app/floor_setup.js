import { LineLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { BoundedVisualizer } from "viz_sandbox/js/bounded_visualizers/bounded_visualizer";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";

export const FLOOR_ARCS_LAYER_ID = "floorArcsLayer";
export const VISITOR_LAYER_ID = "visitorLayer";

/**
 * The floor: surface, 1 m grid, arcs from the focused region, and the stand-in visitor.
 *
 * Unplaced — it IS the X-Y plane, so world coordinates are used directly. Plain deck.gl layers:
 * the floor is not navigable (the orbit camera does pan/zoom/rotate) so the bounded pipeline
 * buys nothing here. Scrollbar/hit-area and annotation layers are disabled: the hit area is an
 * alpha-0 quad that punches a depth hole through anything drawn above z = 0 (same reasoning as
 * pattern_viz_demos broad_floorplans).
 */
export function makeFloorViz(containerId, deckManager, room, _appState) {
  const viz = new BoundedVisualizer(containerId, null, { boundsEnabled: false }, null, deckManager);
  viz.appState.layerDescriptions.scrollbarLayer.enabled = false;
  viz.appState.layerDescriptions.pathAnnotationLayer.enabled = false;
  viz.appState.layerDescriptions.arcAnnotationLayer.enabled = false;

  const { width: W, depth: D } = room;
  const add = (id, accessor, generator) => {
    const qid = viz.constructUniqueInstanceLayerId(id);
    viz.appState.addLayer(new LayerDescription(id, accessor, (rows) => generator(qid, rows), { enabled: true }));
  };

  add("floorSurfaceLayer", () => [{ ring: [[0, 0], [W, 0], [W, D], [0, D]] }], (id, data) =>
    new SolidPolygonLayer({
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: _appState.colors.floor,
      opacity: _appState.floorOpacity(), // the floor exists only as the room forms
      pickable: false,
      parameters: { depthTest: false },
    }),
  );

  const grid = [];
  for (let x = 1; x < W; x++) grid.push({ from: [x, 0, 0], to: [x, D, 0] });
  for (let y = 1; y < D; y++) grid.push({ from: [0, y, 0], to: [W, y, 0] });
  add("floorGridLayer", () => grid, (id, data) =>
    new LineLayer({
      id,
      data,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: _appState.colors.grid,
      opacity: _appState.floorOpacity(),
      getWidth: 1,
      widthUnits: "pixels",
      pickable: false,
      parameters: { depthTest: false },
    }),
  );

  add(FLOOR_ARCS_LAYER_ID, () => _appState.floorArcs, (id, data) =>
    new PathLayer({
      id,
      data,
      getPath: (d) => d.path,
      getColor: (d) => d.color,
      getWidth: 2,
      widthUnits: "pixels",
      capRounded: true,
      pickable: true,
      parameters: { depthTest: false },
    }),
  );

  // The stand-in visitor: a footprint and a 1.7 m body line, for scale in the folded room.
  add(VISITOR_LAYER_ID, () => _appState.visitors, (id, data) => [
    new ScatterplotLayer({
      id: `${id}-footprint`,
      data,
      getPosition: (d) => d.position,
      getRadius: 0.3,
      radiusUnits: "common",
      getFillColor: _appState.colors.visitor,
      pickable: false,
      parameters: { depthTest: false },
    }),
    new LineLayer({
      id: `${id}-body`,
      data,
      getSourcePosition: (d) => d.position,
      getTargetPosition: (d) => [d.position[0], d.position[1], 1.7],
      getColor: _appState.colors.visitor,
      getWidth: 3,
      widthUnits: "pixels",
      pickable: false,
      parameters: { depthTest: false },
    }),
  ]);

  viz.defaultTooltipFunction = (info) => {
    const d = info?.object;
    if (!d || !d.trait || info.layer?.id !== viz.constructUniqueInstanceLayerId(FLOOR_ARCS_LAYER_ID)) return null;
    return {
      html: `<div style="font:11px Helvetica,Arial,sans-serif">${d.trait.label}<br/>to chr${d.bin.chrom} bin ${d.bin.index}</div>`,
      style: { background: "rgba(20,20,28,0.95)", color: "rgb(220,230,245)", padding: "6px 9px", borderRadius: "4px" },
    };
  };

  viz.setPlotPosition([0, 0], [W, D]);
  return viz;
}

/** Quadratic Bézier on the floor plane from `from` to `to` through control point `ctrl`. */
export function floorArcPath(from, to, ctrl, segments = 32, lift = 0.02) {
  const path = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    path.push([a * from[0] + b * ctrl[0] + c * to[0], a * from[1] + b * ctrl[1] + c * to[1], lift]);
  }
  return path;
}
