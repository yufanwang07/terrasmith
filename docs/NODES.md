# Node reference

Every node in the catalog, organised by category, with its type id, ports and parameters.

> **This file is written by hand against the catalog, so it can drift.** The source of truth is
> `packages/graph/src/nodes/*.ts` — each definition carries its own label, description, parameter help and
> ports, and the editor reads those, not this file. `node packages/cli/dist/cli.js nodes` prints the live
> list of type ids by category. If a default here disagrees with the code, the code is right and this file
> needs fixing.
>
> Current as of a catalog of 50 nodes in nine categories.

**Conventions used below.** A *field* is a 2D grid of floats; heights, masks, flow and wear are all fields,
which is why any output can drive any input without a conversion. Heights are in **elmos**, BAR's world
unit — a 16x16 map is 8192 elmos across, and water sits at height 0. A *mask* is a field whose values run
0 to 1. Distances and radii are real world distances, so the same setting means the same thing at preview
and at build resolution. Parameters marked *advanced* are hidden behind a disclosure in the editor.

Nodes marked **expensive** cost enough at full resolution that the editor prefers a coarser preview and
warns before a full-resolution build.

---

## Generators

Sources of terrain. They have no inputs and sample a continuous domain at world coordinates, so the same
node produces the same landscape whether the graph is evaluated at 512 or at 8192.

### Noise
`generator.noise`

The workhorse. One node covers rolling hills, mountain ranges, dunes and cracked plateaus, because the
shape control changes the *character* while every other control keeps its meaning.

- **Outputs:** `out` (field) — terrain.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Shape | choice | Rolling / Ridged / Billowed / Hybrid / Multiplied | Rolling | Rolling is soft hills and the general-purpose choice; Ridged is sharp crests and deep valleys; Billowed is rounded dunes; Hybrid puts detailed peaks over smooth lowlands and looks the most natural; Multiplied is patchy and high-contrast, good for masks. |
| Feature size | elmos | 16 – 65536, log slider | 2048 | Roughly how wide the largest hills are. |
| Height | elmos | 0 – 10000 (slider to 2000) | 400 | Distance from the lowest point to the highest. |
| Detail levels | int | 1 – 14 | 6 | How many times finer detail is layered on; each level halves the feature size. |
| Seed | seed | — | 0 | Changes the pattern without changing its character. |
| Ridge sharpness | number | 0.25 - 1.5 | 0.625 | Only shown for Ridged. Low is broad whalebacks, high is knife edges. It is Musgrave's `offset` inverted, and past about 1 it stops sharpening the crest and starts flattening everything else: a seventh of the map gets clamped dead at every detail level, so it has no detail at any scale while the rest has all of it — which is what makes a map read as two terrains stuck together. The slider used to go to 3, where more than half the map is clamped. |
| Roughness | number | 0.05 - 0.95 | 0.55 | *Advanced.* How much each detail level contributes relative to the one before. It sets the spectral slope, and real landscapes measure 0.55 to 0.65 in the DEM literature; below about 0.5 the terrain is smoother at every scale than any real landscape, which is half of why a ridge crest then looks pasted onto it. |
| Detail spacing | number | 1.2 – 4 | 2.02 | *Advanced.* How much smaller each level is than the last. Exactly 2 lines every level up on the same grid and shows as faint straight creases, which is why the default sits just off it. |
| Noise basis | choice | Perlin / Simplex / Value / Cellular | Perlin | *Advanced.* The underlying random function. Changes texture more than shape; Cellular gives cracked, cell-like ground. |
| Cell shape | choice | Mounds / Cracks / Basins / Flat cells | Mounds | *Advanced.* Only shown for Cellular. What the cells measure, which changes the shape far more than the basis itself does. Mounds are rounded hummocks; Cracks is the lava-field look, a network of fissures along the cell walls; Basins are broad bowls with raised rims; Flat cells gives one height per cell, which terraces into flat-topped platforms. |
| Warp strength | elmos | 0 – 8192 (slider to 2048) | 0 | *Advanced.* Distorts the noise with more noise. A little is the cheapest way to stop terrain looking procedural. |
| Warp size | elmos | 64 – 65536, log slider | 4096 | *Advanced.* How broad the distortion is. Hidden when warp strength is 0. |
| Warp passes | int | 1 – 3 | 1 | *Advanced.* Warping the warp. Two give the swirling eroded look; three rarely help. |
| Base height | elmos | −5000 – 5000 | 0 | *Advanced.* Shifts the whole result up or down. |

### Gradient
`generator.gradient`

A smooth ramp across the map. Deceptively important: almost every hand-designed map has a large-scale bias
— a coast on one side, a central basin — that noise alone will not produce. Multiply noise by a radial
gradient for an island, by a linear one for a coastline.

- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Direction | choice | Radial / West to east / North to south / Diagonal / Box | Radial | Radial is high in the middle and low at the edges, which makes islands. Box is the same but square, so it respects the map edges. |
| Edge value | number | −10000 – 10000 | 0 | The value at the low end. |
| Centre value | number | −10000 – 10000 | 1 | The value at the high end. |
| Falloff | choice | Linear / Smooth / Sharp | Smooth | *Advanced.* Smooth eases at both ends and is almost always right. Sharp stays high then drops fast, which is what gives a plateau an edge rather than a dome. |
| Centre X | number | 0 – 1 | 0.5 | *Advanced.* Radial and Box only. |
| Centre Z | number | 0 – 1 | 0.5 | *Advanced.* Radial and Box only. |

### Plateaus
`generator.plateaus`

Scattered flat-topped platforms. A generator rather than a filter because "somewhere to build" is a primary
requirement of a BAR map, not a correction applied afterwards — **BAR gives players no terraform command**,
so flat ground has to come from the map.

Overlapping plateaus merge into one platform rather than stacking into a tower.

- **Outputs:** `out` (field) — the platforms; `mask` (field) — where they are. The mask is the useful half:
  invert it into an erosion node's Hardness input and the erosion will weather everything else and leave
  the platforms alone.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Count | int | 1 – 128 | 8 | How many platforms. |
| Radius | elmos | 32 – 8192, log slider | 600 | Average platform radius. A bot lab needs a 96-elmo footprint, so a 600-elmo plateau holds a base. |
| Radius variation | number | 0 – 1 | 0.3 | How much the radii differ from each other. |
| Height | elmos | −2000 – 2000 | 200 | How far above (or below) the surroundings the tops sit. |
| Height variation | number | 0 – 1 | 0.2 | How much the heights differ. |
| Edge sharpness | number | 0 – 1 | 0.6 | How abruptly the sides drop away. 1 gives near-vertical cliffs. |
| Seed | seed | — | 0 | Rerolls the placement. |
| Edge margin | number | 0 – 0.4 | 0.08 | *Advanced.* Keeps plateaus away from the map border, as a fraction of the map size. |

### Constant
`generator.constant`

A flat value everywhere. A sea floor, a base plate, or a fixed mask.

- **Outputs:** `out` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Value | number | −10000 – 10000 (slider −500 – 1000) | 0 |

---

### Import heightmap
`generator.importHeightmap`

Brings terrain in from another tool as a 16-bit greyscale PNG or a headerless r16 — the two shapes World Machine, Gaea, L3DT and Blender all export, and the two pymapconv accepts. An image carries brightness and nothing else, so Black is and White is are what turn it into elmos, and the defaults are drier than they look: with the darkest pixel at 0 elmos, nothing on the map is under water. Ships need 8 elmos of depth to float, so an imported coastline wants Black is pushed well below 0 — around -100 for a shelf with a beach on it.

The image's own resolution does not matter; it is resampled onto the build grid, area-averaged when it shrinks and bicubic when it grows. Its shape does matter: a non-square image is stretched to fill the map rather than letter-boxed, so export at the map's aspect. An empty file slot produces flat ground rather than an error, which is what you see before choosing a file.

- **Outputs:** `out` (field) — the imported terrain, already resampled to the build grid.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Heightmap file | image | — | none | The file to read. An 8-bit image loads but arrives with only 256 distinct heights, which terraces the whole map. An r16 is read little-endian, which is what everything in this workflow writes; a big-endian file comes back as noise, not as subtly wrong terrain. |
| Black is | elmos | -10000 - 10000 (slider to 500) | 0 | What the darkest pixel in the image means. Take it negative to put sea floor under the map. |
| White is | elmos | -10000 - 10000 (slider to 2000) | 500 | What the brightest pixel means. Together these two are the most common reason an imported map comes out squashed or flooded. White is must sit above Black is — equal or inverted values stop the build instead of returning a flat map. |
| Width of the r16 | int | 0 - 16384 | 0 | *Advanced.* Only for a headerless r16 that is not square, since the file has no header to say so. At 0 the sample count is assumed square, and a file whose sample count is not a perfect square fails with an error. Ignored for a PNG, which carries its own dimensions. |
| Flip north to south | boolean | — | off | *Advanced.* Some tools write the first row as the south edge. Turn this on if the map comes out mirrored against the image you exported. |

---

## Layout

