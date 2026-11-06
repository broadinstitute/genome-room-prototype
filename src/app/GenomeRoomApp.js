import { DemoApp } from "pattern-app-kit/core";
import { OrbitView } from "@deck.gl/core";
import { VisualizerDeckManager } from "viz_sandbox/js/deck_manager/deck_manager";
import { makeGenomeBins, makeGwasTraits, formatBp, TRAIT_TIERS } from "./genome.js";
import GWAS_TRAITS from "./gwas_traits.json";
import {
  makeProfiles,
  lerpProfile,
  buildCenterline,
  centerAt,
  ribbonPoint,
  ribbonUniforms,
  ribbonCoordinateAtPixel,
} from "./ribbon.js";
import { makeStripViz, applyRibbon } from "./strip_setup.js";
import { makeFloorViz, makeVisitorViz, floorArcPath } from "./floor_setup.js";
import { mountControls } from "./controls.js";
import { buildHintTicks, animateBubbles, refreshClusters, redrawBubbles } from "./bubbles.js";
import { startSimulation, stopSimulation, setVisitorCount, onTiersChanged } from "./visitors.js";
import { setFirstPerson, nextVisitor, updateFirstPerson } from "./first_person.js";

// Colour families by architecture tier (genome.js TRAIT_TIERS): warm = one or a few regions,
// green = dozens, blue/violet = hundreds. Within a family, colours are assigned in trait order.
const TIER_COLORS = {
  few: [[255, 99, 71], [255, 150, 30], [255, 205, 60], [235, 60, 110], [255, 175, 130], [250, 230, 130], [205, 120, 60]],
  dozens: [[80, 200, 120], [40, 180, 170], [160, 220, 80], [110, 230, 205], [70, 150, 95], [195, 240, 160]],
  many: [[90, 150, 255], [175, 125, 255], [130, 205, 255]],
};

const ARC_MODES = ["floor", "wall", "drop", "none"];
// Default trait density "Medium": the two rarest tiers (few, dozens). URL ?tiers= overrides.
export const DEFAULT_TIERS = TRAIT_TIERS.slice(0, 2).map((t) => t.key);
// Wall height limits, metres. The low end leaves the genome strip 1.2 m (base 0.8 + top margin 1.0).
const WALL_HEIGHT_RANGE = [3, 15];

const smoothstep = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
const lerp = (a, b, k) => a + (b - a) * k;

// A half-ellipse in ribbon (s, t) from s0 to s1, hanging `depth` below `top`, as quads at most
// ~0.2 m long so no edge cuts across a bend. Vertex normals are shared between neighbouring quads,
// so the joints have no gaps or overlaps.
function wallArcQuads(quads, s0, s1, top, depth, width, color) {
  const n = Math.max(8, Math.ceil(Math.abs(s1 - s0) / 0.2));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push([lerp(s0, s1, u), top - depth * Math.sin(Math.PI * u)]);
  }
  const side = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / len) * (width / 2);
    const ny = ((b[0] - a[0]) / len) * (width / 2);
    return [[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny]];
  });
  for (let i = 0; i < n; i++) {
    quads.push({ color, at: i / n, ring: [side[i][0], side[i + 1][0], side[i + 1][1], side[i][1]] });
  }
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

/** The first fraction f (0..1) of a polyline, ending on an interpolated point. */
function truncatePath(path, f) {
  if (f >= 1) return path;
  const x = f * (path.length - 1);
  const i = Math.floor(x);
  const a = path[i];
  const b = path[Math.min(i + 1, path.length - 1)];
  const u = x - i;
  return [...path.slice(0, i + 1), [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]];
}

export class GenomeRoomApp extends DemoApp {
  static getTitle() {
    return "Genome Room";
  }
  static getDescription() {
    return "A genome strip mapped onto room-scale surfaces, with region-to-region links on the floor.";
  }

  constructor(containerId, onLoadCallback, appConfig = {}) {
    super();
    this.containerId = containerId;
    this.appConfig = appConfig;
  }

  init(initCallback) {
    this.appState = this.makeApp();
    this.initialized = true;
    if (initCallback) initCallback(this);
  }

