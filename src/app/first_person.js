/**
 * First-person view (bubbles mode, simulated visitors): the camera rides along with one visitor.
 *
 * viz_sandbox's deck manager builds an orthographic OrbitView. While this is on, the view is
 * swapped (`setView`) for a deck FirstPersonView with the same id ("3d-scene"), positioned in plain
 * world metres (no latitude, so the viewport is non-geospatial). The orbit view and the camera
 * state are restored on exit.
 *
 * Camera: eye height `eyeHeight` above the visitor. Walking, it faces the walking direction;
 * standing near the wall, it turns to face the wall and looks up toward the bubbles. Heading and
 * pitch ease toward their targets (time constant `turnSeconds`), so turns are not instant.
 *
 * deck conventions (checked against math.gl SphericalCoordinates): bearing 0° looks along +y,
 * 90° along +x (clockwise from above); positive pitch looks DOWN.
 */
import { FirstPersonView } from "@deck.gl/core";
import { centerAt } from "./ribbon.js";
import { startSimulation } from "./visitors.js";

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // to (−π, π]

export function setFirstPerson(_appState, on) {
  const fpv = _appState.fpv;
  const dm = _appState.vizDeckManager;
  if (on === fpv.on && !fpv.transition) return;
  if (on) {
    if (!_appState.sim.on) startSimulation(_appState);
    if (!_appState.sim.visitors.length) return;
    if (!fpv.transition) fpv.savedView = _appState.currentViewState();
    fpv.on = true;
    if (fpv.visitorId == null || !_appState.sim.visitors.some((v) => v.id === fpv.visitorId)) nextVisitor(_appState);
    const v = followed(_appState);
    fpv.heading = headingTarget(_appState, v) ?? 0;
    fpv.elevation = 0;
    fpv.last = performance.now();
    computePose(_appState);
    transition(_appState, "in");
  } else {
    transition(_appState, "out");
  }
  _appState.onStateChange?.();
}

/**
 * Seamless switch between the orthographic orbit view and the first-person view: a dolly zoom.
 * Both ends are expressed as a perspective camera — look-at point, direction (bearing, pitch),
 * field of view, and the height of the scene visible at the look-at point:
 *  - first person: its own fov; look-at point `focusDistance` ahead.
 *  - orbit: same direction (an orbit's rotationOrbit / rotationX ARE a bearing / pitch); visible
 *    height = viewport height / 2^zoom; fov `orthoFovy` (0.5°), at which perspective is visually
 *    orthographic, so the hand-over to the real OrbitView at that end is invisible.
 * In between, look-at point and angles interpolate, fov and visible height interpolate in log
 * space, and the camera sits at distance = visible height / (2 tan(fov/2)) behind the look-at
 * point. The first-person end is live (the visitor keeps walking).
 */
function transition(_appState, dir) {
  const fpv = _appState.fpv;
  const dm = _appState.vizDeckManager;
  cancelAnimationFrame(fpv.transitionRaf);
  const orbit = fpv.savedView ?? _appState.fitViewState();
  const height = dm.deck.height || 1000;
  const orbitEnd = {
    target: [orbit.target[0], orbit.target[1], orbit.target[2] ?? 0],
    bearing: orbit.rotationOrbit ?? 0,
    pitch: orbit.rotationX ?? 90,
    fovy: fpv.orthoFovy,
    visible: height / Math.pow(2, orbit.zoom),
  };
  const fpvEnd = () => {
    const pose = fpv.pose;
    const d = directionOf(pose.bearing, pose.pitch);
    return {
      target: pose.position.map((x, i) => x + d[i] * fpv.focusDistance),
      bearing: pose.bearing,
      pitch: pose.pitch,
      fovy: fpv.fovy,
      visible: 2 * fpv.focusDistance * Math.tan(((fpv.fovy / 2) * Math.PI) / 180),
    };
  };
  // Resume from wherever a running transition is: its current progress, reversed if needed.
  const start = fpv.transition ? (fpv.transition.dir === dir ? fpv.transition.u : 1 - fpv.transition.u) : 0;
  const t0 = performance.now() - start * fpv.transitionMs;
  fpv.transition = { dir, u: start };
  const frame = (now) => {
    const u = Math.min(1, (now - t0) / fpv.transitionMs);
    fpv.transition.u = u;
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    const k = dir === "in" ? e : 1 - e; // 0 = orbit, 1 = first person
    const a = orbitEnd;
    const b = fpvEnd();
    const lerp = (x, y) => x + (y - x) * k;
    const lerpLog = (x, y) => Math.exp(lerp(Math.log(x), Math.log(y)));
    const dBearing = ((((b.bearing - a.bearing) % 360) + 540) % 360) - 180;
    const bearing = a.bearing + dBearing * k;
    const pitch = lerp(a.pitch, b.pitch);
    const fovy = lerpLog(a.fovy, b.fovy);
    const visible = lerpLog(a.visible, b.visible);
    const target = a.target.map((x, i) => lerp(x, b.target[i]));
    const dist = visible / (2 * Math.tan(((fovy / 2) * Math.PI) / 180));
    const d = directionOf(bearing, pitch);
    fpv.hideSelf = k > 0.9; // the camera is (nearly) inside the followed visitor
    swapView(dm, new FirstPersonView({ id: "3d-scene", fovy, near: Math.max(0.05, dist - 150), far: dist + 250, controller: false }));
    dm.setViewState({ position: target.map((x, i) => x - d[i] * dist), bearing, pitch });
    if (u < 1) {
      fpv.transitionRaf = requestAnimationFrame(frame);
      return;
    }
    fpv.transition = null;
    if (dir === "in") {
      fpv.hideSelf = true;
      swapView(dm, new FirstPersonView({ id: "3d-scene", fovy: fpv.fovy, near: 0.05, far: 400, controller: false }));
      applyPose(_appState);
    } else {
      fpv.on = false;
      swapView(dm, dm.generateView());
      dm.setViewState(orbit);
      _appState.onStateChange?.();
    }
  };
  fpv.transitionRaf = requestAnimationFrame(frame);
}

