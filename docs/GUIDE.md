# Making your first BAR map

This guide assumes you play Beyond All Reason and have never opened a terrain tool. It goes in the order
you will actually need things: get something on screen, learn to read it, then make it a map someone would
want to play.

Every number here comes from BAR's game data, the Recoil engine source, or a measurement across BAR's
curated map pool — 225 maps in the lobby's list, 50 archives where a figure needed the map file itself,
202 for the symmetry shares BAR's own generator carries. The workings are in
[research/bar-gameplay.md](research/bar-gameplay.md) and
[research/map-archive.md](research/map-archive.md) if you want to check one.

**One unit of measurement to learn first.** BAR measures distance in *elmos*. A map is sized in 512-elmo
units, so a "16x16 map" is 8192 x 8192 elmos. A commander's build range is 145 elmos. A heightmap square is
8 elmos, and a metal or terrain-type cell is 16. Terrasmith works in elmos everywhere, so every distance you
type is a real distance in the game.

---

## 1. Start from a template

Do not start from an empty graph. Terrasmith ships seven complete, buildable maps, and changing one is a
much better first hour than building one from nothing.

| Template | Size | Players | What it is |
| --- | --- | --- | --- |
| Rolling hills | 16x16 | 2–12 | Broad hills, wide flat valleys, a few lakes. Almost all of it drivable. |
| Mountain range | 16x16 | 2–10 | High ground worth fighting for, with passes between. |
| Island cluster | 20x20 | 4–16 | Naval, with contested shallows between the islands. |
| Canyon lanes | 20x16 | 8–16 | Plateaus split by deep channels — a lane map. |
| Highland basin | 20x20 | 8–16 | A ring of high ground around an open middle. |
| Almost flat | 12x12 | 2–8 | A blank slate. The one to learn the controls on. |
| Volcanic shelf | 16x16 | 4–12 | Black rock, steep sides, a flooded caldera. |

Pick one. Then find the **Seed** control and change it.

A seed changes the random pattern without changing its character: same hill size, same erosion, same amount
of water, different landscape. Rerolling the seed a dozen times and keeping the one you like is a completely
legitimate way to work, and it is the fastest way to learn what the other controls are doing — because the
only way to tell a real change from a different roll of the dice is to keep the dice still.

The project has one seed, and several nodes have their own. The project seed shifts everything at once; a
node's seed rerolls just that part of the terrain. Start with the project seed.

If you are working from a checkout without the editor, `node tools/render-templates.mjs` renders every
template to `samples/renders/` and prints the height range and the drivable, impassable and underwater
percentages for each.

---

## 2. Reading the overlays

The terrain view shows you a landscape. The overlays tell you whether it is a *map*.

### Who can go here

This is the one to leave on. It colours the ground by which units can cross it, using the thresholds from
BAR's own move definitions rather than a generic idea of "steep".

| Band | Slope | Who this stops |
| --- | --- | --- |
| Vehicle-flat | up to **27°** | Nothing. Every tank, bot, hover and commander drives here. |
| Hover and heavy tank | 27° to **33°** | Vehicles (Flash, Stumpy, Reaper, Goliath) stop at 27°. Hovers and Thor keep going. |
| Bot-climbable | 33° to **54°** | Hovers and Thor stop at 33°. Bots, commanders and amphibious units keep going. |
| All-terrain only | steeper than **54°** | Everything except spiders, Vanguard/Karganeth, Korgoth, T4 all-terrain — and air. |

**27 and 54 are the two numbers that matter**, because they are the two that the most units share. Every
standard vehicle — Flash, Stumpy, Reaper, Goliath, both constructor lines — stops at 27 degrees. Every bot,
every commander and every amphibious unit, including the amphibious vehicles like Beaver and Croc, stops at
54. So:

- A ramp at **26 degrees** is a road. Your whole army uses it.
- A ramp at **30 degrees** shuts standard vehicles out while bots, hovers, Thor and amphibians still climb
  it. This is a deliberate and very effective design tool: it gives one half of the tech tree ground the
  other half cannot follow onto, without building a wall.