The rest of the catalog is procedural: you tune parameters and take what the noise gives you. These nodes work the other way round — you draw a line or a pad on the map in the editor's overlay, and they turn that drawing into terrain, so a map gets a ridge where you want the fight and a river where you want the chokepoint instead of the shape the seed happened to produce. Shapes are stored in elmos, so a layout drawn while previewing at 512 describes the same ridge when the map builds at 8192.

### Layout
`layout.shapes`

Holds the shapes a map is drawn from — ridge lines, rivers, base pads — and hands them to the nodes
that turn them into terrain. Every coordinate is stored in elmos rather than grid samples, so a layout
drawn while previewing at 512 describes the same ridge when the map builds at 8192.

Name the shapes deliberately. Each consuming node carries an *Only shapes named* control that keeps the
shapes whose name contains that text, so the normal arrangement is one layout holding the ridges, the
river and the base pads, with the Ridge node taking `ridge-centre` and the River node taking
`river-main`. Splitting a map across several Layout nodes is the exception, not the habit.

- **Inputs:** `add` (shapes) — optional. Another layout to carry along. Its shapes are placed ahead of
  this node's, and shapes paint in array order like layers, so where the two overlap this node's own
  shapes are the ones that survive.
- **Outputs:** `shapes` (shapes) — the incoming layout followed by this node's own.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Shapes | string | — | starter layout | The drawing itself: points, lines and areas in elmos, each able to carry a height, a width and a soft edge. A shape with no height of its own levels to whatever ground it lands on, which is what the two stock base pads do. The starter layout is two pads on one diagonal, a ridge across the other and a river past both, 180-degree rotationally symmetric like 70.9% of shipped BAR maps, so it builds into a fair map before you touch it. A malformed layout refuses to evaluate and names the shape at fault instead of quietly drawing something else. |
| Stretch to fit the map | boolean | — | on | Rescales the drawing when the map is not the size it was drawn for. The two axes scale independently, so on a 20x16 lane map a square pad comes out oblong; widths and soft edges have no axis of their own and scale by the mean of the two. Turn it off to pin shapes to exact elmo positions. |
| Drawn for a map of | elmos | 512 - 65536 | 8192 | *Advanced.* Only shown when Stretch to fit the map is on. The map width the coordinates above were measured against. 8192 elmos is a 16x16 map, the commonest single size in BAR. |

### Radial layout
`layout.radial`

A ring of shapes around the middle of the map — build pads for start positions, spokes for the ridges that
divide a map into lanes, or one polygon threaded through all the positions — generated already symmetric.
Placing four starts by hand is the easiest way to ship a map that is *almost* symmetric, which plays worse
than one that obviously is not: nobody goes looking for a 30-elmo difference between two bases, they lose to
it without ever seeing it.

The node refuses rather than quietly repairing. *How many* rounds **up** to a whole multiple of the symmetry,
so 6 under Rotational (90°) comes back as 8 instead of dropping two players; a rotation that lands a feature
on a mirror line, where a feature is its own partner and the pair collapses into one spot, stops the build
and names the angle that would clear it; Rotational (90°) on a non-square map is an error, because a quarter
turn maps a rectangle onto a different rectangle.

- **Inputs:** `add` (shapes, optional) — an existing layout to carry through. Its shapes stay ahead of the
  generated ones, so stacking a second Radial layout on an inner ring never renumbers the outer one.
- **Outputs:** `shapes` (shapes) — the arrangement, in world elmos, with nothing drawn yet. Feed it to
  Flatten to shape, Ridge or Layout mask; this node decides where the features are, those decide what they
  are.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| How many | int | 1 - 64 | 4 | How many features to place, rounded up to a whole multiple of the symmetry — three positions cannot be 180-degree symmetric however they are arranged. |
| What to place | enum | Build pads, Points, Spokes, Ring | Build pads | Build pads are squares rounded up to whole 16-elmo build squares and left axis-aligned, because BAR places buildings on an axis-aligned grid and a pad turned to face the centre wastes the corners it stops covering. Points are single spots that draw as circles. Spokes run outward from the middle. Ring joins every position into one closed area, its corners sorted by angle so the outline cannot wind over itself. |
| Distance from centre | elmos | 0 - 65536 (slider to 4096) | 2400 | How far out the features sit. At the default under Rotational (180°) opposing starts are 4800 elmos apart, clear of the ~1400 elmos at which a T2 Annihilator built at one base's edge reaches the other. At 0 every feature stacks on its partner in the middle, which the node rejects. |
| Inner distance | elmos | 0 - 65536 (slider to 4096) | 700 | Only shown for Spokes. Where each spoke begins, measured from the middle. The gap is what stops the spokes meeting in a knot at the centre. |
| Size | elmos | 16 - 8192 (slider to 2048) | 640 | Only shown for Build pads and Points. How big each one is, across. A lab needs 96 x 96 elmos within ±10.7 elmos to be plantable and a start wants roughly 400 x 400 elmos of flat behind it for T2 economy, so the default sizes a base, not a building. |
| Rotation | ° | 0 - 360, step 5 | 0 | Turns the whole arrangement. 0 puts the first feature due east and the angle runs clockwise on the map. Under any mirror symmetry the turn has to stay under half a slot, or a feature reaches the mirror line and the build stops. |
| Symmetry | enum | Rotational (180°), Evenly spaced, Mirror east-west, Mirror north-south, Mirror both ways, Rotational (90°) | Rotational (180°) | Which balance the arrangement has to satisfy exactly. Across 202 shipped BAR maps the split is Rotational (180°) 70.9%, Mirror east-west 13.6%, Mirror north-south 11.8%, Rotational (90°) 3.6% — the default is the one nearly every 1v1 and team map uses, and it is also the only family a rotation of any size suits. |
| Give them a height | boolean | — | off | Off, the shapes carry no height of their own and the consuming node decides: a pad flattens to the ground it covers, a ridge keeps its own Height. This is not the same as a height of 0 — 0 is the water line, so stamping it would drag every pad down to sea level and ring each one with a rim too steep to drive up. Turn it on only when the arrangement itself decides how high these features stand. |
| Height | elmos | -2000 - 8000 (slider to 1000) | 200 | Only shown when Give them a height is on. The height every shape carries, for whatever node consumes the layout. Water is at 0, so a negative value cuts a trench instead of raising a platform. |
| Soft edge | elmos | 0 - 8192 (slider to 1024) | 192 | The feathered band each shape carries with it, used by the node that draws it. |
| Centre offset east | elmos | -32768 - 32768 (slider to 2048) | 0 | *Advanced.* Moves the generated ring off the middle of the map. Partners are still built about the map's own centre, so the result stays symmetric — the features gather into two clusters instead of one even ring. |
| Centre offset south | elmos | -32768 - 32768 (slider to 2048) | 0 | *Advanced.* The same along the north-south axis, positive southward. |

### Layout mask
`layout.mask`

A 0 - 1 field from a layout: 1 inside the shapes, 0 outside, with a feathered band between. It is how a drawing aims the rest of the graph — hand it to any node's Mask input and that node acts only where you drew.

Line width reaches open shapes only. A polygon, or a polyline carrying `closed: true`, fills to its own outline and is never dilated by it; a 400-elmo base pad would otherwise come back 464 elmos wide because the line width happened to be 64. Any shape carrying a width of its own keeps it, so the control is a default for the shapes that did not specify one. Set it to 0 and an open line loses its solid core entirely: the mask peaks at 1 along the line and is nothing but the soft edge.

Each shape is filled against its own outline, so a ring drawn inside another ring fills solid instead of cutting a hole, and overlapping shapes take the greater coverage rather than summing past 1. For a mask with holes in it, run the same layout through Distance to layout and threshold the result, which winds every ring together.

- **Inputs:** `shapes` (shapes) — the layout to rasterise. Required; with nothing connected the node stops and names the port.
- **Outputs:** `out` (field) — the mask, 0 to 1.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Line width | elmos | 0 - 4096 (slider to 1024), slider to 1024 | 64 | How wide lines come out, and the diameter of the disc a point becomes. Areas ignore it. A comfortable main road in BAR is 200 - 400 elmos wide, so the default draws a track rather than a route. |
| Soft edge | elmos | 0 - 4096 (slider to 1024) | 128 | How far outside each shape the mask fades from 1 to 0, measured from the edge of the solid core. 0 gives a hard edge. A shape carrying its own soft edge keeps it. |
| Edge shape | enum | Smooth, Curved, V, Flat-bottomed | Smooth | *Advanced.* The ramp used across the soft edge; the core stays at a flat 1 either way. Smooth is level at both ends and steepest in the middle, so it meets flat ground without a crease. Curved leaves the shape gently and is steepest where it reaches 0. V is one constant slope. Flat-bottomed holds at 1 for the first half of the band and then drops twice as steeply, which in a mask means it widens the solid core by half the soft edge. |
| Invert | boolean | — | off | Swaps inside and outside, for masking everything except what you drew. |
| Only shapes named | string | — | empty | *Advanced.* Empty uses every shape in the layout. Otherwise only shapes whose name contains this text are rasterised, case-insensitively, so one layout can hold the ridges, the river and the base pads and each node takes the part that is its own. |

