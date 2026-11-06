/**
 * Bubbles mode (?mode=bubbles): the chromosome band alone at head height, hint ticks over regions
 * with trait hits, and a cluster of trait bubbles that grows out of the focused region.
 *
 * Everything here is geometry in ribbon (s, t) coordinates, drawn by layers on the strip
 * visualizer, so the ribbon extension maps it onto the surface like the cells. Discs are polygons,
 * not scatter dots: a scatter disc is one quad and would cut across a bend as a chord.
 */
import { PathLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";

const HINT_LAYER_ID = "hintTickLayer";
const BRACKET_LAYER_ID = "bracketLayer";
const BRACKET_LABEL_LAYER_ID = "bracketLabelLayer";
const FAINT_ARC_LAYER_ID = "faintArcLayer";
const SHARED_LINK_LAYER_ID = "sharedLinkLayer";
const BUBBLE_TICK_LAYER_ID = "bubbleTickLayer";
const BUBBLE_LAYER_ID = "bubbleLayer";
const BUBBLE_LABEL_LAYER_ID = "bubbleLabelLayer";
const DISC_SEGMENTS = 40;

/** Bubble radius (m) for a trait. Log-scaled: area-true sizing would make height 47× blood type's radius. */
export function bubbleRadius(trait, { bubbleMinRadius, bubbleRadiusPerDecade }) {
  return bubbleMinRadius + bubbleRadiusPerDecade * Math.log10(Math.max(1, trait.geneCount));
}

/**
 * Greedy circle packing: largest first, each next circle tangent to two placed ones (or to the
 * first), at the candidate nearest the origin that overlaps nothing. Fine for ≤ 16 circles.
 * Returns positions centred on the enclosing circle, and its radius.
 */
export function packCircles(radii, pad = 0) {
  const order = radii.map((r, i) => i).sort((a, b) => radii[b] - radii[a]);
  const placed = [];
  const fits = (x, y, r) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + pad - 1e-9);
  for (const i of order) {
    const r = radii[i];
    if (!placed.length) {
      placed.push({ i, x: 0, y: 0, r });
      continue;
    }
    const candidates = [];
    if (placed.length === 1) {
      const p = placed[0];
      candidates.push([p.x + p.r + r + pad, p.y]);
    }
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) candidates.push(...tangentTo(placed[a], placed[b], r + pad));
      // Also around a single circle, in case no pair leaves room.
      const p = placed[a];
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * 2 * Math.PI;
        candidates.push([p.x + (p.r + r + pad) * Math.cos(ang), p.y + (p.r + r + pad) * Math.sin(ang)]);
      }
    }
    let best = null;
    for (const [x, y] of candidates) {
      if (!fits(x, y, r)) continue;
      const d = Math.hypot(x, y);
      if (!best || d < best.d) best = { x, y, d };
    }
    placed.push({ i, x: best.x, y: best.y, r });
  }
  // Recentre on the bounding box and measure the enclosing radius from there.
  const xs = placed.flatMap((p) => [p.x - p.r, p.x + p.r]);
  const ys = placed.flatMap((p) => [p.y - p.r, p.y + p.r]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const out = new Array(radii.length);
  let R = 0;
  for (const p of placed) {
    out[p.i] = { x: p.x - cx, y: p.y - cy };
    R = Math.max(R, Math.hypot(p.x - cx, p.y - cy) + p.r);
  }
  return { positions: out, radius: R };
}

/** Centres of a circle of radius r tangent to circles a and b (0 or 2 points). */
function tangentTo(a, b, r) {
  const ra = a.r + r;
  const rb = b.r + r;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > ra + rb || d < Math.abs(ra - rb)) return [];
  const along = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - along * along));
  const mx = a.x + (dx * along) / d;
  const my = a.y + (dy * along) / d;
  return [
    [mx - (dy * h) / d, my + (dx * h) / d],
    [mx + (dy * h) / d, my - (dx * h) / d],
  ];
}