- A cliff at **56 degrees** stops every bot, tank, hover and commander. What still walks up it is the
  handful of move classes BAR gives no slope limit at all: spiders, Vanguard and Karganeth, Korgoth, and
  the T4 all-terrain units. That is intended, so do not expect a cliff to be a wall against those.

Two details that will otherwise confuse you. First, the engine does not measure slope the way you would
guess. It works on **16x16 elmo cells**, and for each cell it blends the steepest of the eight triangles in
that cell with their average — but the blend is weighted by how steep that steepest triangle is, so the
steeper it gets the less the average pulls it back. The engine's source comment says the blend is there
"so that small holes don't block huge tanks", and that is true of a shallow dimple, but it is **not** a
licence to leave spikes in. Measured against Terrasmith's exact reproduction of the engine's slope map: a
single heightmap corner raised **20 elmos** above otherwise perfectly flat ground makes its whole 16-elmo
cell read as **66 degrees** — past the 54-degree gate, so nothing but a spider crosses it. Keep per-square
height differences under about 6 elmos anywhere you want vehicles to drive, and smooth before you export.

Second, the viewport overlay is not the engine. It takes a per-sample gradient, which is quick and looks
right but reads systematically **flatter** than the engine does — most visibly on spiky ground and on cliff
tops, where the engine reads steep and a gradient reads level. When you need the definitive answer, run the
validator: it reconstructs the engine's slope map exactly and reports what is actually unreachable. Second, if
you ever read BAR's `movedefs.lua` directly you will see `maxslope = 18` where this guide says 27 degrees.
The engine multiplies by 1.5 on load and BAR pre-divides to compensate. The real angles are the ones in the
table.

### Where you can build

Different rule, and this catches everyone. Buildings are **not** slope-tested. Every heightmap square under
a building's footprint must be within `±maxHeightDif` of the platform height, where
`maxHeightDif = 40 × tan(the unit's maxslope)`. In practice:

| Building | Footprint | Height tolerance |
| --- | --- | --- |
| Bot lab / vehicle plant | 96 x 96 elmos | **±10.7 elmos** |
| Solar collector | 80 x 80 elmos | ±7.05 elmos |
| Fusion reactor | 96 x 80 elmos | ±7.05 elmos |
| Geothermal plant | 80 x 80 elmos | ±14.56 elmos (advanced geo: ±10.7) |
| LLT | 32 x 32 elmos | ±9.97 elmos |
| Metal extractor | 64 x 64 elmos | ±23.09 elmos |

The bot lab is the hard one: 96 elmos across, and the ground under all of it within about 21 elmos top to
bottom. Ground that looks gently rolling in the viewport is often not flat enough for a lab, and that is
exactly what this overlay is for.

### Height

Colours by elevation with the water line marked. **Water is at height 0 in BAR** — that is not a setting,
it is where the water plane is. Everything below 0 is underwater and everything above it is land, so
"raising the sea" means lowering the land, which is what the Sea level node and the Height output's water
level control do for you.

### Metal, symmetry, water flow

Metal shows the extraction sites and what each one yields. Symmetry shows how far the map is from the
symmetry you declared, which is how you catch the half that did not get mirrored. Water flow shows where
water collects and runs, which is useful for deciding where a river should be before you erode.

---

## 3. How big should the map be?

Two hard rules first:

- **Nothing larger than 32 units in any dimension.** BAR's map checklist: *"Maps larger than 32x32 or 32 in
  any dimension will not be accepted."*
- **Both dimensions must be even.** The engine draws terrain in 128-square patches, so the square count has
  to be divisible by 128, which makes the unit count even. Terrasmith will not let you set an odd size.

Then pick from what BAR actually uses. Across the 225 curated maps:

| Format | Size | Elmos across |
| --- | --- | --- |
| 1v1, competitive | 10x10 to 14x14 | 5120 – 7168 |
| 2v2 / 3v3 | 12x12 to 16x16 | 6144 – 8192 |
| 4v4 / 5v5 | 16x16 to 18x18 | 8192 – 9216 |
| **8v8, the default team game** | **20x16, 20x20, 24x16 or 24x24** | 10240 – 12288 |
| Big team, 10v10 and up | 24x24 to 32x32 | 12288 – 16384 |
| FFA, 3 to 8 way | 16x16 to 24x24 | 8192 – 12288 |
| PvE, raptors, scavengers | 20x20 to 32x32 | |

16x16 is the single most common size in the pool (36 maps), then 20x20 and 24x24 (21 each). Of the 40 most
popular 16-player maps, 24 are one of those four 8v8 sizes.

The rule of thumb behind the table is **area per player**, measured as `sizeX × sizeZ / maxPlayers`. Team
maps land between 20 and 36, median about 24 — so a 16-player map wants 320 to 400 square units, which is
20x16 through 20x20. 1v1 maps are far more generous, 32 to 128 per player, because each player has to
expand across the whole map alone.

**Non-square is normal.** 20x16, 24x16, 20x12 and 18x12 are all common, and a rectangle is the natural
shape for a lane map where two teams face each other across the short axis.

Changing the size in Terrasmith does not require rewiring anything, but be clear about what it does.
Generators are anchored in world coordinates, so growing a 16x16 map to 24x24 **does not zoom the
landscape out — it keeps the terrain you already have and extends it**. The pattern is anchored to the
map's origin corner, so the terrain near that corner stays put and the extra ground appears beyond the old
edges (measured: under 3 elmos of drift at the same world point, on a map 400 elmos tall). A 2048-elmo
hill is still 2048 elmos wide; you just have 12288 elmos of map instead of 8192 to put hills in. Decide
the size early, because the half of the map you were happy with will not rearrange itself to fit a new one.

---

## 4. Making somewhere to build

**BAR has no terraform command in normal play.** The engine levels the ground under a building as it is
placed, and craters deform terrain according to `maphardness`, but a player cannot flatten a hillside to
put a lab on it. Flat ground is the map author's job, and it is the single most common thing missing from a
first map.

What each start position needs:

| Check | Window | Tolerance | Target per start |
| --- | --- | --- | --- |
| Lab pad | 96 x 96 elmos | ±10.7 elmos | at least 3 |
| Solar/fusion farm | 96 x 80 elmos | ±7.05 elmos | 400 x 400 elmos contiguous |
| Mex pad | 64 x 64 elmos | ±23.1 elmos | every metal spot |
| Geo pad | 80 x 80 elmos | ±10.7 elmos | every vent |
| Turret pad | 32 x 32 elmos | ±9.97 elmos | along every choke shoulder |

The headline figure: **a usable base needs a contiguous pad of about 400 x 400 elmos** where the height
varies by no more than about ±10 elmos across any 96-elmo window. A forward position needs at least
150 x 150 elmos for a lab and a couple of turrets.

Four ways to get it in Terrasmith, roughly in order of how much control they give you:

1. **The Plateaus node.** Scatters flat-topped platforms with a radius and a height you choose. It also
   outputs a mask of where they are, which is the useful part — see (4).
2. **Flatten with a mask.** Connect any selector to the Flatten node's Mask input and the terrain levels
   only where the mask is 1. `Select by height` for a whole altitude band, `Select by slope` (0° to about
   10°) to find the ground that is nearly flat already and make it properly flat.
3. **Terrace.** Cuts the terrain into flat steps. It is usually sold as a rock-strata effect, but in BAR its
   real value is that steps are buildable: a terraced hillside gives players somewhere to put a base at
   several heights instead of one useless slope.
4. **Protect the flat ground from erosion.** Water erosion has a *Hardness* input — a 0–1 field where 0 is
   unerodible. Wire the Plateaus node's Mask output through `Math: one minus` into Hardness and the erosion
   will weather everything around your platforms and leave the platforms alone. The alternative, if you do
   not have a mask, is the *Protect flat ground* option on the erosion node, which erodes steep ground
   harder than flat ground.

