# World Machine / Gaea Feature Parity Brief

**Purpose.** Specification-grade reference for building a terrain tool that is "on par with World Machine, but easier for beginners," whose final deliverable is a Beyond All Reason (BAR / Recoil engine) map — a 16-bit heightmap plus a DXT1-tiled diffuse texture.

**How to read this.** Sections 1 and 3 are node-catalog specs: implement from the tables. Section 2 is the UX model to copy (and Section 4/5 is where to deliberately *not* copy it). Sections 6–8 are implementation detail with exact formats and byte layouts. **§7.2.1–7.2.5 and §8.5 are the binary-writer spec — read those against the source citations before writing a single byte.** §12 is the verification log: what was checked, against which primary source, and with what verdict. Anything not carrying a source citation or marked "UNVERIFIED — needs confirmation" should be treated as unchecked.

**Date of research:** 2026-09-13. World Machine current release line is *Dragontail Peak* (**build 4059**, released 2026-08-29 — confirmed from the release-notes page); the prior major line was *Hurricane Ridge* (**build 4041** confirmed; the "4041–4051" range is **UNVERIFIED — needs confirmation**), before that *Artist Point* (build 4031 per the release-notes page title; the "4027–4031" range is **UNVERIFIED — needs confirmation**). Gaea current line is Gaea 2.x (**2.2, released 2025-07-14** per the QuadSpinner blog). Statements tagged "[WM2]" come from the 2010 World Machine 2 device reference, which is still the only exhaustive per-parameter listing published; everything else is from the live help center or the Gaea 2 docs source repo.

---

## 0. Executive summary — what "parity" actually requires