  makeApp() {
    const params = new URLSearchParams(window.location.search);

    const _appState = {
      plots: [],
      vizDeckManager: null,
      viewInset: null, // { top, left, headerBottom } px: canvas the exhibit header covers (see fitViewState)
      floorViz: null,
      visitorViz: null, // drawn after the strip, so people stay in front of the wall content
      stripViz: null,

      // Physical room, metres. Unknown for the real space — free parameters. The shapes are
      // built from width and depth; the strip length (2·depth + width) is the same for all.
      // Height (the walls) is adjustable: URL ?wall=<metres>, clamped to WALL_HEIGHT_RANGE.
      room: {
        width: 24,
        depth: 16,
        height: Math.min(WALL_HEIGHT_RANGE[1], Math.max(WALL_HEIGHT_RANGE[0], Number(params.get("wall")) || 12)),
      },
      wallHeightRange: WALL_HEIGHT_RANGE,
      layout: {
        binSizeBp: 5e6,
        wallBaseHeight: 0.8, // genome strip starts this far above the floor
        wallTopMargin: 1.0, // and stops this far below the top of the wall
        stripHeight: null, // derived below: room.height − wallBaseHeight − wallTopMargin
        columnLabelSize: 0.3,
        columnLabelGap: 0.06, // band edge to the near edge of the chromosome labels
        chromZoomBelow: 0.7, // chromosome zoom frames from this far under the band (labels)
        chromZoomAbove: 2.0, // to this far above it (most of a bubble cluster; width usually governs)
        chromZoomPadding: 0.45, // zoom margin (log2) around the chromosome
        chromLabelHoverScale: 1.25, // Screen mode: hovered chromosome label grows (a click target)
        rowLabelMargin: 3.2, // start of the strip, reserved for trait row labels (set to stripSideMargin without them)
        stripSideMargin: 1.6, // trait rows hidden (no row labels): this much padding at both ends
        stripEndMargin: 0, // derived: padding after the last bin
        visitorInset: 0.9, // where the stand-in visitor stands, in front of the surface
        // Links grow out of the focus; a link's duration grows with its length (strip distance
        // between the two regions), so long arcs arrive later. Each eases out on its own clock.
        arcGrowMinMs: 250,
        arcGrowMsPerMetre: 22, // ~1.4 s for the longest (~53 m) link
        dropLineMs: 180, // drop mode: focus line drops first
        riseLineMs: 160, // then, as each floor arc lands, its line rises to the linked region
        arcFadeMs: 350, // and fade out over this long when the focus moves
        flatArcDepth: 0.3, // flat arc diagram: control-point depth as a fraction of arc span
        cornerArm: 0.6, // registration brackets at the physical room's corners, metres per arm
        wallLineWidth: 0.035, // wall arcs and drop lines, metres on the surface
        wallArcGap: 0.05, // wall arcs start this far below the genome
        wallArcFloorMargin: 0.1, // and stop at least this far above the floor
        // Bubbles mode (?mode=bubbles). Band centred at head height; URL ?head=<metres>.
        headHeight: Number(params.get("head")) || 1.6,
        headBandHeight: 0.3, // band height in bubbles mode unless ?band= is given
        bubbleSide: params.get("bubbles") === "below" ? "below" : "above", // URL ?bubbles=above|below
        bubbleMinRadius: 0.12, // m, a trait with one gene
        bubbleRadiusPerDecade: 0.16, // m added per 10× genes
        bubblePad: 0.12, // gap between bubbles (room for the link ticks)
        bubbleGap: 0.45, // band edge to cluster edge
        bracketOffset: 0.3, // band edge to the bracket bar (clears most hint ticks)
        bracketEndTick: 0.1, // end ticks, from the bar toward the cluster
        bracketWidth: 0.025, // line width on the surface, m
        bracketLabelSize: 0.07, // region start/end at the bar's ends, m — legible up close only
        bracketLabelGap: 0.05, // bar end to label
        bracketStemMs: 120, // stem grows out from the band
        bracketBarMs: 200, // then the bar spreads to the cluster's width
        bubbleLeadMs: 200, // bubbles start this long after the stem
        bubbleExitSpeed: 1.8, // exit plays the timeline backward this much faster
        wallTopClear: 0.2, // cluster stays this far below the top of the wall
        bubbleMs: 520, // one bubble's grow-in
        bubbleStaggerMs: 60, // delay between bubbles, largest first
        hintTickWidth: 0.5, // fraction of a bin
        hintTickGap: 0.03, // band edge to tick
        hintTickBase: 0.05, // tick length for one trait, m
        hintTickPerTrait: 0.025, // added per further trait
        clusterGap: 0.25, // open clusters are nudged at least this far apart along the wall
        sharedOutline: 0.035, // outline on bubbles whose trait is in another open cluster
        // Link ticks round each bubble: one per other region where its trait has a hit, on the
        // half away from the band. Left/right = that side of the genome; the angle from straight
        // out grows with distance, up to linkTickMaxAngle.
        linkTickMaxAngle: (70 * Math.PI) / 180,
        linkTickGap: 0.045, // bubble edge to tick
        linkTickLength: 0.05,
        linkTickOpenLength: 0.11, // ticks aimed at another open cluster's region
        linkTickWidth: 0.01,
        faintArcAlpha: 26, // arcs mode: tick → region arcs, out of 255
        faintArcWidth: 0.012, // m
        sharedLinkWidth: 0.03, // link between same-trait bubbles in different clusters
        sharedLinkHandle: 0.35, // cubic handle length along each end's tick, × distance between ends
        sharedLinkMinHandle: 0.3, // m
      },
      // Assembly: 0 = one flat strip, 1 = standing and bent into the current shape. The strip
      // stands up first, then bends; the phases overlap slightly.
      assemblySchedule: { stand: [0, 0.55], bend: [0.45, 1] },
      camera: { roomRotationX: 30, flatRotationX: 90, roomRotationOrbit: -35, padding: 0.3 },
      animationMs: 1600,
      backfaceAlpha: 0.1, // surface seen from behind (dollhouse cutaway)

      colors: {
        text: [225, 230, 240],
        background: [22, 24, 32], // page/canvas
        floor: [28, 30, 38],
        // Light, transparent, and cooler than the floor so the two read as different surfaces.
        wallSurface: [150, 170, 220, 22],
        cornerMarks: [150, 150, 150, 120], // neutral grey: a frame means nothing by its hue
        band: [[70, 80, 110], [120, 130, 165]],
        empty: [36, 40, 52],
        visitor: [240, 240, 240],
        bubbleText: [18, 20, 28],
        bracket: [205, 210, 222, 210],
        sharedOutline: [240, 242, 248],
        linkTickOpen: [240, 242, 248, 240],
        visitorIdle: [150, 155, 170], // simulated visitor not dwelling
      },
      traitColors: [], // per trait index, assigned from TIER_COLORS once the traits are built
      gwasSource: GWAS_TRAITS.source,
      defaultTiers: DEFAULT_TIERS,
      probeScatter: params.get("probe") === "scatter",
      // What the strip shows. URL: ?tracks=none drops the trait rows (traits still drive the
      // floor arcs); the chromosome band then takes the full strip height.
      // bandHeight (m) applies when the trait tracks are hidden; null = one trait row's height,
      // so hiding the tracks leaves the band unchanged. URL: ?band=<metres> or ?band=full.
      // With tracks shown, every row (band included) is stripHeight / (traits + 1).
      display: {
        // "bubbles" (default): the band alone at head height, hint ticks, and a trait-bubble
        // cluster at each focus. "tracks": the genome with trait rows. URL ?mode=tracks.
        mode: params.get("mode") === "tracks" ? "tracks" : "bubbles",
        traitTracks: params.get("tracks") !== "none" && params.get("mode") === "tracks",
        bandHeight: params.get("band") === "full" ? "full" : Number(params.get("band")) || null,
        // Where a focused region's links are drawn. URL: ?arcs=floor|wall|drop.
        //   floor — arcs across the floor between the regions' wall bases
        //   wall  — arcs on the wall surface, hanging below the genome
        //   drop  — floor arcs plus a line down the wall from each region to its arc's end
        //   none  — no links (default in bubbles mode)
        // Bubbles mode link style. "ticks": ticks round each bubble, arcs only between open
        // clusters. "arcs": also a faint arc from each tick to its region on the band, which
        // shifts to the other bubble when that region's cluster opens (default). URL ?links=ticks|arcs.
        bubbleLinks: params.get("links") === "ticks" ? "ticks" : "arcs", // default: faint arcs
        arcs: ARC_MODES.includes(params.get("arcs")) ? params.get("arcs") : params.get("mode") === "tracks" ? "floor" : "none",
        // Trait tiers whose links are drawn (genome.js TRAIT_TIERS). URL: ?tiers=few,dozens.
        // Default: DEFAULT_TIERS. The strip's cells are not filtered.
        tiers: new Set(
          params.get("tiers")
            ? params.get("tiers").split(",").filter((k) => TRAIT_TIERS.some((t) => t.key === k))
            : DEFAULT_TIERS,
        ),
      },

      assembly: 0,
      shapeName: "room",
      shapeFrom: null, // profile snapshots for the shape morph
      shapeTo: null,
      shapeK: 1,
      ribbon: null, // current ribbon state { segs, length, stand, axisY }
      floorOutline: [],
      floorCenter: [0, 0],
      focusBin: null,
      focusLinks: [],
      linkSets: [], // { focusBin, links, maxGrowMs, g, fadeG, alpha, dir }: the entering set + fading ones
      linkFrame: 0, // bumps each animation frame; the wall-link colour update trigger
      floorArcs: [],
      wallLinkQuads: [], // wall arcs / drop lines, in ribbon (s, t) coordinates
      hintTicks: [], // bubbles mode, ribbon (s, t)
      bubbleDraw: [], // bubbles mode: discs as drawn this frame
      bubbleLabels: [],
      bracketQuads: [], // bubbles mode: bracket as drawn this frame
      bracketLabels: [], // region start/end at the bracket's ends
      bubbleClusters: [], // entering + exiting clusters, one open per owner (mouse or visitor)
      sharedLinkQuads: [], // links between same-trait bubbles in different clusters
      bubbleTicks: [], // link ticks round the bubbles, as drawn this frame
      faintArcs: [], // arcs mode: tick → region paths
      sharedTraitKeys: [],
      // First-person view: the camera rides with one simulated visitor. URL ?fpv=1.
      fpv: {
        on: false,
        visitorId: null,
        fovy: Math.min(120, Math.max(30, Number(params.get("fov")) || 85)), // degrees, vertical. URL ?fov=
        orthoFovy: 0.5, // transition end at the orbit view: perspective this narrow looks orthographic
        focusDistance: 3, // m: first-person look-at point, for the transition
        transitionMs: 1800,
        transition: null, // { dir: "in" | "out", u } while the camera moves between views
        eyeHeight: 1.6, // m
        turnSeconds: 0.5, // heading and pitch ease toward their targets with this time constant
        walkingSpeed: 0.15, // m/s: faster than this counts as walking (look along the walk)
        walkElevation: 4, // degrees up while walking
        approachElevation: 12, // standing at a region, before the cluster opens
        dwellElevation: 26, // cluster open: look up toward the bubbles
        savedView: null, // orbit camera to restore
      },
      // Simulated visitors (bubbles mode). URL: ?sim=1&visitors=<n>&simSpeed=<×>.
      sim: {
        on: false,
        count: Math.min(20, Math.max(1, Number(params.get("visitors")) || 10)),
        speed: Math.min(8, Math.max(0.25, Number(params.get("simSpeed")) || 2.5)),
        visitors: [],
        nextId: 1,
        config: {
          walkSpeed: [0.9, 1.4], // m/s, cruising
          accel: 0.8, // m/s², setting off
          decel: 0.6, // m/s², braking into a stop (from 1.2 m/s: ~1.2 m, ~2 s)
          standOff: [0.8, 1.4], // target distance in front of the wall, m
          // Time at a region: stay ±40%, seconds. URL ?stay=<seconds>, or the Stay control.
          stay: Math.min(120, Math.max(1, Number(params.get("stay")) || 12)),
          passStayMs: [500, 2000], // on open floor
          passThroughChance: 0.2,
          exclusionBins: 4, // regions within this many bins of another visitor's are not picked
          // Target weights by the rarest shown trait in the region; regions with no shown hit: 0.
          weightByTier: { few: 8, dozens: 3, many: 1 },
          // When a visitor starts dwelling, a free visitor is sent to a linked region (this often),
          // and the dweller waits for them: walking time + this slack + the dwell trigger.
          recruitChance: 0.8,
          recruitSlackMs: 4000,
          linkedHoldMs: 6000, // two linked dwellers both stay at least this long once linked
          // Detection (positions only)
          dwellRange: 2.2, // within this far of the wall, m
          stillSpeed: 0.25, // and slower than this, m/s
          dwellTriggerMs: 1500, // for this long in front of the same region (±1 bin) → open
          snapBins: 3, // a dwell snaps to the nearest region with a shown hit within this many bins
          releaseMs: 600, // moving for this long → close
        },
      },
      visitors: [],
      readout: null,

      cellColor: (d) => {
        if (d.kind === "band") return _appState.colors.band[d.bin.chromIndex % 2];
        if (!(d.value > 0)) return _appState.colors.empty;
        const c = _appState.traitColors[d.trait.index];
        const k = 0.35 + 0.65 * d.value;
        const e = _appState.colors.empty;
        return [lerp(e[0], c[0], k), lerp(e[1], c[1], k), lerp(e[2], c[2], k)];
      },

      // ---- ribbon state ------------------------------------------------------------------
      phases: (t = _appState.assembly) => {
        const { stand, bend } = _appState.assemblySchedule;
        return {
          stand: (Math.PI / 2) * smoothstep((t - stand[0]) / (stand[1] - stand[0])),
          bend: smoothstep((t - bend[0]) / (bend[1] - bend[0])),
        };
      },
      currentProfile: (k = _appState.shapeK) => lerpProfile(_appState.shapeFrom, _appState.shapeTo, k),

      // Ribbon + floor outline for an assembly/shape state. Pure: the camera uses it to fit the
      // END state of an animation before any frame is drawn.
      geometry: ({ assembly = _appState.assembly, shapeK = _appState.shapeK } = {}) => {
        const { stand, bend } = _appState.phases(assembly);
        const anchor = [_appState.room.width / 2, _appState.room.depth];
        const { segs, length } = buildCenterline(_appState.currentProfile(shapeK), bend, anchor);
        // Floor = the standing centerline, closed across the open end.
        const floorOutline = [];
        for (let s = 0; s <= length; s += 0.5) {
          const c = centerAt(segs, s);
          floorOutline.push([c.x, c.y]);
        }
        return {
          ribbon: { segs, length, stand, axisY: anchor[1] },
          floorOutline,
          floorCenter: [
            floorOutline.reduce((a, p) => a + p[0], 0) / floorOutline.length,
            floorOutline.reduce((a, p) => a + p[1], 0) / floorOutline.length,
          ],
        };
      },

      // Recompute the ribbon from assembly + shape, push it to the strip, rebuild the floor.
      update: () => {
        Object.assign(_appState, _appState.geometry());
        applyRibbon(_appState.stripViz, ribbonUniforms(_appState.ribbon, _appState.backfaceAlpha));
        _appState.rebuildFloor();
      },

      floorOpacity: () => _appState.phases().bend,

      // ---- strip <-> floor geometry --------------------------------------------------------
      binS: (binIndex) => _appState.layout.rowLabelMargin + (binIndex + 0.5) * _appState.barWidth,

      // Bottom-edge point of a bin on the surface, stepped `inset` in front of it: below the
      // strip when flat, into the room once standing.
      binEdgePoint: (binIndex, inset = 0) => {
        const s = _appState.binS(binIndex);
        const { point } = ribbonPoint(_appState.ribbon, s, 0);
        const { h } = centerAt(_appState.ribbon.segs, s);
        const k = _appState.assembly;
        const dx = lerp(0, Math.sin(h), k);
        const dy = lerp(-1, -Math.cos(h), k);
        const len = Math.hypot(dx, dy) || 1;
        return [point[0] + (dx / len) * inset, point[1] + (dy / len) * inset, point[2]];
      },

      setFocusBin: (binIndex) => {
        if (binIndex === _appState.focusBin) return;
        _appState.focusBin = binIndex;
        _appState.rebuildLinks();
        if (_appState.display.mode === "bubbles" && !_appState.sim.on) animateBubbles(_appState);
      },

      // ---- simulated visitors (bubbles mode) -------------------------------------------------
      setSimulation: (on) => {
        if (on) return startSimulation(_appState);
        setFirstPerson(_appState, false);
        stopSimulation(_appState);
      },
      setFirstPerson: (on) => setFirstPerson(_appState, on),
      nextVisitor: () => nextVisitor(_appState),
      onSimFrame: () => updateFirstPerson(_appState),
      setVisitorCount: (n) => setVisitorCount(_appState, n),
      setSimSpeed: (x) => {
        _appState.sim.speed = x;
      },
      setBubbleLinks: (mode) => {
        _appState.display.bubbleLinks = mode;
        redrawBubbles(_appState);
        _appState.onStateChange?.();
      },
      setStay: (seconds) => {
        _appState.sim.config.stay = seconds;
      },

      setTierVisible: (tier, visible) => {
        const tiers = new Set(_appState.display.tiers);
        if (visible) tiers.add(tier);
        else tiers.delete(tier);
        _appState.setTiers([...tiers]);
      },

      // Show exactly these tiers (one rebuild, however many changed).
      setTiers: (keys) => {
        _appState.display.tiers = new Set(keys);
        _appState.onStateChange?.();
        _appState.rebuildLinks();
        if (_appState.display.mode === "bubbles") {
          buildHintTicks(_appState);
          refreshClusters(_appState);
          onTiersChanged(_appState);
        }
      },

      // Links from the focus bin to every other bin sharing a trait in a visible tier. Each
      // focus change starts a new link SET that grows out of the focus; earlier sets fade out.
      rebuildLinks: () => {
        const binIndex = _appState.focusBin;
        if (binIndex == null) return;
        const links = [];
        for (const trait of _appState.traits) {
          if (!_appState.display.tiers.has(trait.tier) || !(trait.values[binIndex] > 0)) continue;
          const color = [..._appState.traitColors[trait.index], 200];
          for (const bin of _appState.bins) {
            if (bin.index === binIndex || !(trait.values[bin.index] > 0)) continue;
            links.push({ trait, bin, color });
          }
        }
        const { arcGrowMinMs, arcGrowMsPerMetre } = _appState.layout;
        const s0 = _appState.binS(binIndex);
        for (const link of links) link.growMs = arcGrowMinMs + arcGrowMsPerMetre * Math.abs(_appState.binS(link.bin.index) - s0);
        // Draw order: the most polygenic traits first, so a few-locus trait's links sit on top
        // of the hundreds that height brings with it.
        links.sort((p, q) => q.trait.binCount - p.trait.binCount);
        _appState.focusLinks = links;
        for (const set of _appState.linkSets) set.dir = "out";
        const maxGrowMs = links.reduce((m, l) => Math.max(m, l.growMs), 0);
        _appState.linkSets.push({ focusBin: binIndex, links, maxGrowMs, g: 0, fadeG: 0, alpha: 1, dir: "in" });
        _appState.rebuildWallLinks();
        _appState.rebuildFloor();
        _appState.animateLinks();
        _appState.onFocusChange?.();
      },

      setArcMode: (mode) => {
        _appState.display.arcs = mode;
        _appState.rebuildWallLinks();
        _appState.rebuildFloor();
        _appState.onStateChange?.();
      },

      // Set timeline offsets (ms). Drop mode runs in sequence: the focus line drops, each floor
      // arc grows on its own duration, then a line rises at that arc's linked region.
      linkTiming: () => {
        const drop = _appState.display.arcs === "drop";
        const { dropLineMs, riseLineMs } = _appState.layout;
        return { arcStart: drop ? dropLineMs : 0, drop: dropLineMs, rise: drop ? riseLineMs : 0 };
      },
      // Fraction of a link's arc drawn at set time g: eased out on the link's own duration.
      linkGrowth: (link, g, arcStart) => easeOutCubic(Math.min(1, Math.max(0, (g - arcStart) / link.growMs))),

      // One loop for all link sets: advance grow (entering) or fade (exiting), drop finished
      // sets, redraw. Floor arcs are cut to length per frame; wall quads keep their geometry and
      // only their colours change (re-tessellating ~20k quads per frame would cost 35–50 ms).
      animateLinks: () => {
        if (_appState._linkRaf) return;
        _appState._linkLast = performance.now();
        const frame = (now) => {
          const { arcFadeMs } = _appState.layout;
          const { arcStart, rise } = _appState.linkTiming();
          const dt = Math.max(0, now - _appState._linkLast);
          _appState._linkLast = now;
          let active = false;
          for (const set of _appState.linkSets) {
            if (set.dir === "in") {
              const end = arcStart + set.maxGrowMs + rise;
              set.g = Math.min(end, set.g + dt);
              if (set.g < end) active = true;
            } else {
              set.fadeG += dt;
              set.alpha = Math.max(0, 1 - set.fadeG / arcFadeMs);
              if (set.alpha > 0) active = true;
            }
          }
          const before = _appState.linkSets.length;
          _appState.linkSets = _appState.linkSets.filter((set) => set.dir === "in" || set.alpha > 0);
          if (_appState.linkSets.length !== before) _appState.rebuildWallLinks({ redraw: false });
          _appState.linkFrame++;
          _appState.rebuildFloor();
          if (_appState.wallLinkQuads.length || before !== _appState.linkSets.length) _appState.stripViz.updatePlot();
          _appState._linkRaf = active ? requestAnimationFrame(frame) : null;
        };
        _appState._linkRaf = requestAnimationFrame(frame);
      },

      // Colour of a wall quad this frame: its set's fade, and hidden until the set's clock
      // reaches the quad's `appearMs` (soft over 40 ms).
      wallQuadColor: (d) => {
        const a = Math.min(1, Math.max(0, (d.set.g - d.appearMs) / 40)) * d.set.alpha;
        return [d.color[0], d.color[1], d.color[2], Math.round((d.color[3] ?? 255) * a)];
      },

      // Wall arcs and drop lines live on the strip in ribbon coordinates, as thin quads short in
      // s: the ribbon extension maps them per vertex, so they bend with the surface and fade from
      // behind like the cells. (Pixel-width PathLayer lines can't be mapped — LIBRARY_NOTES 5.)
      // Independent of assembly, so rebuilt only when the sets or the mode change. Each quad
      // carries its set and `appearMs`, the set time at which it appears.
      rebuildWallLinks: ({ redraw = true } = {}) => {
        const { arcs: mode } = _appState.display;
        const { wallLineWidth: w, wallArcGap, wallArcFloorMargin } = _appState.layout;
        const quads = [];
        if (mode === "wall" || mode === "drop") {
          const { arcStart, drop, rise } = _appState.linkTiming();
          const genomeBottom = _appState.stripPlotBottom;
          for (const set of _appState.linkSets) {
            const s0 = _appState.binS(set.focusBin);
            const from = quads.length;
            if (mode === "drop") {
              // Pieces ≤ 0.2 m so growth is smooth; `down` = the focus line, top to bottom.
              // A piece at fraction u appears at t0 + u·span (the focus line eases out).
              const vertical = (s, color, t0ms, spanMs, down) => {
                const n = Math.max(2, Math.ceil(genomeBottom / 0.2));
                for (let i = 0; i < n; i++) {
                  const t0 = (genomeBottom * i) / n;
                  const t1 = (genomeBottom * (i + 1)) / n;
                  const u = down ? (n - 1 - i) / n : i / n;
                  const appearMs = t0ms + spanMs * (down ? 1 - Math.cbrt(1 - u) : u);
                  quads.push({ color, appearMs, ring: [[s - w / 2, t0], [s + w / 2, t0], [s + w / 2, t1], [s - w / 2, t1]] });
                }
              };
              for (const link of set.links) vertical(_appState.binS(link.bin.index), link.color, arcStart + link.growMs, rise, false);
              vertical(s0, [..._appState.colors.visitor, 230], 0, drop, true);
            } else {
              const top = genomeBottom - wallArcGap;
              const room = top - wallArcFloorMargin;
              const L = _appState.profiles.stripLength;
              for (const link of set.links) {
                const s1 = _appState.binS(link.bin.index);
                const first = quads.length;
                wallArcQuads(quads, s0, s1, top, room * Math.sqrt(Math.abs(s1 - s0) / L), w, link.color);
                // Quad at fraction u along the arc appears when the link's eased growth reaches u.
                for (let i = first; i < quads.length; i++) quads[i].appearMs = arcStart + link.growMs * (1 - Math.cbrt(1 - quads[i].at));
              }
            }
            for (let i = from; i < quads.length; i++) quads[i].set = set;
          }
        }
        _appState.wallLinkQuads = quads;
        if (redraw) _appState.stripViz?.updatePlot();
      },

      // Flat: an arc diagram hanging under the strip. Assembled: bowed toward the floor centre.
      // Each arc is cut to its set's growth (from the focus end) and faded with the set.
      rebuildFloor: () => {
        if (_appState.focusBin == null || !_appState.ribbon) return;
        const k = _appState.assembly;
        const center = _appState.floorCenter;
        const arcs = [];
        if (_appState.display.arcs !== "wall" && _appState.display.arcs !== "none") {
          const { arcStart } = _appState.linkTiming();
          for (const set of _appState.linkSets) {
            if (set.alpha <= 0) continue;
            const from = _appState.binEdgePoint(set.focusBin);
            for (const link of set.links) {
              const f = _appState.linkGrowth(link, set.g, arcStart);
              if (f <= 0) continue;
              const to = _appState.binEdgePoint(link.bin.index);
              const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
              const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
              const flatCtrl = [mid[0], mid[1] - _appState.layout.flatArcDepth * span];
              const roomCtrl = [mid[0] + (center[0] - mid[0]) * 0.7, mid[1] + (center[1] - mid[1]) * 0.7];
              const ctrl = [lerp(flatCtrl[0], roomCtrl[0], k), lerp(flatCtrl[1], roomCtrl[1], k)];
              const path = truncatePath(floorArcPath(from, to, ctrl), f);
              arcs.push({ ...link, path, color: [link.color[0], link.color[1], link.color[2], Math.round(link.color[3] * set.alpha)] });
            }
          }
        }
        _appState.floorArcs = arcs;
        // Simulated visitors draw themselves; otherwise one stand-in at the focus.
        if (!_appState.sim.on) _appState.visitors = [{ position: _appState.binEdgePoint(_appState.focusBin, _appState.layout.visitorInset) }];
        _appState.floorViz.updatePlot();
        _appState.visitorViz?.updatePlot();
      },

      // ---- camera --------------------------------------------------------------------------
      // Frame the surface (sampled along s, top and bottom edge) plus the floor's share: the arc
      // band under the flat strip, interpolated into the floor outline's bounds as it assembles.
      worldCorners: (geom = _appState, k = _appState.assembly) => {
        const r = geom.ribbon;
        const H = _appState.room.height;
        const pts = [];
        for (let s = 0; s <= r.length; s += 2) {
          pts.push(ribbonPoint(r, s, 0).point, ribbonPoint(r, s, H).point);
        }
        const L = r.length;
        const ax = _appState.room.width / 2;
        const D = _appState.room.depth;
        const band = (_appState.layout.flatArcDepth / 2) * L;
        const xs = geom.floorOutline.map((p) => p[0]);
        const ys = geom.floorOutline.map((p) => p[1]);
        const flat = [[ax - L / 2, D - band], [ax + L / 2, D]];
        const room = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
        for (const i of [0, 1]) {
          for (const j of [0, 1]) {
            pts.push([lerp(flat[i][0], room[i][0], k), lerp(flat[j][1], room[j][1], k), 0]);
          }
        }
        return pts;
      },

      // The fitted view for a geometry. expandTargetViewStateToWorldPoints searches zoom in
      // 0.05 steps, so its output is quantized: fine for one fit, a visible stutter if re-run
      // every animation frame. Animations fit once (the end state) and interpolate.
      // The fitted orbit view for a geometry. Not viz_sandbox's expandTargetViewStateToWorldPoints:
      // that measures the whole window and steps zoom in 0.05 increments, but the exhibit header
      // covers the top of the (full-window) canvas. Here: project the corners at zoom 0, scale the
      // zoom so their screen box fits the free area (`viewInset`) (less `padding` zoom), then
      // move the target so the box is centred in that area. Exact, so animations can fit each end
      // once and interpolate.
      fitViewState: (geom = _appState, k = _appState.assembly, { padding = _appState.camera.padding } = {}) => {
        const { flatRotationX, roomRotationX, roomRotationOrbit } = _appState.camera;
        const angles = { rotationX: lerp(flatRotationX, roomRotationX, k), rotationOrbit: roomRotationOrbit * k };
        return _appState.fitPoints(_appState.worldCorners(geom, k), angles, { padding });
      },
      // Orbit view state at `angles` framing world points `corners` in the free area (see above).
      fitPoints: (corners, angles, { padding = _appState.camera.padding } = {}) => {
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
        const deck = _appState.vizDeckManager?.deck;
        const W = deck?.width || window.innerWidth;
        const H = deck?.height || window.innerHeight;
        // Free area: right of the header's control column and below its text, or the full width
        // below the whole header — whichever shows the content larger (the room favours the
        // first, the wide flat strip the second).
        const view = new OrbitView({ id: "fit", orthographic: true });
        const at = (zoom, target) => view.makeViewport({ width: W, height: H, viewState: { ...angles, target, zoom } });
        // Screen box of the corners at zoom 0, centred on `center`.
        const vp0 = at(0, center);
        const px = corners.map((c) => vp0.project(c));
        const bx = [Math.min(...px.map((p) => p[0])), Math.max(...px.map((p) => p[0]))];
        const by = [Math.min(...px.map((p) => p[1])), Math.max(...px.map((p) => p[1]))];
        const inset = _appState.viewInset;
        const areas = [
          { left: inset?.left ?? 0, top: inset?.top ?? 0 },
          { left: 0, top: inset?.headerBottom ?? 0 },
        ].map((a) => ({ left: Math.min(W * 0.6, a.left), top: Math.min(H * 0.6, a.top) }));
        const fitScale = (a) => Math.min((W - a.left) / (bx[1] - bx[0] || 1), (H - a.top) / (by[1] - by[0] || 1));
        const { left, top } = fitScale(areas[0]) >= fitScale(areas[1]) ? areas[0] : areas[1];
        const scale = fitScale({ left, top });
        const zoom = Math.log2(scale) - padding;
        const s = Math.pow(2, zoom);
        // Where the box centre lands after zooming about the screen centre, and where it should be.
        const cx = W / 2 + ((bx[0] + bx[1]) / 2 - W / 2) * s;
        const cy = H / 2 + ((by[0] + by[1]) / 2 - H / 2) * s;
        const dx = left + (W - left) / 2 - cx;
        const dy = top + (H - top) / 2 - cy;
        // New target: the floor point (z = 0) on the line of sight through the pixel that must
        // become the screen centre. OrbitViewport.unproject ignores targetZ and returns a point
        // at the target's depth, so slide it along the view direction (cos rx·sin ro,
        // cos rx·cos ro, −sin rx) to z = 0.
        const vp = at(zoom, center);
        const q = vp.unproject([W / 2 - dx, H / 2 - dy]);
        const rx = (angles.rotationX * Math.PI) / 180;
        const ro = (angles.rotationOrbit * Math.PI) / 180;
        const dir = [Math.cos(rx) * Math.sin(ro), Math.cos(rx) * Math.cos(ro), -Math.sin(rx)];
        const lambda = Math.abs(dir[2]) > 1e-6 ? -(q[2] ?? 0) / dir[2] : 0;
        return { ...angles, target: [q[0] + dir[0] * lambda, q[1] + dir[1] * lambda, 0], zoom };
      },
      fitCamera: (options) => {
        if (_appState.fpv.on) return null; // the first-person view owns the camera
        _appState.zoomedChrom = null;
        const fitted = _appState.fitViewState(_appState, _appState.assembly, options);
        _appState.vizDeckManager.setViewState(fitted);
        return fitted;
      },
      // ---- chromosome zoom (Screen mode) ----------------------------------------------------
      // Clicking a chromosome label frames that chromosome: its span along the strip, from just
      // under the band (labels) to the bubble zone above it. Clicking it again zooms back out.
      zoomedChrom: null,
      zoomToChromosome: (binIndex) => {
        if ((_appState.assemblyTarget ?? _appState.assembly) >= 0.5 || _appState.fpv.on || !_appState.ribbon) return;
        const chrom = _appState.bins[binIndex]?.chrom;
        if (chrom == null) return;
        if (_appState.zoomedChrom === chrom) {
          const out = _appState.fitViewState();
          _appState.animateCamera(out);
          _appState.zoomedChrom = null;
          return;
        }
        const inChrom = _appState.bins.filter((b) => b.chrom === chrom);
        const half = _appState.barWidth / 2;
        const s0 = _appState.binS(inChrom[0].index) - half;
        const s1 = _appState.binS(inChrom[inChrom.length - 1].index) + half;
        const { chromZoomBelow, chromZoomAbove } = _appState.layout;
        const t0 = _appState.stripPlotBottom - chromZoomBelow;
        const t1 = _appState.stripPlotBottom + _appState.stripPlotHeight + chromZoomAbove;
        const points = [];
        for (const sv of [s0, s1]) for (const tv of [t0, t1]) points.push(ribbonPoint(_appState.ribbon, sv, tv).point);
        const { flatRotationX } = _appState.camera;
        const to = _appState.fitPoints(points, { rotationX: flatRotationX, rotationOrbit: 0 }, { padding: _appState.layout.chromZoomPadding });
        _appState.animateCamera(to);
        _appState.zoomedChrom = chrom;
      },
      // Ease the orbit camera from where it is to `to` (no geometry change). With the angles
      // unchanged, the two views differ by a pure scale about one fixed world point F (same pixel
      // in both): F = (T0·k0 − T1·k1) / (k0 − k1), k = 2^zoom. Scaling about F with k interpolated
      // geometrically moves every point in a straight line on screen. Interpolating target and
      // zoom independently instead "swoops": early on the zoom flings content outward faster than
      // the pan brings the target in. Angle changes fall back to independent interpolation.
      animateCamera: (to, ms = 900) => {
        cancelAnimationFrame(_appState._camRaf);
        const from = _appState.currentViewState();
        const dOrbit = ((((to.rotationOrbit - from.rotationOrbit) % 360) + 540) % 360) - 180;
        const sameAngles = Math.abs(dOrbit) < 1e-3 && Math.abs(to.rotationX - from.rotationX) < 1e-3;
        const k0 = Math.pow(2, from.zoom);
        const k1 = Math.pow(2, to.zoom);
        const T0 = [0, 1, 2].map((i) => from.target[i] ?? 0);
        const T1 = [0, 1, 2].map((i) => to.target[i] ?? 0);
        const scales = Math.abs(k1 - k0) > 1e-6 * k0;
        const F = scales ? T0.map((t, i) => (t * k0 - T1[i] * k1) / (k0 - k1)) : null;
        const t0 = performance.now();
        const frame = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          let target;
          let zoom;
          if (sameAngles && scales) {
            const ke = k0 * Math.pow(k1 / k0, e);
            target = F.map((f, i) => f - (f - T0[i]) * (k0 / ke));
            zoom = Math.log2(ke);
          } else {
            target = T0.map((t, i) => lerp(t, T1[i], e));
            zoom = lerp(from.zoom, to.zoom, e);
          }
          if (!_appState.fpv.on) {
            _appState.vizDeckManager.setViewState({
              ...to,
              target,
              zoom,
              rotationX: lerp(from.rotationX, to.rotationX, e),
              rotationOrbit: from.rotationOrbit + dOrbit * e,
            });
          }
          if (k < 1) _appState._camRaf = requestAnimationFrame(frame);
        };
        _appState._camRaf = requestAnimationFrame(frame);
      },
      // Compass bearing the camera looks along (deg clockwise from +y): an orbit view's
      // rotationOrbit is exactly that; a first-person view has `bearing`.
      cameraBearing: () => {
        const vs = _appState.vizDeckManager?.deck?.viewManager?.getViewState("3d-scene"); // no fit fallback: may run before the ribbon exists
        return vs?.bearing ?? vs?.rotationOrbit ?? 0;
      },
      // Orbit view state `next` with its target moved so the room's centre stays on the pixel it
      // occupies in the current view. Only for rotation changes; pans and zooms pass through.
      keepPivot: (next) => {
        const deck = _appState.vizDeckManager?.deck;
        const prev = deck?.viewManager?.getViewState("3d-scene");
        if (_appState.fpv.on || !prev || next.rotationOrbit == null || prev.rotationOrbit == null || !_appState.ribbon) return next;
        if (Math.abs(next.rotationOrbit - prev.rotationOrbit) < 1e-9 && Math.abs(next.rotationX - prev.rotationX) < 1e-9) return next;
        const corners = _appState.worldCorners();
        const mid = (i) => (Math.min(...corners.map((c) => c[i] ?? 0)) + Math.max(...corners.map((c) => c[i] ?? 0))) / 2;
        const pivot = [mid(0), mid(1), mid(2)];
        const W = deck.width || window.innerWidth;
        const H = deck.height || window.innerHeight;
        const view = new OrbitView({ id: "pivot", orthographic: true });
        const vpPrev = view.makeViewport({ width: W, height: H, viewState: prev });
        const vpNext = view.makeViewport({ width: W, height: H, viewState: next });
        const p0 = vpPrev.project(pivot);
        const p1 = vpNext.project(pivot);
        // Screen centre must show what is now at centre − (p0 − p1): the target moves there, on
        // the floor (slide the unprojected point along the view direction to z = 0).
        const q = vpNext.unproject([W / 2 - (p0[0] - p1[0]), H / 2 - (p0[1] - p1[1])]);
        const rx = (next.rotationX * Math.PI) / 180;
        const ro = (next.rotationOrbit * Math.PI) / 180;
        const dir = [Math.cos(rx) * Math.sin(ro), Math.cos(rx) * Math.cos(ro), -Math.sin(rx)];
        const lambda = Math.abs(dir[2]) > 1e-6 ? -(q[2] ?? 0) / dir[2] : 0;
        return { ...next, target: [q[0] + dir[0] * lambda, q[1] + dir[1] * lambda, 0] };
      },
      // What the camera shows now, including any orbit/zoom the user did by hand.
      currentViewState: () => {
        const deck = _appState.vizDeckManager.deck;
        return deck.viewManager?.getViewState("3d-scene") ?? _appState.fitViewState();
      },

      // ---- animation -----------------------------------------------------------------------
      // `step(e)` advances the ribbon state; `end` is the state it reaches at e = 1. The camera
      // eases from where it is to the end state's fit, on the same curve.
      animate: (step, end) => {
        cancelAnimationFrame(_appState._raf);
        _appState.zoomedChrom = null;
        const from = _appState.currentViewState();
        const to = _appState.fitViewState(_appState.geometry(end), end.assembly ?? _appState.assembly);
        const dOrbit = ((((to.rotationOrbit - from.rotationOrbit) % 360) + 540) % 360) - 180; // shortest way round
        const t0 = performance.now();
        const frame = (now) => {
          const k = Math.min(1, (now - t0) / _appState.animationMs);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          step(e);
          _appState.update();
          if (!_appState.fpv.on) _appState.vizDeckManager.setViewState({
            ...to,
            target: [0, 1, 2].map((i) => lerp(from.target[i] ?? 0, to.target[i] ?? 0, e)),
            zoom: lerp(from.zoom, to.zoom, e),
            rotationX: lerp(from.rotationX, to.rotationX, e),
            rotationOrbit: from.rotationOrbit + dOrbit * e,
          });
          _appState.onStateChange?.();
          if (k < 1) _appState._raf = requestAnimationFrame(frame);
        };
        _appState._raf = requestAnimationFrame(frame);
      },
      animateAssembly: (to) => {
        const from = _appState.assembly;
        _appState.assemblyTarget = to; // so controls show where it is going
        if (_appState.display.mode === "bubbles") redrawBubbles(_appState); // arc resolution follows the mode
        _appState.animate(
          (e) => {
            _appState.assembly = lerp(from, to, e);
          },
          { assembly: to },
        );
      },
      animateShape: (name) => {
        _appState.shapeFrom = _appState.currentProfile();
        _appState.shapeTo = _appState.profiles[name];
        _appState.shapeK = 0;
        _appState.shapeName = name;
        _appState.animate(
          (e) => {
            _appState.shapeK = e;
          },
          { shapeK: 1 },
        );
      },
      setAssembly: (value) => {
        cancelAnimationFrame(_appState._raf);
        _appState.assemblyTarget = null;
        _appState.assembly = value;
        _appState.update();
        _appState.fitCamera();
      },

      // ---- cursor readout (diagnostic) -----------------------------------------------------
      handleDeckHover: (info, _event, plotInfo) => {
        if (plotInfo?.id !== _appState.stripViz.instanceId || !info?.viewport) {
          _appState.readout = null;
        } else {
          const { layout, barWidth } = _appState;
          const st = ribbonCoordinateAtPixel(_appState.ribbon, info.viewport, info.pixel, _appState.room.height);
          const plotRelative = st && [st[0] - layout.rowLabelMargin, st[1] - _appState.stripPlotBottom];
          const bin = plotRelative && _appState.bins[Math.floor(plotRelative[0] / barWidth)];
          _appState.readout = {
            plane: plotRelative,
            deck: plotInfo.plotRelativeCoordinate,
            region: bin ? `chr${bin.chrom}:${formatBp(bin.start)}–${formatBp(bin.end)}` : "off-strip",
          };
        }
        _appState.onReadoutChange?.();
      },
    };