function disc(cx, cy, r) {
  const ring = [];
  for (let k = 0; k < DISC_SEGMENTS; k++) {
    const a = (k / DISC_SEGMENTS) * 2 * Math.PI;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
// Overshoots slightly before settling: the "pop" of a bubble appearing.
const easeOutBack = (x) => {
  const c1 = 1.4;
  return 1 + (c1 + 1) * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/**
 * Hint ticks: one per bin with a hit in a visible tier, just outside the band on the bubble side.
 * Length grows with the number of traits hit; colour is the hit trait touching the fewest bins,
 * so a rare-trait region shows its warm colour over the blue of height.
 */
export function buildHintTicks(_appState) {
  const { layout, display, barWidth } = _appState;
  const above = layout.bubbleSide === "above";
  const edge = above ? _appState.stripPlotBottom + _appState.stripPlotHeight : _appState.stripPlotBottom;
  const sign = above ? 1 : -1;
  const ticks = [];
  for (const bin of _appState.bins) {
    const hits = _appState.traits.filter((t) => display.tiers.has(t.tier) && t.byBin.has(bin.index));
    if (!hits.length) continue;
    const rarest = hits.reduce((a, b) => (b.binCount < a.binCount ? b : a));
    const s = _appState.binS(bin.index);
    const w = barWidth * layout.hintTickWidth;
    const t0 = edge + sign * layout.hintTickGap;
    const t1 = t0 + sign * (layout.hintTickBase + layout.hintTickPerTrait * hits.length);
    ticks.push({ color: [..._appState.traitColors[rarest.index], 230], ring: [[s - w / 2, t0], [s + w / 2, t0], [s + w / 2, t1], [s - w / 2, t1]] });
  }
  _appState.hintTicks = ticks;
}

/**
 * One cluster for a bin: a bubble per trait hit there (visible tiers), packed and placed over (or
 * under) the bin, plus the bracket that ties it to the bin. Shrunk to fit the wall if needed, kept
 * on the strip, and nudged sideways off any other open cluster. Null if the bin has no visible
 * hits. `owner` is who opened it: "mouse" or a simulated visitor's id.
 *
 * Bracket: a stem from the band edge at the bin out to a bar; the bar spans the cluster's width,
 * with short end ticks turned toward the cluster. Bubbles emerge from the stem's end.
 */
function buildCluster(_appState, binIndex, owner) {
  const { layout, display } = _appState;
  if (binIndex == null) return null;
  const hits = _appState.traits
    .filter((t) => display.tiers.has(t.tier) && t.byBin.has(binIndex))
    .map((t) => ({ trait: t, hit: t.byBin.get(binIndex) }));
  if (!hits.length) return null;
  const radii = hits.map((h) => bubbleRadius(h.trait, layout));
  const { positions, radius } = packCircles(radii, layout.bubblePad);
  const above = layout.bubbleSide === "above";
  const sign = above ? 1 : -1;
  const edge = above ? _appState.stripPlotBottom + _appState.stripPlotHeight : _appState.stripPlotBottom;
  const avail = above
    ? _appState.room.height - layout.wallTopClear - (edge + layout.bubbleGap)
    : edge - layout.bubbleGap - layout.wallArcFloorMargin;
  const k = Math.min(1, avail / (2 * radius));
  const R = radius * k;
  const L = _appState.profiles.stripLength;
  const s0 = _appState.binS(binIndex);
  // Half-width of the packed cluster, then slide it off any open cluster it would overlap.
  const half = Math.max(...positions.map((q, i) => Math.abs(q.x) + radii[i])) * k;
  const clampS = (x) => Math.min(L - half, Math.max(half, x));
  const others = (_appState.bubbleClusters ?? []).filter((c) => c.dir === "in" && c.owner !== owner).map((c) => c.extent);
  let cs = clampS(s0);
  for (let pass = 0; pass < 8; pass++) {
    const hit = others.find(([a, z]) => cs + half + layout.clusterGap > a && cs - half - layout.clusterGap < z);
    if (!hit) break;
    const left = clampS(hit[0] - layout.clusterGap - half);
    const right = clampS(hit[1] + layout.clusterGap + half);
    cs = Math.abs(left - s0) <= Math.abs(right - s0) ? left : right;
  }
  const ct = edge + sign * (layout.bubbleGap + R);
  const barT = edge + sign * layout.bracketOffset;
  // Link-tick angles: one per other region with a hit for the trait, on the half of the bubble
  // away from the band (where the arcs go). Left/right quarter = that side of the genome; the
  // angle from straight out is linkTickMaxAngle·distance/L, so neighbours point straight out
  // and the strip's far ends toward the side. Capped short of horizontal so long arcs still
  // leave rising.
  const tickAngles = (trait) => {
    const out = [];
    for (const other of trait.byBin.keys()) {
      if (other === binIndex) continue;
      const ds = _appState.binS(other) - s0;
      const theta = (layout.linkTickMaxAngle * Math.abs(ds)) / L;
      out.push({ bin: other, angle: sign * (Math.PI / 2) - (ds >= 0 ? sign : -sign) * theta });
    }
    return out;
  };
  const targets = hits
    .map((h, i) => ({
      ...h,
      ticks: tickAngles(h.trait),
      binIndex,
      anchor: [s0, barT],
      x: cs + positions[i].x * k,
      y: ct + positions[i].y * k,
      r: radii[i] * k,
      color: _appState.traitColors[h.trait.index],
    }))
    .sort((a, b) => b.r - a.r); // largest first in, last out
  const sMin = Math.min(s0, ...targets.map((b) => b.x - b.r));
  const sMax = Math.max(s0, ...targets.map((b) => b.x + b.r));
  const { bracketStemMs, bracketBarMs, bubbleLeadMs, bubbleMs, bubbleStaggerMs } = layout;
  const end = Math.max(bracketStemMs + bracketBarMs, bubbleLeadMs + (targets.length - 1) * bubbleStaggerMs + bubbleMs);
  // Region span for the bracket-end labels (real coordinates: GRCh38, the bin's bounds).
  const bin = _appState.bins[binIndex];
  const fmt = (bp) => `chr${bin.chrom}:${bp.toLocaleString("en-US")}`;
  const span = [fmt(bin.start), fmt(bin.end)];
  const extent = [Math.min(...targets.map((b) => b.x - b.r)), Math.max(...targets.map((b) => b.x + b.r))];
  _appState._clusterSeq = (_appState._clusterSeq ?? 0) + 1;
  return { id: _appState._clusterSeq, owner, binIndex, targets, extent, bracket: { s0, edge, barT, sMin, sMax, sign, span }, g: 0, end, dir: "in" };
}

/**
 * Bracket geometry at timeline position g (ms): the stem grows out from the band, then the bar
 * spreads from the stem to both ends, the end ticks rising over the bar's last 30%. Thin quads in
 * (s, t); the bar is cut into short pieces so it bends with the surface.
 */
function bracketQuads(quads, labels, b, g, layout, color) {
  const { bracketStemMs, bracketBarMs, bracketWidth: w, bracketEndTick, hintTickGap } = layout;
  const stem = easeOutCubic(clamp01(g / bracketStemMs));
  if (stem <= 0) return;
  const t0 = b.edge + b.sign * hintTickGap;
  const t1 = t0 + (b.barT + (b.sign * w) / 2 - t0) * stem;
  quads.push({ color, ring: [[b.s0 - w / 2, t0], [b.s0 + w / 2, t0], [b.s0 + w / 2, t1], [b.s0 - w / 2, t1]] });
  const bar = easeOutCubic(clamp01((g - bracketStemMs) / bracketBarMs));
  if (bar <= 0) return;
  const a = b.s0 + (b.sMin - b.s0) * bar;
  const z = b.s0 + (b.sMax - b.s0) * bar;
  const n = Math.max(1, Math.ceil((z - a) / 0.2));
  for (let i = 0; i < n; i++) {
    const u0 = a + ((z - a) * i) / n;
    const u1 = a + ((z - a) * (i + 1)) / n;
    quads.push({ color, ring: [[u0, b.barT - w / 2], [u1, b.barT - w / 2], [u1, b.barT + w / 2], [u0, b.barT + w / 2]] });
  }
  const tick = clamp01((bar - 0.7) / 0.3);
  if (tick <= 0) return;
  // Region start and end just outside the bar's ends, fading in with the end ticks.
  const alpha = Math.round((color[3] ?? 255) * tick);
  const gap = layout.bracketLabelGap;
  labels.push({ text: b.span[0], position: [a - gap, b.barT, 0.01], anchor: "end", alpha });
  labels.push({ text: b.span[1], position: [z + gap, b.barT, 0.01], anchor: "start", alpha });
  const e0 = b.barT - (b.sign * w) / 2;
  const e1 = b.barT + b.sign * bracketEndTick * tick;
  for (const s of [a, z]) quads.push({ color, ring: [[s - w / 2, e0], [s + w / 2, e0], [s + w / 2, e1], [s - w / 2, e1]] });
}

/**
 * Open (or move) `owner`'s cluster at `binIndex`; null closes it. The owner's current cluster plays
 * its timeline backward (`bubbleExitSpeed`× faster) while the new one grows in. One animation
 * loop serves every cluster and stops when all are at rest.
 */
export function setClusterFocus(_appState, owner, binIndex) {
  const clusters = (_appState.bubbleClusters ||= []);
  for (const c of clusters) if (c.owner === owner) c.dir = "out";
  const next = buildCluster(_appState, binIndex, owner);
  if (next) clusters.push(next);
  runBubbleLoop(_appState);
}

/** Mouse focus changed: the mouse's cluster follows `focusBin`. */
export function animateBubbles(_appState) {
  setClusterFocus(_appState, "mouse", _appState.focusBin);
}

/** Tier filter changed: rebuild every open cluster at its bin. */
export function refreshClusters(_appState) {
  const open = (_appState.bubbleClusters ?? []).filter((c) => c.dir === "in").map((c) => [c.owner, c.binIndex]);
  for (const [owner, bin] of open) setClusterFocus(_appState, owner, bin);
}

/** Redraw the clusters once (e.g. the link style changed). */
export function redrawBubbles(_appState) {
  if (_appState.bubbleClusters) runBubbleLoop(_appState);
}

function runBubbleLoop(_appState) {
  const clusters = _appState.bubbleClusters;
  if (_appState._bubbleRaf) return; // loop already running
  _appState._bubbleLast = performance.now();
  const frame = (now) => {
    const { layout } = _appState;
    const dt = Math.max(0, now - _appState._bubbleLast);
    _appState._bubbleLast = now;
    let active = false;
    for (const c of clusters) {
      if (c.dir === "in") c.g = Math.min(c.end, c.g + dt);
      else c.g -= dt * layout.bubbleExitSpeed;
      if ((c.dir === "in" && c.g < c.end) || (c.dir === "out" && c.g > 0)) active = true;
    }
    for (let i = clusters.length - 1; i >= 0; i--) if (clusters[i].dir === "out" && clusters[i].g <= 0) clusters.splice(i, 1);

    // Pass 1: where every bubble is this frame.
    const brackets = [];
    const spanLabels = [];
    const placed = []; // { c, b, x, y, r, p }
    for (const c of clusters) {
      bracketQuads(brackets, spanLabels, c.bracket, c.g, layout, _appState.colors.bracket);
      c.targets.forEach((b, i) => {
        const p = clamp01((c.g - layout.bubbleLeadMs - i * layout.bubbleStaggerMs) / layout.bubbleMs);
        if (p <= 0) return;
        const m = easeOutCubic(p);
        placed.push({
          c,
          b,
          p,
          x: b.anchor[0] + (b.x - b.anchor[0]) * m,
          y: b.anchor[1] + (b.y - b.anchor[1]) * m,
          r: Math.max(0, b.r * easeOutBack(p)),
        });
      });
    }

    // Pass 2: traits present in two or more clusters. Each consecutive pair (oldest cluster
    // first) gets a link that grows from the older bubble toward the newer one as both appear,
    // and both bubbles get an outline.
    const byTrait = new Map();
    for (const q of placed) (byTrait.get(q.b.trait.key) ?? byTrait.set(q.b.trait.key, []).get(q.b.trait.key)).push(q);
    const shared = new Set();
    const links = [];
    for (const group of byTrait.values()) {
      if (group.length < 2) continue;
      group.sort((u, v) => u.c.id - v.c.id);
      for (const q of group) shared.add(q);
      for (let i = 0; i + 1 < group.length; i++) {
        const f = easeOutCubic(Math.min(group[i].p, group[i + 1].p));
        sharedLinkQuads(links, group[i], group[i + 1], f, _appState);
      }
    }
    _appState.sharedTraitKeys = [...byTrait].filter(([, g]) => g.length > 1).map(([k]) => k);

    // Link ticks: fade in over the second half of each bubble's entrance. Ticks aimed at the region
    // of another open cluster are longer and light.
    const openBins = new Set(clusters.filter((c) => c.dir === "in").map((c) => c.binIndex));
    const ticks = [];
    for (const q of placed) {
      const a = clamp01((q.p - 0.5) / 0.5);
      if (a <= 0 || !q.b.ticks.length) continue;
      const color = [...q.b.color, Math.round(170 * a)];
      const open = [..._appState.colors.linkTickOpen.slice(0, 3), Math.round(_appState.colors.linkTickOpen[3] * a)];
      const r0 = q.r + layout.linkTickGap;
      const hw = layout.linkTickWidth / 2;
      for (const { bin, angle } of q.b.ticks) {
        const isOpen = openBins.has(bin) && bin !== q.c.binIndex;
        const r1 = r0 + (isOpen ? layout.linkTickOpenLength : layout.linkTickLength);
        const cx = Math.cos(angle);
        const sy = Math.sin(angle);
        const px = -sy * hw;
        const py = cx * hw;
        ticks.push({
          color: isOpen ? open : color,
          ring: [
            [q.x + cx * r0 + px, q.y + sy * r0 + py],
            [q.x + cx * r1 + px, q.y + sy * r1 + py],
            [q.x + cx * r1 - px, q.y + sy * r1 - py],
            [q.x + cx * r0 - px, q.y + sy * r0 - py],
          ],
        });
      }
    }
    _appState.bubbleTicks = ticks;

    // Arcs mode: a faint arc from every tick to its region on the band, except regions of other
    // open clusters (those are the shared links above). Paths, not quads: a height bubble alone
    // has ~550, rebuilt every animation frame.
    const faint = [];
    if (_appState.display.bubbleLinks === "arcs") {
      const seg = arcSegments(_appState);
      for (const q of placed) {
        const a = clamp01((q.p - 0.5) / 0.5);
        if (a <= 0) continue;
        const color = [...q.b.color, Math.round(faintAlpha(_appState) * a)];
        for (const { bin } of q.b.ticks) {
          if (openBins.has(bin)) continue;
          const A = tickEnd(q, bin, layout.linkTickLength, layout);
          const B = bandEnd(_appState, bin, q.c.bracket.edge);
          const span = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
          faint.push({ color, path: cubicPoints(A, B, 1, Math.min(seg.faintMax, Math.max(8, Math.ceil((span * 1.4) / seg.faint))), _appState) });
        }
      }
    }
    _appState.faintArcs = faint;

    const drawn = [];
    const labels = [];
    for (const q of placed) {
      const { b, p, x, y, r } = q;
      if (shared.has(q)) drawn.push({ kind: "outline", ring: disc(x, y, r + layout.sharedOutline), fill: [..._appState.colors.sharedOutline, Math.round(230 * Math.min(1, p * 2))] });
      drawn.push({ ...b, kind: "bubble", ring: disc(x, y, r), fill: [...b.color, Math.round(235 * Math.min(1, p * 2))] });
      const textAlpha = Math.round(255 * clamp01((p - 0.6) / 0.4));
      if (textAlpha > 0) labels.push({ text: b.trait.shortLabel, position: [x, y, 0.01], size: labelSize(b.trait.shortLabel, b.r), alpha: textAlpha });
    }
    _appState.bubbleDraw = drawn;
    _appState.bubbleLabels = labels;
    _appState.bracketQuads = brackets;
    _appState.bracketLabels = spanLabels;
    _appState.sharedLinkQuads = links;
    _appState.stripViz?.updatePlot();
    _appState._bubbleRaf = active ? requestAnimationFrame(frame) : null;
  };
  _appState._bubbleRaf = requestAnimationFrame(frame);
}

/**
 * Arc piece lengths (m) along the curve. Screen mode is viewed up close (chromosome zoom), so its
 * arcs use much shorter pieces; arcs are rebuilt only while clusters animate, and Screen mode has
 * a single (mouse) cluster, so the extra points are affordable there.
 */
function arcSegments(_appState) {
  const screen = (_appState.assemblyTarget ?? _appState.assembly) < 0.5;
  return screen ? { faint: 0.12, faintMax: 160, shared: 0.08 } : { faint: 0.5, faintMax: 40, shared: 0.2 };
}

/**
 * Faint-arc opacity (of 255). Screen mode has one (mouse) cluster, so its arcs never become shared
 * links; draw them more opaque there.
 */
function faintAlpha(_appState) {
  const screen = (_appState.assemblyTarget ?? _appState.assembly) < 0.5;
  return screen ? _appState.layout.faintArcAlphaScreen : _appState.layout.faintArcAlpha;
}

/** End of a link at the tip of bubble q's tick toward `otherBin` (or its far side if none). */
function tickEnd(q, otherBin, length, layout) {
  const sign = layout.bubbleSide === "above" ? 1 : -1;
  const t = q.b.ticks.find((k) => k.bin === otherBin);
  const angle = t ? t.angle : sign * (Math.PI / 2);
  const dir = [Math.cos(angle), Math.sin(angle)];
  const d = q.r + layout.linkTickGap + (t ? length : 0);
  return { p: [q.x + dir[0] * d, q.y + dir[1] * d], dir };
}

/** End of a link on the band at a region, arriving straight in from the bubble side. */
function bandEnd(_appState, bin, edge) {
  const sign = _appState.layout.bubbleSide === "above" ? 1 : -1;
  return { p: [_appState.binS(bin), edge], dir: [0, sign] };
}

/**
 * Points of a cubic from end A to end B, its handles along each end's direction (so it leaves A
 * and arrives at B in those directions). Handle length grows with the distance between the
 * ends and is cut so the curve stays on the wall. The first fraction f, in about n pieces.
 */
function cubicPoints(A, B, f, n, _appState) {
  const { layout } = _appState;
  const sign = layout.bubbleSide === "above" ? 1 : -1;
  const limit = sign > 0 ? _appState.room.height - 0.1 : 0.1;
  const span = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
  const handle = (E) => {
    let k = Math.max(layout.sharedLinkMinHandle, layout.sharedLinkHandle * span);
    if (E.dir[1] * sign > 1e-6) k = Math.min(k, Math.max(0, (limit - E.p[1]) / E.dir[1]));
    return [E.p[0] + E.dir[0] * k, E.p[1] + E.dir[1] * k];
  };
  const c1 = handle(A);
  const c2 = handle(B);
  const m = Math.max(1, Math.ceil(n * f));
  const pts = [];
  for (let i = 0; i <= m; i++) {
    const u = Math.min(f, i / n);
    const v = 1 - u;
    const w0 = v * v * v;
    const w1 = 3 * v * v * u;
    const w2 = 3 * v * u * u;
    const w3 = u * u * u;
    pts.push([w0 * A.p[0] + w1 * c1[0] + w2 * c2[0] + w3 * B.p[0], w0 * A.p[1] + w1 * c1[1] + w2 * c2[1] + w3 * B.p[1]]);
  }
  return pts;
}

/**
 * Link between two bubbles of the same trait in different clusters (a older, b newer). Starts
 * at the tip of a's tick toward b's region.
 *  - ticks mode: grows from a to the matching tick on b as both appear (fraction f).
 *  - arcs mode: a's faint arc to b's region already exists, so this is that arc shifting: its
 *    far end slides from b's region on the band to b's tick, and it brightens, by f.
 * Thin quads in (s, t), ≤ 0.2 m each.
 */
function sharedLinkQuads(quads, a, b, f, _appState) {
  if (f <= 0) return;
  const { layout } = _appState;
  const arcs = _appState.display.bubbleLinks === "arcs";
  const A = tickEnd(a, b.c.binIndex, layout.linkTickOpenLength, layout);
  let B = tickEnd(b, a.c.binIndex, layout.linkTickOpenLength, layout);
  let draw = f;
  let alpha = 220;
  if (arcs) {
    const band = bandEnd(_appState, b.c.binIndex, b.c.bracket.edge);
    const dx = band.dir[0] + (B.dir[0] - band.dir[0]) * f;
    const dy = band.dir[1] + (B.dir[1] - band.dir[1]) * f;
    const len = Math.hypot(dx, dy) || 1;
    B = { p: [band.p[0] + (B.p[0] - band.p[0]) * f, band.p[1] + (B.p[1] - band.p[1]) * f], dir: [dx / len, dy / len] };
    draw = 1;
    const fa = faintAlpha(_appState);
    alpha = Math.round(fa + (220 - fa) * f);
  }
  const span = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
  const pts = cubicPoints(A, B, draw, Math.max(16, Math.ceil((span * 1.4) / arcSegments(_appState).shared)), _appState);
  const w = layout.sharedLinkWidth / 2;
  const color = [...a.b.color, alpha];
  const side = pts.map((p, i) => {
    const q0 = pts[Math.max(0, i - 1)];
    const q1 = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
    const nx = (-(q1[1] - q0[1]) / len) * w;
    const ny = ((q1[0] - q0[0]) / len) * w;
    return [[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny]];
  });
  for (let i = 0; i + 1 < pts.length; i++) quads.push({ color, ring: [side[i][0], side[i + 1][0], side[i + 1][1], side[i][1]] });
}

// Fit the label across ~85% of the bubble's diameter (glyphs ≈ 0.6 em wide), capped.
function labelSize(text, r) {
  return Math.min(r * 0.45, (2 * r * 0.85) / (0.6 * text.length));
}

/** Hint ticks, brackets, bubbles, and bubble labels as layers on the strip. Added before the first update(). */
export function addBubbleLayers(viz, _appState) {
  const add = (id, data, make) => {
    const qid = viz.constructUniqueInstanceLayerId(id);
    viz.appState.addLayer(
      new LayerDescription(
        id,
        data,
        (rows, props = {}) => {
          const { enabled, ...passthrough } = props;
          return make(qid, rows, passthrough);
        },
        { enabled: true },
      ),
    );
  };
  add(HINT_LAYER_ID, () => _appState.hintTicks, (id, data, passthrough) =>
    new SolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => d.color,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(BRACKET_LABEL_LAYER_ID, () => _appState.bracketLabels, (id, data, passthrough) =>
    new TextLayer({
      ...passthrough,
      id,
      data,
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      getSize: _appState.layout.bracketLabelSize,
      sizeUnits: "common",
      getColor: (d) => [..._appState.colors.bracket.slice(0, 3), d.alpha],
      getTextAnchor: (d) => d.anchor,
      getAlignmentBaseline: "center",
      fontFamily: "Helvetica, Arial, sans-serif",
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(BRACKET_LAYER_ID, () => _appState.bracketQuads, (id, data, passthrough) =>
    new SolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => d.color,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(FAINT_ARC_LAYER_ID, () => _appState.faintArcs, (id, data, passthrough) =>
    // Not billboarded, widths in world units: the path's width offset is then added before the
    // ribbon hook (deck PathLayer vertex shader), so the paths map onto the surface.
    new PathLayer({
      ...passthrough,
      id,
      data,
      getPath: (d) => d.path,
      getColor: (d) => d.color,
      getWidth: _appState.layout.faintArcWidth,
      widthUnits: "common",
      billboard: false,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(SHARED_LINK_LAYER_ID, () => _appState.sharedLinkQuads, (id, data, passthrough) =>
    new SolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => d.color,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(BUBBLE_TICK_LAYER_ID, () => _appState.bubbleTicks, (id, data, passthrough) =>
    new SolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => d.color,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
  add(BUBBLE_LAYER_ID, () => _appState.bubbleDraw, (id, data, passthrough) =>
    new SolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => d.fill,
      pickable: true, // tooltip; hovering a bubble does not move the focus
      parameters: { depthTest: false },
    }),
  );
  add(BUBBLE_LABEL_LAYER_ID, () => _appState.bubbleLabels, (id, data, passthrough) =>
    new TextLayer({
      ...passthrough,
      id,
      data,
      getText: (d) => d.text,
      getPosition: (d) => d.position,
      getSize: (d) => d.size,
      sizeUnits: "common",
      getColor: (d) => [...(_appState.colors.bubbleText), d.alpha],
      getTextAnchor: "middle",
      getAlignmentBaseline: "center",
      fontFamily: "Helvetica, Arial, sans-serif",
      fontWeight: 600,
      pickable: false,
      parameters: { depthTest: false },
    }),
  );
}