| Capability | World Machine | Gaea 2 | Minimum for parity | Notes for Terrasmith |
|---|---|---|---|---|
| Node/device count | "Over a hundred tools is a lot" ([features.php](https://www.world-machine.com/features.php), verbatim) | **183 documented nodes** across 9 families (counted 2026-09-13 from `source/reference/nodes/*/*.md` minus `index.md`, branch `master`, in [QuadSpinner/Gaea2-Docs](https://github.com/QuadSpinner/Gaea2-Docs)) | ~45–60 well-chosen nodes | The long tail is mostly stylisation. The load-bearing 40 are listed in §10.1. |
| Hydraulic erosion | `Erosion` (flow/wear/deposition masks) | `Erosion`, `Erosion2`, `EasyErosion`, `Wizard`/`Wizard2` | 1 good hydraulic + 1 thermal + 3 mask outputs | §6 |
| Thermal / talus | `Thermal Erosion` (talus mask + talus depth) | `Thermal`, `Thermal2`, `Scree`, `Debris` | 1 | §6 |
| Vector/shape authoring | Layout Generator → renamed **Shapes** | `Draw`, `Island`, `Shape` (much weaker) | **This is WM's real moat.** Ship it. | §2.2 |
| Automatic colour | Colorizer + `Select Wetness` + "Quick Texture" macro | **SatMap: 1400+ satellite-derived CLUTs**, one node | One-click "make it look good" | §7 |
| Build vs preview split | preview res vs build res, explicit **Build** button | Graph (preview) vs **Build Manager** (final) | Yes — but make preview honest | §2.4, §4 |
| Tiled builds | Pro Edition only | All editions | Not needed for BAR (single map) | §2.5 |
| Heightfield precision | internal 0..1 normalised, project max-elevation scalar | internal **32-bit float** | float32 internally, quantise on export | §8 |

---

## 1. World Machine — full device catalog

World Machine's own categories are: **Generator, Filter, Natural (Natural Filter), Combiner, Selector, Converter (now "Texture"), Output, Parameter, Utility**. The public knowledge base at `help.world-machine.com/topics/reference/` exposes those nine category pages plus an `(All Devices)` roll-up — but the KB only has ~35 articles written. The exhaustive per-parameter listing is the World Machine 2 device reference, archived at [web.archive.org/web/20100822145020/http://www.world-machine.com/learn.php?page=devref](https://web.archive.org/web/20100822145020/http://www.world-machine.com/learn.php?page=devref). Both are used below; each entry is marked with its source.

Conventions used in every device: **inputs on the left, outputs on the right, an optional mask input on the bottom, parameter ports along the top.** Data flows left→right. ([Device Workspace](https://help.world-machine.com/topic/devices-and-the-device-workspace/))

### 1.1 Generator devices — *create* data

| Device | What it does | Key parameters |
|---|---|---|
| **Advanced Perlin Noise** | Second-generation customisable fractal generator; total control of the noise basis per octave and how octaves combine. | `Feature Size` (distance between major peaks/valleys); `Style` = Basic / Ridged / Billowy / Smooth Ridged / Smooth Billowy / Sharp Ridged / Flat Middle / Terraced / Stephen's Choice 1; `Octaves` (default *automatic* = derived from detail level); `Persistence`; `Elevation Center`; `Steepness`; `Random Seed`; guide inputs with `Shapeguide lead-in level`, `Distortion guide level`, `Persistence guide level`; multiscale group `Activity` / `Offset` / `Gain` / `Lead-in level` / `Type` (Signal Level, Elevation, Bi-Signal Level, Bi-Elevation, Classical); **Customize Fractal Profile** = per-octave style + strength (0–200%). |
| **Perlin Noise** | Classic Perlin/fBm. The universal building block. | `Feature Size`; `Noise Types` — monofractals: Standard / Ridged / Billowy; multifractals: Stephen's Experimental / Height-based Multifractal / Hybrid Multifractal (Musgrave) / Ridged Multifractal (Musgrave); `Octaves`; `Persistence`; `Offset`, `Gain` (multifractal only); `Random Seed`; `Use Stabilized Noise` (do **not** rescale to fill height range, so panning doesn't change the terrain); `Enable Distortion Input` + `Phase Distortion Strength` / `Direction` (0=left, 90=down, 180=right). |
| **Voronoi Noise** | Worley cellular basis. Sharp ridges; good for mountain cores. | `Feature Size`; `Style` = Fn / Fm−Fn / Fn Cells; `Distance Function` = Euclidean / Manhattan / Alternative #1 / #2; `Random Seed`; distortion input + `Phase Distortion`. |
| **Layout Generator** (renamed **Shapes** in Artist Point) | Vector shape container. Double-click opens the visual editor. See §2.2 — this is the single biggest differentiator. | `Rendering Mode` (Accurate/reduced); `Display as Mask`; `Use Breakup` (fractal edge distortion); `Invert Values`; Shape List; Import/Export SVG/AI. |
| **Constant** | Flat plane at a constant height. | `Height`. |
| **Gradient** | Constantly-sloping plane, optionally tiled in world space. | `Direction` (0=east, 90=north, 180=west, 270=south); `Width` (world coords, default 1.0); `Tiling` = None / Linear (ping-pong) / Discontinuous (sawtooth). |
| **Radial Gradient** | Shapes centred on one point. | `Radius` (1.0 fills default extents); `Type` = Spherical / Gaussian / Diamond / Square / Cone. |
| **File Input** | Import a heightfield or bitmap and place it in world space. | `Load`; `Refresh from File`; `Use absolute path`; `Auto-refresh from file every build` (enables feedback loops); `Interpret as RGB`; `Flip Y-axis`; `Outside Behavior` = Blank / Repeat Edge Values / Tile / Mirror; `Edge Blending` (% of area consumed by the blend zone, exported as an extra mask); World Placement (`Origin`, `Sizing`, `Preserve file aspect ratio`, Set from View / Bring into View / Set in Layout); Altitude Scaling = **Natural Elevations** / **Full Range** / **Specified** (metres). Reads TER, BT, HFZ, PNG, TIFF, BMP, TGA, R32, R16, RAW. |
| **Tiled File Input** *(Pro)* | Import a whole tileset as one logical terrain, with a multi-resolution cache. | `Specify from Files…`; `Validate Tileset`; `Use Tile Subset`; `Interpret as RGB`; `Tiles share edge vertices` (wrong value = 1-pixel offset); `Flip Y-orientation`; World Placement incl. `Size by Tile`; Altitude Scaling; cache `Preload` / `Reset` / `Reset Counters`. Hurricane Ridge added one-click tileset detection from a single example file and upper-left/bottom-left origin support. |
| **Color Generator** | A single solid colour everywhere — the base primitive of all texture networks. | `Color`. |
| **Material** *(Artist Point)* | A full PBR material primitive (6 channels). | `Material Source` = create / import; `Albedo`, `Roughness`, `Metal`, `Vertical Scale`, `Normal Intensity`; import options: per-channel filenames (Diffuse, Normal, Displacement, Occlusion, Roughness, Metal), `Auto-detect from file`, `Diffuse Colorspace`, `Normal Encoding` (green up/down), `Normalize displacement`, `Invert roughness`. **A material loaded from disk is always in localspace** and must be tiled/instanced into the world. |

### 1.2 Filter devices — *modify* a heightfield

| Device | What it does | Key parameters |
|---|---|---|
| **Clamp** | Scale and/or clip heights into a range. | Two range sliders; `Clamp Style` = Clamp (scale into range) / Clip (hard-limit) / Expand (stretch range to 0..1, clip outside); `Find Extents` (one-shot auto-fit); `Normalize Input` (warned: breaks Explorer/pan/zoom). |
| **Levels** *(Artist Point)* | Photoshop Levels. Three steps: stretch input low/high to 0..1 (clipping outside); mid-tone adjust; rescale to a final output range. | `Input Levels` (with histogram); `Output Levels`; `Auto-detect levels`; `Midrange Adjust` = Gamma / Contrast; `Middle` (a **spatial parameter**); `Soft clipping` (asymptotic approach to the ends — keeps detail near an edge). Replaces Expander+Bias/Gain+Clamp. |
| **Curves** | Draw a height→height remap curve. | Drawing area; presets `Linear`, `Glaciation`, `Canyonization`, `Cubic Midlands`, `Midland Plateau`; `Curve Strength`; `Bake Curve`; `Smooth Curve`; `Auto-smoothing`. |
| **Bias/Gain** | Non-linear brightness/contrast for terrain and masks. Immensely useful. | `Bias` (raise/lower); `Gain` (flatten/steepen). |
| **Terrace** | Evenly spaced level steps — exposed strata, river bank levels. | `Terrace Method` = Simple (flat + vertical jumps) / Sharp (sharp top, smooth bottom — default) / Smooth (both smoothed); `Number of Terraces` (over the full 0..1 range); `Terrace Shape` (≈0.5 = no terracing; away from 0.5 increases strength). |
| **Strata** *(Artist Point)* | Modern replacement for Terrace: embeds sedimentary/volcanic rock strata, expressed along the terrain normal. Flat surfaces show no strata. | `Strength`; `Scale` (spacing *and* exposure distance — small = fine lines, large = cliff outcrops/pillars); `Smoothness` (how smoothly the reference normal varies); octave-like multi-set control; `Tilt` (0=flat plane, 90=on its side) and `Heading` (0=east, rotates CCW) — **both spatial**. Outputs `Strata Layers` (ID mask) and `Strata Exposure` (where strata is visible). |
| **Blur** | Smooth a map. | `Blur type` = Uniform / Gaussian / Motion (X only); `Blur radius`; `Scale-independant` (same visual blur regardless of build resolution). Hurricane Ridge added a **spatially-varying radius**. |
| **Expander** | Image-morphology on heights/masks (dilate/erode/open/close analogues). | `Action` = Max (high areas grow) / Min (high areas shrink) / Swell (lumpy, elevation preserved) / Tighten (stretched, ridges appear); `Filter type` = Square (fast) / Circular (correct) / Hybrid (best preservation); `Distance`; `Scale-independant`. |
| **Simple Displacement** | Horizontal warp/distortion driven by a second heightfield. | `Direction` (deg); `Strength`; `Centered` (below 0.5 pulls, above pushes); `Edge Handling` = Repeat edge values / Mirror interior. |
| **Equalizer** | Histogram equalisation — makes every height value equally represented. | `Equalization` (0=none, 1=full); `Capture sample` / `Release sample` (freeze the histogram so results are repeatable and Explorer-safe). |
| **Ramp** | Sawtooth remap of heights. | `Type of Ramp` = Linear Ramp (mirrored sawtooth) / Standard Ramp (wrap to zero); `Frequency`; `Keep full height`. |
| **Height Splitter** | Split a terrain into N equal elevation bands, each on its own output port. | `Number of Bands`; `Clipping Behavior` = Reduce to zero / Maintain height. |
| **Add Noise** | Very high-frequency surface roughness. | `Noise Type` = Normal (±) / Additive (+ only); `Noise Amount`. |
| **Probability** | Treats the input as a probability density and scatters dots — object-placement maps. | `Probability Type` = Uniform; `Bias` (what input value means 50% chance; default 0.5). |
| **Inverter** | `1 − h`. | — |
| **Flipper** | Mirror the terrain. | `Flip Horizontally`, `Flip Vertically`. |
| **Simple Transform** *[WM2, superseded]* | Canned height transforms. | Height Transforms = Canyonize / Glaciate / Cubic Midlands / Midland Plateau; Kernel Transforms = Smoothing filter / Height-varying lowpass; `Intensity Modifier` (repeat count). |
| **Splitter** *[WM2, obsolete]* | Fan one output to N inputs. Obsolete: modern WM allows one output → many inputs directly. | `Outputs`. |
| **Crop & Transform** *(Artist Point)* | Crop / rotate / tile a **localspace** object. Visual editor. | `Resolution Type` = Original-or-smaller / Expandable; `Boundary Handling` = Blank / Edge values / Repeat interior / Mirror interior; `Width`, `Height` (%, may exceed 1). Also the idiomatic way to build mirrored/repeating maps. |
| **Crystallize** *(Artist Point)* | Force the input to constant values inside repeating hex or square cells (columnar basalt; hex board-game maps). | `Cell Shape` = Hexagonal / Square; `Size` (diameter); `Apply mask to full cell`; `Height Percentage` (constrain crystal height to a multiple of the diameter; 0 = unconstrained); rotation. Inputs: primary, `Cellular Sample` (take cell elevation from a different map), mask, placement/distortion. Outputs: primary, `Cell ID`, `Mask`, `Borders`. |
| **Flow Restructure** | Makes the terrain **hydrologically valid**: every cell gets an outlet lower than itself, by simultaneously carving ridges and filling basins with the minimum change. Removes every lake site. | `Ridge Carving` (how freely it may cut through ridges); `Basin Restructuring` (characteristic drainage-basin angle; 0 usually best); `Drain-to` = Map borders and drainage mask / Drainage mask / Map borders along drainage mask; `Operation` = Restructure / Synthesize (experimental). Inputs: primary, Drainage Input, Synthesis Guide. **Almost always required directly in front of Create Water.** Does not work correctly in tiled builds. |
| **Adjust Color** | Colour correction on a bitmap. | (KB stub) |
| **Tint** | Tint a bitmap/material channel. | (KB stub) |

### 1.3 Natural devices — *simulate*

| Device | What it does | Key parameters / ports |
|---|---|---|
| **Erosion** (now "Erosion (Legacy)" in the KB after the Hurricane Ridge rewrite) | Hydraulic erosion by rain and flowing water. **The device people buy WM for.** | See §6.1 for the full parameter semantics and the three mask outputs. |
| **Thermal Erosion** (a.k.a. Thermal Weathering) | Freeze/thaw fracturing of rock → talus slopes at the angle of repose. | See §6.2. |
| **Snow** *[WM2]* | Simulates snowfall, drift, and melt; **modifies the heightfield**, not just a texture. | `Intensity` (deposition rate per step); `Evaporative Balance` (1.0 = evaporates as fast as it falls); `Snow Amount` (simulation duration); `Snow Line` (elevation below which evaporation is greatly increased); `Linear Depthmask` (exact depth vs. log-scaled visual mask); `Depthmask Cutoff`; `Taper Snowfall` (reduce intensity towards the end — for glacier-like accumulation). |
| **Coastal Erosion** *[WM2]* | Fast, **non-simulated** beach/bluff approximation around a water level. | `Simulation Type`; `Use Global Water Level`; `Water Level`; `Beach Size`; `Transition Zone` (Smooth↔Cliffs); `Transition Power`; `Smooth Underwater Features` + `Smoothing Amount`. |
| **River Device** | Manually author river networks. Each drawn segment is a **reach**; double-click enters Layout View to draw. | Per-reach: `GCS Control` (Geomorphic Covariance Structure — the river's "character": meander style, width/depth variation); `Elevations from…` = Automatic-with-slope-limit / Automatic-from-terrain / Linear slope; `Reach Elevation Datum`; `Reach Slope`; `Bankfull Width` (**drives meander scale, not just width**); `Bankfull Depth`; `Channel Type` = Curved (parabolic, thalweg migrates) / Trapezoidal; `Trapezoid Aspect` (0=box, 1=triangle); `Flow Speed From` = Automatic / Manual + `Flow Speed`; valley group: `Create Valley` (0 = no valley), `Floodplain Height`, `Floodplain Width`, `Flatten Meander Belt Area`, `Valley Feature Size`, `Valley Width`, `Valley Height` (minimum depth below existing terrain), `Valley Wall Shape` (low = steep, high = broad U), `Valley Breakup Amount` (fractal blend into terrain). Drawing from the middle of an existing river creates a **tributary**. |
| **Create Water** | Automatically place rivers and lakes. Rivers start where uphill contributing area exceeds a threshold; lakes form at every depression. | `Drain To` = Map borders and existing water / Existing water only; `Headwater Locations` = Automatic / Specified (edit in Layout View); `Channel Head Area` (**km² of drainage needed to start a channel**); `Channel Model` = none / single-pixel paths / varying width+depth+speed from discharge; `Minimum Water Depth`; `Discharge Scalar`; `Flow Speed`; `Pin current headwaters` (freeze so different resolutions agree). Inputs: primary, Water Input, Precipitation Input. Hurricane Ridge added selective inclusion (ignore small/isolated lakes), better water–terrain boundary geometry, and toggles for lake vs. river generation. Does not work as intended in tiled builds. |
| **Reach Character** | Advanced primitive that turns a set of river behaviours into a GCS for the River device. Explicitly "not intended for direct use." | — |

### 1.4 Selector devices — *make masks*

These are how you get from geometry to texture. Modern WM (per [features.php](https://www.world-machine.com/features.php)) groups them as Basic, Advanced, Natural-filter outputs, Comparative, and By-identity.

| Device | What it selects | Key parameters |
|---|---|---|
| **Height Selector** | An elevation band. | Two height sliders; `Fuzziness`; `Falloff Type` = Linear / Exponential. Modern versions add **directional falloff**. |
| **Slope Selector** | A slope band. | Two slope sliders; `Fuzziness`; `Falloff Type`. |
| **Angle Selector** | Faces with a particular orientation (e.g. north-facing). | `Heading` (0=west, 90=south, 180=east); `Elevation` (vertical angle). |
| **Convexity Selector** | Exposed (convex, white) vs. recessed (concave, black) areas; neutral grey between. Shadows cracks / highlights ridges. | `Strength` (what convexity maps to full white). Modern versions add adjustable smoothing. |
| **Select Wetness** | Relative ground wetness from local slope **plus accumulated downslope water flow**. Uncannily good for texturing straight out of the box. | `Wetness` (incident precipitation amount). Inputs: primary, Precipitation Map (optional — lets you author rain shadows), Water Input (optional — underwater = fully wet). **Needs the whole drainage basin inside the render extents; wrong in tiled builds.** Powers the stock *Quick Texture* macro. |
| **Select Roughness** | Surface roughness. | (modern; parameters not published) |
| **Select Water** | Areas covered by the water datatype. | (modern) |
| **Compare Maps** *(Hurricane Ridge, new)* | Fuzzy comparison of two maps: "select where sediment deposition exceeds removal", "where terrain A is lower than terrain B". | — |
| **Select by ID / ID Convert** *(modern)* | Build masks from discrete region IDs rather than continuous values. | — |
| **Chooser** | Not strictly a selector, but the mask *consumer*: alpha-blends A and B by a control map. | `Method` = Alpha blend (**almost always what you want**) / Pre-multiplied alpha / Height-matching; `Mix order` = high values choose B / choose A; `Favor Elevations From` (height-matching only). Cascading Choosers was the classic layering idiom before the Layers device. |

### 1.5 Combiner devices

| Device | What it does | Key parameters |
|---|---|---|
| **Combiner** | Merge two terrains. | `Method` = Average / Add / Subtract / Multiply / Max / Min / Power / Root / **"Add-or-subtract about 0.5"** (values in B above 0.5 are added to A, below are subtracted); `Strength`. |
| **Chooser** | See §1.4. | |
| **Layers** *(Artist Point)* | Photoshop-style layer stack for heightfields, bitmaps **or full materials**. Replaces "cascading Choosers". | `Number of Layers`; per layer: `Opacity` (multiplied with the layer mask), `Operation` = Layer Over / **Layer Under** / Layer Add / **Heightblend Replace** / **Heightblend Merge**, `Premultiplied Alpha`. Each layer has a data input *and* an optional mask input; all data inputs must be the same type. Outputs: blended result, `Composite Mask`, plus a per-layer "what survived" mask. **Limitation: layer parameters cannot be driven by macro parameter ports — use a Chooser if you need that.** |
| **Multi Combiner** *(utility/macro)* | N inputs, only one is evaluated. Pairs with Multi Splitter to skip unbuilt branches and save time+memory. | `Number of Inputs`; `Input Choice`. |

### 1.6 Converter / Texture devices

| Device | What it does | Key parameters |
|---|---|---|
| **Colorize** *[WM2]* | Map a two-colour gradient across input values. | `Color 1` (bottom), `Color 2` (top). |
| **Colorizer** *(modern)* | Full gradient-based colouriser: a CLUT you edit with draggable keys, driven by any mask. This is WM's SatMap equivalent. | gradient keys (hold a modifier while dragging to duplicate); `Contrast Adjustment` (tighten transitions). |
| **Tint** | Tint a colour map. | (KB stub) |
| **Channel Splitter** | Bitmap → 3 heightfields. | `Channel Type` = Red/Green/Blue or Hue/Saturation/Brightness. |
| **Channel Combiner** | 3 heightfields → bitmap. | `Channel Type` = RGB or HSB. |
| **Create Normals** (was **Normalmap Generator**) | Encode the surface normal into RGB; R=X, G=Y, B=Z by convention. | `Encoding Type`; `Flip X`; `Flip Y`. Inputs: primary (heightfield or mesh) + **Tangent Input** — supply a mesh here and you get **tangent-space** normals; otherwise object-space. For tangent-space detail normals the recommended path is the Meshify device's detail normalmap. |
| **Lightmap Generator** | Bakes a lighting/shadow map. | `Illumination Model` = Direct Lighting / Raytraced Lighting; `Included Lighting` = Shadows / Indirect Lighting / Shadows+Indirect+Direct; `Produce RGB Lightmap`; `Soft Clipping` (exposure-style combine of diffuse+sky, only matters above ~90% intensity); `Use Global Light Direction`; `Sun Heading`; `Sun Altitude`; `Sky Lighting Level`; `Diffuse Level`; `Sun Color`; `Sky Color`. |
| **Texture Weightmap (Splatmap)** *(Artist Point)* | Processes N mask inputs into a **sum-to-one** weightmap. | `Number of Inputs` (typically 4, sometimes 8+); `Output type` = Individual weightmaps / **Packed weightmaps** (4 channels → one RGBA image) / **Material ID** (single mask holding the normalised index of the dominant material); advanced: `Priority Behavior` = Equal priority / Favor top inputs / Favor bottom inputs / Favor variety / **Favor best match**, `Priority` (0 = equal), `Exclusion` (1.0 = exactly one material per pixel; intermediate = sharper boundaries). |
| **Instance Tiling** *(Artist Point)* | Tile a localspace object (heightfield / bitmap / material) across the world. | `Tiling Type` = Regular / **Randomized**; `Mirror Tiling`; `Plan scale` (world size of one instance); `Elevation scale`; randomised mode adds `Chunk size` (% of the whole), `Vary placement`, `Vary rotation`, `Vary Scale`. **Projects in plan (XY) — distorts on steep slopes.** |
| **Instance Scattering** *(modern)* | Scatter (rather than tile) localspace objects. | `Aspect Ratio` preservation; additional compositing operators; mirroring variations; `Center-Z Adjustment`. |
| **Meshify** *(Artist Point)* | Heightfield → polygon mesh. Terminal: almost nothing downstream can operate on a mesh. | `Optimization type` = optimized / regular grid; `Max kTri` (thousands of triangles); `Quality` (a **spatial parameter** — smoothly varying LOD); `Surfaces` = top surface / fully enclosed volume; `Tile UVs in tiled builds` (tile (1,2) gets UVs 1.0–2.0 / 2.0–3.0); `Normal Type` = tangent / object space. Inputs: primary, **`Force Full Resolution`** (feed your scene water here so water and terrain edges match exactly; any mask > 0.5 forces full tessellation and those triangles do **not** count against Max kTri), `Mask` (interpreted as volume/depth when exporting an enclosed volume). |

### 1.7 Output devices

| Device | What it does | Key parameters |
|---|---|---|
| **File Output** (a.k.a. Height Output) | Saves the built heightfield. Only heights — any colour-by-elevation shown in WM is illustrative and is lost. | `Set` (filename); `Use absolute path`; `Participate when building tiled worlds`; `Save file every build`; `Write output to disk`; `Output Format` — see §8.1. |
| **Bitmap Output** | Saves a bitmap; accepts an optional heightfield for the alpha channel. | Filename; `File Format` (8- and 16-bit-per-channel options); `Output File on every Build`; `Participate in Tiled Builds`; **`Blend Across Tiles`** (disable only when colour-keying must preserve exact colours); `Write output to disk!`. |
| **Mesh Output** | Triangulated mesh export. | `Mesh Type`; filename; `File Format`; `Export using Quads`; `Output File on every Build`; `Participate in Tiled Builds`. |
| **Scene Output** *(Artist Point)* | Exports terrain + water + material as **one glTF file** (`.gltf` or packed `.glb`). | — |
| **Material Output** *(modern)* | Writes all six PBR channels as files. | — |
| **Scene View** | *Display* device, not a file export: overlays terrain + texture + water so the 3D view shows them together. Without one you see only one aspect at a time. | Inputs: Primary (heightfield), Texture Input, Water Input. `Display` = Terrain+Water / Water Only / Terrain Only. **Tip: freeze the 3D view onto the Scene View, then edit upstream devices and watch the final world update.** |
| **Overlay View** *[WM2]* | Older display-only combiner of a bitmap over a terrain. | — |

### 1.8 Parameter devices — for macro authoring

All of these move *numbers*, not maps. Their wires are **orange**, not black. ([Macros](https://help.world-machine.com/topic/macros/))

| Device | What it does | Key parameters |
|---|---|---|
| **Scalar Generator** | Emits a scalar 0.0–1.0. | `Value`. |
| **Scalar Clamp** | Restrict a scalar to a sub-range. | `Max Range`, `Min Range`, `Type` = Rescale / Clip. **The canonical fix for "parameters that can produce garbage" — see §5.** |
| **Scalar Inverter** | `1.0 − v`. | — |
| **Scalar Arithmetic** | One arithmetic op against a constant. | `Amount`; `Operation` = Add / Subtract / Multiply; `Clipping` = Clip (0.9+0.2→1.0) / Rollover (0.9+0.2→0.1). |
| **Scalar Combiner** | Combine two scalars. | `Operation` = Add Together / Subtract B from A / Multiply. Result clipped to 0..1. |
| **Bank Selector** | **Presets engine.** Tabs × variables: each variable has an output port; switching tab changes every variable at once. Driven by an integer or (preferred) a Selection parameter. | Add a tab / Add a variable / Copy tab / Paste tab / Currently active tab / Tab Selector / per-variable name + value slider. |
| **Integer Generator** | Emits an integer. | `Value`. |
| **Integer Equals** | Integer == constant → TRUE/FALSE. | `Comparison Value`. |
| **Coordinate Generator** | Emits a world-space coordinate packet. | `X Value`, `Y Value`. |
| **Universal Splitter** | Splitter for *any* datatype; auto-configures port types on connect. | `Outputs`. |
| **Automation Scalar** | A scalar settable from the XML automation script. | — |
| **Transform / Distortion Generator** | Parameter-space transform and distortion packets. | — |
| **Control Device** *(Hurricane Ridge, new)* | "Remote control" for other devices — set properties normally only reachable in the UI (enable/disable a device, set a build resolution). Built for macros. | — |
| **Report Presence / Report Spatial** *(Hurricane Ridge, new)* | Let a macro branch on whether an optional input is connected, or on its spatial type. | — |

### 1.9 Utility devices

| Device | What it does | Key parameters |
|---|---|---|
| **Pull-up** | Provide a default heightfield when an optional macro input is unconnected. Two inputs: `Reference` and `Override`; Override wins if wired. | — |
| **Switch** | Pass one of two inputs based on a boolean. | `Input choice`. |
| **Multi Splitter** | Send data to exactly **one** of N outputs; the others transmit nothing so their branches never build. | `Number of Outputs`, `Output Choice`. |
| **Multi Combiner** | The receiving half of the above. | `Number of Inputs`, `Input Choice`. |
| **Tap** *(Artist Point)* | Extract **or replace** a single channel of a composite datatype (Water, Material). Extract: wire composite in, pick a channel, read the 2nd output. Replace: wire the replacement into the Override port; the primary output is the composite with that channel swapped. WM auto-inserts a Tap if you try to wire a plain device into a composite wire. | `Tap into channel`. |
| **Checkpoint** | Pass-through routing aid with named channels **and a build-time result cache.** With `Keep only outputs and checkpoints` memory conservation enabled, only checkpoints retain full-resolution results, so edits downstream rebuild from the checkpoint instead of from scratch. **Caches at build time only — nothing is written to disk.** | per-channel names. |
| **Code Device** *(Hurricane Ridge, dev preview)* | Write a new device inside the app. **Slang compute shaders via Vulkan/Metal with Lua as host language**, syntax highlighting, real shader line numbers, sandboxed, versionable, maskable, drivable by spatial parameters. | — |

---

## 2. World Machine's core UX model

### 2.1 Worlds, devices, and the workview

> "A World Machine world file doesn't define a terrain, but the *steps* to create a terrain. This is the source of both its power and its complexity." — [Chapter 1](https://help.world-machine.com/topic/chapter-1-an-introduction-to-world-machine/)

- A **world** = the set of devices + wires + render extents + project settings. Saved as `.tmd`.
- The **workview** (F5) is the graph canvas. Devices are boxes; wires carry typed data.
- **Adding devices:** Devices menu · toolbar · right-click context menu · **`Tab` = add-from-search** (documented as "most powerful"). Hold SHIFT to keep placing the same device. Click on a device/port while placing and WM auto-wires it.
- **Wiring:** drag from a port; all incompatible ports disappear during the drag. **Releasing over empty space opens add-from-search pre-wired to that port.** One output → many inputs is allowed; one input takes exactly one wire.
- **Wire routing:** click-drag a wire to add a route point; drag one onto another to merge; right-click → *Remove all route points* / *Delete wire*.
- **Device status light** (next to the name):
  - **Green** — fully built at the highest resolution.
  - **Pale green / yellow** — connected but only previewed; the colour walks yellow→green as background builds refine it.
  - **Red** — unconnected or errored.
- **Per-device commands:** About this device · Set Name · Set Properties · **Set Resolution** (override project resolution, or make the device *localspace*) · Set output display hint (**terrain** vs **mask** — changes how it renders) · **Lock Preview on Device** (`f`) · **Bypass Device** (temporarily a no-op — the A/B toggle) · **Disable Device** (greyed out; downstream fails to build) · Disconnect Device · Convert Devices into Macro · Group selected.
- **Groups**: named, coloured (RGBA), described; moving a group moves its contents and **pushes other groups out of the way** unless the group is marked *floating* (dashed border).
- **Overlays**: recolour the whole graph as a heatmap of `Build Time`, `Memory`, or `Tile Blending` (in)compatibility.
- **Blueprints**: drag-select devices → *Define Blueprint* → saved to a library as a plain `.tmd`. Unlike macros, blueprints are **not hidden** — they drop a visible, already-wired set of devices into your graph. Favourites appear in the quick menus.
- **History** *(Pro)*: full edit history persisted on disk between sessions, **named snapshots**, Alt+Left/Right or mouse buttons to navigate, "starred changesets" survive save/load. Projects carry a version and *offer* to upgrade devices from older releases rather than silently changing behaviour.

### 2.2 The Layout Generator / Shapes system — the vector layer

This is the feature that separates World Machine from every "noise + erosion" tool. It is where an artist says *"the range runs here, the coast is there, this is a road."*

- A Layout Generator is a **container for shapes**, and appears as one device in the graph. Double-click → the visual editor.
- **Two fundamentally different uses:**
  1. **As a generator** — its output becomes a guide/mask wired into e.g. a Perlin Noise shapeguide input.
  2. **As a modifier** — wire an existing terrain into its *primary input* and the shapes are **embedded** into that terrain (level a build pad, cut a road, insert a waterway).
- **Per-shape properties:** `Default Value` (the shape's height), `Opacity` (vs. background), `Falloff distance`, `Falloff type` = **Exterior** (full strength to the border, falls away outside) / **Interior** (falls off inside, no influence at the border), `Operation` = positive / negative (subtractive), `Shape Falloff function` = Linear / Squared (gentle bottom, sharp ridge on top) / Square-root (gentle top, steep bottom) / S-falloff (smooth both) / **Custom** (curve editor — this is how you author road and river cross-sections), `Falloff Fader` (0% = always linear, 100% = the chosen function), `Shape Breakup Participation`.
- **Overlap rule:** where shapes overlap, *the greatest height governs*; subtractive shapes are subtracted from the positive result at that point.
- **Vertex-based shapes (polygon, path):** per-vertex `Enter Precise Value` (X, Y, elevation), `Value Key-Point` (manual vs. interpolated height), Delete/Subdivide Vertex, **Vertex Welding** across different shapes (drag one vertex onto another — welded vertices always share a position, so transforming one shape drags the linked river/road along), Break Weld. Quick gesture: **right-click a vertex and drag up/down without releasing to set its height.**
- **Bezier**: per-segment linear↔bezier toggle; handles are linked for smoothness by default, hold SHIFT to break; *Perform Curve Smoothing* sets all handles at once.
- **Fractal Breakup**: enabled per-layout, opted into per-shape. `Fractal Breakup` (intensity), `Breakup Scale` (distance over which the distortion acts — large = slow big variations, small = ripple), `Roughness` (octave count). This is what stops layouts looking like a CAD drawing.
- **Curve editor**: horizontal = distance along the curve, vertical = elevation. Two modes — *Vertex mode* (add/delete/move knots horizontally, for falloff profiles) and *Modify mode* (heights only, for lofting a path). Presets are loadable/savable.
- **Vector import/export:** SVG and AI. Import scaling options: treat file coordinates as metres, kilometres, or a custom factor; optional Y-flip for top-left-origin programs. **Per-vertex data and WM-specific shape data do not survive the round trip.**
- **Hurricane Ridge upgrades:** shape *grouping* (composite shapes), transform widgets, shape browser with hierarchy, lock/hide, extend existing paths, robust undo/redo while editing vertices, adjustable falloff as any percentage between fully-internal and fully-external, **independent vertex heights via interpolating surfaces on box and polygon shapes**, compositing modes `Behind` / `Within Existing` / `Intersect` / Add / Subtract, a new **Interpolating Surface** shape type for sculpting smooth forms, path↔polygon conversion, split path at a vertex.
- **Naming gotcha:** in Artist Point the device was renamed from "Layout Generator" to **Shapes**, and the quick-add buttons ("Attach Layout as Mask", "Attach Layout as Height Adjustment") were **removed**. This generated its own FAQ page: [Where did the Layout Generator go?](https://help.world-machine.com/topic/where-did-the-layout-generator-go/)

### 2.3 The four views

| View | Key | What it shows | Interaction |
|---|---|---|---|
| **Device Workview** | F5 | The graph. Default on startup. | Everything in §2.1. |
| **Layout View** | F6 | The **infinite** procedural world, not just the render extents. Pan/zoom from metres to thousands of km. | Three modes: *Overview* (pan/zoom only), *Render Extent* mode (graphically add/move/resize extents; Zoom to Extents / New Extents / Set Current / Manage…), *Device* mode (manipulate device parameters that expose visual handles; Zoom to Device Origin, Show only Selected). Toggles: `Grid`, `Snap`, `RQ` (show render extents), `Tiles` (show tile boundaries), `Show` (terrain on/off), remembered per-tab. |
| **Explorer View** | F7 | Free flight over the infinite world with a **refining progressive LOD** system. HUD shows X/Y coordinates, movement speed, and **build load** (% of the last second spent building tiles). | Navigation modes: *God's Eye* (drag terrain to pan; RMB drag = elevation; LMB+RMB = view angle), *Fly*, *Walk*, *Drive* (with ctrl = hover, shift = turbo). `View` button recentres on the render quad; `Jump` to X/Y. In Artist Point+, render-extent manipulation moved here from Layout View. |
| **3D View / 2D View** | F8 / F9 | The current render extents only. 3D has Orbit / Free Look / Reset View / **Snapshot Mode** (full-resolution OpenGL render — terrains >1024² are normally downsampled for display) / Detail Toggle. 2D is a non-OpenGL overhead shaded view for huge maps or weak GPUs. | |

**The artifact warning.** Layout and Explorer View render terrain *outside* the render extents, where simulation devices (Erosion, Snow, Create Water, Select Wetness, Flow Restructure) cannot see the data they need. WM marks such devices in the workview with a red **"!"**. This is a permanent, structural honesty problem with a procedural-infinite-world model, and it is a significant beginner trap.

**Modern 3D viewport** (from [features.php](https://www.world-machine.com/features.php)): HDR panorama IBL with rotatable environment, exponential height fog, exposure/tone-mapping/contrast, soft penumbra shadows, **A:B side-by-side or sliding-wipe comparison of two world states or a device's input vs. output**, display guides (**slope overlay** showing where the ground exceeds walkable slope, contour lines, terrain grid showing where the real data resolution sits), **camera slots on keys 1–8**, and an orthographic camera that transitions smoothly out of perspective.

### 2.4 Preview resolution vs. build resolution — and the Build concept

This is the central mental model, and the central beginner trap.

- **Preview**: WM continuously previews *every* device at a low resolution (the configurable *Preview Resolution*, "a value of 64 to 128 is appropriate for most computer systems"). The left-side panel shows the preview of the selected device, live, as you drag sliders.
- **Build**: pressing the green Build button runs the graph at the **project resolution** set in Project Settings. Only then do File/Bitmap/Mesh outputs have real data. Device status lights go pale-green → green as this happens.
- **Lock Preview on Device** (`f`): freeze the preview on device X, then go upstream and edit device Y — you watch X's *filtered* result update live. This is the single most useful navigation feature in the app and it is hidden behind a hotkey.
- **Resolution strategy**: Project Settings → `Resolution` slider plus a **"Power of Two plus one"** dropdown (or Custom). The +1 exists because heightfield exports usually need *n+1* samples for *n* cells. Basic Edition "is free, builds up to 1K, and is for personal and non-commercial work" (features.php, verbatim). Whether "1K" means 1024 or 1025 is **UNVERIFIED — needs confirmation**.
- **Memory Conservation** strategies: `No Conservation` (keep every device's results — most memory) · `Discard unconnected ports` · **`Keep only outputs and checkpoints`** (Checkpoints act as a cache; only they and outputs retain data) · `Keep only outputs` (any change after a final build requires a full rebuild).
- Hurricane Ridge added **per-device previews** (results appear as each device finishes rather than at the end), **async memory paging** (ahead-of-time result archiving), build throttling under low memory, and a Stop/Preview button in the status bar.

### 2.5 World extents, sea level, and tiled builds

**Render Extents** = "a rectangular area that exists in 3D world space, used to set the area of terrain being exported or viewed. The Render Extent stores the location, resolution, and other information for this view into your world." A world may have **many** extents; they can be **locked** against accidental change; they are edited numerically in Project Settings or graphically in Explorer/Layout View.

World Dimensions: `Origin` (centre of the extent in worldspace), `Width` & `Breadth` (X/Y size about the origin), a Square/Nonsquare constraint toggle.

**The vertical axis is global and is a foot-gun.** From [Render Extents and Project Setup](https://help.world-machine.com/topic/render-extents-and-project-setup/):

> "Internally, World Machine keeps all height information as a number between 0 and 1. The scaling value set here allows you to set the elevation in meters that a maximum height value refers to. […] Note that this scaling value is applied worldwide; increasing the value here will instantly increase the apparent vertical relief of every terrain in the world. If the terrain you're creating is sensitive to having exact elevations, it's advisable to **set this only once at the start of your project**."

**Sea level**: the left-side toolbar carries a water-level slider and a show/hide toggle for a **display-only** water plane. Some devices (`Coastal Erosion`) can opt into `Use Global Water Level` so their result matches what you see. Actual water *geometry* comes from the River / Create Water devices and the Water datatype, which is a separate concept from this display plane.

**Tiled builds** *(Professional Edition)*. Rationale, verbatim: "the practical resolution limit for a single heightfield in World Machine is around 8192×8192". Three steps: set tiled export parameters → enable `Participate when building tiled worlds` on each output → run *Tiled Build*.

Parameters: `Tiled Build Render Extents` (which extent to use) · `Tile Output Subset` (re-export only some tiles) · **`Tile Resolution`** (per tile) · **`Tiles per Side`** (final resolution = tile res × tiles per side) · **`Blending Percentage`** (extra area built around each tile, then blended during the Merging phase — this is how simulation devices are made tileable) · `Share Edge Vertices` (adjacent tiles share their edge values so meshes sit seamlessly) · `Merge Output into single file` (memory permitting) · `Flip Y-axis orientation`.

Tile naming string keywords: `%x`, `%y`, `%res`. Default `_x%x_y%y`, so `test_output.png` → `test_output_x5_y9.png`. Plus `Pad coordinate digits` (`x08_y15` vs `x8_y15`) and `Tile numbering start` (0 or 1).

> "Some devices, including the simulation-based devices such as Erosion and Snow, can produce different results in tiled mode versus normal builds … when tiling, they do not have access to information from outside of the tile region."

Hurricane Ridge added tiled-build **recovery** (resume after failure) and **real-time incremental merging**.

**Automation** *(Pro)*: XML scripts (`<automation version="WMP2">` root) with three command classes — Worldfile actions (`<load file="…"/>`), Modification (`<world res="512"/>`, `<enable group="A"/>`, `<disable group="B"/>`), and Build/Export (`<build mode="normal"/>`, `<output/>`). Run from the File menu or by passing the script path on the command line.

### 2.6 Macros and the parameter system

A **macro** is a subgraph packaged as a single device. Inside it there are four undeletable devices:

- **Macro In** / **Macro Out** — define the macro's ports. Per-port: name, **data type** (heightfield / bitmap / text / any), and an **optional** flag. A non-optional input that is unwired makes the whole macro fail to build; an optional one lets the macro supply its own default (see Pull-up).
- **Macro Config** — description, author, version.
- **Macro Parameters** — the exposed UI. Parameter types: **Scalar** (0..1), **Boolean**, **Integer** (with configurable min/max — you *must* set the range), **Selection** (an integer whose values carry labels, rendered as a dropdown). Every parameter can carry **help tooltip text**.

Parameters reach devices through **parameter input ports along the top edge of each device**, which only appear when a device is selected. Between the macro parameter and the target you can insert an arbitrary **scalar device network** (Scalar Clamp / Arithmetic / Combiner / Bank Selector / Universal Splitter) so one slider drives several internal parameters, each over its own sensible range.

**World Machine's own macro design guidelines are, almost verbatim, a beginner-UX manifesto — and are the best available statement of what "easier for beginners" means:**

1. **Limited focus.** "When in doubt, create several macros that can be strung together rather than one monolithic macro."
2. **Use the right number of parameters.** "A far more common mistake is to expose too many parameters to the user… Every parameter you add dilutes the attention that a user can give to any particular parameter. It's all too easy to drown the extremely important parameters under an ocean of irrelevant options." It explicitly cites the 4–7 chunk limit and recommends erring low, plus spatial "chunking" of related parameters.
3. **Use the right parameter for the job.** Drive integers with integers and booleans with booleans; a scalar driving an integer makes the output "suddenly jump from setting to setting".
4. **Allow only valid parameter ranges.** "A scalar has a valid range of 0.0 through 1.0. If a certain effect is only really useful in the range of 0.2 to 0.5, then why let the user go outside of that range? It's far more likely to confuse than empower."
5. **Use Bank Selectors.** ("I'm not kidding!") Presets-as-a-device: a labelled dropdown that sets a dozen hidden parameters at once.
6. **Short-circuit untaken options** with Multi Splitter / Multi Combiner so unselected branches never build.

---

## 3. Gaea 2 — differences and improvements

Gaea (QuadSpinner) was built by an ex-World Machine developer and is the closest direct rival. Its docs are open source at [github.com/QuadSpinner/Gaea2-Docs](https://github.com/QuadSpinner/Gaea2-Docs); everything below is cited to a path inside `source/`.

### 3.1 Full node catalog (183 nodes, 9 toolboxes)

Counted from `source/reference/nodes/{primitive,terrain,simulate,surface,modify,derive,colorize,utility,output}/*.md`, excluding each family's `index.md`, on branch `master` as of 2026-09-13. Per-family counts verified against the GitHub tree API: primitive 23, terrain 14, simulate 25, surface 21, modify 41, derive 14, colorize 13, utility 20, output 12 = **183**. (An earlier draft of this brief said 192; that figure was wrong and did not even match the sum of its own per-family counts.) Descriptions are the front-matter `description:` fields.

**Primitive (23)** — `Cellular`, `Cellular3D`, `Cone`, `Constant`, `Cracks`, `DotNoise`, **`Draw`** (draw entire mountain ranges in the shape you choose), `DriftNoise` (overlapping "shelves"/cliffs), `File`, `Gabor`, `Hemisphere`, `LinearGradient`, `LineNoise` (sets of lines, distortable into layered ridges), `MultiFractal`, `Noise` (single-pixel noise), `Object` (load mesh data), `Pattern`, **`Perlin`** ("geo-variant" — the base Perlin shape modified for terrain), `RadialGradient`, `Shape`, `TileInput`, **`Voronoi`** (geo-variant), `WaveShine`.

**Terrain (14)** — `Canyon` (drainage-based river canyon), `Crater`, `CraterField`, `DuneSea`, **`Island`** (draw a coarse island outline, algorithm generates the detail), **`Mountain`** (modulated Voronoi + distortions — the workhorse), `MountainRange`, `MountainSide`, `Plates` (Perlin core with flat plate-like formations between), `Ridge`, `Rugged` (adds strong rocky surface while preserving overall shape), `Slump`, `Uplift`, `Volcano`.

> **This is Gaea's beginner superpower.** World Machine makes you *assemble* a mountain from Perlin + Combiner + Erosion. Gaea gives you a node literally called `Mountain` that is already a mountain.

**Simulate (25)** — `Anastomosis`, `Crumble`, `Debris`, `Dusting`, **`EasyErosion`**, **`Erosion`**, **`Erosion2`**, `Glacier`, `Hillify`, `HydroFix`, `IceFloe`, `Lake`, `Lichtenberg`, `Rivers`, `Scree`, `Sea` (water surface + coastal erosion), `Sediments`, `Shrubs`, `Snow`, `Snowfield`, `Thermal`, **`Thermal2`**, `Trees`, **`Wizard`**, **`Wizard2`**.

**Surface / LookDev (21)** — `Bomber` (stamp a heightfield across the surface), `Bulbous`, `Contours`, `Craggy`, `Distress`, `FractalTerraces` (multi-octave terracing), `Grid`, `GroundTexture`, `Outcrops`, `Pockmarks`, `RockNoise`, `Rockscape`, `Roughen`, `Sand`, `Sandstone`, `Shatter`, `Shear`, `Steps`, `Stones`, **`Stratify`** (non-linear broken strata with sub-strata in confined local zones — WM's `Strata` equivalent), `Terraces`.

**Modify (41)** — `Adjust`, `Aperture`, `Autolevel`, `BlobRemover`, `Blur`, `Clamp`, `Clip`, `Curve`, `Deflate`, `Denoise`, `Dilate`, `DirectionalWarp`, `Distance` (distance field), `Equalize`, `Extend`, `Filter` (audio-inspired parametric filter on frequency content), `Flip`, `Fold`, `GraphicEQ` (multi-band EQ across feature scales), `Heal` (reconstruct damaged / low-res / 8-bit data at 16-bit fidelity), `Match` (adapt heights of Input to a Reference), `Median`, `Meshify`, `Origami`, `Pixelate`, `Recurve` (curvature-based expander), `Shaper` (bulk terrain up/down — **"add body before erosion so the terrain doesn't end up looking too thin afterward"**), `Sharpen`, `SlopeBlur`, `SlopeWarp`, `SoftClip`, `Swirl`, `ThermalShaper`, `Threshold`, `Transform`, `Transform3D`, `Transpose` (apply the character of a Reference to an Input), `TriplanarDisplacement`, `VariableBlur`, `Warp`, `Whorl`.

**Derive / Data Maps (14)** — `Angle`, `ColorThreshold`, **`Curvature`** (convex selection — "often as highlights on top of an existing texture map"), **`FlowMap`**, `FlowMapClassic`, **`Height`**, `Normals`, **`Occlusion`** (AO-like but favouring sedimentary processes and rock crevices rather than lighting), **`Peaks`** (inverse curvature — isolates prominent high points even at differing elevations), **`RockMap`**, **`Slope`**, **`Soil`** (density increases in crevices where slope lets soil settle; `Power` = number of settling cycles), **`TextureBase`**, **`Texturizer`** (TextureBase with curated preset profiles; `Factor` is the main strength).

**Colorize (13)** — `CLUTer`, `ColorErosion` (erosion-style transport/deposition applied to *colour*), `Gamma`, `HSL`, `RGBMerge`, `RGBSplit`, **`SatMap`**, `Splat` (weighted combine of RGBA channels into one heightfield), `SuperColor`, `Synth` (turn a photo/artwork into a CLUT), `Tint`, `WaterColor`, `Weathering` (brightens protrusions, darkens crevices).

**Utility (20)** — `Accumulator` (merge the masks of multiple Snow/Lake/Debris nodes without wire spaghetti), **`Chokepoint`**, **`Combine`** (blend modes; up to 10 ports), `Compare`, `DataExtractor`, `Edge` (zero-borders vignette), **`Gate`** (baking boundary — forces all ancestors to bake), `Layers`, `LoopBegin` / `LoopEnd`, `MacroPort`, **`Mask`** (mask an effect **after** it has been created — retro-masking), `Math` (expressions), **`Mixer`** (layer-based colour compositing with built-in masking), `Repeat`, `Reseed`, `Route` (integer-driven branch), `Seamless` (make any terrain/colour map tileable), `Switch` (bool-driven branch), `Var`.

**Output (12)** — `AO`, `Cartography`, `Export`, `Halftone`, `LightX`, `Mesher` (meshes + LODs), `PointCloud` (PLY/XYZ/CSV), `Shade`, **`Sunlight`** (sun-light/shadow *integral* over a period up to 365 days — usable to drive snow melt and vegetation growth), `TextureBaker`, `Unity`, `Unreal`.

### 3.2 Erosion quality — the headline difference

Two claims in the Gaea docs matter enormously and are worth copying:

1. **Resolution independence.** > "The Erosion node's algorithm addresses one of the biggest problems in digital erosion: it preserves features across different resolutions. This means that a `512 x 512` preview build will maintain essential parity for all major erosion features with a high resolution 4K or 8K build. **You no longer need to guess the output type.**" (`reference/nodes/simulate/erosion.md`)

   This directly answers World Machine's worst beginner trap (§4.1). Implement this or you inherit WM's problem.

2. **Selective Processing ≠ masking.** A bias mask *modulates a parameter* across the terrain rather than compositing the effect: "With masking the effect is tightly contained within the provided mask… while with Selective Processing, the mask provided will apply a modifier to that area, however processing will still occur outside the bias mask." Bias types: built-in `Slope` and `Altitude` (normalised 0–100%, invertible with `Reverse`), or a custom `Area` input. The mask maps `0 → 0%` and `1 → the slider value` for `Rock Softness`, `Erosion Strength`, and `Precipitation Amount`. (World Machine's equivalent is the `Hardness Mask` input plus, since Hurricane Ridge, generalised **spatial parameters**.)

`Erosion2` "remains user-friendly and delivers deterministic results with up to 10x faster performance, even on the CPU" (`reference/nodes/simulate/erosion2.md`, verbatim). The classic `Erosion` node becomes non-deterministic **when `Parallel Processing` is enabled**; the fix is to disable that toggle, which costs speed — there is no separate `Deterministic` parameter in the published docs.

### 3.3 The Graph vs. Build split

Gaea separates the *authoring* surface from the *production* surface much more cleanly than WM:

- **Graph** = live, low-resolution, always-on preview, plus a Data Editor viewport.
- **Build Options** = a dedicated multi-tab dialog (`source/ui/interface/build-options/`):
  - **Resolution tab** — `Region` (whole terrain or a named sub-region), `Resolution` (2K/4K/…), **`Subdivision`** = None / Faster / Balanced / Slower (an explicit *speed vs. quality* dial), `Output` = Single Image / Tiled Images, `Tile Size`, `Blending`.
  - **Build tab** — `Build Destination`, "maintain a static folder with the latest copy", "open folder after build finishes", "copy the `.terrain` file to the build folder", "remove primary port name in build output", **`File Overwrite Mode` = Overwrite / Increment**, plus **path tokens**.
  - **Tiles tab** — `Tile Suffix Pattern` (e.g. `_y%Y%_x%X%`), leading zeroes, start-from-1, folder organisation (e.g. one folder per node), flip-Y, preserve cache, **`Overlap Pixels`**.
  - **Terrain tab** — the **Terrain Definition**: `Width` (m), `Height` (max terrain height, m), and two *derived read-outs*: **`Real Scale`** (metres per pixel at the active build resolution) and **`Height-Scale Ratio`**. Nodes like `Erosion` then read the real scale to size their physics correctly (`Real Scale` option).
  - Also: Nodes, Regions, Profiles, Commands, Script tabs — batch profiles, CLI automation, and a headless **Build Swarm**.
- **Baking / Gates.** A `Gate` node marks the end of a chain you consider static. `Bake → Bake Required Nodes` bakes every Gate at once; `Bake → Unbake All` reverses it. "When baked caches are loaded, Gaea keeps only the 'linchpin' baked nodes required by any unbaked downstream work — older ancestors can be unloaded." This is a friendlier version of WM's Checkpoint + memory-conservation mode, because the *unit of caching is a node the user placed deliberately*.
- **Regions** — build one part of the terrain at higher resolution without rebuilding the world.
- **Modifier Stack** — the biggest graph-hygiene win. "The Modifier Stack provides quick access to common adjustments, masks, and modifications that you may wish to apply to a node. Traditionally, node-based software would require you to create an additional node for each such adjustment — often resulting in complicated graphs that are difficult to manage." Modifiers are a **post-process**, so changing one does not rebuild the node, and "the memory cost of 6 modifiers is the same as 1 modifier, however the cost of 6 nodes of the same types would create 6 times the overhead." Available modifiers include Height Remap, Autolevel, Equalize, Shaper (±), Drop (remove empty space under the terrain), Warp, Min, Max, **Mask by Height**, **Mask by Slope**. A `DataExtractor` node can pull the generated Mask-by-Height/Slope mask out as a separate output.

### 3.4 Texturing and SatMaps

> "Our library of **over 1400 color maps, derived from real satellite data**, helps you colorize your terrains quickly without sacrificing realism." (`using/using-gaea/colorizing-and-textures/working-with-satmaps.md`)

A SatMap is a CLUT (colour lookup table) indexed by a mask. The whole texturing idiom is:

```
Terrain ──> TextureBase / Texturizer  ──(mask)──> SatMap ──> Mixer ──> ColorErosion ──> Export
                                                      ^
                                        1400 preset gradients
```

SatMap editing controls: `Bias` (push application toward the left or right of the gradient), `Clip` (use only a segment of the gradient), `Roughness` (scatter the colour-map pixels to add chaos/distortion), and H/S/L. In Gaea 2's Mixer 3.0, colour generators (SatMaps, Synth, …) are available **inside Mixer itself**, which "reduces the number of nodes you need to manage."

Gaea's own doc pushes back on the naive flow-map texture, and the warning is worth repeating to our users:

> "In digital terrains, inexperienced artists will often try to use the Flow output too prominently for texturing. While this may work in some situations, it tends to create unrealistic textures and can make your terrain look fake and 'CG'."

and

> "**Erosion should be the last step**… This technique is based on technological limitations from over a decade ago. That former paradigm trained artists (incorrectly)… You can use Texture to create the base for any procedural color map. Flow, Soil, RockMap, Occlusion, and other Data Maps can generate texture-friendly data without actually processing the terrain."

### 3.5 Gaea's beginner-friendliness features, enumerated

| Feature | What it does | Why it lowers the barrier |
|---|---|---|
| Named landform primitives (`Mountain`, `Canyon`, `Island`, `Volcano`, `DuneSea`, `MountainRange`) | One node = a recognisable landform | You get something that looks like terrain in **one node**, not six |
| `EasyErosion`, `Wizard`, `Wizard2` | "A lightweight wrapper for the Erosion node. It simplifies the settings through curated presets, and provides secondary passes" | Three sliders instead of fifteen |
| **Presets on every node** | Save current settings as a named preset; "Make these the default settings for this type of node"; presets appear in search prefixed with `_` | Shipped presets are a curriculum |
| **Predictive search / toolbox** | "Gaea keeps track of the nodes you use, and how different nodes are connected… It then predicts the type of node you might want to create and puts that first in the list." Drag out of the `Flow` port and it suggests `Autolevel` because that's what you always do. Claim: "reduce your graph creation times by 50%" | Teaches idiom by suggestion |
| **Modifier Stack** | See §3.3 | Graph stays 8 nodes instead of 40 |
| **`Mask` node** | Mask an effect *after* it was created | Removes the "you must plan your mask before you place the node" trap |
| **Portals** | Wormhole connections; any output port becomes a portal; `P` opens the portal menu; `Shift` while converting inserts a Chokepoint first | Big graphs stay readable |
| **Lock Preview (`F`)** and **Underlay (`G`)** | Lock the viewport to a node; separately mark which heightfield is the 3D "structure" under a colour map, with `Exclude from Underlay` for intermediate nodes | Removes "why is my colour map floating on the wrong terrain" |
| **Toolbox with three density layouts + colour-coded families + per-family icons** | Expanded / Compact / Toolbar | Visual grouping instead of a flat menu of 183 names |
| **Real Scale / Terrain Definition readout** | metres-per-pixel shown live | Makes "feature size in metres" meaningful instead of a magic number |
| `Autolevel`, `Heal`, `BlobRemover`, `Denoise` | One-click data repair | Fixes imported garbage without teaching signal processing |
| **Mutations** | Rapid variation system | "Give me five more like this" |

**Where Gaea is weaker** (from the polycount/CG Boost/World Machine forum discussions, §4.5): documentation quality has historically been criticised ("poor documentation makes it difficult to learn"), the vector/shape authoring is far behind WM's Layout system, and WM users cite WM's "number of very simple, basic devices" plus the ability to "decompose the more complex data types" as its structural advantage.

---

## 4. What beginners actually struggle with in World Machine

Concrete, named confusions — each with its source.

### 4.1 "Why does my build look different from the preview?"
The preview runs at 64–128 px; the build runs at 513–8192 px. Erosion, thermal weathering, blur and expander are all **resolution-dependent**, so the preview is not a small picture of the build — it is a *different terrain*. Blur and Expander have an explicit `Scale-independant` checkbox precisely because of this, and it is **off by default** in the WM2-era docs. Gaea markets its fix for this as a headline feature ("you no longer need to guess the output type").
*Sources:* [Program Configuration](https://help.world-machine.com/topic/program-configuration/), [Terrain Views](https://help.world-machine.com/topic/terrain-views/), WM2 devref (Blur/Expander).

### 4.2 The red "!" — "my terrain looks broken when I fly around"
Layout and Explorer View draw terrain outside the render extents where simulation devices have no neighbouring data. WM marks the offending devices with a red exclamation point and the manual says only that "the severity of the problem depends upon the device and zoom level." A beginner reads this as *the tool is buggy*.
*Source:* [4. Terrain Views](https://help.world-machine.com/topic/terrain-views/).

### 4.3 Tiled builds silently change simulation results
"Some devices, including the simulation-based devices such as Erosion and Snow, can produce different results in tiled mode versus normal builds." The fix is a `Blending Percentage` slider whose correct value is "in general, terrains with light erosion can use very little blending, while terrains that have huge amounts of variance across tiles will need more". Three devices are documented as flatly not working in tiled builds: **Create Water**, **Select Wetness**, **Flow Restructure**.
*Sources:* [Pro Edition Addendum](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/), [device-create-water](https://help.world-machine.com/topic/device-create-water/), [device-select-wetness](https://help.world-machine.com/topic/device-select-wetness/), [device-flowrestructure](https://help.world-machine.com/topic/device-flowrestructure/).

### 4.4 "Pocket lakes" / the terrain doesn't drain
Create Water fills **every** depression, so a raw fractal terrain produces hundreds of tiny lakes. The documented fix is to insert a Flow Restructure device "directly in front of the Create Water device" — an invisible prerequisite that the beginner has no way to guess. The docs literally title the section "Common Issues → Pocket Lakes".
*Source:* [Create Water](https://help.world-machine.com/topic/device-create-water/).

### 4.5 The node graph itself
- *"World Machine can be challenging to learn for beginners, particularly those who are not familiar with node-based systems or terrain generation concepts."*
- *"Terrain artists generally prefer to work in Gaea because of the speed and more streamlined UI but do fall back to world machine for some tasks."*
- On World Creator, the beginner default: *"the most user-friendly option available… the most intuitive of the terrain creator softwares to jump into."*
- On World Machine support: *"Devs are non-responsive."*
*Sources:* [polycount: Gaea vs World Machine vs World Creator vs Instant Terra](https://polycount.com/discussion/228295/gaea-vs-world-machine-vs-world-creator-vs-instant-terra), [VionixStudio comparison](https://vionixstudio.com/2021/05/01/world-creator-vs-world-machine-vs-gaea/), [World Machine forum: Gaea 2 vs WorldMachine](https://forum.world-machine.com/t/gaea-2-vs-worldmachine/7183).

### 4.6 Texturing is a network, not a button
The canonical stock workflow is: place Selector devices for slope/height/convexity → wire them to Color Generators → cascade Choosers → Bitmap Output. Beginners routinely get a single flat colour or a muddy blend because they do not know the Chooser `Mix order` / `Method` semantics or that the erosion masks exist. The community response has been a long tail of third-party "Colorizer" macros ([HYLK Colouriser](https://www.world-machine.com/library/index.php?entry=109), [bysGamerYT's Colorizer](https://www.world-machine.com/library/), [polycount: advanced coloring macro](https://polycount.com/discussion/111551/world-machine-advanced-coloring-macro)), and eventually a first-party **Quick Texture** macro built on `Select Wetness`.
*Sources:* [7. Bitmaps and Textures](https://help.world-machine.com/topic/bitmaps-and-textures/), [Select Wetness](https://help.world-machine.com/topic/device-select-wetness/).

### 4.7 Getting from a pretty picture to an engine splatmap
A real support thread: a user with a good-looking Quick Texture output could not turn it into an Unreal splatmap, because the macro's internal selection masks are not exposed. The official answer was to **open the macro, restructure its internals** (Height Splitter → 3 bands + the erosion mask as a 4th channel → Texture Weightmap → packed RGBA), and additionally, on build 4020, to route the alpha channel separately because the RGB+A datatype didn't exist until Artist Point.
*Source:* [forum.world-machine.com/t/…/6536](https://forum.world-machine.com/t/is-there-a-way-to-convert-the-quick-texture-macro-to-a-splat-map/6536).
**Lesson for us: any "one-click look" feature MUST also emit its intermediate masks as first-class outputs.**

### 4.8 Feature renames and vanished UI
"Where did the Layout Generator go?" is an official FAQ entry, because Artist Point renamed it to **Shapes** *and* deleted the "Attach Layout as Mask" / "Attach Layout as Height Adjustment" quick-add buttons, *and* moved render-extent editing from Layout View to Explorer View.
*Source:* [Where did the Layout Generator go?](https://help.world-machine.com/topic/where-did-the-layout-generator-go/).

### 4.9 The global elevation scale is a one-way door
Changing the project max elevation "will instantly increase the apparent vertical relief of every terrain in the world", and the manual advises setting it **once at the start of the project**. Beginners inevitably discover this after an hour of tuning.
*Source:* [3. Render Extents and Project Setup](https://help.world-machine.com/topic/render-extents-and-project-setup/).

### 4.10 Invisible prerequisites and half-documented features
- `Normalize Input` on the Clamp device: "will cause problems in Explorer as well as when the terrain is panned or zoomed."
- `Use Stabilized Noise` on Perlin: unchecking it "will interfere with panning or scaling of the terrain."
- Equalizer only works correctly in Explorer if you press **Capture sample** first.
- Chooser's *Height Matching* method: "This section is still under construction!" — in the shipped documentation.
- `Erosion` "is one of the slowest devices in World Machine to process… limit the use of Erosion to only a few places in your network."
- Spatial parameters have an explicit "Watch Out!" section: spatially varying an *XY-space* parameter (a feature scale, width, or direction) "disintegrates into a chaotic pattern" far from the device origin, because each pixel is evaluated with no knowledge of its neighbours.

### 4.11 Parameter overload — acknowledged by the vendor
The River device's own documentation opens the parameter list with: *"That's quite a list of parameters! Luckily, many of them only apply to certain situations; you'll find yourself consistently adjusting only a handful."* The Erosion device: *"There are a large number of parameters… each parameter can interact with the others… it is well worth your time to experiment either with your own settings or using one of the presets."* "Experiment" appears as the recommended learning strategy for at least five devices (Voronoi styles, multiscale Type, Simple Transform, Erosion, Strata).

---

## 5. What "easier for beginners" should concretely mean

Twenty features, ordered by (impact ÷ cost). Each maps to a specific failure in §4.

| # | Feature | Spec | Fixes |
|---|---|---|---|
| 1 | **Start from a template, not an empty graph** | The new-project dialog offers ~8 finished worlds ("Alpine ridge", "Desert mesa", "Rolling hills", "Coastal islands", "BAR 16×16 4-player") that already build and already export. Never show an empty canvas. | §4.5 |
| 2 | **Landform primitives, not noise primitives** | Ship `Mountain`, `MountainRange`, `Canyon`, `Island`, `Plateau`, `Dunes`, `Crater` as single nodes (Gaea's model). Keep `Perlin`/`Voronoi` for experts. | §4.5 |
| 3 | **Honest preview: resolution-independent simulation** | Every simulation parameter is specified in **metres**, resolved against metres-per-pixel. A 512² preview must be visually the same terrain as a 4096² build. If a node cannot be made resolution-independent, badge it in the UI with what will change. | §4.1 |
| 4 | **One-click "make it look good" texturing** | A `Texture` node that internally does wetness + slope + curvature + height, mapped through a large library of satellite-derived gradients (Gaea's SatMap model), with **Style** as a dropdown and 3 sliders. **It must also expose its internal masks as extra output ports** so the user can graduate from it rather than having to gut it (§4.7). | §4.6, §4.7 |
| 5 | **Presets everywhere, and a preset *is* a node** | Every node ships curated presets; users can save their own and set defaults per node type; presets appear in the add-node search alongside nodes. Implement as WM's Bank Selector semantics (one dropdown drives N hidden parameters). | §4.11 |
| 6 | **Parameter ranges that cannot produce garbage** | Slider min/max = the artistically useful range, not the mathematically legal one. Extreme values live behind an "Advanced" disclosure. This is World Machine's own guideline #4 and it does not follow it in its first-party devices. | §4.11 |
| 7 | **Progressive disclosure: Basic / Advanced / Expert per node** | Default to ≤5 parameters (WM's own 4–7 chunk argument). Everything else collapses. `Erosion` shows Duration, Rock Softness, Sediment, Scale, and a Preset dropdown; the other twelve hide. | §4.11 |
| 8 | **Inline explanation, not tooltips** | Each parameter carries one sentence in **artist terms** ("higher = deeper gullies, more sediment in the valleys"), plus a before/after thumbnail strip on hover. Gaea's docs do this with images; put it in the app. | §4.11 |
| 9 | **Auto-fix / lint the graph** | Detect and offer one-click fixes for known traps: "Create Water without Flow Restructure → add one?" (§4.4); "Erosion after Meshify"; "mask input left unconnected"; "output not wired". Present as a non-blocking inspector panel with *Fix* buttons. | §4.4 |
| 10 | **Modifier stack on every node** | Autolevel / Height-remap / Warp / Mask-by-height / Mask-by-slope / Min / Max / Blur as *post-process modifiers* on a node, not as new nodes. Keeps a beginner's graph under ten boxes. Gaea's memory argument applies too: 6 modifiers cost the same as 1. | §4.5 |
| 11 | **A non-node Simple Mode** | A form-based UI over a fixed pipeline: *Base shape → Ridges → Erosion → Water → Texture*, each a card with 3–4 sliders and a live 3D view. **"Show me the graph" converts it into the real node graph at any time and never converts back.** This is the single highest-leverage item and nobody in this market has it. | §4.5 |
| 12 | **Brush/sculpt mode alongside the graph** | A `Sculpt` node holding a raster delta layer, editable with raise/lower/smooth/flatten/noise brushes over the live 3D view, composited into the graph at its position. Non-destructive: the procedural upstream can still change under it. (World Machine has no sculpt at all; its Shapes vector tool is the nearest thing, and World Creator's real-time sculpt is the reason beginners pick it.) | §4.5 |
| 13 | **Vector layout tool, but with beginner defaults** | Copy World Machine's Layout/Shapes wholesale (§2.2) — it is the best-in-class feature — but default `Use Breakup` **on**, default falloff to S-curve, and ship road/river/plateau/ramp shape presets. | — |
| 14 | **Real undo/redo everywhere, including inside sub-editors** | Including while dragging vertices in the shape editor (a thing WM only fixed in Hurricane Ridge), and an always-on autosave with crash recovery. | — |
| 15 | **A:B compare as a first-class verb** | Keyboard toggle to wipe/split between a node's input and output, and between two named snapshots. WM has this now; most beginners never find it because it is a viewport mode rather than a verb. | §4.1 |
| 16 | **Named snapshots in a visible history rail** | "the version before I redid the canyon" is one click, not forty undos. Show it as a strip of thumbnails, not a menu. | — |
| 17 | **Units in metres, shown live** | Persistent read-out of map width (m), metres-per-pixel at the current build resolution, and max elevation (m). Every "feature size" parameter is in metres. Never ask a beginner to reason in 0..1. | §4.9 |
| 18 | **Vertical scale is changeable safely** | Do not make max-elevation a global one-way door. Store heights in metres in float32 internally and quantise only at export, so changing the ceiling rescales the *export mapping*, not the terrain. | §4.9 |
| 19 | **Guided wizards for the export target** | "Export for Beyond All Reason" asks for map size in BAR tiles, then writes the 16-bit heightmap at (mapx+1)² and the diffuse at mapx·8 px (validating that it is a multiple of 1024), and reports the byte sizes before writing. No naked format dropdown. | §4.7, §8 |
| 20 | **Slope/playability overlay in the viewport** | Copy WM's slope overlay but bind it to the *target engine's* walkable-slope and buildable-slope thresholds. For BAR this is directly actionable (unit pathing, build placement) and turns aesthetics into a checkable requirement. | — |

**Two anti-features to avoid, learned from World Machine:**
- Don't let a device's semantics depend on invisible global state (`Use Global Water Level`, project elevation scale, preview vs. build resolution) without surfacing it at the device.
- Don't ship a "magic" macro whose internals are the only way to get at its masks (§4.7).

---

## 6. Erosion in depth

### 6.1 World Machine `Erosion` — parameters in artist terms

Source: [Erosion (Legacy)](https://help.world-machine.com/topic/device-erosion/) and the [WM2 device reference](https://web.archive.org/web/20100822145020/http://www.world-machine.com/learn.php?page=devref).

**Basic group**

| Parameter | Official wording | What it means to an artist |
|---|---|---|
| **Erosion Duration** (WM2: *Erosion Base Duration*) | "The amount of time to simulate erosion occurring. Higher values will take proportionally longer to process; for good performance use the smallest value that still produces acceptable results." | The single "how eroded is it" dial. Cost is **linear** in this. |
| **Rock hardness** | "How strongly the bedrock resists erosion. Higher values will cause erosion to have less effect overall, **but will carve deeper/steeper gullies** into the terrain." | Non-monotonic and therefore the #1 confusing parameter: harder rock = *less* total erosion but *sharper* channels. |
| **Sediment carry amount** | "The water's capacity to carry sediment away. Higher values will cause more erosion **and also deposit more sediment into valley bottoms**." | Controls how much soft material piles up in the valleys. High = soft, filled-in valleys. |
| **Filter type** | `No Filter` — "rough, sharp feel"; `Simple Filter` — "more rounded and diffuse, looking more like soil mantled hillslopes"; `Inverse Filter` — "steepens the carved features… better suited to ice-carved climates". | The climate dial: dry/arid, wet/soil-mantled, or glacial. |
| **Filter strength** | How strongly to apply the chosen filter. | |

**Geological-time Enhancement (GTE)** — "dramatically increases the extent of the erosion effect without running the simulation for excessively long time periods. With geological enhancement, mountains can be reduced to rubble without waiting an eternity."

| Parameter | Meaning |
|---|---|
| **Erosion-time intensifier** | "The lowest setting will produce identical results to non-enhanced erosion; as the value increases the erosion effect is **exponentially strengthened**." |
| **Reconstruction type** | `Faster (Linear Ridges)` — sharp features, **axis-aligned artifacts**; `Better (Smooth Ridges)` (default) — blends ancient and recent features, far fewer directional artifacts, slower. |
| **Uplift** | Geological uplift applied during geological time. Alone it just raises the terrain uniformly; **with a mask or water-channel input it is what keeps rivers pinned at the valley floor while the mountains rise around them.** *GTE only.* |
| **Mask Output Structure** | How detailed vs. smooth the three erosion masks are: "Low values are grainy and only small-scale, while large values average across the entire terrain." *GTE only.* |

**Channeled Erosion group** — `Erosion type` = `Standard Erosion` ("weathered features without deep gullies") vs. `Channeled Erosion` ("deepens and carves additional gullies"); `Channel depth`; `Post-channeling erosion` ("specify a percentage of the total erosion to perform after the channeling action is done. This can make the result look more natural.").

**Compatibility group** — `Preserve map borders` (erosion won't touch edge terrain; interacts with Uplift so the edges stay put while everything else rises); `Hardness doesn't affect channel depth` (the WM 2 default).

**Ports**

- *Inputs*: primary; **`Hardness Mask`** (heightfield — 1.0 = the current rock-hardness setting, 0.0 = the lowest hardness); **`Water Channel Input`** (heightfield **or the Water datatype** — those areas are not eroded and act as infinite sediment sinks, so "areas near water will erode faster as sediment does not build up and reduce the gradient of the terrain").
- *Outputs*: primary, plus the three texturing masks:
  - **Flow mask** — "areas where water flow has occurred"
  - **Wear mask** — "areas where bedrock has been eroded"
  - **Deposition mask** — "areas where sediment has been deposited onto the terrain"

> "Erosion is also useful for texturing your terrain. By using the masks indicating areas of wear, deposition, and flow, you can create much more interesting terrain textures than a typical height and slope distribution."

**Performance / caveats** (verbatim): "Erosion is one of the slowest devices in World Machine to process. It is particularly expensive in large world sizes and when water might travel across the entire map. Use the smallest erosion duration that produces an acceptable result, and limit the use of Erosion to only a few places in your network." Hurricane Ridge rewrote this for "up to 100 times faster at high resolutions", added **Feature Size control** ("directly control the maximum affected feature size"), **Soil control** ("model the landform evolution of soil from an initial distribution"), spatial parameters on *every* parameter, and — importantly — **repeatable output between builds** ("eliminating a common frustration").

### 6.2 World Machine `Thermal Erosion` (Thermal Weathering)

Source: [Thermal Erosion](https://help.world-machine.com/topic/device-thermalerosion/).

Physical model, verbatim: "Boulders and chunks of rock that fracture from the cliff face accumulate to a constant **angle of repose**, where any additional material slides down the talus slope to the base of the hill."

| Parameter | Meaning |
|---|---|
| **Talus Production** | Propensity of the rock face to break down. Modulated by the `Talus Production Mask` input. |
| **Talus Repose Angle** | "The angle at which material comes to rest. In real life, this angle is typically around a **30–40 degree slope**. Lower values look more like sand or soil." |
| **Fracture Size** | Bedrock tends to fracture in chunks around this size. "The effect is relatively subtle." |
| **Talus Size** | Size of the talus boulders; **embeds a rough talus-like pattern into the heightfield** wherever talus exists. `0 m` disables. |
| **Simulation Length** | Duration. "Larger values take proportionally longer… but will allow talus to fall farther and occupy more of the map." |
| **Intensity** | Multiplier on rock fracture. "Typically leave this value alone." |

*Inputs*: primary, `Talus Production Mask`, **`Talus Removal Mask`** (a heightfield or water map designating areas that clear talus away and keep their original geometry — used to apply talus after rivers exist, or to keep roads/build pads clear).
*Outputs*: primary, **`Talus Mask`** (where talus is), **`Talus Depth`** ("Subtracting this from the primary output provides the actual post-erosion bedrock surface" — i.e. you can separate bedrock from regolith).

WM2's older Thermal Erosion had a different, simpler parameterisation worth knowing because the concepts are cleaner: `Iterations`, `Style` = *Classic* (one critical slope: steeper erodes, shallower stops) vs. *Two-phase* (talus tracked separately from uneaten rock, with its own critical slope), `Strength`, **`Mass Balance`** ("controls whether terrain material is only removed (left), only added (right), or both (middle)"), `Rock Angle` (above which rock erodes), `Talus Angle` (below which talus stops sliding). **Mass Balance returned in Hurricane Ridge**, along with a "mass-movement-only mode" that treats the entire input as granular material.

### 6.3 Gaea's erosion parameter vocabulary

`Erosion`: **`Strength`**, **`Rock Softness`** (note: *softness*, the inverse of WM's hardness), **`Downcutting`**, **`Inhibition`**, **`Feature Scale`** (metres — "the width of largest valleys and ridges between them"; default 2000 m), **`Real Scale`** (derive physics from the Terrain Definition — recommended on), **`Sediment Removal`** (can itself be driven by a mask), `Seed`, `Parallel Processing`. (An earlier draft listed a separate `Deterministic` toggle; `reference/nodes/simulate/erosion.md` describes only `Parallel Processing` — *"To ensure fully deterministic processing, disable Parallel Processing. This will sacrifice processing speed to ensure your results are consistent."*)

The doc's own explanation of the Strength/Softness interaction is the clearest artist-facing statement of the hydraulic model anywhere and is worth paraphrasing in our UI:

> "Lesser strength means dissolved soil will be dropped earlier because of lower water transport capacity, and lesser softness means that the rock will be eroded slower but dissolved sediment will be dropped farther. This results in different distribution of deposits, gullies, and shapes of erosion features."

and on Downcutting/Inhibition:

> "`Downcutting` effectively transports sediment far away from its origin. If shorter transport distance is desired… set this parameter to `0.0`, or set `Inhibition` to higher values."

Outputs: **Wear** ("the portions where erosion removes sediments"), **Deposits** ("the resting position of those sediments"), **Flow** ("the path of the sediments from their original location to the final resting position"). The doc warns these "may not be readily visible to the human eye" and to Autolevel/Equalize before using them — **so our equivalent should auto-normalise mask outputs by default.**

### 6.4 Houdini's `HeightField Erode` — a third parameter vocabulary

Source: [sidefx.com/docs/houdini/nodes/sop/heightfield_erode.html](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode.html). Useful because it splits hydraulic and thermal into one node with clearly separated sections.

- **Solver**: `Erosion Feature Size` (metres — channel width), `Spread Iterations` (material transport iterations per frame), `Random Seed`, `Erodability` (maskable).
- **Hydro**: `Flow Force`, `Bank Angle`, `Rainfall Coverage`, `Slope Influence`, `Erosion Rate`, `Deposition Rate`, `Removal Rate`, `Evaporation Rate`.
- **Thermal**: `Weathering Force`, `Cut Angle`, `Repose Angle`.
- **Output layers**: `height`, `sediment` (hydro deposits), `debris` (thermal deposits), `flow` (eroded material flow), `flowdir` (average flow direction — a **vector** field, which neither WM nor Gaea exposes directly and which is genuinely useful for anisotropic texturing).

### 6.5 Recommended erosion API for Terrasmith

```text
Erode(heightfield, params) ->
    height        : float32[]   // eroded surface
    flow          : float32[]   // accumulated water discharge      (auto-normalised)
    wear          : float32[]   // cumulative bedrock removed       (auto-normalised)
    deposition    : float32[]   // cumulative sediment deposited    (auto-normalised)
    flowdir       : float2[]    // mean flow direction (Houdini-style; optional)

params:
    duration_yr      : float   // "how eroded"                      [slider: 0..1 mapped to a sane range]
    rock_hardness    : float   // resistance                        [explain: harder = less total, sharper gullies]
    sediment_capacity: float   // valley fill
    feature_size_m   : float   // METRES, resolved against m/px     <- makes preview == build
    style            : enum    // Arid | SoilMantled | Glacial       (= WM's Filter type)
    uplift_m         : float   // keeps rivers pinned during long erosion
    seed             : uint
    deterministic    : bool    // default TRUE for beginners
inputs (all optional, all spatial):
    hardness_mask, precipitation_mask, water_channels, erodability_mask
```

Design rules extracted from all three tools:
1. **Parameterise in metres, not pixels** — the only way preview can equal build (§4.1, Gaea's headline claim).
2. **Default to deterministic**, offer parallel/non-deterministic as a speed option — inverse of Gaea's default.
3. **Auto-normalise the three mask outputs**; raw accumulation buffers are unusable to a beginner.
4. **Separate bedrock from regolith**: return talus/sediment *depth* as well as a mask (WM's `Talus Depth` trick) so texturing can distinguish exposed rock from loose material.
5. **Ship presets**, because every vendor's own documentation tells the user to start from one.

---

## 7. Texturing and output — and the path to a BAR diffuse

### 7.1 How the two tools get from geometry to colour

**World Machine (classic, all versions):**

```
Terrain ─┬─> Slope Selector    ─┐
         ├─> Height Selector   ─┼─> Chooser / Chooser / Chooser (cascade)  ─> Bitmap Output
         ├─> Convexity Selector ┘        ^        ^        ^
         └─> Erosion ──> flow/wear/deposition masks  |        |
                                  Color Generator ───┴────────┘
```

**World Machine (modern, Artist Point+):** `Material` primitives instead of `Color Generator`; a single **`Layers`** device instead of the Chooser cascade, with heightblend operations; `Colorizer` (a gradient/CLUT device) driven by any mask; `Select Wetness` as the star selector; `Texture Weightmap` to pack a sum-to-one splatmap; `Scene View` to see it on the terrain; `Scene Output` to ship terrain+water+material as one glTF.

**Gaea:** `TextureBase`/`Texturizer` → `SatMap` (1400 satellite CLUTs) → `Mixer` → `ColorErosion` → `Export`. Plus `Curvature`, `Peaks`, `Soil`, `RockMap`, `Occlusion`, `FlowMap` as data maps.

**The transferable idea:** a *colour map* is always `CLUT(mask)`, layered. The interesting engineering is in the **masks**, not the colours. Both tools converged on: height, slope, aspect, curvature/convexity, flow, wear, deposition, talus, wetness, AO/occlusion.

### 7.2 What BAR/Recoil actually needs

Recoil's SMF map format (`rts/Map/SMF/SMFFormat.h` in [beyond-all-reason/RecoilEngine](https://github.com/beyond-all-reason/RecoilEngine)) does **not** consume a PNG diffuse directly. The map compiler (e.g. [Beherith/springrts_smf_compiler](https://github.com/Beherith/springrts_smf_compiler) `pymapconv`, CC0-1.0) takes a single large RGB(A) diffuse image and cuts it into **32×32 DXT1 tiles with 4 mip levels**, deduplicating identical tiles into a `.smt` file and writing an index array into the `.smf`.

Header, verbatim from `rts/Map/SMF/SMFFormat.h` (**lines 49–70** on `master`, verified 2026-09-13 — an earlier draft said 50–71):

```c
struct SMFHeader {
    char  magic[16];      // "spring map file\0"        offset  0, 16 bytes
    int   version;        // Must be 1 for now          offset 16
    int   mapid;          // random GUID                offset 20
    int   mapx;           // Must be divisible by 128   offset 24
    int   mapy;           // Must be divisible by 128   offset 28
    int   squareSize;     // must be 8                  offset 32
    int   texelPerSquare; // must be 8 for now          offset 36
    int   tilesize;       // texels in a tile, must be 32 offset 40
    float minHeight;      // height that 0x0000 means   offset 44
    float maxHeight;      // height that 0xffff means   offset 48
    int   heightmapPtr;   // -> short int[(mapy+1)*(mapx+1)]        offset 52
    int   typeMapPtr;     // -> unsigned char[mapy/2 * mapx/2]      offset 56
    int   tilesPtr;       // -> MapTileHeader                       offset 60
    int   minimapPtr;     // -> 1024*1024 DXT1 + 8 mip sublevels    offset 64
    int   metalmapPtr;    // -> unsigned char[mapx/2 * mapy/2]      offset 68
    int   featurePtr;     // -> MapFeatureHeader                    offset 72
    int   numExtraHeaders;//                                        offset 76
};                        // sizeof == 80 bytes, then ExtraHeaders
```

(Offsets are byte offsets computed from the declaration order with `int`/`float` = 4 bytes, no padding — every field is naturally 4-byte aligned after the 16-byte magic.)

```c
static constexpr size_t SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6); // == 680
static constexpr size_t MINIMAP_NUM_MIPMAP = 9;
static constexpr size_t MINIMAP_SIZE = 699048;

struct MapTileHeader { int numTileFiles; int numTiles; };
// followed by numTileFiles × { int numTilesInThisFile; char smtFilename[] /* NUL-terminated */ }
// then int[ mapx*texelPerSquare/tileSize * mapy*texelPerSquare/tileSize ]
//    == int[ mapx/4 * mapy/4 ]  with texelPerSquare=8, tileSize=32

struct TileFileHeader {   // .smt
    char magic[16];       // "spring tilefile\0"
    int  version;         // 1
    int  numTiles;
    int  tileSize;        // 32
    int  compressionType; // 1 == DXT1
};                        // followed by numTiles × SMALL_TILE_SIZE raw bytes
```

`rts/Map/SMF/SMFReadMap.h:181-182` and `SMFReadMap.cpp:120-129` (inside `CSMFReadMap::ParseHeader`) confirm the derived geometry. `SQUARE_SIZE = 8` is `static constexpr int` in `rts/Sim/Misc/GlobalConstants.h:24`:

```cpp
static constexpr int tileScale     = 4;              // SMFReadMap.h:181
static constexpr int bigSquareSize = 32 * tileScale; // SMFReadMap.h:182  == 128
...
numBigTexX   = header.mapx / bigSquareSize;   // SMFReadMap.cpp:120
bigTexSize   = SQUARE_SIZE * bigSquareSize;   //             :122  == 8*128 == 1024
tileMapSizeX = header.mapx / tileScale;       //             :123
tileCount    = (header.mapx * header.mapy) / (tileScale * tileScale); // :125
mapSizeX     = header.mapx * SQUARE_SIZE;     //             :126
heightMapSizeX = header.mapx + 1;             //             :129
```

And `pymapconv/src/pymapconv.py` derives everything from the **texture** you hand it:

```python
mapx      = texw // 8      # pymapconv.py:442
springmapx = texw // 512   # pymapconv.py:444   (map size in BAR "tiles")
expectedheightmapsize = (mapx + 1) * (mapy + 1) * 2   # :530
if pngheight[0] == mapx * 8 and pngheight[1] == mapy * 8: ...  # :553 (hi-res heightmap path)
```

**Texture dimension constraint (corrected).** pymapconv does *not* accept any multiple of 512; `pymapconv.py:446` rejects the texture unless **both dimensions are multiples of 1024**:

```python
if (texh % 1024 != 0) or (texw % 1024 != 0):
    print_flushed('Error: Texture Image dimensions are not multiples of 1024! ...')
    return -1      # pymapconv.py:446-448
```

So `springmapx = texw // 512` must be **even**. A "15×15" BAR map is not compilable by this tool; sizes are effectively 2, 4, 6, … BAR tiles per side. BAR's own [map checklist](https://www.beyondallreason.info/guide/map-checklist) additionally states: *"Maps larger than 32x32 or 32 in any dimension will not be accepted."*

#### 7.2.1 Exact on-disk layout of a pymapconv-written `.smf`

This is the byte order a writer must reproduce. Verified against `pymapconv.py:1024-1077` (`master`, 2026-09-13). **Everything is little-endian**; the header struct is declared as
`SMFHeader_struct = struct.Struct('< 16s i i i i i i i f f i i i i i i i')` (`pymapconv.py:38`) — 16 + 16×4 = **80 bytes**, no padding, matching the C struct exactly.

| # | Chunk | Size (bytes) | Notes |
|---|---|---|---|
| 1 | `SMFHeader` | 80 | `numExtraHeaders = 1` |
| 2 | `ExtraHeader` | **12** | `{ int size = 12; int type = 1 /* MEH_Vegetation */; int vegmapPtr; }` — the third int is **undocumented in `SMFFormat.h`**; pymapconv's own comment says *"MISSING FROM DOCS, only exists if type=1 (vegmap)"* (`pymapconv.py:60-63`). |
| 3 | vegetation map | `mapx*mapy/16` = `(mapx/4)*(mapy/4)` | `unsigned char`, 0 = none, 1 = grass (`SMFFormat.h:96-103`) |
| 4 | heightmap | `(mapx+1)*(mapy+1)*2` | `uint16` **little-endian**, row-major (`struct.pack('<H', h)`, `pymapconv.py:1054`) |
| 5 | typemap | `(mapx/2)*(mapy/2)` | `unsigned char` |
| 6 | minimap | `MINIMAP_SIZE` = 699048 | DXT1, 9 mip levels 1024²→4². pymapconv truncates: `minimapdata[:MINIMAP_SIZE]`, with the comment *"dont even write more than needed, or else produced map will crash!"* |
| 7 | metalmap | `(mapx/2)*(mapy/2)` | `unsigned char` |
| 8 | `MapTileHeader` | 8 | `{ int numTileFiles; int numTiles; }` |
| 9 | per-tile-file record | `4 + len(smtFilename) + 1` | `int numTilesInThisFile`, then the NUL-terminated `.smt` **basename** (path stripped) |
| 10 | tile index array | `4 * mapx*mapy/16` | `int32` LE, `(mapx/4)*(mapy/4)` entries |
| 11 | `MapFeatureHeader` | 8 | `{ int numFeatureType; int numFeatures; }` |
| 12 | feature type names | Σ `len(name)+1` | NUL-terminated strings |
| 13 | `MapFeatureStruct[]` | `24` each | `'< i f f f f f'` |

Note the ordering trap: the **heightmap comes after the vegetation map, not immediately after the headers**, and `heightmapPtr` is computed as `80 + 12 + mapx*mapy/16`. Nothing in the engine requires this order (every chunk is reached through its pointer), but every existing BAR `.smf` has it, and the vegetation ExtraHeader is written unconditionally.

`.smt` payload: `TileFileHeader` (`'< 16s i i i i'` = **32 bytes**) followed by `numTiles × SMALL_TILE_SIZE` (680) raw bytes (`pymapconv.py:1013-1018`).

#### 7.2.2 Height reconstruction — the `65536` gotcha

The `SMFHeader` comment says `maxHeight` is *"Height value that 0xffff in the heightmap corresponds to"*. **That comment is wrong by one code value.** The engine actually computes (`SMFReadMap.cpp:144-155` → `SMFMapFile.cpp:113-135`):

```cpp
const float minHgt = mapInfo->smf.minHeightOverride ? mapInfo->smf.minHeight : header.minHeight;
const float maxHgt = mapInfo->smf.maxHeightOverride ? mapInfo->smf.maxHeight : header.maxHeight;
mapFile.ReadHeightmap(..., /*base=*/minHgt, /*mod=*/(maxHgt - minHgt) / 65536.0f);   // SMFReadMap.cpp:155
...
sHeightMap[i] = base + swabWord(word) * mod;                                          // SMFMapFile.cpp:132
```

i.e.

```
h(raw) = minHeight + raw * (maxHeight - minHeight) / 65536.0f     // raw in [0, 65535]
```

so raw `0xFFFF` reaches only `minHeight + 65535/65536 * (maxHeight - minHeight)` — it never reaches `maxHeight`. The correct **export** quantisation is therefore

```
raw = clamp( floor( (h - minHeight) * 65536.0 / (maxHeight - minHeight) ), 0, 65535 )
```

**not** `round(v * 65535)`. Using the 65535 form biases every height upward by up to one code value and puts the map's true ceiling one step below the declared `maxHeight`. (`swabWord` is a byte-swap that is a no-op on little-endian hosts, confirming the on-disk format is LE.)

Two further consequences:

- **`mapinfo.lua` can override the header.** `rts/Map/MapInfo.cpp:406-409` reads `smf.minHeight` / `smf.maxHeight`; if the key exists in `mapinfo.lua` it wins over the `.smf` header. A BAR export must write the same pair into both, or deliberately write it only into `mapinfo.lua`.
- pymapconv's CLI defaults are `--minheight -50.0` and `--maxheight 100.0` (`pymapconv.py:1372-1377`; `-x/--maxheight` default `100.0`, `-n/--minheight` default `-50.0`); both are documented as *required* in the help text. There is **no** BAR-wide convention beyond that — see §10.3.

#### 7.2.3 What the metalmap and typemap actually are

- **Metalmap** (`-m/--metalmap`): *"Metal map to use, **red channel** is amount of metal. Resized to xsize / 2 by ysize / 2."* pymapconv takes `metalimage` at `(mapx/2, mapy/2)` and bilinearly resizes if the size is wrong (`pymapconv.py:689-698`). It is a **separately authored image**, not derived from the terrain.
- **Typemap** (`-y/--typemap`): *"Type map to use, uses the **red channel** to define terrain type [0-255]. types are defined in the .smd, if this argument is skipped the entire map will TERRAINTYPE0."* Resized with **nearest neighbour** if mis-sized (`pymapconv.py:882-887`), which is correct for an index map. The engine consumes it in `CMoveMath::GetPosSpeedMod` (`rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:89-101`) to look up per-terrain-type `tankSpeed` / `kbotSpeed` / `hoverSpeed` / `shipSpeed` multipliers — so the typemap is a **gameplay** surface, not decoration.
- Both live at `(mapx/2) × (mapy/2)`, i.e. half the heightmap-square resolution, matching `mapDims.hmapx`.

#### 7.2.4 The hi-res heightmap path (pymapconv line 553)

pymapconv accepts **two** heightmap shapes, and they are not equivalent:

1. **Canonical**: a 16-bit greyscale PNG (or `.raw`/`.r16`) of exactly `(mapx+1) × (mapy+1)` samples. The `.raw` path requires the file to be exactly `(mapx+1)*(mapy+1)*2` bytes and unpacks it as `'<H'` (`pymapconv.py:530-536`). Samples map 1:1 to heightmap corners. **This is the shape to emit.**
2. **Hi-res**: a PNG of exactly `mapx*8 × mapy*8` (i.e. one sample per *diffuse texel* / per engine elmo). pymapconv pads it by 4 px on each side by edge replication, then downsamples to `(mapx+1)²` with a filter chosen by `--highresheightmapfilter`, whose options are `[lanczos, bilinear, nearest, median, histogram]` and whose **default is `nearest`** (`pymapconv.py:1436-1438`). `nearest` samples at `(col*8+4, row*8+4)` — the exact texel centres that line up with the corner grid; `median` uses a 4×4 window; `histogram` uses an 8×8 window and prefers the modal value (built for flat man-made surfaces); `lanczos`/`bilinear` go through `Image.resize`. `nearest`, `lanczos` and `bilinear` clamp output to `65534`, not `65535`.

So the pipeline does **not** prefer the hi-res form; it is an opt-in path that mainly helps authored/architectural terrain where you want height discontinuities to land exactly on texel boundaries. For procedurally generated terrain the `(mapx+1)²` form is both smaller and lossless.

#### 7.2.5 Slope thresholds, from BAR's own movedefs

Calibrating a viewport slope overlay to BAR requires two facts that are easy to get wrong.

**(a) The numbers in `movedefs.lua` are not terrain angles.** `gamedata/movedefs.lua:43-50` defines:

```lua
local SLOPE = {
    NONE = 0, MINIMUM = 27, MODERATE = 33, -- just below angle of repose
    DIFFICULT = 54, EXTREME = 75, MAXIMUM = 90,
}
```

but the engine transforms them (`rts/Sim/MoveTypes/MoveDefHandler.cpp:84-96`):

```cpp
static float DegreesToMaxSlope(float degrees) {
    const float deg = std::clamp(degrees, 0.0f, 60.0f) * 1.5f;
    const float rad = deg * degToRad;
    return (1.0f - math::cos(rad));
}
```

So the **real** terrain angle is `clamp(v, 0, 60) * 1.5` degrees:

| movedefs constant | value in lua | real terrain angle | stored `maxSlope` = `1 − cos θ` |
|---|---|---|---|
| `SLOPE.MINIMUM` | 27 | **40.5°** | 0.2396 |
| `SLOPE.MODERATE` | 33 | **49.5°** | 0.3506 |
| `SLOPE.DIFFICULT` | 54 | **81.0°** | 0.8436 |
| `SLOPE.EXTREME` | 75 | clamped → **90.0°** | 1.0 |
| `SLOPE.MAXIMUM` | 90 | clamped → **90.0°** | 1.0 |
| engine default, Tank/KBot | 60 | clamped → **90.0°** | 1.0 |
| engine default, Hover | 15 | **22.5°** | 0.0761 |

**(b) The quantity compared against it is `1 − normal.y`, at half resolution.** `rts/Map/ReadMap.cpp:755-778` builds `slopeMap` at `hmapx × hmapy` (= `mapx/2 × mapy/2`) by taking, over the 8 face normals of a 2×2 block of heightmap squares, both the average and the minimum `normal.y`, blending them (`mix(maxslope, avgslope, maxslope/avgslope)` — a deliberate smoothing "so small holes don't block huge tanks"), and storing `1.0f - slope`. So a Terrasmith slope overlay should compute `1 − n_y` on the same half-resolution grid and threshold it against the table above — **not** compute a per-pixel slope in degrees and compare to the raw lua number.

**(c) Buildability is a different test.** Buildings use `UnitDef::maxHeightDif`, derived in `rts/Sim/Units/UnitDef.cpp:422-426` as

```cpp
const float maxSlopeDeg = std::clamp(udTable.GetFloat("maxSlope", 0.0f), 0.0f, 89.0f);
maxHeightDif = 40.0f * math::tanf(maxSlopeDeg * DEG_TO_RAD);   // "FIXME: kill the magic constant"
```

and `CGameHelper::TestBuildSquare` compares `abs(wantedHeight - groundHeight) <= maxHeightDif` over the footprint (`rts/Game/GameHelper.cpp:1211, 1634`). A buildability overlay therefore needs a **height-deviation-over-footprint** metric, not a slope metric.

### 7.3 Worked size calculation — a 16×16 BAR map

Given: `springmapx = springmapy = 16` (BAR's conventional "16×16" map size).

| Quantity | Formula | Value |
|---|---|---|
| Diffuse texture width | `springmapx * 512` | **8192 px** (also ✓ a multiple of 1024, which pymapconv requires) |
| `mapx`, `mapy` | `texw / 8` | **1024**, 1024 (✓ divisible by 128) |
| World size | `mapx * SQUARE_SIZE` = `1024 * 8` | **8192 × 8192 engine units** (= 1 unit per diffuse texel) |
| Heightmap grid | `(mapx+1) × (mapy+1)` | **1025 × 1025** samples |
| Heightmap bytes | `1025 * 1025 * 2` | **2 101 250 B** (≈ 2.00 MiB) |
| Vegetation (grass) map | `unsigned char[(mapx/4) * (mapy/4)]` = 256×256 | **65 536 B** (always written by pymapconv, via the `MEH_Vegetation` ExtraHeader) |
| Typemap | `unsigned char[(mapx/2) * (mapy/2)]` = 512×512 | **262 144 B** |
| Metalmap | `unsigned char[(mapx/2) * (mapy/2)]` = 512×512 | **262 144 B** |
| Minimap | fixed `MINIMAP_SIZE` | **699 048 B** (1024² DXT1 = 524 288, then 512²…4² mips: 131 072 + 32 768 + 8 192 + 2 048 + 512 + 128 + 32 + 8) |
| Tile index array | `int[(mapx/4) * (mapy/4)]` = `int[256*256]` | 65 536 ints = **262 144 B** |
| Distinct tiles (worst case, no dedup) | `(8192/32)²` = 256² | **65 536 tiles** |
| `.smt` payload (worst case) | `65 536 * 680` | **44 564 480 B** (≈ 42.5 MiB) |
| `.smt` header | `16 + 4*4` | **32 B** |
| Uncompressed RGB source diffuse in RAM | `8192 * 8192 * 3` | **201 326 592 B** (192 MiB) — plan for this |

Sanity checks: `bigTexSize = 8 * 128 = 1024`, so the engine streams the diffuse as `numBigTexX = 1024/128 = 8` × 8 = **64 "big textures" of 1024×1024** each. `tileCount = 1024*1024/16 = 65 536` ✓ matches the worst-case tile count.

`.smf` total (worst case, no features): `80 + 12 + 65 536 + 2 101 250 + 262 144 + 699 048 + 262 144 + (8 + 4 + len(smtname)+1) + 262 144 + 8` ≈ **3.65 MiB**, plus the `.smt` at up to 42.5 MiB.

### 7.4 Consequences for our texturing pipeline

1. **Author the diffuse at exactly `springmapx * 512` px square, a multiple of 1024, 8 bits per channel, sRGB.** (pymapconv hard-rejects non-multiples of 1024 — `pymapconv.py:446` — so `springmapx` must be even.) There is no point producing 16-bit colour: DXT1 will crush it to 5:6:5 anyway.
2. **DXT1 is 4×4-block, 5:6:5 endpoints.** Smooth gradients band badly; high-frequency noise survives better than you'd expect. Practical implication: bias the texture generator toward **detail and grain** rather than large smooth colour ramps, and consider dithering the 5:6:5 quantisation.
3. **Tile deduplication rewards flat/repeated regions.** Large uniform areas (deep water, blank plateaus) collapse to a handful of tiles. A texture generator that emits genuinely unique colour per texel produces the full 42.5 MiB. That's fine, but it's a knob worth exposing ("texture variety vs. file size").
4. **The minimap is generated by downsampling the diffuse to 1024×1024** (`pymapconv.py:496-497`: `minimapimage = intex.resize((1024, 1024), Image.LANCZOS)` when no `-p/--minimap` is supplied; a supplied one is *also* resized to 1024²), then DXT1-compressed with 9 mip levels (`nvdxt.exe … -nmips 9`, or `CompressonatorCLI -fd DXT1 -miplevels 9` on Linux — `pymapconv.py:515-519`) — so whatever we produce must read well at 1024² too.
5. **BAR needs more than a diffuse.** Practical BAR maps also want a metalmap (`mapx/2 × mapy/2`, 8-bit), a typemap (terrain-type indices, same size), a minimap, and usually a specular/splat-distribution set. Our "one-click texturing" node should be able to emit **all of them from the same mask set**:
   - diffuse ← CLUT(texture-base mask), layered
   - metalmap ← a paint/scatter layer, not derived from terrain
   - typemap ← argmax over the material masks (exactly WM's `Texture Weightmap` **Material ID** output mode)
   - splat distribution ← WM's packed-RGBA weightmap mode
6. **Slope matters functionally, not just visually.** Because the engine derives pathing from the heightmap, a viewport slope overlay keyed to BAR's movedef slope limits is a genuine authoring tool (§5, item 20).

---

## 8. File formats — import/export for interop

### 8.1 What World Machine reads and writes

**File Input reads:** TER, BT, HFZ, PNG, TIFF, BMP, TGA, R32, R16, RAW. ([WM2 devref, File Input](https://web.archive.org/web/20100822145020/http://www.world-machine.com/learn.php?page=devref))

**File Output writes** (WM2 list, still the fullest enumeration):

| Group | Format | Notes (verbatim where quoted) |
|---|---|---|
| Low precision | **TGA** | "Greyscale RGB TGA" |
| | **BMP** | "Greyscale RGB BMP" |
| | **RAW** | "8bit RAW file with no header" |
| High precision | **Terragen (.ter)** | "Terragen-format output" |
| | **Leveller** | Daylon Leveller format |
| | **PNG** | "PNG 16bit per channel" |
| | **Povray-TGA** | "stores 16bits of heightfield data across the Red and Green channels of a standard TGA. The Red channel holds the upper 8 bits, the Green the lower 8." |
| | **RAW16** | "16bit RAW file, **in standard PC byte-endian format**" (= little-endian) |
| | **RAW-FP32** | "32bit Floating Point RAW. Each 4 byte data value is a single-precision floating point value" |
| | **BT** | Virtual Terrain Project Binary Terrain |
| | **PGM (ASCII)** | "Portable GreyMap. An extremely simple ASCII-based 16bit format" |
| | **TIFF** | "TIFF 16bit per channel" |
| | **HFZ** | HFZ compressed |

Bitmap Output: 8-bit BMP, 16-bit TIFF and PNG (plus an optional heightfield wired in as the 4th/alpha channel). Modern WM adds **EXR, including the RGB-packed EXR height layout that Godot expects**, and glTF/GLB scene export.

### 8.2 What Gaea reads and writes

From `source/using/advanced-topics/technical-information/file-formats.md`:

**Import bitmaps:** OpenEXR (32-bit), TIFF (32/16/8), PNG 64/16/8, RAW (Float / Half / UShort), JPG (8), Gaea RAW (32). Also `.webp`, `.svg`, `.psd`, `.hdr`, `.pfm`, `.bmp`.
**3D:** OBJ, FBX, DAE, glTF/GLB, XYZ point cloud.
**Project file:** `.terrain`.

> "Gaea stores and processes its heightfields in **32-bit floating points**."
> "Raw can be saved as `.raw`, `.r16`, and `.r32` as required as different applications use different combinations of format and extensions."
> "Game engines, such as Unity, can only import RAW 16-bit (ushort) format terrains."

**The headerless RAW contract, verbatim — this is the spec to implement:**

> "32-bit float (`.r32`) and 16-bit ushort (`.raw`) are the simplest formats you can use. It is a simple binary array of `float` (IEEE 754) or `unsigned short`. The file has no header and can be read directly as a binary stream. The files will use **Little Endian**. The size of the heightfield should be **square root of the byte length divided by the size of the type** (4 bytes for `float`, 2 bytes for `ushort`). The `.r32` format will store values between `0.0f` and `1.0f`. While the `.raw` format will store values between `0` and `65535`."

```c
// .r16 / .raw  — headerless
uint16_t data[n*n];   // little-endian, row-major, 0..65535
// n = sqrt(filesize / 2)

// .r32 — headerless
float    data[n*n];   // IEEE-754 little-endian, row-major, 0.0f..1.0f
// n = sqrt(filesize / 4)
```

**Row order is the eternal gotcha.** Nothing in the RAW contract says whether row 0 is top or bottom; every tool exposes a "Flip Y" toggle for exactly this reason (WM File Input `Flip Y-axis`, WM tiled export `Flip Y-axis orientation`, Gaea Tiles tab `Flip Y Axis`, Instant Terra, pymapconv). **Ship a flip toggle and a visible preview of which corner is the origin.**

### 8.3 Terragen `.TER` — exact byte layout

Source: [docs.planetside.co.uk/wiki/Terragen_.TER_Format](https://docs.planetside.co.uk/wiki/Terragen_.TER_Format) (also implemented by [GDAL's `terragen` driver](https://gdal.org/en/stable/drivers/raster/terragen.html)).

Chunked, **little-endian ("intel-ordered")**, 4-byte-aligned, and critically: *"chunks do not include a 'length of data' value"* — a reader must know each chunk's size from its marker.

```
offset  0 : char[8]  "TERRAGEN"
offset  8 : char[8]  "TERRAIN "          // note the trailing space
offset 16 : chunks...
   ...    : char[4]  "EOF "              // at end of file
```

| Marker | Payload | Semantics / constraints |
|---|---|---|
| `"SIZE"` | `int16 n_minus_1; int16 pad;` | **Required. Must appear before any altitude data.** Value is `n − 1`. For square terrains `n` = points per side; for non-square, `n` = points along the **shortest** side. |
| `"XPTS"` | `int16 xpts; int16 pad;` | Required only for non-square. **Must appear after SIZE and before any altitude data.** |
| `"YPTS"` | `int16 ypts; int16 pad;` | As XPTS, for the y direction. |
| `"SCAL"` | `float32 x, y, z;` | Optional. **Metres per terrain unit** on each axis. Must appear before altitude data. |
| `"CRAD"` | `float32 radius_km;` | Optional. Planet radius in kilometres. |
| `"CRVM"` | `uint32 mode;` | Optional. Terrain curvature mode. |
| `"ALTW"` | `int16 HeightScale; int16 BaseHeight; int16 Elevation[n*m];` | The altitude data. |
| `"EOF "` | — | End of file. |

**Decoding formula, verbatim:**

> "The absolute altitude of a particular point … is equal to `BaseHeight + (Elevation * HeightScale / 65536)`"

…in terrain units; multiply by `SCAL.z` for metres. Note `HeightScale` and `BaseHeight` are **signed** 16-bit.

Terragen 4.8 itself is stated to export heightfields to **TER (preserving all scaling information), EXR (32-bit float preserving absolute height in metres), TIFF (16-bit unsigned short), and RAW (16-bit unsigned short)** — **UNVERIFIED — needs confirmation** (sourced from the Planetside feature tour, not the TER format wiki page).

### 8.4 The other formats, precisely

| Format | Layout | Gotchas |
|---|---|---|
| **PNG 16-bit grayscale** | PNG spec: `IHDR` bit-depth 16, colour type 0. Sample values are **big-endian** within the datastream (PNG is always network byte order) — the opposite of RAW. | Must be *linear data*, never sRGB-gamma'd. Gaea: "Don't let apps apply sRGB gamma to the heightmap (this bends elevations and ruins slopes)." 8-bit PNG bands visibly; "banding will be obvious." Image editors that "helpfully" colour-manage or dither will corrupt it. **This is what BAR/pymapconv expects for the heightmap** (`(mapx+1)²`, or `mapx*8 × mapy*8` for the hi-res path). |
| **TIFF 16-bit** | `SampleFormat = 1` (uint) or `3` (IEEE float), `BitsPerSample = 16` or `32`, `PhotometricInterpretation = 1` (BlackIsZero), single sample per pixel. | Gaea: "Don't assume 'TIFF' means 'high fidelity'. Many TIFFs are 8-bit, RGB, or colour-managed." Prefer 16-bit *integer* TIFF when the source is already quantised; confirm single-channel grayscale. |
| **OpenEXR 32-bit float** | Half or full float, arbitrary channels, tiled or scanline. | Gaea: "Prefer 32-bit float EXR for maximum fidelity and **safe negatives**… Don't treat EXR like an image: avoid colour transforms, tone mapping, or display LUT baking. Don't export 'beauty' EXRs; export **data** EXRs (single channel if possible)." Godot specifically wants an **RGB-packed** height EXR, which WM supports explicitly. |
| **GeoTIFF DEM** | TIFF + geo tags. | "Prefer 32-bit float GeoTIFF when available (best fidelity, handles negatives cleanly)… Pre-handle NoData if your exporter encodes it as a huge negative (e.g. −32768) or huge positive — mask/crop it before [import] or you'll Autolevel against garbage." Don't export with "visualization scaling". |
| **BT** | Virtual Terrain Project Binary Terrain — headered, supports float and int, geo-referenced. | Read/write supported by WM; useful for GIS round-trips. |
| **HFZ** | HF2/HFZ, compressed heightfield (Leveller lineage). | WM read + write. |
| **PGM (ASCII)** | `P2` magic, whitespace-separated decimal samples, maxval up to 65535. | Trivially debuggable; enormous files. Good for tests. |
| **Povray-TGA** | 16-bit packed across two 8-bit channels: **R = high byte, G = low byte**. | Legacy; cheap trick worth supporting because it needs no 16-bit image library. |

### 8.5 Precision: why normalise before quantising

Gaea's `normalized-output.md` is the best short treatment and is directly relevant to us, because BAR's heightmap is 16-bit:

> "16-bit integer heightmaps have 65,536 possible values (0–65535)… the vertical 'step size' equals (height range) / (number of code values). So if your terrain's meaningful heights only occupy, say, 10% of the saved range… In 16-bit, using only 10% of the range gives you ~6,553 usable levels instead of 65,536 — that's roughly **12.7 bits of effective precision, not 16**. Result: more visible terracing/banding, noisier erosion micro-detail, and worse downstream filtering."

Workflow it prescribes (and which maps exactly onto SMF's `minHeight`/`maxHeight` fields):

```
export value:      v = (h − hmin) / (hmax − hmin)      // stretch to full 16-bit span
reconstruct:       h = v * (hmax − hmin) + hmin        // engine-side vertical scale
```

**For BAR, use the engine's exact mapping, not the generic one above.** Recoil divides by **65536**, not 65535 (`SMFReadMap.cpp:155`, `SMFMapFile.cpp:132` — see §7.2.2), so the matched pair is:

```
write:        raw = clamp( floor( (h - minHeight) * 65536.0 / (maxHeight - minHeight) ), 0, 65535 )
engine reads: h   = minHeight + raw * (maxHeight - minHeight) / 65536.0
```

Write `minHeight` and `maxHeight` into the `SMFHeader` as exactly the `hmin`/`hmax` used for that quantisation (and, if you also emit `mapinfo.lua`, into `smf.minHeight` / `smf.maxHeight`, which override the header — `MapInfo.cpp:406-409`). The round trip is then lossless to `(maxHeight − minHeight)/65536` of the relief. Note that the intermediate PNG-16 handed to pymapconv is **big-endian** (PNG is always network byte order) while the `.smf` heightmap chunk is **little-endian**; the conversion happens inside pymapconv. **Also record the min/max as project metadata**: "keep track of (or export alongside) your terrain's original min/max elevation… Then your 'Height Scale' in the DCC becomes deterministic instead of eyeballed."

Tiling caveat, verbatim: *"if you normalize each tile independently, each tile gets its own min/max, which can cause seams… Normalize before tiling (one global min/max), or force a consistent min/max across all tiles."*

---

## 9. The rest of the field, briefly

> **Provenance note.** Every cell in this table below the World Machine, Gaea and Terragen rows is sourced from vendor marketing pages, third-party comparison articles or add-on documentation, not from source code or a reference manual. Treat the numeric claims ("over 50 separate nodes", "8 flow properties") as **UNVERIFIED — needs confirmation**; they are directionally useful, not specification-grade.

| Tool | Model | Relevant strengths | Relevant weaknesses |
|---|---|---|---|
| **World Machine** (Dragontail Peak, 4059+) | CPU node graph, procedural-infinite world | Best-in-class vector **Shapes** layer; deepest device decomposition; simulation-derived masks; tiled builds beyond RAM; **VDM terrain with real overhangs** (new); Code device = Slang compute shaders + Lua, in-app; Win/macOS/Linux; **Basic Edition free up to 1K** for non-commercial | Steepest learning curve; CPU-bound historically (100× erosion speedup only landed in Hurricane Ridge); simulation devices behave differently in Layout/Explorer/tiled; documentation has stale and unfinished sections; community reports slow support |
| **Gaea 2** (QuadSpinner) | GPU/CPU node graph, "Infinity Graph" | 192 nodes; named landform primitives; **resolution-independent erosion**; **1400 SatMaps**; Modifier Stack; Portals/Chokepoints/Gates; predictive search; Build Swarm + CLI; 32-bit float internally | Vector/shape authoring far weaker than WM; historically criticised documentation; fewer low-level decomposition primitives |
| **World Creator** (BiteTheBytes) | 100% GPU, real-time, filter-stack + sculpt | "**the most user-friendly option available**"; near-instant feedback; real-time sculpting over the procedural result | Paid only, no free tier; less deep procedurally; smaller node/filter vocabulary |
| **Terragen 4** (Planetside) | Node graph, but a *renderer* first | Planetary scale + true atmospherics/clouds; **TER format is the de-facto heightfield interchange**; exports TER / EXR-float-in-metres / TIFF-uint16 / RAW-uint16 | Terrain generation is secondary to rendering; heightfield toolset is thin next to WM/Gaea |
| **Houdini** (SideFX) | Heightfields as volumes inside a general procedural DCC | `HeightField Erode` splits hydro/thermal cleanly and outputs `height`/`sediment`/`debris`/`flow`/**`flowdir`** (a vector field); `HeightField Mask by Feature` / `by Object`; masks plug into the heightfield input of Noise/Erode/Scatter to localise them; full scripting | Enormous general-purpose app; terrain is a corner of it; licence cost; nothing like a beginner mode |
| **Blender A.N.T. Landscape + ErosionR / Erosion add-on** | Mesh-based, operator-driven (not a graph) | Free and in-the-box; A.N.T. = "Another Noise Tool", ships a **Landscape Eroder** reachable from Weight Paint Mode's Weights menu; the commercial Erosion add-on adds river/lake generation, curve-driven erosion control, and **8 flow properties**, works on any mesh, non-destructive iterative refinement with rising detail | Operator/modal UI, not procedural; slow on dense meshes; no real graph, no tiling, no engine-oriented export |
| **Instant Terra** (Wysilab) | Node graph, GPU | "**over 50 separate nodes**" including hydraulic erosion, an experimental **rock/thermal erosion** (sediment movement under gravity / talus deposition), and **mountain erosion** for young-fold Alpine ridges; **paintable masks to control any node**; exports heightmaps at 8/16/32-bit as TIFF, PNG, TGA, RAW16, OpenEXR32, Raw32; meshes as FBX, OBJ, Alembic | Smaller node library; less mature texturing/colour pipeline |

---

## 10. Recommendations for Terrasmith

### 10.1 The minimum node set for credible parity (~45 nodes)

*Generators (8)* — `Perlin/fBm` (with ridged/billowy/multifractal variants folded into a Style dropdown), `Voronoi`, `Mountain`, `Canyon`, `Island/Landmass`, `Gradient` (linear), `RadialGradient`, `Constant`.
*Shapes (1, big)* — the vector layout editor (§2.2). This is the differentiator; budget accordingly.
*Import (2)* — `FileInput` (heightfield/bitmap with placement + altitude mapping), `Material/Texture Input`.
*Filters (12)* — `Levels`, `Curve`, `Bias/Gain`, `Clamp`, `Blur` (scale-independent by default), `Expander`, `Warp/Displace`, `Terrace/Strata`, `AddNoise`, `Transform`, `Flip`, `Equalize`.
*Natural (6)* — `Erosion` (hydraulic), `Thermal` (talus), `FlowRestructure`, `CreateWater`, `River` (vector-drawn), `CoastalErosion`.
*Selectors (8)* — `Height`, `Slope`, `Aspect/Angle`, `Convexity/Curvature`, `Wetness`, `Occlusion/AO`, `CompareMaps`, `Peaks`.
*Combine (4)* — `Combine` (blend modes), `Chooser` (alpha blend + heightblend), `Layers` (stack), `Mask` (retro-mask, Gaea style).
*Colour (4)* — `Colorize/CLUT` (with a large preset gradient library), `Texture` (the one-click node, §5 item 4), `Mixer`, `Weightmap` (sum-to-one, packed RGBA + Material-ID modes).
*Output (5)* — `HeightOutput`, `BitmapOutput`, `Normals`, `Lightmap/AO bake`, `BARExport` (the wizard, §5 item 19).
*Utility (5)* — `Checkpoint/Gate` (cache boundary), `Switch`, `Portal`, `Note/Group`, `Sculpt` (raster delta layer).

### 10.2 Decisions this research implies

1. **Store heights as `float32` in metres internally; quantise only at export.** Both Gaea (float32) and the 16-bit-precision analysis argue for it, and it removes World Machine's "set the elevation scale once and never touch it" one-way door.
2. **Every spatial parameter is expressed in metres and resolved against metres-per-pixel.** This is the mechanism that makes preview ≡ build, which is the #1 beginner complaint about World Machine and Gaea's #1 marketing claim.
3. **Ship a non-node Simple Mode that compiles into the real graph.** One-way conversion. No competitor has this; it is the whole "easier for beginners" thesis in one feature.
4. **Every "magic" node exposes its internal masks as output ports.** Non-negotiable — this is the exact failure documented in the Quick Texture → splatmap support thread (§4.7).
5. **Erosion returns flow / wear / deposition, auto-normalised, plus talus depth.** And defaults to deterministic.
6. **Clamp slider ranges to the artistically useful range**, with an Advanced disclosure for the rest — World Machine's own macro guideline #4, which its first-party devices violate.
7. **Copy World Machine's Shapes/Layout editor in full**, including custom falloff curves, vertex welding, and fractal breakup; default breakup **on**.
8. **Copy Gaea's Modifier Stack** so a beginner graph stays under ten nodes, and because it is genuinely cheaper (post-process, no per-modifier memory).
9. **Ship a large preset gradient library for the colour node** (Gaea's SatMap is 1400 entries and is a large part of why its output looks good immediately).
10. **Build a `BARExport` wizard** that takes map size in BAR tiles (**N even**, ≤ 32) and derives `texw = 512·N` (a multiple of 1024), `mapx = texw/8`, heightmap `(mapx+1)²` 16-bit greyscale PNG, and writes `minHeight`/`maxHeight` from the actual normalisation used — quantising with `floor((h−min)·65536/(max−min))` clamped to `[0, 65535]`, **not** `·65535` (§7.2.2) — reporting all byte sizes before writing (§7.3).
11. **Author the diffuse for DXT1**: 8-bit sRGB at `512·N` px, favour grain over smooth ramps, optionally dither the 5:6:5 quantisation, and expose a "texture variety vs. .smt size" control since tile dedup is what sets file size.
12. **Import/export the interop set**: read PNG16, TIFF16/32, EXR32, R16/RAW, R32, TER, BT; write PNG16, TIFF16, EXR32, R16, R32, TER. All headerless RAW is **little-endian, row-major**, and needs a visible Y-flip toggle.
13. **Add a slope overlay bound to BAR's walkable/buildable slope thresholds** — it converts a subjective aesthetic judgement into a checkable requirement, which is exactly the sort of thing beginners need.
14. **Do not build tiled builds yet.** BAR maps top out around 8192² diffuse / 1025² heightmap, comfortably inside memory; tiled builds are where the majority of World Machine's documented correctness caveats live.

### 10.3 Open questions — resolved

**1. Preferred source image for metalmap and typemap? — RESOLVED: both are separately authored 8-bit images, read from the *red channel*.**
`pymapconv.py:689-698` and `882-887`; help strings at `:1366` and `:1399`. Metalmap: *"red channel is amount of metal. Resized to xsize / 2 by ysize / 2"* (bilinear if mis-sized). Typemap: *"uses the red channel to define terrain type [0-255]. types are defined in the .smd, if this argument is skipped the entire map will TERRAINTYPE0"* (nearest-neighbour if mis-sized). Neither is derived from the heightmap or the diffuse by any part of the toolchain, and `maps-metadata` stores no source for them either — it only *parses* `metalMap`/`typeMap` back out of finished `.smf` files (`cloud/map-parser/src/parse-worker.ts:171`). So Terrasmith emitting both from its mask set (§7.4 item 5) is a genuine improvement, not a duplication. See §7.2.3.

**2. Walkable / buildable slope thresholds? — RESOLVED, with a trap.**
`gamedata/movedefs.lua:43-50` gives `MINIMUM = 27`, `MODERATE = 33`, `DIFFICULT = 54`, `EXTREME = 75`, `MAXIMUM = 90` — but these are **not degrees of terrain slope**. `MoveDefHandler.cpp:84-96` computes `1 − cos(clamp(v, 0, 60) × 1.5°)`, so the real angles are 40.5° / 49.5° / 81° / 90° / 90°. The quantity compared against it is `1 − normal.y`, smoothed over a 2×2 heightmap-square block at `mapx/2 × mapy/2` resolution (`ReadMap.cpp:755-778`). Buildability is a *separate* test: `maxHeightDif = 40 × tan(unitDef.maxSlope)` compared against height deviation over the footprint (`UnitDef.cpp:422-426`, `GameHelper.cpp:1211, 1634`). Full table and citations in §7.2.5.

**3. A BAR convention for `minHeight`/`maxHeight`? — RESOLVED: there is none.**
Nothing in `beyond-all-reason/maps-metadata` fixes or even records a canonical pair; its schemas (`schemas/{cdn,live,lobby,teiserver}_maps.yaml`) carry no height fields, and the map parser reads `minHeight`/`maxHeight` back out of each `.smf` individually (`cloud/map-parser/src/parse-worker.ts:179-180`), i.e. every map chooses its own. The BAR [map checklist](https://www.beyondallreason.info/guide/map-checklist) states no height convention either (it does cap map size at *"32x32 or 32 in any dimension"*). The only defaults anywhere in the pipeline are pymapconv's CLI defaults, `--minheight -50.0` / `--maxheight 100.0` (`pymapconv.py:1372-1377`), and mappers are instructed to change them per map. **Conclusion: auto-normalise per map, expose `minHeight`/`maxHeight` as explicit metres, default to a sensible pair (e.g. −50 / +100 to match pymapconv), and write the same values into both the `SMFHeader` and `mapinfo.lua`'s `smf` table.**

**4. Hi-res `mapx*8 × mapy*8` heightmap vs `(mapx+1)²`? — RESOLVED: the canonical form is `(mapx+1)²`; hi-res is an opt-in downsampling convenience.**
Both are accepted. The hi-res path pads by 4 px of edge replication and downsamples with `--highresheightmapfilter`, default **`nearest`** (sampling at `col*8+4, row*8+4`, the texel centres that align with the corner grid), with `median`, `histogram`, `lanczos` and `bilinear` as alternatives; three of the five clamp to 65534 rather than 65535. Full behaviour in §7.2.4. **For procedurally generated terrain, emit `(mapx+1)²` directly — it is smaller and involves no resampling.**

### 10.4 Remaining open questions

- **Erosion parameter semantics in Hurricane Ridge.** WM's `Erosion` was rewritten (feature-size control, soil control, spatial parameters on every parameter) but the KB page still documents the legacy device; the current parameter list is not published. §6.1's modern-parameter notes are inferred from release notes, not a reference page. **UNVERIFIED — needs confirmation.**
- **Gaea per-node Properties tables.** Exact slider ranges and defaults for `Erosion2`, `SatMap`, `Texturizer` and `Export` are generated at build time and are absent from `Gaea2-Docs`; only the prose semantics were recoverable. `Erosion`'s `Feature Scale` default of **2000 m** *is* stated in prose and is confirmed. Everything else: **UNVERIFIED — needs confirmation.**
- **Erosion algorithm choice.** Neither vendor publishes whether their hydraulic erosion is a grid/pipe model, a particle/droplet model, or stream-power. This research does not constrain our implementation; drive it from the papers in the scratch corpus (mei2007, olsen2004, cordonnier2016, guerin2016, jako2011).
- **`.smd` vs `mapinfo.lua`.** pymapconv's typemap help text refers to terrain types "defined in the `.smd`", which is the legacy Spring map-definition file; BAR maps use `mapinfo.lua` instead (`beyond-all-reason/maps-metadata` has a `check_uses_mapinfo_lua.ts` script). The exact `mapinfo.lua` terrain-type table shape was **not** verified here and must be before writing an exporter.
- **DXT1 compressor.** pymapconv shells out to `nvdxt.exe` (Windows) or `CompressonatorCLI` (Linux) rather than compressing in-process. If Terrasmith writes `.smf`/`.smt` directly it needs its own DXT1 encoder; the quality of that encoder, not the source texture, will set the visible result.

---

## 11. Sources

**World Machine**
- Help centre root and device reference — https://help.world-machine.com/topics/reference/ , https://help.world-machine.com/topics/alldevices/
- Category pages: [generator](https://help.world-machine.com/topics/generator-devices/), [filter](https://help.world-machine.com/topics/filter-devices/), [natural](https://help.world-machine.com/topics/natural-devices/), [combiner](https://help.world-machine.com/topics/combiner-devices/), [selector](https://help.world-machine.com/topics/selector-devices/), [converter](https://help.world-machine.com/topics/converter-devices/), [output](https://help.world-machine.com/topics/output-devices/), [parameter](https://help.world-machine.com/topics/parameter-devices/), [utility](https://help.world-machine.com/topics/utility-devices/)
- **WM2 exhaustive device reference (archived)** — https://web.archive.org/web/20100822145020/http://www.world-machine.com/learn.php?page=devref
- User's guide chapters — [1 Introduction](https://help.world-machine.com/topic/chapter-1-an-introduction-to-world-machine/), [2 Device Workspace](https://help.world-machine.com/topic/devices-and-the-device-workspace/), [3 Render Extents & Project Setup](https://help.world-machine.com/topic/render-extents-and-project-setup/), [4 Terrain Views](https://help.world-machine.com/topic/terrain-views/), [5 Layout Generator](https://help.world-machine.com/topic/layout-generator/), [6 File Input and Output](https://help.world-machine.com/topic/file-input-and-output/), [7 Bitmaps and Textures](https://help.world-machine.com/topic/bitmaps-and-textures/), [Macros](https://help.world-machine.com/topic/macros/), [Blueprints](https://help.world-machine.com/topic/blueprints/), [Pro Edition Addendum](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/)
- Concepts — [Localspace](https://help.world-machine.com/topic/localspace/), [Spatial Parameters](https://help.world-machine.com/topic/spatial-parameters/)
- Device pages — [Erosion](https://help.world-machine.com/topic/device-erosion/), [Thermal Erosion](https://help.world-machine.com/topic/device-thermalerosion/), [River](https://help.world-machine.com/topic/device-river/), [Create Water](https://help.world-machine.com/topic/device-create-water/), [Flow Restructure](https://help.world-machine.com/topic/device-flowrestructure/), [Select Wetness](https://help.world-machine.com/topic/device-select-wetness/), [Texture Weightmap](https://help.world-machine.com/topic/device-splatmap/), [Layers](https://help.world-machine.com/topic/layers/), [Material](https://help.world-machine.com/topic/device-material/), [Meshify](https://help.world-machine.com/topic/device-meshify/), [Scene Output](https://help.world-machine.com/topic/device-scene-output/), [Scene View](https://help.world-machine.com/topic/device-sceneview/), [Strata](https://help.world-machine.com/topic/device-strata/), [Crystallize](https://help.world-machine.com/topic/device-crystallize/), [Instance Tiling](https://help.world-machine.com/topic/device-instance-tiling/), [Levels](https://help.world-machine.com/topic/device-levels/), [Crop & Transform](https://help.world-machine.com/topic/device-crop-transform/), [Chooser](https://help.world-machine.com/topic/device-chooser/), [Checkpoint](https://help.world-machine.com/topic/device-checkpoint/), [Tap](https://help.world-machine.com/topic/device-tap/), [Create Normals](https://help.world-machine.com/topic/device-createnormals/), [Reach Character](https://help.world-machine.com/topic/device-reachcharacter/)
- Release notes — [Build 4041 'Hurricane Ridge'](https://help.world-machine.com/topic/version-hurricane-ridge/), [Build 4031 'Artist Point'](https://help.world-machine.com/topic/version-artist-point/), [Build 4059 'Dragontail Peak'](https://help.world-machine.com/topic/build-4059-dragontail-peak/)
- Marketing/feature page (current feature set) — https://www.world-machine.com/features.php
- FAQ — [Where did the Layout Generator go?](https://help.world-machine.com/topic/where-did-the-layout-generator-go/), [How do I export my terrain and textures?](https://help.world-machine.com/topic/how-do-i-export-my-terrain-and-textures/)
- Forum — [Gaea 2 vs WorldMachine](https://forum.world-machine.com/t/gaea-2-vs-worldmachine/7183), [Quick Texture → splatmap](https://forum.world-machine.com/t/is-there-a-way-to-convert-the-quick-texture-macro-to-a-splat-map/6536)

**Gaea** (all paths relative to `source/` in https://github.com/QuadSpinner/Gaea2-Docs)
- `reference/nodes/{primitive,terrain,simulate,surface,modify,derive,colorize,utility,output}/*.md` — the 183-node catalog
- `.meta/*.json` — per-node metadata (Name, Description, Family, Toolbox, Classification, ShortCode, RequiresBaking)
- `reference/nodes/simulate/erosion.md`, `erosion2.md`, `wizard.md`, `wizard2.md`, `easyerosion.md`, `thermal2.md`
- `using/using-gaea/understanding-erosion/index.md` — including the "Misconceptions" section
- `using/using-gaea/colorizing-and-textures/working-with-satmaps.md`
- `using/using-gaea/managing-graphs/using-modifiers.md`
- `using/advanced-topics/technical-information/file-formats.md` — the RAW/R16/R32 contract
- `guides/scenarios/helpful-info/format-gotchas.md`, `normalized-output.md`
- `guides/scenarios/workflow/bake-required.md` — Gates
- `ui/interface/build-options/{resolution,build,tiles,terrain}.md`
- `ui/interface/graph/{procedural-workflow,toolbox-and-search}.md`
- `ui/graph/basic-workflow/{lock-preview,underlays}.md`, `ui/graph/organization/portals-and-chokepoints.md`
- `ui/interface/property-editor/presets.md`
- `using/getting-started/important/scale-and-resolution.md`
- Live docs — https://docs.gaea.app/ ; blog — https://blog.quadspinner.com/gaea-2-2-released/

**BAR / Recoil**
- `rts/Map/SMF/SMFFormat.h` (SMFHeader, ExtraHeader, MapTileHeader, MapFeatureHeader, TileFileHeader, `SMALL_TILE_SIZE`=680, `MINIMAP_SIZE`=699048, `MINIMAP_NUM_MIPMAP`=9) — https://github.com/beyond-all-reason/RecoilEngine
- `rts/Map/SMF/SMFReadMap.h:181-182` (`tileScale = 4`, `bigSquareSize = 32*tileScale`), `rts/Map/SMF/SMFReadMap.cpp:120-129` (`ParseHeader` derived sizes), `rts/Map/SMF/SMFReadMap.cpp:144-155` (`LoadHeightMap`, the `/65536` reconstruction), `rts/Map/SMF/SMFMapFile.cpp:97-135` (`ReadHeightmap`), `rts/Map/MapInfo.cpp:406-409` (`mapinfo.lua` `smf.minHeight`/`maxHeight` overrides), `rts/Sim/Misc/GlobalConstants.h:24` (`SQUARE_SIZE = 8`)
- `src/pymapconv.py` — https://github.com/Beherith/springrts_smf_compiler (CC0-1.0). The repo is `springrts_smf_compiler`; `Beherith/Spring_SMF_compiler` (cited in an earlier draft) does not exist. Lines verified on `master` 2026-09-13: `38` (`SMFHeader_struct`), `442`/`444` (`mapx`/`springmapx`), `446` (texture must be a multiple of **1024**), `530` (`expectedheightmapsize`), `536` (`<H` little-endian unpack), `553` (hi-res heightmap path), `1024-1077` (SMF write order), `1013` (`.smt` header write)

**Other tools**
- Terragen TER format — https://docs.planetside.co.uk/wiki/Terragen_.TER_Format ; GDAL driver — https://gdal.org/en/stable/drivers/raster/terragen.html ; feature tour — https://planetside.co.uk/terragen-feature-tour/
- Houdini heightfields — https://www.sidefx.com/docs/houdini/model/heightfields.html ; HeightField Erode 3.0 — https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode.html ; masking — https://www.sidefx.com/docs/houdini/heightfields/masking.html
- Blender A.N.T. Landscape — https://docs.blender.org/manual/en/2.82/addons/add_mesh/ant_landscape.html , https://extensions.blender.org/add-ons/antlandscape/ ; ErosionR — https://github.com/nerk987/ErosionR ; Erosion add-on — https://blender-addons.org/erosion-add-on/
- Instant Terra — https://www.wysilab.com/Features/Features-terrain-editor.html ; https://www.cgchannel.com/2022/03/wysilab-ships-instant-terra-2-0/ ; https://www.cgchannel.com/2020/12/wysilab-releases-instant-terra-1-1/
- Comparisons — https://polycount.com/discussion/228295/gaea-vs-world-machine-vs-world-creator-vs-instant-terra ; https://vionixstudio.com/2021/05/01/world-creator-vs-world-machine-vs-gaea/ ; https://www.cgchannel.com/2026/05/world-machine-dragontail-peak-preview/

---

## 12. Verification log

Every claim below was re-checked against a primary source on **2026-09-13** by fetching the raw file (`curl` on `raw.githubusercontent.com`, or the GitHub tree API via `gh`). Engine claims are against `beyond-all-reason/RecoilEngine@master`; compiler claims against `Beherith/springrts_smf_compiler@master`; Gaea claims against `QuadSpinner/Gaea2-Docs@master`.

| # | Claim as written | Source checked | Verdict |
|---|---|---|---|
| 1 | `SMFHeader` field order, types and byte offsets (magic 0, version 16, mapid 20, mapx 24, mapy 28, squareSize 32, texelPerSquare 36, tilesize 40, minHeight 44, maxHeight 48, heightmapPtr 52, typeMapPtr 56, tilesPtr 60, minimapPtr 64, metalmapPtr 68, featurePtr 72, numExtraHeaders 76; `sizeof == 80`) | `rts/Map/SMF/SMFFormat.h:49-70`; independently cross-checked against `pymapconv.py:38` `struct.Struct('< 16s i i i i i i i f f i i i i i i i')` (16 + 16×4 = 80) | **confirmed** |
| 2 | The header block is at "lines 50–71" | `SMFFormat.h` — the struct spans **49–70** | **corrected** |
| 3 | `SMALL_TILE_SIZE == 680`, `MINIMAP_NUM_MIPMAP == 9`, `MINIMAP_SIZE == 699048`; minimap = 1024² DXT1 + 8 mip sublevels | `SMFFormat.h:28,31,34,65`; arithmetic re-derived: 524288+131072+32768+8192+2048+512+128+32+8 = 699048 | **confirmed** |
| 4 | `TileFileHeader` = `char[16] + 4 ints` = 32 B, magic `"spring tilefile\0"`, `compressionType == 1` (DXT1); tiles are 32×32 DXT1 with **4** mip levels (512+128+32+8) | `SMFFormat.h:172-183`; `pymapconv.py:79, 1013` | **confirmed** |
| 5 | `tileScale = 4`, `bigSquareSize = 32*tileScale` at `SMFReadMap.h:181-182`; `numBigTexX`/`bigTexSize`/`tileMapSizeX`/`tileCount`/`mapSizeX`/`heightMapSizeX` at cpp lines 120/122/123/125/126/129 | `SMFReadMap.h:181-182`, `SMFReadMap.cpp:120-129` | **confirmed** (prose range "118-127" **corrected** to 120-129) |
| 6 | `SQUARE_SIZE = 8` | `rts/Sim/Misc/GlobalConstants.h:24` (`static constexpr int SQUARE_SIZE = 8;`) | **confirmed** |
| 7 | Heightmap reconstruction is `h = min + v*(max−min)` with `v` the normalised 0..1 value (implying ÷65535) | `SMFReadMap.cpp:155` passes `mod = (maxHgt - minHgt) / 65536.0f`; `SMFMapFile.cpp:132` computes `base + word * mod`. Divisor is **65536**, and `maxHeight` is never actually reached | **corrected** — added §7.2.2 with the exact export quantisation |
| 8 | `minHeight`/`maxHeight` come from the `.smf` header | `rts/Map/MapInfo.cpp:406-409` — `mapinfo.lua`'s `smf.minHeight`/`smf.maxHeight` **override** the header when the keys exist | **gap filled** |
| 9 | On-disk `.smf` chunk order | `pymapconv.py:1024-1077`. The doc omitted the **12-byte `MEH_Vegetation` ExtraHeader** (with an undocumented third int) and the `mapx*mapy/16` vegetation map that precede the heightmap | **gap filled** (new §7.2.1, plus a row in the §7.3 size table) |
| 10 | Heightmap is `uint16` little-endian | `pymapconv.py:536` (`struct.unpack('< ' + 'H'*n)`), `:1054` (`struct.pack('<H', h)`); engine side `swabWordInPlace` in `SMFMapFile.cpp:108` is a no-op on LE hosts | **confirmed** |
| 11 | pymapconv derives `mapx = texw // 8` (`:442`), `springmapx = texw // 512` (`:444`), `expectedheightmapsize = (mapx+1)*(mapy+1)*2` (`:530`), hi-res path at `:553` | `pymapconv.py` at exactly those lines | **confirmed** |
| 12 | "Author the diffuse at exactly `springmapx * 512` px" | `pymapconv.py:446` rejects the texture unless **both dimensions are multiples of 1024** — so `springmapx` must be **even** | **corrected** |
| 13 | pymapconv repo is `github.com/Beherith/Spring_SMF_compiler` | That repo returns HTTP 404. The real one is **`github.com/Beherith/springrts_smf_compiler`** (CC0-1.0), path `src/pymapconv.py` | **corrected** |
| 14 | Minimap falls back to `intex.resize((1024,1024), LANCZOS)` | `pymapconv.py:496-497` — confirmed; also learned a *supplied* `--minimap` is resized to 1024² too (`:491`), and compression is `nvdxt … -nmips 9` / `CompressonatorCLI -fd DXT1 -miplevels 9` (`:515-519`) | **confirmed + extended** |
| 15 | Metalmap and typemap source images | `pymapconv.py:689-698`, `882-887`, help text `:1366`, `:1399` — both separately authored, both read from the **red channel**, metalmap bilinear-resized, typemap nearest-resized | **gap filled** (open question 1) |
| 16 | Hi-res heightmap path behaviour | `pymapconv.py:553-641`, `1436-1438` — filters `[lanczos, bilinear, nearest, median, histogram]`, default `nearest` | **gap filled** (open question 4) |
| 17 | BAR movedef slope thresholds | `Beyond-All-Reason/gamedata/movedefs.lua:43-50` (`MINIMUM 27 / MODERATE 33 / DIFFICULT 54 / EXTREME 75 / MAXIMUM 90`) **but** `MoveDefHandler.cpp:84-96` applies `clamp(v,0,60)*1.5` then `1−cos`. Comparison quantity is `1−normal.y` at half resolution (`ReadMap.cpp:755-778`). Buildability uses `maxHeightDif = 40*tan(maxSlope)` (`UnitDef.cpp:422-426`, `GameHelper.cpp:1211,1634`) | **gap filled** (open question 2) |
| 18 | A BAR convention exists for `minHeight`/`maxHeight` | `maps-metadata` schemas carry no height fields; `cloud/map-parser/src/parse-worker.ts:179-180` reads them per map. pymapconv defaults `-50.0` / `+100.0` (`:1372-1377`). BAR map checklist caps size at "32x32 or 32 in any dimension" | **resolved: no convention** (open question 3) |
| 19 | Gaea has "192 documented nodes" | GitHub tree API over `Gaea2-Docs@master`: primitive 23, terrain 14, simulate 25, surface 21, modify 41, derive 14, colorize 13, utility 20, output 12 = **183** (excluding `index.md`). The per-family *lists* in §3.1 match the filenames exactly | **corrected** (183; "Simulate (26)" → 25) |
| 20 | Gaea "over 1400 color maps, derived from real satellite data" | `source/using/using-gaea/colorizing-and-textures/working-with-satmaps.md` front matter + body, verbatim | **confirmed** |
| 21 | Gaea `Erosion` resolution-independence quote; `Feature Scale` default 2000 m; Strength/Rock Softness and Downcutting/Inhibition quotes | `source/reference/nodes/simulate/erosion.md`, verbatim | **confirmed** |
| 22 | `Erosion2` "up to 10x faster … deterministic"; classic `Erosion` has a `Deterministic` toggle | `erosion2.md` confirms the speed/determinism claim. `erosion.md` documents only a **`Parallel Processing`** toggle — no `Deterministic` parameter | **corrected** |
| 23 | Gaea headerless RAW contract (`.r32` float LE 0..1, `.raw` ushort LE 0..65535, no header, `n = sqrt(bytes/typesize)`) | `source/using/advanced-topics/technical-information/file-formats.md`, verbatim | **confirmed** |
| 24 | Gaea 16-bit precision / "~12.7 bits" and the per-tile normalisation seam warning | `source/guides/scenarios/helpful-info/normalized-output.md:15,20,56`, verbatim | **confirmed** |
| 25 | Terragen `.TER`: `"TERRAGEN"` @0, `"TERRAIN "` @8, chunk markers and payload types, `SIZE` = n−1, `ALTW` decoding `BaseHeight + Elevation*HeightScale/65536`, intel-ordered | docs.planetside.co.uk `Terragen_.TER_Format` wiki | **confirmed** |
| 26 | WM "practical resolution limit … around 8192×8192"; tiled-build parameter list; `%x`/`%y`/`%res`, default `_x%x_y%y` | help.world-machine.com Pro Edition Addendum, verbatim | **confirmed** |
| 27 | WM "over a hundred devices"; Basic Edition free up to 1K; 3D viewport display guides incl. slope overlay | world-machine.com/features.php — the wording is "**Over a hundred tools**", and "Basic is free, builds up to **1K**" | **corrected** (wording; "1025×1025" now flagged unverified) |
| 28 | Dragontail Peak = build 4059; Hurricane Ridge = build 4041 with "up to 100 times faster" erosion, Feature Size and Soil controls | help.world-machine.com release-notes pages for both builds | **confirmed** (the *ranges* 4041–4051 / 4027–4031 remain **unverified**) |
| 29 | WM2 device-reference claims (Gradient `0 = east, 90 = north, 180 = west, 270 = south`; Angle Selector `0=west, 90=south, 180=east`; Terrace `Sharp` is the default method; Voronoi styles `Fn / Fm−Fn / Fn Cells` and Euclidean/Manhattan/Alt#1/#2; Scalar Arithmetic Clip vs Rollover with the 0.9+0.2 examples; Combiner's "values in the second heightfield above 0.5 are added … below … subtracted"; File Output `RAW16` = "16bit RAW file, in standard PC byte-endian format"; Snow `Evaporative Balance`) | The archived WM2 devref page was downloaded in full (223 KB) and each string located verbatim | **confirmed** |
| 30 | Gaea 2.2 is the current line | blog.quadspinner.com — Gaea 2.2 released **2025-07-14** | **confirmed** |

**Not verifiable from a primary source and now marked in-text as "UNVERIFIED — needs confirmation":** the World Machine build-number *ranges* for Hurricane Ridge and Artist Point; whether Basic Edition's "1K" is 1024 or 1025; Terragen 4.8's exporter list; the modern (post-Hurricane-Ridge) `Erosion` parameter table; Gaea's per-node Properties tables (slider ranges/defaults); and all third-party tool claims in §9.

**Claims re-derived arithmetically rather than cited** (all check out): every figure in the §7.3 worked size table, and the `MINIMAP_SIZE` mip breakdown.
