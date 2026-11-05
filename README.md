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
- `?view=room` — start assembled instead of flat.
- `?shape=room|rounded|arc` — starting shape.
- `?arcs=floor|wall|drop` — how a region's links are drawn: arcs across the floor (default), arcs
  on the wall hanging below the genome, or floor arcs plus a line down the wall from each linked
  region to its arc's end.
- `?tiers=few,dozens,many` — which trait tiers' links are drawn (any subset; default all). The
  strip's cells are not filtered.
- `?tracks=none` — hide the trait rows. Traits still drive the links and their colours.
- `?band=<metres>|full` — chromosome band height when the trait rows are hidden. Default: one trait
  row's height, so hiding the tracks leaves the band unchanged.
- `?probe=scatter` — diagnostic. Draws the same points as scatter dots and as polygon squares; they
  should coincide on every surface.

## Interaction

- **Flat strip / Assembled** buttons animate the transition. The slider sets it directly. The strip
  stands up about its bottom edge, then bends into the current shape. Bending never stretches the
  strip, so genome distances are preserved and nothing separates.
- **Shape** buttons morph between room, rounded room and half-cylinder.
- Hover a cell to stand a visitor in front of that region. Links fan out to every other region
  sharing a trait with it. The tooltip lists every trait with a hit in that bin.
- The checkbox on each legend tier heading shows or hides that tier's links live.
- **Arcs** buttons switch the link style live. The **Trait tracks** checkbox reloads with
  `?tracks=none` toggled.
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
