import { DemoApp } from "pattern-app-kit/core";
import { VisualizerDeckManager } from "viz_sandbox/js/deck_manager/deck_manager";
import { makeGenomeBins, makePlaceholderTraits, formatBp } from "./genome.js";
import { makeWalls, wallPlacement, wallEdgePoint, assignBinsToWalls } from "./room.js";
import { placeVisualizer, auditPlacement, placedCorners, placedCoordinateAtPixel } from "./plane_placement.js";
import { makeWallViz } from "./wall_setup.js";
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

export class GenomeRoomApp extends DemoApp {
  static getTitle() {
    return "Genome Room";
  }
  static getDescription() {
    return "A genome strip on three walls, region-to-region links on the floor, folding between a flat net and the room.";
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
      wallVizzes: [],

      // Physical room, metres. Unknown for the real space — these are free parameters.
      room: { width: 24, depth: 16, height: 6 },
      layout: {
        binSizeBp: 5e6,
        traitCount: 8,
        wallBaseHeight: 0.8, // genome strip starts this far above the floor
        stripHeight: 4.2, // and is this tall
        columnLabelSize: 0.3,
        rowLabelMargin: 3.2, // front of the left wall, reserved for trait row labels
        visitorInset: 0.9, // where the stand-in visitor stands, in front of the wall
        flatArcDepth: 0.3, // flat arc diagram: control-point depth as a fraction of arc span
      },
      // The deck manager's view is orthographic, so a straight-on room view sees both side walls
      // edge-on; the orbit angle turns one of them toward the camera.
      camera: { roomRotationX: 30, flatRotationX: 90, roomRotationOrbit: -35, padding: 0.3 },
      foldDurationMs: 1600,

      colors: {
        text: [225, 230, 240],
        floor: [28, 30, 38],
        grid: [48, 52, 64],
        wall: [22, 24, 32],
        band: [[70, 80, 110], [120, 130, 165]],
        empty: [36, 40, 52],
        visitor: [240, 240, 240],
      },
      traitColors: TRAIT_COLORS,

      probeScatter: params.get("probe") === "scatter",

      fold: 0, // 0 = flat net, 1 = folded room
      focusBin: null,
      floorArcs: [],
      visitors: [],

      cellColor: (d) => {
        if (d.kind === "band") return _appState.colors.band[d.bin.chromIndex % 2];
        if (!(d.value > 0)) return _appState.colors.empty;
        const c = _appState.traitColors[d.trait.index % _appState.traitColors.length];
        const k = 0.35 + 0.65 * d.value;
        const e = _appState.colors.empty;
        return [e[0] + (c[0] - e[0]) * k, e[1] + (c[1] - e[1]) * k, e[2] + (c[2] - e[2]) * k];
      },

      // ---- genome strip <-> floor geometry -------------------------------------------------
      // Bottom-edge point of a bin's column on whichever wall holds it, under the wall's current
      // placement — so it tracks the wall through the transition.
      binEdgePoint: (binIndex, inset = 0) => {
        const viz = _appState.wallVizzes.find((v) => binIndex < v.segment.firstBin + v.segment.bins.length);
        const s = viz.wall.stripStart + (binIndex - viz.segment.firstBin + 0.5) * _appState.barWidth;
        return wallEdgePoint(viz.wall, viz.appState.planePlacement, _appState.fold, s, inset);
      },

      // Links from the focused bin to every other bin sharing a trait with it.
      focusLinks: [],
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
        _appState.rebuildFloor();
        _appState.onFocusChange?.();
      },

      // Arc geometry depends on where the walls are, so it is rebuilt on every fold step. Flat:
      // an arc diagram hanging under the strip. Room: bowed toward the middle of the floor.
      rebuildFloor: () => {
        if (_appState.focusBin == null) return;
        const t = _appState.fold;
        const center = [_appState.room.width / 2, _appState.room.depth / 2];
        const from = _appState.binEdgePoint(_appState.focusBin);
        _appState.floorArcs = _appState.focusLinks.map((link) => {
          const to = _appState.binEdgePoint(link.bin.index);
          const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
          const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
          const flatCtrl = [mid[0], mid[1] - _appState.layout.flatArcDepth * span];
          const roomCtrl = [mid[0] + (center[0] - mid[0]) * 0.7, mid[1] + (center[1] - mid[1]) * 0.7];
          const ctrl = [flatCtrl[0] + (roomCtrl[0] - flatCtrl[0]) * t, flatCtrl[1] + (roomCtrl[1] - flatCtrl[1]) * t];
          return { ...link, path: floorArcPath(from, to, ctrl) };
        });
        _appState.visitors = [{ position: _appState.binEdgePoint(_appState.focusBin, _appState.layout.visitorInset) }];
        _appState.floorViz.updatePlot();
      },

