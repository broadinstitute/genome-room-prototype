/**
 * The genome strip as a RIBBON: one 2D plot in ribbon coordinates (s along the strip, t up it),
 * mapped onto a 3D surface by a function f(s, t) evaluated per vertex in the vertex shader.
 *
 * The surface is a standing ribbon whose bottom edge follows a floor-plane centerline, built
 * from a few segments of constant curvature (straight runs, tight corners, arcs). That one family
 * covers a flat strip, a room with corners, rounded corners, and a curved wall. Two parameters
 * morph between them without stretching the ribbon — genome distances are preserved:
 *   bend   0..1  scales every segment's turn (0 = straight centerline)
 *   stand  0..π/2  tilts the ribbon up about the line y = axisY, z = 0 (0 = lying on the floor)
 * The middle of the strip is anchored, so the back of the room never moves.
 *
 * Content z (out of the plot plane) is carried along the surface normal, so anything drawn
 * slightly in front of the plot stays in front of the surface.
 *
 * The same math exists twice — GLSL for rendering, JS for everything the CPU needs (floor arcs,
 * camera fit, cursor → ribbon coordinate). Keep them in step.
 */
import { LayerExtension } from "@deck.gl/core";

export const SEGMENT_COUNT = 5;

/**
 * Centerline profiles. Every profile has SEGMENT_COUNT segments whose lengths sum to the strip
 * length, so profiles can be interpolated segment by segment. Turns are radians, negative =
 * clockwise seen from above (the room is on the right of the direction of travel).
 */
export function makeProfiles(room) {
  const { width: W, depth: D } = room;
  const L = 2 * D + W;
  const cornered = (c) => ({
    lengths: [D - c / 2, c, W - c, c, D - c / 2],
    turns: [0, -Math.PI / 2, 0, -Math.PI / 2, 0],
  });
  const room_ = cornered(0.3);
  return {
    stripLength: L,
    room: { label: "Room", ...room_ },
    rounded: { label: "Rounded", ...cornered(8) },
    // Constant curvature over the whole length: a half-cylinder.
    arc: { label: "Arc", lengths: room_.lengths, turns: room_.lengths.map((len) => (-Math.PI * len) / L) },
  };
}

export function lerpProfile(a, b, k) {
  return {
    lengths: a.lengths.map((v, i) => v + (b.lengths[i] - v) * k),
    turns: a.turns.map((v, i) => v + (b.turns[i] - v) * k),
  };
}

/**
 * Segment start states for a profile at a given bend, anchored so the strip midpoint sits at
 * `anchor` heading +X. Returns { segs: [{ s0, x0, y0, h0, k }] } — the uniform payload.
 */
export function buildCenterline(profile, bend, anchor) {
  // Integrate from s = 0 in a provisional frame.
  const raw = [];
  let x = 0;
  let y = 0;
  let h = 0;
  let s = 0;
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const len = profile.lengths[i];
    const turn = profile.turns[i] * bend;
    const k = len > 0 ? turn / len : 0;
    raw.push({ s0: s, x0: x, y0: y, h0: h, k });
    [x, y, h] = advance(x, y, h, k, len);
    s += len;
  }
  const L = s;
  // Rigidly move the provisional centerline so its midpoint lands on the anchor heading +X.
  const mid = centerAt(raw, L / 2);
  const rot = -mid.h;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const segs = raw.map((g) => {
    const dx = g.x0 - mid.x;
    const dy = g.y0 - mid.y;
    return { s0: g.s0, x0: anchor[0] + c * dx - sn * dy, y0: anchor[1] + sn * dx + c * dy, h0: g.h0 + rot, k: g.k };
  });
  return { segs, length: L };
}

function advance(x, y, h, k, ds) {
  if (Math.abs(k) < 1e-9) return [x + ds * Math.cos(h), y + ds * Math.sin(h), h];
  const h1 = h + k * ds;
  return [x + (Math.sin(h1) - Math.sin(h)) / k, y + (-Math.cos(h1) + Math.cos(h)) / k, h1];
}

