/**
 * Plain-DOM overlay: fold controls, trait legend, focus summary, and the placed-plane coordinate
 * readout. Kept out of React deliberately — it is diagnostic chrome for the spike.
 */
const PANEL_STYLE =
  "position:absolute;background:rgba(16,18,24,0.88);color:rgb(220,226,238);" +
  "font:12px Helvetica,Arial,sans-serif;padding:10px 12px;border-radius:6px;line-height:1.45;";

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const fmt = (p) => (p ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : "—");

export function mountControls(parent, _appState) {
  const root = document.createElement("div");
  parent.appendChild(root);

  // ---- top-left: title, fold, legend ---------------------------------------------------------
  const top = document.createElement("div");
  top.style.cssText = PANEL_STYLE + "left:12px;top:12px;max-width:320px;";
  top.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">Genome Room — plane placement spike</div>
    <div style="opacity:.7;margin-bottom:8px">Genome bins: GRCh38 lengths, ${_appState.bins.length} bins.
      <b>Trait values are placeholders, not data.</b> Hover a wall cell to stand there.</div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <button data-fold="0">Flat strip</button>
      <button data-fold="1">Room</button>
      <input data-role="slider" type="range" min="0" max="100" step="1" style="flex:1" />
      <span data-role="angle" style="width:34px;text-align:right"></span>
    </div>
    <div style="opacity:.7;margin:6px 0 2px">Floor arcs and wall cells: trait</div>
    <div data-role="legend"></div>`;
  root.appendChild(top);

  const slider = top.querySelector('[data-role="slider"]');
  const angle = top.querySelector('[data-role="angle"]');
  for (const button of top.querySelectorAll("button[data-fold]")) {
    button.onclick = () => _appState.animateFold(Number(button.dataset.fold));
  }
  slider.oninput = () => {
    cancelAnimationFrame(_appState._foldRaf);
    _appState.applyFold(Number(slider.value) / 100);
    _appState.fitCamera();
    angle.textContent = `${slider.value}%`;
  };
  _appState.onFoldChange = () => {
    const pct = Math.round(_appState.fold * 100);
    slider.value = String(pct);
    angle.textContent = `${pct}%`;
  };
  _appState.onFoldChange();

  top.querySelector('[data-role="legend"]').innerHTML = _appState.traits
    .map((t) => {
      const c = _appState.traitColors[t.index % _appState.traitColors.length];
      return `<div><span style="display:inline-block;width:10px;height:10px;background:${rgb(c)};margin-right:6px"></span>${t.label} — ${(t.density * 100).toFixed(1)}% of bins</div>`;
    })
    .join("");

  // ---- bottom-left: focus + readout ----------------------------------------------------------
  const bottom = document.createElement("div");
  bottom.style.cssText = PANEL_STYLE + "left:12px;bottom:12px;min-width:330px;";
  root.appendChild(bottom);

  const render = () => {
    const bin = _appState.focusBin != null ? _appState.bins[_appState.focusBin] : null;
    const r = _appState.readout;
    bottom.innerHTML = `
      <div><b>Standing at</b> ${bin ? `chr${bin.chrom}, bin ${bin.index}` : "—"} · ${_appState.floorArcs.length} arcs</div>
      <div style="margin-top:6px;opacity:.7">Cursor on a wall (plot-relative coordinates)</div>
      <div>wall: ${r ? r.wall : "—"} · region: ${r ? r.region : "—"}</div>
      <div>plane-intersected: ${fmt(r?.plane)}</div>
      <div>deck plotRelativeCoordinate: ${fmt(r?.deck)}</div>`;
  };
  _appState.onFocusChange = render;
  _appState.onReadoutChange = render;
  render();

  return { unmount: () => root.remove() };
}
