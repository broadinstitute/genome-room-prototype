import { SolidPolygonLayer } from "@deck.gl/layers";
import { BoundedHeatmapVisualizer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedHeatmapVisualizer";
import { BoundedScatterplotLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedScatterplotLayer";
import { BoundedSolidPolygonLayer } from "viz_sandbox/js/bounded_visualizers/shader_bounds/BoundedSolidPolygonLayer";
import { LayerDescription } from "viz_sandbox/js/heatmap_visualizer/utils/layer_description";
import { formatBp } from "./genome.js";

const BACKDROP_LAYER_ID = "wallBackdropLayer";
const PROBE_DOT_LAYER_ID = "probeScatterLayer";
const PROBE_SQUARE_LAYER_ID = "probeSquareLayer";

/**
 * One wall's genome segment as a BoundedHeatmapVisualizer: columns are genome bins, row 0 is the
 * chromosome band, rows 1..K are traits.
 *
 * The plot is laid out in WALL SURFACE coordinates — x along the hinge, y up from the floor —
 * with its rect starting `layout.wallBaseHeight` above the floor. A plane placement then carries
 * that frame onto the wall (flat or folded); nothing here knows where the wall is.
 */
export function makeWallViz(containerId, deckManager, segment, traits, layout, _appState) {
  const { wall, firstBin, bins } = segment;
  const { barWidth, rowHeight, wallBaseHeight, wallHeight } = layout;
  const rowCount = traits.length + 1;

  const heatmapData = [];
  const heatmapDataLookupByRow = {};
  const heatmapDataLookupByColumn = {};
  const pushCell = (cell) => {
    heatmapData.push(cell);
    (heatmapDataLookupByRow[cell.rowIndex] ||= []).push(cell);
    (heatmapDataLookupByColumn[cell.colIndex] ||= []).push(cell);
  };
  // Row layout, bottom to top (world Y is up): traits 1..K, then the chromosome band on top,
  // next to the chromosome labels above the strip.
  const bandRow = traits.length;
  bins.forEach((bin, col) => {
    pushCell({ kind: "band", rowIndex: bandRow, colIndex: col, rowId: "chromosome", colId: bin.index, bin, value: 0 });
    for (const trait of traits) {
      pushCell({
        kind: "trait",
        rowIndex: traits.length - 1 - trait.index, // trait 1 just under the band
        colIndex: col,
        rowId: trait.label,
        colId: bin.index,
        bin,
        trait,
        value: trait.values[bin.index],
      });
    }
  });

  // Chromosome names at the first bin of each chromosome on this wall. Sparse: labels are
  // positioned by `index`, so missing columns simply have no label.
  const columnAxisLabelData = bins
    .map((bin, col) => ({ bin, col }))
    .filter(({ bin, col }) => col === 0 || bin.start === 0)
    .map(({ bin, col }) => ({ index: col, label: `chr${bin.chrom}` }));
  const rowAxisLabelData = [
    { index: bandRow, label: "chromosome" },
    ...traits.map((t) => ({ index: traits.length - 1 - t.index, label: t.shortLabel })),
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
      columnAxisLabelSize: layout.columnLabelSize, // absolute world size: bins are too narrow to size from
      defaultTextColor: _appState.colors.text,
    },
    null,
    deckManager,
  );

  viz.heatmapDataAccessor = (d) => d.value;
  viz.getHeatMapFillColor = (d) => _appState.cellColor(d);
  viz.appState.columnAxisLabelTextAngle = 0;
  // Column labels and title above the strip: below it, the title lands past the hinge — on the
  // floor when flat, under it when folded. Row labels into the reserved margin at the wall start.
  viz.setColumnLabelPosition("top", false);
  viz.setRowLabelPosition("left", false);
  viz.appState.colAxisTitleText = `genome position (GRCh38, ${formatBp(layout.binSizeBp)} bins) — ${wall.label.toLowerCase()}`;
  viz.appState.rowAxisTitleText = "trait";

  // Row labels only where the strip starts. On the other walls they would sit in the corner,
  // behind the neighbouring wall.
  if (firstBin !== 0) {
    viz.appState.layerDescriptions.rowAxisLabelLayer.enabled = false;
    viz.appState.layerDescriptions.rowAxisLabelHitLayer.enabled = false;
    viz.appState.rowAxisTitleText = "";
  }

  viz.defaultTooltipFunction = (info) => {
    const d = info?.object;
    if (!d || d.id === "plot_hit_area" || !d.bin || (info.layer && !viz.isTooltipEnabledLayer(info.layer))) {
      return null;
    }
    const where = `chr${d.bin.chrom}:${formatBp(d.bin.start)}–${formatBp(d.bin.end)}`;
    const what =
      d.kind === "band"
        ? "chromosome band"
        : `${d.trait.label}: ${d.value > 0 ? d.value.toFixed(2) : "no signal"}`;
    return {
      html: `<div style="font:11px Helvetica,Arial,sans-serif">${where}<br/>${what}<br/><span style="opacity:.6">${wall.label}, bin ${d.bin.index}</span></div>`,
      style: { background: "rgba(20,20,28,0.95)", color: "rgb(220,230,245)", padding: "6px 9px", borderRadius: "4px" },
    };
  };

  // Hovering a cell stands in for a visitor standing in front of that region.
  const baseHover = viz.dataHoverFunction.bind(viz);
  viz.dataHoverFunction = (info, event) => {
    baseHover(info, event);
    if (info?.object?.bin) _appState.setFocusBin(info.object.bin.index);
  };

  addBackdropLayer(viz, wall, wallHeight, _appState);
  if (_appState.probeScatter) addScatterProbe(viz, bins, traits, layout);

  // Plot rect in wall-surface coordinates, raised off the floor. LAST: triggers composeTransforms.
  viz.setPlotPosition([wall.stripStart, wallBaseHeight], [bins.length * barWidth, rowCount * rowHeight]);
  return viz;
}

/**
 * The full wall surface, drawn under the heatmap. Plain (unbounded) layer: it is larger than the
 * plot rect, so a bounded layer would clip it to the heatmap. The generator spreads `props` so
 * the plane placement reaches it.
 */
function addBackdropLayer(viz, wall, wallHeight, _appState) {
  const qid = viz.constructUniqueInstanceLayerId(BACKDROP_LAYER_ID);
  const data = [{ ring: [[0, 0], [wall.length, 0], [wall.length, wallHeight], [0, wallHeight]] }];
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
          getFillColor: _appState.colors.wall,
          pickable: false,
          parameters: { depthTest: false },
        });
      },
      { enabled: true },
    ),
  );
  // addLayer appends; the backdrop must draw first.
  const order = viz.appState.orderedLayerIds;
  order.splice(order.indexOf(BACKDROP_LAYER_ID), 1);
  order.unshift(BACKDROP_LAYER_ID);
}