/** Centerline point and heading at arc length s (extrapolates past both ends). */
export function centerAt(segs, s) {
  let i = 0;
  for (let j = 1; j < segs.length; j++) if (s >= segs[j].s0) i = j;
  const g = segs[i];
  const [x, y, h] = advance(g.x0, g.y0, g.h0, g.k, s - g.s0);
  return { x, y, h };
}

/** The ribbon map f(s, t, z) → world, and the surface normal there. Mirrors ribbon_map in GLSL. */
export function ribbonPoint(state, s, t, z = 0) {
  const { x, y, h } = centerAt(state.segs, s);
  const n = [Math.sin(h), -Math.cos(h), 0]; // right of travel: into the room
  const q = [x + z * n[0], y + z * n[1], t];
  const a = state.stand - Math.PI / 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ry = q[1] - state.axisY;
  return {
    point: [q[0], state.axisY + ca * ry - sa * q[2], sa * ry + ca * q[2]],
    normal: [n[0], ca * n[1] - sa * n[2], sa * n[1] + ca * n[2]],
  };
}

/** Uniform payload for the shader module. */
export function ribbonUniforms(state, backfaceAlpha) {
  const u = {};
  state.segs.forEach((g, i) => {
    u[`seg${i}`] = [g.s0, g.x0, g.y0, g.h0];
  });
  u.curvA = [state.segs[0].k, state.segs[1].k, state.segs[2].k, state.segs[3].k];
  u.params = [state.segs[4].k, state.stand, state.axisY, backfaceAlpha];
  return u;
}

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------

const RIBBON_GLSL = /* glsl */ `
uniform ribbonUniforms {
  vec4 seg0;
  vec4 seg1;
  vec4 seg2;
  vec4 seg3;
  vec4 seg4;
  vec4 curvA;   // k0..k3
  vec4 params;  // k4, stand, axisY, backfaceAlpha
} ribbon;

void ribbon_center(float s, out vec2 p, out float h) {
  vec4 g = ribbon.seg0;
  float k = ribbon.curvA.x;
  if (s >= ribbon.seg1.x) { g = ribbon.seg1; k = ribbon.curvA.y; }
  if (s >= ribbon.seg2.x) { g = ribbon.seg2; k = ribbon.curvA.z; }
  if (s >= ribbon.seg3.x) { g = ribbon.seg3; k = ribbon.curvA.w; }
  if (s >= ribbon.seg4.x) { g = ribbon.seg4; k = ribbon.params.x; }
  float ds = s - g.x;
  if (abs(k) < 1e-9) {
    h = g.w;
    p = g.yz + ds * vec2(cos(g.w), sin(g.w));
  } else {
    h = g.w + k * ds;
    p = g.yz + vec2(sin(h) - sin(g.w), -cos(h) + cos(g.w)) / k;
  }
}

vec3 ribbon_map(vec3 w, out vec3 normal) {
  vec2 c;
  float h;
  ribbon_center(w.x, c, h);
  vec3 n = vec3(sin(h), -cos(h), 0.0);
  vec3 q = vec3(c + w.z * n.xy, w.y);
  float a = ribbon.params.y - 1.5707963267948966;
  float ca = cos(a);
  float sa = sin(a);
  float ry = q.y - ribbon.params.z;
  normal = vec3(n.x, ca * n.y - sa * n.z, sa * n.y + ca * n.z);
  return vec3(q.x, ribbon.params.z + ca * ry - sa * q.z, sa * ry + ca * q.z);
}
`;

const RIBBON_MODULE = {
  name: "ribbon",
  vs: RIBBON_GLSL,
  fs: RIBBON_GLSL,
  uniformTypes: {
    seg0: "vec4<f32>",
    seg1: "vec4<f32>",
    seg2: "vec4<f32>",
    seg3: "vec4<f32>",
    seg4: "vec4<f32>",
    curvA: "vec4<f32>",
    params: "vec4<f32>",
  },
};