Order matters: put the flattening **after** erosion, or erosion will chew holes in it.

---

## 5. Metal

### What a spot actually is

BAR does not store a list of metal spots. It **finds** them when the game starts, by looking at the metal
map — one byte per 16x16 elmo cell — and grouping every connected run of non-zero cells into one spot. The
spot's position is the centre of that group's bounding box, and its worth is the sum of the whole group.

That is why **a spot is a blob, not a pixel**. A single painted cell is a legal spot but a bad one: it gives
the extractor-snapping logic almost nothing to work with. Real BAR spots are **4x4 metal cells, about 64x64
elmos** — measured across Altair Crossing, Ravaged, Tabula and Tundra. BAR's own spot-placer gadget is a
little more generous, painting a 5x5 block minus its four corners, which is 80x80 elmos. Anywhere in that
range is a normal spot.

Three sizes to stay inside:

- **180 elmos across, maximum.** An extractor only captures cells whose centre is within `extractorRadius`
  (90 on most maps). A wider blob can never be fully captured, and the player quietly loses income.
- **212 elmos of Z-span is a cliff edge.** Past that, BAR's placement validity check rejects every position
  and the spot cannot be snapped to at all.
- **540 elmos is catastrophic.** If any connected blob's bounding box exceeds `extractorRadius × 6`, the
  spot finder gives up on the *entire map*: all spot UI, area-mex and mex snapping is disabled everywhere.

Design to the 64x64 figure; the other numbers are failure cliffs, not targets.

And keep separate spots **separate**. The grouping counts diagonal contact as connected, so leave at least
one empty metal cell (16 elmos) between blobs on both axes, or two spots that look distinct on screen will
merge into one when the game loads.

### How many, and where

The measured median across 50 shipped maps is **8.5 metal spots per player**, and the sensible band for a
team map is **6 to 11 per player**. 1v1 maps run far richer — 10 to 16 per player — because both players
have to expand across the whole map.

The layout grammar almost every BAR team map uses, per player:

| Zone | Count | Value | Notes |
| --- | --- | --- | --- |
| Base | 3–4 | 1.8–2.3 | Inside the start box, on flat ground, close enough to wall in with one LLT line. |
| Expansion | 2–3 | 1.8–2.3 | One step out; reachable in under 30 seconds by a T1 constructor. |
| Contested / middle | 1–3 shared | 2.0, or a double at 4.0–4.3 | On or beside the main chokepoint. Often paired with a geo vent. |
| Risk | 0–1 | 4.0+ | Behind a cliff, on an island, or within artillery range of the enemy. |

A standard spot is worth **2.0 metal per second** to a T1 extractor — that is BAR's own metal brush default,
and the median across the 50 sampled maps is 1.99. Different values are how a map tells players where to
fight, but uniform-value maps are a legitimate style too: Ravaged, Cells and Tundra all use essentially one
value everywhere.

Pace the expansion. A T1 tank moves about 75 elmos per second, so the first ring of expansion spots should
be 600 to 1500 elmos from the start — 8 to 20 seconds away. A map with no metal in that band has a dead
first three minutes.

### Metal and water

A spot underwater is not automatically dead, but it is restricted. The T1 extractor has no depth limit at
all and works at any depth; the cloaked T1 caps at 20 elmos; T2 splits into a land version capped at 20 and
an underwater version that *requires* at least 15. So **a spot deeper than 20 elmos is a plain-T1-only spot
until the player has naval tech** — a real balance lever, and one that is easy to pull by accident.

---

## 6. Start positions and symmetry

### Use 180-degree rotation

BAR's own map generator weights its symmetry choices from a scan of 202 shipped maps
(`newmap_archetypes.lua`), and the shares are lopsided:

| Symmetry | Share of the 202 scanned maps |
| --- | --- |
| **Rotational 180°** | **70.9%** |
| Mirror across X | 13.6% |
| Mirror across Z | 11.8% |
| Rotational 90° | 3.6% |