### Distance to layout
`layout.distance`

A field of distances in elmos: every point reports how far it is from the nearest shape in the layout, and points inside a closed shape report that distance as negative. Every gameplay rule worth writing down is phrased as a distance — how far from the start position, how close to the water, how wide the gap between two ridges — so this is the node that turns a threshold into a real elmo figure instead of a number tuned by eye. The zero contour sits on the geometry as drawn: stroke widths and soft edges, which the other layout nodes honour, are ignored here, and *Grow by* is the only thing that moves it. Set it to 300 and everything within 300 elmos of the shapes reads negative, which a selector takes straight out.

Distances past *Measure out to* are reported as exactly that value, so beyond the default 2048 the field is a flat plateau and a threshold above it selects the whole outer map at once; an empty layout, or *Only shapes named* matching nothing, returns that same value everywhere rather than failing. That bound is also the cost control. The node is **expensive** — it runs an exact nearest-segment search for every texel of the build grid, so an 8192 build is 67 million queries — and a tight bound is what lets the search prune most of the map away without looking at a segment.

- **Inputs:** `shapes` (shapes) — the layout to measure from. Lines and points are measured from the geometry itself; only closed shapes have an inside.
- **Outputs:** `out` (field) — distance in elmos, negative inside closed shapes. This is not a 0 – 1 mask, so send it through Remap or a selector before using it as one.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Negative inside areas | boolean | — | on | Makes the interior of a closed shape read as minus the distance to its outline, so the outline is where the value crosses zero and "below 0" means inside. Interiors are wound together across every closed shape at once, so a ring drawn the other way round inside another cuts a hole. Turn it off to measure from the outline on both sides. |
| Measure out to | elmos | 8 – 65536, log slider (slider to 8192) | 2048 | How far the measurement runs before it stops; anything further away reads as this value. Keep it a little past the largest distance you threshold on. |
| Grow by | elmos | -16384 – 16384 (slider -1024 to 1024) | 0 | Moves the zero contour outward by this many elmos, turning "near the shape" into "inside the shape". Negative values pull it inward and eat into the shapes instead. |
| Only shapes named | string | — | (empty) | *Advanced.* Uses only the shapes whose name contains this text, so one layout can hold the ridges, the river and the base pads and each node takes the part that is its own. Empty uses every shape. |

### Flatten to shape
`layout.flatten`

Levels the ground inside every shape of a layout and ramps it back out into the terrain around it — the plateau, the base pad, the shelf along a coast, exactly where it was drawn. A shape carrying no height of its own levels to the mean of the ground it covers, which is the "flatten this, whatever height suits" case; only the solid core votes on that mean, so the blend band cannot drag a pad towards the valley next door.

The blend band grows **outward** from the outline. What comes out flat is what was drawn, and a 384-elmo soft edge reaches 384 elmos past every side of it. So draw the pad at the size that has to be buildable — a bot lab is 96 x 96 elmos and needs its whole footprint within 10.72 elmos of one height, and a working base wants about 400 x 400 elmos of that — then let the edge spill outside it.

- **Inputs:** `terrain` (field) — the heightmap to level; `shapes` (shapes) — the layout to level to, applied in the order it holds them, so where two shapes overlap the later one levels over the earlier; `mask` (field, optional) — where it is 1 the levelling applies in full, where it is 0 the terrain passes through untouched.
- **Outputs:** `out` (field) — the levelled terrain.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Use each shape’s own height | boolean | — | on | Lets each shape level to the height stored with it, and lets a shape with no height of its own level to the average of the ground it covers. Turn it off to drive every shape to one height instead. |
| Height | elmos | -2000 - 8000 (slider to 1000) | 100 | The single height every shape levels to. Only shown when Use each shape’s own height is off. Water sits at height 0, so anything below that is sea floor. |
| How it combines | enum | — | Level | What the shape does to the ground it covers. Level replaces it and eases in at the edge, and is the usual choice; Level (linear edge) uses a straight ramp, about half as steep at its worst point but leaving a visible crease where it meets flat ground; Raise only lifts ground below the height and leaves anything higher; Lower only cuts ground above it, for a basin; Add stacks the height on what is already there. |
| Height is relative to the ground | boolean | — | off | *Advanced.* Reads each height as "this far above the ground here" rather than as an elevation. It also switches off the level-to-the-average behaviour, so shapes with no height of their own stop doing anything — as they do under Add, for the same reason. |
| Strength | number | 0 - 1 | 1 | How far the ground moves towards the flattened height. 1 is fully flat; lower values keep some of the original relief showing through the pad. |
| Soft edge | elmos | 0 - 8192 (slider to 2048) | 384 | The band of slope that blends the flattened area back into the terrain outside it. Too narrow and that band is a cliff: to stay under the 27 degrees that stops tanks it has to be about five and a half times the height it bridges, so a 200-elmo step wants roughly 1100 elmos. At 400 the same step measures past 54 degrees, which stops bots as well. |
| Line width | elmos | 0 - 4096 (slider to 1024) | 128 | *Advanced.* How wide a flattened line or point comes out — a road, a ramp, a landing pad. Areas are unaffected, so this cannot quietly fatten a pad drawn to fit a factory. |
| Edge shape | enum | — | Smooth | *Advanced.* The cross-section of the soft edge. Smooth flattens out at both ends and meets flat ground without a crease; Curved is a rounded bowl; V is straight sides meeting at a point; Flat-bottomed is a flat floor with straight banks. |
| Only shapes named | string | — | empty | *Advanced.* Leave empty to flatten every shape in the layout. Otherwise only shapes whose name contains this text are used, so one layout can hold the ridges, the river and the base pads and each node takes the ones it wants. |

### River
`layout.river`

Cuts a channel along each line in a layout — a stream, a canyon, a canal. What separates it from subtracting a depth from the terrain is that the bed is forced downhill the whole way: each station along the line takes the lower of the ground minus Depth and the previous station's bed minus the Fall, so the bed can never rise. A bed that inherits the terrain's bumps is a chain of closed basins, which the flow-accumulation pass reads as disconnected ponds, a depression-fill pass floods flat to the first lip downstream, and the engine's water surface shows as ponds in game.

Depth is the least it cuts, not the most. Where the line climbs, the bed keeps descending at the Fall rate and the cut deepens to whatever it takes to get through the rise, so a river drawn across a ridge saws a gorge through it. The node only ever lowers ground: where the terrain already sits below the graded bed it passes through unchanged, and no amount of Depth will build a levee to hold the water in.

- **Inputs:** `terrain` (field) — the ground to cut into. `shapes` (shapes) — the lines to follow; closed rings and single points are skipped, since a loop that ran downhill the whole way round would have to arrive back below where it left. `mask` (field, optional) — where it is 1 the cut applies in full, where it is 0 the terrain passes through untouched.
- **Outputs:** `out` (field) — the carved terrain. `channel` (field) — how deep the cut went as a fraction of Depth, 1 at the deepest part and 0 outside. It is measured against the terrain that came in rather than against each pass in turn, so where two rivers cross both channels show; feed it to a river-bed texture or a sediment filter as a wetness mask.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Width | elmos | 8 - 8192, log slider to 1024 | 256 | How wide the channel is, bank to bank. A shape carrying its own width uses that instead, so one layout can hold a stream and a gorge. Under about 100 elmos it reads as a ditch rather than a barrier. |
| Depth | elmos | 0 - 2000 (slider to 400) | 60 | How far the bed sits below the ground it runs through. With Width it sets the bank angle: on the Curved bed the steepest point of the wall is four times the depth divided by the width, so 60 in a 256-elmo channel reaches 43 degrees at the rim — bots and commanders climb out at 54, vehicles are stopped at 27. Widening to about 470 brings that same depth under the vehicle limit. At 0 nothing is cut below the bed line, leaving a level floor falling at the Fall rate instead of a trench. |
| Bank | elmos | 0 - 8192 (slider to 1024) | 128 | A graded shoulder outside the rim: ground standing above the bank top is shaved down and faded back into the terrain over this distance, so the cut eases in instead of ending in a wall. It does not touch the channel wall itself — widen the river to soften that. |
| Bed shape | enum | Smooth, Curved, V, Flat-bottomed | Curved | The cross-section. Curved is the rounded bowl a real river cuts; V gives sharp gorges and cut roads; Flat-bottomed gives a canal floor you can build on; Smooth flattens at both ends and meets flat ground without a crease. |
| Fall | elmos per 1000 | 0 - 500 (slider to 60) | 8 | The least the bed is allowed to drop over every 1000 elmos it runs. Anything above 0 is enough to stop water pooling; larger values cut deeper downstream, because the bed has to keep falling through whatever ground it meets. |
| Flow the other way | boolean | — | off | Lines run from their first point to their last. This swaps source and mouth, which flips the end the gorge deepens towards. |
| Run it down to a set height | boolean | — | off | Grades the bed evenly from source to mouth instead of following the ground. The source is read off the terrain where the line starts, so the river still begins at ground level; this is how it reaches the sea rather than falling into it in the last cell. |
| Mouth height | elmos | -2000 - 4000 (slider to 400) | 0 | Only shown when Run it down to a set height is on. Absolute height of the bed where the river ends; water sits at height 0, so 0 puts the mouth at the shoreline. How far below 0 decides the traffic: vehicles ford up to 20 elmos of water, small ships need 8, battleships and submarines 15. A mouth set above the source loses to the Fall clamp and the bed descends regardless. |
| Curve the line | boolean | — | on | *Advanced.* Runs a spline through the points instead of straight segments between them. Turn it off for a canal or a cut road, where the corners you drew are the point. |
| Only shapes named | string | — | empty | *Advanced.* Empty carves every shape in the layout. Otherwise only shapes whose name contains this text are used, so one layout can hold the ridges, the river and the base pads. |

