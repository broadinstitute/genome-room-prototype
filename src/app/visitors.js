/**
 * Simulated visitors (bubbles mode, ?sim=1): stand-ins for tracked people walking the room.
 *
 * Movement and detection are deliberately separate, as they would be with real tracking:
 *  - Movement: each visitor walks to a target in front of the wall — biased toward regions with
 *    hint ticks, rarer traits more so — stays a while, then picks another. Some targets are open
 *    floor (passing through).
 *  - Detection only reads positions: a visitor who is near the wall and nearly still in front of
 *    the same region for `dwellTriggerMs` opens a cluster there; moving off for `releaseMs`
 *    closes it. It knows nothing of the targets.
 *
 * Simulation time runs at `sim.speed`× real time; the bubble and bracket animations do not.
 */
import { centerAt } from "./ribbon.js";
import { setClusterFocus, animateBubbles } from "./bubbles.js";

const owner = (v) => `visitor-${v.id}`;
const rand = (a, b) => a + Math.random() * (b - a);

/** Nearest wall point to floor position p: arc length s, distance in front, and the bin there. */
function nearestWall(_appState, p) {
  const r = _appState.ribbon;
  let best = null;
  for (let s = 0; s <= r.length; s += 0.25) {
    const c = centerAt(r.segs, s);
    const d = Math.hypot(p[0] - c.x, p[1] - c.y);
    // In front = on the room side (right of the direction of travel).
    const front = (p[0] - c.x) * Math.sin(c.h) - (p[1] - c.y) * Math.cos(c.h);
    if (front > -0.05 && (!best || d < best.d)) best = { s, d };
  }
  if (!best) return null;
  // Refine to 1 cm: the coarse step is ~3 bins, enough to register the wrong region.
  for (let s = Math.max(0, best.s - 0.25); s <= Math.min(r.length, best.s + 0.25); s += 0.01) {
    const c = centerAt(r.segs, s);
    const d = Math.hypot(p[0] - c.x, p[1] - c.y);
    if (d < best.d) best = { s, d };
  }
  const col = Math.floor((best.s - _appState.layout.rowLabelMargin) / _appState.barWidth);
  const bin = col >= 0 && col < _appState.bins.length ? col : null;
  return { ...best, bin };
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Traits with a hit at `bin` in the tiers currently shown. */
const visibleTraits = (_appState, bin) =>
  _appState.traits.filter((t) => _appState.display.tiers.has(t.tier) && t.byBin.has(bin));

/** Nearest region to `bin` (within ±snapBins) with a shown hit, or null. */
function snapBin(_appState, bin) {
  const n = _appState.sim.config.snapBins;
  for (let d = 0; d <= n; d++) {
    for (const b of d ? [bin - d, bin + d] : [bin]) {
      if (b >= 0 && b < _appState.bins.length && visibleTraits(_appState, b).length) return b;
    }
  }
  return null;
}

/** Two regions share a trait in the tiers currently shown. */
const linked = (_appState, a, b) => a != null && b != null && a !== b && visibleTraits(_appState, a).some((t) => t.byBin.has(b));

const openFloorTarget = (_appState) => {
  const cfg = _appState.sim.config;
  const xs = _appState.floorOutline.map((q) => q[0]);
  const ys = _appState.floorOutline.map((q) => q[1]);
  for (let tries = 0; tries < 40; tries++) {
    const q = [rand(Math.min(...xs), Math.max(...xs)), rand(Math.min(...ys), Math.max(...ys))];
    const w = nearestWall(_appState, q);
    if (pointInPolygon(q, _appState.floorOutline) && w && w.d > cfg.dwellRange + 0.5) {
      return { pos: q, bin: null, stayMs: rand(...cfg.passStayMs) };
    }
  }
  return null;
};

/** Region bins other visitors are heading to or standing at (to keep visitors apart). */
const takenBins = (_appState, v) =>
  _appState.sim.visitors.filter((o) => o !== v).flatMap((o) => [o.target?.bin, o.dwellBin]).filter((b) => b != null);

/** Weighted pick from `weights` (array); null if all zero. */
function pickWeighted(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let x = Math.random() * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) <= 0) return i;
  return weights.length - 1;
}