Rot180 dominates for a concrete reason: it makes distance to the contested middle automatically equal for
both sides. With mirror symmetry you have to check it yourself, and you inherit a handedness problem — a
ramp that turns right on one side turns left on the other, which is a real asymmetry for units that have to
turn. Use mirror symmetry when you want both halves to *read* identically, which is mostly a tournament 1v1
concern. Use rot90 for four-way FFA and 2v2v2v2, and accept that the middle is hard to make coherent.

**Mirror all four layers together**: heightmap, metal map, terrain type map and feature placement. A
mirrored heightmap with a hand-placed extra rock on one side is the single most common source of "this side
is better" complaints. Terrasmith's symmetry overlay shows you where the map deviates from the symmetry you
declared, which is the quickest way to catch a layer you forgot.

### What each start needs

1. **The same metal, at the same distance.** Same number of base spots, same total worth. Players compare
   this immediately.
2. **The same terrain class.** The slope bands have to mirror too. A symmetric heightmap with an
   asymmetric type map is a classic imbalance bug.
3. **A buildable pad inside the start box.** At least 96x96 elmos within ±10.7 — BAR's pregame build UI
   assumes the commander can place a lab straight away.
4. **Distance from the other bases.** At least **1400 elmos** between start positions on a team map, and
   **2500** on a 1v1 — the thresholds BAR's own map checklist uses. 1400 is not arbitrary: it is the range
   of a T2 Annihilator, so anything closer means one player's static defence already covers their
   neighbour's base. Note that this is a floor, not safety: a Big Bertha reaches 4650 elmos, and no
   sensible base spacing puts a map out of its range.
5. **One or two ramps per base.** Zero ramps is unplayable; four or more is undefendable. Make each ramp
   generously wide — around 150 elmos is a reasonable default — or units will conga-line into it and die.
6. **A ridge that breaks line of sight**, so a base is not visible from the front without scouting, and a
   clear straight back edge where players park nano farms and T2 economy.

### Start boxes

Start boxes are lobby-side, not part of the map file: they live in BAR's `maps-metadata` repository in a
normalised 0–200 space on both axes, scaled by `mapSizeX / 200`. On a 16x16 map one box unit is 40.96 elmos.

**Ship rectangles.** Across all 225 curated maps there are 936 two-point rectangles and 8 polygons. The
rectangle is the only shape the engine, SPADS and the lobby servers all understand directly.

Ship **several sets**, keyed by team count: typically 2 teams for 1v1, 2 teams with 4 and with 8 players per
box for team games, plus a 4-way arrangement for FFA. The lobby picks the set matching the team count, and
falls back to the nearest larger and then the nearest smaller — so a missing set does not break anything,
but it may hand players a box shaped for a different game.

---

## 7. Water

### Depth is the only thing that matters

Depth is just negative height, and every naval rule keys off specific depths:

| Depth below 0 | What changes |
| --- | --- |
| 0 to −4 | Nothing. Ground units unaffected. |
| −4 to −8 | Ground units slow down progressively. Still too shallow for ships. |
| **−8** | **Ships float.** Destroyers, cruisers, PT boats, sea constructors. |
| −8 to −15 | Small and medium ships, hovers, wading bots and tanks all share this band. |
| **−15** | **Submarines and capital ships.** Also the T2 underwater extractor. |
| **−20** | **Hard limit for ground units.** Deeper than this, no tank or bot can wade. |
| deeper than −20 | Ships, submarines, hovers, amphibians and air only. |

So the shape of your shoreline decides what kind of fight happens there. A coast that drops from 0 to −25
inside one 8-elmo heightmap square is a hard land/sea boundary with nothing in between. A coast that
spends 100 or more elmos between −4 and −20 is a wide amphibious contest zone where hovers and wading bots
have a distinct role. Both are valid. Pick one deliberately.

### Channels

Ship pathing blocks on any point that rises above the ship's minimum depth, so a channel that dips to −6
anywhere will hard-stop a fleet that could otherwise pass. Dredge navigable channels to **at least 20 elmos
deep and 200 elmos wide** — a battleship is 136 elmos across.

