import { SolidPolygonLayer } from "@deck.gl/layers";
import { BoundedHeatmapVisualizer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedHeatmapVisualizer";
import { BoundedScatterplotLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedScatterplotLayer";
import { BoundedSolidPolygonLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedSolidPolygonLayer";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";
import { formatBp } from "./genome.js";
import { RIBBON_EXTENSION } from "./ribbon.js";
import { addBubbleLayers } from "./bubbles.js";

const BACKDROP_LAYER_ID = "stripBackdropLayer";
const WALL_LINKS_LAYER_ID = "wallLinksLayer";

/**
 * Workaround: BoundedScatterplotLayer.getShaders() merges its own injections with an object
 * spread, which REPLACES any extension injection on the same hook (vs:#decl,
 * vs:DECKGL_FILTER_GL_POSITION, fs:#decl, fs:#main-start). With the ribbon extension attached
 * that drops the varying declaration and the fragment shader fails to link. Re-append each
 * extension's injections after the base class has run.
 */
class ExtensionSafeBoundedScatterplotLayer extends BoundedScatterplotLayer {
  getShaders() {
    const shaders = super.getShaders();
    for (const extension of this.props.extensions) {
      const inject = extension.getShaders.call(this, extension)?.inject ?? {};
      for (const [hook, code] of Object.entries(inject)) {
        const current = shaders.inject[hook] ?? "";
        if (!current.includes(code)) shaders.inject[hook] = `${current}\n${code}`;
      }
    }
    return shaders;
  }
}
ExtensionSafeBoundedScatterplotLayer.layerName = "ExtensionSafeBoundedScatterplotLayer";
const PROBE_DOT_LAYER_ID = "probeScatterLayer";
const PROBE_SQUARE_LAYER_ID = "probeSquareLayer";

/**
 * The whole genome as ONE BoundedHeatmapVisualizer in ribbon coordinates: x = s along the strip,
 * y = t up it. Columns are genome bins; the top row is the chromosome band, traits below.
 * Nothing here knows the projection — the ribbon extension maps every vertex in the shader.
 */
export function makeStripViz(containerId, deckManager, bins, traits, layout, _appState) {
  const { barWidth, rowHeight, wallBaseHeight, wallHeight, rowLabelMargin, stripLength, traitTracks } = layout;
  const trackTraits = traitTracks ? traits : []; // rows drawn; traits still drive the floor arcs
  const rowCount = trackTraits.length + 1;
  const bandRow = trackTraits.length;

  const heatmapData = [];
  const heatmapDataLookupByRow = {};
  const heatmapDataLookupByColumn = {};
  const pushCell = (cell) => {
    heatmapData.push(cell);
    (heatmapDataLookupByRow[cell.rowIndex] ||= []).push(cell);
    (heatmapDataLookupByColumn[cell.colIndex] ||= []).push(cell);
  };
  bins.forEach((bin, col) => {
    pushCell({ kind: "band", rowIndex: bandRow, colIndex: col, rowId: "chromosome", colId: bin.index, bin, value: 0 });
    for (const trait of trackTraits) {
      pushCell({
        kind: "trait",
        rowIndex: trackTraits.length - 1 - trait.index, // trait 1 just under the band
        colIndex: col,
        rowId: trait.label,
        colId: bin.index,
        bin,
        trait,
        value: trait.values[bin.index],
      });
    }
  });

  const columnAxisLabelData = bins
    .filter((bin) => bin.start === 0)
    .map((bin) => ({ index: bin.index, label: `chr${bin.chrom}` }));
  const rowAxisLabelData = [
    ...trackTraits.map((t) => ({ index: trackTraits.length - 1 - t.index, label: t.shortLabel })),
  ];

  const viz = new BoundedHeatmapVisualizer(
    containerId,
    {
      heatmapData,
      heatmapDataLookupByRow,
      heatmapDataLookupByColumn,
      columnAxisLabelData,
      rowAxisLabelData,
      heatmapDimensions: [bins.length, rowCount],
    },
    {
      heatmapBarWidth: barWidth,
      heatmapBarHeight: rowHeight,
      columnAxisLabelSize: layout.columnLabelSize,
      defaultTextColor: _appState.colors.text,
    },
    null,
    deckManager,
  );

  viz.heatmapDataAccessor = (d) => d.value;
  viz.getHeatMapFillColor = (d) => _appState.cellColor(d);
  viz.appState.columnAxisLabelTextAngle = 0;
  if (layout.bubbles && layout.bubbleSide === "above") {
    // Ticks and bubbles use the space above the band; chromosome labels go underneath.
    viz.setColumnLabelPosition("bottom", false);
    viz.appState.columnAxisLabelTextAnchor = "start";
  } else {
    viz.setColumnLabelPosition("top", false);
  }
  viz.setRowLabelPosition("left", false);
  // Chromosome labels in Helvetica, set clear of the band: the library centres each label on a
  // point only ~0.06 m off the band (less than half a 0.3 m label). Anchor the label's far-side
  // baseline instead, columnLabelGap from the band.
  viz.appState.columnAxisLabelGap = layout.columnLabelGap;
  viz.appState.layerDescriptions["columnAxisLabelLayer"].setLayerProps({
    fontFamily: "Helvetica, Arial, sans-serif",
    getAlignmentBaseline: viz.appState.columnLabelPosition === "bottom" ? "top" : "bottom",
  });
  viz.appState.colAxisTitleText = layout.bubbles ? "" : `genome position (GRCh38, ${formatBp(layout.binSizeBp)} bins)`;
  viz.appState.rowAxisTitleText = traitTracks ? "trait" : "";

  viz.defaultTooltipFunction = (info) => {
    const d = info?.object;
    if (d?.kind === "bubble") {
      const h = d.hit;
      return {
        html: `<div style="font:11px Helvetica,Arial,sans-serif"><b>${d.trait.label}</b><br/>${d.trait.geneCount} associated gene${d.trait.geneCount > 1 ? "s" : ""} genome-wide<br/>here: ${h.hits} significant hit${h.hits > 1 ? "s" : ""}, strongest p = 1e-${Math.round(h.mlog)}${h.gene ? ` (${h.gene})` : ""}<br/><span style="opacity:.6">${d.trait.study.firstAuthor} ${d.trait.study.date.slice(0, 4)}, ${d.trait.study.accession}</span></div>`,
        style: { background: "rgba(20,20,28,0.95)", color: "rgb(220,230,245)", padding: "6px 9px", borderRadius: "4px" },
      };
    }
    if (!d || d.id === "plot_hit_area" || !d.bin || (info.layer && !viz.isTooltipEnabledLayer(info.layer))) {
      return null;
    }
    const where = `chr${d.bin.chrom}:${formatBp(d.bin.start)}–${formatBp(d.bin.end)}`;
    const hit = d.kind === "trait" ? d.trait.byBin.get(d.bin.index) : null;
    const what =
      d.kind === "band"
        ? "chromosome band"
        : hit
          ? `${d.trait.label}: ${hit.hits} significant hit${hit.hits > 1 ? "s" : ""}, strongest p = 1e-${Math.round(hit.mlog)}${hit.gene ? ` (${hit.gene})` : ""}`
          : `${d.trait.label}: no significant hit`;
    const study = d.kind === "trait" ? `<br/><span style="opacity:.6">${d.trait.study.firstAuthor} ${d.trait.study.date.slice(0, 4)}, ${d.trait.study.accession}</span>` : "";
    // Every trait with a significant hit in this bin, whichever row is hovered.
    const binTraits = traits
      .map((t) => ({ t, h: t.byBin.get(d.bin.index) }))
      .filter(({ h }) => h)
      .map(({ t, h }) => {
        const c = _appState.traitColors[t.index];
        return `<div><span style="display:inline-block;width:8px;height:8px;margin-right:5px;background:rgb(${c[0]},${c[1]},${c[2]})"></span>${t.label} — p = 1e-${Math.round(h.mlog)}${h.gene ? ` (${h.gene})` : ""}</div>`;
      });
    const traitList = `<div style="margin-top:5px;opacity:.6">${binTraits.length ? `Traits in this bin (${binTraits.length})` : "No trait hits in this bin"}</div>${binTraits.join("")}`;
    return {
      html: `<div style="font:11px Helvetica,Arial,sans-serif">${where}<br/>${what}${study}<br/><span style="opacity:.6">bin ${d.bin.index}</span>${traitList}</div>`,
      style: { background: "rgba(20,20,28,0.95)", color: "rgb(220,230,245)", padding: "6px 9px", borderRadius: "4px" },
    };
  };

  // Hovering a cell stands in for a visitor standing in front of that region.
  const baseHover = viz.dataHoverFunction.bind(viz);
  viz.dataHoverFunction = (info, event) => {
    baseHover(info, event);
    if (info?.object?.bin) _appState.setFocusBin(info.object.bin.index);
  };

  addBackdropLayer(viz, stripLength, wallHeight, _appState);
  addWallLinksLayer(viz, _appState);
  if (layout.bubbles) addBubbleLayers(viz, _appState);
  if (_appState.probeScatter && traitTracks) addScatterProbe(viz, bins, traits, { barWidth, rowHeight });

  // Plot rect in ribbon coordinates: after the row-label margin, top-aligned to the strip, so
  // the band keeps its place whether or not the trait rows are drawn below it. In bubbles mode,
  // centred on plotCenterHeight (head height) instead.
  const plotHeight = rowCount * rowHeight;
  _appState.stripPlotHeight = plotHeight;
  _appState.stripPlotBottom =
    layout.plotCenterHeight != null
      ? layout.plotCenterHeight - plotHeight / 2
      : wallBaseHeight + layout.stripHeight - plotHeight; // for the cursor readout
  viz.setPlotPosition([rowLabelMargin, _appState.stripPlotBottom], [bins.length * barWidth, plotHeight]);
  return viz;
}

/** Give every layer of `viz` the ribbon mapping, with the current ribbon state. */
export function applyRibbon(viz, uniforms, { redraw = true } = {}) {
  for (const id of viz.appState.orderedLayerIds) {
    viz.appState.layerDescriptions[id].setLayerProps({
      extensions: [RIBBON_EXTENSION],
      ribbonUniforms: uniforms,
      billboard: false,
    });
  }
  if (redraw) viz.updatePlot();
}

/**
 * The full surface behind the heatmap, cut into narrow quads along s: the ribbon map acts per
 * vertex, so a single rectangle would cut straight across every bend as a chord.
 */
function addBackdropLayer(viz, stripLength, wallHeight, _appState) {
  const step = 0.25;
  const data = [];
  for (let s = 0; s < stripLength; s += step) {
    const s1 = Math.min(s + step, stripLength);
    data.push({ ring: [[s, 0], [s1, 0], [s1, wallHeight], [s, wallHeight]] });
  }
  const qid = viz.constructUniqueInstanceLayerId(BACKDROP_LAYER_ID);
  viz.appState.addLayer(
    new LayerDescription(
      BACKDROP_LAYER_ID,
      () => data,
      (rows, props = {}) => {
        const { enabled, ...passthrough } = props;
        return new SolidPolygonLayer({
          ...passthrough,
          id: qid,
          data: rows,
          getPolygon: (d) => d.ring,
          getFillColor: _appState.colors.wallSurface,
          pickable: false,
          parameters: { depthTest: false },
        });
      },
      { enabled: true },
    ),
  );
  const order = viz.appState.orderedLayerIds;
  order.splice(order.indexOf(BACKDROP_LAYER_ID), 1);
  order.unshift(BACKDROP_LAYER_ID); // draw first
}

/** Wall arcs / drop lines: thin quads in ribbon coordinates (built in GenomeRoomApp). */
function addWallLinksLayer(viz, _appState) {
  const qid = viz.constructUniqueInstanceLayerId(WALL_LINKS_LAYER_ID);
  viz.appState.addLayer(
    new LayerDescription(
      WALL_LINKS_LAYER_ID,
      () => _appState.wallLinkQuads,
      (rows, props = {}) => {
        const { enabled, ...passthrough } = props;
        return new SolidPolygonLayer({
          ...passthrough,
          id: qid,
          data: rows,
          getPolygon: (d) => d.ring,
          getFillColor: _appState.wallQuadColor,
          // Geometry is fixed per link set; only colours change per animation frame.
          updateTriggers: { getFillColor: _appState.linkFrame },
          pickable: false, // hover on the strip moves the focus; links would steal it
          parameters: { depthTest: false },
        });
      },
      { enabled: true },
    ),
  );
}

/**
 * DIAGNOSTIC (?probe=scatter): the same cell centres as BoundedScatterplotLayer dots and as
 * BoundedSolidPolygonLayer squares. Under the plane-matrix approach they separated (matrix-order
 * bug). Under the ribbon they should coincide: both reach DECKGL_FILTER_GL_POSITION with the
 * bounds transform already applied, and no modelMatrix is involved.
 */
function addScatterProbe(viz, bins, traits, { barWidth, rowHeight }) {
  const points = [];
  for (const trait of traits.slice(0, 3)) {
    bins.forEach((bin, col) => {
      if (trait.values[bin.index] > 0) points.push([(col + 0.5) * barWidth, (traits.length - 1 - trait.index + 0.5) * rowHeight]);
    });
  }
  const half = Math.min(barWidth, rowHeight) * 0.35;
  const st = viz.appState;
  const bounds = () => ({
    bounded: st.boundsEnabled,
    boundsTL: st.plotRelativeBoundsTL,
    boundsBR: st.plotRelativeBoundsBR,
    boundsTransformMatrix: st.boundsTransformMatrix,
  });
  const add = (id, make) => {
    const qid = viz.constructUniqueInstanceLayerId(id);
    st.addLayer(
      new LayerDescription(
        id,
        () => points,
        (rows, props = {}) => {
          const { enabled, ...passthrough } = props;
          return make(qid, rows, passthrough);
        },
        { enabled: true },
      ),
    );
  };
  // No registerScrollableLayer: the strip is not navigable, so the bounds transform never changes.
  add(PROBE_SQUARE_LAYER_ID, (id, data, passthrough) =>
    new BoundedSolidPolygonLayer({
      ...passthrough,
      id,
      data,
      getPolygon: ([x, y]) => [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]],
      getFillColor: [255, 255, 255, 140],
      parameters: { depthTest: false },
      ...bounds(),
    }),
  );
  add(PROBE_DOT_LAYER_ID, (id, data, passthrough) =>
    new ExtensionSafeBoundedScatterplotLayer({
      ...passthrough,
      id,
      data,
      getPosition: (p) => p,
      getRadius: half * 0.6,
      radiusUnits: "common",
      getFillColor: [255, 40, 160, 255],
      parameters: { depthTest: false },
      ...bounds(),
    }),
  );
}
