# Rendering viz_sandbox plots onto non-X-Y surfaces — findings for a library change

viz_sandbox lays every plot out in the world X-Y plane at z = 0. This prototype tried two
consumer-side ways of putting plots onto other surfaces. Each finding below is a candidate
requirement for a library feature. Verified in the running app, 2026-11-04, against viz_sandbox
`main` and deck.gl 9.1.1.

| Approach | Where | Surfaces it can make |
|---|---|---|
| **Plane placement** — one rigid `modelMatrix` per visualizer | commit `93fe382` (`src/app/plane_placement.js`, three wall visualizers) | Flat planes only |
| **Surface projection** — a function f(s, t) applied per vertex in the shader | current code (`src/app/ribbon.js`, one strip visualizer) | Any surface f can describe: flat strip, room, rounded room, half-cylinder |

The surface projection is the more general one; a plane placement is its affine special case. It is
the recommended shape for the library feature.

## Surface projection (current)

The genome strip is one `BoundedHeatmapVisualizer` in ribbon coordinates (x = s along the strip,
y = t up it). A deck.gl `LayerExtension` (`RibbonExtension`) maps every vertex through
f(s, t) in the `DECKGL_FILTER_GL_POSITION` hook, after viz_sandbox's own transforms. The ribbon's
state (centerline segments, stand-up angle) is a uniform block, updated per frame through a layer
prop, without recompiling the shader.

### What worked

| Mechanism | Result |
|---|---|
| Hook coverage | Every layer the heatmap uses reaches the hook with `geometry.position` filled: the forked `BoundedSolidPolygonLayer` (cells), `TextLayer` (labels, titles — glyph corners map individually, so text bends with the surface), deck `SolidPolygonLayer`, and `BoundedScatterplotLayer` (with the workaround below). |
| Bounded clipping | Correct. The clip test runs on pre-projection coordinates. |
| Picking, tooltips, `dataHoverFunction` | Correct on curved surfaces. |
| Scatter alignment | `?probe=scatter`: scatter dots sit centered in the polygon squares marking the same points, including on a curved corner. No `modelMatrix` is involved, so the matrix-order bug below does not arise. |
| Backface cutaway | Done in the same extension: a varying carries the surface normal's facing, and `DECKGL_FILTER_COLOR` fades back-facing fragments. Works per fragment on curved surfaces. |
| Morphing | Assembly (flat strip → standing → bent) and shape changes (room ↔ rounded ↔ arc) at 60 fps (worst frame 18 ms), re-uploading uniforms every frame. |

### What needed workarounds

**1. `BoundedScatterplotLayer` overwrites extension shader injections (bug).** Its `getShaders()`
merges its own injections with an object spread (`{...shaders.inject, ...BOUNDS_INJECT}`). That
replaces any extension injection on the same hook (`vs:#decl`, `vs:DECKGL_FILTER_GL_POSITION`,
`fs:#decl`, `fs:#main-start`). With the ribbon extension attached, the varying declaration is
dropped and the fragment shader fails to link (`Error during linking: Fragment shader is not
compiled`). Workaround: `ExtensionSafeBoundedScatterplotLayer` re-appends each extension's
injections. **Wanted:** concatenate per hook instead of spreading.

**2. The projection has to exist twice.** GLSL for rendering; JS for everything on the CPU — floor
arc endpoints, camera framing, cursor → (s, t). Kept in step by hand (`ribbon_map` /
`ribbonPoint`). **Wanted:** a projection object that carries both, so the library can use the JS
half for extents and cursor inversion.

**3. Cursor coordinate is wrong on any projected plot.** deck's `plotRelativeCoordinate` intersects
the pick ray with z = 0. Example on the half-cylinder: ribbon intersection (19.16, 1.00), deck
(7.00, 8.96). The workaround intersects the ray with the surface cut into 0.25 m planar facets
(`ribbonCoordinateAtPixel`). It agreed with the GPU-picked cell to within 0.003 m. **Wanted:** the
manager computes plot coordinates through the projection's inverse (or a facet search like this
one) for projected visualizers. Wheel zoom, plot drag and scrollbar reveal depend on it.

**4. Large polygons need subdividing.** f acts on vertices, so a polygon spanning a bend renders as
its chord. Heatmap cells are narrow enough; the strip backdrop had to be cut into 0.25 m quads.
**Wanted:** a tessellation option on generated chrome (backdrops, hit areas, scrollbars) for
projected visualizers.

**5. Pixel-width lines and paths can't use this hook.** Their width is applied in clip space before
`DECKGL_FILTER_GL_POSITION`, so remapping the center collapses the width. The wall arcs, drop
lines and brackets are thin polygons for this reason. **Exception (verified 2026-11-05):** a
`PathLayer` with `billboard: false` and `widthUnits: "common"` works — deck's vertex shader then
adds the width offset to `geometry.position` in common space before the hook, so the whole
ribbon maps. The bubbles-mode faint arcs use it (thousands of paths rebuilt per frame, far cheaper
than re-tessellating polygons). Pixel widths remain unsupported.

