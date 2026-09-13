# BAR Gameplay Constraints That Shape Good Maps

> **Purpose.** Everything a map-builder tool needs to know about *Beyond All Reason* gameplay in order to
> guide a beginner toward a **good** map, not merely a *valid* one. Every number below is quoted from
> engine source (Recoil), BAR game source, BAR's published map metadata, or from SMF archives of real
> shipped maps that I parsed byte-by-byte while writing this. Citations are inline as
> `repo:path:line`.
>
> Primary sources:
> - **Engine**: <https://github.com/beyond-all-reason/RecoilEngine> (`RE:` prefix below)
> - **Game**: <https://github.com/beyond-all-reason/Beyond-All-Reason> (`BAR:` prefix)
> - **Map metadata**: <https://github.com/beyond-all-reason/maps-metadata> (`MM:` prefix)
> - **Map template**: <https://github.com/beyond-all-reason/map_blueprint> (`BP:` prefix)
> - **Live metadata CDN**: <https://maps-metadata.beyondallreason.dev/latest/lobby_maps.validated.json>
>   (225 curated maps, fetched 2026-09-13)

---

## 0. TL;DR for the implementer

| Thing | Value |
|---|---|
| Elmo | the world unit. 1 heightmap square = **8 elmos** (`SQUARE_SIZE`) |
| Spring "map size" unit | **512 elmos** = 64 heightmap squares |
| Legal map dimensions | `mapx`, `mapy` divisible by 128 → map size units are **even integers** |
| BAR accepted sizes | 6–32 units per axis; **≤ 32 in any dimension** (hard BAR policy) |
| Most common sizes | 16×16 (36 maps), 24×24 (21), 20×20 (21), 14×14 (14), 12×12 (12) |
| Diffuse texture | exactly **1 texel per elmo** → `sizeUnits × 512` px square-ish |
| Metal map resolution | 1 sample per **16×16 elmos** (`METAL_MAP_SQUARE_SIZE = SQUARE_SIZE*2`) |
| Type map resolution | 1 sample per **16×16 elmos** |
| Slope map resolution | 1 sample per **16×16 elmos** (`hmapx = mapx/2`) |
| BAR extractor radius | **90 elmos** on every real BAR map I checked (engine default is 500) |
| Standard metal spot | T1 mex income ≈ **1.8 – 2.3 metal/s**; brush default is **2.0** |
| Standard tidal | **20** (67 of 225 maps); range 0–25 |
| Standard wind | `minWind` 0–6, `maxWind` 12–25; BAR checklist says **0–30** |
| Symmetry in the wild | rot180 **70.9 %**, mirrorX 13.6 %, mirrorZ 11.8 %, rot90 3.6 % |

---

## 1. Units, coordinates, and the SMF container

### 1.1 The elmo

```c
// RE:rts/Sim/Misc/GlobalConstants.h:24
static constexpr int SQUARE_SIZE = 8;              // 1 heightmap square = 8 elmos
// RE:rts/Sim/Misc/GlobalConstants.h:17
static constexpr int SPRING_FOOTPRINT_SCALE = 2;   // a "TA footprint unit" = 2 squares = 16 elmos
// RE:rts/Sim/Misc/GlobalConstants.h:45
static constexpr float ELMOS_TO_METERS = 1.0f / SQUARE_SIZE;   // 8 elmos ≈ 1 "metre"
// RE:rts/Sim/Misc/GlobalConstants.h:52
static constexpr int GAME_SPEED = 30;              // sim frames per second
// RE:rts/Map/MetalMap.h:11
static constexpr float METAL_MAP_SQUARE_SIZE = SQUARE_SIZE * 2;  // = 16 elmos
```

Derived ladder (memorise this):

| Quantity | Elmos | Heightmap squares | Map-size units |
|---|---|---|---|
| 1 heightmap square | 8 | 1 | 1/64 |
| 1 footprint unit / metal square / type square / slope cell | 16 | 2 | 1/32 |
| 1 texture tile (32 px, `tileScale = 4`) | 32 | 4 | 1/16 |
| 1 LOS cell (BAR `losMipLevel = 3`) | 64 | 8 | 1/8 |
| 1 radar cell (BAR `radarMipLevel = 2`) | 32 | 4 | 1/16 |
| 1 air-LOS cell (BAR `airMipLevel = 4`) | 128 | 16 | 1/4 |
| **1 map-size unit** | **512** | **64** | 1 |

LOS/radar cell size is `mipDiv = SQUARE_SIZE * (1 << mipLevel)` — `RE:rts/Sim/Misc/LosHandler.cpp:87`.
BAR's mip levels: `BAR:gamedata/modrules.lua:59-62`.

`Game.mapX` exposed to Lua is literally `mapDims.mapx / 64` — `RE:rts/Lua/LuaConstGame.cpp:162` — which is
the canonical definition of the "map size" number players quote ("a 16×16 map").

### 1.2 SMF header — exact struct

From `RE:rts/Map/SMF/SMFFormat.h:49-70`. All fields little-endian, no padding (80 bytes total).

| Offset | Type | Field | Notes |
|---:|---|---|---|
| 0 | `char[16]` | `magic` | `"spring map file\0"` |
| 16 | `int32` | `version` | must be 1 |
| 20 | `int32` | `mapid` | arbitrary GUID-ish |
| 24 | `int32` | `mapx` | **must be divisible by 128** |
| 28 | `int32` | `mapy` | **must be divisible by 128** |
| 32 | `int32` | `squareSize` | must be 8 |
| 36 | `int32` | `texelPerSquare` | must be 8 |
| 40 | `int32` | `tilesize` | must be 32 |
| 44 | `float` | `minHeight` | world height of heightmap value `0x0000` |
| 48 | `float` | `maxHeight` | world height of heightmap value `0xffff` |
| 52 | `int32` | `heightmapPtr` | → `uint16[(mapy+1)*(mapx+1)]` |
| 56 | `int32` | `typeMapPtr` | → `uint8[(mapy/2)*(mapx/2)]` |
| 60 | `int32` | `tilesPtr` | → `MapTileHeader` |
| 64 | `int32` | `minimapPtr` | → 699048 bytes, DXT1 1024² + 8 mips |
| 68 | `int32` | `metalmapPtr` | → `uint8[(mapx/2)*(mapy/2)]` |
| 72 | `int32` | `featurePtr` | → `MapFeatureHeader` |
| 76 | `int32` | `numExtraHeaders` | |

Then `numExtraHeaders` × `ExtraHeader { int32 size; int32 type; ... }`
(`RE:rts/Map/SMF/SMFFormat.h:82-85`). The only one in the wild is
`MEH_Vegetation = 1` (`size = 12`, followed by an `int32` pointer to a
`uint8[(mapx/4)*(mapy/4)]` grass map; `0 = none, 1 = grass`).

**Height decode** (`RE:rts/Map/SMF/SMFReadMap.cpp:157`):

```
height = minHgt + raw_u16 * (maxHgt - minHgt) / 65536.0f
```

Note the divisor is **65536, not 65535**, so `0xffff` never quite reaches `maxHeight`.

**Height override gotcha** (`RE:rts/Map/SMF/SMFReadMap.cpp:146-147`, `RE:rts/Map/MapInfo.cpp:405-409`):
if `mapinfo.lua` contains `smf = { minheight = …, maxheight = … }`, those **override** the SMF header
values. Real maps rely on this — Altair Crossing's header says `-50 … 100` but its `mapinfo.lua` says
`-125 … 875`. **Your writer must keep the two in sync or deliberately use the override**; a mismatch
silently rescales the whole terrain.

`MapFeatureStruct` (`RE:rts/Map/SMF/SMFFormat.h:147-156`) is **24 bytes**:
`int32 featureType; float xpos, ypos, zpos, rotation, relativeSize;`
`rotation` is in the range −32768…32767 for a full circle; `relativeSize` is unused, keep 1.

### 1.3 Worked layout, verified against a real shipped map

`Altair_Crossing_V4.smf` (BAR map "Altair Crossing", 8×8, 2–6 players). Parsed values:

```
mapx = mapy = 512, squareSize = 8, texelPerSquare = 8, tilesize = 32
minHeight(header) = -50, maxHeight(header) = 100, numExtraHeaders = 1
```

| Offset | Size (bytes) | Contents |
|---:|---:|---|
| 0 | 80 | SMFHeader |
| 80 | 12 | ExtraHeader `{size=12, type=1 (vegetation), ptr=92}` |
| 92 | 16 384 | grass map, `(512/4)² = 128²` |
| 16 476 | 526 338 | heightmap, `(512+1)² × 2` |
| 542 814 | 65 536 | type map, `(512/2)² = 256²` |
| 608 350 | 699 048 | minimap (fixed `MINIMAP_SIZE`) |
| 1 307 398 | 65 536 | metal map, `256²` |
| 1 372 934 | 8 + 4 + 30 + 65 536 | `MapTileHeader{numTileFiles=1, numTiles=16384}`, `int32 16384` + `"Altair_Crossing_V4.smt\0"`, then `int32[128×128]` tile indices |
| 1 438 505 | 8 + names + 2×24 | `MapFeatureHeader{numFeatureType=18, numFeatures=2}`, 18 names (`TreeType0..15`, `GeoVent`, `geovent`), then 2 `geovent` features |
| — | 1 438 743 | file size |

Every offset above is arithmetic from `mapx`/`mapy` — there is no slack. This is a good self-test for a
writer.

### 1.4 Size conversion table

`texels = mapx × texelPerSquare = mapx × 8 = sizeUnits × 512` → **the diffuse texture is exactly
1 texel per elmo.**

| Size (units) | `mapx`=`mapy` | Elmos | Heightmap samples `(mapx+1)²` | Heightmap bytes | Diffuse texture (px) | Tile grid `mapx/4` | Max unique tiles | Metal/type map | Minimap |
|---|---|---|---|---|---|---|---|---|---|
| 8×8 | 512 | 4 096 | 513² = 263 169 | 526 338 | 4 096² | 128² | 16 384 | 256² = 65 536 | 699 048 |
| 10×10 | 640 | 5 120 | 641² = 410 881 | 821 762 | 5 120² | 160² | 25 600 | 320² = 102 400 | 699 048 |
| 12×12 | 768 | 6 144 | 769² = 591 361 | 1 182 722 | 6 144² | 192² | 36 864 | 384² = 147 456 | 699 048 |
| 14×14 | 896 | 7 168 | 897² = 804 609 | 1 609 218 | 7 168² | 224² | 50 176 | 448² = 200 704 | 699 048 |
| 16×16 | 1 024 | 8 192 | 1025² = 1 050 625 | 2 101 250 | 8 192² | 256² | 65 536 | 512² = 262 144 | 699 048 |
| 18×18 | 1 152 | 9 216 | 1153² = 1 329 409 | 2 658 818 | 9 216² | 288² | 82 944 | 576² = 331 776 | 699 048 |
| 20×20 | 1 280 | 10 240 | 1281² = 1 640 961 | 3 281 922 | 10 240² | 320² | 102 400 | 640² = 409 600 | 699 048 |
| 24×24 | 1 536 | 12 288 | 1537² = 2 362 369 | 4 724 738 | 12 288² | 384² | 147 456 | 768² = 589 824 | 699 048 |
| 28×28 | 1 792 | 14 336 | 1793² = 3 214 849 | 6 429 698 | 14 336² | 448² | 200 704 | 896² = 802 816 | 699 048 |
| 32×32 | 2 048 | 16 384 | 2049² = 4 198 401 | 8 396 802 | 16 384² | 512² | 262 144 | 1024² = 1 048 576 | 699 048 |