function regionTarget(_appState, bin) {
  const cfg = _appState.sim.config;
  const p = _appState.binEdgePoint(bin, rand(...cfg.standOff));
  return { pos: [p[0], p[1]], bin, stayMs: rand(0.6, 1.4) * cfg.stay * 1000 };
}

/** Where a visitor walks next: a spot in front of a region (weighted), or open floor. */
function pickTarget(_appState, v) {
  const { sim } = _appState;
  const cfg = sim.config;
  if (Math.random() < cfg.passThroughChance) {
    const t = openFloorTarget(_appState);
    if (t) return t;
  }
  // Only regions with a hit in a shown tier; regions other visitors are heading to or standing
  // at are off-limits (± exclusionBins).
  const taken = takenBins(_appState, v);
  const weights = _appState.bins.map((bin) => {
    if (taken.some((b) => Math.abs(b - bin.index) <= cfg.exclusionBins)) return 0;
    const hits = visibleTraits(_appState, bin.index);
    if (!hits.length) return 0;
    const rarest = hits.reduce((a, b) => (b.binCount < a.binCount ? b : a));
    return cfg.weightByTier[rarest.tier];
  });
  const bin = pickWeighted(weights);
  return bin == null ? openFloorTarget(_appState) ?? { pos: v.pos, bin: null, stayMs: 1000 } : regionTarget(_appState, bin);
}

/**
 * Recruit: when `v` starts dwelling, send the nearest free visitor to a region linked to v's
 * (sharing a shown trait; rarer shared traits weighted up, same weights as targets), and have v
 * wait long enough for them to get there and dwell.
 */
function recruit(_appState, v) {
  const { sim } = _appState;
  const cfg = sim.config;
  const traits = visibleTraits(_appState, v.dwellBin);
  if (!traits.length) return;
  const taken = takenBins(_appState, null);
  const weights = _appState.bins.map((bin) => {
    if (taken.some((b) => Math.abs(b - bin.index) <= cfg.exclusionBins)) return 0;
    const shared = traits.filter((t) => t.byBin.has(bin.index));
    if (!shared.length) return 0;
    const rarest = shared.reduce((a, b) => (b.binCount < a.binCount ? b : a));
    return cfg.weightByTier[rarest.tier];
  });
  const bin = pickWeighted(weights);
  if (bin == null) return;
  const target = regionTarget(_appState, bin);
  // Free = not dwelling or about to, not already recruited, not waiting on a recruit.
  const free = sim.visitors.filter((o) => o !== v && !o.active && o.dwellMs === 0 && o.recruitedBy == null && o.waitFor == null);
  if (!free.length) return;
  const r = free.reduce((a, b) =>
    Math.hypot(b.pos[0] - target.pos[0], b.pos[1] - target.pos[1]) < Math.hypot(a.pos[0] - target.pos[0], a.pos[1] - target.pos[1]) ? b : a,
  );
  setTarget(r, target);
  r.recruitedBy = v.id;
  const dist = Math.hypot(r.pos[0] - target.pos[0], r.pos[1] - target.pos[1]);
  v.waitFor = r.id;
  v.waitDeadline = sim.time + (dist / r.speed) * 1000 + cfg.recruitSlackMs + cfg.dwellTriggerMs;
}

function setTarget(v, target) {
  v.target = target;
  v.arrived = false; // the stay starts on arrival
}

/** May `v` leave its region? Not while holding for a link, or waiting on a recruit en route. */
function mustStay(_appState, v) {
  const { sim } = _appState;
  if (sim.time < v.holdUntil) return true;
  if (v.waitFor == null) return false;
  const r = sim.visitors.find((o) => o.id === v.waitFor);
  const enRoute = r && r.recruitedBy === v.id && !r.active && sim.time < v.waitDeadline;
  if (!enRoute) v.waitFor = null;
  return enRoute;
}