    // ---- data ------------------------------------------------------------------------------
    _appState.bins = makeGenomeBins(_appState.layout.binSizeBp);
    _appState.traits = makeGwasTraits(_appState.bins, GWAS_TRAITS, _appState.layout.binSizeBp);
    const tierUsed = {};
    _appState.traitColors = _appState.traits.map((t) => {
      const family = TIER_COLORS[t.tier];
      const i = (tierUsed[t.tier] = (tierUsed[t.tier] ?? -1) + 1);
      return family[i % family.length];
    });
    _appState.layout.stripHeight =
      _appState.room.height - _appState.layout.wallBaseHeight - _appState.layout.wallTopMargin; // derived
    _appState.profiles = makeProfiles(_appState.room);
    const stripLength = _appState.profiles.stripLength;
    // Without trait rows there are no row labels to make room for: pad both ends equally.
    if (!_appState.display.traitTracks) {
      _appState.layout.rowLabelMargin = _appState.layout.stripSideMargin;
      _appState.layout.stripEndMargin = _appState.layout.stripSideMargin;
    }
    const { rowLabelMargin, stripEndMargin } = _appState.layout;
    _appState.barWidth = (stripLength - rowLabelMargin - stripEndMargin) / _appState.bins.length; // derived
    const { stripHeight } = _appState.layout;
    const traitRowHeight = stripHeight / (_appState.traits.length + 1); // derived
    const { traitTracks, bandHeight, mode } = _appState.display;
    const bubbles = mode === "bubbles";
    const defaultBand = bubbles ? _appState.layout.headBandHeight : traitRowHeight;
    const rowHeight = traitTracks
      ? traitRowHeight
      : Math.min(stripHeight, bandHeight === "full" ? stripHeight : (bandHeight ?? defaultBand)); // derived

