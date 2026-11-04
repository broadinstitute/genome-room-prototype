import { SolidPolygonLayer } from "@deck.gl/layers";
import { BoundedHeatmapVisualizer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedHeatmapVisualizer";
import { BoundedScatterplotLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedScatterplotLayer";
import { BoundedSolidPolygonLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedSolidPolygonLayer";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";
import { formatBp } from "./genome.js";
import { RIBBON_EXTENSION } from "./ribbon.js";

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
  viz.setColumnLabelPosition("top", false);
  viz.setRowLabelPosition("left", false);
  viz.appState.colAxisTitleText = `genome position (GRCh38, ${formatBp(layout.binSizeBp)} bins)`;
  viz.appState.rowAxisTitleText = traitTracks ? "trait" : "";

  viz.defaultTooltipFunction = (info) => {
    const d = info?.object;
    if (!d || d.id === "plot_hit_area" || !d.bin || (info.layer && !viz.isTooltipEnabledLayer(info.layer))) {
      return null;
    }
    const where = `chr${d.bin.chrom}:${formatBp(d.bin.start)}–${formatBp(d.bin.end)}`;
    const what =
      d.kind === "band" ? "chromosome band" : `${d.trait.label}: ${d.value > 0 ? d.value.toFixed(2) : "no signal"}`;
    return {
      html: `<div style="font:11px Helvetica,Arial,sans-serif">${where}<br/>${what}<br/><span style="opacity:.6">bin ${d.bin.index}</span></div>`,
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
  if (_appState.probeScatter && traitTracks) addScatterProbe(viz, bins, traits, { barWidth, rowHeight });

  // Plot rect in ribbon coordinates: after the row-label margin, top-aligned to the strip, so
  // the band keeps its place whether or not the trait rows are drawn below it.
  const plotHeight = rowCount * rowHeight;
  _appState.stripPlotBottom = wallBaseHeight + layout.stripHeight - plotHeight; // for the cursor readout
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
          getFillColor: (d) => d.color,
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
