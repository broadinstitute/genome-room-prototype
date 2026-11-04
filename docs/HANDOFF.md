# Genome Room prototype — handoff

State as of 2026-11-04. Read this first, then [README.md](../README.md) (running it, URL options)
and [LIBRARY_NOTES.md](LIBRARY_NOTES.md) (viz_sandbox findings).

## What this is and why

A local science museum has a large walk-in space: projection on three walls and the floor,
auditorium scale, lidar tracking of visitors' positions and gestures. The pitch under exploration
is a **data-driven multiplayer genome explorer**: the genome is laid out around the walls, a visitor
standing in front of a region gets a readout about it, and links to other regions that share a
trait fan out (on the floor, or on the walls). Polygenic traits come from comparing regions that
several visitors stand near. Audience is kids to adults, so it has to read quickly. It must be
real data, not a cartoon. "Everything lights up" for highly polygenic traits is acceptable and can
be part of the story.

This repo is a **viz_sandbox prototype that simulates the room**: a 3D view of the surfaces, the
floor, and a stand-in visitor, seen from outside. It does not target the real projection hardware.

It has a second purpose: a spike on rendering viz_sandbox plots onto **surfaces other than the
world X-Y plane**, to shape a possible library change. That is what LIBRARY_NOTES.md records.

## Direction from the user (decisions already made)

- **Different data projections are the main goal.** The same visualization should map onto a room
  with corners, a rounded room, a half-cylinder, or other surfaces.
- **Text placement is not a priority.** Labels map with the surface and have not been tuned. A real
  installation would probably render text separately (per-screen overlays).