### Ridge
`layout.ridge`

Raises a mountain ridge along every line in a layout, with a crest that rises and falls along its length instead of holding one height. With nothing wired into `terrain` it is a generator and the ridge is the whole map; with terrain wired in it is a modifier, which is why the input is optional rather than split across two nodes.

Height and Width are defaults, not orders — a shape carrying its own height or width uses those, so one layout can hold a main spine and a low spur and one node builds both. A closed shape, such as a crater rim, ignores Taper the ends: fading a ring towards its own join would cut a gap in the rim and open a path straight into the middle. Where two spines cross, the taller crest wins.

- **Inputs:** `terrain` (field, optional) — the ground the ridge rises out of; leave it empty for the ridge on its own. `shapes` (shapes) — the lines to follow; shapes with fewer than two points are skipped. `mask` (field, optional) — where the ridge applies: 1 takes the result, 0 passes the input through untouched.
- **Outputs:** `out` (field) — the terrain with the ridge in it. `offset` (field) — the ridge by itself, exactly zero everywhere outside the foot. The second one is the useful half: it is already a per-flank weight, so send it to a selector or straight into a splat mask to put rock on the ridge and nothing elsewhere.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Height | elmos | 0 - 8000 (slider to 1500) | 400 | How far the crest stands above the ground it grows from. Overridden by a shape that carries its own height. |
| Width | elmos | 8 - 16384 (slider to 4096), log slider | 900 | How wide the foot is. With Height this decides the flank slope: 400 elmos of rise over a 900-elmo foot runs the steepest part past 50 degrees, well beyond the 27 degrees where every BAR vehicle stops and past the 33 of hovers and Thor, so only bots and spiders will climb it. Widen the foot or drop the height to let tanks over. |
| Flank shape | enum | Smooth, Curved, V, Flat-bottomed | Smooth | The cross-section. Smooth flattens at both crest and foot, so the ridge meets flat ground without a visible crease; Curved is a rounded shoulder; V is straight sides meeting at a point. Flat-bottomed is worded for carving, but on a ridge it gives a flat *top* spanning the middle half of the width — 450 elmos of level crest at the default width, enough to build on. |
| Taper the ends | number | 0 - 0.5 | 0.12 | What fraction of the length fades out at each end. At 0 the spine stops dead and leaves a cliff across its end. Ignored on a closed shape. |
| Crest variation | elmos | 0 - 4000 (slider to 500) | 100 | How far the crest wanders up and down along its length. At 0 the ridge holds one elevation and reads as a wall. |
| Variation size | elmos | 16 - 65536, log slider | 1800 | *Advanced.* How far apart the high and low points of the crest are. Around twice the width gives one summit per stretch of ridge. |
| Variation detail | int | 1 - 8 | 3 | *Advanced.* How many octaves of noise are layered into the crest variation; higher puts small bumps on the large swells. |
| Wobble the edges | elmos | 0 - 4000 (slider to 600) | 180 | How far the foot pushes in and out of the curve you drew. This is the single setting that stops a layout looking drawn rather than grown. Only the size counts — a negative value wobbles the same amount. |
| Wobble size | elmos | 16 - 65536, log slider | 900 | *Advanced.* How far apart the bulges in the outline are. Small values ripple the edge; large ones sway the whole flank. |
| How it meets the terrain | enum | Add on top, Rise above, Replace | Add on top | *Advanced.* Add on top rides the ridge over whatever relief is already there, so a ridge crossing a valley dips with it. Rise above makes Height an absolute elevation: the ridge appears only where it stands taller than the terrain, and ground the foot does not reach keeps its old height exactly — including sea floor, which a plain maximum would lift to the water line at 0 and drain. Replace discards the incoming terrain. |
| Seed | seed | — | 0 | Rerolls both noises. The same seed rebuilds the same mountain every time. |
| Only shapes named | string | — | empty | *Advanced.* Empty uses every shape in the layout. Otherwise only shapes whose name contains this text, so one layout can hold your ridges, your river and your base pads and each node takes the ones it wants. |

---

## Filters

Operations that reshape an existing terrain. **Every filter that changes heights in place takes an
optional Mask input**: where the mask is 1 the effect applies fully, where it is 0 the input passes
through untouched. That is why masking works uniformly across the whole tool instead of being a per-node
afterthought — and why any selector can drive any filter.

The two exceptions are **Transform** and **Sea level**, which move or shift the entire terrain rather than
modifying it point by point, so there is nothing for a partial mask to blend between. Each node's Inputs
line below is authoritative; if it does not list `mask`, the node does not have one.

### Smooth
`filter.smooth`

Softens the terrain. The radius is a real distance, so the same setting smooths the same amount whether you
are previewing or building.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Radius | elmos | 0 – 4096, log slider to 1024 | 64 |
| Strength | number | 0 – 1 | 1 |

### Sharpen
`filter.sharpen`

Exaggerates local relief — crisper ridges, deeper valleys — without changing the overall shape. Overdone, it
puts halos around every cliff.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Radius | elmos | 1 – 4096, log slider to 1024 | 96 |
| Amount | number | 0 – 3 (slider to 1.5) | 0.5 |

### Terrace
`filter.terrace`

Cuts the terrain into flat steps, like sedimentary rock. Useful in BAR for a second reason: **flat steps are
buildable**, so a terraced hillside gives players somewhere to put a base at several heights instead of one
unusable slope.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Steps | int | 1 – 64 | 8 | How many benches. |
| Sharpness | number | 0 – 1 | 0.7 | 0 leaves the terrain alone; 1 gives hard flat benches with vertical risers. |
| Set range manually | boolean | — | off | *Advanced.* Off, the steps span the terrain's own range. |
| Lowest step | elmos | — | 0 | *Advanced.* Shown when the range is manual. |
| Highest step | elmos | — | 500 | *Advanced.* Shown when the range is manual. |

### Curve
`filter.curve`

Remaps heights through a curve. Drag the low end down to deepen valleys, flatten the middle to create a
plain, lift the top for sharper peaks.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Curve | curve | — | straight line (0,0)–(1,1) | Horizontal is the input height, vertical is the output. |
| Set range manually | boolean | — | off | *Advanced.* |
| Input low | elmos | — | 0 | *Advanced.* Shown when the range is manual. |
| Input high | elmos | — | 500 | *Advanced.* Shown when the range is manual. |

### Remap height
`filter.remap`

Rescales heights into a range you choose. Put one before the Height output to set exactly how tall the map
is and where the water line falls.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Input range | choice | Automatic / Manual | Automatic | Automatic uses the terrain's own lowest and highest points. |
| Lowest | elmos | −10000 – 10000 | −100 | The output low. Below 0 is underwater. |
| Highest | elmos | −10000 – 10000 | 500 | The output high. |
| From | elmos | — | 0 | *Advanced.* Manual input low. |
| To | elmos | — | 1 | *Advanced.* Manual input high. |
| Clamp to range | boolean | — | on | *Advanced.* With manual limits, anything outside them is pinned to the edge of the output range. |

### Clamp
`filter.clamp`

Limits how low or high the terrain can go. With softness above 0 it eases into the limit instead of cutting
flat, which avoids the mesa-top look.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Floor | elmos | −10000 – 10000 | −200 | Useful as a sea floor: nothing goes deeper than this. |
| Ceiling | elmos | −10000 – 10000 | 800 | |
| Softness | elmos | 0 – 500 | 0 | Distance over which the terrain eases into the limit. |

### Transform
`filter.transform`

Pans, zooms and rotates the terrain. Handy for repositioning a generator without rerolling it.

- **Inputs:** `terrain` (field).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Offset X | elmos | −32768 – 32768 (slider ±4096) | 0 |
| Offset Z | elmos | −32768 – 32768 (slider ±4096) | 0 |
| Scale | number | 0.05 – 20, log slider | 1 |
| Rotation | degrees | 0 – 360 | 0 |
| Outside the edge | choice | Stretch edge / Mirror / Repeat | Stretch edge (*advanced*) |

### Warp
`filter.warp`

Displaces the terrain sideways using another field. Feeding it noise breaks up mechanical-looking shapes;
feeding it a flow map drags features along the drainage.

