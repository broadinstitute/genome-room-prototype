import { TRAIT_TIERS } from "./genome.js";

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

  // ---- top-left: title, assembly, shape, legend ----------------------------------------------
  const top = document.createElement("div");
  top.style.cssText = PANEL_STYLE + "left:12px;top:12px;max-width:320px;";
  const shapes = ["room", "rounded", "arc"];
  top.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">Genome Room — ribbon projection</div>
    <div style="opacity:.7;margin-bottom:8px">GRCh38, ${_appState.bins.length} bins. Traits: GWAS Catalog
      (${_appState.gwasSource.catalog.replace(/^.*_(e\d+_r[\d-]+).*$/, "$1")}), one study each, hits at
      ${_appState.gwasSource.threshold}. Hover a cell to stand there.</div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <button data-assembly="0">Flat strip</button>
      <button data-assembly="1">Assembled</button>
      <input data-role="slider" type="range" min="0" max="100" step="1" style="flex:1" />
      <span data-role="pct" style="width:34px;text-align:right"></span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <span style="opacity:.7">Shape</span>
      ${shapes.map((s) => `<button data-shape="${s}">${_appState.profiles[s].label}</button>`).join("")}
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <span style="opacity:.7">Arcs</span>
      <button data-arcs="floor">Floor</button>
      <button data-arcs="wall">Wall</button>
      <button data-arcs="drop">Floor + drop lines</button>
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <input data-role="tracks" type="checkbox" ${_appState.display.traitTracks ? "checked" : ""} /> Trait tracks on the strip
    </label>
    <div style="opacity:.7;margin:6px 0 2px">${_appState.display.traitTracks ? "Arcs and cells" : "Arcs"}: trait</div>
    <div data-role="legend"></div>`;
  root.appendChild(top);

  const slider = top.querySelector('[data-role="slider"]');
  const pct = top.querySelector('[data-role="pct"]');
  for (const button of top.querySelectorAll("button[data-assembly]")) {
    button.onclick = () => _appState.animateAssembly(Number(button.dataset.assembly));
  }
  const shapeButtons = top.querySelectorAll("button[data-shape]");
  for (const button of shapeButtons) {
    button.onclick = () => _appState.animateShape(button.dataset.shape);
  }
  // The strip's rows are fixed at construction: toggling reloads with the URL parameter.
  top.querySelector('[data-role="tracks"]').onchange = (e) => {
    const url = new URL(window.location.href);
    if (e.target.checked) url.searchParams.delete("tracks");
    else url.searchParams.set("tracks", "none");
    window.location.assign(url);
  };
  const arcButtons = top.querySelectorAll("button[data-arcs]");
  for (const button of arcButtons) {
    button.onclick = () => _appState.setArcMode(button.dataset.arcs);
  }
  slider.oninput = () => {
    _appState.setAssembly(Number(slider.value) / 100);
    _appState.onStateChange();
  };
  _appState.onStateChange = () => {
    const value = Math.round(_appState.assembly * 100);
    slider.value = String(value);
    pct.textContent = `${value}%`;
    for (const b of shapeButtons) b.style.fontWeight = b.dataset.shape === _appState.shapeName ? "700" : "400";
    for (const b of arcButtons) b.style.fontWeight = b.dataset.arcs === _appState.display.arcs ? "700" : "400";
  };
  _appState.onStateChange();

  top.querySelector('[data-role="legend"]').innerHTML = TRAIT_TIERS.map((tier) => {
    const rows = _appState.traits
      .filter((t) => t.tier === tier.key)
      .map((t) => {
        const c = _appState.traitColors[t.index];
        return `<div><span style="display:inline-block;width:10px;height:10px;background:${rgb(c)};margin-right:6px"></span>${t.label} — ${t.binCount} bin${t.binCount > 1 ? "s" : ""}</div>`;
      })
      .join("");
    if (!rows) return "";
    const on = _appState.display.tiers.has(tier.key);
    return `<label style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <input data-tier="${tier.key}" type="checkbox" ${on ? "checked" : ""} /><span style="opacity:.75">${tier.label}</span>
      </label><div data-tier-rows="${tier.key}" style="padding-left:20px;opacity:${on ? 1 : 0.35}">${rows}</div>`;
  }).join("");
  // Tier checkboxes filter the links live; the strip's cells are unaffected.
  for (const box of top.querySelectorAll("input[data-tier]")) {
    box.onchange = () => {
      _appState.setTierVisible(box.dataset.tier, box.checked);
      top.querySelector(`[data-tier-rows="${box.dataset.tier}"]`).style.opacity = box.checked ? "1" : "0.35";
    };
  }

  // ---- bottom-left: focus + readout ----------------------------------------------------------
  const bottom = document.createElement("div");
  bottom.style.cssText = PANEL_STYLE + "left:12px;bottom:12px;min-width:330px;";
  root.appendChild(bottom);

  const render = () => {
    const bin = _appState.focusBin != null ? _appState.bins[_appState.focusBin] : null;
    const r = _appState.readout;
    bottom.innerHTML = `
      <div><b>Standing at</b> ${bin ? `chr${bin.chrom}, bin ${bin.index}` : "—"} · ${_appState.focusLinks.length} links</div>
      <div style="margin-top:6px;opacity:.7">Cursor on the strip (plot-relative coordinates)</div>
      <div>region: ${r ? r.region : "—"}</div>
      <div>ribbon-intersected: ${fmt(r?.plane)}</div>
      <div>deck plotRelativeCoordinate: ${fmt(r?.deck)}</div>`;
  };
  _appState.onFocusChange = render;
  _appState.onReadoutChange = render;
  render();

  return { unmount: () => root.remove() };
}