/**
 * DIAGNOSTIC (?probe=scatter): the same cell centres drawn twice, as BoundedScatterplotLayer dots
 * and as BoundedSolidPolygonLayer squares. On the X-Y plane they coincide. On a placed plane they
 * separate if the two layer types compose modelMatrix and the bounds transform in different orders.
 *
 * No registerScrollableLayer: wall plots are not navigable, so the bounds transform never changes.
 */
function addScatterProbe(viz, bins, traits, layout) {
  const { barWidth, rowHeight } = layout;
  // Plot-local coordinates ([0, plotW] × [0, plotH]); the bounds transform adds the plot offset.
  const points = [];
  for (const trait of traits.slice(0, 3)) {
    bins.forEach((bin, col) => {
      if (trait.values[bin.index] > 0) {
        points.push([(col + 0.5) * barWidth, (traits.length - 1 - trait.index + 0.5) * rowHeight]);
      }
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

  const squareQid = viz.constructUniqueInstanceLayerId(PROBE_SQUARE_LAYER_ID);
  st.addLayer(
    new LayerDescription(
      PROBE_SQUARE_LAYER_ID,
      () => points,
      (rows, props = {}) => {
        const { enabled, ...passthrough } = props;
        return new BoundedSolidPolygonLayer({
          ...passthrough,
          id: squareQid,
          data: rows,
          getPolygon: ([x, y]) => [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]],
          getFillColor: [255, 255, 255, 140],
          parameters: { depthTest: false },
          ...bounds(),
        });
      },
      { enabled: true },
    ),
  );

  const dotQid = viz.constructUniqueInstanceLayerId(PROBE_DOT_LAYER_ID);
  st.addLayer(
    new LayerDescription(
      PROBE_DOT_LAYER_ID,
      () => points,
      (rows, props = {}) => {
        const { enabled, ...passthrough } = props;
        return new BoundedScatterplotLayer({
          ...passthrough,
          id: dotQid,
          data: rows,
          getPosition: (p) => p,
          getRadius: half * 0.6,
          radiusUnits: "common",
          getFillColor: [255, 40, 160, 255],
          parameters: { depthTest: false },
          ...bounds(),
        });
      },
      { enabled: true },
    ),
  );
}