      // ---- fold + camera -----------------------------------------------------------------
      // `fold` runs 0 (one horizontal strip) to 1 (room).
      floorOpacity: () => _appState.fold,
      applyFold: (fold) => {
        _appState.fold = fold;
        for (const viz of _appState.wallVizzes) placeVisualizer(viz, wallPlacement(viz.wall, fold, _appState.room));
        _appState.rebuildFloor();
      },

      // Dollhouse cutaway. The orthographic camera sees any wall whose face points away from it
      // from behind — mirrored text through the backdrop — so those walls fade out.
      backfaceOpacity: 0.1,
      updateWallFacing: (viewState) => {
        const pitch = (viewState.rotationX * Math.PI) / 180;
        const orbit = (viewState.rotationOrbit * Math.PI) / 180;
        // Direction from the orbit target toward the camera.
        const toCamera = [-Math.sin(orbit) * Math.cos(pitch), -Math.cos(orbit) * Math.cos(pitch), Math.sin(pitch)];
        for (const viz of _appState.wallVizzes) {
          const m = viz.appState.planePlacement;
          // Third column of the placement = the wall's face normal.
          const facing = m[8] * toCamera[0] + m[9] * toCamera[1] + m[10] * toCamera[2];
          const opacity = facing > -1e-3 ? 1 : _appState.backfaceOpacity;
          if (viz.wallOpacity === opacity) continue;
          viz.wallOpacity = opacity;
          for (const id of viz.appState.orderedLayerIds) viz.appState.layerDescriptions[id].setLayerProps({ opacity });
          viz.updatePlot();
        }
      },

      // Every corner of every surface, after placement.
      // The floor's share of the frame: when flat, the band under the strip that the arc diagram
      // can reach (a quadratic Bézier's depth is half its control depth); in the room, the floor.
      // Interpolated, so the camera moves smoothly and never reacts to which arcs are showing.
      worldCorners: () => {
        const { width: W, depth: D, height: H } = _appState.room;
        const walls = _appState.wallVizzes.map((v) => v.wall);
        const stripX0 = walls[0].flatOrigin[0];
        const stripX1 = walls.at(-1).flatOrigin[0] + walls.at(-1).length;
        const arcBand = (_appState.layout.flatArcDepth / 2) * (stripX1 - stripX0);
        const flatBand = [[stripX0, D - arcBand], [stripX1, D - arcBand], [stripX1, D], [stripX0, D]];
        const roomFloor = [[0, 0], [W, 0], [W, D], [0, D]];
        const t = _appState.fold;
        const floor = flatBand.map(([x, y], i) => [
          x + (roomFloor[i][0] - x) * t,
          y + (roomFloor[i][1] - y) * t,
          0,
        ]);
        const wallCorners = _appState.wallVizzes.flatMap((viz) => placedCorners(viz, [0, 0, viz.wall.length, H]));
        return [...floor, ...wallCorners];
      },

      fitCamera: ({ padding = _appState.camera.padding } = {}) => {
        const corners = _appState.worldCorners();
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        // Midpoint of the bounding box. z stays 0: the viz_sandbox controller pins the orbit
        // target to the z = 0 plane.
        const target = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
        const { flatRotationX, roomRotationX, roomRotationOrbit } = _appState.camera;
        const rotationX = flatRotationX + (roomRotationX - flatRotationX) * _appState.fold;
        const rotationOrbit = roomRotationOrbit * _appState.fold;
        const fitted = _appState.floorViz.expandTargetViewStateToWorldPoints(
          corners,
          { rotationX, rotationOrbit, target, zoom: 9 }, // start zoomed IN; the fit only zooms out
          0.05,
        );
        fitted.zoom -= padding;
        _appState.vizDeckManager.setViewState(fitted);
        _appState.updateWallFacing(fitted);
        return fitted;
      },

