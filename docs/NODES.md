# Node reference

Every node in the catalog, organised by category, with its type id, ports and parameters.

> **This file is written by hand against the catalog, so it can drift.** The source of truth is
> `packages/graph/src/nodes/*.ts` — each definition carries its own label, description, parameter help and
> ports, and the editor reads those, not this file. `node packages/cli/dist/cli.js nodes` prints the live
> list of type ids by category. If a default here disagrees with the code, the code is right and this file
> needs fixing.
>
> Current as of a catalog of 37 nodes in seven categories.

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
| Ridge sharpness | number | 0.25 – 3 | 1 | Only shown for Ridged. Low is broad whalebacks, high is knife edges. |
| Roughness | number | 0.05 – 0.95 | 0.5 | *Advanced.* How much each detail level contributes relative to the one before. Below 0.5 is smooth, above 0.6 is jagged. |
| Detail spacing | number | 1.2 – 4 | 2.02 | *Advanced.* How much smaller each level is than the last. Exactly 2 lines every level up on the same grid and shows as faint straight creases, which is why the default sits just off it. |
| Noise basis | choice | Perlin / Simplex / Value / Cellular | Perlin | *Advanced.* The underlying random function. Changes texture more than shape; Cellular gives cracked, cell-like ground. |
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

## Filters

Operations that reshape an existing terrain. **Every filter takes an optional Mask input**: where the mask
is 1 the effect applies fully, where it is 0 the input passes through untouched. That is why masking works
uniformly across the whole tool instead of being a per-node afterthought — and why any selector can drive
any filter.

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

- **Inputs:** `a` (field, "Low"), `b` (field, "High"), `reference` (field, optional — which terrain decides
  the height; defaults to Low).
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

Leaving *To* at its default of 27 selects exactly the ground BAR vehicles can drive on.

One caveat when you are using this node to reason about pathing rather than to drive an effect: the engine
evaluates slope over 16x16-elmo cells, blending the steepest of the eight triangles in the cell with their
average so that isolated spikes do not block units. This node measures per-sample slope by central
difference, which is close but not identical. When you need the engine's own answer — "is this pocket
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
