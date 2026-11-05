# Genome Room prototype — handoff

State as of 2026-11-05. Read this first, then [README.md](../README.md) (running it, URL options)
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

On `main` (see `git log`), pushed to the public repo https://github.com/broadinstitute/genome-room-prototype.

**UI** (`src/app/controls.js`): a transparent exhibit header over the full-window canvas — title
"Polygenomic Exploration Room" (34 px), subtitle naming the target (Ars Electronica's Deep Space
projection system — linked to ars.electronica.art/solutions/en/deepspace/ — installed at the Boston
Museum of Science), the description (projection on
walls and floor, lidar tracking, linger to open traits, shared traits connect people), then one
row per control group (label column, controls to its right), as segmented toggles styled from the
visualization palette (`colors.wallSurface` borders, `colors.band[1]` for the active segment):
- **Mode**: Room / Screen = `animateAssembly(1 / 0)`, `?view=flat`. Screen stops the simulation
  (and first person; the camera glides out of first person before the room unfolds).
- **Room shape**: Square / Rounded / Arc (the `room` profile's label is "Square"; `?shape=room`).
- **Trait density**: Low / Medium / High = the 1, 2 or 3 rarest tiers via `setTiers` ("Custom" if
  the Debug legend leaves a gap).
- **Simulate visitors** (header checkbox), with indented sub-controls: number of visitors 1–20;
  View: 3rd person / 1st person (1st person starts the simulation).

The header has `pointer-events: none` except on the control groups, so the canvas stays
draggable. Its layout is measured into `viewInset` (`top` = below the text, `left` = right of the
control column, `headerBottom`), kept in step by a `ResizeObserver`. `fitViewState` fits the content
into whichever free area shows it larger: right of the controls and below the text (the room) or
full width below the whole header (the flat strip). Everything else is in a collapsed **Debug**
panel bottom right. Both register refreshers on `_appState.onStateChange`.

**Defaults**: assembled (`?view=flat` for the strip), rounded, bubbles mode (`?mode=tracks` for the
trait-row view), arcs none, bubble links as faint arcs (`?links=ticks` for ticks only), 12 m walls, trait density Medium (`DEFAULT_TIERS` = few, dozens),
simulation on (`?sim=0` off; off by default when starting as the flat screen) with 10 visitors at
2.5×. The URL records only deviations (`recordSimParam`, `recordTiersParam`).

Working:

- One genome strip: 631 bins of 5 Mb from real GRCh38 chromosome lengths. Top row is a chromosome
  band (alternating colours per chromosome); 16 trait rows below.
- **Traits are real GWAS Catalog data** (release e116, 2026-10-29). See "Trait data" below.
- Assembly from flat strip to standing surface, animated or by slider. Three shapes, with animated
  morphs between them.
- Hover a cell → focus on that bin → links to every bin sharing a trait with it. The tooltip lists
  every trait with a hit in that bin (strongest p, gene), on any row including the band.
- Three link styles (`?arcs=` or the Arcs buttons): floor arcs, wall arcs, floor arcs + drop lines.
- Links filter by trait tier (`?tiers=` or the legend tier checkboxes).
- Trait rows can be hidden (`?tracks=none`); band height is a parameter (`?band=`).
- Wall height is adjustable (`?wall=` or the Wall height box); the strip fills it.
- **Bubbles mode** (the default; `?mode=tracks` or the Debug View buttons switch): band alone at head height, hint ticks,
  animated trait-bubble cluster at the focus. See "Bubbles mode" below.
- **Simulated visitors** in bubbles mode (`?sim=1`): dwell opens clusters; traits shared between
  open clusters are linked. See "Simulated visitors" below.
- Light transparent wall tint, slightly lighter floor, page background matching the room.
- Corner registration brackets at the 8 corners of the **physical** room box.
- Camera: animations ease from the current view to a fit of the end state.
- `vite build` passes, and the deploy check reports the build data-free.

## How it works

### Coordinates

- **Room**: `room = { width: 24, depth: 16, height: 6 }` metres. A free parameter; the real room's
  dimensions are unknown. Height is adjustable (`?wall=`, 3–15 m, or the Wall height box). World X-Y is the floor, Z is up. The physical room box is
  x ∈ [0, W], y ∈ [0, D], z ∈ [0, H], open at y = 0.
- **Strip (ribbon) coordinates** `(s, t)`: s runs along the strip (0 … L, L = 2D + W = 56 m), t up it.
  The strip visualizer lives entirely in these coordinates. With trait rows shown, the first
  `rowLabelMargin` (3.2 m) of s is reserved for row labels and the bins fill the rest. Without
  them (bubbles mode, `?tracks=none`) there are no row labels, so both ends get `stripSideMargin`
  (1.6 m). `barWidth = (L − rowLabelMargin − stripEndMargin) / 631`.
- `stripHeight` is derived: `room.height − wallBaseHeight (0.8) − wallTopMargin (1.0)`, 10.2 m at the
  default 12 m wall (4.2 m at 6 m). Row heights scale with it.
- The genome plot is **top-aligned** to the strip (`wallBaseHeight` + `stripHeight`), so the
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

### What the projection supports

- **Shapes.** The mechanism takes any continuous f(s, t, z) → world that can be written in GLSL
  (dome, ceiling, sloped wall, twisted strip). The **current** `ribbon_map` covers one family only:
  a floor-plane centerline of exactly 5 constant-curvature segments, extruded vertically, tilted
  about one axis. Any other surface needs a new GLSL map, its JS twin, and a cursor inverse (the
  facet search generalizes). Isometry (no stretching) holds only for bent-sheet surfaces like this
  one; a sphere or dome would distort.
- **Per-vertex limit.** f moves vertices, so large polygons must be cut narrow or they render as
  chords across a bend.
- **Layers.** Works: polygons (`BoundedSolidPolygonLayer`, `SolidPolygonLayer`), `TextLayer` with
  `billboard: false`, `BoundedScatterplotLayer` (with the injection workaround). Does not work:
  pixel-width `LineLayer` / `PathLayer` / `BoundedLineLayer` (width applied after the hook).
  Works (verified, bubbles-mode faint arcs): `PathLayer` with `billboard: false` and
  `widthUnits: "common"`. Untested: `BoundedBoxLayer`.
- **Plots.** Heatmap: verified. Scatter: verified via `?probe=scatter`. Bars: should work if cut
  into strips; untested. Line charts and `makeChart` axes/ticks: no (pixel-width lines). Navigable
  plots: rendering maps, but wheel zoom, drag and scrollbars use `plotRelativeCoordinate`, which is
  wrong on a projected plot.
- **viz_sandbox contract it relies on.** `applyRibbon` reaches layers only through `setLayerProps`;
  a custom generator that does not spread passthrough props stays flat silently. Bounds clipping and
  GPU picking work because both run before / through the same vertex shader. Extents and camera fit
  come from the JS twin, not `getWorldExtents`. Details and the proposed API: LIBRARY_NOTES.md.

### Assembly and shape — `src/app/GenomeRoomApp.js`

- `assembly` 0 → 1. `phases()` splits it: `stand` (0 → 90°) over [0, 0.55], `bend` (0 → 1) over
  [0.45, 1] (`assemblySchedule`).
- Shape morph: `shapeFrom`, `shapeTo`, `shapeK`. `currentProfile()` blends them.
- `geometry({assembly, shapeK})` is **pure**: it returns ribbon state, floor outline (the centerline
  sampled every 0.5 m) and floor centre. `update()` applies it, pushes uniforms, rebuilds the floor.
- `animate(step, end)`: fits the camera once to `geometry(end)`, then each frame calls `step(e)`,
  `update()`, and sets a view state interpolated from the starting view (including any manual
  orbit) to that fit. Easing is quadratic in-out over `animationMs` (1600).
- **Camera fit** (`fitViewState`): our own, not viz_sandbox's `expandTargetViewStateToWorldPoints`
  (which measures the whole window and steps zoom in 0.05 increments). It projects the corner
  points at zoom 0, scales zoom so their screen box fits the free area in `viewInset` (less the
  `camera.padding` 0.3 zoom), and moves the target so the box is centred there. The new target is
  the floor point on the line of sight through the pixel that must become the centre
  (`OrbitViewport.unproject` ignores `targetZ`, so the unprojected point is slid along the view
  direction to z = 0). Exact, so `setAssembly` (slider) refits per position without zoom jumps.
- **Rotation pivot** (`keepPivot`): that target is the orbit pivot, and it sits ~10 m behind the
  room, so mouse rotation swung the room around its back corner. deck uses the view state returned
  from `onViewStateChange` (wrapped after the deck manager's handler); on any rotation change the
  target is re-solved so the room's 3D bounding-box centre stays on its pixel. Pans and zooms pass
  through. Not view `padding`: deck applies padding as a projection skew (`matrix[8]`/`[9]`),
  which shears an orthographic view.

### Floor and links

- `src/app/floor_setup.js`: a `BoundedVisualizer` with bounds off, using plain deck layers in world
  coordinates. It is not projected: the floor is the X-Y plane. Layers: floor polygon (opacity =
  bend phase), room corner brackets, floor arcs (`PathLayer`, pixel width, tooltip), visitor
  (person pictogram).
- `setFocusBin(bin)` sets the focus and calls `rebuildLinks()`. That builds `focusLinks` (one per
  other bin sharing a trait whose tier is in `display.tiers`), sorts them most-polygenic first so
  few-region links draw on top, pushes them as a new **link set** (earlier sets switch to
  fading out), then calls `rebuildWallLinks()`, `rebuildFloor()` and `animateLinks()`.
  `setTierVisible(tier, on)` (legend checkboxes) changes `display.tiers` and calls `rebuildLinks()`.
- **Link animation**: `_appState.linkSets` holds the entering set and any fading ones. One rAF
  loop (`animateLinks`) advances each set's clock `g` (ms); fading sets drop to zero alpha over
  `arcFadeMs` (350) and are removed. Each link has its own duration, `growMs = arcGrowMinMs (250)
  + arcGrowMsPerMetre (22) × strip distance between the two regions` (~1.4 s for the longest),
  and eases out cubic on it (`linkGrowth`), so long links arrive later than short ones.
  `linkTiming()` gives the offsets: in drop mode the focus line drops first (`dropLineMs` 180),
  each floor arc then grows on its own duration, and as it lands a line rises at its linked
  region (`riseLineMs` 160).
  - Floor arcs are rebuilt per frame and cut to length (`truncatePath`) from the focus end.
  - Wall quads keep their geometry for the life of a set; each carries its set and `appearMs`
    (the set time at which it appears: the inverse of the link's easing at the quad's position). Per frame only colours change (`wallQuadColor`, re-evaluated through
    `updateTriggers: { getFillColor: linkFrame }`), because re-tessellating the quads every frame
    is far too slow.
- **Floor arcs**: quadratic Béziers between the two bins' wall-base points. The control point
  blends from "hanging under the flat strip" to "bowed toward the floor centre" with assembly.
- **Wall arcs and drop lines** are geometry in **ribbon (s, t)**, drawn by a `SolidPolygonLayer` on
  the strip (`wallLinksLayer`), so the ribbon extension maps them. Each is cut into quads at most
  ~0.2 m long, because the map acts per vertex and a long polygon edge would cut across a bend as a
  chord. They are rebuilt only when the link sets or arc mode change, not per frame. Pixel-width
  `PathLayer` lines cannot be projected this way (LIBRARY_NOTES item 5), which is why these are
  polygons.
- Wall arcs hang from just under the genome down toward the floor; depth ∝ √(span / L).
- Drop lines run from the genome's lower edge to t = 0, the point where the floor arc starts.

### Bubbles mode — `src/app/bubbles.js`

A separate view, requested as a first look at an "approach a region" design. Bubbles will
eventually be trait icons; ticks are meant as points of interest a visitor walks toward.

- **Chromosome labels** (both modes): Helvetica; baseline anchored on the far side of the label
  `columnLabelGap` (0.06 m) from the band. The library default centres labels on a point
  ~0.06 m off the band, so 0.3 m labels overlapped it.
- **Band**: trait rows off, band only (`layout.headBandHeight` 0.3 m), centred on
  `layout.headHeight` (1.6 m, `?head=`). `makeStripViz` centres the plot when
  `plotCenterHeight` is set; `_appState.stripPlotHeight` holds its height. Chromosome labels sit
  on the side away from the bubbles; the axis title is dropped. Arcs default to `none`.
- **Hint ticks** (`buildHintTicks`): one per bin with a hit in a visible tier, just outside the
  band on the bubble side. Length = `hintTickBase` + `hintTickPerTrait` × traits hit. Colour =
  the hit trait touching the fewest bins, so a rare-trait region shows warm over height's blue.
  Rebuilt on tier change.
- **Bubbles** (`buildBubbleTargets`, `animateBubbles`): one per trait hit in the focus bin
  (visible tiers). Radius = `bubbleMinRadius` + `bubbleRadiusPerDecade` × log10(geneCount):
  log-scaled, because area-true sizing makes height (2242 genes) 47× blood type's radius.
  `geneCount` (`genome.js`) = distinct mapped genes over the trait's 1 Mb loci (the strongest
  hit's gene in each) — a proxy for "related genes". Packed by a greedy tangent packer
  (`packCircles`, largest first), centred over the bin, shrunk to fit the wall, kept on the strip.
- **Bracket**: a stem from the band edge at the bin out to a bar `bracketOffset` (0.3 m) off the
  band, clearing most hint ticks; the bar spans the cluster's width (and the bin), with end ticks
  turned toward the cluster. The region's start and end (`chr6:30,000,000`, `chr6:35,000,000`;
  GRCh38 bin bounds, so a chromosome's last bin ends at its length) sit just outside the bar's
  ends in 0.07 m Helvetica (`bracketLabelSize`), fading in with the end ticks — meant to be read
  only from right in front of the wall, as a reminder the data is real. Thin quads in (s, t), the bar cut into ≤ 0.2 m pieces so it bends
  with the surface — CPU geometry, ~20 quads a frame, no line shader needed (pixel-width lines
  can't go through the ribbon map anyway).
- **Animation**: each cluster has a timeline clock `g` (ms). Entering: the stem grows
  (`bracketStemMs` 120), the bar spreads from the stem to both ends (`bracketBarMs` 200), and
  from `bubbleLeadMs` (200) bubbles grow out of the stem's end to their packed positions, largest
  first, staggered (`bubbleMs` 520, `bubbleStaggerMs` 60). Position eases out cubic; radius eases
  out with a slight overshoot; fill fades in; labels fade in over the last 40%.
- **Exit**: on a focus or tier change, every current cluster switches to `out` and plays its
  timeline backward at `bubbleExitSpeed` (1.8×) — labels fade, bubbles shrink back into the stem
  smallest first, then the bar and stem retract — while the new cluster enters. Clusters live in
  `_appState.bubbleClusters`; one rAF loop draws them all, drops finished exits, and stops when
  everything is at rest. Each frame rebuilds the polygons and calls `stripViz.updatePlot()`.
- **Rendering**: discs are 40-gon polygons in ribbon (s, t) on the strip, so they bend with the
  surface; labels are a `TextLayer` with `sizeUnits: "common"`. Both mapped by the ribbon
  extension like the cells. Bubbles are pickable (tooltip) but do not move the focus.

### Simulated visitors — `src/app/visitors.js`

The "multiplayer" model: several visitors at once, each opening a cluster by dwelling. Bubbles
mode only. URL `?sim=1&visitors=<n>&simSpeed=<×>`, or the Simulate visitors controls (live).
Decisions taken with the user: drive bubbles mode; links for traits shared between clusters;
wander biased toward hint ticks; toggle + count + speed.

- **Movement** (stands in for people): each visitor walks to a target 0.8–1.4 m in front of a
  region, setting off at `accel` 0.8 m/s² up to a cruising 0.9–1.4 m/s and braking on the stopping
  curve v = √(2·`decel`·distance left), `decel` 0.6 m/s² (~1 m and ~1.5–2 s to stop). Straight
  legs; heading changes are instant. At a region it stays `config.stay` s ±40% (default 12;
  `?stay=` or the Stay control), then picks another. Target regions must have a hit in a shown
  tier; they are weighted by the rarest shown trait there (`weightByTier` few 8 / dozens 3 /
  many 1) and exclude regions within 4 bins of another visitor's target or dwell. 20% of targets
  are open floor (pass-through, 0.5–2 s). New visitors walk in from the open front. Simulation
  time (`sim.time`) runs at `sim.speed`×; animations run in real time.
- **Recruiting** (point of the multiplayer story): when a visitor starts dwelling, with
  `recruitChance` 0.8 the nearest free visitor (not dwelling or about to, not already recruited
  or waiting) is sent to a region linked to it — sharing a shown trait, rarer shared traits
  weighted up as above. The dweller then waits (`waitFor`) until the recruit dwells, or until a
  deadline of walking time + `recruitSlackMs` 4 s + the dwell trigger, even past its own stay.
- **Linked holds**: when a visitor starts dwelling at a region sharing a shown trait with another
  dweller's region, both hold for at least `linkedHoldMs` 6 s from then (`holdUntil`). With
  "hundreds" shown, height links nearly every pair, so holds are common.
- **Tier changes** (`onTiersChanged`): visitors heading to a region that lost its shown hits pick
  a new target; visitors dwelling at one move on.
- **Detection** (stands in for tracking — reads positions only, never targets): nearest wall
  point by sampling the centerline every 0.25 m, refined to 1 cm (`nearestWall`; the coarse step
  is ~3 bins). The bin there snaps to the nearest bin within `snapBins` 3 that has a shown hit
  (as an installation would snap to its nearest point of interest; near room corners the nearest
  wall point can be a few bins off the region faced); none → not a dwell. Within `dwellRange`
  2.2 m of the wall and slower than `stillSpeed` 0.25 m/s at the same region (±1 bin) for
  `dwellTriggerMs` 1.5 s → open that visitor's cluster. Moving for `releaseMs` 0.6 s → close it.
  Movement pauses while the room is not fully assembled (the centerline is the wall base only
  then).
- **Clusters per owner**: `setClusterFocus(_appState, owner, bin)` opens or moves one owner's
  cluster ("mouse" or `visitor-<id>`); null closes it. New clusters slide sideways off open ones
  (`clusterGap` 0.25 m); the bracket's bar still spans from the region to the cluster.
- **Shared traits**: a trait with bubbles in two or more clusters gets a link from each bubble to
  the next (oldest cluster first), in the trait's colour (shape: see link ticks below), drawn to the smaller of the
  two bubbles' entrance progress, so it grows as the second appears and retracts as either
  exits. Both bubbles get a light outline. `sharedTraitKeys` lists them; the bottom panel shows
  visitors, dwelling count and shared traits.
- **Link ticks** (all clusters, mouse or simulated): each bubble has one tick per other region
  where its trait has a hit, so a bubble shows its links to regions nobody is standing at — height
  a dense fringe, blood type none. Ticks sit on the half of the bubble away from the band, where
  the arcs go. Placement is a genome compass, not the literal wall direction (on a 56 m strip
  nearly every literal direction is horizontal): left quarter = regions to the left on the genome,
  right quarter = to the right; the angle from straight out is `linkTickMaxAngle` (70°) × strip
  distance / strip length, so neighbours point straight out and the strip's far ends toward the
  side, never flat. Ticks toward another open cluster's region are longer and light
  (`linkTickOpen`). The shared arc is a cubic from that tick's tip to the matching tick's tip on
  the other bubble, its handles along the two ticks (`sharedLinkHandle` 0.35 × distance, min
  `sharedLinkMinHandle` 0.3 m, cut to keep the curve on the wall), so it leaves and arrives
  exactly in the ticks' directions. Ticks fade in over the second half of a bubble's
  entrance. `bubblePad` is 0.12 m to make room for them.
- **Link styles** (`display.bubbleLinks`, `?links=ticks|arcs`, the Links buttons, live):
  - `ticks`: ticks, plus arcs only between open clusters, growing as the second
    bubble appears.
  - `arcs` (default): also a faint arc (`faintArcAlpha` 26/255, `faintArcWidth` 0.012 m) from every tick to
    its region on the band, arriving straight in. When that region's cluster opens, the arc
    shifts: its far end slides from the band to the new bubble's tick and it brightens to a full
    shared link, by the new bubble's entrance progress (and back when either closes). Faint arcs
    are a `PathLayer` (not billboarded, widths in world units, so the ribbon map applies — the
    width offset is added before `DECKGL_FILTER_GL_POSITION`), rebuilt each animation frame:
    ~4,500 paths with all tiers and five clusters kept frames at 17 ms (p95), 34 ms worst.
- **Floor**: each visitor is a gender-neutral restroom-style pictogram (inline SVG, `IconLayer`
  mask, billboarded, 1.7 m tall in world units, feet at the position, min 12 px). Simulated
  visitors are grey until dwelling, white while their cluster is open; a ring on the floor round
  their feet fills as the dwell builds. The mouse-mode stand-in uses the same figure.

### First-person view — `src/app/first_person.js`

Bubbles mode with simulated visitors: the camera rides with one visitor (random; **Next visitor**
picks another). Toggle: **First-person view** checkbox, `?fpv=1`, Escape leaves. Turning it on
starts the simulation if needed.

- **View swap**: `vizDeckManager.setView(new FirstPersonView({ id: "3d-scene", fovy: 85, near:
  0.05, controller: false }))` (fov: `?fov=`, 30–120), view state `{ position: [x, y, eyeHeight], bearing, pitch }` in world
  metres (no latitude: a non-geospatial viewport). Off: `setView(generateView())` and the saved
  orbit view state. While on, `fitCamera` and the animation camera step do nothing.
- **deck conventions** (checked against math.gl `SphericalCoordinates`): bearing 0° looks along
  +y, 90° along +x (clockwise from above); positive pitch looks down.
- **Camera**: eye 1.6 m above the visitor. Walking (> 0.15 m/s): face the walk, 4° up. Standing
  at a region: face the wall point of the region, 12° up, 26° once the cluster is open (the
  bubbles are overhead at ~1.2 m from the wall). Heading and pitch ease with a 0.5 s time
  constant. Updated from the simulation loop (`onSimFrame`).
- **Transition** (both directions, 1.8 s, cubic in-out; reversible mid-way): a dolly zoom with a
  `FirstPersonView` throughout. Each end is a look-at point, bearing, pitch, fov and the scene
  height visible at the look-at point. Orbit end: an orbit's `rotationOrbit` / `rotationX` are
  exactly a bearing / pitch (probed: direction = (cos rx·sin ro, cos rx·cos ro, −sin rx)); visible
  height = viewport height / 2^zoom; fov `orthoFovy` 0.5°, at which perspective is visually
  orthographic. First-person end: the live pose, look-at point `focusDistance` 3 m ahead. In
  between: look-at point and angles interpolate, fov and visible height interpolate in log space,
  camera at visible / (2·tan(fov/2)) behind the look-at point; near/far follow that distance. At
  the orbit end the real OrbitView takes over; verified no visible jump on the first frame.
- **View swaps go through `swapView`**, which finalizes the controller a swap replaces (deck
  9.1.1 leaks it when the controller type changes; the leaked FirstPersonController snapped the
  orbit camera back at the end of every drag after leaving first person — see LIBRARY_NOTES).
- **People as meshes**: deck sizes billboard offsets (IconLayer, LineLayer pixel widths) by the
  viewport's focal distance, not each vertex's depth — fine for the orbit view, but under a
  `FirstPersonView` (focal distance 1) icons shrink to specks and pixel lines vanish. Visitors are
  now a flat pictogram mesh (`SimpleMeshLayer`, unlit) turned each frame to face the camera's
  bearing (`cameraBearing()`; also on orbit drags). Corner brackets, dwell rings and floor arcs are
  billboarded `PathLayer`s (billboarded paths multiply their offset by clip w, so pixel widths
  hold in every view).
- **Visitors visualizer**: people moved off the floor visualizer to `visitorViz`, created after
  the strip, because with depth testing off layers draw in visualizer order and the band and
  bubbles painted over anyone in front of them. The followed visitor's figure is skipped.

### Parameters

Most live on `_appState` in `GenomeRoomApp.js`: `room`, `layout`, `assemblySchedule`, `camera`,
`colors`, `display`. URL parameters (`view`, `mode`, `head`, `bubbles`, `links`, `stay`, `sim`, `fpv`, `visitors`, `simSpeed`, `shape`, `arcs`, `tiers`, `wall`, `tracks`, `band`, `probe`) are read in
`makeApp`; see the README. `mode`, `head`, `bubbles`, `wall`, `tracks` and `band` change the heatmap's row structure or placement, which is fixed
when it is built, so changing them means a reload (the checkbox and Wall height box do this). `arcs` switches live.

## Trait data

- **Source:** GWAS Catalog associations download (v1.0.2 "alternative" zip, ~70 MB). The build
  script reads the zip directly. The download is not in the repo; the 88 KB pre-binned output is.
  It is bundled into the JS (an import), which the template's data-free check allows: it only
  rejects CSVs and `data/` directories in the output.
- **Selection:** `TRAITS` in `scripts/build_gwas_traits.py`, one GWAS Catalog study accession per
  trait. Chosen by profiling candidate studies for significant hits, bins hit and top genes, and
  checking that the expected locus is the strongest: ABO at chr9 ~133 Mb, ALDH2 and ADH1B for
  alcohol flush, MC1R for red hair, HERC2/OCA2 for eye colour, HLA for coeliac.
- **Per bin:** strongest -log10 p, hit count, and the mapped gene of the strongest hit. In the app a
  cell's value is log(mlog / 7.3) / log(max mlog / 7.3), so a trait dominated by one locus shows one
  bright cell and dim others. For eye colour, HERC2 is p ≈ 1e-28539 and the next locus is 1e-321.
- **Tiers** (`TRAIT_TIERS` in `genome.js`), by app bins hit, set the colour families and legend
  groups: few (≤ 6 bins, warm), dozens (≤ 60, green), hundreds (blue/violet).
- **Current list:**
  - Few: ABO blood type, alcohol flush, bitter taste, red hair, earlobes, freckles, coriander,
    coeliac.
  - Dozens: hair shape, eye colour, coffee, left-handedness, photic sneeze.
  - Hundreds: male-pattern baldness, chronotype, height.
- **Caveats to carry forward:**
  - **Bin counts track study size, not only biology.** A small study finds few loci. Eye colour has
    5 bins in a 5k-person study and 23 in a 157k one. The few-region tier mixes true single-gene
    traits (ABO, red hair at MC1R) with small studies (earlobes, freckles: n ≈ 8–9k).
  - **Ancestry varies by study.** ABO, earlobes and alcohol flush are East Asian cohorts; most
    others are European.
  - **Bitter taste:** the study used (Hwang 2018, multivariate) has its strongest signal at the
    chr12 TAS2R cluster. TAS2R38 (chr7) is barely significant. The classic PTC/PROP story is
    TAS2R38; no large PTC-specific study is in the Catalog.
  - **Coeliac:** the Immunochip study (GCST005523) excludes HLA, so it was swapped for GCST90468120.
  - **Lactase persistence and wet/dry earwax** were candidates but have no usable GWAS Catalog
    entry. They would need a hand-entered locus (LCT/MCM6 chr2, ABCC11 chr16) from the literature.
  - Some 23andMe studies (Pickrell 2016: photic sneeze, monobrow, chin dimples) list ~50 hits in
    the Catalog, so they land in "dozens".

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

- **Height swamps the links.** Height has a hit in 551 of 631 bins, so nearly every focus brings
  ~550 height links (plus ~260 each for baldness and chronotype). Links are drawn most-polygenic
  first so a few-region trait's links sit on top, but the floor is still mostly blue. That is the
  real "everything lights up" story. The tier checkboxes in the legend (or `?tiers=few`) hide
  the polygenic tiers' links; the strip's cells stay unfiltered.
- **Wall arcs need wall space.** With trait rows shown, only ~0.65 m sits under the genome and the
  arcs squash. They read well with `?tracks=none`. A taller wall does not help with tracks shown:
  the extra height goes to the rows, and the space under the genome stays at the 0.8 m base.
- Wall arcs and drop lines are not pickable. Hovering them would move the focus.
- Changing the focus in wall mode re-tessellates every wall quad of the entering and fading sets:
  ~81k quads at a chr16 bin with all tiers on, one 150 ms frame. The growth after it runs at
  ~19 ms a frame (colours only). With `?tiers=few,dozens` it is ~4k quads.
- Text is mapped but untuned: labels are small, can overlap, and read mirrored on back-facing walls.
- Corner brackets mark the physical room box, not the projected surface. The arc shape visibly
  overruns the side walls. This was a deliberate choice: it shows a projection against the real
  space. Revisit if surface-relative marks are wanted.
- `colors.floor` (opaque, opacity-faded) and `colors.wallSurface` (transparent) are separate
  settings and were tuned by eye only.
- Bubbles mode:
  - With all tiers on, 561 of 631 bins get a tick (height again). The hints only single out
    regions with `?tiers=few,dozens` or the tier checkboxes.
  - Moving to an adjacent bin overlaps the exiting and entering clusters in nearly the same
    place for ~0.5 s, which reads as a flicker of doubled bubbles. Sweeping the cursor stacks
    several exiting clusters.
  - The greedy packer leaves gaps; it is not an optimal packing.
  - Labels are sized to fit the bubble, so small bubbles' labels are hard to read.
  - The default camera frames the whole room; the bubbles are small at that zoom.
- The README's Interaction section covers the controls; there is no in-app help.

## Open threads (not started)

- **Trait data, next steps**: a per-trait toggle (tier filter exists); per-trait weighting by variance explained rather than -log10 p; hand-entered loci for
  lactase persistence and earwax; larger studies for the small-study traits; an ancestry-aware
  framing for the exhibit.
- **Visitor simulation, next steps**: collision avoidance between visitors; groups that move
  together; visitors leaving and arriving; drive trait-tracks mode (arc fans per visitor); a
  stronger polygenic moment when three or more visitors share a trait.
- **Dwell drives depth**: local insets or discrete zoom levels when a visitor lingers. The user is
  concerned that continuous local zoom could become too complex to read.
- **First-person view, next steps**: a visitor-controlled (not simulated) walk; head bob or
  gaze that wanders between bubbles; text is mapped for distance viewing and reads small up
  close.
- **Per-screen text overlays** instead of mapped text.
- **Library change**: the `viz.setProjection({glsl, uniforms, map, invert})` sketch in
  LIBRARY_NOTES.md, plus the `BoundedScatterplotLayer` injection-merge bug found here.
- More projections, e.g. a floor-plus-walls continuous surface or an irregular room plan.
- Deployment. The template's GitHub Pages workflow (`.github/workflows/build-deploy.yml`) runs on
  every push to `main`; it needs Pages enabled for the repo (source: GitHub Actions) and the
  `ACTIONS_CLASSIC` secret for the private dependency installs. pattern-deploy (App Engine) is not
  set up. Ask before changing either.

## File map

| File | Role |
|---|---|
| `src/main.jsx` | Boots the app into `#deckContainer`. |
| `src/app/GenomeRoomApp.js` | `_appState`: parameters, geometry, animation, camera, focus/links, wall-link geometry, hover readout. |
| `src/app/ribbon.js` | Profiles, centerline, JS and GLSL surface map, `RibbonExtension`, cursor → (s, t). |
| `src/app/strip_setup.js` | The strip `BoundedHeatmapVisualizer`, tessellated backdrop, wall-links layer, scatter probe, `applyRibbon`, `ExtensionSafeBoundedScatterplotLayer` workaround. |
| `src/app/floor_setup.js` | Floor visualizer: surface, corner brackets, floor arcs, visitor; `floorArcPath`. |
| `src/app/genome.js` | GRCh38 lengths, binning, `makeGwasTraits` (re-bin, values, tiers, gene counts), `formatBp`. |
| `src/app/visitors.js` | Visitor simulation: movement, recruiting, holds, dwell detection, floor markers. |
| `src/app/first_person.js` | First-person view: swaps in a deck `FirstPersonView`, follows one simulated visitor. |
| `src/app/bubbles.js` | Bubbles mode: hint ticks, circle packing, clusters and brackets, enter/exit animation, layers. |
| `src/app/gwas_traits.json` | Generated trait data. |
| `scripts/build_gwas_traits.py` | Curated trait list and the Catalog → JSON build. |
| `src/app/controls.js` | DOM panels: assembly, shape, arcs, wall height, tracks toggle, legend with tier filter, focus and cursor readout. |
| `docs/LIBRARY_NOTES.md` | Both projection approaches, workarounds, proposed API. |

Infrastructure follows `pattern-viz-prototype-template`: deck.gl 9.1.1 / luma 9.1.2 pinned
(deck 9.3 breaks bounded layers); viz_sandbox tracks `main`, refreshed by `prebuild`; never pin it
to a commit.
