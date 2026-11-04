# genome-room-prototype

Prototype for a projected, walk-in genome exhibit. A genome strip runs around three walls. The
floor carries links between regions that share a trait. The scene transitions between a single
continuous horizontal strip (the single-screen 2D layout, with the links as an arc diagram under it)
and the room it wraps into.

It is also a spike for rendering viz_sandbox visualizers onto planes other than world X-Y. The
findings, as requirements for a library change, are in
[docs/LIBRARY_NOTES.md](docs/LIBRARY_NOTES.md).

**Data status:** genome bins come from real GRCh38 chromosome lengths (5 Mb bins). Trait values
and the floor links derived from them are **placeholders**, not data.

## Run

```bash
npm install
npm run dev
```

URL options:
- `?view=room` — start in the room instead of the flat strip.
- `?probe=scatter` — diagnostic. Draws the same points as scatter dots and as polygon squares, to
  show the `BoundedScatterplotLayer` matrix-order bug on placed planes.

## Interaction

- **Flat strip / Room** buttons animate the transition. The slider sets it directly. Each wall
  moves rigidly: origin interpolated, orientation slerped.
- Hover a wall cell to stand a visitor in front of that region. Arcs fan out across the floor to
  every other region sharing a trait with it.
- Drag to orbit, scroll to zoom (deck.gl orbit camera).
- The bottom-left panel compares the cursor position computed against the wall's plane with the
  value deck reports. The two disagree for any placed plot.

## Layout

- `src/app/plane_placement.js` — the placement workaround: plane matrix, per-layer placement,
  quad-offset extension, placed corners, cursor ray–plane intersection.
- `src/app/room.js` — room geometry; each wall's flat-strip and room frames, and the rigid
  interpolation between them.
- `src/app/genome.js` — GRCh38 lengths, binning, placeholder trait values.
- `src/app/wall_setup.js`, `src/app/floor_setup.js` — the visualizers.
- `src/app/GenomeRoomApp.js` — app state, transition, camera, wall-facing cutaway.

Infrastructure (deck.gl/luma/loaders pins, viz_sandbox tracking `main`, data-free deploy) follows
`pattern-viz-prototype-template` with the gallery's newer kit version. Both template deploy paths
(GitHub Pages and pattern-deploy) are still present; neither has been set up.