**`.smt` size:** `32 + numTiles × 680` bytes (`SMALL_TILE_SIZE = 512+128+32+8 = 680`,
`RE:rts/Map/SMF/SMFFormat.h:27`). Altair's smt with zero dedup: `32 + 16384×680 ≈ 10.6 MiB`. A 24×24 map
with no dedup would be `147456 × 680 ≈ 95 MiB` — which is why big BAR maps are 100–150 MB downloads
(Supreme Isthmus v2.1 is 144 MB). **Tile dedup is the single biggest lever on archive size.**

---

## 2. Map sizes BAR actually uses

### 2.1 Hard policy

> "Maps larger than **32x32** or **32 in any dimension** will not be accepted."
> — BAR Map Checklist, <https://www.beyondallreason.info/guide/map-checklist>

`mapx` must be divisible by 128 (`RE:rts/Map/SMF/SMFFormat.h:53`), so the size unit count is always
**even**. All 225 curated maps have even sizes; the smallest is 6×4 and the largest 32×32.

### 2.2 Observed distribution (225 curated maps, `lobby_maps.validated.json`)

| Size | Count | Representative maps (playerCountMin–Max) |
|---|---:|---|
| 8×8 | 6 | Altair Crossing (2–6), Avalanche (2–2), Geyser Plains (2–4), The Desert Triad (2–3) |
| 10×10 | 7 | Ravaged (2–2), Titan Duel (2–4), Copper Hill (2–4), Glacier Pass (2–4) |
| 12×12 | 12 | Faster Than Light (2–4), Mithril Mountain (2–4), Into Battle Redux (2–4), Devil's Postpiles (2–8) |
| 14×14 | 14 | Canis River (2–8), Aurelia (2–4), Theta Crystals (2–8), Pools of Ilys (2–6), Isidis Crack (2–8) |
| 16×16 | **36** | Archsimkats Valley (2–12), Tundra (2–8), Altored Divide (6–10), Hades Ponds (8–16), Sunderance (10–16) |
| 18×18 | 8 | Cloud9 (4–9), Forge (12–16), Mariposa Island (12–16), Painted Desert (2–8) |
| 20×20 | **21** | Cells (8–16), Erebos Lakes (8–16), Pawn Retreat (8–16), Tempest (12–16), Thermal Shock (12–16) |
| 20×16 | 9 | Hera Planum, Kings Assault, Salmiakki, Salt Reef, The Rock (all ~10–16) |
| 24×16 | 7 | Koom Valley, Esker Creek, Seven Rivers, Swirly Rock, Bismuth Valley (12–16) |
| 24×24 | **21** | Ascendancy, Carrot Mountains, Darkside, Riverrun, Sulphur Springs, The Tartar Steppe (12–16); Adamantium Factory (16–64 FFA) |
| 28×28 | 4 | Krakatoa (12–16), DWorld (10–16), Proving Grounds (4–16), Project SD-129 (4–32) |
| 32×32 | 5 | Jade Empress (16), Mediterraneum (10–32), Nine Metal Islands (9–18), Special Hotstepper (2–100) |

Asymmetric (non-square) sizes are common and legitimate — 20×16, 24×16, 20×12, 20×10, 18×12 — and are the
canonical shape for **lane maps** where two teams face across the short axis.

### 2.3 Player-count guidance (derived from the curated pool)

| Format | Recommended size | Elmos | Rationale from real maps |
|---|---|---|---|
| **1v1 (competitive)** | **10×10 → 14×14** | 5 120 – 7 168 | The `competitive2p` list clusters at 12×12–16×16; the `tourney2p` list at 12×12–16×16. Pure duel maps (Ravaged, Avalanche, Argent Strata, Onyx Cauldron) are 10×10–16×16. |
| **2v2 / 3v3** | **12×12 → 16×16** | 6 144 – 8 192 | Devil's Postpiles 12×12 (2–8), Canis River 14×14 (2–8), Boreal Falls 14×14 (2–6) |
| **4v4 / 5v5** | **16×16 → 18×18** | 8 192 – 9 216 | Altored Divide 16×16 "optimal for 2 teams, up to 5 players each"; Cloud9 18×18 (4–9) |
| **8v8 (the BAR default team game)** | **20×16, 20×20, 24×16, 24×24** | 10 240 – 12 288 | The entire `popular16p` list (40 maps) lives here; 18 of 21 24×24 maps are 12–16 players |
| **Big team (10v10+)** | **24×24 → 32×32** | 12 288 – 16 384 | Adamantium Factory 24×24 (up to 64), Mediterraneum 32×32 (up to 32) |
| **FFA (3–8 way)** | **16×16 → 24×24** | 8 192 – 12 288 | 74 maps carry the `ffa` tag; 4-corner startboxes on 16×16–24×24 dominate |
| **PvE / Raptors / Scavengers** | **20×20 → 32×32** | | 32 maps carry the `pve` tag; big open maps favour defence lines |

**Rule of thumb that matches the data — area per player, in map-size-units²** (`sizeX × sizeZ / maxPlayers`):

| Format | Observed range | Examples |
|---|---|---|
| **Team (8v8, 16 players)** | **14 – 36 u²/player**, median ≈ 22 | Tabula 16×14 = 224/16 = **14**; Hera Planum 20×16 = 320/16 = **20**; Koom Valley 24×16 = 384/16 = **24**; Cells 20×20 = 400/16 = **25**; Supreme Isthmus 24×24 = 576/16 = **36** (the roomy end) |
| **Small team (6–10 players)** | 20 – 35 u²/player | Altored Divide 16×16 = 256/10 = **26**; Cloud9 18×18 = 324/9 = **36** |
| **1v1 (2 players)** | **50 – 128 u²/player** | Ravaged 10×10 = 100/2 = **50**; Avalanche 8×8 = 64/2 = **32**; Argent Strata 16×16 = 256/2 = **128** |

1v1 maps are 2–5× more generous per player because each player must expand across the whole map alone.
A generator targeting "8v8" should aim at **≈ 20–25 u²/player**, i.e. 320–400 u² total, i.e. 20×16 to 20×20.

### 2.4 Startbox geometry

BAR stores startboxes in a **0…200 normalised space** (`MM:schemas/map_list.yaml`, `$defs.startboxRect`),
converted with `scaleX = Game.mapSizeX / 200` (`BAR:luarules/gadgets/include/startbox_utilities.lua:168-169`).
So **1 startbox unit = mapSizeX/200 elmos** — on a 16×16 map that is 40.96 elmos.

Two shapes: a 2-point axis-aligned rect (legacy; the only shape SPADS/TEIServer understand) or a ≥3-point
Catmull-Rom polygon with per-point `strength ∈ [0,1]`.

Observed startbox-set shapes across the 225 maps (teams × maxPlayersPerStartbox):

| Teams | Most common `maxPlayersPerStartbox` | Count |
|---|---|---|
| 2 | 8 | 86 |
| 2 | 2 / 4 / 3 | 29 / 29 / 26 |
| 4 | 4 | 10 |
| 4 | 1 (FFA corners) | 8 |
| 16 | 1 (full FFA) | 6 |

A well-formed BAR map ships **several** startbox sets: typically `2 teams × 1` (for 1v1), `2 × 4`,
`2 × 8`, plus a `4 × 1` or `4 × 4` FFA arrangement. The lobby selects by team count
(`BAR:luarules/gadgets/include/startbox_utilities.lua`, `matchSetExact` / `matchSetLarger`).

---

## 3. Reference distances — overlay these on the canvas

All in elmos. Ranges are `weapondefs[*].range`; `speed` in BAR unitdefs is **elmos per second**
(`RE:rts/Sim/Units/UnitDef.cpp:442-443`: `speed = udTable.GetFloat("speed", |maxVelocity| * GAME_SPEED)`).

| # | Thing | Elmos | Source |
|---|---|---:|---|
| 1 | Heightmap square | 8 | `SQUARE_SIZE` |
| 2 | Metal / type / slope cell | 16 | `METAL_MAP_SQUARE_SIZE` |
| 3 | **Commander build range** | **145** | `BAR:units/armcom.lua:5` `builddistance` |
| 4 | Commander D-gun range | 250 | `armcom.lua:270` |
| 5 | Commander laser range | 300 | `armcom.lua:189` |
| 6 | Commander sight / radar | 450 / 700 | `armcom.lua:51,42` |
| 7 | **Extractor radius (BAR maps)** | **90** | every real `mapinfo.lua` checked |
| 8 | Pawn (T1 raider bot) range | 180 | `BAR:units/ArmBots/armpw.lua:119` |
| 9 | Stumpy (T1 tank) range | 350 | `BAR:units/ArmVehicles/armstump.lua:119` |
| 10 | Hammer / Thud (T1 arty bot) range | 380 | `armham.lua:114`, `corthud.lua` |
| 11 | **LLT (Light Laser Tower)** | **430** | `BAR:units/ArmBuildings/LandDefenceOffence/armllt.lua:114` |
| 12 | Rocko (T1 rocket bot) | 475 | `armrock.lua` |
| 13 | HLT (Sentry / heavy laser) | 620 | `armhlt.lua:112` |
| 14 | Fido (T2 assault bot) / Goliath | 650 | `armfido.lua:114`, `corgol.lua` |
| 15 | Luger/Hammer arty (T1 veh arty) | 710 | `armart.lua` |
| 16 | Pit Bull (T2 turret) | 730 | `armpb.lua` |
| 17 | Doomsday Machine (T2 fort) | 950 | `cordoom.lua` |
| 18 | Merl (T2 rocket arty) | 1 300 | `armmerl.lua:115` |
| 19 | Ambusher (T2 arty turret) | 1 380 | `armamb.lua` |
| 20 | Annihilator (T2 beam fort) | 1 400 | `armanni.lua:124` |
| 21 | **Radar (Radar Tower)** | **2 100** | `BAR:units/ArmBuildings/LandUtil/armrad.lua:27` `radardistance` |
| 22 | Annihilator built-in radar | 1 500 | `armanni.lua:27` |
| 23 | Big Bertha (T2 LRPC) | 4 650 | `armbrtha.lua:121` |
| 24 | Vulcan (T3 LRPC) | 5 750 | `armvulc.lua` |
| 25 | Nano turret build range | 400 | `armnanotc.lua:3` |
| 26 | LOS cell (vision granularity) | 64 | `modrules losMipLevel = 3` |
| 27 | Radar cell | 32 | `modrules radarMipLevel = 2` |