      animateFold: (to) => {
        cancelAnimationFrame(_appState._foldRaf);
        const from = _appState.fold;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / _appState.foldDurationMs);
          const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          _appState.applyFold(from + (to - from) * eased);
          _appState.fitCamera();
          _appState.onFoldChange?.();
          if (k < 1) _appState._foldRaf = requestAnimationFrame(step);
        };
        _appState._foldRaf = requestAnimationFrame(step);
      },

      // ---- placed-plane coordinate readout (diagnostic) ------------------------------------
      readout: null,
      handleDeckHover: (info, _event, plotInfo) => {
        const viz = _appState.wallVizzes.find((v) => v.instanceId === plotInfo?.id);
        if (!viz || !info?.viewport) {
          _appState.readout = null;
        } else {
          const placed = placedCoordinateAtPixel(viz, info.viewport, info.pixel);
          const offsetX = viz.appState.globalPositionOffsetX;
          const offsetY = viz.appState.globalPositionOffsetY;
          const plotRelative = placed && [placed[0] - offsetX, placed[1] - offsetY];
          const binOnWall = plotRelative && Math.floor(plotRelative[0] / _appState.barWidth);
          const bin = binOnWall != null && viz.segment.bins[binOnWall];
          _appState.readout = {
            wall: viz.wall.label,
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
    const walls = makeWalls(_appState.room, _appState.layout.rowLabelMargin);
    const { barWidth, segments } = assignBinsToWalls(walls, _appState.bins);
    _appState.barWidth = barWidth;
    _appState.segments = segments;
    const rowHeight = _appState.layout.stripHeight / (_appState.layout.traitCount + 1); // derived

    // ---- visualizers -----------------------------------------------------------------------
    _appState.vizDeckManager = new VisualizerDeckManager({ containerId: this.containerId });
    _appState.floorViz = makeFloorViz(this.containerId, _appState.vizDeckManager, _appState.room, _appState);
    _appState.wallVizzes = segments.map((segment) => {
      const viz = makeWallViz(
        this.containerId,
        _appState.vizDeckManager,
        segment,
        _appState.traits,
        { ..._appState.layout, barWidth, rowHeight, wallHeight: _appState.room.height },
        _appState,
      );
      viz.wall = segment.wall;
      viz.segment = segment;
      return viz;
    });
    _appState.plots = [_appState.floorViz, ..._appState.wallVizzes];

    const startFold = params.get("view") === "room" ? 1 : 0;
    _appState.applyFold(startFold);
    for (const viz of _appState.wallVizzes) {
      const missed = auditPlacement(viz);
      if (missed.length) console.warn(`[placement] ${viz.wall.id} wall: layers not placed`, missed);
    }
    _appState.vizDeckManager.onDeckHover(_appState.handleDeckHover);
    // The manager notifies with either the deck event ({ viewState }) or deck.viewState.
    const onViewChange = (e) => {
      const vs = [e?.viewState, e?.["3d-scene"], e].find((v) => v && v.rotationX != null);
      if (vs) _appState.updateWallFacing(vs);
    };
    _appState.vizDeckManager.observer.subscribeToEvent("viewStateChange", onViewChange);
    // Start standing mid back wall, at the first bin there with any trait signal.
    const back = _appState.segments[1];
    const start = back.firstBin + Math.floor(back.bins.length / 2);
    const firstHit = _appState.bins.slice(start).find((b) => _appState.traits.some((t) => t.values[b.index] > 0));
    _appState.setFocusBin((firstHit ?? _appState.bins[start]).index);
    _appState.fitCamera();

    const controls = mountControls(document.body, _appState);
    this._appState = _appState;
    if (import.meta.env.DEV) window.__genomeRoom = _appState; // console/debug handle, dev builds only

    return {
      plots: _appState.plots,
      _appState,
      unmount: () => {
        cancelAnimationFrame(_appState._foldRaf);
        _appState.vizDeckManager.observer.unsubscribeFromEvent("viewStateChange", onViewChange);
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