- **Inputs:** `terrain` (field), `warp` (field, "Displacement" — drives how far each point moves),
  `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Amount | elmos | 0 – 8192 (slider to 2048) | 256 | How far points move. |
| Direction from | choice | Slope of displacement / Fixed diagonal | Slope of displacement (*advanced*) | The first moves along the displacement field's own slope, which gives organic swirls; the second moves everything the same way, scaled by the displacement value. |

### Flatten
`filter.flatten`

Levels the terrain toward a height. Connect a mask to flatten only where you want a base. **In BAR players
cannot terraform, so buildable ground has to be here before the map ships** — a bot lab needs 96x96 elmos
within about ±10.7.

The mask is folded into the blend rather than applied twice, so partial mask values give partial levelling.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Level to | choice | Average height / A fixed height / The lowest point / The highest point | Average height | Average uses the mean height inside the mask. |
| Height | elmos | −10000 – 10000 | 0 | Shown when levelling to a fixed height. |
| Strength | number | 0 – 1 | 1 | |

### Sea level
`filter.seaLevel`

Decides how much of the map is underwater. **Water sits at height 0 in BAR**, so this finds the height that
floods the fraction you asked for and shifts the whole terrain to put that height at 0.

Setting a water line by typing a height is guesswork — you would have to already know the terrain's height
distribution. This asks the question the other way round. The answer is an exact quantile of the height
distribution, so it does not move when the preview resolution changes.

- **Inputs:** `terrain` (field).
- **Outputs:** `out` (field); `land` (field) — a 0–1 mask of everything above the water line, free of charge.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Set by | choice | How much is underwater / A fixed height | How much is underwater | |
| Underwater | number | 0 – 0.95 | 0.2 | 0 leaves the map dry, 0.5 makes half of it sea. Islands live around 0.55 to 0.7. |
| Water height | elmos | −10000 – 10000 | 0 | Shown in fixed-height mode. The height that becomes the shoreline. |

---

## Combiners

Ways to put two fields together.

### Combine
`combiner.combine`

Merges two terrains or masks. Deliberately one node with a dropdown rather than thirty two-input nodes: a
palette of thirty is harder to learn, and swapping the mode preserves the wiring, which is exactly the
experiment you want to run.

- **Inputs:** `a` (field), `b` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Operation | choice | Add / Subtract / Multiply / Maximum / Minimum / Average / Difference / Divide / Screen / Overlay | Add | Add stacks detail on a base shape. Subtract carves B out of A. Multiply with a 0–1 mask as B fades A out. **Maximum keeps whichever is higher, which is how you drop a mountain range into rolling hills without flattening either.** Divide yields 0 on division by zero. Screen and Overlay assume 0–1 data and are for combining masks, not heights. |
| B amount | number | −4 – 4 | 1 | Scales B before combining. 0.3 adds a hint of B. |

### Blend
`combiner.blend`

Fades between two terrains. With a mask connected, A shows where the mask is 0 and B where it is 1 — the
standard way to give different parts of a map different character.

- **Inputs:** `a` (field), `b` (field), `mask` (field, optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| B amount | number | 0 – 1 | 0.5 | Used when nothing is connected to the mask, and scales the mask when one is. |

### Height split
`combiner.heightSplit`

Uses A below a height and B above it. A quick way to give lowlands and highlands different treatment
without building a mask by hand.

- **Inputs:** `a` (field, "Low"), `b` (field, "High"), `reference` (field, "Measured from", optional —
  which terrain decides the height; defaults to Low).
- **Outputs:** `out` (field); `mask` (field) — the split itself, reusable elsewhere.

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Split height | elmos | −10000 – 10000 | 200 |
| Blend width | elmos | 0 – 2000 (slider to 400) | 60 |

---

## Selectors

Selectors turn a terrain into a 0–1 mask. They are how a graph stops being one shape and becomes a map:
rock on steep ground, sediment in valleys, snow above a line. Every one outputs the same kind of field the
filters accept as a mask, so any selection can drive any effect.

All five share two advanced parameters: **Soften** (elmos, 0 – 2048, default 0) blurs the mask so its edges
feather instead of stepping, and **Invert** (default off) flips it.

### Select by slope
`selector.slope`

Marks ground within a steepness band, **in real degrees**.

The BAR thresholds worth knowing, and the reason this node exists:

| Threshold | What it gates |
| --- | --- |
| **27°** | Every standard vehicle — Flash, Stumpy, Reaper, Goliath, the constructor lines. Below this, tanks drive. |
| **33°** | Hovers and Thor. |
| **54°** | All bots, commanders, amphibians, amphibious vehicles and hover-amphibians. |
| above 54° | Spiders, Vanguard/Karganeth, Korgoth and T4 all-terrain only. |

Leaving *To* at its default of 27 selects the ground BAR vehicles can drive on. Note which side the
softness falls on: the band itself is fully selected and *Edge softness* feathers **outside** it, so the
default 4 degrees means everything up to 27 is a full 1 and the mask fades to 0 by 31. Set softness to 0
when you want the mask to mean "vehicles can cross here" exactly and nothing beyond it.

One caveat when you are using this node to reason about pathing rather than to drive an effect: this node
measures per-sample slope by central difference, and the engine does something else. The engine evaluates
slope over 16x16-elmo cells and blends the steepest of the eight triangles in the cell toward their
average, weighted so that the steeper that triangle is the less the average pulls it back. The practical
consequence runs the opposite way to the folklore: a single heightmap corner 20 elmos above flat ground
makes the engine read that cell as 66 degrees, where a central difference reads far less. So this node
reads **flatter** than the engine on rough ground. When you need the engine's own answer — "is this pocket
actually unreachable" — use the validator, which reconstructs the engine's slope map exactly.

- **Inputs:** `terrain` (field).
- **Outputs:** `mask` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| From | degrees | 0 – 90 | 0 |
| To | degrees | 0 – 90 | 27 |
| Edge softness | degrees | 0 – 45 | 4 |
| Soften | elmos | 0 – 2048 | 0 (*advanced*) |
| Invert | boolean | — | off (*advanced*) |

### Select by height
`selector.height`

Marks the parts of the map inside a height band. Snow lines, shorelines, or keeping an effect off the
lowlands. Remember that 0 is the water line.

- **Inputs:** `terrain` (field).
- **Outputs:** `mask` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| From | elmos | −10000 – 10000 | 200 |
| To | elmos | −10000 – 10000 | 10000 |
| Edge softness | elmos | 0 – 2000 (slider to 400) | 60 |
| Soften | elmos | 0 – 2048 | 0 (*advanced*) |
| Invert | boolean | — | off (*advanced*) |

### Select by water flow
`selector.flow` — **expensive**

Marks where water collects and runs. Drives river beds, wet rock, and the sediment colour that makes a
texture look like water has been over it.

- **Inputs:** `terrain` (field).
- **Outputs:** `mask` (field); `flow` (field) — the raw accumulation, for texturing.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Threshold | number | 0 – 1 | 0.6 | Lower values select more of the drainage network, down to every hillside rivulet. |
| Edge softness | number | 0 – 1 | 0.15 | |
| Spread flow | boolean | — | on | *Advanced.* On, water spreads between downhill neighbours and gives smooth branching networks. Off, it takes the single steepest path and gives crisper single-thread channels. |
| Soften | elmos | 0 – 2048 | 0 | *Advanced.* |
| Invert | boolean | — | off | *Advanced.* |

### Select by curvature
`selector.curvature`

Marks convex ridges or concave gullies. Convex ground sheds material and shows bare rock; concave ground
collects it. This is the selector that makes a texture look weathered.

- **Inputs:** `terrain` (field).
- **Outputs:** `mask` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Select | choice | Ridges and crests / Gullies and hollows | Ridges and crests | |
| Strength | number | 0.05 – 20, log slider | 1 | Curvature values are tiny; this scales them into a usable mask. The scaling accounts for cell size, so the mask is stable across resolutions. |
| Soften | elmos | 0 – 2048 | 0 | *Advanced.* |
| Invert | boolean | — | off | *Advanced.* |

### Select by shelter
`selector.occlusion` — **expensive**

Marks ground hidden from the open sky — the insides of canyons and the bases of cliffs. Ambient occlusion
used as a mask; it is what makes crevices read as deep.

- **Inputs:** `terrain` (field).
- **Outputs:** `mask` (field); `occlusion` (field) — the raw openness, before inversion.

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Radius | elmos | 16 – 8192, log slider to 2048 | 512 |
| Intensity | number | 0 – 3 | 1 |
| Soften | elmos | 0 – 2048 | 0 (*advanced*) |
| Invert | boolean | — | off (*advanced*) |

---

## Natural

Simulations of the processes that make terrain look real. These are the expensive nodes and also the ones
that do the most for a map: raw noise reads as procedural because nothing has ever flowed across it.

Their parameters are densities and world distances rather than iteration counts and pixel radii, and the
simulation runs on a grid chosen from its own feature scale rather than from whatever grid the graph is on.
So a preview at 512 and a build at 4096 apply the same *amount* of erosion, and the preview predicts the
build.

### Water erosion
`natural.hydraulic` — **expensive**

Runs water over the terrain, cutting valleys and depositing sediment. The single biggest thing you can do
to stop terrain looking procedural.

Two solvers under one node, because you should choose by the look you want rather than by the numerical
method.

- **Inputs:** `terrain` (field); `hardness` (field, optional) — a 0–1 field where 1 erodes normally and 0
  is unerodible rock, for protecting plateaus that need to stay buildable; `mask` (field, optional).
- **Outputs:** `out` (field); `flow` (field) — where water ran, for river masks and wet-rock texturing;
  `wear` (field) — how much material was removed, which exposes bare rock; `deposition` (field) — where
  sediment settled, for sand, silt and flood plains; `water` (field) — standing water depth, produced only
  by the lakes solver.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Style | choice | Rivers and gullies / Lakes and flood plains | Rivers and gullies | The first traces individual water particles and gives crisp branching valleys, and is faster. The second simulates a sheet of water on a grid: smoother, and the only mode that leaves standing water. |
| Amount | number | 0.05 – 8, log slider | 1 | How much erosion happens. 0.5 is a light weathering pass; 4 carves deep canyons. |
| Feature scale | elmos | 8 – 2048, log slider | 128 | Roughly how wide the carved valleys are. Larger gives broad river valleys, smaller gives fine gullies. |
| Deposition | number | 0 – 1 | 0.3 | How readily sediment settles out. High values build flood plains and deltas. |
| Meander | number | 0 – 0.6 | 0.05 | Particle solver only. How much water keeps its heading instead of following the slope exactly. A little gives lazy meanders; a lot stops the water following the terrain at all. |
| Evaporation | number | 0 – 0.2 | 0.01 | *Advanced.* How quickly water disappears, which limits how far a channel can run. |
| Protect flat ground | boolean | — | off | *Advanced.* Erodes steep ground harder than flat ground. Helps keep buildable plateaus intact while still weathering the cliffs around them. Ignored when a Hardness field is connected. |
| Seed | seed | — | 0 | |

### Slumping
`natural.thermal` — **expensive**

Lets material slide off anything steeper than its angle of repose, piling up talus at the bottom. Turns the
unnaturally sharp cliffs procedural terrain produces into slopes that look like rock.

- **Inputs:** `terrain` (field); `hardness` (field, optional) — 0 holds firm at any angle; `mask` (field,
  optional).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Angle of repose | degrees | 5 – 85 | 35 | The steepest slope loose material will hold. Dry sand sits near 34°, scree near 38°; solid rock holds far steeper. Note how close the default is to BAR's 33° hover limit — a 35° talus slope is bot-only ground. |
| Amount | number | 0.05 – 5, log slider | 1 | How far material travels. One unit is about 400 elmos of run, roughly the length of a scree slope below a real cliff. |

### Snow
`natural.snow`

Settles snow above a height line, sliding it off steep ground and drifting it into hollows. Not just
"everything above a height": reproducing the sliding and drifting is most of what makes a snowy map look
like a snowy map rather than a white-painted one.

- **Inputs:** `terrain` (field), `mask` (field, optional).
- **Outputs:** `out` (field) — the thickened terrain; `coverage` (field) — a mask for texturing.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Snow line | elmos | −10000 – 10000 | 400 | Where snow starts, with a 60-elmo transition that reads as a natural boundary at map scale. |
| Slides off above | degrees | 10 – 85 | 45 | Steeper than this stays bare rock. |
| Depth | elmos | 0 – 200 (slider to 50) | 8 | How much height the snow adds. Keep it small: snow deep enough to see in the heightmap is snow deep enough to change what units can climb. |
| Drifting | number | 0 – 1 | 0.5 | How much snow gathers in hollows rather than lying evenly. |

---

## Gameplay

Nodes that know BAR's rules rather than just the geometry. They run the engine's own tests — its eight-triangle slope map, the height-difference check a building is judged by instead of slope, each move class's climb limit and water depth — so they answer the questions a heightfield on its own cannot: can a bot get up here, does a lab fit, is this expansion worth taking. A vehicle stops at 27 degrees and a bot at 54, and a bot lab needs every square of its 96x96-elmo footprint within 10.7 elmos of the platform height; since **BAR gives players no terraform command**, ground that flat has to come from the map.

### Symmetry
`gameplay.symmetry`

Copies or blends one sector of the terrain onto the others so no player gets the better hill. In a scan of 202 shipped BAR maps 70.9% were half-turn symmetric and another 25.4% mirrored, so for anything competitive this is a requirement rather than a style, and the `deviation` output is here to prove the map met it.

Send every layer that decides a fight through its own copy of this node with identical settings — heightmap, metal, typemap, feature masks. A mirrored heightmap whose metal map or typemap was placed by hand is the classic imbalance bug, and it is invisible on a heightmap preview. Quarter turns, third turns and the two diagonals exist only on a square map; on a rectangle the node stops and names the map's real size in elmos.

- **Inputs:** `terrain` (field) — the field to make fair; `mask` (field, optional) — where the mask is 1 the fix applies fully, where it is 0 the input passes through. Masking this node is the same admission as a Strength below 1: whatever the mask excludes stays uneven, so keep it for colour and decoration.
- **Outputs:** `out` (field) — the symmetric field; `deviation` (field) — the largest disagreement between each sample and its partners, in elmos. It is measured on the input, before the fix, so it reports on the graph feeding this node rather than on the result: preview it to find the ridge one branch built on one side only.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Symmetry | enum | — | Half turn (rotate 180°) | Which group the map is built on. A half turn is the only kind where both starts sit the same distance from the centre by construction; a left-right or top-bottom mirror flips handedness, so a ramp curving right on one side curves left on the other. A third turn resamples instead of permuting samples, so it lands symmetric only to within resampling error, and the corners outside the inscribed circle have no partner and keep what they had. |
| How to reconcile | enum | — | Copy one sector onto the others | Copying is exact — the authored sector survives digit for digit and every side matches bit for bit. Average keeps detail from all sectors and hides the seam, which is what you want after erosion, but two ridges 10 elmos apart come out as one broad mound. Keep the highest welds plateaus together; keep the lowest welds valleys. On a mask those two read as "set on any side" and "set on every side". |
| Master sector | enum | — | Top / left half | *Advanced.* Which sector is authoritative — the north half, or the west half for a left-right mirror. Switch to the bottom / right half when the south or east is the half you shaped. Only shown for Copy one sector onto the others. |
| Seam blend | elmos | 0 - 1024 (slider to 256) | 128 | *Advanced.* Only shown for Copy one sector onto the others. Copying leaves a seam where the two halves meet: the map stops being itself and becomes a copy of somewhere else, and the two do not join. Measured on a gentle map that step was 127 elmos over one square — a cliff across the whole map, holding nearly every impassable cell it had. This blends the halves across the join; 128 takes that 127 down to 9 and costs three elmos of relief. The result is exactly symmetric either way, and 0 is the hard copy. |
| Strength | number | 0 - 1 | 1 | *Advanced.* Blends the symmetric result back over the original. Anything below 1 leaves the map measurably uneven, so keep it for cosmetic layers such as a colour map and leave it at 1 for terrain. |
| Glide period | elmos | 0 - 16384 | 0 | *Advanced.* How far a glide slides along the map before it repeats. 0 uses the whole map, and a period longer than the map is treated as the whole map; the value is snapped down to an even number of grid samples so half a period lands on a sample. Only a map whose seam is open water or a tiling texture can take a glide at all. Only shown for the two glide kinds. |

### Passability
`gameplay.passability`

Marks every cell the chosen unit class can occupy, applying both gates the engine applies — the slope limit and the water depth limit — with depth measured down from 0, the water plane. Each cell is judged as a whole from the nine corner heights under it: a ground class is blocked when the deepest of them is too deep, a ship when the shallowest is too shallow, so a shoreline cell can be closed to both at once.

What this does not model is width. Nothing in the mask knows that a Goliath is 56 elmos across or a Thor 104, so a one-cell ribbon of passable ground reads as a route for a class that could never fit down it. Read `mask` as "this class could stand here", and judge chokepoints by measuring the gap: under 56 elmos turns away T2 assault units, under 104 turns away the largest ground units, and a comfortable main road in BAR is 200 to 400 elmos wide.

`cutOff` is the output that finds bugs — passable ground that no route reaches, which paints like terrain and plays like nothing. Every region holding a seed counts as main, so a map split down the middle with a start position on each side reports nothing cut off; leave `seeds` empty and the largest passable region becomes the reference instead.

- **Inputs:** `terrain` (field) — the heights to test. `seeds` (shapes, optional) — points that count as connected to the game, normally the start positions. The first point of each shape is used, and a seed landing on ground this class cannot occupy seeds nothing, which quietly drops the node back to the largest-region rule.
- **Outputs:** `mask` (field) — where the class can go. `cutOff` (field) — the stranded ground, trimmed against `mask` so everything it marks is terrain this class could actually stand on.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Unit class | enum | 11 classes | Vehicle — Stumpy, most tanks | Whose limits to test. 27 degrees stops every vehicle, 33 stops hovers and the Thor, 54 stops everything but spiders; ground classes drown past 20 elmos of water, a destroyer needs 8 elmos under it and a battleship 15. Two families break the pattern: a ship never consults the slope map, so an underwater cliff is open water, and a hover ignores depth and is slope-tested only over land. |
| Ignore pockets under | elmos | 0 - 4096 (slider to 1024) | 256 | Edge length of the smallest cut-off area worth reporting; a region is flagged once its area reaches this squared. A few stranded cells behind a cliff are noise, a 400-elmo shelf is a mistake. |
| Count a corner touch as a route | enum | 2 options | No — cells must share an edge | *Advanced.* Whether two cells meeting only at a corner count as connected. The narrowest ground class still needs 24 elmos of clearance, so a diagonal pinch is not a corridor; allowing it merges regions nothing can travel between and hides real cut-off ground. |

### Build pads
`gameplay.buildablePads`

Marks the ground a chosen building will actually go down on, and can cut the best near-misses into flat platforms. The rule it applies is **not** the slope rule: an immobile unit is never slope tested, so the engine takes a platform height from the single heightmap square under the build position and demands that every square under the footprint sit within 40 x tan(maxslope) elmos of it — 10.7 for a bot lab. A smooth 20-degree ramp is drivable by every unit in the game and buildable by nothing, and a field of 5-elmo bumps is the other way round. The engine also does not get to slide that platform height to suit the footprint, so a level lab pad with one raised square near an edge is refused in game even though its total spread looks fine. Judging a base site by slope is the most common way a good-looking map turns out to have nowhere to put a factory.

Leave *Platforms to level* at 0 and the node only reports. Above 0 it ranks near-miss sites by how little earth each would move, takes one per platform-sized tile so they spread over the map instead of packing into one corner, levels each to the mean height of its own core, and then re-runs the build test on the terrain it outputs — so the platforms it has just cut appear in the mask the author is looking at. That re-test is part of why this node is **expensive**: three passes of the engine's build test over the analysis grid plus a resample either side of the levelling, around a quarter of a second on a 16x16 map. The result is memoised, so the cost falls once per change rather than once per frame; tune the upstream terrain with levelling off and turn it on last.

- **Inputs:** `terrain` (field) — the heightmap to test. `mask` (field, optional) — where the levelling applies; where it is 0 the incoming terrain passes through untouched. It gates the platforms only, not the test, and with *Platforms to level* at 0 it does nothing at all.
- **Outputs:** `mask` (field) — "Fits here", the answer, placed at the footprint's centre where you would click to place the building rather than at its minimum corner, so it can be read directly as "put one here". `out` (field) — the terrain, carrying any levelled platforms; identical to the input when nothing was levelled.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Building | enum | 13 buildings | Bot lab / vehicle plant — 96x96 elmos | Whose footprint and tolerance to test. Check the lab first — the largest footprint at nearly the tightest tolerance, and no lab pad means no game. The spread each one tolerates varies hugely: a metal extractor takes 23.1 elmos over 64x64, a Vulcan wants 128x128 within 7.1. |
| Platforms to level | int | 0 - 64 | 0 | How many near-miss sites to cut into real platforms. At 0 the node looks and changes nothing. |
| Platform size | elmos | 16 - 2048 (slider to 512) | 128 | Side length of each levelled platform, rounded up to a multiple of 16 elmos, which is BAR's build grid. A lab needs 96; the default 128 leaves room for the nano turrets that go beside it. Only shown when Platforms to level is above 0. |
| Platform edge | elmos | 0 - 512 | 48 | *Advanced.* Width of the graded slope between a platform and the ground around it. Only shown when Platforms to level is above 0. |
| Near-miss allowance | number | 1 - 12 | 3 | *Advanced.* Multiplies the building's tolerance while hunting for sites. 1 only tidies ground that already works; 12 will cut a platform out of a hillside. Only shown when Platforms to level is above 0. |
| Deepest water allowed | elmos | 0 - 200 | 0 | *Advanced.* Water sits at height 0 in BAR. At 0 a pad must be entirely dry; raise it to let a building stand in the shallows. |

### Metal spots
`gameplay.metalSpots`

Lays out the map's whole metal economy in one pass: base spots inside each start's 600-elmo ring,
expansions between 600 and 1500 elmos, and a contested set out in the middle. Spots go down as complete
symmetry orbits, so every player's share is equal by construction and there is nothing to measure
afterwards.

BAR stores no metal spots. It reads one byte per 16x16 elmos out of the map file and discovers spots at
game start by connected-component analysis of those bytes, so a spot's position, its worth and even its
existence emerge from the shape painted here. The finder is 8-connected, and that is the trap: two blobs
touching at a single corner become one spot of double value whose reported centre sits between them. It is
what *Keep spots apart by* defends, and why the density is stepped up to the graph's resolution
nearest-neighbour instead of smoothed — a blurred blob bleeds across the empty cell that holds two spots
apart.

Candidates are limited to ground a 4x4 extractor can stand on, and preferred where a lab would fit beside
it, so the three counts are targets rather than promises: a ring of nothing but cliff quietly yields fewer
spots. Read the `spots` output back and count. The node is **expensive** because it always runs on BAR's
own 8-elmo grid, up to 2048 squares an axis, whatever resolution the preview is at — cost follows the map's
size in elmos, so a draft preview costs what a build does. Settle the terrain first and keep this late in
the graph.

- **Inputs:** `terrain` (field) — the heights spots are placed on; `starts` (shapes, optional) — one point
  per start position, in elmos. Connect it and the two start settings below are ignored.
- **Outputs:** `metal` (field) — the 0 to 1 density to wire into the Metal output node; `spots` (shapes) —
  one point per spot carrying its income. The second is the one to feed an overlay or a layout, because it
  is the only way to see where the spots actually landed and what each one is worth.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Symmetry | choice | None / Half turn (rotate 180°) / Mirror left to right / Mirror top to bottom / Mirror both ways (quarters) / Quarter turn (square maps) | Half turn (rotate 180°) | Places every spot together with its mirror images, so the two sides match without anyone comparing distances. None mirrors nothing and leaves a single start. Quarter turn needs a square map. |
| Where the starts go | choice | Left and right edges / Top and bottom edges / Corners | Left and right edges | Which edge the first start sits on; the symmetry makes the rest. Only used when nothing is connected to `starts`. |
| Starts in from the edge | elmos | 128 - 8192 (slider to 2048) | 700 | How far in from that edge the start sits. A base claims the metal within 600 elmos of the start before it expands, so a start much closer to the edge than that has nowhere to grow. Only used when nothing is connected to `starts`. |
| Base spots per start | int | 0 - 12 | 3 | Spots inside the base ring, within 600 elmos of the start. Shipped maps use three or four. |
| Expansion spots per start | int | 0 - 12 | 3 | Spots 600 to 1500 elmos out — eight to twenty seconds for a T1 tank at 75 elmos/s. A map with nothing in this ring has a dead early game. |
| Contested spots in the middle | int | 0 - 8 | 1 | Full mirrored sets, placed only where no start is nearer than 990 elmos, so holding one is a decision. A small map may have no such ground and gets fewer. |
| Metal per second per spot | number | 0.2 - 8 | 2 | What a T1 extractor collects from a base or expansion spot. Standard BAR spots yield 1.8 to 2.3, and the in-game metal brush defaults to 2. |
| Contested spot yield | number | 0.2 - 12 | 4 | The same for the middle spots. A double spot is worth about 4, and differences in value are how a map tells players where to fight. |
| Metal per second at full density | number | 0.1 - 10 | 1 | *Advanced.* Must match the same setting on the Metal output node, which is what turns a byte into income for the whole map. Too low and cells clip at their maximum, flattening the difference between a normal spot and a double. |
| Keep spots apart by | elmos | 32 - 2048 | 160 | *Advanced.* Centre to centre, applied between every pair of spots, the mirror images within one orbit included. The default leaves an empty 16-elmo cell between two 80-elmo blobs whichever way they lie; under about 136 a diagonal pair can meet and merge. |
| Keep spots off the edge by | elmos | 0 - 2048 | 96 | *Advanced.* BAR's own finder skips the outer 24 elmos of the map so a mex can physically fit, so metal painted out there is worth nothing. |
| Blob shape | choice | BAR standard (21 cells, 80x80 elmos) / Round / Square | BAR standard (21 cells, 80x80 elmos) | *Advanced.* How one spot's bytes are laid out on the 16-elmo grid. The default is what BAR's own spot placer writes, a 5x5 block with the four corners removed, and it sits comfortably inside the 90-elmo circle a T1 extractor collects from. |
| Blob radius | elmos | 16 - 160 | 32 | *Advanced.* Half the blob's width, rounded to whole 16-elmo cells. Keep it under 90: past 180 elmos across, no single extractor can capture the whole spot and the player loses income without being told why. Only shown when Blob shape is Round or Square. |
| Seed | seed | — | 0 | Rerolls the tie-breaks in the layout. Spots move; their counts and values do not. |

### Carve ramp
`gameplay.rampCarve`

Cuts a corridor down a cliff or up onto a plateau until its grade sits under the slope limit of the class you choose. The commonest fault in a first BAR map is a plateau with no way up: the terrain looks finished and half of it is scenery, because every approach reads over 27 degrees and the vehicles never arrive.

It only ever lowers ground, never raises it — a ramp built by filling leaves a causeway with unclimbable sides. That has one consequence to plan for: when the route is too short for the height it has to climb, the shortfall comes out of the top, and the cut eats back into the plateau rim until the grade fits. If the rim retreats further than you wanted, draw a longer or more diagonal route; widening it does nothing.

- **Inputs:** `terrain` (field) — the ground to cut; `route` (shapes, optional) — one line per ramp, in elmos, drawn across the edge you want a way up, and either direction gives the same ramp; `mask` (field, optional) — where it is 1 the cut applies in full, where it is 0 the terrain passes through untouched.
- **Outputs:** `out` (field) — the cut terrain; `ramp` (field) — the corridor, 1 along the floor and feathered to 0 across the shoulders. That second output is the one to keep: run it into a texture selector and the ramp reads as a road, which is how a player spots the way up before walking into the cliff.

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Passable by | enum | — | Vehicle — Stumpy, most tanks | Sets the grade to cut to: 27 degrees for vehicles, 33 for Thor and hovers, 54 for bots, the commander and amphibians. A bot-only ramp onto a plateau is a deliberate and effective way to decide where the fight happens. Spiders and ships are absent from the menu because they have no slope limit, so there would be nothing to cut down to. |
| Ramp width | elmos | 32 - 2048 (slider to 600) | 200 | Width of the corridor floor, which is cut flat right across — a cambered ramp reads steeper at its edges, and the engine grades a cell by its steepest triangle. A main crossing wants 200 to 400 elmos; below about 150 units conga-line up it and die one at a time, and nothing under 104 admits the widest ground units at all. |
| Shoulder | elmos | 0 - 1024 | 96 | *Advanced.* Width of the graded band either side, blending the cut back into the hillside. At 0 the floor ends in a vertical step and `ramp` has no feather to texture against. |
| Headroom under the limit | ° | 0 - 30, in 0.5 steps | 4 | *Advanced.* How far under the class's limit to aim, so a default vehicle ramp is cut to 23 degrees rather than 27. The engine reads a cell's slope from the steepest of the eight triangles in a 16x16-elmo cell, so a ramp built exactly at the limit fails wherever anything roughens it. Set this at or above the class's own limit and there is no grade left to cut to: the terrain passes straight through and `ramp` comes out empty. |
| From | vec2 | — | 1024, 4096 | The low end of the ramp, in elmos across and down. Ignored when `route` is connected. |
| To | vec2 | — | 4096, 4096 | The high end, in the same units. Which end you call high does not matter — the profile is solved in both directions. |

---

## Outputs

The sockets the exporter reads. It finds them by type rather than by name, so a graph can be rearranged
freely and still export. **Every output also passes its input straight through**, so one can be inserted
mid-graph as a tap without breaking the chain.

**Only the Height output is required.** Everything else has a derived default, because a first map should
export from a single Noise node wired to a single Height output.

### Height output
`output.height`

The terrain the map is built from. Every map needs exactly one.

**The height range matters more than it looks.** It becomes the `.smf` header's `minHeight`/`maxHeight` and
the `mapinfo.lua` overrides, and the engine quantises the entire map into **65536 steps across that range**.
Declaring a range much wider than the terrain uses throws away precision and leaves visible terracing on
gentle slopes. The build warns when the terrain fills less than half its declared range.

- **Inputs:** `terrain` (field).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Fit range to terrain | boolean | — | on | Picks the range from the terrain with a little headroom. Turn it off to pin the range so the water line stays put while you keep editing. |
| Lowest | elmos | −10000 – 10000 | −200 | Shown when the range is manual. |
| Highest | elmos | −10000 – 10000 | 800 | Shown when the range is manual. |
| Water level | elmos | −10000 – 10000 | 0 | **Height 0 is the water surface in BAR.** Moving this shifts the terrain so the sea rises or falls, rather than asking you to insert an offset node. |

### Metal output
`output.metal`

Where metal can be extracted, as a 0–1 density. The map stores one byte per 16x16-elmo cell, and `maxMetal`
in `mapinfo.lua` is what turns that density into metal per second.

Worth re-reading [the guide's metal section](GUIDE.md#5-metal) before hand-painting this: BAR discovers
spots at game start by grouping connected non-zero cells, so blob shape and spacing decide whether your
spots work. A standard BAR spot is about 64x64 elmos; a connected blob wider than roughly 180 elmos cannot
be fully captured by one extractor, and one wider than 540 disables spot detection for the whole map.

- **Inputs:** `metal` (field) — metal density.
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Metal per second at full density | number | 0.01 – 10 | 1 | Written to `mapinfo.lua` as `maxMetal`. A standard BAR T1 extractor on a standard spot yields about 1.8 to 2.3 metal per second. |
| Density scale | number | 0 – 4 | 1 | *Advanced.* |
| Ignore below | number | 0 – 1 | 0.02 | *Advanced.* Densities under this become zero. Stops a faint wash of metal across the whole map, which reads as buildable-anywhere to the extractor placement logic. |

### Terrain type output
`output.terrainType`

Which surface type each part of the map is: ground, rock, sand, water, road. Controls unit speed, crater
resistance and whether tracks show. Optional — the exporter derives it from slope and height when nothing
is connected.

- **Inputs:** `type` (field) — whole numbers 0–255 selecting a terrain type from `mapinfo.lua`.
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Values are | choice | Type indices (0–255) / A 0–1 range to spread across the types | Type indices (*advanced*) |

### Texture output
`output.texture`

The colour map painted onto the terrain. Leave it unconnected and the exporter generates one from the
terrain automatically.

- **Inputs:** `color` (color).
- **Outputs:** `out` (color).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Brightness | number | 0.2 – 2 | 1 |
| Contrast | number | 0.2 – 2 | 1 |
| Saturation | number | 0 – 2 | 1 |

Contrast pivots around mid-grey, and saturation uses Rec. 709 luma weights so desaturating does not shift
the apparent brightness.

### Specular output
`output.specular`

The specular map. **Its presence is what switches the engine onto its advanced shading path**, so a map
that wants splatting or detail normals must have one.

- **Inputs:** `in` (color). **Outputs:** `out` (color).
- **Parameter:** Strength, 0 – 2, default 1. Scales the whole map before export; alpha is left alone.

### Splat output
`output.splat`

The RGBA weight map that blends four detail textures across the map. Each channel is one material.

- **Inputs:** `in` (color). **Outputs:** `out` (color).
- **Parameter:** Strength, 0 – 2, default 1.

### Normal map output
`output.normal`

A detail normal map blended into the terrain lighting, adding surface relief the heightmap is too coarse to
carry.

- **Inputs:** `in` (color). **Outputs:** `out` (color).
- **Parameter:** Strength, 0 – 2, default 1.

### Grass output
`output.grass`

Where the engine draws grass, as a 0–1 coverage map. Optional.

- **Inputs:** `in` (field). **Outputs:** `out` (field).
- **Parameter:** Strength, 0 – 2, default 1.

---

## Utility

Plumbing and small conveniences. None of them generate terrain; they exist because a graph that is hard to
read is a graph nobody edits twice.

### Math
`utility.math`

Applies one arithmetic operation to every point of a terrain or mask. *One minus* is the one you will reach
for most — it inverts a 0–1 mask, which is what you need to turn a "protect this" mask into a Hardness
field.

- **Inputs:** `in` (field); `operand` (number, optional — overrides the Amount parameter when connected).
- **Outputs:** `out` (field).

| Parameter | Type | Range | Default | What it does |
| --- | --- | --- | --- | --- |
| Operation | choice | Add / Multiply / Raise to power / Absolute value / Negate / One minus / Round down / Threshold | Multiply | Raise to power reflects negative inputs so the sign survives, which stops it folding a signed height field in half. Threshold makes everything above the amount 1 and the rest 0. |
| Amount | number | −1000 – 1000 (slider ±10) | 1 | |

### Measure
`utility.statistics`

Reduces a whole terrain to one number — its highest point, its average height, its range — so one part of
the graph can react to another instead of relying on a value you typed once.

- **Inputs:** `in` (field). **Outputs:** `out` (number).

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| Measure | choice | Lowest point / Highest point / Average height / Highest minus lowest | Highest point |

### Number
`utility.number`

A single number you can wire into several places at once, so one slider drives them all.

- **Outputs:** `out` (number).
- **Parameter:** Value, −100000 – 100000 (slider ±10), default 1.

### Reroute
`utility.reroute`

Bends a connection so it can be routed around other nodes. Changes nothing about the data. Purely for
tidying, which matters more than it sounds on a graph with fifty nodes.

- **Inputs:** `in` (field). **Outputs:** `out` (field).
- **Parameter:** Label, text, default empty.