// geometry.position is the vertex in common space AFTER everything viz_sandbox does (bounds
// transform, text/scatter quad offsets), i.e. a point in the flat plot plane. Recover world from
// it, map it onto the ribbon, and re-project. Works for any layer whose shader fills
// geometry.position before DECKGL_FILTER_GL_POSITION — polygons, text glyphs, scatter discs.
// Not for pixel-width lines/paths, whose width is applied in clip space.
const RIBBON_INJECT = {
  "vs:#decl": "out float ribbon_facing;",
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
    vec3 ribbon_world = geometry.position.xyz / project.commonUnitsPerWorldUnit + project.coordinateOrigin;
    vec3 ribbon_normal;
    vec3 ribbon_mapped = ribbon_map(ribbon_world, ribbon_normal);
    vec4 ribbon_common = vec4((ribbon_mapped - project.coordinateOrigin) * project.commonUnitsPerWorldUnit, 1.0);
    position = project_common_position_to_clipspace(ribbon_common);
    ribbon_facing = dot(ribbon_normal, normalize(project.cameraPosition - ribbon_common.xyz));
  `,
  "fs:#decl": "in float ribbon_facing;",
  // Dollhouse cutaway: surface seen from behind fades.
  "fs:DECKGL_FILTER_COLOR": "if (ribbon_facing < 0.0) color.a *= ribbon.params.w;",
};

/**
 * Maps a layer's geometry onto the ribbon. The ribbon state rides on the `ribbonUniforms` layer
 * prop (declared in defaultProps so composite layers forward it to their sublayers); changing it
 * re-uploads uniforms without recompiling the shader.
 */
export class RibbonExtension extends LayerExtension {
  getShaders() {
    return { modules: [RIBBON_MODULE], inject: RIBBON_INJECT };
  }
  draw() {
    if (this.props.ribbonUniforms) this.setShaderModuleProps({ ribbon: this.props.ribbonUniforms });
  }
}
RibbonExtension.extensionName = "RibbonExtension";
RibbonExtension.defaultProps = { ribbonUniforms: null };

export const RIBBON_EXTENSION = new RibbonExtension();

// ---------------------------------------------------------------------------------------------
// Cursor → ribbon coordinate (CPU)
// ---------------------------------------------------------------------------------------------

/**
 * Ribbon (s, t) under a screen pixel: intersect the pick ray with the ribbon approximated by
 * planar facets along s (rulings are straight, so each facet is exact between its two rulings
 * up to the centerline's curvature within it). Nearest hit wins. Null if the ray misses.
 */
export function ribbonCoordinateAtPixel(state, viewport, pixel, height, step = 0.25) {
  const o = viewport.unproject([pixel[0], pixel[1], 0]);
  const b = viewport.unproject([pixel[0], pixel[1], 0.5]);
  const d = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
  let best = null;
  for (let s = 0; s < state.length; s += step) {
    const s1 = Math.min(s + step, state.length);
    const p00 = ribbonPoint(state, s, 0).point;
    const p10 = ribbonPoint(state, s1, 0).point;
    const p01 = ribbonPoint(state, s, height).point;
    const e1 = sub(p10, p00);
    const e2 = sub(p01, p00);
    const n = cross(e1, e2);
    const denom = dot(n, d);
    if (Math.abs(denom) < 1e-12) continue;
    const r = dot(n, sub(p00, o)) / denom;
    const hit = add(o, scale(d, r));
    // Solve hit - p00 = u·e1 + v·e2 by the 2×2 normal equations.
    const w = sub(hit, p00);
    const a11 = dot(e1, e1);
    const a12 = dot(e1, e2);
    const a22 = dot(e2, e2);
    const b1 = dot(w, e1);
    const b2 = dot(w, e2);
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) continue;
    const u = (b1 * a22 - b2 * a12) / det;
    const v = (a11 * b2 - a12 * b1) / det;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    if (!best || r < best.r) best = { r, s: s + u * (s1 - s), t: v * height };
  }
  return best && [best.s, best.t];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