/** Tier filter changed: nobody heads to, or stays at, a region with no shown hits. */
export function onTiersChanged(_appState) {
  const { sim } = _appState;
  if (!sim.on) return;
  for (const v of sim.visitors) {
    if (v.target?.bin != null && !visibleTraits(_appState, v.target.bin).length) {
      setTarget(v, pickTarget(_appState, v));
      v.recruitedBy = null;
    }
    if (v.active && !visibleTraits(_appState, v.dwellBin).length) {
      v.holdUntil = 0;
      v.waitFor = null;
      v.stayLeft = 0; // move on next step
    }
  }
}

function makeVisitor(_appState, id, pos) {
  const v = {
    id,
    pos,
    speed: rand(..._appState.sim.config.walkSpeed), // cruising speed
    vel: 0, // current speed along the leg
    target: null,
    stayLeft: 0,
    arrived: false,
    dwellBin: null,
    dwellMs: 0,
    movingMs: 0,
    active: false, // has an open cluster
    holdUntil: 0, // sim ms: stay at least until then (a link formed with another dweller)
    waitFor: null, // id of a visitor recruited to a linked region, while they are en route
    waitDeadline: 0,
    recruitedBy: null, // id of the dweller who recruited this visitor
  };
  setTarget(v, pickTarget(_appState, v));
  return v;
}

/** The open front of the room: the gap between the strip's two ends, where visitors walk in. */
function entrance(_appState) {
  const o = _appState.floorOutline;
  const a = o[0];
  const b = o[o.length - 1];
  const u = rand(0.3, 0.7);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + 0.5];
}

export function setVisitorCount(_appState, n) {
  const { sim } = _appState;
  sim.count = n;
  while (sim.visitors.length > n) {
    const v = sim.visitors.pop();
    if (v.active) setClusterFocus(_appState, owner(v), null);
  }
  while (sim.visitors.length < n) sim.visitors.push(makeVisitor(_appState, sim.nextId++, entrance(_appState)));
  _appState.onFocusChange?.();
}

export function startSimulation(_appState) {
  const { sim } = _appState;
  if (sim.on) return;
  sim.on = true;
  // The mouse's cluster closes; visitors drive the wall now.
  setClusterFocus(_appState, "mouse", null);
  if (_appState.assembly < 1) _appState.animateAssembly(1);
  setVisitorCount(_appState, sim.count);
  sim.last = performance.now();
  sim.uiLast = 0;
  sim.time = sim.time ?? 0;
  const frame = (now) => {
    if (!sim.on) return;
    const dt = Math.min(0.1, Math.max(0, (now - sim.last) / 1000)) * sim.speed; // sim seconds
    sim.last = now;
    // Walls only stand still once the room is assembled; before that, wait.
    if (_appState.assembly >= 0.999 && _appState.ribbon) step(_appState, dt);
    drawVisitors(_appState);
    _appState.onSimFrame?.();
    if (now - sim.uiLast > 250) {
      sim.uiLast = now;
      _appState.onFocusChange?.();
    }
    sim.raf = requestAnimationFrame(frame);
  };
  sim.raf = requestAnimationFrame(frame);
  _appState.onFocusChange?.();
}

export function stopSimulation(_appState) {
  const { sim } = _appState;
  if (!sim.on) return;
  sim.on = false;
  cancelAnimationFrame(sim.raf);
  for (const v of sim.visitors) if (v.active) setClusterFocus(_appState, owner(v), null);
  sim.visitors = [];
  animateBubbles(_appState); // the mouse's cluster comes back at the last hovered bin
  _appState.rebuildFloor();
  _appState.onFocusChange?.();
}