## Plane placement (commit `93fe382`)

Three wall visualizers, each placed by a rigid `modelMatrix` set on every LayerDescription via
`setLayerProps`. All built-in heatmap layers accepted it. Findings:

1. **No placement concept on the visualizer.** The matrix had to go onto each layer; a custom
   generator that doesn't spread passthrough props stays on X-Y without error.
2. **Quad offsets ignore `modelMatrix` (deck.gl behavior).** Text glyphs and scatter discs add their
   corner offset after the model transform (`project32`'s `project_position_to_clipspace`), so
   placed text stayed parallel to the floor. Needed an extension rotating the offset through
   `DECKGL_FILTER_SIZE`. The surface projection does not have this problem: it maps the vertex
   after the offset is added.
3. **`BoundedScatterplotLayer` composes `bounds · modelMatrix`; every other bounded layer composes
   `modelMatrix · bounds` (bug).** Under a placement its points left the plot.
4. **`plotRelativeCoordinate` assumes z = 0** (as item 3 above). Flat-strip state: ray–plane
   (12.00, 1.80) vs deck (12.00, 17.80).
5. **Extents are pre-placement.** `getWorldExtents()` returns the X-Y rect.

## Related limits hit along the way

- **Orthographic-only view.** `VisualizerDeckManager.generateView()` hard-codes
  `orthographic: true`, so a room seen from outside always shows part of the surface from behind
  (handled by the cutaway). A visitor's-eye perspective view needs a configurable view, with the
  fit/unproject helpers following it. **Workaround in use (2026-11-05):** the manager's
  `setView()` accepts a deck `FirstPersonView` with the same id ("3d-scene"), positioned in world
  metres (no latitude → non-geospatial viewport); every layer, the ribbon extension (its facing
  test uses `project.cameraPosition`) and picking work under it. The app's own fit/animation code
  has to stand aside while it is active, and `generateView()` restores the orbit view.
  **deck 9.1.1 bug hit by swapping views:** when a view keeps its id but its controller type
  changes (OrbitController ↔ FirstPersonController), `ViewManager._updateController` creates the
  new controller and never finalizes the old one, which stays subscribed to pointer events. Here
  the stale FirstPersonController re-emitted its old view state at the end of every drag, so the
  orbit camera snapped back after leaving first person. Workaround: finalize the replaced
  controller after `setView` (`swapView` in `src/app/first_person.js`). A library `setView`
  should do this.
  A seamless orbit ↔ first-person transition works as a dolly zoom (perspective narrowed to 0.5°
  stands in for the orthographic end); see HANDOFF "First-person view".
- **View `padding` shears an orthographic view.** deck's `createProjectionMatrix` applies padding
  by adding to `matrix[8]`/`matrix[9]` (a z-dependent term); after the perspective divide that is a
  screen offset, but with an orthographic projection (w = 1) it is a shear. Offsetting the
  content in the orthographic OrbitView needs a moved target instead (and, to keep rotation about
  the content, re-solving the target on rotation — `keepPivot` in GenomeRoomApp).
- **Billboarded pixel sizes assume a map-like focal distance.** deck's
  `project_pixel_size_to_clipspace` scales by `project.focalDistance`, not the vertex's clip `w`.
  IconLayer (billboard), TextLayer (billboard) and LineLayer pixel widths are right under the
  orthographic OrbitView, but under a non-geospatial FirstPersonView (focal distance 1) they
  shrink by the distance: icons become specks, lines vanish. Billboarded `PathLayer` is the
  exception (its offset is multiplied by `w`). Relevant if the library gets a configurable
  perspective view: its chrome (pixel-width axes, ticks, billboard labels) would hit this.
- **Orbit target pinned to z = 0** (`constrainViewStateTarget`).
- **Cell gaps alias at small cell sizes.** At ~2 px per bin, the inter-cell gap lands on whole pixel
  columns in a beat pattern; those pixels pick the hit area. Not projection-related.

## Proposed API (sketch)

```js
// A projection maps plot coordinates (after bounds/pan/zoom) to world.
const projection = {
  glsl: "...",                 // defines vec3 project_surface(vec3 p, out vec3 normal)
  uniforms: { ... },           // updatable per frame without recompiling
  map(x, y, z) { ... },        // JS twin: world point + normal
  invert(ray) { ... },         // optional; else the library facet-searches with map()
};
viz.setProjection(projection);  // applied to every layer of the visualizer; null = X-Y plane
viz.setProjectionUniforms({ ... });
viz.getProjectedExtents();      // sampled through map()
// A rigid placement is the special case: map(p) = M · p.
```
