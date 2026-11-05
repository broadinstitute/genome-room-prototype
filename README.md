# genome-room-prototype

Prototype for a projected, walk-in genome exhibit. The genome is one continuous strip, mapped onto
a room-scale surface: a room with corners, a rounded room, or a half-cylinder. The floor carries
links between regions that share a trait. The scene transitions between the strip lying flat (the
single-screen 2D layout, with the links as an arc diagram under it) and the assembled surface.

It is also a spike for rendering viz_sandbox visualizers onto surfaces other than the world X-Y
plane. The strip is a single `BoundedHeatmapVisualizer`; a deck.gl extension maps every vertex
through a surface function in the shader. Findings, as requirements for a library change, are in
[docs/LIBRARY_NOTES.md](docs/LIBRARY_NOTES.md). The earlier rigid-plane version (three wall
visualizers) is commit `93fe382`.

**Data:** genome bins come from GRCh38 chromosome lengths (5 Mb bins). The 16 traits are GWAS
Catalog associations (release e116, 2026-10-29), one study per trait, hits at p < 5e-8, pre-binned
into `src/app/gwas_traits.json` by `scripts/build_gwas_traits.py`. To rebuild:

```bash
curl -L -o catalog.zip https://www.ebi.ac.uk/gwas/api/search/downloads/associations/v1.0.2
python3 scripts/build_gwas_traits.py catalog.zip
```

## Run

```bash
npm install
npm run dev
```

URL options:
Defaults: assembled rounded room, bubbles mode, 12 m walls, no link arcs, trait density Medium
(`tiers=few,dozens`), simulation on with 10 visitors at 2.5× (off when starting as the flat
screen). The URL records a setting only when it differs from these.

- `?view=flat` — start as the flat strip instead of the assembled room.
- `?shape=room|rounded|arc` — starting shape (default rounded).
- `?mode=tracks` — the genome with trait rows (the original view). Default `bubbles`: the chromosome
  band alone at head height, hint ticks over regions with trait hits, and a cluster of trait bubbles
  that grows out of the hovered region. Options:
  `?head=<metres>` (band centre, default 1.6), `?bubbles=above|below` (cluster side, default
  above). Band height defaults to 0.3 m here; `?band=` overrides. Arcs default to none.
- `?links=ticks|arcs` (bubbles mode) — link style: ticks round each bubble with arcs only between
  open clusters, or (default) also a faint arc from every tick to its region, which shifts onto
  the other bubble when that region's cluster opens.
- `?fpv=1` (bubbles mode) — first-person view: the camera rides with one simulated visitor (starts
  the simulation); the camera glides between the room view and the visitor's eyes. `?fov=<degrees>`
  (default 85). Also the **First-person view** checkbox; **Next visitor** switches; Escape leaves.
- `?sim=0|1` (bubbles mode; default on in the room, off with `?view=flat`) — simulated visitors walk the room; dwelling in front of a region opens
  its cluster. `?visitors=<1–20>` (default 10), `?simSpeed=<0.25–8>` (simulation time scale,
  default 2.5), `?stay=<seconds>` (time a visitor spends at a region, ±40%; default 12).
- `?arcs=floor|wall|drop|none` — how a region's links are drawn: arcs across the floor (default), arcs
  on the wall hanging below the genome, or floor arcs plus a line down the wall from each linked
  region to its arc's end.
- `?tiers=few,dozens,many` — which trait tiers' links are drawn (any subset; default all). The
  strip's cells are not filtered.
- `?wall=<metres>` — wall height, 3–15 (default 12). The genome strip fills the wall between a
  0.8 m base and a 1 m top margin, so its rows grow with the wall.
- `?tracks=none` — hide the trait rows. Traits still drive the links and their colours.
- `?band=<metres>|full` — chromosome band height when the trait rows are hidden. Default: one trait
  row's height, so hiding the tracks leaves the band unchanged.
- `?probe=scatter` — diagnostic. Draws the same points as scatter dots and as polygon squares; they
  should coincide on every surface.

## Interaction

A transparent **header** over the full-window visualization: title, subtitle (the target: Ars
Electronica's Deep Space projection system at the Boston Museum of Science), description, and the
exhibit controls, one row each:
- **Mode**: Room (assembled) / Screen (the unfolded strip). Screen stops the simulation.
- **Room shape**: Square / Rounded / Arc.
- **Trait density**: Low / Medium / High (traits in up to a few / dozens / hundreds of regions).
- **Simulate visitors**: on/off, number of visitors, View: 3rd person / 1st person.

The camera frames the room in the space the header leaves free. **Bottom right**, a collapsed
**Debug** panel holds every prototype control below, the trait legend and the readout. The two
stay in sync.

- **Flat strip / Assembled** buttons animate the transition. The slider sets it directly. The strip
  stands up about its bottom edge, then bends into the current shape. Bending never stretches the
  strip, so genome distances are preserved and nothing separates.
- **Shape** buttons morph between room, rounded room and half-cylinder.
- Hover a cell to stand a visitor in front of that region. Links fan out to every other region
  sharing a trait with it. The tooltip lists every trait with a hit in that bin.
- The checkbox on each legend tier heading shows or hides that tier's links live (and, in bubbles
  mode, its ticks and bubbles).
- **View** buttons switch between trait tracks and bubbles mode (reloads with `?mode=`).
- In bubbles mode, **Simulate visitors** starts or stops the simulation live (the room assembles
  if it is flat); the visitor count, speed and stay time apply live too. While it runs, hovering the strip
  does not open clusters.
- In bubbles mode, hovering a bubble shows the trait, its gene count, and its hits in that region.
- **Arcs** buttons switch the link style live. The **Trait tracks** checkbox reloads with
  `?tracks=none` toggled. The **Wall height** box reloads with `?wall=` set.
- Drag to orbit, scroll to zoom (deck.gl orbit camera).
- The bottom-left panel compares the cursor position computed against the surface with the value
  deck reports. The two disagree for any projected plot.

## Layout

- `src/app/ribbon.js` — the surface: centerline profiles, the map f(s, t) in JS and GLSL, the
  deck.gl extension, cursor → (s, t) by ray–facet intersection.
- `src/app/strip_setup.js` — the genome strip visualizer.
- `src/app/floor_setup.js` — floor, floor arcs, stand-in visitor, corner registration brackets at
  the physical room's 8 corners.
- `src/app/genome.js` — GRCh38 lengths, binning, GWAS traits re-binned to the app's bins, tiers.
- `src/app/gwas_traits.json` — generated; do not edit by hand.
- `scripts/build_gwas_traits.py` — the curated trait list (one study per trait) and the build.
- `src/app/GenomeRoomApp.js` — app state, parameters, assembly and shape animation, camera, wall
  arc / drop line geometry.
- `src/app/controls.js` — plain-DOM control and readout panels.

[docs/HANDOFF.md](docs/HANDOFF.md) describes the prototype as a whole for picking the work up.

Infrastructure (deck.gl/luma/loaders pins, viz_sandbox tracking `main`, data-free deploy) follows
`pattern-viz-prototype-template` with the gallery's newer kit version. Both template deploy paths
(GitHub Pages and pattern-deploy) are still present; neither has been set up.
