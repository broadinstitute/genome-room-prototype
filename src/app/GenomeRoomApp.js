import { DemoApp } from "pattern-app-kit/core";
import { VisualizerDeckManager } from "viz_sandbox/js/deck_manager/deck_manager";
import { makeGenomeBins, makePlaceholderTraits, formatBp } from "./genome.js";
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
import { makeFloorViz, floorArcPath } from "./floor_setup.js";
import { mountControls } from "./controls.js";

const TRAIT_COLORS = [
  [255, 170, 60],
  [90, 180, 255],
  [120, 220, 140],
  [240, 100, 120],
  [200, 140, 255],
  [255, 230, 90],
  [80, 220, 220],
  [255, 140, 200],
];

const ARC_MODES = ["floor", "wall", "drop"];

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
    quads.push({ color, ring: [side[i][0], side[i + 1][0], side[i + 1][1], side[i][1]] });
  }
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
      floorViz: null,
      stripViz: null,

      // Physical room, metres. Unknown for the real space — free parameters. The shapes are
      // built from width and depth; the strip length (2·depth + width) is the same for all.
      room: { width: 24, depth: 16, height: 6 },
      layout: {
        binSizeBp: 5e6,
        traitCount: 8,
        wallBaseHeight: 0.8, // genome strip starts this far above the floor
        stripHeight: 4.2, // and is this tall
        columnLabelSize: 0.3,
        rowLabelMargin: 3.2, // start of the strip, reserved for trait row labels
        visitorInset: 0.9, // where the stand-in visitor stands, in front of the surface
        flatArcDepth: 0.3, // flat arc diagram: control-point depth as a fraction of arc span
        cornerArm: 0.6, // registration brackets at the physical room's corners, metres per arm
        wallLineWidth: 0.035, // wall arcs and drop lines, metres on the surface
        wallArcGap: 0.05, // wall arcs start this far below the genome
        wallArcFloorMargin: 0.1, // and stop at least this far above the floor
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
      },
      traitColors: TRAIT_COLORS,
      probeScatter: params.get("probe") === "scatter",
      // What the strip shows. URL: ?tracks=none drops the trait rows (traits still drive the
      // floor arcs); the chromosome band then takes the full strip height.
      // bandHeight (m) applies when the trait tracks are hidden; null = one trait row's height,
      // so hiding the tracks leaves the band unchanged. URL: ?band=<metres> or ?band=full.
      // With tracks shown, every row (band included) is stripHeight / (traits + 1).
      display: {
        traitTracks: params.get("tracks") !== "none",
        bandHeight: params.get("band") === "full" ? "full" : Number(params.get("band")) || null,
        // Where a focused region's links are drawn. URL: ?arcs=floor|wall|drop.
        //   floor — arcs across the floor between the regions' wall bases
        //   wall  — arcs on the wall surface, hanging below the genome
        //   drop  — floor arcs plus a line down the wall from each region to its arc's end
        arcs: ARC_MODES.includes(params.get("arcs")) ? params.get("arcs") : "floor",
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
      floorArcs: [],
      wallLinkQuads: [], // wall arcs / drop lines, in ribbon (s, t) coordinates
      visitors: [],
      readout: null,

      cellColor: (d) => {
        if (d.kind === "band") return _appState.colors.band[d.bin.chromIndex % 2];
        if (!(d.value > 0)) return _appState.colors.empty;
        const c = _appState.traitColors[d.trait.index % _appState.traitColors.length];
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
        const links = [];
        for (const trait of _appState.traits) {
          if (!(trait.values[binIndex] > 0)) continue;
          const color = [..._appState.traitColors[trait.index % _appState.traitColors.length], 200];
          for (const bin of _appState.bins) {
            if (bin.index === binIndex || !(trait.values[bin.index] > 0)) continue;
            links.push({ trait, bin, color });
          }
        }
        _appState.focusLinks = links;
        _appState.rebuildWallLinks();
        _appState.rebuildFloor();
        _appState.onFocusChange?.();
      },

      setArcMode: (mode) => {
        _appState.display.arcs = mode;
        _appState.rebuildWallLinks();
        _appState.rebuildFloor();
        _appState.onStateChange?.();
      },

      // Wall arcs and drop lines live on the strip in ribbon coordinates, as thin quads short in
      // s: the ribbon extension maps them per vertex, so they bend with the surface and fade from
      // behind like the cells. (Pixel-width PathLayer lines can't be mapped — LIBRARY_NOTES 5.)
      // Independent of assembly, so rebuilt only when the focus or the mode changes.
      rebuildWallLinks: () => {
        const { arcs: mode } = _appState.display;
        const { wallLineWidth: w, wallArcGap, wallArcFloorMargin } = _appState.layout;
        const quads = [];
        const focus = _appState.focusBin;
        if (focus != null && mode !== "floor") {
          const genomeBottom = _appState.stripPlotBottom;
          const s0 = _appState.binS(focus);
          const vertical = (s, color) =>
            quads.push({ color, ring: [[s - w / 2, 0], [s + w / 2, 0], [s + w / 2, genomeBottom], [s - w / 2, genomeBottom]] });
          if (mode === "drop") {
            for (const link of _appState.focusLinks) vertical(_appState.binS(link.bin.index), link.color);
            vertical(s0, [..._appState.colors.visitor, 230]);
          } else {
            const top = genomeBottom - wallArcGap;
            const room = top - wallArcFloorMargin;
            const L = _appState.profiles.stripLength;
            for (const link of _appState.focusLinks) {
              const s1 = _appState.binS(link.bin.index);
              wallArcQuads(quads, s0, s1, top, room * Math.sqrt(Math.abs(s1 - s0) / L), w, link.color);
            }
          }
        }
        _appState.wallLinkQuads = quads;
        _appState.stripViz?.updatePlot();
      },

      // Flat: an arc diagram hanging under the strip. Assembled: bowed toward the floor centre.
      rebuildFloor: () => {
        if (_appState.focusBin == null || !_appState.ribbon) return;
        const k = _appState.assembly;
        const center = _appState.floorCenter;
        const from = _appState.binEdgePoint(_appState.focusBin);
        const links = _appState.display.arcs === "wall" ? [] : _appState.focusLinks;
        _appState.floorArcs = links.map((link) => {
          const to = _appState.binEdgePoint(link.bin.index);
          const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
          const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
          const flatCtrl = [mid[0], mid[1] - _appState.layout.flatArcDepth * span];
          const roomCtrl = [mid[0] + (center[0] - mid[0]) * 0.7, mid[1] + (center[1] - mid[1]) * 0.7];
          const ctrl = [lerp(flatCtrl[0], roomCtrl[0], k), lerp(flatCtrl[1], roomCtrl[1], k)];
          return { ...link, path: floorArcPath(from, to, ctrl) };
        });
        _appState.visitors = [{ position: _appState.binEdgePoint(_appState.focusBin, _appState.layout.visitorInset) }];
        _appState.floorViz.updatePlot();
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
      fitViewState: (geom = _appState, k = _appState.assembly, { padding = _appState.camera.padding } = {}) => {
        const corners = _appState.worldCorners(geom, k);
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        // Bounding-box midpoint; z stays 0 (the viz_sandbox controller pins the orbit target there).
        const target = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
        const { flatRotationX, roomRotationX, roomRotationOrbit } = _appState.camera;
        const fitted = _appState.floorViz.expandTargetViewStateToWorldPoints(
          corners,
          { rotationX: lerp(flatRotationX, roomRotationX, k), rotationOrbit: roomRotationOrbit * k, target, zoom: 9 },
          0.05,
        );
        fitted.zoom -= padding;
        return fitted;
      },
      fitCamera: (options) => {
        const fitted = _appState.fitViewState(_appState, _appState.assembly, options);
        _appState.vizDeckManager.setViewState(fitted);
        return fitted;
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
        const from = _appState.currentViewState();
        const to = _appState.fitViewState(_appState.geometry(end), end.assembly ?? _appState.assembly);
        const dOrbit = ((((to.rotationOrbit - from.rotationOrbit) % 360) + 540) % 360) - 180; // shortest way round
        const t0 = performance.now();
        const frame = (now) => {
          const k = Math.min(1, (now - t0) / _appState.animationMs);
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          step(e);
          _appState.update();
          _appState.vizDeckManager.setViewState({
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
    _appState.traits = makePlaceholderTraits(_appState.bins, _appState.layout.traitCount);
    _appState.profiles = makeProfiles(_appState.room);
    const stripLength = _appState.profiles.stripLength;
    _appState.barWidth = (stripLength - _appState.layout.rowLabelMargin) / _appState.bins.length; // derived
    const { stripHeight } = _appState.layout;
    const traitRowHeight = stripHeight / (_appState.traits.length + 1); // derived
    const { traitTracks, bandHeight } = _appState.display;
    const rowHeight = traitTracks
      ? traitRowHeight
      : Math.min(stripHeight, bandHeight === "full" ? stripHeight : (bandHeight ?? traitRowHeight)); // derived

    const startShape = _appState.profiles[params.get("shape")] ? params.get("shape") : "room";
    _appState.shapeName = startShape;
    _appState.shapeFrom = _appState.profiles[startShape];
    _appState.shapeTo = _appState.profiles[startShape];
    _appState.assembly = params.get("view") === "room" ? 1 : 0;

    // Page behind the canvas, so the room reads as one dark space.
    const backgroundCss = `rgb(${_appState.colors.background.join(",")})`;
    document.body.style.background = backgroundCss;
    document.querySelector(this.containerId).style.background = backgroundCss;

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
        stripLength,
      },
      _appState,
    );
    _appState.plots = [_appState.floorViz, _appState.stripViz];

    _appState.update();
    _appState.vizDeckManager.onDeckHover(_appState.handleDeckHover);
    // Start standing mid-strip, at the first bin there with any trait signal.
    const start = Math.floor(_appState.bins.length / 2);
    const firstHit = _appState.bins.slice(start).find((b) => _appState.traits.some((t) => t.values[b.index] > 0));
    _appState.setFocusBin((firstHit ?? _appState.bins[start]).index);
    _appState.fitCamera();

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