### Tidal strength

Tidal generators produce energy equal to `tidalStrength` exactly: at 20, one tidal is 20 energy per second
for 90 metal, which is about 1.7 times a solar collector's metal efficiency and safe from air raids until
T2. That is why **20 is BAR's convention** — 67 of the 225 curated maps use it, 37 use 15, and BAR's
checklist asks for a value between 0 and 25.

One trap: `armtide` requires water **at least 20 elmos deep**. A map with a uniform 10-elmo shelf has a
tidal strength nobody can ever collect. If you want tidals to be usable, author a contiguous area at least
20 elmos deep inside each player's reach.

Set tidal strength to 0 on a map with no water, so players do not waste metal discovering there is nothing
to build on.

### What makes a water map good

Good:

- Land and sea both matter — roughly 30% or more of the metal reachable only by sea or amphibian, and 50%
  or more on land.
- Navigable channels at least 200 elmos wide and 20 deep, connected, so a fleet can flank.
- Shallows between −8 and −20 around the islands, so hovers and amphibians have their own role.
- Tidal strength 15 to 25, so the naval investment pays back.
- A land bridge or a narrow isthmus, so land armies can still contest something.

Bad:

- A moat nobody can cross: deep water, no land route, no bridge. The game becomes two parallel solitaires.
- Water shallower than 8 elmos everywhere. Ships cannot even leave the shipyard and the entire naval tree
  is dead.
- Tidal strength 0 on a map that is half water.
- Deep water immediately next to a base pad. Enemy destroyers outrange everything you can build there and
  shell the base from turn one.

There is one more lever worth knowing about and being careful with: water damage. At 2000 it makes water
completely impassable to ground units; at 20000 hovers cannot cross either. That is how lava maps are made,
and it is also how a mapper who sets it to 5000 "for flavour" silently deletes amphibious play.

---

## 8. Moving to the node graph

The guided form is a curated set of controls over a real node graph, not a separate simple engine. It walks
four steps — **Landform**, **Weathering**, **Shaping**, **Height and water** — and each control in them is
one parameter of one node the template already placed. When you run out of form, switching to the graph
shows you exactly what the form was driving: the same nodes that are in the palette, wired the way a person
would wire them. Open a template's graph early, even if you do not intend to edit it; the templates are the
clearest documentation the catalog has.

Every node's reference page is in [NODES.md](NODES.md). The categories:

| Category | What lives there |
| --- | --- |
| **Generator** | Where terrain comes from: Noise, Gradient, Plateaus, Constant, and Import heightmap for anything made elsewhere. No inputs. |
| **Layout** | Terrain from what you drew rather than from a seed: a Layout of shapes, and the nodes that turn it into a ridge, a river, a flat pad, a mask or a distance field. |
| **Filter** | Reshaping existing terrain: Smooth, Sharpen, Terrace, Curve, Remap, Clamp, Transform, Warp, Flatten, Sea level. |
| **Combiner** | Putting two terrains together: Combine, Blend, Height split. |
| **Selector** | Turning terrain into a 0–1 mask: by height, slope, water flow, curvature or shelter. |
| **Natural** | Simulations: Water erosion, Slumping, Snow. The expensive ones, and the ones that matter most. |
| **Gameplay** | The nodes that know BAR's rules rather than just geometry: Symmetry, Passability, Build pads, Metal spots, Carve ramp. |
| **Output** | What the exporter reads: Height, Texture, Metal, Terrain type, and the shading maps. |
| **Utility** | Plumbing: Number, Math, Measure, Reroute. |

### The four connections that do most of the work

**1. The spine.** Almost every map is this chain:

```
Noise → Water erosion → Remap height → Sea level → Height output
```

Noise makes the landform. Water erosion makes it look like somewhere rather than like a heightfield —
it is the single biggest thing you can do to stop terrain looking procedural. Remap sets how tall the map
is. Sea level decides how much of it is underwater and shifts the terrain so the shoreline lands on height
0, where BAR's water is. Height output is what gets built.

