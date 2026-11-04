import { Matrix4 } from "math.gl";
import { makePlaneMatrix } from "./plane_placement.js";

/**
 * The three projected walls, in genome-strip order: the strip starts at the front of the left
 * wall, runs to the back, across the back wall, and forward along the right wall.
 *
 * Wall surface coordinates are (s along the floor edge, t up the wall). Each wall has two frames:
 *   room  standing on its floor edge: s along `u`, t along +Z. u × Z points into the room, so
 *         content reads correctly from inside.
 *   flat  one segment of a single horizontal strip on the X-Y plane: s along +X, t along +Y.
 *         The walls sit end to end in strip order, so the genome reads left to right unbroken.
 * `wallPlacement` interpolates between the two.
 *
 * `stripStart` reserves the front of the left wall for the trait row labels; the genome strip
 * starts after it.
 */
export function makeWalls(room, rowLabelMargin) {
  const { width: W, depth: D } = room;
  const walls = [
    { id: "left", label: "Left wall", length: D, stripStart: rowLabelMargin, origin: [0, 0, 0], u: [0, 1, 0], outward: [-1, 0, 0] },
    { id: "back", label: "Back wall", length: W, stripStart: 0, origin: [0, D, 0], u: [1, 0, 0], outward: [0, 1, 0] },
    { id: "right", label: "Right wall", length: D, stripStart: 0, origin: [W, D, 0], u: [0, -1, 0], outward: [1, 0, 0] },
  ];
  // Flat strip: end to end along the back wall's line, centred on the room, so the back wall is
  // in the same place in both frames and only the side walls travel.
  let x = -D;
  for (const wall of walls) {
    wall.stripLength = wall.length - wall.stripStart; // derived
    wall.flatOrigin = [x, D, 0];
    x += wall.length;
  }
  // Hinges for the fold-in: each side wall turns about the corner it shares with the back wall.
  walls[0].corner = [0, D, 0];
  walls[0].foldSign = 1;
  walls[2].corner = [W, D, 0];
  walls[2].foldSign = -1;
  return walls;
}

const flatFrame = (wall) => makePlaneMatrix(wall.flatOrigin, [1, 0, 0], [0, 1, 0]);

const smoothstep = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * Assembly schedule: the strip stands up first, then the side walls swing in. The phases overlap
 * slightly so the motion doesn't stall at the handover.
 */
export const ASSEMBLY = { standUp: [0, 0.55], foldIn: [0.45, 1] };

/**
 * Placement of a wall at `t` (0 = flat strip, 1 = room), as a hinge chain:
 *   1. fold   — side walls rotate about the corner line they share with the back wall (a line
 *               across the strip, through the corner point). Positive for the left wall,
 *               negative for the right, so both swing toward the room.
 *   2. stand  — the whole strip rotates about its bottom edge (y = D, z = 0), +Y toward +Z.
 * Every rotation axis is a shared edge, so adjacent walls stay joined at every t.
 * At t = 1 this lands exactly on each wall's room frame (u along its floor edge, v = +Z).
 */
export function wallPlacement(wall, t, room) {
  const D = room.depth;
  const phi = (Math.PI / 2) * smoothstep((t - ASSEMBLY.standUp[0]) / (ASSEMBLY.standUp[1] - ASSEMBLY.standUp[0]));
  const theta = (Math.PI / 2) * smoothstep((t - ASSEMBLY.foldIn[0]) / (ASSEMBLY.foldIn[1] - ASSEMBLY.foldIn[0]));

  const stand = new Matrix4().translate([0, D, 0]).rotateX(phi).translate([0, -D, 0]);
  if (wall.corner == null) return stand.multiplyRight(flatFrame(wall));

  const c = wall.corner;
  const fold = new Matrix4()
    .translate(c)
    .rotateY(wall.foldSign * theta)
    .translate([-c[0], -c[1], -c[2]]);
  return stand.multiplyRight(fold).multiplyRight(flatFrame(wall));
}

/**
 * Point on a wall's bottom edge at surface coordinate `s`, under `placement`, stepped `inset` in
 * front of it: below the strip when flat, into the room when folded, interpolated in between.
 */
export function wallEdgePoint(wall, placement, t, s, inset = 0) {
  const p = placement.transformAsPoint([s, 0, 0]);
  const flatIn = [0, -1];
  const roomIn = [-wall.outward[0], -wall.outward[1]];
  const dx = flatIn[0] + (roomIn[0] - flatIn[0]) * t;
  const dy = flatIn[1] + (roomIn[1] - flatIn[1]) * t;
  const len = Math.hypot(dx, dy) || 1;
  return [p[0] + (dx / len) * inset, p[1] + (dy / len) * inset, p[2]];
}

/**
 * Assign genome bins to walls in strip order. Bar width is derived from the total strip length
 * so every bin has the same physical width on every wall; the last wall absorbs rounding.
 */
export function assignBinsToWalls(walls, bins) {
  const stripLength = walls.reduce((sum, w) => sum + w.stripLength, 0);
  const barWidth = stripLength / bins.length; // derived — don't set independently
  let cursor = 0;
  return {
    barWidth,
    segments: walls.map((wall, i) => {
      const count =
        i === walls.length - 1 ? bins.length - cursor : Math.round(wall.stripLength / barWidth);
      const segment = { wall, firstBin: cursor, bins: bins.slice(cursor, cursor + count) };
      cursor += count;
      return segment;
    }),
  };
}
