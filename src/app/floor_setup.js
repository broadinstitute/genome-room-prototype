import { PathLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { BoundedVisualizer } from "viz_sandbox/js/bounded_visualizers/bounded_visualizer";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";
import { dwellRingPath } from "./visitors.js";

export const FLOOR_ARCS_LAYER_ID = "floorArcsLayer";
export const VISITOR_LAYER_ID = "visitorLayer";

const PERSON_HEIGHT = 1.7; // m

/**
 * Gender-neutral pictogram as a flat mesh standing on the floor (x across, z up, y = 0), turned
 * per frame to face the camera's bearing. Not a billboarded icon: deck sizes billboard offsets by
 * the viewport's focal distance rather than each vertex's depth, which is right for map views but
 * shrinks icons to specks under a FirstPersonView (focal distance 1). A mesh has real size in
 * every view. Shapes in a 64 × 170 unit frame (feet at the bottom), scaled to PERSON_HEIGHT:
 * head, torso, two arms, two legs; each convex, fanned from its centre.
 */
function personMesh() {
  const k = PERSON_HEIGHT / 170;
  const P = (x, y) => [(x - 32) * k, 0, (170 - y) * k];
  const shapes = [];
  const circle = (cx, cy, r, n = 24) => {
    const ring = [];
    for (let i = 0; i < n; i++) ring.push(P(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)));
    shapes.push({ c: P(cx, cy), ring });
  };
  const roundRect = (x, y, w, h, r, n = 6) => {
    const ring = [];
    const corners = [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]];
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= n; i++) {
        const a = ((a0 + (90 * i) / n) * Math.PI) / 180;
        ring.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a)));
      }
    }
    shapes.push({ c: P(x + w / 2, y + h / 2), ring });
  };
  circle(32, 15, 14);
  roundRect(16, 35, 32, 64, 8);
  roundRect(2, 35, 11, 56, 5.5);
  roundRect(51, 35, 11, 56, 5.5);
  roundRect(17, 101, 13, 69, 6.5);
  roundRect(34, 101, 13, 69, 6.5);
  const pos = [];
  for (const { c, ring } of shapes) {
    for (let i = 0; i < ring.length; i++) pos.push(...c, ...ring[i], ...ring[(i + 1) % ring.length]);
  }
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = -1; // facing −y, toward the camera
  return { attributes: { positions: { value: positions, size: 3 }, normals: { value: normals, size: 3 } } };
}
const PERSON_MESH = personMesh();

/**
 * The floor: surface, arcs from the focused region, and the stand-in visitor.
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

  // Outline follows the ribbon's centerline (closed straight across the open front), so the floor
  // matches whatever shape the walls take.
  add("floorSurfaceLayer", () => [{ ring: _appState.floorOutline }], (id, data) =>
    new SolidPolygonLayer({
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: _appState.colors.floor,
      opacity: _appState.floorOpacity(), // the floor exists only as the room forms
      pickable: false,
      parameters: { depthTest: false },
      updateTriggers: { getPolygon: [_appState.floorOutline] },
    }),
  );

  /**
   * Registration brackets at the 8 corners of the PHYSICAL room box (width × depth × height), after
   * hic_contact_map's bounding-corner brackets: three short arms per corner pointing inward along
   * each axis, neutral grey, never depth-tested. Fixed to the room, not to the projected surface, so
   * they stay put while the surface changes shape and show where a projection departs from the
   * real walls (the arc overruns the side walls). Fade in with the floor: on the flat strip there
   * is no room yet.
   */
  const H = room.height;
  const arm = _appState.layout.cornerArm;
  const cornerSegments = [];
  for (const cx of [0, 1]) {
    for (const cy of [0, 1]) {
      for (const cz of [0, 1]) {
        const at = [cx * W, cy * D, cz * H];
        const inward = [cx ? -1 : 1, cy ? -1 : 1, cz ? -1 : 1];
        for (let k = 0; k < 3; k++) {
          const to = at.slice();
          to[k] += inward[k] * arm;
          cornerSegments.push({ from: at, to });
        }
      }
    }
  }
  // Billboarded PathLayer, not LineLayer: deck scales LineLayer's pixel width by the viewport's
  // focal distance (fine for the orbit view, ~zero width under the first-person view); a
  // billboarded path scales by each vertex's clip depth, so it holds in every view.
  add("roomCornerLayer", () => cornerSegments, (id, data) =>
    new PathLayer({
      id,
      data,
      getPath: (d) => [d.from, d.to],
      billboard: true,
      getColor: _appState.colors.cornerMarks,
      getWidth: 1.5,
      widthUnits: "pixels",
      opacity: _appState.floorOpacity(),
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
      billboard: true, // pixel width that holds under the first-person view too
      capRounded: true,
      pickable: true,
      parameters: { depthTest: false },
    }),
  );


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