    const startShape = _appState.profiles[params.get("shape")] ? params.get("shape") : "rounded";
    _appState.shapeName = startShape;
    _appState.shapeFrom = _appState.profiles[startShape];
    _appState.shapeTo = _appState.profiles[startShape];
    _appState.assembly = params.get("view") === "flat" ? 0 : 1; // assembled room by default; ?view=flat for the strip

    // Page behind the canvas, so the room reads as one dark space.
    const backgroundCss = `rgb(${_appState.colors.background.join(",")})`;
    document.body.style.background = backgroundCss;
    _appState.containerEl = document.querySelector(this.containerId);
    _appState.containerEl.style.background = backgroundCss;

    // ---- visualizers -----------------------------------------------------------------------
    _appState.vizDeckManager = new VisualizerDeckManager({ containerId: this.containerId });
    _appState.floorViz = makeFloorViz(this.containerId, _appState.vizDeckManager, _appState.room, _appState);
    _appState.stripViz = makeStripViz(
      this.containerId,
      _appState.vizDeckManager,
      _appState.bins,
      _appState.traits,
      {
        ..._appState.layout,
        barWidth: _appState.barWidth,
        rowHeight,
        traitTracks: _appState.display.traitTracks,
        wallHeight: _appState.room.height,
        plotCenterHeight: bubbles ? _appState.layout.headHeight : null,
        bubbles,
        stripLength,
      },
      _appState,
    );
    _appState.visitorViz = makeVisitorViz(this.containerId, _appState.vizDeckManager, _appState.room, _appState);
    _appState.plots = [_appState.floorViz, _appState.stripViz, _appState.visitorViz];
    if (bubbles) buildHintTicks(_appState);