### 3.1 Speeds → "how long is this walk?"

| Unit | `speed` (elmos/s) | Crosses 512 elmos (1 map unit) in |
|---|---:|---|
| Commander (`armcom`) | 37.5 | 13.7 s |
| Merl (T2 arty veh) | 33 | 15.5 s |
| Goliath | 39 | 13.1 s |
| Thud | 45 | 11.4 s |
| Hammer | 46.2 | 11.1 s |
| Rocko | 50.7 | 10.1 s |
| Fido | 69 | 7.4 s |
| **Stumpy (avg T1 tank)** | **75** | **6.8 s** |
| Pawn (T1 raider) | 87 | 5.9 s |
| Freedom Fighter (T1 air) | 289 | 1.8 s |

**Design consequence:** on a 16×16 map (8 192 elmos across), a T1 tank takes **~110 s** to cross corner
to edge. On a 24×24 map it takes **~165 s**. That is why BAR's big-team maps are lane-shaped: raw
traversal time, not area, is what makes a map feel sluggish.

### 3.2 Footprints → "how wide must this gap be?"

`UnitDef.xsize = footprintX × SPRING_FOOTPRINT_SCALE` (`RE:rts/Sim/Units/UnitDef.cpp:671`), in heightmap
squares → **elmos = footprintX × 16**.

`MoveDef.xsize = footprintX × 2`, then **forced odd** by subtracting 1 if even
(`RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:314-317`) → pathing footprint in elmos = `(2f − [f even? 0 : … ])`;
practically `xsize_squares × 8`.

| Structure | `footprint` | Elmos |
|---|---|---|
| LLT, radar, HLT | 2×2 | 32×32 |
| Nano turret, wind gen, tidal gen | 3×3 | 48×48 |
| Metal extractor (T1 & T2) | 4×4 | 64×64 |
| Solar, Geothermal plant | 5×5 | 80×80 |
| Bot lab / Vehicle plant | 6×6 | 96×96 |
| Fusion reactor | 6×5 | 96×80 |
| Vulcan | 8×8 | 128×128 |

| Mobile move class | pathing `xsize` (squares) | Elmos |
|---|---:|---|
| `BOT2` (Pawn, Grunt, cons) | 3 | 24 |
| `TANK3`, `BOT3` | 5 | 40 |
| `HTANK4`, `HBOT4` (Goliath, Razorback) | 7 | 56 |
| `VBOT6` (Korgoth), `HTBOT6` (Vanguard) | 11 | 88 |
| `HBOT7` (Juggernaut), `HTANK7` (Thor) | 13 | 104 |
| `BOAT9` (battleships/carriers) | 17 | 136 |

**A chokepoint narrower than ~104 elmos will refuse the largest ground units; narrower than ~56 elmos
will refuse T2 assault units.** A "one-lane" corridor for T1 wants ≥ 3× the unit footprint (≈ 120 elmos)
or units bunch and stall. A comfortable main road in BAR is **200–400 elmos wide**.

---

## 4. Slope & pathing — the "walkable by X" overlay

This is the single most useful overlay a map builder can render. Here is the exact math.

### 4.1 How the engine derives slope

1. Face normals are computed per heightmap square (2 triangles per square) — `RE:rts/Map/ReadMap.cpp:672`.
2. The **slope map** is at half heightmap resolution (`hmapx = mapx/2`, one cell per **16×16 elmos**),
   `RE:rts/Map/ReadMap.cpp:373`. For each cell (`RE:rts/Map/ReadMap.cpp:742-780`):

```c
avgslope = mean(  normal.y of the 8 triangles in the 2x2 square block )
maxslope = min (  normal.y of the 8 triangles in the 2x2 square block )   // "max slope" = min .y
lerp  = maxslope / avgslope;
slope = mix(maxslope, avgslope, lerp);        // "smooth it a bit, so small holes don't block huge tanks"
slopeMap[cell] = 1.0f - slope;                // 0 = flat, 1 = vertical
```

3. A `MoveDef`'s threshold is stored as `maxSlope = 1 - cos(deg)` — `RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:84-95`:

```c
static float DegreesToMaxSlope(float degrees) {
    const float deg = std::clamp(degrees, 0.0f, 60.0f) * 1.5f;   // <-- note the ×1.5
    return (1.0f - math::cos(deg * DEG_TO_RAD));
}
```

4. **BAR pre-divides by 1.5** so the numbers in `movedefs.lua` read as real degrees
   (`BAR:gamedata/movedefs.lua`, `setMaxSlope`):

```lua
---`maxSlope` is multiplied by 1.5 at load, so 60 degrees is its actual "maximum",
-- so has default value 15 * 1.5 = 22.5 for hovers and 90 for bots/vehicles/ships.
moveDef.maxslope = moveDef.maxslope / 1.5
```

**Net result — the overlay rule:**

> A 16×16-elmo cell is **impassable** for a move class iff the blended terrain tilt angle θ (where
> `cos θ = 1 − slopeMap`) **exceeds the `SLOPE.*` constant in degrees** taken straight from
> `movedefs.lua`.

Speed penalty when passable (`RE:rts/Sim/MoveTypes/MoveMath/GroundMoveMath.cpp:12-28`):

```c
if (slope > maxSlope)      return 0;           // impassable
if (-height > depth)       return 0;           // too deep
speedMod  = 1 / (1 + slope * slopeMod);
speedMod *= (height < 0) ? waterDamageCost : 1;
speedMod *= GetDepthMod(height);
```

With `allowDirectionalPathing = true` (BAR sets it, `modrules.lua:84`), the slope term uses
`max(0, slope * dirSlopeMod)` so **downhill is free and uphill is slow**
(`GroundMoveMath.cpp:47`).

Hover (`HoverMoveMath.cpp`): water is *free* (`speedMod = 1` if `height < 0`), otherwise the same
slope formula. Ship (`ShipMoveMath.cpp`): `if (-height < depth) return 0;` — pure depth gate, slope
is ignored.

### 4.2 BAR move classes — resolved table

`BAR:gamedata/movedefs.lua` constants:

```lua
DEPTH = { NONE=0, TICK=5, MIN_SHALLOW=8, MAX_SHALLOW=20, SUBMERGED=15, AMPHIBIOUS=5000, MAXIMUM=9999 }
SLOPE = { NONE=0, MINIMUM=27, MODERATE=33, DIFFICULT=54, EXTREME=75, MAXIMUM=90 }
SLOPE_MOD = { MINIMUM=4, MODERATE=18, SLOW=25, VERY_SLOW=36, GLACIAL=42, MAXIMUM=4000 }
CRUSH = { NONE=0, TINY=5, LIGHT=10, SMALL=18, MEDIUM=25, LARGE=50, HEAVY=250, HUGE=1400, MASSIVE=9999 }
```

Resolved to engine semantics (max slope in **real degrees**; depths in elmos):

| MoveDef | Class | fp | path width (elmos) | **max slope °** | slopeMod | min depth | max depth | sub | crush | Example units |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|
| `COMMANDERBOT` | KBot | 3 | 40 | **54** | 4 | – | 5000 (amphib) | – | 50 | All commanders |
| `SBOT2` | KBot | 2 | 24 | **54** | 4 | – | **5** | – | 5 | Flea, critters |
| `BOT2` | KBot | 2 | 24 | **54** | 4 | – | **20** | – | 15 | Pawn, Grunt, T1 cons, Fast/Spy |
| `BOT3` | KBot | 3 | 40 | **54** | 4 | – | **20** | – | 25 | Fido, Zeus, Maverick, Hrk |
| `HBOT4` | KBot | 4 | 56 | **54** | 4 | – | **20** | – | 252 | Razorback, Sumo, Fatboy, Pede |
| `HBOT7` | KBot | 7 | 104 | **54** | 4 | – | **20** | – | 1400 | Juggernaut |
| `HTBOT6` | KBot | 6 | 88 | **90 (none)** | 4 | – | **20** | – | 252 | Vanguard, Karganeth, Thermite |
| `ABOT3` | KBot | 3 | 40 | **54** | 4 | – | 5000 (amphib) | – | 50 | Crab, Commando, AAK, Amphib |
| `HABOT5` | KBot | 5 | 72 | **54** | 4 | – | 5000 (amphib) | – | 252 | Shiva, Marauder, Banisher |
| `VBOT6` | KBot | 6 | 88 | **54** | 4 | – | 5000 (amphib) | – | 1400 | Korgoth |
| `TBOT3` (spiders) | KBot | 3 | 40 | **90 (none)** | ~4 | – | **20** | – | 15 | Spider, Recluse, Tarantula, Termite |
| `NANO` | KBot | 3 | 40 | **27** | 36.4 | – | **0** | – | 0 | Nano turrets (placement only) |
| `TANK2` | Tank | 2 | 24 | **27** | 18 | – | **20** | – | 18 | Flash, Fav, Consul, Torch |
| `TANK3` | Tank | 3 | 40 | **27** | 18 | – | **20** | – | 30 | Stumpy, Janus, T1/T2 cons, Levelers |
| `MTANK3` | Tank | 3 | 40 | **27** | 25 | – | **20** | – | 250 | Reaper, Bulldog, Merl, Vac |
| `HTANK4` | Tank | 4 | 56 | **27** | 36 | – | **20** | – | 252 | Goliath, Tremor, Banisher, Manticore |
| `HTANK7` | Tank | 7 | 104 | **33** | 42 | – | **20** | – | 1400 | Thor |
| `ATANK3` | Tank | 3 | 40 | **54** | 18 | – | 5000 (amphib) | – | 30 | Beaver, Croc, Pincer, Muskrat, Garpike |
| `HOVER2` | Hover | 2 | 24 | **33** | 25 | – | n/a | – | 25 | Small hovers |
| `HOVER3` | Hover | 3 | 40 | **33** | 25 | – | n/a | – | 25 | Standard hovers, hover cons |
| `HHOVER4` | Hover | 4 | 56 | **33** | 18 | – | n/a | – | 252 | Lun, Sokolov, heavy hovers |
| `AHOVER2` | Hover | 2 | 24 | **54** | 18 | – | n/a | – | 25 | Amphib hover |
| `BOAT3` | Ship | 3 | 40 | n/a | – | **8** | – | no | 9 | Small ships, sea cons, PT boats |
| `BOAT4` | Ship | 4 | 56 | n/a | – | **8** | – | no | 9 | Destroyers, Roy, Serpent |
| `BOAT5` | Ship | 5 | 72 | n/a | – | **8** | – | no | 16 | Cruisers, missile ships, transports |
| `BOAT9` | Ship | 9 | 136 | n/a | – | **15** | – | no | 252 | Battleships, carriers, Epoch, Black Hydra |
| `UBOAT4` | Ship | 4 | 56 | n/a | – | **15** | – | **yes** | 5 | Submarines |
| `EPIC*` | mixed | 4–5 | 56–72 | 54–90 | – | 15 | 9999 | – | 9999 | T4 units |

