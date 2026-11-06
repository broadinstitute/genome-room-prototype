import { TRAIT_TIERS } from "./genome.js";
import patternLogoUrl from "./assets/pattern-logo-WHITE.svg"; // copied from pattern-site/static

/**
 * Plain-DOM overlay. Top left: the exhibit panel (title, what this is, four controls). Bottom
 * right: a collapsed Debug panel holding every prototype control, the trait legend, and the
 * focus / cursor readout. Both refresh from `_appState.onStateChange`. Kept out of React
 * deliberately.
 */
const PANEL_STYLE =
  "background:rgba(16,18,24,0.88);color:rgb(220,226,238);" +
  "font:12px Helvetica,Arial,sans-serif;padding:10px 12px;border-radius:6px;line-height:1.45;";

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const fmt = (p) => (p ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : "—");

export function mountControls(parent, _appState) {
  const root = document.createElement("div");
  parent.appendChild(root);
  const refreshers = [];
  _appState.onStateChange = () => refreshers.forEach((f) => f());
  // Live controls keep the URL in step so a reload restores them.
  const setParam = (key, value) => {
    const url = new URL(window.location.href);
    if (value == null) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
    window.history.replaceState(null, "", url);
  };

  // ?sim= only when it differs from the default (on in the room, off as the flat screen).
  _appState.recordSimParam = () => {
    const assembled = (_appState.assemblyTarget ?? _appState.assembly) >= 0.5;
    setParam("sim", _appState.sim.on === assembled ? null : _appState.sim.on ? 1 : 0);
  };

  // ?tiers= only when the shown tiers differ from the default (Medium).
  _appState.recordTiersParam = () => {
    const keys = TRAIT_TIERS.map((t) => t.key).filter((k) => _appState.display.tiers.has(k));
    setParam("tiers", keys.join(",") === _appState.defaultTiers.join(",") ? null : keys.join(",") || "none");
  };

  mountMainPanel(root, _appState, refreshers, setParam);

  // ---- bottom-left: Pattern logo, linking to the Pattern site ---------------------------------
  const logo = document.createElement("a");
  logo.href = "http://pattern.broadinstitute.org";
  logo.target = "_blank";
  logo.rel = "noopener";
  logo.title = "Pattern";
  logo.style.cssText = "position:absolute;left:28px;bottom:22px;display:block;opacity:.75;transition:opacity .15s;";
  logo.onmouseenter = () => (logo.style.opacity = "1");
  logo.onmouseleave = () => (logo.style.opacity = ".75");
  logo.innerHTML = `<img src="${patternLogoUrl}" alt="Pattern" style="display:block;height:34px;width:auto" />`;
  root.appendChild(logo);

  // ---- bottom-right: collapsed Debug panel holding the full prototype UI ----------------------
  const debug = document.createElement("div");
  debug.style.cssText =
    "position:absolute;right:12px;bottom:12px;max-height:calc(100vh - 24px);overflow:auto;" +
    "display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:12px Helvetica,Arial,sans-serif;";
  const debugBody = document.createElement("div");
  debugBody.style.cssText = "display:none;flex-direction:column;gap:8px;";
  const debugToggle = document.createElement("button");
  debugToggle.className = "gr-btn"; // header palette (style injected by mountMainPanel)
  const setDebugOpen = (open) => {
    debugBody.style.display = open ? "flex" : "none";
    debugToggle.textContent = open ? "Debug ▾" : "Debug ▸";
    debugToggle.classList.toggle("on", open);
  };
  debugToggle.onclick = () => setDebugOpen(debugBody.style.display === "none");
  setDebugOpen(false);
  debug.appendChild(debugBody);
  debug.appendChild(debugToggle);
  root.appendChild(debug);

  // ---- debug: title, assembly, shape, legend ---------------------------------------------------
  const top = document.createElement("div");
  top.style.cssText = PANEL_STYLE + "max-width:340px;";
  const shapes = ["room", "rounded", "arc"];
  top.innerHTML = `
    <div style="font-size:14px;font-weight:600;margin-bottom:4px">Debug — ribbon projection</div>
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
      <span style="opacity:.7">View</span>
      <button data-mode="tracks">Trait tracks</button>
      <button data-mode="bubbles">Bubbles</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <span style="opacity:.7">Arcs</span>
      <button data-arcs="floor">Floor</button>
      <button data-arcs="wall">Wall</button>
      <button data-arcs="drop">Floor + drop</button>
      <button data-arcs="none">None</button>
    </div>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <span style="opacity:.7">Wall height</span>
      <input data-role="wall" type="number" min="${_appState.wallHeightRange[0]}" max="${_appState.wallHeightRange[1]}" step="0.5"
        value="${_appState.room.height}" style="width:56px" /> m
    </label>
    <div style="display:${_appState.display.mode === "bubbles" ? "block" : "none"};margin-bottom:6px">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <span style="opacity:.7">Links</span>
        <button data-links="ticks">Ticks</button>
        <button data-links="arcs">Faint arcs</button>
      </div>
      <label style="display:flex;gap:6px;align-items:center">
        <input data-role="sim" type="checkbox" ${_appState.sim.on ? "checked" : ""} /> Simulate visitors
      </label>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <span style="opacity:.7">Visitors</span>
        <input data-role="visitors" type="number" min="1" max="20" step="1" value="${_appState.sim.count}" style="width:44px" />
        <span style="opacity:.7;margin-left:6px">Speed</span>
        <input data-role="simSpeed" type="range" min="0.25" max="8" step="0.25" value="${_appState.sim.speed}" style="width:90px" />
        <span data-role="simSpeedValue">${_appState.sim.speed}×</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <label style="display:flex;gap:6px;align-items:center">
          <input data-role="fpv" type="checkbox" /> First-person view
        </label>
        <button data-role="nextVisitor">Next visitor</button>
        <span data-role="fpvWho" style="opacity:.7"></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <span style="opacity:.7">Stay at a region</span>
        <input data-role="stay" type="number" min="1" max="120" step="1" value="${_appState.sim.config.stay}" style="width:48px" /> s (±40%)
      </div>
    </div>
    <label style="display:${_appState.display.mode === "bubbles" ? "none" : "flex"};gap:6px;align-items:center;margin-bottom:6px">
      <input data-role="tracks" type="checkbox" ${_appState.display.traitTracks ? "checked" : ""} /> Trait tracks on the strip
    </label>
    <div style="opacity:.7;margin:6px 0 2px">${_appState.display.mode === "bubbles" ? "Ticks, bubbles and arcs" : _appState.display.traitTracks ? "Arcs and cells" : "Arcs"}: trait</div>
    <div data-role="legend"></div>`;
  debugBody.appendChild(top);

  const slider = top.querySelector('[data-role="slider"]');
  const pct = top.querySelector('[data-role="pct"]');
  for (const button of top.querySelectorAll("button[data-assembly]")) {
    button.onclick = () => _appState.animateAssembly(Number(button.dataset.assembly));
  }
  const shapeButtons = top.querySelectorAll("button[data-shape]");
  for (const button of shapeButtons) {
    button.onclick = () => {
      _appState.animateShape(button.dataset.shape);
      setParam("shape", button.dataset.shape === "rounded" ? null : button.dataset.shape);
    };
  }
  // The strip's rows are fixed at construction: toggling reloads with the URL parameter.
  top.querySelector('[data-role="tracks"]').onchange = (e) => {
    const url = new URL(window.location.href);
    if (e.target.checked) url.searchParams.delete("tracks");
    else url.searchParams.set("tracks", "none");
    window.location.assign(url);
  };
  top.querySelector('[data-role="sim"]').onchange = (e) => {
    _appState.setSimulation(e.target.checked);
    _appState.recordSimParam();
  };
  top.querySelector('[data-role="visitors"]').onchange = (e) => {
    const n = Math.min(20, Math.max(1, Math.round(Number(e.target.value)) || 1));
    e.target.value = n;
    _appState.sim.count = n;
    if (_appState.sim.on) _appState.setVisitorCount(n);
    setParam("visitors", n);
    _appState.onStateChange();
  };
  // First-person view: live; Escape leaves it.
  top.querySelector('[data-role="fpv"]').onchange = (e) => {
    _appState.setFirstPerson(e.target.checked);
    setParam("fpv", e.target.checked ? 1 : null);
    _appState.recordSimParam();
  };
  top.querySelector('[data-role="nextVisitor"]').onclick = () => _appState.nextVisitor();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _appState.fpv.on) {
      _appState.setFirstPerson(false);
      setParam("fpv", null);
    }
  });
  top.querySelector('[data-role="stay"]').onchange = (e) => {
    const x = Math.min(120, Math.max(1, Number(e.target.value) || 12));
    e.target.value = x;
    _appState.setStay(x);
    setParam("stay", x);
  };
  top.querySelector('[data-role="simSpeed"]').oninput = (e) => {
    const x = Number(e.target.value);
    _appState.setSimSpeed(x);
    top.querySelector('[data-role="simSpeedValue"]').textContent = `${x}×`;
    setParam("simSpeed", x);
  };
  // Wall height sets the strip's row heights, also fixed at construction: reload with ?wall=.
  top.querySelector('[data-role="wall"]').onchange = (e) => {
    const value = Number(e.target.value);
    if (!(value > 0)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("wall", String(value));
    window.location.assign(url);
  };
  // The mode changes the strip's structure: reload with ?mode=.
  const modeButtons = top.querySelectorAll("button[data-mode]");
  for (const button of modeButtons) {
    button.style.fontWeight = button.dataset.mode === _appState.display.mode ? "700" : "400";
    button.onclick = () => {
      const url = new URL(window.location.href);
      if (button.dataset.mode === "bubbles") url.searchParams.delete("mode");
      else url.searchParams.set("mode", button.dataset.mode);
      window.location.assign(url);
    };
  }
  const linkButtons = top.querySelectorAll("button[data-links]");
  for (const button of linkButtons) {
    button.onclick = () => {
      _appState.setBubbleLinks(button.dataset.links);
      setParam("links", button.dataset.links === "ticks" ? "ticks" : null); // default: faint arcs
    };
  }
  const arcButtons = top.querySelectorAll("button[data-arcs]");
  for (const button of arcButtons) {
    button.onclick = () => _appState.setArcMode(button.dataset.arcs);
  }
  slider.oninput = () => {
    _appState.setAssembly(Number(slider.value) / 100);
    _appState.onStateChange();
  };
  refreshers.push(() => {
    const value = Math.round(_appState.assembly * 100);
    slider.value = String(value);
    pct.textContent = `${value}%`;
    for (const b of shapeButtons) b.style.fontWeight = b.dataset.shape === _appState.shapeName ? "700" : "400";
    const fpvBox = top.querySelector('[data-role="fpv"]');
    // Checked = where the camera is going (a transition out still has fpv.on until it ends).
    fpvBox.checked = _appState.fpv.on && _appState.fpv.transition?.dir !== "out";
    top.querySelector('[data-role="sim"]').checked = _appState.sim.on;
    top.querySelector('[data-role="nextVisitor"]').disabled = !_appState.fpv.on;
    top.querySelector('[data-role="fpvWho"]').textContent = _appState.fpv.on ? `following visitor ${_appState.fpv.visitorId}` : "";
    for (const b of linkButtons) b.style.fontWeight = b.dataset.links === _appState.display.bubbleLinks ? "700" : "400";
    for (const b of arcButtons) b.style.fontWeight = b.dataset.arcs === _appState.display.arcs ? "700" : "400";
    top.querySelector('[data-role="visitors"]').value = _appState.sim.count;
    for (const box of top.querySelectorAll("input[data-tier]")) {
      const on = _appState.display.tiers.has(box.dataset.tier);
      box.checked = on;
      top.querySelector(`[data-tier-rows="${box.dataset.tier}"]`).style.opacity = on ? "1" : "0.35";
    }
  });

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
      _appState.recordTiersParam();
    };
  }
  _appState.onStateChange();

  // ---- debug: focus + readout ----------------------------------------------------------
  const bottom = document.createElement("div");
  bottom.style.cssText = PANEL_STYLE + "min-width:330px;";
  debugBody.appendChild(bottom);

  const render = () => {
    const bin = _appState.focusBin != null ? _appState.bins[_appState.focusBin] : null;
    const r = _appState.readout;
    bottom.innerHTML = `
      ${
        _appState.sim.on
          ? `<div><b>Visitors</b> ${_appState.sim.visitors.length} · dwelling ${_appState.sim.visitors.filter((v) => v.active).length}
              · shared traits: ${_appState.sharedTraitKeys.length ? _appState.sharedTraitKeys.map((k) => _appState.traits.find((t) => t.key === k).shortLabel).join(", ") : "none"}</div>`
          : `<div><b>Standing at</b> ${bin ? `chr${bin.chrom}, bin ${bin.index}` : "—"} · ${_appState.focusLinks.length} links</div>`
      }
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

/**
 * The exhibit header, over the top of the full-window canvas: title, subtitle, description, and
 * below them the controls — mode (Room / Screen = assembled / unfolded); room shape; trait
 * density (Low / Medium / High = the 1, 2 or 3 rarest tiers); Simulate visitors (on/off, number
 * of visitors, 3rd / 1st person view). The camera fits the content into the area the header
 * leaves free (`viewInset`). Toggle buttons use the visualization's own palette.
 */
function mountMainPanel(root, _appState, refreshers, setParam) {
  const c = _appState.colors;
  const rgba = (col, a) => `rgba(${col[0]},${col[1]},${col[2]},${a})`;
  const accent = c.wallSurface; // the wall tint's blue
  const css = document.createElement("style");
  css.textContent = `
    .gr-header { position:absolute; left:0; right:0; top:0; display:flex; flex-direction:column; gap:14px;
      pointer-events:none; /* the canvas under it stays draggable; controls opt back in */
      padding:18px 28px 12px; box-sizing:border-box; background:transparent;
      color:${rgba(c.text, 1)}; font-family:Helvetica,Arial,sans-serif; }
    .gr-title { font-size:34px; font-weight:600; letter-spacing:.3px; line-height:1.1; }
    .gr-subtitle { font-size:15px; margin-top:6px; color:${rgba(c.text, 0.85)}; }
    .gr-subtitle a { color:inherit; text-decoration:underline; text-decoration-color:${rgba(accent, 0.6)};
      text-underline-offset:3px; pointer-events:auto; }
    .gr-subtitle a:hover { text-decoration-color:${rgba(c.text, 1)}; }
    .gr-desc { font-size:13px; line-height:1.5; margin-top:8px; color:${rgba(c.text, 0.62)}; max-width:760px; }
    .gr-controls { display:flex; flex-direction:column; gap:20px; font-size:13px; }
    .gr-group { display:flex; flex-direction:row; align-items:flex-start; gap:12px; pointer-events:auto; align-self:flex-start; }
    .gr-group > .gr-head { width:112px; flex-shrink:0; min-height:28px; }
    .gr-group > .gr-seg, .gr-group > .gr-row { min-height:26px; }
    .gr-sub { display:flex; flex-direction:column; align-items:flex-start; gap:8px; }
    .gr-sub > .gr-row { min-height:28px; }
    .gr-group.gr-col { flex-direction:column; gap:6px; }
    .gr-group.gr-col > .gr-head { min-height:0; width:auto; }
    .gr-group.gr-col > .gr-sub { padding-left:22px; }
    .gr-head { font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:${rgba(c.text, 0.55)};
      display:flex; align-items:center; gap:8px; }
    .gr-row { display:flex; align-items:center; gap:8px; color:${rgba(c.text, 0.8)}; }
    .gr-seg { display:inline-flex; border:1px solid ${rgba(accent, 0.35)}; border-radius:4px; overflow:hidden; }
    .gr-seg button { background:transparent; color:${rgba(c.text, 0.7)}; border:0; padding:5px 12px; font:inherit;
      cursor:pointer; }
    .gr-seg button + button { border-left:1px solid ${rgba(accent, 0.35)}; }
    .gr-seg button:hover { color:${rgba(c.text, 1)}; background:${rgba(accent, 0.08)}; }
    .gr-seg button.on { background:${rgba(c.band[1], 0.45)}; color:${rgba(c.text, 1)}; }
    .gr-seg button:disabled { opacity:.4; cursor:default; }
    .gr-btn { background:${rgba(c.background, 0.9)}; color:${rgba(c.text, 0.75)}; border:1px solid ${rgba(accent, 0.35)};
      border-radius:4px; padding:5px 12px; font:13px Helvetica,Arial,sans-serif; cursor:pointer; }
    .gr-btn:hover { color:${rgba(c.text, 1)}; background:${rgba(accent, 0.1)}; }
    .gr-btn.on { background:${rgba(c.band[1], 0.45)}; color:${rgba(c.text, 1)}; }
    .gr-note { align-self:center; color:${rgba(c.band[1], 1)}; transition:opacity .3s; } /* the lighter chromosome band */
    .gr-note.off { opacity:0; }
    .gr-room-only { transition:opacity .3s; }
    .gr-room-only.off { opacity:.28; pointer-events:none; } /* Screen mode: room-only controls */
    .gr-header input[type=range] { accent-color:${rgba(c.band[1], 1)}; }
    .gr-header input[type=checkbox] { accent-color:${rgba(c.band[1], 1)}; margin:0; }`;
  document.head.appendChild(css);

  const shapes = ["room", "rounded", "arc"];
  const densities = [["Low", 1], ["Medium", 2], ["High", 3]];
  const header = document.createElement("div");
  header.className = "gr-header";
  header.innerHTML = `
    <div>
      <div class="gr-title">Polygenomic Exploration Room</div>
      <div class="gr-subtitle">A virtual prototype of an immersive room experience targeting
        <a href="https://ars.electronica.art/solutions/en/deepspace/" target="_blank" rel="noopener">Ars Electronica's Deep Space
        projection system</a> (installed at the Boston Museum of Science)</div>
      <div class="gr-desc">Images are projected across the walls and floor, and laser (lidar) tracking follows where
        each visitor stands. The human genome runs around the walls at head height. Linger in front of a region and
        the traits linked to it there open above it; when several people stand at regions that share a trait, the
        room connects them. Trait data: GWAS Catalog.</div>
    </div>
    <div class="gr-controls">
      <div class="gr-group">
        <div class="gr-head">Mode</div>
        <div class="gr-seg"><button data-main-mode="room">Room</button><button data-main-mode="screen">Screen</button></div>
        <div data-main="modeNote" class="gr-note">Screen mode allows direct interaction with the visualization using your mouse.</div>
      </div>
      <div class="gr-group">
        <div class="gr-head">Trait density</div>
        <div style="display:flex;flex-direction:column;gap:5px">
          <div class="gr-seg" style="align-self:flex-start">${densities.map(([label, n]) => `<button data-main-density="${n}">${label}</button>`).join("")}</div>
          <div data-main="densityValue" style="opacity:.6"></div>
        </div>
      </div>
      <div class="gr-group gr-room-only">
        <div class="gr-head">Room shape</div>
        <div class="gr-seg">${shapes.map((s) => `<button data-main-shape="${s}">${_appState.profiles[s].label}</button>`).join("")}</div>
      </div>
      <div class="gr-group gr-col gr-room-only">
        <label class="gr-head"><input data-main="sim" type="checkbox" /> Simulate visitors</label>
        <div class="gr-sub">
          <div class="gr-row">Number of visitors:
            <input data-main="visitors" type="range" min="1" max="20" step="1" style="width:110px" />
            <span data-main="visitorsValue" style="width:18px;text-align:right"></span></div>
          <div class="gr-row">View:
            <span class="gr-seg"><button data-main-view="room">3rd person</button><button data-main-view="fpv">1st person</button></span>
            <span data-main="fpvWho" style="opacity:.6"></span></div>
        </div>
      </div>
    </div>`;
  root.appendChild(header);
  const q = (sel) => header.querySelector(sel);

  // The canvas stays full-window under the (transparent) header; the camera fits the room into
  // the area below the header instead.
  // The camera fits the room to the right of the control column and below the text block; on a
  // window too narrow for that, below the whole header.
  const layout = () => {
    const text = header.firstElementChild.getBoundingClientRect();
    // Right edge of the control column, ignoring the Screen-mode note beside the Mode toggle
    // (it is faded out, but still takes space, in Room mode).
    const groups = [...header.querySelectorAll(".gr-group")].flatMap((g) =>
      [...g.children].filter((el) => !el.classList.contains("gr-note")).map((el) => el.getBoundingClientRect()),
    );
    _appState.viewInset = {
      top: text.bottom + 12,
      left: Math.max(...groups.map((r) => r.right)) + 24,
      headerBottom: header.offsetHeight,
    };
    requestAnimationFrame(() => _appState.fitCamera());
  };
  // Header height can settle after mount (fonts, wrapping) and changes with the window width.
  new ResizeObserver(layout).observe(header);
  window.addEventListener("resize", layout);

  // Mode: Room = the assembled room, Screen = the unfolded strip (animated either way).
  const modeButtons = header.querySelectorAll("button[data-main-mode]");
  for (const b of modeButtons) {
    b.onclick = () => {
      const room = b.dataset.mainMode === "room";
      setParam("view", room ? null : "flat");
      // Screen: visitors walk a room, so the simulation (and first person) stop. Leaving first
      // person glides the camera back first; unfold once that has finished.
      const wasFpv = _appState.fpv.on;
      if (!room && _appState.sim.on) {
        _appState.setSimulation(false);
        setParam("fpv", null);
      }
      const go = () => {
        _appState.animateAssembly(room ? 1 : 0);
        _appState.recordSimParam();
      };
      if (!room && wasFpv) setTimeout(go, _appState.fpv.transitionMs + 50);
      else go();
      _appState.onStateChange();
    };
  }
  const shapeButtons = header.querySelectorAll("button[data-main-shape]");
  for (const b of shapeButtons) {
    b.onclick = () => {
      _appState.animateShape(b.dataset.mainShape);
      setParam("shape", b.dataset.mainShape === "rounded" ? null : b.dataset.mainShape);
    };
  }
  q('[data-main="sim"]').onchange = (e) => {
    _appState.setSimulation(e.target.checked);
    _appState.recordSimParam();
    if (!e.target.checked) setParam("fpv", null);
    _appState.onStateChange();
  };
  q('[data-main="visitors"]').oninput = (e) => {
    const n = Number(e.target.value);
    _appState.sim.count = n;
    if (_appState.sim.on) _appState.setVisitorCount(n);
    setParam("visitors", n === 10 ? null : n);
    _appState.onStateChange();
  };
  const viewButtons = header.querySelectorAll("button[data-main-view]");
  for (const b of viewButtons) {
    b.onclick = () => {
      const fpv = b.dataset.mainView === "fpv";
      _appState.setFirstPerson(fpv); // first person starts the simulation if needed
      setParam("fpv", fpv ? 1 : null);
      _appState.recordSimParam();
      _appState.onStateChange();
    };
  }
  const densityButtons = header.querySelectorAll("button[data-main-density]");
  for (const b of densityButtons) {
    b.onclick = () => {
      const n = Number(b.dataset.mainDensity);
      _appState.setTiers(TRAIT_TIERS.slice(0, n).map((t) => t.key));
      _appState.recordTiersParam();
    };
  }
  const tierCount = () => {
    // How many tiers, rarest first, are shown without a gap (the Debug legend can make gaps).
    let n = 0;
    while (n < TRAIT_TIERS.length && _appState.display.tiers.has(TRAIT_TIERS[n].key)) n++;
    return n;
  };

  refreshers.push(() => {
    // Target of a running assembly animation if any, else where it is.
    const assembled = (_appState.assemblyTarget ?? _appState.assembly) >= 0.5;
    for (const b of modeButtons) b.classList.toggle("on", (b.dataset.mainMode === "room") === assembled);
    for (const g of header.querySelectorAll(".gr-room-only")) g.classList.toggle("off", !assembled);
    q('[data-main="modeNote"]').classList.toggle("off", assembled); // shown in Screen mode only
    for (const b of shapeButtons) b.classList.toggle("on", b.dataset.mainShape === _appState.shapeName);
    q('[data-main="sim"]').checked = _appState.sim.on;
    q('[data-main="visitors"]').value = _appState.sim.count;
    q('[data-main="visitorsValue"]').textContent = _appState.sim.count;
    const fpvOn = _appState.fpv.on && _appState.fpv.transition?.dir !== "out";
    for (const b of viewButtons) b.classList.toggle("on", (b.dataset.mainView === "fpv") === fpvOn);
    q('[data-main="fpvWho"]').textContent = fpvOn ? `visitor ${_appState.fpv.visitorId}` : "";
    const n = tierCount();
    const exact = n === _appState.display.tiers.size; // no gaps from the Debug legend
    for (const b of densityButtons) b.classList.toggle("on", exact && Number(b.dataset.mainDensity) === n);
    q('[data-main="densityValue"]').textContent = exact && n
      ? `Traits in up to ${["a few", "dozens of", "hundreds of"][n - 1]} regions`
      : "Custom (see Debug)";
  });
}