function step(_appState, dt) {
  const { sim } = _appState;
  const cfg = sim.config;
  sim.time += dt * 1000;
  for (const v of sim.visitors) {
    // ---- movement ----------------------------------------------------------------------------
    const before = v.pos;
    const [tx, ty] = v.target.pos;
    const dx = tx - v.pos[0];
    const dy = ty - v.pos[1];
    const dist = Math.hypot(dx, dy);
    if (dist > 0.02) {
      // Speed up from rest at `accel`, cruise, and brake on the stopping curve v = √(2·decel·d)
      // so the visitor eases into the target instead of arriving at full speed.
      const brake = Math.sqrt(2 * cfg.decel * dist);
      const desired = Math.min(v.speed, brake);
      v.vel = desired > v.vel ? Math.min(desired, v.vel + cfg.accel * dt) : desired;
      const stepLen = Math.min(dist, v.vel * dt);
      v.pos = [v.pos[0] + (dx / dist) * stepLen, v.pos[1] + (dy / dist) * stepLen];
    } else {
      v.vel = 0;
      if (!v.arrived) {
        v.arrived = true;
        v.stayLeft = v.target.stayMs;
      } else v.stayLeft -= dt * 1000;
      if (v.stayLeft <= 0 && !mustStay(_appState, v)) {
        v.recruitedBy = null;
        v.waitFor = null;
        setTarget(v, pickTarget(_appState, v));
      }
    }
    // ---- detection (positions only) ----------------------------------------------------------
    const speed = dt > 0 ? Math.hypot(v.pos[0] - before[0], v.pos[1] - before[1]) / dt : 0;
    const w = nearestWall(_appState, v.pos);
    // Snap to the nearest region with a shown hit within ±snapBins (as an installation would snap
    // to its nearest point of interest); none → not a dwell. Near a corner the nearest wall
    // point can sit a few bins off the region the visitor is facing.
    const bin = w && w.bin != null ? snapBin(_appState, w.bin) : null;
    const still = speed < cfg.stillSpeed && w && w.d <= cfg.dwellRange && bin != null;
    if (still) {
      v.movingMs = 0;
      if (v.dwellBin == null || Math.abs(bin - v.dwellBin) > 1) {
        if (v.active) setClusterFocus(_appState, owner(v), null);
        v.active = false;
        v.dwellBin = bin;
        v.dwellMs = 0;
      }
      v.dwellMs += dt * 1000;
      if (!v.active && v.dwellMs >= cfg.dwellTriggerMs) {
        v.active = true;
        setClusterFocus(_appState, owner(v), v.dwellBin);
        // Linked to another dweller: both hold for linkedHoldMs from now.
        for (const o of sim.visitors) {
          if (o !== v && o.active && linked(_appState, v.dwellBin, o.dwellBin)) {
            v.holdUntil = Math.max(v.holdUntil, sim.time + cfg.linkedHoldMs);
            o.holdUntil = Math.max(o.holdUntil, sim.time + cfg.linkedHoldMs);
            if (o.waitFor === v.id) o.waitFor = null; // the recruit arrived
          }
        }
        if (v.recruitedBy == null && Math.random() < cfg.recruitChance) recruit(_appState, v);
      }
    } else {
      v.movingMs += dt * 1000;
      if (!v.active) {
        v.dwellBin = null;
        v.dwellMs = 0;
      } else if (v.movingMs >= cfg.releaseMs) {
        v.active = false;
        setClusterFocus(_appState, owner(v), null);
        v.dwellBin = null;
        v.dwellMs = 0;
      }
    }
  }
}

/** Floor markers: a person pictogram and a dwell ring that fills as the dwell builds. */
function drawVisitors(_appState) {
  const { sim } = _appState;
  const self = _appState.fpv?.on && _appState.fpv.hideSelf ? _appState.fpv.visitorId : null;
  _appState.visitors = sim.visitors.map((v) => ({
    self: v.id === self, // followed in the first-person view: the camera is inside it
    position: [v.pos[0], v.pos[1], 0],
    active: v.active,
    dwell: v.active ? 1 : Math.min(1, v.dwellMs / sim.config.dwellTriggerMs),
  }));
  _appState.visitorViz.updatePlot();
}

/** Dwell ring path around a visitor: a circle drawn to fraction `dwell`. */
export function dwellRingPath(d, radius = 0.45, segments = 40) {
  const n = Math.max(1, Math.ceil(segments * d.dwell));
  const path = [];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 - (2 * Math.PI * d.dwell * i) / n;
    path.push([d.position[0] + radius * Math.cos(a), d.position[1] + radius * Math.sin(a), 0.01]);
  }
  return path;
}