Notes / gotchas:

- **The `1.5×` gotcha.** If you ever read `movedefs.lua` raw you'll see e.g. `maxslope = 36` for
  `SLOPE.DIFFICULT` (54/1.5). Do not mistake that for 36°. Use the `SLOPE.*` constant name.
- `SLOPE.MAXIMUM = 90` → `1 - cos(90°) = 1.0`, and `slopeMap` is `1 - normal.y ≤ 1`, so those classes
  are **never blocked by slope** (spiders, Vanguard, Korgoth-tier all-terrain).
- Ships never consult `maxSlope` at all (`MoveDefHandler.cpp:238-243`, the `Ship` branch sets only
  `depth = minWaterDepth`).
- Hovers ignore water depth entirely unless `noHoverWaterMove` (see §9.3).
- `depthModParams` (BAR's `depthModGeneric = {minHeight = 4, linearCoeff = 0.03, maxValue = 0.7}`) makes
  wading progressively slower below 4 elmos of water: `speedMod ×= 1/clamp(1 + 0.03·depth, 0.01, ∞)`
  (`RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:744-771`). At the 20-elmo wading limit that's ×0.625.
  (BAR's `maxValue` key is a typo for `maxScale` and is currently ignored — flagged `TODO` in BAR source.)

### 4.3 Practical slope thresholds for a "buildable / walkable" overlay

Render **four** bands. These are the ones that matter to a player:

| Band | Threshold | Who it gates |
|---|---|---|
| **Vehicle-flat** | ≤ **27°** | Everything drives here. This is where a player can build a base and mass tanks. |
| **Hover / heavy-tank** | ≤ **33°** | Hovers, Thor |
| **Bot-climbable** | ≤ **54°** | All bots, commanders, amphibs, hover-amphibs |
| **All-terrain only** | > 54° | Spiders, Vanguard/Karganeth, Korgoth, T4 — and air |

The BAR map checklist explicitly asks for this to be legible *in the texture*:

> "Create three distinct texture levels: vehicles on flat areas, bots on slopes, all-terrain on rocky /
> steep zones to show clear unit accessibility differences."

### 4.4 Buildability (flatness), which is a *different* rule from pathing

Immobile units are **not** slope-tested; they are **height-difference** tested
(`RE:rts/Game/GameHelper.cpp:1627-1634`):

```c
if (unitDef->IsImmobileUnit())
    slopeCheck |= (std::abs(wantedHeight - groundHeight) <= unitDef->maxHeightDif);
else
    slopeCheck |= (groundSlope <= maxSlope);
```

and (`RE:rts/Sim/Units/UnitDef.cpp:423-427`):

```c
const float maxSlopeDeg = clamp(udTable.GetFloat("maxSlope", 0.0f), 0.0f, 89.0f);
maxHeightDif = 40.0f * tan(maxSlopeDeg * DEG_TO_RAD);
```

`wantedHeight` is the levelled platform height chosen by `GetBuildHeight`
(`RE:rts/Game/GameHelper.cpp:1188-1261`), clamped into `[minHgt, maxHgt]` derived from the footprint.
`groundHeight` is the per-square centre height. So:

> **Every heightmap square under a building's footprint must lie within `±maxHeightDif` elmos of the
> platform height.**

| Building | `maxslope` | `maxHeightDif` (elmos) | Footprint | Needed flat pad |
|---|---:|---:|---|---|
| Solar collector | 10 | **7.05** | 5×5 → 80×80 el | 80×80 within ±7 el |
| Fusion reactor | 10 | **7.05** | 6×5 → 96×80 el | 96×80 within ±7 el |
| Nano turret | 10 | **7.05** | 3×3 → 48×48 el | |
| Annihilator | 10 | **7.05** | 4×4 → 64×64 el | |
| Big Bertha | 12 | **8.50** | 4×4 | |
| LLT | 14 | **9.97** | 2×2 → 32×32 el | |
| Bot lab / Vehicle plant | 15 | **10.72** | 6×6 → 96×96 el | **the hard one** |
| Advanced geo | 15 | **10.72** | 5×5 | |
| Geothermal plant | 20 | **14.56** | 5×5 → 80×80 el | |
| Wind generator | 10 | **7.05** | 3×3 | |
| Metal extractor (T1/T2) | 30 | **23.09** | 4×4 → 64×64 el | mexes tolerate rough ground |

**Design rule:** a usable base needs a contiguous pad of at least **~400 × 400 elmos** where the
height varies by no more than ~±10 elmos per 96-elmo window — that is roughly 25 lab-sized pads. Front
positions need at least a ~150×150 elmo pad for a lab + a few turrets.

> BAR does **not** give players a terraform command in normal play. The engine auto-levels the ground
> under a building when it is placed (`levelGround` defaults true, `RE:rts/Sim/Units/UnitDef.cpp:692`), and
> `maphardness` (`mapinfo.lua`, default 100, BAR blueprint 200, Altair 120) controls how much craters
> deform terrain. **So "flat enough to build on" is a map-authoring responsibility, not something the
> player can fix.**

---

## 5. Metal

### 5.1 The data path, exactly

```
SMF metalmap: uint8[(mapx/2) * (mapy/2)]      // 1 byte per 16x16 elmos
      |
      v  CMetalMap::Init(map, mapx/2, mapy/2, metalScale = mapInfo->map.maxMetal)
distributionMap[]  (uint8)   +   metalScale (float)
      |
      v  CMetalMap::GetMetalAmount(x,z) = distributionMap[z*sizeX + x] * metalScale
"metal amount" (float, what Lua's Spring.GetMetalAmount / GetGroundInfo return)
      |
      v  CExtractorBuilding::SetExtractionRangeAndDepth(range = unitDef->extractRange,
      |                                                 depth = unitDef->extractsMetal)
metalExtract = SUM over metal squares whose CENTRE lies strictly within `range`
               of  ( extractionDepth_granted * GetMetalAmount(x,z) )
      |
      v  CUnit::UpdateResources() every UNIT_SLOWUPDATE_RATE (15) frames = 2x/s,
         AddResources({metalExtract * 0.5f, 0})
income (metal per second) = metalExtract
```

Sources: `RE:rts/Map/MetalMap.h:11`, `RE:rts/Map/MetalMap.cpp:29-50,76-84`,
`RE:rts/Sim/Units/UnitTypes/ExtractorBuilding.cpp:82-146`, `RE:rts/Sim/Units/Unit.cpp:1092-1098`,
`RE:rts/Sim/Units/UnitDef.cpp:588`.

**The master formula:**

```
T1 mex income (metal/s) = extractsMetal × Σ_{metal squares with centre inside extractorRadius} ( byte × maxMetal )
```

with BAR's `armmex.extractsmetal = 0.001` and `armmoho.extractsmetal = 0.004` (exactly 4×).

`extractRange` is **not** set per unit in BAR; the engine assigns
`extractRange = mapInfo->map.extractorRadius` for any unit with `extractsMetal > 0`
(`RE:rts/Sim/Units/UnitDef.cpp:588`). **So the map, not the game, decides mex radius.**

### 5.2 mapinfo knobs

```lua
-- RE:rts/Map/MapInfo.cpp:105-116  (engine defaults in comments)
tidalStrength   = 0.0        -- default 0
maxMetal        = 0.02       -- default 0.02   <-- the byte→metal scale
extractorRadius = 500.0      -- default 500
```

BAR's own template (`BP:mapinfo.lua:29-30`) and every shipped map I opened use:

```lua
maxMetal        = 0.90     -- varies per map, see below
extractorRadius = 90.0     -- UNIVERSAL in BAR
```

Real values sampled from shipped archives:

| Map | Size | `maxMetal` | `extractorRadius` | `tidalStrength` | wind | metal spots | geo | T1 income/spot |
|---|---|---:|---:|---:|---|---:|---:|---|
| Altair Crossing V4 | 8×8 | 1.80 | 90 | 20 | 12–27 | **30** | 2 | 1.29 – 2.79 |
| Ravaged Remake v1.2 | 10×10 | 1.05 | 90 | 21 | 5–15 | **32** | 4 | 1.79 – 1.82 |
| Tabula Remake 1.5.1 | 16×14 | 0.91 | 90 | 20 | 1–22 | **68** | 0 | 1.85 (med), 4.00 (double) |
| Supreme Isthmus v2.1 | 24×24 | 0.93 | 90 | 21 | 1–19 | **90** | 4 | 2.30 (med), 4.30 (double) |
| BAR `map_blueprint` | — | 0.90 | 90 | 15 | 1–20 | — | — | — |

**`maxMetal` is a free scale factor.** It only sets how much metal one byte is worth, so the author
picks it to land their intended spot value inside the 0–255 byte range with headroom. A good default
for a tool: pick `maxMetal` such that the *largest intended* spot uses bytes in the 150–255 range.

### 5.3 What a "metal spot" is in BAR

BAR does not store spots. It **discovers** them at game start by connected-component analysis of the
metal map — `BAR:common/upgets/api_resource_spot_finder.lua`, function `GetSpotsMetal()`:

1. Scan the metal map row by row from `1.5 × 16 = 24` elmos to `mapSize − 24` elmos, in 16-elmo steps
   (borders are excluded so a mex can always physically fit).
2. Build horizontal **strips** of consecutive squares with `groundMetal > 0`.
3. Merge a strip with strips on the row above when they overlap **or come within one metal square**
   (`stripRight[i] + metalMapSquareSize >= x1`). This is 8-connectivity with a 1-cell gap tolerance.
4. Each merged group is a spot with:
   - `worth` = Σ of `GetGroundInfo` metal over the whole group (i.e. Σ byte × maxMetal),
   - `x, z` = **centre of the group's bounding box**, `y` = ground height there,
   - `minX/maxX/minZ/maxZ`, and per-row `left[]`/`right[]` for placement validity.
5. **Failure mode:** `maxStripLength = extractorRadius * 6` (= **540 elmos** with r=90). If any group's
   bounding box exceeds 540 elmos in either axis, the finder returns `false, true` →
   `isMetalMap = true`, and all spot UI / area-mex / mex-snapping is disabled for the whole map.

> ⚠️ **Hard constraint for a map builder: no connected metal blob may exceed 540 elmos (33.75 metal
> squares) in width or height.** Blobs that touch diagonally or come within 16 elmos count as connected.
> Keep discrete spots ≥ 32 elmos apart (2 empty metal squares) to guarantee they stay separate.

There is also a hard-coded allow-list of "metal maps" (SpeedMetal, Cloud9 V2, Asteroid Mines V2.1, Iron
Isle V1, Nine Metal Islands V1, Oort Cloud V2) that skip spot detection entirely
(`api_resource_spot_finder.lua:33-40`).

`mex_count`, `mex_x{i}`, `mex_y{i}`, `mex_z{i}`, `mex_metal{i}` are published as game rules params for
AIs (`setMexGameRules`). `mex_count = -1` signals "metal map, no spots".

### 5.4 Spot placement validity (why blob *shape* matters)

`IsBuildingPositionValid` (`api_resource_spot_finder.lua:183-201`) requires that a mex position captures
**every** square of the group: for each metal row `sz` of the spot,
`|x − left/right| ` must stay within `sqrt(expandedRadius² − dz²)` where
`expandedRadius = extractorRadius + 16`. In practice:

> **A spot blob must fit inside a circle of radius ~90 elmos**, i.e. **≤ ~180 elmos across** —
> otherwise no single mex can capture all of it and the player loses income to a "split" spot.

Real BAR spots are **4×4 metal squares = 64×64 elmos** (Altair Crossing: every spot is exactly 4×4 or
4×3). The engine's Lua spot-placer gadget (`BAR:luarules/gadgets/map_metal_spot_placer.lua`) paints a
**5×5 block minus the four corners = 21 squares** (80×80 elmos), each set to
`metal × 0.43 × 9/21 × 255`, which makes the T1 income ≈ `1.0 × metal`.

The in-game metal brush (`BAR:luaui/Widgets/cmd_metal_brush.lua:59-67`) defaults:

```lua
local METAL_SQ          = Game.metalMapSquareSize or 16
local EXTRACTOR_RADIUS  = Game.extractorRadius or 90
local MIN_METAL_VALUE   = 0.01
local MAX_METAL_VALUE   = 50.0
local DEFAULT_METAL_VALUE = 2.0            -- <-- BAR's canonical spot value
local DEFAULT_RADIUS      = METAL_SQ * 1.5 -- 3x3 metal pixels
```

and its HUD readout is literally `spot = Σ(metal within extractorRadius) × 0.001`, i.e. **the T1 mex
income in metal/s** (`cmd_metal_brush.lua:304-364`).

### 5.5 Income numbers to design against

| Extractor | `extractsMetal` | Income on a 2.0 spot | Cost (M/E) | Footprint |
|---|---:|---:|---|---|
| `armmex` T1 Metal Extractor | 0.001 | **2.0 /s** | 50 / 500 | 4×4 |
| `armamex` T1 cloaked (Moho-lite) | 0.001 | 2.0 /s | 200 / … | 4×4 |
| `armmoho` T2 Moho Mine | 0.004 | **8.0 /s** | 620 / 7700 | 4×4, `maxwaterdepth 20` |
| `armuwmme` T2 underwater Moho | 0.004 | 8.0 /s | 620 / … | 4×4, `minwaterdepth 15` |

T1 mex has **no `maxwaterdepth`** in BAR (`BAR:units/ArmBuildings/LandEconomy/armmex.lua`), so T1 mexes
work at any depth; only T2 splits into land (`≤ 20`) and sea (`≥ 15`) variants. **A spot at depth 20–…
is a T1-only spot until the player has naval tech** — a real and often-unintentional balance lever.

### 5.6 Spot-count conventions

| Format | Spots per player | Evidence |
|---|---|---|
| 1v1 | **12–16** | Ravaged 10×10, 2 players, **32 spots** |
| 2v2–3v3 | 5–8 | Altair Crossing 8×8, up to 6 players, **30 spots** |
| 8v8 team | **4–6** | Tabula 16×14, 16 players, **68 spots** (4.25/player); Supreme Isthmus 24×24, 16 players, **90 spots** (5.6/player) |

Standard layout grammar used by virtually every BAR team map:

| Zone | Count per player | Value | Notes |
|---|---|---|---|
| **Base spots** | 3–4 | 1.8–2.3 | inside the startbox, safe, on flat ground, close enough to be walled in by a single LLT line |
| **Expansion spots** | 2–3 | 1.8–2.3 | one lane-step out; reachable in < 30 s by a T1 con |
| **Contested / middle** | 1–3 shared | 2.0, or a **double** at 4.0–4.3 | on or beside the main chokepoint; often paired with a geo |
| **Risk spots** | 0–1 | 4.0+ | behind a cliff, on an island, or in artillery range of the enemy |

Both Tabula and Supreme Isthmus use exactly this: a median spot at ~1.85/2.30 and a handful of
"double" spots at 4.00/4.30 in contested ground. **Value differentiation is how a map tells players
where to fight.**

---

## 6. Geothermal vents

### 6.1 What a geo is, mechanically

A geo is a **feature** whose `FeatureDef.geoThermal == true`
(`RE:rts/Sim/Features/FeatureDef.cpp`, parsed at `FeatureDefHandler.cpp`: `fd.geoThermal = fdTable.GetBool("geoThermal", false)`).

Maps declare it through the SMF feature-type name. The engine auto-creates a default def for **any map
feature type whose (lowercased) name contains the substring `"geovent"`**, and additionally always
registers a def literally named `geovent` if the map didn't supply one
(`RE:rts/Sim/Features/FeatureDefHandler.cpp:232-258`). The auto-created def is:

```c
// RE:rts/Sim/Features/FeatureDefHandler.cpp:182-205
fd.collidable    = false;   fd.burnable  = false;  fd.destructable = false;
fd.reclaimable   = false;   fd.geoThermal = true;
fd.drawType      = DRAWTYPE_NONE;    // invisible: the vent is painted into the map texture
fd.cost = 0; fd.reclaimTime = 0; fd.health = 0;
fd.xsize = 0; fd.zsize = 0;          // zero footprint, does not block
fd.collisionVolume = CollisionVolume('s','z', ZeroVector, ZeroVector);
```

So: **name the SMF feature type `GeoVent` or `geovent` and place it at the world position of the vent
you painted into the diffuse texture.** Altair Crossing does exactly that — its feature-type string
table is `TreeType0..15`, `GeoVent`, `geovent`, and it places 2 `geovent` features.

Games may ship a richer def. BAR's editor-side defs (`BAR:features/geovent.lua`) are
`editor_geovent` (4×4 footprint, rock model, smoke) and `editor_geocrack` (footprint 0, decal-only,
`buildingGroundDecalType = "editor_geovent_crack.dds"`, size 4×4) — both `geothermal = true`,
`indestructible`, `reclaimable = false`, `blocking = false`.

### 6.2 Build placement rule

A unit with `needGeo` (set by a `g`/`j` character in its yardmap,
`RE:rts/Sim/Units/UnitDef.cpp:847-848`) may only be placed where a geothermal feature is nearby
(`RE:rts/Game/GameHelper.cpp:1307-1324`):

```c
const int mindx = xsize * (SQUARE_SIZE >> 1) - (SQUARE_SIZE >> 1);   // = xsize*4 - 4
const int mindz = zsize * (SQUARE_SIZE >> 1) - (SQUARE_SIZE >> 1);
// square is buildable iff  |feature.x - testPos.x| < mindx  &&  |feature.z - testPos.z| < mindz
```

For `armgeo` (`footprintx = 5` → `xsize = 10`): `mindx = 36`. **The vent must sit within ±36 elmos of
the plant's centre in both axes.**

### 6.3 BAR geo plants

| Unit | `energymake` | Cost (M/E) | Footprint | `maxslope` → `maxHeightDif` | `maxwaterdepth` |
|---|---:|---|---|---|---|
| `armgeo` Geothermal Powerplant | **300 E/s** | 560 / 13 000 | 5×5 (80×80 el) | 20 → **14.6 el** | 5 |
| `armageo` Advanced Geothermal | **1 250 E/s** | 1 600 / 27 000 | 5×5 | 15 → **10.7 el** | 5 |
| `armuwgeo` / `coruwgeo` | — | — | — | — | underwater variants exist |

For comparison: a fusion reactor is 750 E/s for 3 350 M. **An advanced geo out-produces a fusion at half
the metal cost** — geos are extremely strong in BAR, which is why placement matters so much.

### 6.4 Conventions

- **Typical count: 2–6 per map, always symmetric.** Sampled: Altair Crossing (8×8) = 2, Ravaged
  (10×10) = 4, Supreme Isthmus (24×24) = 4, Tabula (16×14) = 0.
- Common patterns: one per team inside the base (safe econ), or an **even number in contested ground**
  (a reason to fight). Never an odd number unless the odd one is dead-centre.
- BAR checklist: *"Make sure geo-vents are buildable with T2 geos"* — i.e. verify an 80×80 elmo pad
  around each vent satisfies `maxHeightDif ≤ 10.7` for `armageo`, not just the looser 14.6 for `armgeo`.
- Vents must be visible in the texture — the default def is `DRAWTYPE_NONE`, so **if you don't paint a
  vent/crack into the diffuse texture, the geo is invisible** and players will never find it.
- `ypos` in `MapFeatureStruct` should follow the terrain. BAR checklist: *"Avoid fixed Y values"* (it
  breaks when the water level modoption changes).

---

## 7. Start positions & start boxes

### 7.1 The two systems

**(a) `mapinfo.lua teams{}` — engine-level fixed start positions.**

```lua
-- BP:mapinfo.lua:257-263  /  Altair_Crossing_V4 mapinfo.lua
teams = {
    [0] = {startPos = {x = 496,  z = 1924}},
    [1] = {startPos = {x = 3755, z = 2037}},
    [2] = {startPos = {x = 456,  z = 893}},
    ...
}
```

Coordinates are **elmos**. BAR checklist: *"teams{} should be set properly for max. number of start
positions + teams."* Real maps ship 6 (Altair, Ravaged) to 16 (Tabula, Supreme Isthmus) entries.

**(b) Start boxes — lobby-level, from `maps-metadata`.**

Coordinates are integers in **0…200** on both axes, scaled by `Game.mapSizeX / 200`
(`BAR:luarules/gadgets/include/startbox_utilities.lua:168-169`). Shipped to the game as the
`mapmetadata_startboxes_set` modoption (base64url(zlib(json)) keyed by team count).

A `startboxesInfo` is `{ startboxes: [ {poly: [...]}, ... ], maxPlayersPerStartbox: int }`.
A `poly` of 2 points is a rect (top-left, bottom-right); 3+ points is a Catmull-Rom polygon with
optional per-point `strength ∈ [0,1]` (0 = sharp corner, 1 = full curve).

Startbox names are auto-derived from the box centroid into N/S/E/W/NE/…/Center thirds
(`startbox_utilities.lua:16-41`).

**(c) Named spawn points with roles** — the modern BAR team-game layer
(`MM:schemas/map_list.yaml`, `$defs.startPos`):

```yaml
startPos:
  positions: { "<name>": {x: int, y: int} }     # elmos
  team:
    - teamCount: 2
      playersPerTeam: 8
      sides:
        - starts:
          - spawnPoint: "<name>"
            baseCenter: "<name>"                 # optional
            role: front | air | tech | sea | front/sea | air/tech | ...
```

**Roles are the design contract for an 8v8 map**: every side needs at least one `front`, one `air`,
one `tech`, and — on a water map — one `sea` position. If your generated map cannot support a sane
front/air/tech split per side, it will not play well as a team map.

### 7.2 Fairness requirements

1. **Mirror the metal.** Each start must have the same number and value of base spots within the same
   distance. The spot finder's `worth` is what players compare.
2. **Mirror the terrain class.** Slope bands must mirror too — a mirrored heightmap with an
   un-mirrored typemap is a classic imbalance bug.
3. **Mirror the distance to the middle.** For rot180 symmetry this is automatic; for mirror symmetry
   check the axis-perpendicular distance from each start to the contested line.
4. **Startbox must contain a buildable pad.** Engine start-position validity and BAR's pregame-build
   widget both assume the commander can plant a lab immediately: **≥ 96×96 elmos within ±10.7 el**.
5. **No start inside another's weapon envelope.** Bases ≥ **~1 400 elmos apart** minimum so a T2
   Annihilator (1 400) built at the edge of one base cannot cover the other's. For 1v1, ≥ 2 500 so an
   early Big Bertha (4 650) is a commitment, not a free win.
6. `useStartPositionSelecter = false` in BAR (`BAR:gamedata/modrules.lua`) — BAR uses its own placement
   UI, so `teams{}` positions act as defaults/anchors rather than hard spawns.

### 7.3 Typical base layout (what a good BAR base looks like)

```
                        [ back: fusion / T2 econ / nanos ]      <- flat, 400x400 el
   [ air pad ]      [ lab ] [ lab ]      [ geo ]                <- 96x96 pads
                        [ mex ] [ mex ] [ mex ]                 <- 3-4 base spots
   ------------------- ridge / natural wall -------------------
                  [ LLT line ] [ radar ]                        <- on the ridge
                        (ramp, 200-400 el wide)
                   >>> toward the contested middle <<<
```

- **1–2 ramps per base.** Zero ramps = unplayable; 4+ = undefendable.
- The ridge should break line of sight (LOS is raycast, `RE:rts/Sim/Misc/LosHandler.cpp:92`), so a
  base is not visible from the front line without scouting.
- Leave a **clear straight back edge**: players park nano-turret farms and T2 econ there.

---

## 8. Water

### 8.1 Depth semantics

Depth is just negative height. Everything keys off it:

| Depth (elmos below 0) | Consequence |
|---|---|
| 0 to −4 | Ground units unaffected (`depthModGeneric.minHeight = 4`) |
| −4 to −8 | Ground units slow (`×1/(1+0.03·d)`); still no ships (`MIN_SHALLOW = 8`) |
| **−8** | **Ships float** (`BOAT3/4/5`, `minwaterdepth = 8`) |
| −8 to −15 | Small/medium ships, hovers, wading bots & tanks |
| **−15** | **Submarines and capital ships** (`UBOAT4`, `BOAT9`, `minwaterdepth = 15`); T2 underwater mex |
| **−20** | **Hard limit for ground units** (`MAX_SHALLOW`); deeper = impassable for every tank/bot |
| < −20 | Ships, subs, hovers, amphibs (`AMPHIBIOUS = 5000`), air only |

So the **navigable band is a knife-edge**: a shoreline that goes from 0 to −25 in one 16-elmo cell gives
you a hard land/sea boundary with no mixed zone. A shoreline that spends 100+ elmos between −4 and −20
creates a wide amphibious/wading contest zone. **Both are valid; pick deliberately.**

### 8.2 Ship pathing gotcha

`ShipSpeedMod` with direction (`RE:rts/Sim/MoveTypes/MoveMath/ShipMoveMath.cpp:19-27`) blocks movement
when `height >= 0` **or** when moving uphill into water shallower than `depth`. Narrow channels that dip
above −8 anywhere will hard-block a fleet. **Dredge channels to ≥ 20 elmos deep and ≥ 200 elmos wide**
(a `BOAT9` is 136 elmos across).

### 8.3 Water damage — the lava / acid lever

```c
// RE:rts/Map/MapInfo.cpp:237
water.damage = wt.GetFloat("damage", 0.0f) * (UNIT_SLOWUPDATE_RATE * INV_GAME_SPEED);   // ×0.5
// RE:rts/Sim/MoveTypes/MoveDefHandler.cpp:158-160
CMoveMath::noHoverWaterMove = (water.damage >= 1e4f);                  // MAX_ALLOWED_WATER_DAMAGE_HMM
CMoveMath::waterDamageCost  = (water.damage >= 1e3f) ? 0.0f            // MAX_ALLOWED_WATER_DAMAGE_GMM
                                                     : 1.0f / (1.0f + water.damage * 0.1f);
```

| `mapinfo water.damage` | Effect |
|---:|---|
| 0 | normal water; ground speedMod ×1 |
| 100 | `waterDamageCost = 1/(1+5) = 0.167` → wading is 6× slower |
| **≥ 2 000** | `waterDamageCost = 0` → **ground units cannot enter water at all** |
| **≥ 20 000** | `noHoverWaterMove` → **hovers cannot cross water either** |

This is how lava maps are built. It is also a trap: a mapper who sets `damage = 5000` "for flavour"
silently removes amphibious play.

### 8.4 Tidal generators

```c
// RE:rts/Map/MapInfo.cpp:105,114
map.tidalStrength = max(0, topTable.GetFloat("tidalStrength", 0.0f));
// RE:rts/Sim/Units/Unit.cpp:1098  (called 2x/s, hence *0.5)
AddResources(unitDef->tidalGenerator * (envResHandler.GetCurrentTidalStrength() * 0.5f));
```

`armtide.tidalgenerator = 1` (`BAR:units/ArmBuildings/SeaEconomy/armtide.lua:29`), so:

> **Tidal generator energy/s = `tidalStrength` exactly.** Cost 90 M / 200 E, footprint 3×3.

| `tidalStrength` | E/s per 90 metal | Verdict |
|---:|---:|---|
| 0 | 0 | Tidals useless — only correct on a map with no water |
| 10 | 10 | weak; wind is usually better |
| **15** | 15 | fine (37 of 225 maps) |
| **20** | 20 | **BAR standard — 67 of 225 maps** |
| 21–25 | 21–25 | strong; makes sea starts economically dominant |
| 75 / 80 | — | two outlier maps only |

Compare: a solar collector is 20 E/s for 155 M. **At `tidalStrength = 20`, a tidal is ~1.7× the
metal-efficiency of a solar and is unkillable by air raids until T2.** That is exactly why 20 is the
convention: it makes water starts viable without making them free.

Distribution across the 225 curated maps: `20` ×67, `15` ×37, `0` ×33, `10` ×21, `25` ×8, `18/21/22` ×7 each.

### 8.5 What makes a water map good vs bad

**Good:**
- Land and sea both matter: ≥ 30 % of metal spots reachable only by sea/amphib, ≥ 50 % on land.
- Navigable channels ≥ 200 elmos wide, ≥ 20 el deep, connected — a fleet can flank.
- Shallows (−8 to −20) around islands so hovers and amphibs have a distinct role.
- `tidalStrength` 15–25 so the sea investment pays back.
- Land bridges or narrow isthmuses so land armies can still contest.

**Bad:**
- A moat that no one can cross (water > 20 deep, no land route, no bridge) — the game becomes two
  parallel solitaires.
- Water shallower than 8 everywhere — ships can't spawn from a shipyard, the whole naval tree is dead.
- `tidalStrength = 0` on a map that's 50 % water.
- Deep water immediately adjacent to base pads — enemy `BOAT4` destroyers (range 400+) shell the base
  from turn one.
- `voidWater = true` (`RE:rts/Map/MapInfo.cpp:109`) without understanding it removes the water plane
  entirely (space maps) — everything below 0 becomes a bottomless hole.

---

## 9. Wind

```c
// RE:rts/Map/MapInfo.cpp:135-136,170-172
atmo.minWind = atmoTable.GetFloat("minWind", 5.0f);
atmo.maxWind = atmoTable.GetFloat("maxWind", 25.0f);
atmo.maxWind = max(0, atmo.maxWind);
atmo.minWind = min(atmo.maxWind, max(0, atmo.minWind));
```

Wind does a random walk, re-rolled every `WIND_UPDATE_RATE = 15 * GAME_SPEED = 450` frames (15 s),
smoothstep-blended between the old and new vectors, clamped to `[minWind, maxWind]`
(`RE:rts/Sim/Misc/Wind.cpp:91-143`, `RE:rts/Sim/Misc/Wind.h:43`).

Energy (`RE:rts/Sim/Units/Unit.cpp:1094`, ×0.5 because 2 ticks/s):

```c
AddResources(SResourcePack(envResHandler.GetCurrentWindStrength()).cap_at(unitDef->windGenerator) * 0.5f);
```

> **Wind generator energy/s = `min(currentWindStrength, windGenerator)`.**
> BAR's `armwin.windgenerator = 25` (`BAR:units/ArmBuildings/LandEconomy/armwin.lua:27`), cost 40 M /
> 175 E, footprint 3×3. **So wind above 25 is wasted.**

Note the naive average `(min+max)/2` is *not* the true average — the random walk is biased. BAR ships a
Monte-Carlo table (`MM:scripts/js/src/derived_map_info.ts`, `avgWindTable`, sourced from
`BAR:luaui/Widgets/gui_top_bar.lua updateAvgWind()`). Excerpts:

| min\max | 10 | 15 | 20 | 25 | 30 |
|---|---|---|---|---|---|
| **0** | 7.5 | 11.2 | 14.9 | 18.6 | 20.7 |
| **2** | 7.5 | 11.2 | 14.9 | 18.6 | 20.7 |
| **5** | 8.0 | 11.5 | 15.1 | 18.8 | 20.7 |
| **10** | — | 12.9 | 16.1 | 19.5 | 21.2 |
| **15** | — | 15.0 | 17.8 | 20.9 | 22.3 |
| **20** | — | — | 20.4 | 22.8 | 23.7 |

Note the **ceiling near 21**: raising `maxWind` above ~26 barely raises the average, because the walk
rarely reaches the cap. `maxWind = 30, minWind = 0` averages **20.7**, not 15.

### 9.1 What values are balanced

BAR checklist: **wind range 0–30.** Observed across 225 maps: the top pairs are
`(1,19)` ×13, `(2,20)` ×13, `(5,25)` ×12, `(0,0)` ×10, `(5,20)` ×10, `(5,19)` ×8, `(4,16)` ×7.

| Config | Avg | Reading |
|---|---:|---|
| `0 – 0` | 0 | **Wind disabled.** Correct for indoor/space/lava maps. 10 maps do this (Faster Than Light, Moonshine Run, Darkside, Prismatic Anomaly). Forces solar/geo/fusion — a deliberate, *slower* econ. |
| `1 – 4` (Comet Catcher, Red Comet) | ~3 | Wind is a trap. Fine on a metal-rich duel map. |
| `4 – 12` | ~9 | Wind is a weak filler. Safe default for a "solar map". |
| **`2 – 20` / `1 – 19` / `5 – 20`** | ~14–15 | **The BAR sweet spot.** A wind (40 M) averages 15 E/s vs a solar (155 M) at 20 E/s → wind is ~4× metal-efficient but volatile and fragile. Both are viable. |
| `5 – 25` | ~18.8 | Wind-favoured. Fine, but solar becomes a niche pick. |
| `13 – 17` (Incandescence) | 15.2 | Low variance — wind behaves like a cheap reliable solar. Nice design trick. |
| `25 – 25` | 25 | Flat max wind. Solar is dead. 4 maps do it. |

**Rules for a generator:**
- `maxWind ≤ 25` unless you intend wind to be strictly better than solar.
- `maxWind − minWind` is the **volatility knob**: a wide spread (0–25) creates energy-stall gameplay
  and rewards storage; a narrow spread (13–17) makes wind boring but safe.
- Set `0 – 0` **only** if the map's fiction says so; it is a real balance change, not flavour.
- Wind is direction-agnostic for gameplay — only strength matters — but the generators visibly rotate,
  which is a nice ambience cue.

---

## 10. Type map & terrain types (the forgotten layer)

`typeMapPtr` → `uint8[(mapx/2) * (mapy/2)]`, one byte per **16×16 elmos**, indexing
`mapinfo.terrainTypes[i]`:

```lua
-- BP:mapinfo.lua:214-240
terrainTypes = {
    [0]   = { name = "Ground", hardness = 1.0, receiveTracks = true,
              moveSpeeds = { tank = 1.0, kbot = 1.0, hover = 1.0, ship = 1.0 } },
    [255] = { name = "Roads",  hardness = 1.0, receiveTracks = true,
              moveSpeeds = { tank = 1.25, kbot = 1.25, hover = 1.25, ship = 1.25 } },
}
```

The multiplier is applied straight onto the speed mod
(`RE:rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:96-100`):

```c
case MoveDef::Tank: return (GroundSpeedMod(moveDef, height, slope) * tt.tankSpeed);
```

Consequences worth exposing in a builder:

- `moveSpeeds.tank = 0` makes a region **impassable to vehicles only** — the cheapest way to author
  "bots-only swamp" without touching the heightmap.
- `moveSpeeds = 0` for all classes makes terrain impassable to ground while staying visually flat
  (lava lakes, minefields, deep snow).
- `1.25` roads are a legitimate and under-used pacing tool — BAR's own blueprint ships them.
- `hardness` scales crater depth locally (`RE:rts/Map/MapInfo.cpp:443`); global default
  `maphardness = 100` (`MapInfo.cpp:98`), BAR blueprint uses 200 (less deformable).
- BAR's `pfRawMoveSpeedThreshold = 0` (`modrules.lua:104`) means units will happily raw-move over
  slow-but-passable terrain; they only reroute around truly impassable squares.

---

## 11. Other `mapinfo.lua` values that change gameplay

| Key | Engine default | BAR convention | Effect |
|---|---|---|---|
| `maphardness` | 100 (`MapInfo.cpp:98`) | 120–200 | crater depth / terrain deformability |
| `gravity` | 130 (`MapInfo.cpp:101`) | **100** (blueprint, Altair, Ravaged) | **Ballistic weapon reach.** `CCannon::UpdateRange` clamps `rangeBoostFactor = range / GetRange2D(...)` (`RE:rts/Sim/Weapons/Cannon.cpp:41-56`); if gravity is too high for a projectile's speed, the weapon's *effective* range shrinks below its stated `range`. Higher gravity also flattens lob arcs → arty can't clear cliffs. **Don't deviate from 100–130 without testing artillery.** |
| `notDeformable` | false | false | locks the heightmap |
| `voidWater` | false | false | no water plane at all (space maps) |
| `voidGround` | false | false | holes in the map |
| `autoShowMetal` | — | `true` | metal overlay on when a mex is selected |
| `water.damage` | 0 | 0 | see §8.3 |
| `smf.minheight/maxheight` | header | **always set explicitly** | overrides the SMF header (§1.2) |

### 11.1 High ground is a real mechanic, not just aesthetics

Two engine behaviours make elevation worth fighting for:

1. **LOS and radar are raycast** against the heightmap
   (`RE:rts/Sim/Misc/LosHandler.cpp:92`: `algoType = (LOS || RADAR) ? LOS_ALGO_RAYCAST : LOS_ALGO_CIRCLE`).
   A ridge genuinely blocks vision. Air-LOS and sonar are circles and ignore terrain.
2. **Ballistic range scales with height difference**
   (`RE:rts/Sim/Weapons/Cannon.cpp`, `GetStaticRange2D`):
   `range ∝ v² + v·sqrt(v² + 2·g·Δh)` with `Δh` negative when shooting downhill, plus a
   `heightBoostFactor` amplification beyond 100 elmos of drop. **Firing down off a 100-elmo cliff is a
   substantial free range bonus; firing up is a penalty.**

So: a plateau **≥ 100 elmos** above the surrounding ground is a materially strong position. That is the
number to design cliffs around.

---

## 12. Design heuristics for good BAR maps

### 12.1 Symmetry

From `BAR:luaui/RmlWidgets/gui_terraform_brush/newmap_archetypes.lua`, *"AUTO-GENERATED … from a scan of
202 real BAR maps"*:

```lua
symmetryWeights = { rot180 = 0.709, mirrorx = 0.136, mirrorz = 0.118, rot90 = 0.036 }
sizeWeights = { [8]=0.03, [10]=0.025, [12]=0.119, [14]=0.089, [16]=0.203, [18]=0.069,
                [20]=0.183, [22]=0.01, [24]=0.173, [26]=0.005, [28]=0.02, [30]=0.025, [32]=0.05 }
```

| Type | Share | When to use | Failure mode |
|---|---:|---|---|
| **Rotational 180°** | **71 %** | default for everything, especially lane / 8v8 maps | Diagonal maps can feel "twisted"; the two halves never look alike on the minimap |
| **Mirror X or Z** | 25 % combined | when you want both sides to *read* identically (tournament 1v1) | Handedness: a right-handed ramp becomes left-handed. Real asymmetry for units that turn. |
| **Rotational 90°** | 3.6 % | 4-way FFA, 2v2v2v2 | Hard to make a coherent middle |
| **Point/radial (6/8-way)** | rare | FFA-only maps | Everyone fights in the centre; no expansion pacing |
| **Asymmetric** | tagged `asymmetrical` in metadata | only for showcase/PvE | Almost never accepted for competitive play |

Mirror **all four layers together**: heightmap, metal map, type map, feature placement. A mirrored
heightmap with hand-placed features is the #1 source of "this side is better" complaints.

### 12.2 Terrain archetypes with real parameter ranges

Same auto-generated file — p20…p80 ranges over 202 shipped maps:

| Archetype | Weight | Hilliness | Water level | Islandness |
|---|---:|---|---|---|
| Open Plains | 15.3 % | 0.284 – 0.424 | 0 – 0.03 | 0 – 0.04 |
| Rolling Hills | 13.4 % | 0.481 – 0.587 | 0 – 0.042 | 0 – 0.052 |
| Highlands | 16.3 % | 0.681 – 0.787 | 0 – 0.054 | 0 – 0.04 |
| Mountain Pass | 7.4 % | 0.847 – 1.0 | 0 – 0.085 | 0 – 0.05 |
| Lakes & Rivers | 14.4 % | 0.556 – 0.815 | 0.157 – 0.427 | 0.069 – 0.284 |
| Coastal | 17.3 % | 0.56 – 1.0 | 0.265 – 0.395 | 0.483 – 1.0 |
| Island Skirmish | 15.8 % | 0.508 – 1.0 | 0.437 – 0.642 | 0.87 – 1.0 |

All archetypes share `roughness 0.35–0.7`, `featureScale 0.4–0.7`, `jaggedness 0.35–0.65`. Useful
defaults for a generator's sliders.

### 12.3 Chokepoints

- Count: **2–4 crossings** between the two halves on a team map, **2–3** on a 1v1 map.
  One choke = stalemate and artillery war. Five+ = no defence is possible and the map devolves into
  raiding.
- Width: **200–400 elmos** for a main crossing (fits an army, doesn't fit *the whole* army);
  **100–150 elmos** for a flank path (fits raiders, punishes deathballs).
- Absolute floor: **104 elmos** (largest `MoveDef` footprint) — narrower and `HBOT7`/`BOAT9` simply
  cannot pass, which is almost never what you want.
- A choke should have **buildable shoulders** (a 32×32 pad for an LLT, a 64×64 for a mex) on both
  approaches — otherwise neither side can hold it and it becomes a revolving door.
- Put a metal spot **adjacent to, not inside**, the choke. Inside = the fight is decided by whoever
  walks in first; adjacent = holding the choke earns the spot.

### 12.4 Expansion pacing

Measure with T1 tank speed 75 el/s (§3.1):

| Ring | Distance from start | Walk time | Should contain |
|---|---|---|---|
| Base | 0 – 600 el | 0 – 8 s | 3–4 mex, lab pads, geo (sometimes) |
| Near expansion | 600 – 1 500 el | 8 – 20 s | 2–3 mex, first defensible line |
| Mid | 1 500 – 3 000 el | 20 – 40 s | contested spots, the chokes |
| Far / enemy near-expansion | 3 000+ el | 40 s+ | raid targets |

If a map has no metal between 600 and 1 500 elmos, the early game is a dead 3 minutes. If it has *all*
its metal there, there is no mid-game.

### 12.5 High ground, ramps, sightlines

- A plateau worth taking is **≥ 100 elmos** above its surroundings (§11.1) and **≥ 300×300 elmos** on
  top (room for 2–3 turrets + a radar + a mex).
- **1–2 ramps per plateau.** Ramp grade must be ≤ **27°** if vehicles should use it, ≤ **54°** for
  bots only — that is a deliberate and very effective way to make a "bot-only high ground".
- Ramp width: ≥ 150 elmos or units will conga-line and die.
- Cliff faces should be **> 54°** if you want them to be genuinely impassable (spiders will still
  climb — `TBOT3` has no slope limit; that's intended).
- Keep at least one **long sightline** (1 500–2 500 elmos) somewhere so radar and LRPC have a role,
  and plenty of **broken ground** so raiders can flank unseen.

### 12.6 Flatness budget

For each start position, check and report:

```
buildable_area(ε) = area of cells where |h - local_plane| <= ε over a WxW window
```

| Check | Window | Tolerance | Target |
|---|---|---|---|
| Lab pad | 96×96 el | ±10.7 el | ≥ 3 per start |
| Solar/fusion farm | 96×80 el | ±7.05 el | ≥ 400×400 el contiguous per start |
| Mex pad | 64×64 el | ±23.1 el | every metal spot |
| Geo pad | 80×80 el | ±10.7 el (T2 geo) | every geo vent |
| Turret pad | 32×32 el | ±9.97 el | along every choke shoulder |

---

## 13. Common beginner mistakes in BAR maps

**Scale & format**
1. Making the map too big. A 24×24 "for 8v8" plays like glue: 165 s to cross with T1. Start at 16×16.
2. Odd/illegal dimensions. `mapx` must be divisible by 128; the size unit must be even.
3. Forgetting `smf.minheight`/`maxheight` in `mapinfo.lua` and getting the header's placeholder range,
   which silently squashes or explodes the terrain.
4. Shipping 100 % unique tiles → a 100 MB+ archive for a 24×24 map. Dedup tiles.

**Slope & buildability**
5. Beautiful rolling terrain with **no flat pads**. If there isn't a 96×96 elmo area within ±10.7 elmos
   near each start, players cannot build a factory. This is the single most common fatal flaw.
6. Confusing the pathing slope rule (per 16-elmo cell, angle vs `SLOPE.*`) with the building rule
   (per-footprint height difference vs `40·tan(maxslope)`). They fail in different places.
7. Cliffs at exactly ~54° so bots sometimes climb and sometimes don't, producing erratic pathing.
   Make cliffs unambiguously > 60° or unambiguously < 50°.
8. Bumpy "noise" over the whole map: the slope map's max-of-8-triangles term means a single sharp pixel
   spike blocks a whole 16-elmo cell. Smooth the heightmap before export; keep per-square deltas under
   ~6 elmos in intended-flat areas.

**Metal**
9. One giant metal blob. Over 540 elmos across → `isMetalMap = true` and every spot-based UI (area mex,
   mex snapping, AI mex logic) turns off map-wide.
10. Blobs bigger than ~180 elmos across → no single mex captures the whole spot; players lose income
    and never understand why.
11. Spots closer than 32 elmos → they merge into one spot with double value in an odd shape.
12. Wildly inconsistent spot values with no visual signal. Players read spot value off the number the
    prospector shows; if a 4.0 spot looks identical to a 1.8 spot, the map feels random.
13. Spots on unbuildable slope (needs ±23.1 el over 64×64) or partly in > 20 el water (T1-only).
14. Too few spots. Under ~4 per player on a team map and the game is a stall-fest.
15. Leaving `extractorRadius` at the engine default **500** — every mex then drains half the map and the
    spot finder produces one giant blob. **Set `extractorRadius = 90`.**

**Geo / features**
16. Geo vent feature present but nothing painted in the texture → an invisible free 300 E/s.
17. Odd number of geos, or geos at different distances from each start.
18. Geo vents on ground too rough for the 5×5, ±10.7 el advanced-geo pad.
19. Blocking features (rocks, wrecks) sprinkled over the only flat build areas.

**Water / wind / tidal**
20. `tidalStrength = 0` on a water map, or `25` on a map with a puddle.
21. Water between −1 and −7 elmos everywhere: too deep to build on, too shallow for ships. Dead zone.
22. `maxWind` above 25 (wasted — generators cap at 25) or `minWind = maxWind = 0` by accident.
23. Setting `water.damage` for flavour and unknowingly crossing the 2 000 / 20 000 thresholds that kill
    amphibious and hover movement.

**Layout & fairness**
24. Mirroring the heightmap but hand-placing metal/features/typemap → asymmetric balance.
25. Start positions too close (< ~1 400 elmos) so T2 static defence covers the enemy base.
26. `teams{}` with fewer entries than the startboxes allow → players spawn on top of each other.
27. Only one crossing between halves → artillery stalemate; or a completely open field → no defence.
28. No back-of-base flat area, so there is nowhere to put the T2 economy.
29. Sun placed so shadows hide the terrain relief. (BAR checklist: *"Position sun on northern map area
    for optimal shadowing"*, and darken ambient/diffuse so units stand out.)
30. Not authoring the **three texture traversability levels** (vehicle-flat / bot-slope / all-terrain)
    so players cannot read pathability from the ground texture.

---

## 14. Quick validation checklist a builder can implement

```
SIZE
 [ ] mapx, mapy divisible by 128; size units even; both <= 32; neither dimension > 32
 [ ] mapinfo smf.minheight/maxheight set and consistent with the heightmap range

PATHING
 [ ] >= 60% of land area passable by TANK3 (<=27 deg)
 [ ] >= 85% of land area passable by BOT2 (<=54 deg)
 [ ] every metal spot reachable by BOT2 from at least one start without crossing >20 el water
 [ ] every start connected to every other start for BOT2 and for TANK3
 [ ] all chokepoints >= 104 el wide (hard) / >= 200 el (recommended for mains)

BUILDABILITY
 [ ] >= 3 lab pads (96x96 within +-10.7 el) per start position
 [ ] >= 400x400 el of solar-flat (+-7.05 el over 96x80) per start
 [ ] every metal spot has a 64x64 pad within +-23.1 el
 [ ] every geo vent has an 80x80 pad within +-10.7 el

METAL
 [ ] extractorRadius == 90
 [ ] no connected metal blob > 540 el in either axis   (else isMetalMap)
 [ ] no blob > 180 el across                            (else un-capturable)
 [ ] spot separation >= 32 el
 [ ] spots per player within [4,6] team / [12,16] 1v1
 [ ] spot values mirrored under the map's symmetry, within 1%

GEO
 [ ] geo count even (or centre-symmetric), mirrored positions
 [ ] each geo has a matching texture vent/crack

ENVIRONMENT
 [ ] 0 <= minWind <= maxWind <= 30 ; maxWind <= 25 unless intentional
 [ ] tidalStrength in {0} if no water, else 15..25
 [ ] water.damage < 2000 unless lava is intended
 [ ] gravity in [100,130]

START
 [ ] teams{} entries >= max players across all startbox sets
 [ ] every start inside its startbox, on a buildable pad
 [ ] min start-to-start distance >= 1400 el (team) / 2500 el (1v1)
 [ ] startbox sets present for 2x1, 2x4, 2x8 and at least one FFA arrangement
```

---

## 15. Source index

| Topic | File | Key lines |
|---|---|---|
| Elmo, square, footprint, game speed | `RE:rts/Sim/Misc/GlobalConstants.h` | 17, 24, 37, 45, 52, 60 |
| Metal square size | `RE:rts/Map/MetalMap.h` | 11 |
| SMF header, tile header, feature struct | `RE:rts/Map/SMF/SMFFormat.h` | 27, 30, 33, 49–70, 82–85, 124–127, 137–140, 147–156, 178–184 |
| Header parse, sizes, height decode, height override | `RE:rts/Map/SMF/SMFReadMap.cpp` | 113–130, 146–157 |
| `tileScale = 4`, `bigSquareSize = 128` | `RE:rts/Map/SMF/SMFReadMap.h` | 181–182 |
| `mapinfo` map/atmo/water/terrainTypes parsing + defaults | `RE:rts/Map/MapInfo.cpp` | 98–116, 135–172, 234–275, 405–409, 440–452 |
| Center/max height map, slope map | `RE:rts/Map/ReadMap.cpp` | 356–373, 616–641, 742–780 |
| Metal map storage & extraction API | `RE:rts/Map/MetalMap.cpp` | 29–50, 76–95, 98–113 |
| Extractor income | `RE:rts/Sim/Units/UnitTypes/ExtractorBuilding.cpp` | 44–49, 82–146 |
| `extractRange = mapInfo->map.extractorRadius`, `maxHeightDif`, footprint scale, `levelGround` | `RE:rts/Sim/Units/UnitDef.cpp` | 423–427, 429–430, 442–443, 588, 671–672, 692, 847–848 |
| Wind/tidal energy tick | `RE:rts/Sim/Units/Unit.cpp` | 1080–1098 |
| Wind random walk, update rate | `RE:rts/Sim/Misc/Wind.cpp` / `Wind.h` | 59–75, 91–143 / 34–45 |
| MoveDef parse, `DegreesToMaxSlope`, depth mod, defaults | `RE:rts/Sim/MoveTypes/MoveDefHandler.cpp` | 84–95, 158–160, 190–300, 308–322, 744–771 |
| Ground/hover/ship speed mods | `RE:rts/Sim/MoveTypes/MoveMath/{Ground,Hover,Ship}MoveMath.cpp` | whole files |
| Slope/type lookup in speed mod | `RE:rts/Sim/MoveTypes/MoveMath/MoveMath.cpp` | 81–145 |
| Build height, terrain constraints, geo proximity | `RE:rts/Game/GameHelper.cpp` | 1188–1261, 1307–1324, 1419–1440, 1590–1646 |
| Geo feature defs | `RE:rts/Sim/Features/FeatureDefHandler.cpp` | 182–205, 232–258 |
| LOS/radar mip → elmos, raycast vs circle | `RE:rts/Sim/Misc/LosHandler.cpp` | 83–92 |
| Cannon range vs gravity & height | `RE:rts/Sim/Weapons/Cannon.cpp` | 32–56, and `GetStaticRange2D` |
| `Game.*` constants exposed to Lua | `RE:rts/Lua/LuaConstGame.cpp` | 130–176 |
| BAR move classes | `BAR:gamedata/movedefs.lua` | whole file |
| BAR LOS/radar mips, pathing rules | `BAR:gamedata/modrules.lua` | 54–110 |
| Metal spot finder | `BAR:common/upgets/api_resource_spot_finder.lua` | 27–75, 183–201, 233–360 |
| Lua metal spot placer (map-side layout) | `BAR:luarules/gadgets/map_metal_spot_placer.lua` | whole file |
| Metal brush (mapper tool, spot conventions) | `BAR:luaui/Widgets/cmd_metal_brush.lua`, `BAR:luarules/gadgets/cmd_metal_brush.lua` | 50–80, 248–286, 304–364 |
| Geo feature defs (editor) | `BAR:features/geovent.lua` | whole file |
| Startbox normalisation 0..200 | `BAR:luarules/gadgets/include/startbox_utilities.lua` | 1–41, 168–169 |
| Terrain archetypes / symmetry weights from 202 real maps | `BAR:luaui/RmlWidgets/gui_terraform_brush/newmap_archetypes.lua` | whole file |
| Map metadata schema (startboxes, startPos roles, terrain tags) | `MM:schemas/map_list.yaml`, `MM:schemas/lobby_maps.yaml` | whole files |
| Average wind Monte-Carlo table | `MM:scripts/js/src/derived_map_info.ts` | `avgWindTable` |
| Canonical BAR `mapinfo.lua` | `BP:mapinfo.lua` | 20–40, 79–80, 214–263 |
| BAR map checklist (policy) | <https://www.beyondallreason.info/guide/map-checklist> | — |
| Mapmaking resources hub | <https://www.beyondallreason.info/guide/mapmaking-resources> | — |