**2. Two noises into Combine on Maximum.** One broad Noise for the landform, one at a smaller feature size
for detail, joined with `Combine → Add`. Swap the operation to `Maximum` and you get something different
and very useful: a mountain range dropped into rolling hills without flattening either one, because Maximum
keeps whichever terrain is higher at each point.

**3. A selector into a Mask input.** Every filter that changes heights has an optional Mask input, and
every selector outputs exactly the kind of field a mask wants — so any selection can drive any effect.
(The two exceptions are Transform and Sea level, which move the whole terrain and have nothing sensible to
do with a partial mask.) This is the connection that turns a graph from "one shape" into a map:

- `Select by slope (0° to 10°) → Flatten.Mask` — make the nearly-flat ground properly flat.
- `Select by height → Smooth.Mask` — soften only the lowlands, leave the peaks sharp.
- `Sea level.Land → Snow.Mask` — no snow on the sea.

**4. A mask into Hardness.** Water erosion and Slumping both take a 0–1 Hardness field where 0 is
unerodible rock. Feeding a mask of your build pads into Hardness — via `Math: one minus`, since the mask
marks what you want *protected* — lets you erode the whole map without eating the flat ground the map needs.

Two more worth knowing: the erosion nodes output **Flow**, **Wear** and **Deposit** alongside the terrain,
which are what make a texture look like water has been over it; and the Sea level node outputs a **Land**
mask for free, which saves you building one.

### Things that will save you time

- **Feature sizes are real distances.** "Feature size 2048" means hills roughly 2048 elmos wide, not a
  frequency. The same setting means the same thing whether you are previewing or building.
- **The preview is honest.** Every generator samples a continuous domain, so what you see at preview
  resolution is what you build at full resolution, with more detail. Erosion is the exception, and
  Terrasmith handles it by running the simulation on a grid chosen from the erosion's own feature scale
  rather than from whatever grid the preview is on — so the erosion you preview is the erosion you get.
- **Anything can drive anything.** Heights, masks, flow and wear are all the same kind of data, so there is
  no conversion node to look for. If an output plugs into an input, it will work.
- **Bypass a node** rather than deleting it while you are experimenting — its first input passes straight
  to its first output and the rest of the graph is untouched.

---

## 9. Exporting

Building produces a `.sd7` archive. From the command line:

```bash
node packages/cli/dist/cli.js build my-map.terrasmith --quality final
```

The quality levels cap the resolution the graph is evaluated at: draft 513 samples, standard 1025, final
4097. A draft answers "is the shape right" and is fast enough to iterate on; the heightfield is upsampled to
the map's real resolution afterwards. Build draft while you are working, and build final once before you
ship.

### Set the height range before you ship

The `.smf` stores heights as 16-bit integers spread across the range you declare, so the whole map is
quantised into 65536 steps between the minimum and maximum height. If you declare −1000 to 2000 for terrain
that only spans −80 to 320, you have thrown away most of your precision, and it shows as faint terracing on
gentle slopes. The build warns you if the terrain fills less than half its declared range. Fix it on the
Height output node: either leave *Fit range to terrain* on, or set the numbers to match what you actually
have.

### What ends up in the archive

```
MyMap.sd7
  maps/MyMap.smf                  heightmap, type map, metal map, minimap, tile indices, features
  maps/MyMap.smt                  the deduplicated DXT1 tiles the texture is made of
  maps/MyMap_specular.dds         the specular map; its presence turns on the engine's advanced shading
  maps/*_dnts.dds                 four tiling detail normals the shader blends over the diffuse
  maps/MyMap_splat.dds            the four-channel splat weights, when a Splat output is connected
  mapinfo.lua                     name, version, height range, water, wind, tidal, metal, start positions
  maphelper/mapinfo.lua           a one-line back-compat shim every shipped BAR map still includes
  mapconfig/map_metal_layout.lua  the metal spot list, when the project has spots
  mapconfig/map_metadata.json     the maps-metadata record: start boxes, spots, tags
  README.md
```