- **Flat mode is one continuous horizontal genome**, not wall panels laid out flat.
- **Assembly should look like a room assembling, with edges staying joined throughout.**
- The earlier three-visualizer plane approach was replaced by the shader projection ("experiment
  B"). It is kept in commit `93fe382` for comparison.
- The **"chromosome" row label was removed** on request.
- Prototype structure first; library changes come later, informed by LIBRARY_NOTES.md.

## Current state

Commit `9921148` on `main`. No git remote; nothing pushed or deployed.

Working:

- One genome strip: 631 bins of 5 Mb from real GRCh38 chromosome lengths. Top row is a chromosome
  band (alternating colours per chromosome); 8 trait rows below.
- **Trait values are placeholders**: deterministic hash, densities from 25% down to 1% of bins
  (`makePlaceholderTraits` in `src/app/genome.js`). The UI says so.
- Assembly from flat strip to standing surface, animated or by slider. Three shapes, with animated
  morphs between them.
- Hover a cell → focus on that bin → links to every bin sharing a trait with it.
- Three link styles (`?arcs=` or the Arcs buttons): floor arcs, wall arcs, floor arcs + drop lines.
- Trait rows can be hidden (`?tracks=none`); band height is a parameter (`?band=`).
- Light transparent wall tint, slightly lighter floor, page background matching the room.
- Corner registration brackets at the 8 corners of the **physical** room box.
- Camera: animations ease from the current view to a fit of the end state.
- `vite build` passes, and the deploy check reports the build data-free.

## How it works

### Coordinates

- **Room**: `room = { width: 24, depth: 16, height: 6 }` metres. A free parameter; the real room's
  dimensions are unknown. World X-Y is the floor, Z is up. The physical room box is
  x ∈ [0, W], y ∈ [0, D], z ∈ [0, H], open at y = 0.
- **Strip (ribbon) coordinates** `(s, t)`: s runs along the strip (0 … L, L = 2D + W = 56 m), t up it.
  The strip visualizer lives entirely in these coordinates. The first `rowLabelMargin` (3.2 m) of s
  is reserved for row labels; the bins fill the rest (`barWidth = (L − margin) / 631`).
- The genome plot is **top-aligned** to the strip (`wallBaseHeight` 0.8 + `stripHeight` 4.2), so the
  band stays in place when the trait rows are hidden. `_appState.stripPlotBottom` holds the plot's
  lower edge in t.

### The surface map — `src/app/ribbon.js`

- A **profile** is 5 constant-curvature segments (lengths + turn angles). `room` has 0.3 m corner
  arcs, `rounded` 8 m arcs, `arc` turns uniformly (a half-cylinder). `lerpProfile` blends two.
- `buildCenterline(profile, bend, anchor)` integrates the profile with turns scaled by `bend`, then
  moves it rigidly so the strip midpoint sits at `(W/2, D)` heading +X. Arc length is preserved
  whatever `bend` is, so **the map is isometric**: the strip never stretches or tears.
- `ribbonPoint(state, s, t, z)` = centerline point at s, offset z along the surface normal, then
  stood up by angle `stand` about the line y = axisY, z = 0. Returns point and normal.
- The same map exists in **GLSL** (`ribbon_map`) and **JS** (`ribbonPoint`). They are kept in step
  by hand: change one, change the other.
- `RibbonExtension` (a deck.gl `LayerExtension`) remaps every vertex in
  `DECKGL_FILTER_GL_POSITION`, after viz_sandbox's bounds transform. It also fades back-facing
  fragments (`backfaceAlpha` 0.1, the dollhouse cutaway). State goes in as a uniform block via the
  `ribbonUniforms` layer prop, so per-frame updates do not recompile.
- `applyRibbon(viz, uniforms)` in `strip_setup.js` sets the extension and uniforms on every
  `LayerDescription` of the strip through `setLayerProps`. It runs on every `update()`.
- `ribbonCoordinateAtPixel` turns a cursor into (s, t) by intersecting the pick ray with the surface
  cut into 0.25 m facets. deck's own `plotRelativeCoordinate` is wrong on any projected plot.

### Assembly and shape — `src/app/GenomeRoomApp.js`

- `assembly` 0 → 1. `phases()` splits it: `stand` (0 → 90°) over [0, 0.55], `bend` (0 → 1) over
  [0.45, 1] (`assemblySchedule`).
- Shape morph: `shapeFrom`, `shapeTo`, `shapeK`. `currentProfile()` blends them.
- `geometry({assembly, shapeK})` is **pure**: it returns ribbon state, floor outline (the centerline
  sampled every 0.5 m) and floor centre. `update()` applies it, pushes uniforms, rebuilds the floor.
- `animate(step, end)`: fits the camera once to `geometry(end)`, then each frame calls `step(e)`,
  `update()`, and sets a view state interpolated from the starting view (including any manual
  orbit) to that fit. Easing is quadratic in-out over `animationMs` (1600).
- `setAssembly` (slider) refits per position with `fitCamera()`. That fit searches zoom in 0.05
  steps, so the slider shows small zoom jumps. Re-running it every animation frame was the cause of
  the earlier camera stutter.

### Floor and links

- `src/app/floor_setup.js`: a `BoundedVisualizer` with bounds off, using plain deck layers in world
  coordinates. It is not projected: the floor is the X-Y plane. Layers: floor polygon (opacity =
  bend phase), room corner brackets, floor arcs (`PathLayer`, pixel width, tooltip), visitor
  (footprint + 1.7 m line).
- `setFocusBin(bin)` builds `focusLinks` (one per other bin sharing any trait), then
  `rebuildWallLinks()` and `rebuildFloor()`.
- **Floor arcs**: quadratic Béziers between the two bins' wall-base points. The control point
  blends from "hanging under the flat strip" to "bowed toward the floor centre" with assembly.
- **Wall arcs and drop lines** are geometry in **ribbon (s, t)**, drawn by a `SolidPolygonLayer` on
  the strip (`wallLinksLayer`), so the ribbon extension maps them. Each is cut into quads at most
  ~0.2 m long, because the map acts per vertex and a long polygon edge would cut across a bend as a
  chord. They are rebuilt only when the focus or arc mode changes, not per frame. Pixel-width
  `PathLayer` lines cannot be projected this way (LIBRARY_NOTES item 5), which is why these are
  polygons.
- Wall arcs hang from just under the genome down toward the floor; depth ∝ √(span / L).
- Drop lines run from the genome's lower edge to t = 0, the point where the floor arc starts.

### Parameters

Most live on `_appState` in `GenomeRoomApp.js`: `room`, `layout`, `assemblySchedule`, `camera`,
`colors`, `display`. URL parameters (`view`, `shape`, `arcs`, `tracks`, `band`, `probe`) are read in
`makeApp`; see the README. `tracks` and `band` change the heatmap's row structure, which is fixed
when it is built, so changing them means a reload (the checkbox does this). `arcs` switches live.

## Verifying changes

- The user keeps a dev server running (`npx vite --port 5199 --strictPort` was used here). Do not
  start a duplicate; ask for the port if unsure.
- Check behaviour in the running app, not just the build. A successful build proves little here:
  shader link errors only appear at runtime.
- Dev builds expose `window.__genomeRoom` (the `_appState`) and
  `__genomeRoom.debugRibbonPoint(s, t, z)`.
- Screenshots: the Playwright MCP browser was locked by another session, so a small
  `playwright-core` script was used instead. It launched the local Chromium from
  `~/Library/Caches/ms-playwright`, headed, 1600×1000, and ran wait / click / move / eval /
  screenshot steps. It lived in a session scratchpad and is not in the repo. Recreate it if needed.
- Useful checks:
  - Per-frame camera recording: wrap `vizDeckManager.setViewState` and look for sign flips in zoom,
    target or rotation across an animation.
  - `?probe=scatter`: dots and squares must coincide on curved corners.
  - The bottom-left readout: the ribbon-intersected coordinate should match the hovered cell.

## Known limits and rough edges

- **Placeholder traits.** Trait 1 covers 25% of bins, so a focus on it gives ~150 links, dense in
  every mode.
- **Wall arcs need wall space.** With trait rows shown, only ~0.65 m sits under the genome and the
  arcs squash. They read well with `?tracks=none`.
- Wall arcs and drop lines are not pickable. Hovering them would move the focus.
- Changing the focus in wall mode re-tessellates ~18–21k quads: 35–50 ms measured over two frames.
- Text is mapped but untuned: labels are small, can overlap, and read mirrored on back-facing walls.
- Corner brackets mark the physical room box, not the projected surface. The arc shape visibly
  overruns the side walls. This was a deliberate choice: it shows a projection against the real
  space. Revisit if surface-relative marks are wanted.
- `colors.floor` (opaque, opacity-faded) and `colors.wallSurface` (transparent) are separate
  settings and were tuned by eye only.
- The README's Interaction section covers the controls; there is no in-app help.

## Open threads (not started)

- **Real data**: GWAS Catalog associations (or similar), curated trait list, the "everything lights
  up" story for highly polygenic traits.
- **Visitor simulation**: several simulated visitors moving and dwelling; polygenic traits surfaced
  from loci that several visitors stand near.
- **Dwell drives depth**: local insets or discrete zoom levels when a visitor lingers. The user is
  concerned that continuous local zoom could become too complex to read.
- **Visitor's-eye perspective view.** viz_sandbox's deck manager hard-codes an orthographic
  OrbitView (LIBRARY_NOTES, "Related limits").
- **Per-screen text overlays** instead of mapped text.
- **Library change**: the `viz.setProjection({glsl, uniforms, map, invert})` sketch in
  LIBRARY_NOTES.md, plus the `BoundedScatterplotLayer` injection-merge bug found here.
- More projections, e.g. a floor-plus-walls continuous surface or an irregular room plan.
- A GitHub remote and deployment. The template's GitHub Pages and pattern-deploy paths are present
  but not set up. Ask before creating anything.

## File map

| File | Role |
|---|---|
| `src/main.jsx` | Boots the app into `#deckContainer`. |
| `src/app/GenomeRoomApp.js` | `_appState`: parameters, geometry, animation, camera, focus/links, wall-link geometry, hover readout. |
| `src/app/ribbon.js` | Profiles, centerline, JS and GLSL surface map, `RibbonExtension`, cursor → (s, t). |
| `src/app/strip_setup.js` | The strip `BoundedHeatmapVisualizer`, tessellated backdrop, wall-links layer, scatter probe, `applyRibbon`, `ExtensionSafeBoundedScatterplotLayer` workaround. |
| `src/app/floor_setup.js` | Floor visualizer: surface, corner brackets, floor arcs, visitor; `floorArcPath`. |
| `src/app/genome.js` | GRCh38 lengths, binning, placeholder traits, `formatBp`. |
| `src/app/controls.js` | DOM panels: assembly, shape, arcs, tracks toggle, legend, focus and cursor readout. |
| `docs/LIBRARY_NOTES.md` | Both projection approaches, workarounds, proposed API. |

Infrastructure follows `pattern-viz-prototype-template`: deck.gl 9.1.1 / luma 9.1.2 pinned
(deck 9.3 breaks bounded layers); viz_sandbox tracks `main`, refreshed by `prebuild`; never pin it
to a commit.
