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

**Data status:** genome bins come from real GRCh38 chromosome lengths (5 Mb bins). Trait values
and the floor links derived from them are **placeholders**, not data.

## Run

```bash
npm install
npm run dev
```

URL options:
- `?view=room` — start assembled instead of flat.
- `?shape=room|rounded|arc` — starting shape.
- `?probe=scatter` — diagnostic. Draws the same points as scatter dots and as polygon squares; they
  should coincide on every surface.

## Interaction

- **Flat strip / Assembled** buttons animate the transition. The slider sets it directly. The strip
  stands up about its bottom edge, then bends into the current shape. Bending never stretches the
  strip, so genome distances are preserved and nothing separates.
- **Shape** buttons morph between room, rounded room and half-cylinder.
- Hover a cell to stand a visitor in front of that region. Arcs fan out across the floor to every
  other region sharing a trait with it.
- Drag to orbit, scroll to zoom (deck.gl orbit camera).
- The bottom-left panel compares the cursor position computed against the surface with the value
  deck reports. The two disagree for any projected plot.

## Layout

- `src/app/ribbon.js` — the surface: centerline profiles, the map f(s, t) in JS and GLSL, the
  deck.gl extension, cursor → (s, t) by ray–facet intersection.
- `src/app/strip_setup.js` — the genome strip visualizer.
- `src/app/floor_setup.js` — floor, arcs, stand-in visitor.
- `src/app/genome.js` — GRCh38 lengths, binning, placeholder trait values.
- `src/app/GenomeRoomApp.js` — app state, assembly and shape animation, camera.

Infrastructure (deck.gl/luma/loaders pins, viz_sandbox tracking `main`, data-free deploy) follows
`pattern-viz-prototype-template` with the gallery's newer kit version. Both template deploy paths
(GitHub Pages and pattern-deploy) are still present; neither has been set up.