Three naming rules the engine enforces, all handled for you but worth knowing when something goes wrong:

- The map's **springname** — the name BAR and every lobby server know it by — is `name .. " " .. version`
  from `mapinfo.lua`. It is not the filename. If the map shows up in the lobby under a name you did not
  expect, that is where it came from.
- `mapinfo.mapfile` must point at the actual `.smf`, and the `.smt` name stored inside the `.smf` must
  match the actual file in `maps/`. Renaming anything after a build is how you get a pink map.
- **The archive must not be solid.** A solid `.sd7` still loads today — the engine's own rejection of it is
  dormant on current Recoil master, and all you lose is that `mapinfo.lua` costs a full decompression — but
  BAR's CI checks solidity independently and the whitelist is empty, so a solid archive simply will not get
  into the map pool. Terrasmith always writes non-solid.

Do not ship your source files. World Machine `.tmd` projects and source PNGs inside the archive are pure
weight — several shipped BAR maps carry megabytes of them by accident, and BAR's own upload form has a
separate field for the `.tmd` precisely so it does not have to go in the map.

### Test it

Copy the `.sd7` into the `maps/` folder of your BAR data directory and launch BAR. An unpacked `MyMap.sdd/`
directory works too and saves the packing step while you iterate.

Then actually play it, or at least drive units around it. Terrasmith's validator catches the mechanical
problems — unreachable pockets, pads too small for a lab, metal blobs that will not resolve, asymmetry —
but it cannot tell you whether the map is any good.

---

## 10. Getting the map into BAR's map pool

Maps in BAR's rotation are curated. The process is documented in the `maps-metadata` wiki and in BAR's own
guides; this is the shape of it.

**Step 0 — get it reviewed.** Post in the BAR Discord `#mapping` channel: create a thread, attach and keep
the current map files there, and ping the `@mapper` role. Iterate on the feedback, then ask for a formal
review. **At least two reviewers must weigh in** for approval, and IceXuick breaks ties. Run the public
[Map Checklist](https://www.beyondallreason.info/guide/map-checklist) on your own map first — it is the
standard the reviewers use, and it has around 35 items.

**Step 1 — upload the archive.** Either to <https://springfiles.springrts.com/>, which makes it available
across every Recoil/Spring game, or directly to BAR's CDN by uploading to the
`bar-springfiles-syncer_assets-upload` Google Cloud Storage bucket, which every member of BAR's Google
Group can write to. The springname must be exact and unique; the CDN refuses ambiguous lookups.

**Step 2 — add a row in Rowy.** Sign in at <https://rowy.beyondallreason.dev/>. You will be a viewer by
default and need an editor role, which Marek, Nikuksis, Beherith or IceXuick can grant. Start with the
**spring name** column: filling it in triggers a parser that downloads your archive, reads it, and fills in
several fields automatically. Wait for it to say Done, then fill in the rest — author, a top-down photo of
at least 1024 pixels **whose aspect ratio matches the map's**, terrain tags, game type, team and player
counts, the start boxes (there is a graphical editor; remember to press save), and Certified, which all new
maps should be.

**Step 3 — open the pull request.** There is an "Open PR" button in the last column of your row. It
generates a pull request against the `maps-metadata` repository. If you forget, automation opens one with
everything pending every 24 hours.

**Step 4 — CI checks it.** The validations that can block you: the archive must be non-solid; the archive
must contain a `mapinfo.lua`; the photo's aspect ratio must match the map's dimensions; the start boxes and
start positions must validate against the schema. One more that is easy to miss: **`tidalStrength` has no
default** in the metadata build, so it must be present in your `mapinfo.lua` or the build fails. Terrasmith
writes it from the project's water settings, which default to 20.

**Step 5 — nothing.** Once a curator merges the PR, automation pushes the map to the CDN, to the lobby's
map details, to SPADS, to Teiserver and to the website. It is playable within a few minutes.