    _appState.update();
    _appState.vizDeckManager.onDeckHover(_appState.handleDeckHover);

    // Rotate about the room's centre. The orbit view pivots on its target, which the camera fit
    // places off the room (the floor point behind the room's screen centre, so the room sits in
    // the area the header leaves free; the target must stay at z = 0). deck uses the view state
    // returned from onViewStateChange, so when a drag changes the rotation, re-solve the target
    // to keep the room's centre on the same pixel. (View padding would keep the target central,
    // but deck applies it as a projection skew that shears an orthographic view.)
    {
      const deck = _appState.vizDeckManager.deck;
      const baseOnViewStateChange = deck.props.onViewStateChange;
      deck.setProps({
        onViewStateChange: (params) => {
          const viewState = baseOnViewStateChange(params) || params.viewState;
          return _appState.keepPivot(viewState);
        },
      });
    }
    // Start standing mid-strip, at the first bin there with a few-region trait (almost every bin
    // has a height hit, which on its own shows only the "everything" end of the story).
    const start = Math.floor(_appState.bins.length / 2);
    const firstHit = _appState.bins
      .slice(start)
      .find((b) => _appState.traits.some((t) => t.tier === "few" && t.values[b.index] > 0));
    _appState.setFocusBin((firstHit ?? _appState.bins[start]).index);
    _appState.fitCamera();

    // Simulation on by default in the room (?sim=0 turns it off); off by default as the flat
    // screen (?view=flat), since visitors need the assembled room. Before the controls read sim.on.
    const simDefault = _appState.assembly >= 1;
    _appState.sim.defaultOn = simDefault;
    if (bubbles && (params.get("sim") === "1" || (simDefault && params.get("sim") !== "0"))) startSimulation(_appState);
    if (bubbles && params.get("fpv") === "1") setFirstPerson(_appState, true);
    const controls = mountControls(document.body, _appState);
    this._appState = _appState;
    if (import.meta.env.DEV) {
      // Console/debug handles, dev builds only.
      window.__genomeRoom = _appState;
      _appState.debugRibbonPoint = (s, t, z = 0) => ribbonPoint(_appState.ribbon, s, t, z);
    }

    return {
      plots: _appState.plots,
      _appState,
      unmount: () => {
        cancelAnimationFrame(_appState._raf);
        controls.unmount();
        for (const viz of _appState.plots) _appState.vizDeckManager.unregisterVisualizer(viz.instanceId);
      },
      setTheme: () => {
        // Dark only for now; colours already live on _appState.colors.
      },
    };
  }

  setTheme(theme) {
    this.appState?.setTheme?.(theme);
  }
}