/**
 * Swap the deck view, finalizing any controller the swap replaces. deck 9.1.1 bug: when a view
 * keeps its id but changes controller type (OrbitController ↔ FirstPersonController),
 * ViewManager._updateController creates the new controller but never finalizes the old one, which
 * stays subscribed to pointer events. After leaving first person the stale FirstPersonController
 * emitted its old view state at the end of every drag, snapping the orbit camera back. The
 * viewport rebuild can be deferred, so sweep now and again next frame.
 */
function swapView(dm, view) {
  const vm = dm.deck?.viewManager;
  const before = vm ? Object.values(vm.controllers).filter(Boolean) : [];
  dm.setView(view);
  if (!vm) return;
  const sweep = () => {
    const live = new Set(Object.values(vm.controllers));
    for (const c of before) {
      if (!live.has(c) && !c._genomeRoomFinalized) {
        c._genomeRoomFinalized = true;
        c.finalize();
      }
    }
  };
  sweep();
  requestAnimationFrame(sweep);
}

/** Unit view direction for a deck bearing / pitch (bearing clockwise from +y; pitch + = down). */
function directionOf(bearing, pitch) {
  const b = (bearing * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return [Math.cos(p) * Math.sin(b), Math.cos(p) * Math.cos(b), -Math.sin(p)];
}

/** Follow a different visitor (random among the others). */
export function nextVisitor(_appState) {
  const fpv = _appState.fpv;
  const others = _appState.sim.visitors.filter((v) => v.id !== fpv.visitorId);
  if (!others.length) return;
  fpv.visitorId = others[Math.floor(Math.random() * others.length)].id;
  _appState.onStateChange?.();
}

const followed = (_appState) => _appState.sim.visitors.find((v) => v.id === _appState.fpv.visitorId);

/**
 * Direction to look (radians, atan2 on the floor plane, 0 = +x): toward the wall when standing
 * near it, else along the walk. Null if neither applies (stopped on open floor: keep heading).
 */
function headingTarget(_appState, v) {
  const fpv = _appState.fpv;
  const dx = v.target.pos[0] - v.pos[0];
  const dy = v.target.pos[1] - v.pos[1];
  const walking = v.vel > fpv.walkingSpeed && Math.hypot(dx, dy) > 0.05;
  if (!walking && v.target.bin != null) {
    // Face the wall at the region: from the visitor to the centerline point there.
    const s = _appState.binS(v.dwellBin ?? v.target.bin);
    const c = centerAt(_appState.ribbon.segs, s);
    return Math.atan2(c.y - v.pos[1], c.x - v.pos[0]);
  }
  if (walking) return Math.atan2(dy, dx);
  return null;
}

/**
 * Per frame (called from the simulation loop): ease heading and pitch toward the visitor's, and
 * place the camera — unless a transition is running, which reads the pose itself.
 */
export function updateFirstPerson(_appState) {
  const fpv = _appState.fpv;
  if (!fpv.on) return;
  if (!computePose(_appState)) return;
  if (!fpv.transition) applyPose(_appState);
}

function applyPose(_appState) {
  _appState.vizDeckManager.setViewState(_appState.fpv.pose);
}

/** The followed visitor's eye pose (eased), in deck FirstPersonView terms: `fpv.pose`. */
function computePose(_appState) {
  const fpv = _appState.fpv;
  let v = followed(_appState);
  if (!v) {
    nextVisitor(_appState);
    v = followed(_appState);
    if (!v) {
      setFirstPerson(_appState, false);
      return false;
    }
  }
  const now = performance.now();
  const dt = Math.min(0.1, (now - fpv.last) / 1000);
  fpv.last = now;
  const k = 1 - Math.exp(-dt / fpv.turnSeconds);

  const target = headingTarget(_appState, v);
  if (target != null) fpv.heading = wrap(fpv.heading + wrap(target - fpv.heading) * k);
  // Look up toward the bubbles while standing at a region; level-ish while walking.
  const standing = v.vel <= fpv.walkingSpeed && v.target.bin != null;
  const elevation = standing ? (v.active ? fpv.dwellElevation : fpv.approachElevation) : fpv.walkElevation;
  fpv.elevation += (elevation - fpv.elevation) * k;

  // deck bearing: degrees clockwise from +y. Our heading: radians counter-clockwise from +x.
  fpv.pose = {
    position: [v.pos[0], v.pos[1], fpv.eyeHeight],
    bearing: 90 - (fpv.heading * 180) / Math.PI,
    pitch: -fpv.elevation,
  };
  return true;
}