/**
 * Visitors, on their own visualizer created AFTER the strip: layers draw in visualizer order with
 * depth testing off, so on the floor visualizer the band and bubbles painted over anyone standing
 * in front of them (very visible in the first-person view). Person pictogram (billboarded, so it
 * faces any camera) and a floor ring that fills as the dwell builds. The visitor being followed in
 * the first-person view is skipped (the camera is inside it).
 */
export function makeVisitorViz(containerId, deckManager, room, _appState) {
  const viz = new BoundedVisualizer(containerId, null, { boundsEnabled: false }, null, deckManager);
  viz.appState.layerDescriptions.scrollbarLayer.enabled = false;
  viz.appState.layerDescriptions.pathAnnotationLayer.enabled = false;
  viz.appState.layerDescriptions.arcAnnotationLayer.enabled = false;
  const add = (id, accessor, generator) => {
    const qid = viz.constructUniqueInstanceLayerId(id);
    viz.appState.addLayer(new LayerDescription(id, accessor, (rows) => generator(qid, rows), { enabled: true }));
  };
  // Visitors: a person pictogram, for scale in the folded room. Simulated visitors are grey
  // until they dwell; a ring on the floor around their feet fills as the dwell builds.
  const visitorColor = (d) => (d.active === false ? _appState.colors.visitorIdle : _appState.colors.visitor);
  add(VISITOR_LAYER_ID, () => _appState.visitors.filter((d) => !d.self), (id, data) => [
    new PathLayer({
      id: `${id}-dwell`,
      data: data.filter((d) => d.dwell > 0),
      getPath: (d) => dwellRingPath(d), // not the bare function: deck passes an info object second
      billboard: true, // pixel width that holds under the first-person view too
      getColor: _appState.colors.visitor,
      getWidth: 3,
      widthUnits: "pixels",
      pickable: false,
      parameters: { depthTest: false },
    }),
    // Person pictogram mesh, turned to face the camera (yaw = −bearing: local +x → screen right).
    new SimpleMeshLayer({
      id: `${id}-person`,
      data,
      mesh: PERSON_MESH,
      getPosition: (d) => d.position,
      getOrientation: () => [0, -_appState.cameraBearing(), 0],
      getColor: visitorColor,
      material: false,
      pickable: false,
      parameters: { depthTest: false, cullMode: "none" },
      updateTriggers: { getOrientation: [_appState.cameraBearing()], getColor: [_appState.colors.visitor, _appState.colors.visitorIdle] },
    }),
  ]);
  // Re-face the camera while the orbit view is dragged (the simulation redraws every frame anyway).
  const baseViewStateChange = viz.viewStateChangeHandler.bind(viz);
  viz.viewStateChangeHandler = (e) => {
    baseViewStateChange(e);
    if (!_appState.sim.on) viz.updatePlot();
  };
  viz.setPlotPosition([0, 0], [room.width, room.depth]);
  return viz;
}
