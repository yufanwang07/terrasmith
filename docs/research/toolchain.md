# Existing BAR/Spring Map Toolchain & Author Workflow

> Research brief for TerraSmith. Everything below was read from primary sources (engine source,
> compiler source, editor source, official guides) during this survey; every non-obvious claim carries
> an inline citation of the form `repo :: path : line`. Where a source is a wiki page that is now behind
> an anti-bot wall, the Wayback snapshot URL is given.
>
> **Adversarial fact-check pass, 2026-09-13.** Every falsifiable claim below was re-checked against the
> primary source (raw files fetched from GitHub; see the **Verification log** at the end for the
> per-claim verdict). Corrections are marked **[CORRECTED]** inline. Claims that could not be
> confirmed from a primary source are marked **UNVERIFIED — needs confirmation** and must not be
> relied on by the binary writer. Line numbers were re-pinned to
> `RecoilEngine@master` and `springrts_smf_compiler@master` (v0.6.3, 1601 L) as of 2026-09-13.
> **The single most important correction is §2.3: BAR pre-divides `maxslope` by 1.5, so every
> slope threshold in the original draft was ~2× too permissive.**
>
> **Purpose:** (a) document the *exact* input conventions so a new tool can be a drop-in replacement,
> (b) enumerate where the incumbent tools are slow, broken, or hostile, so the new tool can beat them.

---

## 0. Executive summary

| Layer | Incumbent | Status | Key weakness |
|---|---|---|---|
| Binary writer (.smf/.smt) | **pymapconv** (`Beherith/springrts_smf_compiler`, v0.6.3, **CC0-1.0**) | *The* de-facto standard for BAR | Single-threaded Python; shells out to a 2004-era `nvdxt.exe`; exact-hash-only tile dedup; several silent-corruption bugs (typemap, featurelist, featuremap-grass, 16-bit metalmap); Windows-first |
| Binary writer (legacy) | C++ `mapconv` (Mother's / BrainDamage / abma), `smf_tools` | Dead (last real work 2009–2014; smf_tools archived 2023) | O(n²) lossy tile matching, pinstriping, requires `-i` heightmap flip |
| Binary writer (SpringBoard's) | **MapConvNG** — `bin/windows/springMapConvNG.exe` / `bin/linux/mapcompile`, driven by `SpringBoard-Core :: dist_cfg/exts/compiler.js` | Alive but **closed/vendored** — no public source repo found | Ships only as a binary inside the SpringBoard/spring-launcher distribution; different CLI from both pymapconv and the C++ mapconv **[CORRECTED — the original draft listed MapConvNG as a dead wiki link; it is in fact what SpringBoard actually shells out to]** |
| Terrain authoring | **World Machine** (+ L3DT, Gaea, Blender, Photoshop/GIMP) | Alive, dominant | No Spring awareness at all; every resolution/flip/channel convention is manual |
| In-engine editing | **SpringBoard** (`Spring-SpringBoard/SpringBoard-Core`) | Alive but niche | Runs *inside* Spring; needs a launcher-side host process to compile; heavy; never adopted by BAR |
| In-engine editing (new) | **BAR Terraform Brush** (`doc/TerraformBrush.md`, widget in BAR master) | Actively developed 2025–26 | Only exports heightmap PNG + per-tool sidecars; cannot write .smf; explicitly lists "Direct map-file workflow" as unbuilt backlog item #18 |
| Validation / QA | Nothing that looks at terrain. `maps-metadata` validates *metadata*; pathability is checked by *playing the map* in SpringBoard with 7 stub units | **This is the biggest open hole in the ecosystem** |

**The single largest interop win** is to read and write pymapconv's input conventions byte-for-byte
(see §3.2 and the argparse `@file` settings format in §3.6), because every BAR map in the pool was
built that way and every mapper's muscle memory and `.tmd`/PSD source tree is shaped around it.

---

## 1. The target format: SMF / SMT / SD7

### 1.1 Archive layout (.sd7)

A BAR map ships as a **7-Zip archive renamed `.sd7`** (or an unpacked `<name>.sdd/` directory, which the
engine loads identically — the standard iteration trick).

```
MyMap.sd7                     # 7z, MUST NOT be solid (-ms=off)
├── mapinfo.lua               # required; the map's whole config (see §1.6)
├── mapoptions.lua            # optional map modoptions
├── maps/
│   ├── MyMap.smf             # heightmap, typemap, metalmap, grass, minimap, tile index, features
│   └── MyMap.smt             # DXT1 tile atlas
├── maphelper/                # comes from the "Map Helper v1" dependency archive
├── mapconfig/                # start boxes, metal spot lua, etc.
├── LuaGaia/, LuaRules/       # feature placer gadget etc. (convention, not required by BAR's guide)
├── features/, objects3d/, unittextures/   # custom feature defs + models + textures
└── (SSMF textures: normals/specular/splat DDS, skybox, DNTS)
```
Source for the required top-level directories: BAR's own file-structure guide
(<https://www.beyondallreason.info/guide/mapping-1-file-structure-prerequisites>), which names exactly
`/features`, `/mapconfig`, `/maphelper`, `/maps`, `/objects3d`, `/unittextures`, `mapinfo.lua` and
`mapoptions.lua` — **[CORRECTED] `LuaGaia/` and `LuaRules/` are *not* in BAR's required list**; they come
from the boilerplate generated by `smf_tools/src/makemap.sh` (LuaGaia/main.lua, LuaGaia/draw.lua,
LuaGaia/Gadgets/featureplacer.lua, features.lua, mapinfo.lua — `smf_tools :: src/makemap.sh:393,421-521`)
and from the maps that use a feature-placer gadget instead of SMF-embedded features.

**Gotcha (classic, still bites people):** a *solid* 7z archive makes the map invisible to Spring. Use
`7z a -ms=off`. BAR CI actually asserts this:
`maps-metadata :: scripts/js/src/check_archive_not_solid.ts` fails the build on `meta.isArchiveSolid`.

**Gotcha:** renaming the `.smt` after compiling without fixing the name recorded inside the `.smf`
produces the famous **pink map**. **[CORRECTED — the mechanism, verified in the loader]:**

- `SMFFormat.h:108-113`'s doc comment claims "Spring prepends the filename with `maps/`". **That comment
  is stale.** The loader actually prepends the *directory of the `.smf` itself*:
  `const std::string& smfDir = FileSystem::GetDirectory(gameSetup->MapFileName());` … `smtFilePath = smfDir + smtFileName`
  (`RecoilEngine :: rts/Map/SMF/SMFGroundTextures.cpp:123, :140-143`). In a conventional archive that
  directory *is* `maps/`, so the observable behaviour matches — but a writer must record a **bare
  filename relative to the .smf's own directory**, not a path containing `maps/`.
- If that fails, it retries the bare string as an absolute/VFS path (`SMFGroundTextures.cpp:148-149`).
- If the file still is not found, the engine does **not** error out — it fills every tile with byte
  `0xaa`: `memset(&tiles[curTile * SMALL_TILE_SIZE], 0xaa, numSmallTiles * SMALL_TILE_SIZE);`
  and logs *"could not find .smt tile-file %d (\"%s\"; ALL %d SMALL TILES WILL BE MADE RED)"*
  (`SMFGroundTextures.cpp:151-159`). **`0xaa` bytes decoded as DXT1 are the pink/magenta map.**
- `mapinfo.lua`'s `smf.smtFileName0..N` overrides the embedded names **only if the count matches**
  `MapTileHeader.numTileFiles`; otherwise the engine logs a warning and keeps the embedded names
  (`SMFGroundTextures.cpp:126-130`).

### 1.2 `SMFHeader` — exact layout (80 bytes)

From `RecoilEngine :: rts/Map/SMF/SMFFormat.h:49-70` (struct `SMFHeader`) and the matching Python struct in
`springrts_smf_compiler :: src/pymapconv.py:38` (`'< 16s i i i i i i i f f i i i i i i i'`, `struct.calcsize` = **80**;
verified by running `struct.calcsize`). The C++ struct is 17 naturally-aligned 4-byte members after a
`char[16]`, so it has **no padding** and `sizeof(SMFHeader) == 80` too — the engine relies on this when it
seeks to the extra headers with `ifs.Seek(sizeof(SMFHeader))` (`SMFMapFile.cpp:242`).

Field order on disk is fixed by the explicit sequential reader
`CSMFMapFile::ReadMapHeader` (`RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp:293-313`), not by struct layout —
so the table below is authoritative regardless of compiler packing.

All integers are **little-endian on disk**. The engine byte-swaps on read via `swabDWordInPlace` /
`swabWordInPlace` (`RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp:108`, `:251-252`; the per-field helpers are
`ReadInt`/`ReadFloat` at `:274-289`), i.e. the file is LE and big-endian hosts fix it up at load time.

| Off | Size | Type | Field | Semantics / constraint |
|----:|----:|---|---|---|
| 0 | 16 | `char[16]` | `magic` | `"spring map file\0"` — engine does `strcmp(h.magic,"spring map file")==0` (`SMFMapFile.cpp:27`) |
| 16 | 4 | `int32` | `version` | must be `1` (`SMFMapFile.cpp:18`) |
| 20 | 4 | `int32` | `mapid` | "sort of a GUID"; engine ignores it. Regression testers treat bytes 20–23 as the only allowed diff (`springrts_smf_compiler :: regression_tester/README.md`) |
| 24 | 4 | `int32` | `mapx` | width in **squares**. `mapx = texture_width / 8 = 64 × springMapSizeX`. Header doc says "must be divisible by 128" |
| 28 | 4 | `int32` | `mapy` | length in squares |
| 32 | 4 | `int32` | `squareSize` | must be `8` (elmos per square) — hard-checked `SMFMapFile.cpp:24` |
| 36 | 4 | `int32` | `texelPerSquare` | must be `8` — hard-checked `SMFMapFile.cpp:22` |
| 40 | 4 | `int32` | `tilesize` | must be `32` — hard-checked `SMFMapFile.cpp:20` |
| 44 | 4 | `float32` | `minHeight` | world height that heightmap value `0` maps to |
| 48 | 4 | `float32` | `maxHeight` | world height that heightmap value `0xFFFF` maps to |
| 52 | 4 | `int32` | `heightmapPtr` | file offset → `uint16[(mapy+1)*(mapx+1)]` |
| 56 | 4 | `int32` | `typeMapPtr` | file offset → `uint8[(mapy/2)*(mapx/2)]` |
| 60 | 4 | `int32` | `tilesPtr` | file offset → `MapTileHeader` |
| 64 | 4 | `int32` | `minimapPtr` | file offset → 699 048 bytes of DXT1 + 8 mips |
| 68 | 4 | `int32` | `metalmapPtr` | file offset → `uint8[(mapx/2)*(mapy/2)]` |
| 72 | 4 | `int32` | `featurePtr` | file offset → `MapFeatureHeader` |
| 76 | 4 | `int32` | `numExtraHeaders` | count of `ExtraHeader` records that immediately follow |

**Only the four `must be` fields plus the magic are actually validated at load** (`CheckHeader`,
`SMFMapFile.cpp:16-28` — verbatim: `version != 1`, `tilesize != 32`, `texelPerSquare != 8`,
`squareSize != 8`, then `std::strcmp(h.magic, "spring map file") == 0`). Note the magic test is
`strcmp` against a 15-char string, so byte 15 must be `\0` and bytes 16.. are the next field.

`mapx % 128 != 0` will *not* be rejected by `CheckHeader`, but **the map will still be broken**
**[CORRECTED — the original draft implied the engine merely tolerates it]**: `CSMFReadMap::ParseHeader`
computes `numBigTexX = header.mapx / bigSquareSize` with `bigSquareSize = 32 * tileScale = 128`
(`SMFReadMap.cpp:120-121`, `SMFReadMap.h:181-182`), and `static_assert(bigSquareSize == PATCH_SIZE)`
ties that to the ROAM mesh patch size `PATCH_SIZE = 128` (`SMFReadMap.cpp:480`;
`rts/Map/SMF/ROAM/Patch.h:23`). Integer truncation means the last `mapx % 128` squares get **no ground
texture patch and no ROAM patch at all**. pymapconv independently forbids it by demanding the texture be
a multiple of 1024 px (`pymapconv.py:446-448`) → `springMapSize` even → `mapx = 64·N` divisible by 128.
**Treat `mapx % 128 == 0` and `mapy % 128 == 0` as hard writer invariants.**
*(Whether any shipped BAR map is odd-sized: **UNVERIFIED — needs confirmation**; the BAR map pool was not
enumerated in this pass.)*

### 1.3 `ExtraHeader` and the vegetation (grass) map

```c
struct ExtraHeader { int size; int type; };   // SMFFormat.h
```
`type == 1` (`MEH_Vegetation`) is followed by **one more int**, the offset of the grass map — this third
field is *not* in the engine header struct and is documented only as a comment in pymapconv:

> `int extraoffset ; //MISSING FROM DOCS, only exists if type=1 (vegmap)`
> — `springrts_smf_compiler :: src/pymapconv.py:60-63` (`ExtraHeader_struct = struct.Struct('< i i i')`)

The engine reads it positionally (`RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp:239-270`, `ReadGrassMap`):

```c
ifs.Seek(sizeof(SMFHeader));                       // == 80
for (int a = 0; a < header.numExtraHeaders; ++a) {
    ifs.Read(&size,4); ifs.Read(&type,4);          // both swabbed
    if (type == MEH_Vegetation) {
        ifs.Read(&pos,4); ifs.Seek(pos);
        ifs.Read(data, header.mapx/4 * header.mapy/4);
        return true;                               // stops scanning immediately
    }
    assert((size - 8) <= (header.mapx/4 * header.mapy/4));
    ifs.Read(data, size - 8);                      // skip an unknown extra header
}
```

So `size` is the **whole** extra-header record including its own 8-byte prefix; for the vegetation
header `size = 12`, `type = 1` (`MEH_Vegetation`, `SMFFormat.h:103`), `offset = <vegmap byte offset>`.
Note the engine never validates `size` for the vegetation record (it returns before using it) but a
*different* unknown extra header with `size - 8 > mapx/4*mapy/4` trips an assert in debug builds.
Grass data is `uint8[(mapx/4)*(mapy/4)]`, 0 = none. Old maps used 0/1 binary; the modern engine uses
0–254 as density (pymapconv's decompiler prints "old style (binary) grass" vs
"new style 0-254 awesome grass"). pymapconv writes `ExtraHeader_struct.pack(12, 1, vegmapPtr)` with
`vegmapPtr = 80 + 12 = 92` (`pymapconv.py:1032, :1049`).

### 1.4 Tile section

At `tilesPtr`:
```c
struct MapTileHeader { int numTileFiles; int numTiles; };     // 8 bytes
// then, numTileFiles times:
//   int  numTilesInThisFile
//   char filename[]   (NUL-terminated; resolved relative to the .smf's own directory)
// then:
//   int32 tileIndex[(mapx/4) * (mapy/4)]   // raster order, row-major, x fastest
```
`RecoilEngine :: rts/Map/SMF/SMFFormat.h:107-127` (MapTileHeader + doc block);
engine reader: `rts/Map/SMF/SMFGroundTextures.cpp:105-182`;
pymapconv writer: `pymapconv.py:1063-1066`; pymapconv reader: `pymapconv.py:1286-1300`.

Tiles from multiple files are numbered consecutively: file 0 owns `[0, n0)`, file 1 owns `[n0, n0+n1)`, etc.

**Writer invariants the engine actually enforces** (all from `SMFGroundTextures.cpp`, added in this
fact-check pass — the original draft omitted them):
- `smfMap->tileCount > 0`, else `content_error` (`:110-113`). `tileCount = mapx*mapy/16`.
- The tile buffer is sized from `MapTileHeader.numTiles`: `tiles.assign(numTiles * SMALL_TILE_SIZE, 0)`
  (`:117`), and each file's tiles are appended at `curTile++` (`:173-175`). **`Σ numTilesInThisFile`
  must equal `MapTileHeader.numTiles`** or the engine writes past the buffer / leaves it short.
- The filename is read with `ReadString` into a `char[256]` (`:134, :137`) — **max 255 bytes**.
- Each `.smt`'s `TileFileHeader` is hard-validated: `magic == "spring tilefile"`, `version == 1`,
  `tileSize == 32`, `compressionType == 1`; any mismatch throws `content_error` (`:165-171`).
- Every `tileIndex` entry is read and byte-swapped (`:178-182`); out-of-range indices are **not**
  bounds-checked here.

Engine-side derived constants (`RecoilEngine :: rts/Map/SMF/SMFReadMap.cpp:120-129`, `SMFReadMap.h:181-183`,
`rts/Sim/Misc/GlobalConstants.h:24` for `SQUARE_SIZE = 8`):

```
tileScale      = 4                    // 4 squares per tile edge (4 × 8 elmos = 32 texels)
bigSquareSize  = 32 * tileScale = 128 // squares per streamed "big square"
bigTexSize     = 8 * 128 = 1024       // texels per big square  ← why textures must be 1024-multiples
tileMapSizeX   = mapx / 4
tileCount      = mapx*mapy / 16
mapSizeX       = mapx * 8             // elmos
```

### 1.5 `.smt` tile file

```c
struct TileFileHeader {               // 32 bytes  (struct.calcsize('< 16s i i i i') == 32)
  char magic[16];      // "spring tilefile\0"
  int  version;        // 1
  int  numTiles;
  int  tileSize;       // 32
  int  compressionType;// 1 = DXT1
};
// then numTiles × 680 raw bytes
```
`SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6) = 512+128+32+8 = 680`
(`RecoilEngine :: rts/Map/SMF/SMFFormat.h:28`; struct `TileFileHeader` at `:175-183`,
`struct.calcsize('< 16s i i i i') == 32` verified). That is a 32×32 DXT1 image **plus 3 mip levels**
(16×16 = 128 B, 8×8 = 32 B, 4×4 = 8 B), stored contiguously, mip0 first, each level in row-major
4×4-block order.

### 1.6 Minimap

Always exactly `MINIMAP_SIZE = 699048` bytes (`SMFFormat.h:34`): a 1024×1024 DXT1 image with
`MINIMAP_NUM_MIPMAP = 9` levels (`SMFFormat.h:31`) — 1024, 512, 256, 128, 64, 32, 16, 8, 4. Verified arithmetic
(`Σ max(1,⌈n/4⌉)² × 8` for n = 1024…4):

```
524288 + 131072 + 32768 + 8192 + 2048 + 512 + 128 + 32 + 8 = 699048  ✓
```
Engine mip seeking: `offset += Square((mipsize+3)/4)*8; mipsize >>= 1;`
(`RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp:77-93`).

**Writing more than 699 048 bytes here crashes the produced map** — pymapconv guards this explicitly:
`smffile.write(minimapdata[:MINIMAP_SIZE])  # dont even write more than needed, or else produced map will crash!`
(`pymapconv.py:1057`). The engine reads a blind fixed-size `ifs.Read(data, MINIMAP_SIZE)` at
`header.minimapPtr` (`SMFMapFile.cpp:70-75`), so **too few** bytes is equally fatal.

### 1.7 Feature section

At `featurePtr`:
```c
struct MapFeatureHeader { int numFeatureType; int numFeatures; };   // note the ORDER
// then numFeatureType NUL-terminated strings
// then numFeatures × MapFeatureStruct (24 bytes each)
struct MapFeatureStruct {
  int   featureType;    // index into the string table
  float xpos;           // elmos
  float ypos;           // IGNORED by the engine (see below)
  float zpos;           // elmos
  float rotation;       // "-32768..32767 for full circle" (SMFFormat.h:155); cast to short by the engine
  float relativeSize;   // "Not used at the moment keep 1" (SMFFormat.h:156)
};
```
`struct.calcsize('< i f f f f f') == 24` (verified). Field order is fixed by the sequential reader
`CSMFMapFile::ReadMapFeatureStruct` (`SMFMapFile.cpp:323-331`), and the header order
(`numFeatureType` **then** `numFeatures`) by `ReadMapFeatureHeader` (`SMFMapFile.cpp:316-320`) and
`SMFFormat.h:135-139`.

Load-bearing gotchas:

1. **`ypos` is thrown away.** `RecoilEngine :: rts/Sim/Features/FeatureHandler.cpp:88` builds the feature
   position as `float3(mfi[a].pos.x, CGround::GetHeightReal(mfi[a].pos.x, mfi[a].pos.z), mfi[a].pos.z)`.
   The feature is always snapped to terrain. (This is why BAR's checklist says *"Ensure features do not
   use a fixed Y value, so they will float in the air on water-height changes (use python script to
   convert Springboard feature-placement.lua file)"*.)
2. **`rotation` is a float in the file but a `short` in the engine**:
   `static_cast<short int>(mfi[a].rotation)` (`FeatureHandler.cpp:95`) → `params.heading`. So the useful
   range is −32768…32767 for a full turn, and fractional values are truncated toward zero. Values
   outside that range are implementation-defined on conversion — clamp before writing.
3. **[CORRECTED] An unresolvable feature name is skipped, but it is NOT silent.** The call site is
   `GetFeatureDef(readMap->GetFeatureTypeName(mfi[a].featureType), true)` (`FeatureHandler.cpp:78`) —
   the second argument is `showError`, and with it true `CFeatureDefHandler::GetFeatureDef` emits
   `LOG_L(L_ERROR, "[%s] could not find FeatureDef \"%s\"", …)` before returning null
   (`rts/Sim/Features/FeatureDefHandler.cpp:208-224`). The feature is then dropped
   (`FeatureHandler.cpp:80-81`). So the featurelist newline bug (§3.8) *does* leave a trace — an
   `ERROR` line per bad feature in `infolog.txt` — but nothing surfaces it in-game, which is why it
   reads as silent in practice.
4. **[ADDED] Feature type names are matched case-insensitively.** `GetFeatureDef` does
   `StringToLowerInPlace(name)` before the map lookup (`FeatureDefHandler.cpp:214`), and
   `LoadFeatureDefsFromMap` lowercases every SMF feature-type name first
   (`FeatureDefHandler.cpp:237`). A writer may emit any case.
5. **[ADDED] Two reserved name substrings auto-create feature defs.** For any SMF feature-type name with
   no matching game FeatureDef, the engine checks `name.find("treetype")` then `name.find("geovent")`
   (substring, on the lowercased name) and synthesises a default tree / geo def; anything else logs
   *"unknown map default feature-type"* (`FeatureDefHandler.cpp:226-258`). A default `geovent` def is
   always added even if the map declares none (`:255-258`). This is why the classic
   `TreeType0..15` + `GeoVent` table (§4.2) works with no game support.
6. **[ADDED — hard writer limits, from `rts/Map/SMF/SMFMapFile.h:62` `char featureTypes[16384][32]`]:**
   - `numFeatureType` **must be ≤ 16384**, else the engine throws `content_error`
     *"excess feature-types defined"* (`SMFMapFile.cpp:144-151`).
   - Each name is read one byte at a time into a 32-byte slot with the loop bound `j < K-1 == 31`
     (`SMFMapFile.cpp:153-162`), breaking on the NUL. **A name of 31 or more characters is never
     NUL-terminated within the loop, so the terminator is left in the stream and every subsequent name
     — plus `featureFileOffset = ifs.GetPos()` (`:164`), the start of the `MapFeatureStruct` array —
     is shifted.** Enforce **feature type names ≤ 30 characters**.
7. The `MapFeatureStruct` array begins immediately after the last name's NUL; there is no alignment
   padding (`SMFMapFile.cpp:164, :168-182`).

> **Claimed wiki error (original draft):** <https://springrts.com/wiki/Mapdev:SMF_format> was said to
> document the feature header as `numFeatures` then `numFeatureType`, i.e. backwards.
> **UNVERIFIED — needs confirmation.** The live wiki is behind an anti-bot wall and every Wayback
> snapshot tried (`2022id_`, `20200101id_`, `20180101id_`, `20150101id_`) returns only a 5–6 KB page
> shell with no article body. The *engine* order is confirmed beyond doubt (`SMFFormat.h:135-139`,
> `SMFMapFile.cpp:316-320`): **`numFeatureType` first**. Trust the header.

### 1.8 Heightmap semantics and quantization

```c
mapFile.ReadHeightmap(cornerHeightMapSyncedData, cornerHeightMapUnsyncedData,
                      minHgt, (maxHgt - minHgt) / 65536.0f);     // SMFReadMap.cpp:157
...
sHeightMap[i] = base + swabWord(word) * mod;                     // SMFMapFile.cpp:132
```
i.e. **`height = minHeight + raw × (maxHeight − minHeight) / 65536`** — note the divisor is `65536`,
**not** `65535`. Raw `0xFFFF` therefore lands `(max−min)/65536` *below* `maxHeight`. The vertical
quantum is `(max−min)/65536` elmos; for a typical BAR map with `min=-160, max=640` that's ~0.0122 elmos.

`mapinfo.lua`'s `smf.minHeight` / `smf.maxHeight` override the compiled values, and the engine tracks
which were explicitly present (`smf.minHeightOverride = smfTable.KeyExists("minHeight")`,
`RecoilEngine :: rts/Map/MapInfo.cpp:406-409`; consumed at `SMFReadMap.cpp:146-147`). **You can re-scale
a map's vertical range without recompiling** — a fact worth exploiting in a new tool.

Note the asymmetry a round-tripper must respect: the engine decodes with `/65536`, but the legacy C++
`mapconv` *encoded* with `/65535` (`BrainDamage/MapConv :: MapConv.cpp:291, :303`). Maps compiled with
the old tool are therefore ~1 LSB taller than a `/65536` re-encode would produce.

### 1.9 Derived resolutions (memorize this table)

Let `N` = spring map size in "map units" along an axis (the number you see in the lobby, e.g. `20x10`).
`N` must be **even** (texture must be a multiple of 1024 px).

| Layer | Resolution | Per-texel meaning |
|---|---|---|
| Diffuse texture (input) | `512·N × 512·M` px | 1 texel per elmo |
| `mapx` / `mapy` (squares) | `64·N` / `64·M` | — |
| World size | `512·N × 512·M` elmos | — |
| Heightmap | `(64·N + 1) × (64·M + 1)`, uint16 | corner heights, 8 elmos apart |
| Typemap | `32·N × 32·M`, uint8 | 1 per 2×2 squares (16 elmos) |
| Metalmap | `32·N × 32·M`, uint8 | 1 per 2×2 squares |
| Grass/veg map | `16·N × 16·M`, uint8 | 1 per 4×4 squares |
| Featuremap (input only) | `64·N × 64·M` px | 1 per square (8 elmos) |
| Tile index | `16·N × 16·M` int32 | 1 per 32×32-texel tile |
| Minimap | 1024 × 1024 | fixed |
| Normal map (SSMF, optional) | up to `512·N` (1:1 with diffuse) | BAR checklist: "highest resolution, ideally 1:1" |
| Specular (SSMF, optional) | typically `256·N` (half-res) | |
| Splat distribution (SSMF) | power-of-two, ≥2048 | RGBA; each channel picks one DNTS |

`GetInfoMapSize` in the engine confirms the unitsync-visible sizes:
`height → (mapx+1, mapy+1)`, `grass → (mapx/4, mapy/4)`, `metal → (mapx/2, mapy/2)`, `type → (mapx/2, mapy/2)`
(`RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp:193-203`).

### 1.10 Worked size calculation — a 16 × 16 map

```
N = M = 16
diffuse texture      = 8192 × 8192 px  (RGB, 201 MB raw; PIL holds it as ~192 MiB + copies)
mapx = mapy          = 8192 / 8 = 1024              (1024 % 128 == 0 ✓)
world size           = 8192 × 8192 elmos
heightmap PNG        = 1025 × 1025, 16-bit grey      → 1025² × 2 =  2 101 250 B in the SMF
typemap              =  512 × 512                    →              262 144 B
metalmap             =  512 × 512                    →              262 144 B
grass/veg map        =  256 × 256                    →               65 536 B
minimap              =  fixed                        →              699 048 B
tile index           =  256 × 256 × int32            →              262 144 B
featuremap (input)   = 1024 × 1024 px
max distinct tiles   =  256 × 256 = 65 536

SMF total (no features):
   80   SMFHeader
 + 12   ExtraHeader (vegmap)
 +  65 536  vegmap
 + 2 101 250  heightmap
 +   262 144  typemap
 +   699 048  minimap
 +   262 144  metalmap
 +       8  MapTileHeader
 +       4 + len("MyMap.smt") + 1   = 14
 +   262 144  tile index
 +       8  MapFeatureHeader
 +   Σ(len(name)+1) for feature types
 +   24 × numFeatures
 =   3 652 388 B ≈ 3.48 MiB + feature table     [CORRECTED: draft said 3 652 392; re-summed]

SMT worst case (zero dedup — the normal case on photographic textures):
   32 + 65 536 × 680 = 44 564 512 B ≈ 42.5 MiB
```

Scaling table (square maps, worst-case SMT = `174080·N²` bytes):

| N | texture px | mapx | heightmap px | max tiles | SMT worst case |
|---:|---:|---:|---:|---:|---:|
| 8 | 4096² | 512 | 513² | 16 384 | 11.1 MB |
| 16 | 8192² | 1024 | 1025² | 65 536 | 44.6 MB |
| 24 | 12288² | 1536 | 1537² | 147 456 | 100.3 MB |
| 32 | 16384² | 2048 | 2049² | 262 144 | 178.3 MB |

BAR caps maps at **32 in any dimension** — verbatim: *"Maps larger than 32x32 or 32 in any dimension will
not be accepted"* (<https://www.beyondallreason.info/guide/map-checklist>). **[CORRECTED — the draft's
quotation ("…as larger maps become unplayable and strain the engine") is not the checklist's wording.]**
At N=32 the *input* diffuse is a 268-megapixel image; this alone is a dominant workflow pain point.

### 1.11 `mapinfo.lua` — what the engine actually reads

Parsed by `RecoilEngine :: rts/Map/MapInfo.cpp`. Full tag reference:
<https://web.archive.org/web/2022id_/https://springrts.com/wiki/Mapdev:mapinfo.lua>.
Sections: `mapinfo` (name/shortname/description/author/version/mapfile/modtype/depend), `smf`, `sound`,
`resources`, `splats`, `atmosphere`, `grass`, `lighting`, `water`, `teams`, `terrainTypes`, `custom`.

Fields a compiler must be aware of:

All key lookups are **case-insensitive**: `LuaTable::PushValue` lowercases the C++-side key whenever the
parser has `lowerCppKeys` (default true), and the Lua-side keys are lowered to match
(`RecoilEngine :: rts/Lua/LuaParser.cpp:999-1001`). BAR's `maps-metadata` mirrors this with its own
`lowerKeys()` helper (`maps-metadata :: scripts/js/src/maps_metadata.ts:106-120`, comment:
*"We lower keys, because in Recoil engine, the keys are case insensitive in mapinfo"*).

Defaults verified line-by-line in `RecoilEngine :: rts/Map/MapInfo.cpp`:

- `maphardness` **100** (`:98`), `notDeformable` false (`:99`), `gravity` **130** (`:101`),
  `tidalStrength` **0.0** (`:105`), `maxMetal` **0.02** (`:106`), `extractorRadius` **500** (`:107`),
  `voidAlphaMin` **0.9** (`:108`), `voidWater` false (`:109`), `voidGround` false (`:110`),
  `autoShowMetal` **true** (`:124`). Post-clamps at `:113-116`: `hardness = max(0.001,|h|)·sign(h)`,
  `tidalStrength/maxMetal/extractorRadius = max(0, ·)`. `gravity` is negated and divided by
  `GAME_SPEED²` before use (`:103`).
- `smf = { minHeight, maxHeight, minimapTex, metalmapTex, typemapTex, grassmapTex, smtFileName0..N }`
  — every compiled layer can be overridden by a loose image file.
  Source: `MapInfo.cpp:404-428` (`ReadSMF`), fields `smf.minimapTexName` … `smf.grassmapTexName`;
  `smtFileName%i` is scanned from 0 until the first missing key (`:421-428`).
- `resources = { detailTex, specularTex, splatDetailTex, splatDistrTex, grassShadingTex,
  skyReflectModTex, detailNormalTex, lightEmissionTex, parallaxHeightTex }`
  — this is literally a `std::array<…, 9>` at `MapInfo.cpp:361-371`; note `detailNormalTex` maps to the
  internal field `blendNormalsTexName`. `splatDetailNormalTex1..4` are parsed separately, either as a
  `splatDetailNormalTex` **sub-table** with an `alpha` flag or as flat
  `splatDetailNormalTex1`…`N` keys (`MapInfo.cpp:340-400`) — the loop is open-ended and stops at the
  first missing index, while the *renderer* clamps to `NUM_SPLAT_DETAIL_NORMALS = 4`
  (`SMFReadMap.h:183`, used at `SMFReadMap.cpp:305, :800, :1000`). **Keys are 1-based, not 0-based.**
- `splats = { texScales, texMults }` — both `float4`, defaults `(0.02,0.02,0.02,0.02)` and
  `(1,1,1,1)` (`MapInfo.cpp:181-182`).
- `terrainTypes[0..255] = { name="Default", hardness=1.0, receiveTracks=true,
  moveSpeeds={tank=1,kbot=1,hover=1,ship=1} }` (`MapInfo.cpp:432-458` `ReadTerrainTypes`;
  `NUM_TERRAIN_TYPES = 256` at `rts/Map/MapInfo.h:25`). Speeds are clamped to `max(0, ·)` and hardness
  to `max(0.001, ·)` (`:452-456`). These are the semantics of the **typemap**.
- `pfs.qtpfsConstants = { layersPerUpdate, maxTeamSearches, minNodeSizeX/Z, maxNodeDepth,
  numSpeedModBins, minSpeedModVal, maxSpeedModVal, maxNodesSearched, maxRelativeNodesSearched }`.

A complete, known-good boilerplate `mapinfo.lua` is embedded in
`enetheru/smf_tools :: src/makemap.sh` — worth lifting verbatim as a template default.

---

## 2. Engine-side facts a terrain tool must respect

### 2.1 Slope map — how the engine derives steepness

`RecoilEngine :: rts/Map/ReadMap.cpp:690-738` (`UpdateFaceNormals`) and `:741-781` (`UpdateSlopemap`).
**[Line range corrected from the draft's `:672-780`.]**

Per **square** (`mapx × mapy`), two face normals are computed from the four corner heights
(`ReadMap.cpp:690-729`):

```c
// hTL, hTR, hBL, hBR are corner heights of the square; SQUARE_SIZE == 8
fnTL = normalize( ( -(hTR-hTL), 8, -(hBL-hTL) ) );   // top-left triangle
fnBR = normalize( (  (hBL-hBR), 8,  (hTR-hBR) ) );   // bottom-right triangle
centerNormal[y*mapx+x] = normalize(fnTL + fnBR);
```

Then `UpdateSlopemap` reduces to a **half-resolution** slope map (`hmapx × hmapy` = `mapx/2 × mapy/2`,
i.e. the same grid as the typemap/metalmap) over the 8 face normals of the 2×2 square block:

```c
// ReadMap.cpp:751-778, exact
idx0 = (y*2    ) * mapx + x*2;
idx1 = (y*2 + 1) * mapx + x*2;
// the 8 face normals are faceNormalsSynced[(idxN + {0,1}) * 2 + {0,1}] for N in {0,1}
avgslope = (sum of those 8 .y) * 0.125f;
maxslope = min  of those 8 .y;            // "max slope" == smallest normal.y
lerp  = maxslope / avgslope;
slope = mix(maxslope, avgslope, lerp);    // "smooth it a bit, so small holes don't block huge tanks"
slopeMap[y*hmapx + x] = 1.0f - slope;
```
with `mix(v1, v2, a) == v1 + (v2 - v1) * a` (`RecoilEngine :: rts/System/SpringMath.h:169`) — so
`slope = maxslope + (avgslope − maxslope) · (maxslope/avgslope)`. Note the *commented-out* older
definition on `SpringMath.h:168` is the algebraically equivalent `v1*(1-a) + v2*a`; use the live one.

So **`slopeMap ∈ [0,1]`, `0` = flat, and it equals `1 − n_y` of a blended normal.** Any validator must
reproduce *this* (including the `mix`), not a naïve gradient, or it will disagree with the engine.
`slopeMap` is sized `mapDims.hmapx * mapDims.hmapy` and has **no unsynced variant**
(`ReadMap.cpp:372-373, :396-397`).

### 2.2 Move classes: how `maxSlope` maps to a threshold

`RecoilEngine :: rts/Sim/MoveTypes/MoveDefHandler.cpp:84-95`:

```c
static float DegreesToMaxSlope(float degrees) {
    const float deg = std::clamp(degrees, 0.0f, 60.0f) * 1.5f;
    return 1.0f - math::cos(deg * DEG_TO_RAD);
}
```
Defaults: `maxSlope = 60` for Tank/KBot classes, `15` for Hover (`MoveDefHandler.cpp:233, :238`);
Ship has no `maxSlope` at all (`:242-243`). `slopeMod` defaults to `4.0f / (maxSlope + 0.001f)`
(`MoveDefHandler.cpp:284`, computed **after** `maxSlope` has been converted, so it is `4/threshold`,
not `4/degrees`).

**The `× 1.5` matters and is not what it looks like** — see §2.3: BAR divides its own `maxslope` values
by 1.5 *before* the engine multiplies them back, so the numbers in `movedefs.lua` are true terrain
degrees.

**[CORRECTED — the draft applied the `GroundSpeedMod` rule to all classes. The three classes use three
different functions, and only `Tank`/`KBot` test both slope and depth.]**

Ground — Tank and KBot (`RecoilEngine :: rts/Sim/MoveTypes/MoveMath/GroundMoveMath.cpp:12-29`):

```c
float CMoveMath::GroundSpeedMod(const MoveDef& md, float height, float slope) {
    if (slope   >  md.maxSlope) return 0.0f;   // too steep
    if (-height >  md.depth)    return 0.0f;   // too deep (md.depth == maxWaterDepth here)
    speedMod = 1.0f / (1.0f + slope * md.slopeMod);
    speedMod *= (height < 0.0f ? waterDamageCost : 1.0f);
    speedMod *= md.GetDepthMod(height);
    return speedMod;
}
```

Hover (`HoverMoveMath.cpp:12-23`) — **no depth test at all**; water is free:

```c
if (height < 0.0f)          return (1.0f * !noHoverWaterMove);  // over water: full speed
if (slope > md.maxSlope)    return 0.0f;
return 1.0f / (1.0f + slope * md.slopeMod);
```

Ship (`ShipMoveMath.cpp:11-18`) — **slope is ignored entirely**; `md.depth` is `minWaterDepth` here
(`MoveDefHandler.cpp:242`):

```c
if (-height < md.depth) return 0.0f;   // not deep enough
return 1.0f;
```

And the terrain-type multiplier is applied on top
(`RecoilEngine :: rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:81-105`, `GetPosSpeedMod`):

```c
const int square       = (xSquare>>1) + ((zSquare>>1) * mapDims.hmapx);   // half-res index
const int terrType     = readMap->GetTypeMapSynced()[square];
const float slope      = readMap->GetSlopeMapSynced()[square];
const float height     = readMap->GetMaxHeightMapSynced()[xSquare + zSquare*mapDims.mapx];
... GroundSpeedMod(md, height, slope) * tt.tankSpeed  // or kbotSpeed / hoverSpeed / shipSpeed
```
**A terrain type with `moveSpeeds.tank = 0` makes the square impassable to vehicles regardless of slope.**
That is the mechanism behind BAR's "traversability layers" checklist item.

### 2.3 BAR's actual move classes (the numbers a validator needs)

> ### ⚠ [CORRECTED] — the single biggest error in the original draft
>
> The draft fed BAR's `SLOPE.*` constants straight into `DegreesToMaxSlope` and reported thresholds of
> `0.2396 / 0.3506 / 0.8436` (θ = 40.5° / 49.5° / 81°). **That is wrong by the factor 1.5.**
> `gamedata/movedefs.lua` pre-divides every `maxslope` by 1.5 before handing it to the engine, exactly
> cancelling the engine's `× 1.5`:
>
> ```lua
> -- beyond-all-reason/Beyond-All-Reason :: gamedata/movedefs.lua:546-555
> local function setMaxSlope(moveDef)
>     if moveDef.maxslope then
>         if type(moveDef.name) == "string" and moveDef.name:find("BOT") then
>             moveDef.slopeMod = SLOPE_MOD.MINIMUM
>         end
>         ---`maxSlope` is multiplied by 1.5 at load, so 60 degrees is its actual "maximum",
>         -- so has default value 15 * 1.5 = 22.5 for hovers and 90 for bots/vehicles/ships.
>         moveDef.maxslope = moveDef.maxslope / 1.5
>     end
> end
> ```
> `setMaxSlope(moveDef)` runs on every def before it is returned (`movedefs.lua:601-605`).
> **Net effect: the `SLOPE.*` numbers are literal terrain degrees, and the threshold on `slopeMap` is
> simply `1 − cos(SLOPE_value°)`.** Using the draft's numbers would let a validator pass ramps that no
> BAR vehicle can climb.

Reference constants, `beyond-all-reason/Beyond-All-Reason :: gamedata/movedefs.lua:41-58` — verbatim:

```lua
local SLOPE = { NONE=0, MINIMUM=27, MODERATE=33 --[[just below angle of repose]], DIFFICULT=54, EXTREME=75, MAXIMUM=90 }
local SLOPE_MOD = { MINIMUM=4, MODERATE=18, SLOW=25, VERY_SLOW=36, GLACIAL=42, MAXIMUM=4000 }
local DEPTH = { NONE=0, TICK=5, MIN_SHALLOW=8, MAX_SHALLOW=20, SUBMERGED=15,
                AMPHIBIOUS=5000, MAXIMUM=9999, DEFAULT=1000000 }   -- DEFAULT was missing from the draft
```

| Class | Example defs | `maxslope` in `movedefs.lua` | value handed to engine (`/1.5`) | threshold on `slopeMap` = `1−cos(deg·1.5)` | `maxwaterdepth` |
|---|---|---:|---:|---:|---:|
| Vehicles | `TANK2`, `TANK3`, `MTANK3`, `HTANK4`, `NANO` | `SLOPE.MINIMUM` = 27 | 18 | **`1−cos(27°) = 0.108993`** | 20 (`NANO`: 0) |
| Heavy vehicle (Ragnarok-class) | `HTANK7` | `SLOPE.MODERATE` = 33 | 22 | **`1−cos(33°) = 0.161329`** | 20 |
| Hovercraft | `HOVER2`, `HOVER3`, `HHOVER4` | `SLOPE.MODERATE` = 33 | 22 | **`0.161329`** | — (hovers ignore depth) |
| Heavy hover | `HOVER7` | literal `36` | 24 | **`1−cos(36°) = 0.190983`** | — |
| Amphib hover | `AHOVER2` | `SLOPE.DIFFICULT` = 54 | 36 | **`0.412215`** | — |
| Bots | `BOT2`, `BOT3`, `HBOT4`, `HBOT7`, `SBOT2`, `ABOT3`, `COMMANDERBOT` | `SLOPE.DIFFICULT` = 54 | 36 | **`1−cos(54°) = 0.412215`** | 20 (`SBOT2`: 5; amphib: 5000) |
| All-terrain bots | `HTBOT6` | `SLOPE.MAXIMUM` = 90 | 60 | **`1−cos(90°) = 1.0`** (never blocked by slope) | 20 |
| All-terrain bots (no key) | `TBOT3` | *absent* → engine default 60 | 60 | **`1.0`** | 20 |
| Ships | `BOAT3/4/5/9`, `UBOAT4` | (no `maxslope`; slope ignored entirely) | — | — | `minwaterdepth` 8 (`BOAT9`/`UBOAT4`: 15) gates them |

**Practical validator thresholds on `slopeMap` (`= 1 − n_y`):**
- `> 0.108993` → **no vehicles** (θ > 27°)
- `> 0.161329` → **no hovers, no heavy vehicles** (θ > 33°)
- `> 0.412215` → **no bots** (θ > 54°) — only all-terrain bots remain
- `> 1.0` → impossible; nothing is blocked by slope above `SLOPE.MAXIMUM`

Equivalently, in terms of the terrain angle θ of the blended normal (`slopeMap = 1 − cos θ`):
vehicles stop at θ = **27°**, hovers / heavy vehicles at **33°**, bots at **54°**, all-terrain at **90°**.
That is: **`SLOPE.*` reads as degrees at face value.**

Also note `slopeMod` (`SLOPE_MOD.*`) is only an *in-band speed penalty*, not a gate; BAR forces
`slopeMod = SLOPE_MOD.MINIMUM (4)` on any def whose **name contains `"BOT"`**
(`movedefs.lua:548-550`) — so bots are additionally the least slowed by slope.

### 2.4 Metal semantics

`RecoilEngine :: rts/Map/MetalMap.cpp:29-52` — `CMetalMap::Init(map, sizeX, sizeZ, metalScale)`;
`metalScale` is `mapinfo.maxMetal` (default `0.02`), passed at `rts/Map/ReadMap.cpp:167`
(`metalMap.Init(metalmapPtr, mbi.width, mbi.height, mapInfo->map.maxMetal)` with `mbi` asserted to be
`hmapx × hmapy`, `ReadMap.cpp:165-166`). `GetMetalAmount(x,z)` returns `distributionMap[…] * metalScale`
(`MetalMap.cpp:76-84`); the area overload sums it over a **half-open** box `[x1,x2) × [z1,z2)`
(`MetalMap.cpp:56-73`).

A metalmap pixel of 255 at `maxMetal = 0.02` therefore yields a metal *amount* of `5.1` for that
half-square. **[CORRECTED — the draft called this "5.1 metal/s".** The engine unit here is an abstract
metal amount; converting it to income per second depends on the extractor unitdef's `extractsMetal`
and the game's extraction logic, which was **not** traced in this pass: **UNVERIFIED — needs
confirmation**.]

So a **metal spot** is a *blob of nonzero metalmap pixels* and its strength is the **sum** of pixel
values over the extractor's footprint/radius — there is no explicit spot list in the SMF. Games that
want discrete mex spots either derive them at runtime or ship a Lua config
(Zero-K: `/mapconfig/map_metal_layout.lua`-style; BAR derives them from the metalmap).

pymapconv's `--normalizemetal` (§3.5) exists precisely because hand-painted metal blobs end up with
unequal sums and therefore unequal extraction rates.

---

## 3. pymapconv — `Beherith/springrts_smf_compiler`

Repo: <https://github.com/Beherith/springrts_smf_compiler> (note: **not** `Spring_SMF_compiler`; that
name 404s — re-tested 2026-09-13: `springrts_smf_compiler` → HTTP 200, `Spring_SMF_compiler` → HTTP 404).
Version surveyed: **0.6.3** (`src/version.py`, `__VERSION__ = "0.6.3"`, release note "Fix Image.LANCZOS").
**1601** lines of Python in one file (`src/pymapconv.py`) + a vendored `argparseui.py` for the GUI.
**[CORRECTED] License: the repo's `LICENSE` file is `CC0 1.0 Universal` (GitHub reports `CC0-1.0`),
not "MIT/PD-ish".** The source header comment is `# PD license by Beherith` /
`# You like pasghetti code? No problem, you get pasghetti code.` (`pymapconv.py:2-3`). Repo state at
survey: 14 stars, last push 2024-10-30.

This is *the* tool. BAR's own file-structure guide names it ("Spring Map Compiler (from Github.com/Beherith)")
and the map checklist references it by name for minimap tweaking.

### 3.1 Runtime shape

- Launch with **no argv → PyQt5 GUI** auto-generated from the `argparse` parser via the vendored
  `argparseui` (`pymapconv.py:1570-1600`). Launch with argv → pure CLI.
- Ships as a one-file PyInstaller `.exe` on Windows (GitHub Actions, `.github/workflows/build-and-release.yml`
  — confirmed present, alongside `validate.yml`); Linux build needs `CompressonatorCLI` and `ImageMagick`
  installed by the user (`build/linux/{build,install}.sh`).
- Python deps: `Pillow`, `pypng`, `pyqt5` (`src/requirements.txt` — confirmed verbatim; the file's own
  comment notes *"argparseui is modified, so it was vendored and included in this repo"*).
- **It shells out for all DXT compression.** Windows: `nvdxt.exe` (the ancient NVIDIA DDS Utilities tool,
  vendored at `build/win/nvdxt.exe`) plus `nvtt_export.exe` + `FreeImage.dll` for the SSMF side maps.
  Linux: `CompressonatorCLI`.

### 3.2 Inputs — exact conventions (this is the compatibility surface)

Derived from `pymapconv.py:431-900`. `mapx = texw//8`, `mapy = texh//8`,
`springmapx = texw//512`, `springmapy = texh//512` (`pymapconv.py:441-445`).
*(Line numbers in this section were re-pinned against `master`; the draft's were consistently 2–15 low.)*

| Flag | Input | Required format | Validation / behaviour |
|---|---|---|---|
| `-t/--intex` | **diffuse texture** | any PIL-readable; **both dimensions must be multiples of 1024** | Hard error otherwise (`pymapconv.py:446-448`). `RGB` preferred; `RGBA` triggers a "MEGA WARNING" (alpha is only meaningful with `voidGround`/`voidWater`) and switches all intermediates from BMP to TIFF (`:453-460`, `:901-903`) |
| `-a/--heightmap` | **heightmap** | `.png` 16-bit **greyscale, no alpha, no palette**, `(mapx+1) × (mapy+1)`; or `.raw`/`.r16` = raw little-endian `uint16`, exactly `(mapx+1)*(mapy+1)*2` bytes | Raw size hard-checked (`:528-536`); PNG bit depth, greyscale and alpha are all hard-checked (`:543-551`). Anything else (BMP/8-bit) is accepted with a terracing warning and converted as `value*255` (`:663-682`) |
| `-a` (hi-res mode) | heightmap at `mapx*8 × mapy*8` (= texture resolution) | 16-bit PNG | Special "high-res heightmap mode" (`:553-641`): pads by 4 px into an `'I'` image, then downsamples per `--highresheightmapfilter` ∈ `nearest` (default), `lanczos`, `bilinear`, `median`, `histogram`. **All outputs are clamped to `[0, 65534]`, not 65535** (`:627, :640`) |
| `-m/--metalmap` | **metal map** | `mapx/2 × mapy/2`; modes `L`, `I`, `RGB`, `RGBA` | Wrong size → **bilinear** resize (destroys crisp spots, `:694-698`). `RGB/RGBA` → red channel. `L` → value. `I` (16-bit) → **BROKEN**, see §3.8 |
| `-y/--typemap` | **type map** | `mapx/2 × mapy/2`, **must be RGB/RGBA** | Wrong size → nearest resize (`:884-887`). Greyscale → **silently ignored**, see §3.8 |
| `-f/--featuremap` | **feature map** | exactly `mapx × mapy` (hard error, `:785-788`), must be `RGB` or `RGBA` (hard error, `:782-784`) | Green 255 = geovent (`:796`); green 200–215 = `TreeType0..15` (`:800`); red 255→`featurelist[0]`, 254→`[1]`, … 1→`[254]` via `featurelist[255 - pixel[0]]` (`:806-814`); blue = grass (**broken**, §3.8, `:793-794`). Placement is at `(8·col+4, 8·row+4)` elmos |
| `-j/--featurelist` | **feature name list** | one name per line, optional ` <rotation>` second token | Index 0 = red 255. **Lines with no second token embed a `\n` in the feature name** (§3.8, `:763-773`). The rotation column is parsed to an int but **never used** |
| `-k/--featureplacement` | **feature placement file** | Lua-ish one-per-line, see below | Naïve comma/`=` split, not a Lua parse (`:735-758`) |
| `-r/--grassmap` | **grass map** | `mapx/4 × mapy/4`, any mode | Nonzero → grass; RGB averaged; clamped to 254 (`:842-845`). Wrong size → nearest resize. **This is the working grass path** |
| `-p/--minimap` | minimap override | any size (resized to 1024² with LANCZOS) | Falls back to the diffuse if it fails to open |
| `-g/--geoventfile` | geovent decal | default `./resources/geovent.bmp` (present in the repo) | Stamped into the diffuse centred on each geovent; pure white `(255,255,255)` is treated as transparent |
| `-l/--mapnormals` | normal map (→DDS) | ≤16k × 16k *(advisory only — help text, **not enforced in code**)* | Windows only; `nvtt_export.exe --output "<n>.dds" --save-flip-y --mip-filter 0 --quality 3 --format bc1` (`:408-409`) |
| `-z/--specular` (+`--specularscale`) | specular (→DDS) | ≤16k × 16k *(advisory)* | Windows only; `--format bc3` (DXT5), optionally downscaled by an integer factor first (`:410-413`, `resize_rgba_image` at `:338-375`) |
| `-w/--splatdistribution` (+`--splatdistributionscale`) | splat distribution (→DDS) | ≤16k × 16k *(advisory)* | Windows only; `--format bc3` (`:414-417`) |
| `-n/--minheight`, `-x/--maxheight` | floats | defaults `-50.0`, `100.0` | Written into the SMF header |

**Feature placement file format** (the one a new tool must emit; this is also what the decompiler writes,
`pymapconv.py:1276-1281`):

```
{ name = 'agorm_talltree6', x = 224, z = 3616, rot = "0" ,scale = 1.000000 },
```
Parser (`pymapconv.py:735-758`): split the line on `,`; for each chunk containing `=`, the key is the
text before `=` stripped of ` {}'"` and lowercased, the value is the text after `=` stripped of ` {}'"`.
Recognised keys: `name` (string), `x`, `y`, `z`, `rot`, `scale` (floats). Lines with fewer than 3
comma-separated chunks are skipped. **Consequences:** a feature name containing a comma breaks the line;
`y` defaults to 0 and is ignored by the engine anyway; `scale` is written but the engine ignores it.

**Feature list file format** (`fs.txt` historically):
```
btreeblo_1 -1
btreeblo 16000
```
Legacy semantics (from the original mapconv help text preserved verbatim at `pymapconv.py:1583-1590`):
a number from 32767 to −32768 next to the name is the rotation; `-1` means random. **pymapconv ignores
it entirely.**

### 3.3 Full CLI reference (v0.6.3, from `pymapconv.py:1356-1447`)

```
-o, --outfile                 output .smf name (a sibling .smt is created)      [my_new_map.smf]
-t, --intex                   diffuse texture (required)
-a, --heightmap               16-bit PNG or .raw/.r16 (required)
-m, --metalmap
    --normalizemetal PCT      % deviation from the median spot total to snap to the median  [0.0]
-x, --maxheight FLOAT         world height of 0xFFFF                                [100.0]
-n, --minheight FLOAT         world height of 0x0000                                [-50.0]
-g, --geoventfile             geovent decal                        [./resources/geovent.bmp]
-k, --featureplacement        feature placement text file
-j, --featurelist             feature name list (required if --featuremap given)
-f, --featuremap              feature placement image
-r, --grassmap                overrides grass from --featuremap
-y, --typemap
-p, --minimap                 override minimap (1024x1024)
-l, --mapnormals              → .dds BC1, flipped                            (Windows only)
-z, --specular                → .dds BC3, flipped                            (Windows only)
    --specularscale INT       downscale factor                                        [1]
-w, --splatdistribution       → .dds BC3, flipped                            (Windows only)
    --splatdistributionscale INT                                                      [1]
-q, --numthreads INT          parallel nvdxt jobs                          [4] (Windows only)
-u, --linux                   use AMD Compressonator instead of nvdxt   [auto on Linux]
-v, --nvdxt_options STR       extra nvdxt flags                    ['-Sinc -quality_highest']
    --highresheightmapfilter  lanczos|bilinear|nearest|median|histogram         [nearest]
-c, --dirty                   keep ./temp after compiling
-d, --decompile PATH.smf      decompile a map
-s, --skiptexture             skip texture regeneration when decompiling
```

All defaults above were read from the `add_argument` calls and are confirmed exact
(`:1358, :1371, :1374, :1377, :1380, :1427, :1431, :1434, :1438, :1441, :1446`).

Note the flag collisions with the legacy C++ tool: pymapconv's `-l` is `--mapnormals` (legacy `-l` was
`--lowpass`), `-c` is `--dirty` (legacy `-c` was `--compress`), `-z` is `--specular` (legacy `-z` was
`--texcompress`), `-v` is `--nvdxt_options` (legacy `-v` was `--version`). Old build scripts are **not**
source-compatible.

**[ADDED] Two undocumented CLI quirks found in this pass:**
- The version flag is registered as `parser.add_argument('-v,', '--version', …)` — **with a literal
  trailing comma in the short flag** (`pymapconv.py:1447`), because `-v` was already taken by
  `--nvdxt_options`. So `-v` never means `--version`, and `-v,` is the (useless) short form.
- `-q/--numthreads` is **forced to 1 whenever `--linux` is active**, before the user's value is applied
  — `if myargs.linux: numthreads = 1` then `numthreads = int(myargs.numthreads)` inside a `try`
  (`pymapconv.py:394-400`), so an explicit `-q` on Linux *does* take effect unless it fails to parse,
  but the Linux DXT path (`os.system` in a serial loop, `:917-924`) ignores it anyway.

### 3.4 The tiling + DXT1 pipeline, step by step

`pymapconv.py:896-1004`:

1. Crop the diffuse into **spatially contiguous 1024×1024 chunks** (`:904-913`):
   `intex.crop((1024*tilex, 1024*tiley, 1024*(tilex+1), 1024*(tiley+1)))`, `tilex ∈ [0, springmapx//2)`,
   `tileindex = tiley * (springmapx//2) + tilex`.
   Saved as `temp/temp<i>.BMP` (or `.TIFF` when the diffuse is RGBA).
   *(This is where pymapconv differs from and beats the C++ mapconv — see §4.2.)*
2. Compress each chunk to DXT1 with **4 mip levels** (`:916-950`):
   - Windows: `nvdxt.exe -file temp\thread<k>\temp*.BMP -dxt1a -outsamedir -nmips 4 -Sinc -quality_highest`,
     run as `numthreads` parallel processes each with its own copy of `nvdxt.exe` in `temp/thread<k>/`.
     Files are assigned round-robin by `tileindex % numthreads`.
   - Linux: `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4 temp/temp<i>.BMP temp/temp<i>.dds`,
     serially via `os.system` (`:917-924`).
   - Note `dxt1a` (1-bit alpha) is used unconditionally; the comment on the minimap path says it is to
     avoid "spurious alpha pixels".
3. Skip the **128-byte DDS header** (`ddsfile.read()[128:]`, `pymapconv.py:988`) and re-slice each
   1024² DDS into 32×32 tiles using `ReadTile` (`pymapconv.py:953-965` — transcription below verified
   character-for-character against the source):

   ```python
   def ReadTile(xpos, ypos, sourcebuf):     # xpos,ypos are multiples of 32 within the 1024² image
       outtile = b''; sourceoffset = 0
       for i in range(4):                   # mip 0..3
           div = 1 << i
           for y in range(8 // div):
               for x in range(8 // div):
                   ptr = ((x + xpos//div//4) + (y + ypos//div//4) * (256 // div)) * 8 + sourceoffset
                   outtile += sourcebuf[ptr:ptr+8]
           sourceoffset += 524288 // (1 << (i*2))   # 524288, 131072, 32768, 8192
       return outtile                       # exactly 680 bytes
   ```
   `256 // div` is the DXT1 block-row stride of the mip level; `8` is the DXT1 block size.
4. **Deduplicate tiles by exact byte equality**: `tilehash[bytes] -> index`
   (`pymapconv.py:976-1004`). "yes, we are gonna use the tiles as keys to perform rapid lossless
   compresssion :D". Tile raster position is
   `tilepos = 32*tilex + x + (32*springmapx//2) * (32*tiley + y)` (`:996`) — note
   `32*springmapx//2 == 16*springmapx == mapx/4`, i.e. the tile-index row stride. Prints
   `Lossless compression of 32x32 tiles: X tiles used of Y maximum`; the printed maximum
   `256*springmapx*springmapy` equals `(mapx/4)·(mapy/4)` and is correct. There is a live
   `# TODO: tilehash is larger than max tiles sometimes!` on `:1003`.
5. Write the `.smt` (`:1013-1017`), then the `.smf` with the layout
   `header | extra header | vegmap | heightmap | typemap | minimap | metalmap | tile section | feature section`
   (`pymapconv.py:1021-1079`). Offsets are precomputed arithmetically at `:1031-1043`, so the writer is
   single-pass. Verified pointer arithmetic:
   `vegmapPtr = 80 + 12 = 92`; `heightmapptr = vegmapPtr + mapx*mapy//16`;
   `typemapptr = heightmapptr + 2*(mapx+1)*(mapy+1)`; `minimapptr = typemapptr + mapx*mapy//4`;
   `metalmapptr = minimapptr + 699048`; `tilesptr = metalmapptr + mapx*mapy//4`;
   `featureptr = tilesptr + 4 + 4 + 4 + len(smtfilename) + 1 + 4*(mapx*mapy//16)`.

**Minimap path** (`pymapconv.py:472-524`): resize the diffuse (or `--minimap`) to 1024² with LANCZOS →
BMP (or TIFF if RGBA) → `nvdxt.exe -dxt1a -nmips 9 -Sinc -quality_highest` (or
`CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 9`) → strip 128 bytes → truncate to 699 048.
It also writes `<mapname>.jpg` (1024²) and `<mapname>.png` (128², for Chobby) next to the SMF
(`:506-512`).

### 3.5 `--normalizemetal` — the only "balance" feature in the toolchain

`pymapconv.py:215-336` (`MetalSpot` at `:215-253`, `MetalMap` at `:255-336`), invoked at `:720-722`.
Flood-fills the metalmap into 8-connected `MetalSpot` blobs (`isneighbour` is a Chebyshev-distance-≤1
test, `:223-227`), computes each blob's total, takes the **median** of all blob totals
(`totals[int(len(self.spots)/2)]` — the *upper* median, `:296`), and for every blob whose total is within
`±normalizemetal %` of the median, adds/removes value from individual pixels (highest-value pixels
first, `sortpixels` at `:252-253`) until it equals the median. Prints a before/after listing of every
spot with its centroid and total.

This is *the* seed of the "metal balance" feature and is the only thing in the ecosystem that
understands a metal spot as an object. It is also `O(pixels × spots × pixels_per_spot)` and gets slow.

**Bug in it (confirmed):** `MetalMap.__init__` builds `self.data[row][col]` from
`data[row*w:(row+1)*w]` (`pymapconv.py:256-262`) but `calcspots` iterates
`for x in range(self.w): for z in range(self.h): self.data[x][z]` (`:271-273`), and writes back
`newdata[pixel[0]*self.w + pixel[1]]` (`:332-335`). Rows and columns are transposed. On a **square**
metalmap this is a harmless transposition of the whole normalization pass; on a **non-square** map
`self.data[x]` indexes a list of length `h` with `x < w`, so it will `IndexError` (w > h) or silently
process only part of the map and write back transposed garbage (w < h).

### 3.6 The settings file format (free interop win)

The GUI's Save/Load buttons write an **argparse `fromfile_prefix_chars='@'` file**: one token per line
(`argparseui.py:712-722`, `:767-784`). The decompiler emits the same thing as
`<mapname>_compilation_settings.txt` (`pymapconv.py:1340-1352`):

```
-n
-160.0
-x
640.0
-o
MyMap_recompiled.smf
-m
MyMap_metal.bmp
-t
MyMap_texture.bmp
-a
MyMap_height.png
-g

-y
MyMap_type.bmp
-r
MyMap_grass.bmp
-k
MyMap_featureplacement.lua
```

Reading and writing this format means a new tool can import an existing project's settings and be
driven by mappers' existing `.bat`/`@file` habits with zero friction.

### 3.7 Decompiler

`SMFMapDecompiler` (`pymapconv.py:1108-1352`) emits, from an `.smf` + its `.smt`:
`_mini.dds`, `_height.png` (16-bit grey), `_metal.bmp`, `_type.bmp`, `_grass.bmp`,
`_featureplacement.lua`, `_texture.bmp`, `_compilation_settings.txt`.

The texture path decodes DXT1 **in pure Python** (`pythonDecodeDXT1`, `pymapconv.py:88-131`) — the code
itself says *"Generating texture, this is very very slow (few minutes)"* (`pymapconv.py:1313`).
`--skiptexture` exists to avoid it. There is also a `pythonEncodeDXT1` which the author annotates
*"this is absolutely trashy and slow … i havent even tested this yet, dont even think about using it"*
(`pymapconv.py:135-137`) — i.e. **there is no pure-Python compression path; the external compressor is mandatory.**

### 3.8 Known limitations & confirmed bugs in pymapconv 0.6.3

Each of these was verified against the source (and, where numeric, reproduced):

1. **Featuremap grass is a guaranteed crash / index overflow.**
   ```python
   vegmap = [0] * ((mapx // 4) * (mapy // 4))
   ...
   for row in range(featuremap.size[1]):          # 0 .. mapy-1
       for col in range(featuremap.size[0]):      # 0 .. mapx-1
           if col % 2 and row % 2:
               vegmap[(mapx // 4) * row + col] = min(254, pixel[2])   # pymapconv.py:790-794
   ```
   For a 16×16 map: `len(vegmap) = 65 536` (`:774`), and the first out-of-range write happens at
   `row = 256` (`256*256 + col >= 65 536`), long before the loop ends at `row = 1023`. Python raises
   `IndexError`. **`--featuremap`'s blue channel is unusable; you must use `--grassmap`.**
2. **16-bit (`mode 'I'`) metalmaps crash the writer.** `metalmap.append(metalimage_pixels[col,row]/256.0)`
   produces a float (`pymapconv.py:713`), later `struct.pack('B', m)` → `struct.error: required argument
   is not an integer` (`pymapconv.py:1062`).
3. **Greyscale typemaps are silently ignored.** `typemap[...] = typemap_img_pixel[col,row][0]` indexes
   `[0]` on what is an `int` for PIL mode `L` → `TypeError`, swallowed by the bare `except:` that wraps
   the whole block, which then prints *"Warning: Unable to open typemap, skipping. FileNotFoundError"*
   (`pymapconv.py:878-894`; the offending index is on `:892`, the bare `except:` on `:893`). **The map
   compiles with an all-zero typemap (`typemap = [0] * (mapx//2) * (mapy//2)`, `:878`) and the mapper is
   told the file was missing.** Typemaps must be RGB/RGBA.
4. **Featurelist lines without a rotation column embed a newline in the feature name.**
   `line = line.split(' ')` with no `strip()` (`pymapconv.py:763-773`); `"rock1\n".split(' ') == ["rock1\n"]`.
   The name `"rock1\n"` is appended to `featuretypes` (`:765-766`) and written into the SMF string table,
   `GetFeatureDef` fails, and the engine **drops every such feature** (`FeatureHandler.cpp:78-81`).
   **[CORRECTED — not truly silent: each drop emits an `L_ERROR` line to `infolog.txt`
   (`FeatureDefHandler.cpp:220-221`). Nothing surfaces it in-game, which is why it reads as silent.]**
   Workaround: always write two tokens.
5. **`mapid` is drawn from `random.randint(0, 31**2)`** — i.e. 0…961 inclusive, not 0…2³¹
   (`pymapconv.py:1026`). Almost certainly a `31**2` / `2**31` typo. Collisions are near-certain across
   a map pool. (The engine never reads `mapid` — it is not touched anywhere in `SMFMapFile.cpp` beyond
   `ReadMapHeader` — so this is a metadata-quality bug, not a correctness one.)
6. **8-bit heightmaps lose 0.8 % of range**: `heights.append(otherheight_pixels[col,row] * 255)` maps
   255 → 65 025, not 65 535 (`pymapconv.py:680`; the multi-channel branch at `:682` has the same flaw).
   Should be `*257`. The legacy C++ tool has the same class of bug with `*256` → 65 280
   (`BrainDamage/MapConv :: MapConv.cpp:302`).
7. **Exact-hash-only tile dedup.** On any photographic texture essentially nothing dedups, so the `.smt`
   is always ~`174080·N²` bytes. The old C++ tool's perceptual matching (§4.2) is gone with no replacement.
8. **Mip bleeding at 1024-px chunk boundaries.** Because mips 1–3 of each 32×32 tile are lifted out of
   the *chunk's* mip chain, texels near a chunk edge have mips built from clamped-edge data. Visible as
   faint seams on a 1024-elmo grid at distance.
9. **`./temp` is hard-coded relative to CWD** (`pymapconv.py:456-470`) and `nvdxt.exe` is copied from
   CWD. Two concurrent compiles in the same directory corrupt each other; the tool cannot be used as a
   library or in a CI matrix without chdir gymnastics.
10. **The whole diffuse is loaded into PIL memory.** `Image.MAX_IMAGE_PIXELS` is set **twice**: to
    `933_120_000` at module scope (`pymapconv.py:20`) and then raised to `16_000_000_000` inside
    `compileSMF` just before opening the diffuse (`pymapconv.py:432`) — the draft cited only the
    second. A 32×32 map means a 16384² RGB image (≈768 MiB) plus the 1024² crops plus the intermediate
    BMPs on disk. Reported compile times for large maps run into tens of minutes.
11. **DDS header assumed to be exactly 128 bytes** (`[128:]`, `pymapconv.py:970` for the minimap and
    `:988` for each tile chunk). A DX10-header DDS would silently corrupt every tile.
    **[CORRECTED — scope of the risk.]** Those two `[128:]` slices only ever read files produced by
    `nvdxt.exe` (2004-era, legacy header only) or `CompressonatorCLI -fd DXT1` — **never** by
    `nvtt_export.exe`, whose output goes straight to the map archive and is not re-parsed by pymapconv.
    So the "newer NVTT emits DX10 headers" framing in the draft is misattributed. Whether any
    `CompressonatorCLI` build emits a DX10 header for `-fd DXT1`: **UNVERIFIED — needs confirmation**.
    It remains a real fragility for any general-purpose DDS reader TerraSmith ships.
12. **Windows-only for normals/specular/splat DDS** (`if (not myargs.linux) and (myargs.mapnormals or
    myargs.specular or myargs.splatdistribution)`, `pymapconv.py:404`, and it additionally requires
    `nvtt_export.exe` **and** `FreeImage.dll` in the CWD, else it only prints a warning and continues
    (`:405, :429`)); Linux mappers must run the ImageMagick drag-and-drop scripts by hand.
13. **No validation of anything semantic.** It never checks slope, pathability, symmetry, metal totals,
    start positions, or whether the heightmap and texture agree.
14. **Aborts with `return -1` and a 220 Hz beep**, not exit codes usable in a pipeline
    (`pymapconv.py:1547-1552`); on error paths it frequently just prints and continues.

### 3.9 What pymapconv gets right (don't regress these)

- Multithreaded texture compression on Windows (4× default) — a real speedup over the C++ tool.
- The high-res heightmap mode with `nearest` sampling: it samples the `mapx*8`-resolution heightmap at
  exactly the texel centres of the 8×8 grid (`for y in range(4, mapy*8+8, 8): for x in range(4, mapx*8+8, 8)`),
  which makes cliff edges land on texture features instead of being smeared by an interpolating resize
  (`pymapconv.py:624-629`). This is the fix for the notorious "X → X/8+1 interpolation problem".
  Caveat for a re-implementation: the sampled value is clamped to **65534**, not 65535 (`:627`).
- The 16-bit-depth histogram check that warns when you're only using ≤256 distinct height levels and
  will get terracing (`pymapconv.py:649-661`).
- Auto-emitting `<map>.jpg` and 128² `<map>.png` thumbnails for the lobby.
- The `@file` settings round-trip and the decompiler, which together make maps re-editable.
- A **regression tester** (`regression_tester/regression_tester.py`) that decompiles + recompiles the whole
  BAR map pool with two builds and diffs the bytes, allowing only bytes 20–23 (`mapid`) to differ.
  This is a good model for a new tool's conformance suite.

---

## 4. The original C++ `mapconv` and its variants

### 4.1 Lineage

| Tool | Where | Notes |
|---|---|---|
| Original `mapconv` | shipped inside `taspring_0.62b1_src.zip` | "Interesting. So MapConv used to be packed with Spring…" (`BrainDamage/MapConv :: notes.txt`) |
| **Mother's MapConv** (UberMapConv) | `UberMapConv-083105.sd7` | The one the wiki told everyone to use; "with 'optimization' … has the no scanlines hack included" (<https://web.archive.org/web/2022id_/https://springrts.com/wiki/Maps:Compiling>) |
| `BrainDamage/MapConv` | <https://github.com/BrainDamage/MapConv> | Cross-platform port; last commit **2009-10-07 "fixed pinstriping in windows"** |
| `abma/MapConv` | <https://github.com/abma/MapConv> | Same family, last touched 2014 |
| `enetheru/smf_tools` | <https://github.com/enetheru/smf_tools> | C++ rewrite (`smf_cc`, `smf_decc`, `smf_info`, `smt_convert`, `smt_info`, `smt_repair`); **archived**, last push 2023 |
| `renefritze/wxmapconv` | <https://github.com/renefritze/wxmapconv> | wxWidgets GUI front-end, 2010 |
| Mapdeconv, Das Bruce's MapConv Frontend | wiki-listed, binaries on springfiles | dead links in practice |
| **MapConvNG** | vendored binary in the SpringBoard/spring-launcher distribution (`bin/windows/springMapConvNG.exe`, `bin/linux/mapcompile`) | **[CORRECTED] Not dead** — it is the compiler SpringBoard actually invokes (§5.2). No public source repo found. |

### 4.2 `BrainDamage/MapConv` — CLI and algorithm

CLI (tclap, `MapConv.cpp:68-160`):

```
-t/--intex        texture (multiple of 1024 each side)             [required]
-a/--heightmap    16-bit .raw or image, (xsize+1)×(ysize+1)        [required]
-m/--metalmap     red channel = metal, rescaled to xsize/2 × ysize/2  [required]
-n/--minheight    float                                            [required]
-x/--maxheight    float                                            [required]
-y/--typemap      red channel = terrain type
-g/--geoventfile  geovent decal                        [geovent.bmp]
-e/--externaltilefile   reuse tiles from an existing .smt
-o/--outfile      output .smf                              [test.smf]
-c/--compress     0..1, LOSSY tile matching aggressiveness     [0.8]
-f/--featuremap   xsize × ysize
-j/--featurelist  one name per line                          [fs.txt]
-i/--invert       flip the heightmap image vertically on read
-l/--lowpass      5×5 weighted smooth of the heightmap
-z/--texcompress  path to the companion texcompress binary (non-Windows)
```

The three material differences from pymapconv:

1. **Lossy, perceptual tile dedup.** `ProcessTiles` sets
   `meanThreshold = 2000·c`, `meanDirThreshold = 20000·c`, `borderThreshold = 80000·c`
   (`TileHandler.cpp:35-37` — confirmed verbatim).

   *(All BrainDamage/MapConv line citations in this section were re-pinned against
   `github.com/BrainDamage/MapConv@master`, last commit 2009-10-07.)* For each new tile, `FindCloseTile` does a **linear scan over every tile
   already used** comparing 9 cheap statistics (per-channel sum, and per-channel first moments about the
   tile centre in x and y) and, if all pass, a **border-only** SSE comparison of the 4 edge rows/cols
   against `borderThreshold` (`TileHandler.cpp:249-311`). This is the `-c` "compression": it can shrink
   an `.smt` enormously at the cost of visible tile repetition. It is also **O(tiles²)** — for a 16×16
   map that's up to 4.3 billion comparisons.
   The wiki's own advice: *"NEVER USE THE SMF COMPRESSION, IT IS UTTERLY USELESS! (Further note, its not
   useles, just ugly … Values of up to 0.6 wont cause too noticable loss in quality)"*.
2. **The 1024×1024 intermediate chunks are NOT spatially contiguous.** `ProcessTiles` packs **1024
   consecutive tiles in map raster order** into a 32×32 grid inside a 1024² BMP
   (`TileHandler.cpp:70-93`): `xb = (startTile+b) % tilex; yb = (startTile+b) / tilex` — so a chunk is a
   *strip* of the map re-flowed into a square. Mip generation therefore averages texels from completely
   unrelated parts of the map. **This is the root cause of the historic "pinstriping"/"scanlines"
   artefacts** and of the "no scanlines hack" in Mother's build. pymapconv fixed this by cropping real
   contiguous regions.
3. **The heightmap is flipped on read**: `heightmap[(ysize-y)*mapx + x] = (float(h))/65535*hDif+minHeight`
   — **[line numbers corrected]** `MapConv.cpp:291` (`.raw` path) and `:303` (image path), inside
   `LoadHeightMap` at `:275-340`. `-i/--invert` then flips it *back* (`:308-317`), so without `-i` the
   compiled map is upside-down relative to the source image. The wiki says
   *"Most maps will use this [-i]"*. **pymapconv does not flip.** Any legacy `.bat` carried forward
   unchanged will produce a vertically mirrored map.

Other details worth stealing or avoiding:
- `-l/--lowpass` is a 5×5 kernel with weight `max(0, 1 − 0.4·√(dx²+dy²))` (`MapConv.cpp:319-339`) — a
  cheap terrain de-noiser applied *after* height scaling into world units.
- Tree placement has an anti-clumping rule (`LastTree`), a height gate (`h < 5 → skip`) and a `FlatSpot`
  test, and randomizes `relativeSize` as `0.8f + rand()/RAND_MAX * 0.4f`, i.e. uniform in `[0.8, 1.2]`
  (`FeatureCreator.cpp:70-101`) — the only automated vegetation logic in the classic chain.
  Placement is `(startx + x*8 + 4, 0, starty + y*8 + 4)` (`:95-97`) — the same `+4` half-square centring
  pymapconv uses.
- Feature type indices: `#define NUM_TREE_TYPES 16` (`FeatureCreator.cpp:4`) → 16 `TreeType0..15`,
  then `GeoVent` at 16, then `fs.txt` lines from 17; `numFeatureType = NUM_TREE_TYPES + 1 + ArbFeatureTypes`
  (`FeatureCreator.cpp:33`, names written at `:39-51`). pymapconv reproduces this exactly (its own
  progress print says *"17 of which are built-in"*, `pymapconv.py:815`), so the two are index-compatible.
- File section order is different from pymapconv's (heightmap, typemap, minimap, tiles, metalmap, vegmap,
  features — `MapConv.cpp:212-228`, confirmed verbatim; note the vegmap offset is written as a *separate*
  extra header at `:228`). Harmless, since everything is pointer-addressed, but a byte-diff tool must not
  assume an order — and the engine tolerates both because every chunk is reached via its own pointer.
- **Encoding asymmetry:** it divides by `65535` on load (`:291, :303`) where the engine multiplies by
  `(max−min)/65536` on read. 8-bit source images are scaled `*256` (`:302`), capping at 65 280.

### 4.3 `enetheru/smf_tools` — the best-designed of the dead alternatives

Archived, but architecturally the most interesting prior art: a *split* toolchain where the tile atlas
and the map file are separate concerns, with a CSV tilemap as the interchange format.

`smf_cc` (`smft :: src/smf_cc.cpp:31-92`):
*(Usage block below is the verbatim `option::Descriptor usage[]` from `smf_cc.cpp:30-90`.)*

```
smf_cc -v -o mymap.smf --mapsize 8x8 --height height.tif \
       --mini minimap.jpeg --metal metalmap.png --grass grass.png mymap.smt
  --mapsize=XxZ    spring map units, "must be multiples of two"
  --tilesize=X     pixels, multiple of 4          [32]
  -y/--floor  -Y/--ceiling
  --height=…       (x*64+1)x(y*64+1):1 UINT16
  --type=…         (x*32)x(y*32):1 UINT8
  --tilemap=…      (x*16)x(y*16):1 UINT32 image OR CSV
  --mini=…         1024x1024:4 UINT8
  --metal=…        (x*32)x(y*32):1 UINT8
  --grass=…        (x*16)x(y*16):1 UINT8
  --features=…     CSV:  NAME,X,Y,Z,R,S
```
Key ideas worth adopting:
- **A human-readable CSV tilemap as a first-class intermediate** (`smt_convert` emits `<name>.smt.csv`).
  That makes tile reuse, external tile libraries, and incremental recompiles tractable.
- **A CSV feature list** (`NAME,X,Y,Z,R,S`) instead of pseudo-Lua.
- `smt_convert --imagesize WxH --smt --tilesize 32x32 --type DXT1` decouples atlas building from map
  building; `smt_repair` and `smt_info`/`smf_info` are proper inspection tools.
- `makemap.sh` generates the **entire `.sdd`** — mapinfo.lua, LuaGaia featureplacer gadget, features.lua,
  archive, symlink into the maps folder, and even a `script.txt` to launch the engine on the new map.
  That end-to-end "one command → playable" ergonomic is exactly the bar to beat.
- Its confirmation of the even-size rule: the CLI help says *"must be multiples of two"*
  (`smf_cc.cpp:55`) and it is enforced with `LOG(ERROR) << "map sizes must be multiples of two"`
  (`smf_cc.cpp:148`); `makemap.sh:109,113` adds *"requires a multiple of two and no smaller than four"*.
- `makemap.sh` archives with `7z a -ms=off -mx=9` (`makemap.sh:723`) — independent confirmation of the
  non-solid rule.

---

## 5. SpringBoard (`Spring-SpringBoard/SpringBoard-Core`)

<https://github.com/Spring-SpringBoard/SpringBoard-Core> — Lua, 14 stars, MIT, **not** archived,
still receiving commits (last push **2026-08-19** per the GitHub API on 2026-09-13; the draft's
"2026-02-18" is stale). Docs: <https://springboard-core.readthedocs.io/>.

### 5.1 What it is

An editor that **runs inside the Spring engine itself** as a game (`modinfo.lua`: `modtype = 1`,
`onlyLocal = true`). You launch it via `spring-launcher`, it opens a map as a "project", and you edit
with WYSIWYG brushes using the real renderer, the real camera, the real unit/feature models.

Architecture (`scen_edit/`):
- **`model/`** — `heightmap.lua`, `texture_manager.lua`, `terrain_manager.lua`, `brush_manager.lua`,
  `area_manager.lua`, `team_manager.lua`, `trigger_manager.lua`, `variable_manager.lua`,
  `assets_manager.lua`, `project.lua`, plus `object/`, `rendering/`, `runtime_model/`.
- **`command/`** — a full command/undo system. Every mutation is a command object
  (`terrain_shape_modify_command`, `terrain_level_command`, `terrain_smooth_command`,
  `terrain_change_texture_command`, `terrain_metal_command`, `terrain_grass_command`,
  `set_heightmap_brush_command`, `import_heightmap_command`, `import_diffuse_command`,
  `load_metal_map_command`, `export_maps_command`, `compile_map_command`, …) with `undo_command.lua` /
  `redo_command.lua` / `compound_command.lua`.
- **`view/`** — Chili GUI.
- **`meta/` + `triggers/`** — the scenario meta-programming system (events/conditions/actions with
  expressions and variables). This is genuinely the strongest part and has no equivalent anywhere.
- **`exts/`** — plugin directory.

Texture editing works at **1024×1024 FBO tiles, one per 1024 elmos** (`texture_manager.lua:10`
`self.TEXTURE_SIZE = 1024`; `:180-182` iterates `Game.mapSizeX / TEXTURE_SIZE`). Since SMF diffuse is
1 texel per elmo, **SpringBoard paints at full native SMF resolution** — it is not a downgrade.
It also manages the full SSMF shading-texture set live (`$ssmf_specular`, `$ssmf_emission`,
`$ssmf_sky_refl`, `$ssmf_splat_distr`, `$ssmf_splat_normals:0..3`), mapping each to its `mapinfo.lua`
key (`texture_manager.lua:22-72`).

### 5.2 How it compiles — it shells out to **MapConvNG**

> **[RESOLVED — this was open question #2 in the draft.]** The launcher-side implementation is
> `Spring-SpringBoard/SpringBoard-Core :: dist_cfg/exts/compiler.js` (an Electron extension loaded by
> spring-launcher, not part of `gajop/spring-launcher` master — which is why grepping that repo found
> nothing). It is **not** a pymapconv wrapper, **not** smf_tools, and **not** a JS reimplementation:
>
> ```js
> // dist_cfg/exts/compiler.js:17-31
> if (process.platform === 'win32')      executableBin = 'windows/springMapConvNG.exe';
> else if (process.platform === 'linux') executableBin = 'linux/mapcompile';
> this.executablePath = path.resolve(`${__dirname}/../../bin/${executableBin}`);
> ```
> ```js
> // dist_cfg/exts/compiler.js:42-70  — compileMap_SpringMapConvNG()
> ['-t', diffusePath, '-h', heightPath, '-ct', '1', '-o', outputPath]
>   + optional: metalPath→'-m', typePath→'-z', maxh→'-maxh', minh→'-minh', minimap→'-minimap'
>   // commented out as "potential footguns": -ccount, -th, -features
> ```
> Progress is scraped from stdout lines containing `"Compressing"` matched against `/[0-9]+\/\s*[0-9]+/`
> (`:14, :75-93`); exit code 0 → `CommandFinished`, else `CommandFailed` (`:101-114`).
>
> **`springMapConvNG.exe` / `mapcompile` ships only as a vendored binary in the SpringBoard
> distribution's `bin/` directory. No public source repository was found** (checked
> `Spring-SpringBoard/{SpringMapConvNG,MapConvNG}`, `gajop/{SpringMapConvNG,MapConvNG}` → all 404; a
> GitHub repo search for "MapConvNG" returned nothing). Its CLI is incompatible with both pymapconv and
> the C++ mapconv — note `-z` means *typemap* here but *specular* in pymapconv and *texcompress* in the
> C++ tool. **Provenance and licence of MapConvNG: UNVERIFIED — needs confirmation.**

SpringBoard itself contains **no SMF writer**. `CompileMapCommand` just posts a JSON message to the
launcher host process:

```lua
WG.Connector.Send("CompileMap", {
    heightPath = ..., diffusePath = ..., metalPath = ..., outputPath = ...,
    minimap = Path.Join(SB.DIRS.WRITE_PATH, self.opts.diffusePath),
}, { waitForResult = true })
-- scen_edit/command/compile_map_command.lua
```
and listens for `CompileMapStarted` / `CompileMapProgress` / `CompileMapFinished` / `CompileMapError`
(`scen_edit/view/map/terrain_settings_editor.lua:178-200`). Heightmap *import* is likewise delegated:
`WG.Connector.Send("ImportSBHeightmap", {inPath, outPath, min, max, width = Game.mapSizeX/Game.squareSize+1,
height = Game.mapSizeZ/Game.squareSize+1})` (`scen_edit/command/import_heightmap_command.lua:27-38`).

`ExportMapsCommand` writes plain images into a directory — `heightmap.png`, `diffuse.png`, the shading
textures, `grass.png`, `metal.png` (`scen_edit/command/export_maps_command.lua`). `ExportAction:ExportSpringArchive`
then assembles a `.sdd`-shaped build dir (LuaGaia/main.lua, LuaGaia/draw.lua, copied project files, s11n
objects) and hands the images to the launcher to compile.

**So SpringBoard is an editor bolted onto an external compiler, exactly like the workflow it replaces.**
Its own docs say manual export is "only recommended if you want to customize the export process
(perhaps you want to compile the map yourself using a third-party tool)" and that
"Including feature defs, compiling the map and setting mapinfo.lua is outside the scope of this guide"
(`SpringBoard-Core :: doc/source/map_features.rst`).

### 5.3 Why it did not become the standard

Reading the repo and its docs, the reasons are structural rather than about quality:

1. **It is a Spring game, not an app.** You need the engine, the launcher, an installed game module, and
   a downloaded asset pack (`springboard/assets/core/`). Every crash is an engine crash. Every GL bug is
   an engine GL bug.
2. **Game-specific modules never materialised.** Verified against the GitHub org API on 2026-09-13:
   `SpringBoard-BA` (last push 2017-08-26), `SpringBoard-ZK` (2021-01-28), `SpringBoard-EVO` (2017-08-11),
   `SpringBoard-S44` (2017-09-19), `SpringBoard-XTA` (2014-09-20), `SpringBoard-LD42` (2018-11-26),
   `SpringBoard-BYAR` (**2020-03-10**). The BAR module is six years stale. Without a current module, BAR's
   units/features/movedefs aren't there.
3. **Its centre of gravity is scenarios, not terrain.** `doc/source/comparison.rst` compares SpringBoard
   only to *scenario* editors (ZKME, the SC2/WC3 editors) — the whole positioning is
   "trigger/event/action editor that happens to have terrain brushes".
4. **It doesn't own the artifact.** Because it can't write `.smf` and can't ingest a finished `.sd7`,
   it can't be the single source of truth for a map. Mappers who live in World Machine + Photoshop have
   to round-trip through it, and round-tripping loses their layer stacks.
5. **The texture pipeline can't match an offline renderer.** Painting a 32×32 map at 1 texel/elmo is
   16384² texels of FBO state inside a game process.

### 5.4 Where BAR mappers *do* use it

For a narrow slice of the workflow. BAR's file-structure guide lists SpringBoard as needed
**"For DNTS painting, Object Placement and heightmap finetuning"** — three uses, not one
**[CORRECTED — the draft said "exactly one thing"]** — and the map checklist says verbatim
*"**Heightmap** - Full pathability validation needed (ideally finetuned in Springboard)"*
(<https://www.beyondallreason.info/guide/map-checklist>), and the mapmaking-resources page links
a **Unit Pathability Checker** you unzip into your `.sdd`:

> "Unzip this into your .sdd map folder and then load it in SpringBoard. You can then check path-ability
> for each major unit-type."
> — `beyond-all-reason/support :: Mapping resources/MapFeatures/Scripts/Unit_Pathability_Checker/readme.md`

It ships seven stub units: `armbats.lua`, `armch.lua`, `armcs.lua`, `armpw.lua`, `armstump.lua`,
`armsub.lua`, `armthor.lua` — i.e. ship, hover-con, vehicle-con, bot, vehicle, submarine, all-terrain bot.
Beherith maintains an equivalent drop-in at <https://github.com/Beherith/bar_springboard_passability>
("armpw and armstump and armch").

**That is the state of the art of pathability QA in BAR: manually driving seven stub units around your map.**

---

## 6. The rest of the ecosystem

### 6.1 SpringMapEdit (Frostregen; `aeonios/SpringMapEdit` fork)

Java + SWT + JOGL standalone 3D editor. Wiki: <https://web.archive.org/web/2022id_/https://springrts.com/wiki/Maps:SpringMapEdit>.
Features per the wiki: heightmap raise/lower/set/smooth/randomize with custom brushes,
**hydraulic and thermal erosion** on whole maps or selections, texture painting with loaded textures and
**auto-generation from height/steepness**, and **flip/mirror/shift of all or part of a map** with
customizable settings. Screenshots demonstrate 64×64 and 48×64 maps.

> "While the tool is mostly reliable, error feedback is not, and it is recommended you use this with
> care and run it from a console so you get output."

Status: `aeonios/SpringMapEdit` last pushed 2017, 6 stars. Downloads point at `frostregen.org` which is
long dead. **Its symmetry/mirror feature and its height/slope-driven auto-texturing are the two ideas
worth reviving.**

### 6.2 BAR's **Terraform Brush** — the real current competitor

`beyond-all-reason/Beyond-All-Reason :: doc/TerraformBrush.md` (1184 lines) +
`luaui/Widgets/cmd_terraform_brush.lua` + `luaui/RmlWidgets/gui_terraform_brush/`.
Actively developed (PR #7219, `realtime-terraformer` branch). Available in skirmish/singleplayer/replay.

Tools in the panel: **Terraform** (Raise/Lower/Level/Smooth/Ramp/Restore/Noise), **Feature Placer**
(random / regular / clustered with smart filters), **Grass Brush**, **Weather Brush**, **Light Placer**,
**Splat Painter** (paints directly into the SSMF splat distribution map), **Decal Placer**,
**Clone Tool** (region copy/paste across terrain + metal + features + grass + splats + decals + lights),
**Environment** (skybox library, sun/fog/atmosphere, water, saveable `.env.lua` presets).

Notable capabilities a new tool is now measured against:
- **Symmetry instrument**: radial N-way (2–16) around a click-placed origin gizmo, or X/Y axial mirror,
  or 4-way quad; ghost cursors at every symmetric position; all copies collapse into **one undo entry**;
  plus a one-shot **Mirror** button that reflects one half of the map across an axis.
- **Noise brush** with Perlin / Voronoi / FBM / Billow, scale 8–512 elmos, octaves 1–8, persistence,
  lacunarity, seed.
- Spline ramps with progressive commitment, straight ramps with axis lock, Level pinned to drag-start
  height, Smooth targeting a running 5×5 local mean.
- Full undo/redo, presets, performance mode.

Its export is deliberately weak, and this is the gap:
> **Heightmap Export**: read `GetGroundHeight()` per cell → normalize 0–1 → render quads into an FBO →
> `gl.SaveImage()` **inside** the RenderToTexture callback → write a companion `.txt` with min/max altitude.
> **Import**: PNG → texture → FBO → readback → `minH + grey × heightRange` → send **32 columns per frame**
> via `$terraform_import$` messages, throttled to avoid network flood.
> — `doc/TerraformBrush.md` §"Heightmap Export/Import"

And, from its own roadmap (backlog item **#18**, MoSCoW "S", complexity 9):
> **"Direct map-file workflow — Work directly with a map file (`.sd7`/`.smf`), saving and loading all
> changes and configurations into it. Explore whether full map compilation/decompilation is possible
> within the tool or engine."**

Its "QoL / Future Instruments" wish-list is effectively a spec for the validator a new tool should ship:
contour lines, **slope/gradient overlay (flat=green / moderate=yellow / cliff=red)**, aspect map,
water-depth overlay, normal/curvature map, **"Passability grid — show engine mobility-map per unit class
as a color-coded per-cell overlay"**, LoS shadow map, **metal density heatmap**, terrain cross-section
profile, optimal path planner with a max-grade constraint.

### 6.3 DXT/DDS conversion helpers shipped with pymapconv

`springrts_smf_compiler/tools/` — contents verified by cloning the repo (`tools/win`, `tools/linux`):
- `NVTT_DragAndDropOnThis_ConvertTo_DXT1C.bat` → `nvtt_export.exe --output "%%~nx.dds" --save-flip-y --mip-filter 0 --quality 3 --format bc1 "%%~x"`
- `NVTT_DragAndDropOnThis_ConvertTo_DXT5.bat` → same with `--format bc3`
- `nvdxt_DragNDrop_U8888_sinc.bat` → **[CORRECTED]** the line that actually *runs* is
  `nvdxt.exe -file "%%~x" -u8888 -Sinc -output "%%~nx.dds"` — **without `-quality_highest`**; the
  `-quality_highest` variant is echoed to the console and then `@REM`-ed out on the next line. Uncompressed
  RGBA8 with sinc-sharpened mips ("U8888 uncompressed sinc sharpened mips are best").
- `nvdxt_DragNDrop_U8888_sinc_flipped.bat` → runs
  `nvdxt.exe -file "%%~x" -u8888 -Sinc -quality_highest -flip -output "%%~nx.dds"` (this one *does* keep
  `-quality_highest`). **Its own banner text wrongly says "without flipping them"** — copy-paste from the
  unflipped script.
- Also vendored: `nvtt_export.exe`, `FreeImage.dll`, `Windows_Texture_Viewer_v089b.rar` in `tools/win/`;
  `nvdxt.exe` lives at **`build/win/nvdxt.exe`**, not in `tools/`.
- Linux: `DXT1_Converter_Linux.sh` / `DXT5_Converter_Linux.sh` → `./magick convert "$input" -flip -define dds:compression=dtx1 -define dds:fast-mipmaps=false …`
  (the `dtx1` typo is in the shipped script — **and so is `dtx5` in the DXT5 one**; both are silently
  ignored by ImageMagick, which falls back to its default DDS compression). They drive a bundled
  `dragon-dxt1`/`dragon-dxt5` drag-target helper and a bundled `magick` binary.

**The `-flip` / `--save-flip-y` is not optional.** Every SSMF side texture must be vertically flipped
relative to the diffuse because of GL texture origin. Forgetting it is one of the most common map bugs,
and it is *entirely* a manual step today.

### 6.4 World Machine — the actual terrain authoring tool of record

BAR ships World Machine **project templates** as official resources:
- `beyond-all-reason/support :: Mapping resources/WM templates/Crescent_Bay_Clean_v3.tmd`
- icexuick's WM collection: <https://drive.google.com/drive/folders/1iS0etPCbSf5AfwSe9RTUWXtbo4UxQQX3>

pymapconv itself ships five `.tmd` (World Machine document) samples in `map_samples/`:
`Crescent_Bay_Clean_v3.tmd` (7983 lines), `Madness_v1.tmd` (6706), `skyboxer_carinae2_v4.tmd`,
and two `General_green_rocky_world_machine_texturizer_and_spring_map_Generator*.tmd`. Inspecting the
binary shows a full WM device graph: `APRL` (Advanced Perlin: Style/Scale/Persistence/Lacunarity/Octaves/
Seed/Steepness/Elevation/Multiscale…), `WARP` (Simple Displacement), `SSEL` (Select by slope/height with
Min/Max/Falloff), `BLUR` ("Blur Breakup Slopes"), etc., plus `WMDefaultPath = D:\spring\maps\crescent_bay\`
and `WMAuthor = Peter Sarkozy` — i.e. **the reference BAR terrain template is a World Machine node graph
that already knows about Spring's output paths.**

**The handoff format is: nothing but images.**
- Heightmap → 16-bit PNG (or `.raw`/`.r16`) at `(64N+1) × (64M+1)`. WM outputs power-of-two, so the
  mapper must resize to the odd size — this is the notorious "+1" problem. pymapconv's high-res mode
  (feed it `64N·8` and let it sample at texel centres) is the modern dodge.
- Diffuse ("texturizer" output) → BMP/PNG at `512N × 512M`.
- Normals/specular/splat distribution → PNG/TGA → flipped DDS via the drag-and-drop scripts.
- Metal / type / grass / feature maps → hand-painted in Photoshop or GIMP; BAR's checklist specifies
  "Metal map with sharp shapes (**default hard pen 4px**)".

Nothing carries provenance. Change the terrain and *every* derived map must be regenerated by hand.

### 6.5 L3DT

<http://www.bundysoft.com/L3DT/>. Wiki-listed as *"Commercial Map Maker, standard version is free, but
pro version requires payment but includes all the tools required to make an SD7 Spring map from scratch"*
(<https://web.archive.org/web/2022id_/https://springrts.com/wiki/Map,_Game,_And_Unit_Development_Programs>).
L3DT Pro historically had a Spring export plugin. In practice, in BAR-era mapping it has been displaced
by World Machine; BAR's own resources page does not mention it at all. Treat it as legacy.

### 6.6 Gaea

Not referenced anywhere in BAR's official mapping resources, the springrts wiki tool list, or pymapconv.
Individual mappers use it the same way as World Machine (build → export 16-bit grayscale PNG heightmap +
colour map), but **there is zero Spring-specific tooling, template, or documentation for it.** Its export
is generic, so the handoff is identical to WM's: images, resized by hand, with all the +1/flip/channel
conventions manual.

### 6.7 Blender / other

The wiki has "Making a height map with Blender" (`Mapdev:howto_height_blender`). Blender is mostly used
for map **features** (models → `.s3o`/`.dae`) rather than terrain. BAR's feature workflow uses
`Spring Features V1.0` / `Spring-Helper-Projects/spring-features` libraries plus custom models, with
`beyond-all-reason/support :: Mapping resources/MapFeatures/Scripts/Rotating features` as a Python
post-processor for rotations.

---

## 7. The current end-to-end BAR mapper workflow (the competitive brief)

Reconstructed from BAR's official guides
(<https://www.beyondallreason.info/guide/mapping-1-file-structure-prerequisites>,
`/guide/map-checklist`, `/guide/mapmaking-resources`, `/guide/map-reviews-process`),
the pymapconv source, and the SpringBoard docs.

**Tools you must install first:** Photoshop or GIMP; World Machine; a text editor; pymapconv
(from GitHub releases); SpringBoard (+ spring-launcher + assets); 7-Zip. *(That list is literally BAR's.)*

### Step 1 — Decide the size
Pick `N × M` in spring map units, both **even**, neither > **32**. Everything downstream is derived from
this; changing it later invalidates every asset.
> **Pain:** there is no tool that tells you what `N` implies (world elmos, heightmap pixels, expected file
> size, expected compile time). Mappers keep a hand-written table or copy an existing map's numbers.

### Step 2 — Terrain in World Machine
Load the Crescent Bay template (or icexuick's), build the height field, export.
> **Pain:** WM's canvas is power-of-two; SMF wants `64N+1`. Resizing 2048→1281 in Photoshop introduces
> interpolation that smears cliff edges relative to the texture. The community workaround is to export at
> `512N` (8× resolution) and let pymapconv's `--highresheightmapfilter nearest` sample texel centres —
> a fix that exists only because the resolution mismatch is unavoidable.
> **Pain:** min/max height must be chosen by hand and typed into `-n`/`-x`; if you guess wrong the whole
> map is squashed or clipped and you recompile. There is no "fit range to content" anywhere.
> **Pain:** WM has no idea what a playable slope is. You find out your ramps are too steep for vehicles
> three steps later, in-engine.

### Step 3 — Diffuse texture
WM texturizer output and/or hand painting, at `512N × 512M`. For a 20×10 map that's **10240 × 5120**;
for 32×32 it's **16384 × 16384** (268 Mpx).
> **Pain:** Photoshop on a 268-megapixel RGB canvas. Every iteration is minutes.
> **Pain:** "Clean design on main paths/chokepoints, wilder in edges/cliff-areas" (checklist) is a purely
> manual judgement with no tooling.
> **Pain:** BAR requires the texture to *encode traversability* — "Vehicles: flat-area appearance (e.g.
> grass); Bots only: cliff/hill texture distinct from vehicle ramps (e.g. sand/gravel); All-terrain:
> clearly rocky/steep" (checklist). **The texture must agree with the slope map, and nothing checks that
> it does.**

### Step 4 — The derived maps, all by hand
- **Normals** at `512N`, **specular** at `256N`, **splat distribution** (RGBA, ≥2048, power-of-two),
  **DNTS** tiles at 512² or 1024².
- **Metalmap** `32N × 32M`, 8-bit RGB BMP, red channel, hard 4-px pen.
- **Typemap** `32N × 32M`, 8-bit **RGB** BMP (greyscale silently fails — §3.8).
- **Grassmap** `16N × 16M`.
- **Featuremap** `64N × 64M` RGB (or skip it and write a placement file).
- **Minimap** 1024², usually auto-generated then hand-lightened.
> **Pain:** six-plus images at five different resolutions with three different channel conventions, and
> the only validation is "did pymapconv print a warning".
> **Pain:** every DDS must be **vertically flipped**. Drag-and-drop `.bat` files.
> **Pain:** none of these regenerate when the heightmap changes.

### Step 5 — Features
Place trees/rocks/geovents. Either paint a featuremap (green 200–215 + green 255 + red 255-down) or write
a `featureplacement.lua`. Or place them in SpringBoard and run
`springboard_model_lua_to_set_lua_feature_dumper.py` to convert SpringBoard's `model.lua` to placement
lines (`springrts_smf_compiler :: src/springboard_model_lua_to_set_lua_feature_dumper.py` — 37 lines, hard-codes
`model.lua` as the input filename and the output name `featureplacement_set.lua`, and does
`fy = int(fy * -10185.925)` on `rot.y`).

> **[RESOLVED — this was open question #4 in the draft.]** The unexplained constant is
> **`64000 / (2π) = 10185.9163578…`**, matched to 1 part in 10⁶ by the script's `10185.925`.
> So the script assumes SpringBoard's `rot.y` is in **radians** and maps a full turn onto **64000**
> units — but an SMF/Spring heading is a full turn over **65536** units
> (`SMFFormat.h:155`: "-32768..32767 for full circle"). The correct factor is
> **`65536 / (2π) = 10430.3783505…`**.
> **The shipped script is therefore wrong by a factor of `64000/65536 = 0.9765625`, i.e. every rotation
> is under-applied by ~2.34 %** — up to ~8.4° of error at a half-turn. TerraSmith should use
> `65536/(2π)` and treat round-tripped placements from this script as approximate. The leading minus
> sign encodes the CCW↔CW handedness flip between SpringBoard and SMF headings (not independently
> verified: **UNVERIFIED — needs confirmation** of SpringBoard's rotation sign convention).
> **Pain:** the featuremap red channel maxes out at 255 feature types and requires an exactly-ordered text
> file whose first line is red=255.
> **Pain:** the featurelist newline bug silently deletes features (§3.8.4).
> **Pain:** feature Y is ignored by the engine, so anything authored with an explicit Y is wrong; BAR's
> checklist has an explicit item about this.
> **Pain:** BAR's own tooling for this is *three separate Python scripts in a support repo*.

### Step 6 — Compile
Run pymapconv (GUI or CLI), point it at everything, set min/max height, hit go.
> **Pain:** minutes to tens of minutes; the whole texture goes through disk as BMP/TIFF, then through
> `nvdxt.exe`, then back through Python.
> **Pain:** it must be run from a writable CWD containing `nvdxt.exe`; `./temp` is hard-coded.
> **Pain:** no incremental build. Changed one metal pixel? Full retile, full DXT pass.
> **Pain:** errors are `print` + `return -1` + a beep.

### Step 7 — `mapinfo.lua`
Hand-write ~200 lines: lighting, sun direction ("Sun positioned in northern map area for proper
shadowing"), fog, skybox, water params, `maxMetal`, `minWind`/`maxWind` (BAR wants **0–30**),
`tidalStrength` (**0–25**), terrainTypes, teams/start positions, splat scales, resource texture paths.
> **Pain:** copy-paste from another map, then tune by trial and error, restarting the engine each time
> (BAR's Terraform Brush Environment panel is a direct response to this).

### Step 8 — Package and test
`7z a -ms=off MyMap.sd7 *`, drop into `data/maps/`, launch BAR.
Or keep it as `MyMap.sdd/` and skip the zip.
> **Pain:** solid-archive mistake makes the map invisible with no error.
> **Pain:** renaming anything post-compile → pink map.

### Step 9 — Validate by playing
Load the map in SpringBoard with the Unit Pathability Checker stub units and drive `armpw`, `armstump`,
`armch`, `armbats`, `armcs`, `armsub`, `armthor` around looking for pockets and unclimbable ramps.
> **Pain:** this is manual, slow, non-exhaustive, and non-reproducible. It is the single biggest
> unaddressed problem in the toolchain.

### Step 10 — Review
Open a thread in BAR Discord `#mapping`, ping `@mapper`, iterate. Formal review needs **at least 2
reviewers**; IceXuick breaks ties; the checklist is the standard
(<https://www.beyondallreason.info/guide/map-reviews-process>).
> **Pain:** the checklist has ~35 items, every one of which is checked by a human squinting at the map.

### Step 11 — Get it into the pool
Metadata goes into BAR's Rowy instance → exported to `maps-metadata/map_list.yaml` → CI validates →
generated configs are pushed to SPADS/Teiserver/lobby/Webflow.

> **[RESOLVED — this was open question #3 in the draft: "how does the CDN produce the per-map
> `metadata.json` that `fetchMapsMetadata()` consumes?"]**
>
> It is **not** external to the repo. `maps-metadata :: scripts/js/src/maps_metadata.ts:20` points at a
> Cloud Run service — `const mapsParserURL = process.env.MAP_PARSER_URL || 'https://map-parser-oseq47fmga-ew.a.run.app'`
> — called as `GET /parse-map/<springName>` (`:87`), which returns `{bucket, path, baseUrl}`; the CI then
> downloads `<path>/metadata.json` from that GCS bucket (`:96-104, :137-139`).
>
> **That service's source lives in the same repo**, at `maps-metadata :: cloud/map-parser/src/parse-worker.ts`.
> It: finds the archive via `https://files-cdn.beyondallreason.dev/find?category=map&springname=…` (`:52`),
> determines solidity by shelling out to `7za l -x!*` and parsing the `Solid = +/-` line (`:19-49`;
> `.sdz` is always reported non-solid), then parses the map with the **npm package `spring-map-parser`**
> (`import { MapParser } from 'spring-map-parser'`, `:2`; options `mipmapSize: 16, skipSmt: false,
> parseResources: true, resources: ['detailNormalTex','specularTex'], parseSkybox: true`, `:96-104`).
> It writes `texture.jpg`, `texture-preview.jpg`, `texture-dry.jpg`, `texture-dry-preview.jpg`,
> `height.png`, `type.png`, `metal.png`, `mini.jpg`, `res_*.png`, `skybox.png` and finally
> `metadata.json` = `{ mapInfo, minHeight, maxHeight, fileName, springName, isArchiveSolid, smd, smf,
> cacheVersion, extractedFiles }` — with `smf` stripped of its bulk arrays
> (`heightMap, metalMap, miniMap, typeMap, tileIndexMap, heightMapValues`) (`:167-195`).
>
> **`spring-map-parser` is now `beyond-all-reason/map-parser`** (MIT, TypeScript, `author: "Jazcash and
> others"`, `npm view spring-map-parser version` → **6.4.2**, last push 2026-09-10) — so the draft's
> guess ("likely Jazcash's spring-map-parser") was right, and the repo has since moved into the BAR org.
> Its `SMF` type (`src/map-model.ts:37-70`) is a field-by-field mirror of `SMFHeader` plus the tile
> section, which is a useful cross-check for TerraSmith's reader.
>
> **Consequence for TerraSmith:** to emit CI-consumable metadata directly, match the `metadata.json`
> shape above (the key names are `spring-map-parser`'s, e.g. `mapWidth`/`mapWidthUnits`/`minDepth`/
> `maxDepth`, **not** the engine's `mapx`/`minHeight`), and note that `maps-metadata` lower-cases all
> `mapInfo` keys on read (`maps_metadata.ts:144-147`).

**Total realistic loop time for a one-pixel terrain change: 10–40 minutes.** That is the number to beat.

---

## 8. Web-based and node-based tools targeting Spring/BAR

The honest answer: **there is essentially nothing mature.**

| Project | What it is | Status |
|---|---|---|
| `hendkai/bar-map-generator` | A single-page browser tool (`bar_map_generator.html`, GitHub-Pages hostable) that procedurally generates BAR maps — Continental / Islands / Canyon / Hills / Flat noise presets — or imports real terrain from **OpenStreetMap** (water bodies, roads, elevation samples). Auto-distributes metal and geothermal spots. Emits heightmap, metal, texture, normal, specular, minimap, grass, type and splat maps + metadata, then a downloaded `.bat`/`.sh` **downloads pymapconv and runs it locally** to produce the `.sd7`. | Last push 2026-05; README: *"This project is currently in active development and not yet fully functional."* 2 stars. Confirms the pattern: **browser front-end, pymapconv back-end.** |
| BAR Terraform Brush | In-engine, not web, but node-adjacent in spirit (parametric noise + brush stack). | Active — see §6.2 |
| World Machine / Gaea | Node-based, but entirely Spring-unaware | External |
| Zero-K | Uses Lua configs for startboxes (`/mapconfig/map_startboxes.lua`, in-game Startbox Editor widget) and metal spots (`dbg_mouse_to_mex_portable.lua`), and `ValidMaps.lua` for a curated list. Dynamic *layout* generation at runtime, not map generation. | Active but not a map builder |
| `RecoilEngine :: rts/Map/Generation/BlankMapGenerator.{cpp,h}` | The engine can synthesize a blank map at runtime | File confirmed present on `master`. Placeholder only — there is no procedural generator in the engine |

**Conclusion: the "web-based node terrain editor that speaks SMF" niche is empty.** Every attempt so far
has stopped at "generate images, then shell out to pymapconv".

---

## 9. Validation & QA — what exists, and what a validator must check

### 9.1 What exists today

| Check | Tool | Automated? |
|---|---|---|
| Pathability per move class | SpringBoard + Unit Pathability Checker stub units (`armbats/armch/armcs/armpw/armstump/armsub/armthor`) | **No** — you drive units around |
| Slope readability | Human eye + the texture-must-match-slope convention | **No** |
| Metal balance | pymapconv `--normalizemetal` (median-snapping of spot totals) | Partially, at compile time only |
| Start position sanity | `maps-metadata :: scripts/js/src/check_startpos.ts` — duplicate configs, side/player counts, unknown `spawnPoint`/`baseCenter` references. Explicit TODO: *"maybe also check that positions are not out of bounds using map metadata?"* | Metadata only, **not terrain** |
| Start box sanity | `check_startboxes.ts` — duplicate team counts, legacy 2-point rectangles with `a.x>=b.x \|\| a.y>=b.y`, degenerate N-gons via shoelace `\|area2\| < 1`, and `startboxes.length × maxPlayersPerStartbox ≤ map.playerCount` | Metadata only |
| Uses `mapinfo.lua` (not legacy `.smd`) | `check_uses_mapinfo_lua.ts` (whitelist: `Mescaline_V2`) | Yes |
| Archive not solid | `check_archive_not_solid.ts` | Yes |
| Photo aspect ratio | `check_photo_aspect_ratio.ts` | Yes |
| Compiler output stability | `springrts_smf_compiler :: regression_tester/` — decompile+recompile the pool with two builds, byte-diff, only bytes 20–23 (`mapid`) may differ | Yes, but it's a compiler test, not a map test |
| Everything else (~35 items) | The BAR map checklist, read by two human reviewers | **No** |

**There is no map validator.** Nothing in the ecosystem reads an `.smf` and tells you that a plateau is
unreachable, that your ramp is 41° so vehicles can't use it, that the north base has 14 metal spots and
the south has 13, or that your map isn't actually symmetric.

### 9.2 The checks that matter (specification for a validator)

Everything below is computable from `heightmap + typemap + metalmap + mapinfo.lua` alone, offline,
without the engine.

**A. Rebuild the engine's slope map exactly** (§2.1). Half-resolution (`mapx/2 × mapy/2`), from face
normals, with the `mix(maxslope, avgslope, maxslope/avgslope)` smoothing. Do not substitute a gradient
magnitude — it will disagree at exactly the cliff edges that matter.

**B. Per-move-class passability mask.** **[CORRECTED — the draft used one rule for all classes; the
engine uses three different functions (§2.2). Use these.]**

```
# common: terrain type must not zero the class out
tt_ok  = terrainTypes[typemap[halfIdx]].<class>Speed > 0
slope  = slopeMap[halfIdx]                  # half-res, (x>>1, z>>1)
height = maxHeightMap[xSquare + zSquare*mapx]   # FULL-res, note the mixed resolution
thr    = 1 - cos(radians(maxslope_degrees))     # maxslope_degrees straight from movedefs.lua

Tank / KBot :  tt_ok && slope <= thr && -height <= maxwaterdepth
Hover       :  tt_ok && (height < 0 || slope <= thr)        # NO depth test; water is free
Ship        :  tt_ok && -height >= minwaterdepth            # slope is IGNORED entirely
```
(`MoveMath.cpp:87-101` for the index derivation — `square = (xSquare>>1) + ((zSquare>>1) * hmapx)`,
`accurateSquare = xSquare + zSquare*mapx`; `GroundMoveMath.cpp:12-29`, `HoverMoveMath.cpp:12-23`,
`ShipMoveMath.cpp:11-18`.) Then **footprint-erode** the mask by the move def's `footprint` (2–9 squares
in BAR; `movedefs.lua` sets `footprintx = footprintz = footprint`) — a 1-square-wide gap is not passable
to a footprint-3 unit.

**C. Connectivity / unpathable pockets.** Flood-fill each per-class mask. Report:
- the number of connected components and each one's area;
- any component **smaller than some threshold** that is not reachable from the largest component
  ("pockets"), with its bounding box and centroid so the mapper can jump to it;
- specifically, **components that contain a metal spot or a start position but are not connected to the
  main component** — that is a map-breaking bug;
- one-square-wide "hairline" corridors, found by comparing the mask before and after erosion.

**D. Ramp grade check.** For every path that crosses a plateau boundary, report the steepest square. A
useful derived metric BAR mappers actually need: *"is this ramp usable by vehicles (≤0.108993, θ≤27°),
hovers (≤0.161329, θ≤33°), bots (≤0.412215, θ≤54°)?"* **[thresholds corrected — see §2.3]** —
expressed in the same three-tier language the checklist uses
(vehicle / bot-only / all-terrain).

**E. Texture-vs-slope agreement.** BAR's checklist demands the diffuse *visually encode* the three
traversability tiers. A validator can at minimum flag squares whose passability class changed without a
corresponding change in the diffuse (e.g. compute mean texture colour per class and report squares that
are statistical outliers for their class).

**F. Metal balance.**
- Cluster nonzero metalmap pixels into spots (8-connected), like `MetalMap.calcspots`.
- Per spot: centroid, pixel count, **sum of values**, and the derived income
  `sum × mapinfo.maxMetal` (and the engine's extractor-radius overlap behaviour —
  `extractorRadius` default 500 elmos, `MapInfo.cpp:107`; overlapping extractors both suffer reduced
  output). Note `GetMetalAmount(x1,z1,x2,z2)` sums over a **half-open** box (`MetalMap.cpp:66-70`).
- Report the distribution: min/median/max spot total, and each spot's deviation from the median
  (this is exactly what `--normalizemetal` operates on).
- **Per-region balance**: given start positions or start boxes, assign spots to the nearest start and
  report count and total per start. Asymmetry here is the #1 competitive-balance complaint.

**G. Symmetry / fairness.** Given a symmetry hypothesis (X mirror, Z mirror, 180° rotation, N-way radial
about a centre — the same set the BAR Terraform Brush's symmetry instrument supports), compute the
residual for the heightmap, metalmap, typemap and (optionally) the diffuse. Report:
- the best-fitting symmetry and its RMS residual;
- a heat map of where symmetry breaks;
- whether the break is cosmetic (diffuse only) or gameplay-affecting (height/metal/type).

**H. Start position fairness.** For each start position:
- distance (Euclidean and **path distance through the passability mask**) to the nearest N metal spots;
- metal income within `extractorRadius` and within a typical early-expansion radius;
- flat buildable area within a radius (squares below the vehicle slope threshold and above water);
- path distance to the map centre and to each opposing start;
- water/land classification.
Then report the max-minus-min across positions. This is the quantity human reviewers are eyeballing.

**I. Cheap structural checks** (all pure arithmetic, all currently unowned by any tool):
- texture dimensions are multiples of 1024, both axes;
- heightmap is exactly `(mapx+1) × (mapy+1)` and 16-bit greyscale with no alpha;
- distinct height levels > 256 (else warn about terracing — pymapconv already does this);
- metal/type are exactly `mapx/2 × mapy/2` and **type is RGB** (the greyscale trap, §3.8.3);
- grass is `mapx/4 × mapy/4`;
- every name in the featurelist/placement file resolves to a feature def in the target game,
  and contains no whitespace/newline;
- no feature is placed outside the map or on water it shouldn't be on;
- `.smt` filename recorded in the `.smf` matches the file on disk (pink-map guard);
- minimap chunk is exactly 699 048 bytes;
- archive is not solid;
- `mapinfo.lua` parses, `smtFileName0` matches, `maxMetal`/`minWind`/`maxWind`/`tidalStrength` are in
  BAR's accepted ranges (checklist verbatim: *"Configure wind and tidal (wind between 0-30, tidal
  between 0-25)"*);
- **[ADDED] feature-table conformance the engine actually enforces (§1.7):** `numFeatureType ≤ 16384`,
  every feature type name ≤ 30 characters, no embedded whitespace or NUL, and either resolvable as a
  game FeatureDef (case-insensitively) or containing the substring `treetype` / `geovent`;
- **[ADDED] tile-section conformance (§1.4):** `Σ numTilesInThisFile == MapTileHeader.numTiles`,
  every `tileIndex` entry in `[0, numTiles)`, the `.smt` name ≤ 255 bytes and resolvable relative to the
  `.smf`'s own directory, and each referenced `.smt` header matching
  `magic="spring tilefile" / version=1 / tileSize=32 / compressionType=1`;
- **[ADDED]** `mapx % 128 == 0` and `mapy % 128 == 0` (ROAM patch coverage, §1.2).

---

## 10. Interop checklist for TerraSmith

To be a drop-in replacement rather than yet another island:

**Must read (import):**
- `.smf` + `.smt` (full decompile, including grass extra header and features) — parity with pymapconv `-d`.
- pymapconv `@file` settings files / `*_compilation_settings.txt` (one token per line).
- `featureplacement.lua` in the `{ name = '…', x = …, z = …, rot = "…", scale = … },` form,
  parsed the *same lenient way* pymapconv parses it (so existing files load unchanged) but with a
  strict mode that reports what pymapconv would have silently mangled.
- `fs.txt`-style featurelists, **stripping whitespace** (fix bug §3.8.4 while staying index-compatible:
  red 255 → line 0).
- `smf_tools` CSV tilemaps and `NAME,X,Y,Z,R,S` feature CSVs (cheap, and a better interchange format).
- `mapinfo.lua` (as data, not just as a blob) — including `smf.minHeight/maxHeight` overrides and
  `terrainTypes[*].moveSpeeds`, which the validator needs.

**Must write (export):**
- `.smf`/`.smt` byte-identical to pymapconv modulo `mapid`, so the existing regression tester validates it.
- The same sidecar files: `<map>.jpg` (1024²) and `<map>.png` (128²).
- A full `.sdd`/`.sd7` with `-ms=off`, `mapinfo.lua`, `LuaGaia` featureplacer boilerplate
  (take the template from `smf_tools/src/makemap.sh`).
- The pymapconv settings file, so a mapper can fall back to pymapconv at any time.

**Must beat:**
1. **Compile time.** Do DXT1 in-process (libsquish/ISPC/GPU), not via `nvdxt.exe` + BMPs on disk.
   Target: a 16×16 map in seconds, not minutes.
2. **Incremental rebuild.** Hash per-tile inputs; only recompress changed 1024² regions; never retile
   because the metalmap changed.
3. **One source of truth.** Derive metal/type/grass/feature/normal/specular/splat from a project graph so
   a heightmap edit propagates instead of invalidating six hand-made images.
4. **The +1 / flip / channel conventions handled automatically** (accept a power-of-two heightmap and do
   the texel-centre resample; auto-flip DDS; accept greyscale typemaps).
5. **Ship the validator** (§9.2). Nobody else has one. Slope overlay, per-class passability mask,
   pocket detection, metal balance, symmetry residual, start-position fairness — offline, in seconds, in
   CI.
6. **Better tile dedup than exact-hash** without the C++ tool's O(n²) linear scan and without its
   pinstriping: perceptual hashing / LSH over the decoded 32×32 tiles, with a quality dial, and chunking
   that stays spatially contiguous.
7. **Don't regress** pymapconv's good parts: multithreading, the `nearest` high-res heightmap sampler,
   the 16-bit histogram warning, the decompiler, the `@file` round-trip, and the regression harness.

---

## Appendix A — Source index

**Repositories read (cloned to a scratch dir during this survey):**
- `Beherith/springrts_smf_compiler` @ master — `src/pymapconv.py` (1601 L), `src/argparseui.py` (854 L),
  `src/version.py` (0.6.3), `src/tree_placer_springrts.py`, `src/springrts_smf_minimapper.py`,
  `src/fast_decompiler.py`, `src/springboard_model_lua_to_set_lua_feature_dumper.py`,
  `regression_tester/`, `tools/win/*.bat`, `tools/linux/*.sh`, `map_samples/*.tmd`, `doc/CHANGELOG.md`, `doc/DEV.md`
- `beyond-all-reason/RecoilEngine` @ `master` (re-fetched 2026-09-13 via
  `raw.githubusercontent.com/beyond-all-reason/RecoilEngine/master/...`; **all line numbers in this
  document are pinned to that fetch, not to the draft's `8f47fd2`**) —
  `rts/Map/SMF/SMFFormat.h`, `rts/Map/SMF/SMFMapFile.{h,cpp}`, `rts/Map/SMF/SMFReadMap.{h,cpp}`,
  `rts/Map/SMF/SMFGroundTextures.cpp`, `rts/Map/SMF/ROAM/Patch.h`, `rts/Map/MapInfo.{h,cpp}`,
  `rts/Map/ReadMap.{h,cpp}`, `rts/Map/MetalMap.{h,cpp}`, `rts/Sim/Misc/GlobalConstants.h`,
  `rts/Sim/MoveTypes/MoveDefHandler.cpp`,
  `rts/Sim/MoveTypes/MoveMath/{MoveMath,GroundMoveMath,HoverMoveMath,ShipMoveMath}.{h,cpp}`,
  `rts/Sim/Features/{FeatureHandler,FeatureDefHandler}.cpp`, `rts/System/SpringMath.h`,
  `rts/Lua/LuaParser.cpp`, `rts/Map/Generation/BlankMapGenerator.*`
- `Spring-SpringBoard/SpringBoard-Core` @ `master` — `scen_edit/command/*`, `scen_edit/model/*`,
  `scen_edit/view/map/terrain_settings_editor.lua`, `scen_edit/view/actions/export_action.lua`,
  **`dist_cfg/exts/compiler.js`**, `dist_cfg/exts/import_sb_image.js`,
  `doc/source/{map_features,comparison,directory_structure}.rst`
- `BrainDamage/MapConv` @ 3cb545b — `MapConv.cpp`, `TileHandler.cpp`, `FeatureCreator.cpp`, `README.txt`, `notes.txt`
- `enetheru/smf_tools` (archived) — `src/smf_cc.cpp`, `src/makemap.sh`, `README.md`, `notes.txt`
- `beyond-all-reason/maps-metadata` @ `main` — `scripts/js/src/{check_startpos,check_startboxes,check_uses_mapinfo_lua,check_archive_not_solid,check_photo_aspect_ratio,derived_map_info,maps_metadata}.ts`, **`cloud/map-parser/src/parse-worker.ts`**, `schemas/map_list.yaml`, `Makefile`, `tools/map_syncer/`
- `beyond-all-reason/map-parser` @ `master` (npm `spring-map-parser` 6.4.2, MIT, "Jazcash and others") — `package.json`, `src/map-model.ts`
- `beyond-all-reason/Beyond-All-Reason` — `gamedata/movedefs.lua`, `doc/TerraformBrush.md`
- `beyond-all-reason/support` — `Mapping resources/{WM templates, MapFeatures/Scripts}`

**Web sources:**
- <https://www.beyondallreason.info/guides> · `/guide/mapmaking-resources` · `/guide/map-checklist` ·
  `/guide/mapping-1-file-structure-prerequisites` · `/guide/map-reviews-process` · `/guide/environment-design`
- <https://springboard-core.readthedocs.io/en/latest/>
- springrts wiki (behind Anubis; via Wayback `https://web.archive.org/web/2022id_/…`):
  `Mapdev:Main`, `Mapdev:SMF_format`, `Mapdev:mapinfo.lua`, `Maps:Compiling`, `Maps:SpringMapEdit`,
  `Map,_Game,_And_Unit_Development_Programs`, `Mapdev:Tutorial_Simple`.
  **Re-check 2026-09-13: every Wayback snapshot tried for `Mapdev:SMF_format` (`2022id_`, `20200101id_`,
  `20180101id_`, `20150101id_`) returns only a 5–6 KB MediaWiki shell with no article body. Treat every
  wiki-sourced quotation in this document as UNVERIFIED.** The engine source is authoritative for the
  binary format regardless.
- Beherith's *Advanced SpringRTS Mapping Guide*:
  <https://docs.google.com/document/d/1PL8U2bf-c5HuSVAihdldDTBA5fWKoeHKNb130YDdd-w/edit>
  (**UNVERIFIED — not machine-readable; fetch blocked. Still open; needs a human read-through before
  implementation.** Referenced by name from BAR's file-structure guide.)
- RebelNode's *Beginner Guide*:
  <https://docs.google.com/document/d/1NnNw5LMQG1NRk8F2Wl6T6lAZdfHGNU8RuzQJ66jmpYs/edit>
  (**UNVERIFIED — same caveat, still open**)
- <https://github.com/hendkai/bar-map-generator>
- <https://github.com/Beherith/bar_springboard_passability>

## Appendix B — Quick-reference formulas

```
springMapSizeX = texWidth / 512                      (must be an even integer)
mapx           = texWidth / 8   = 64 * springMapSizeX
worldSizeX     = mapx * 8       = texWidth  elmos
heightmapW     = mapx + 1
typemapW = metalmapW = mapx / 2
grassmapW      = mapx / 4
featuremapW    = mapx
tileIndexW     = mapx / 4
maxTiles       = (mapx/4) * (mapy/4)
smtBytes       = 32 + numTiles * 680
minimapBytes   = 699048                              (always)

height(raw)    = minHeight + raw * (maxHeight - minHeight) / 65536.0
rawFor(h)      = round((h - minHeight) * 65536 / (maxHeight - minHeight))   clamp [0, 65535]

featurePos     = (8*col + 4, ignored, 8*row + 4)     elmos, from a featuremap pixel
featureHeading = (short)rotation                     65536 == full circle

slopeMap[i]    = 1 - mix(minNy, avgNy, minNy/avgNy)  over the 8 face normals of a 2x2 square block
                 where mix(a,b,t) = a + (b-a)*t          (SpringMath.h:169)

# engine side (MoveDefHandler.cpp:84-95)
maxSlopeFor(d) = 1 - cos(clamp(d, 0, 60) * 1.5 deg)      # d is the movedef's maxslope KEY
# BAR side (movedefs.lua:546-555): key = SLOPE_value / 1.5, so the 1.5s cancel:
barThreshold(S) = 1 - cos(S deg)                          # S is the SLOPE.* constant, in real degrees
   vehicles S=27 -> 0.108993    hovers S=33 -> 0.161329   bots S=54 -> 0.412215   all-terrain S=90 -> 1.0
   [CORRECTED: the draft had 0.2396 / 0.3506 / 0.8436 — it omitted BAR's /1.5 pre-division]

metalAmount    = sum(metalmap pixels in range) * mapinfo.maxMetal      (maxMetal default 0.02)
                 # an abstract "amount", NOT metal/second — see 2.4

sbRotToHeading = radians * 65536/(2*pi)                   # = 10430.3783505
   # pymapconv's springboard dumper uses -10185.925 == -64000/(2*pi): ~2.34% too small (see step 5, section 7)
```

---

## Verification log

Adversarial fact-check, **2026-09-13**. Every claim below was checked against a primary source fetched
during this pass (raw GitHub files via `curl`, the GitHub REST API, `npm view`, or the live BAR guide).
Engine line numbers are pinned to `beyond-all-reason/RecoilEngine@master` as fetched on that date;
pymapconv to `Beherith/springrts_smf_compiler@master` (v0.6.3, `pymapconv.py` = 1601 lines).

**Legend:** ✅ confirmed · 🔧 corrected in place · ❓ unverified (marked as such in the body).

### A. Binary format (load-bearing for the writer)

| # | Claim | Source checked | Verdict |
|---|---|---|---|
| 1 | `SMFHeader` is 80 bytes, `'< 16s i i i i i i i f f i i i i i i i'`, fields in the order magic/version/mapid/mapx/mapy/squareSize/texelPerSquare/tilesize/minHeight/maxHeight/heightmapPtr/typeMapPtr/tilesPtr/minimapPtr/metalmapPtr/featurePtr/numExtraHeaders | `SMFFormat.h:49-70`; sequential reader `SMFMapFile.cpp:293-313`; `struct.calcsize` run = 80; `pymapconv.py:38` | ✅ **confirmed, byte-for-byte.** Draft cited `pymapconv.py:36` → 🔧 `:38` |
| 2 | Only `version==1`, `tilesize==32`, `texelPerSquare==8`, `squareSize==8`, `strcmp(magic,"spring map file")==0` validated | `SMFMapFile.cpp:16-28` | ✅ confirmed, all four draft line cites (`:18/:20/:22/:24/:27`) exact |
| 3 | `SMALL_TILE_SIZE = 680`, `MINIMAP_NUM_MIPMAP = 9`, `MINIMAP_SIZE = 699048` | `SMFFormat.h:28, :31, :34`; arithmetic re-derived in Python (Σ = 699048 ✓, 512+128+32+8 = 680 ✓) | ✅ values confirmed; 🔧 line cites were `:26`/`:32` → `:28`/`:34` |
| 4 | `TileFileHeader` = 32 bytes, magic/version/numTiles/tileSize/compressionType | `SMFFormat.h:175-183`; `struct.calcsize('< 16s i i i i')` = 32 | ✅ confirmed |
| 5 | `MapFeatureHeader` is `numFeatureType` **then** `numFeatures` | `SMFFormat.h:135-139`; `SMFMapFile.cpp:316-320` | ✅ confirmed |
| 6 | Wiki documents that header backwards | 4 Wayback snapshots of `Mapdev:SMF_format` — all return a body-less shell | ❓ **unverified**, marked in §1.7 |
| 7 | `MapFeatureStruct` = 24 bytes, `int, float×5` | `SMFFormat.h:148-157`; `SMFMapFile.cpp:323-331`; `calcsize('< i f f f f f')` = 24 | ✅ confirmed |
| 8 | `ypos` ignored; feature snapped to `GetHeightReal` | `FeatureHandler.cpp:88` | ✅ confirmed; 🔧 cite `:87` → `:88` |
| 9 | `rotation` float → `static_cast<short int>` | `FeatureHandler.cpp:95` | ✅ confirmed exactly |
| 10 | **Unresolvable feature names are "silently skipped, no error"** | `FeatureHandler.cpp:78-81` calls `GetFeatureDef(name, true)`; `FeatureDefHandler.cpp:220-221` does `LOG_L(L_ERROR, …)` when `showError` | 🔧 **CORRECTED — it logs an ERROR to infolog.** Behaviour (drop the feature) is right; "no error" is wrong |
| 11 | *(not in draft)* Feature-type name buffer is `char[16384][32]`, read loop bound `j < 31` | `SMFMapFile.h:62`; `SMFMapFile.cpp:144-162` | ➕ **gap filled** — hard limits `numFeatureType ≤ 16384` and name length ≤ 30 chars |
| 12 | *(not in draft)* Feature names lowercased; `treetype`/`geovent` substrings auto-create defs | `FeatureDefHandler.cpp:214, :226-258` | ➕ gap filled |
| 13 | `ExtraHeader{int size; int type;}` + third int offset when `type==MEH_Vegetation==1`; grass is `uint8[(mapx/4)*(mapy/4)]`; extra headers start at byte 80 | `SMFFormat.h:83-103`; `SMFMapFile.cpp:239-270` (`ifs.Seek(sizeof(SMFHeader))` at `:242`); `pymapconv.py:60-63, :1032, :1049` | ✅ confirmed; 🔧 cites `:59-61`→`:60-63`, `:240-256`→`:239-270`; ➕ added the `size-8` skip path for non-veg headers |
| 14 | `MapTileHeader{numTileFiles, numTiles}`, then per-file `int + NUL-string`, then `int32[(mapx/4)*(mapy/4)]` | `SMFFormat.h:107-127`; `SMFGroundTextures.cpp:105-182`; `pymapconv.py:1063-1066` | ✅ confirmed |
| 15 | **"The name is stored bare and the engine prepends `maps/`"** | `SMFGroundTextures.cpp:123, :140-149` — it prepends `FileSystem::GetDirectory(gameSetup->MapFileName())` | 🔧 **CORRECTED.** Observably equivalent for standard archives, but the rule is "the .smf's own directory" |
| 16 | *(not in draft)* Missing `.smt` → `memset(…, 0xaa, …)` = the pink map; `.smt` header hard-validated; `Σ numTilesInThisFile` must equal `numTiles`; filename buffer 256 B | `SMFGroundTextures.cpp:110-117, :134-137, :151-159, :165-175` | ➕ gap filled — these are writer invariants |
| 17 | `tileScale=4`, `bigSquareSize=128`, `bigTexSize=1024`, `tileCount=mapx*mapy/16`, `NUM_SPLAT_DETAIL_NORMALS=4` | `SMFReadMap.h:181-183`; `SMFReadMap.cpp:120-129`; `GlobalConstants.h:24` (`SQUARE_SIZE=8`) | ✅ confirmed; 🔧 cite `SMFReadMap.cpp:113-124` → `:120-129` |
| 18 | `height = minHeight + raw × (max−min)/65536` (divisor 65536, **not** 65535) | `SMFReadMap.cpp:157`; `SMFMapFile.cpp:132` | ✅ confirmed exactly; ➕ added that legacy C++ `mapconv` *encoded* with `/65535` (`MapConv.cpp:291,303`) |
| 19 | `GetInfoMapSize`: height `(mapx+1,mapy+1)`, grass `/4`, metal `/2`, type `/2` | `SMFMapFile.cpp:193-203` | ✅ confirmed; 🔧 cite `:197-206` → `:193-203` |
| 20 | 16×16 map SMF total ≈ 3 652 392 B | Re-summed the draft's own line items | 🔧 **CORRECTED to 3 652 388 B** (arithmetic slip of 4) |
| 21 | SMT worst case `32 + 65536×680 = 44 564 512`; scaling `174080·N²` | Recomputed for N = 8/16/24/32 | ✅ confirmed, all four rows |
| 22 | `mapx % 128 != 0` "will not be rejected by the engine" | `SMFMapFile.cpp:16-28` (true, not rejected) **but** `SMFReadMap.cpp:120-121, :480`; `ROAM/Patch.h:23` (`PATCH_SIZE=128`) | 🔧 **hardened** — not rejected, but the remainder gets no ground-texture/ROAM patch. Treat as a hard invariant. Whether a shipped BAR map is odd-sized: ❓ |

### B. Engine simulation semantics

| # | Claim | Source checked | Verdict |
|---|---|---|---|
| 23 | Face normals `fnTL = normalize(-(hTR-hTL), 8, -(hBL-hTL))`, `fnBR = normalize((hBL-hBR), 8, (hTR-hBR))` | `ReadMap.cpp:705-723` | ✅ confirmed exactly |
| 24 | `slopeMap[y*hmapx+x] = 1 − mix(maxslope, avgslope, maxslope/avgslope)` over 8 face normals of a 2×2 block | `ReadMap.cpp:751-778`; `mix` = `v1+(v2-v1)*a` at `SpringMath.h:169` | ✅ confirmed; 🔧 cite `:672-780` → `:690-738` + `:741-781`; ➕ added the `mix` definition |
| 25 | `DegreesToMaxSlope(d) = 1 − cos(clamp(d,0,60)·1.5·π/180)` | `MoveDefHandler.cpp:84-95` | ✅ confirmed verbatim |
| 26 | Engine defaults `maxSlope` 60 (Tank/KBot), 15 (Hover); `slopeMod = 4/(maxSlope+0.001)` | `MoveDefHandler.cpp:233, :238, :284` | ✅ confirmed exactly |
| 27 | `GroundSpeedMod` blocks on `slope > maxSlope` or `-height > depth` | `GroundMoveMath.cpp:12-29` | ✅ confirmed verbatim |
| 28 | *(draft applied that rule to every class)* | `HoverMoveMath.cpp:12-23` (no depth test; `height<0` ⇒ speed 1); `ShipMoveMath.cpp:11-18` (slope ignored) | 🔧 **CORRECTED** in §2.2 and in the §9.2 B validator spec |
| 29 | `square = (x>>1) + ((z>>1)*hmapx)`; height read at **full** res | `MoveMath.cpp:87-92` | ✅ confirmed |
| 30 | BAR `SLOPE = {27,33,54,75,90}`, `SLOPE_MOD = {4,18,25,36,42,4000}`, `DEPTH = {0,5,8,20,15,5000,9999}` | `movedefs.lua:41-58` | ✅ values confirmed; ➕ `DEPTH.DEFAULT = 1000000` was missing from the draft |
| 31 | **Vehicle/hover/bot thresholds are `0.2396 / 0.3506 / 0.8436` (θ = 40.5/49.5/81°)** | `movedefs.lua:546-555` — `setMaxSlope()` does `moveDef.maxslope = moveDef.maxslope / 1.5`, applied to every def at `:601` | 🔧 **CORRECTED — the most serious error in the draft.** True values: **0.108993 / 0.161329 / 0.412215** (θ = 27° / 33° / 54°). Whole §2.3 table, the §9.2 D thresholds and Appendix B rewritten |
| 32 | Per-class movedef assignments (TANK2/3, HTANK7, HOVER2/3, BOT2/3, HTBOT6, BOAT*) | `movedefs.lua:100-530` | ✅ confirmed; ➕ added `HOVER7` (literal 36), `AHOVER2` (54), `TBOT3` (no `maxslope` ⇒ engine default 60), `SBOT2` (depth 5), `NANO` (depth 0) |
| 33 | `slopeMod` forced to 4 for defs whose name contains `"BOT"` | `movedefs.lua:548-550` | ➕ gap filled |
| 34 | `maxMetal` default 0.02; `GetMetalAmount = distributionMap[·] * metalScale` | `MapInfo.cpp:106`; `MetalMap.cpp:29-52, :76-84`; `ReadMap.cpp:165-167` | ✅ confirmed |
| 35 | "255 at maxMetal 0.02 = **5.1 metal/s**" | Product 255×0.02 = 5.1 ✓, but the per-second conversion depends on extractor unitdefs, not traced | 🔧 softened to "metal *amount*"; per-second claim marked ❓ |
| 36 | mapinfo defaults: maphardness 100, gravity 130, extractorRadius 500, voidAlphaMin 0.9, NUM_TERRAIN_TYPES 256 | `MapInfo.cpp:98-124, :432-458`; `MapInfo.h:25` | ✅ all confirmed; 🔧 `MapInfo.h:24` → `:25`; ➕ added `tidalStrength` 0.0, `autoShowMetal` true, the post-clamps, terrainType defaults, and `splats` defaults (0.02 / 1.0, `MapInfo.cpp:181-182`) |
| 37 | `resources` is a literal 9-entry array; `splatDetailNormalTex{1..4}` | `MapInfo.cpp:361-371` (9 entries ✓), `:340-400` (splat normals, **1-based**, open-ended loop, renderer clamps to 4) | ✅ confirmed; ➕ noted `detailNormalTex → blendNormalsTexName` and the sub-table form |
| 38 | `smf.minHeightOverride = smfTable.KeyExists("minHeight")` | `MapInfo.cpp:406-409`; consumed `SMFReadMap.cpp:146-147` | ✅ confirmed |
| 39 | *(not in draft)* mapinfo keys are case-insensitive | `LuaParser.cpp:999-1001` (`lowerCppKeys`) | ➕ gap filled — matters because BAR writes `maxslope` while the engine asks for `maxSlope` |

### C. pymapconv

| # | Claim | Source checked | Verdict |
|---|---|---|---|
| 40 | Repo is `Beherith/springrts_smf_compiler`; `Spring_SMF_compiler` 404s | GitHub API: 200 vs 404 | ✅ confirmed (note: the fact-check *task brief* itself gave the 404 name) |
| 41 | Version 0.6.3; ~1600 lines | `src/version.py`; `wc -l` = 1601 | ✅ confirmed |
| 42 | **"MIT/PD-ish"** licence | `LICENSE` = CC0 1.0 Universal; GitHub API `spdx_id: CC0-1.0` | 🔧 **CORRECTED to CC0-1.0** |
| 43 | Deps `Pillow`, `pypng`, `pyqt5`; CI `build-and-release.yml`; `build/win/nvdxt.exe` vendored | `src/requirements.txt`; `.github/workflows/`; `find` on the clone | ✅ all confirmed |
| 44 | Texture must be a multiple of 1024 both axes; `mapx=texw//8`, `springmapx=texw//512` | `pymapconv.py:441-448` | ✅ confirmed; 🔧 cite `:440` → `:446` |
| 45 | 16-bit PNG heightmap checks (bitdepth/greyscale/alpha); `.raw` size check | `pymapconv.py:528-536, :543-551` | ✅ confirmed; 🔧 cite `:520-531` → `:543-551` |
| 46 | High-res `nearest` mode samples at `range(4, mapy*8+8, 8)` | `pymapconv.py:624-629` | ✅ confirmed; 🔧 cite `:619-628` → `:624-629`; ➕ values clamped to **65534** |
| 47 | 16-bit histogram/terracing warning | `pymapconv.py:649-661` | ✅ exists; 🔧 cite `:545-549` → `:649-661` (draft was badly off) |
| 48 | `ReadTile` transcription (mip loop, `256//div` stride, `524288 >> 2i` offsets, 680 B out) | `pymapconv.py:953-965` | ✅ **confirmed character-for-character** |
| 49 | Tile dedup by exact bytes; printed max `256·springmapx·springmapy` is the right tile count | `pymapconv.py:976-1004`; `256·N·M == (mapx/4)(mapy/4)` ✓ | ✅ confirmed; ➕ noted the live `# TODO: tilehash is larger than max tiles sometimes!` |
| 50 | SMF section order and all precomputed pointers | `pymapconv.py:1021-1079` | ✅ confirmed and the arithmetic transcribed |
| 51 | Featuremap-grass `IndexError` | `pymapconv.py:774, :790-794` | ✅ confirmed; 🔧 cite `:800-802` → `:790-794`; 🔧 the *first* failure is at `row=256`, not at the max index the draft quoted |
| 52 | 16-bit metalmap float crash | `pymapconv.py:713` + `:1062` | ✅ confirmed; 🔧 cites `:711`/`:1088` → `:713`/`:1062` |
| 53 | Greyscale typemap silently ignored via bare `except` | `pymapconv.py:878-894` (index on `:892`, `except:` on `:893`) | ✅ confirmed; 🔧 cite `:873-889` → `:878-894` |
| 54 | Featurelist newline bug | `pymapconv.py:763-773` | ✅ confirmed; 🔧 cite `:761-771` → `:763-773`; 🔧 downstream "silently drops" → logs an ERROR (see #10) |
| 55 | `mapid = random.randint(0, 31**2)` | `pymapconv.py:1026` | ✅ confirmed; 🔧 cite `:1038` → `:1026`; ➕ noted the engine never reads `mapid` |
| 56 | 8-bit heightmap `*255` | `pymapconv.py:680` (and `:682`) | ✅ confirmed; 🔧 cite `:676` → `:680` |
| 57 | `Image.MAX_IMAGE_PIXELS = 16_000_000_000` | `pymapconv.py:432` — but also `933_120_000` at `:20` | 🔧 both documented |
| 58 | `[128:]` DDS header assumption would break on a DX10 DDS "which newer NVTT can emit" | `pymapconv.py:970, :988` — those slices only ever read `nvdxt.exe` / `CompressonatorCLI` output; `nvtt_export` output is never re-parsed | 🔧 **CORRECTED (misattributed).** Residual risk (Compressonator emitting DX10) marked ❓ |
| 59 | Windows-only SSMF DDS path | `pymapconv.py:404-405, :429` | ✅ confirmed; ➕ also needs `FreeImage.dll`, and only warns on absence |
| 60 | `--normalizemetal` 8-connected blobs, median snap, row/col transposition bug | `pymapconv.py:215-336` (`isneighbour` `:223-227`, median `:296`, transposition `:256-262` vs `:271-273` vs `:332-335`) | ✅ confirmed; 🔧 all three line cites re-pinned; ➕ noted it is the *upper* median |
| 61 | CLI defaults (`-50.0`, `100.0`, 4 threads, `-Sinc -quality_highest`, `nearest`, `./resources/geovent.bmp`, `my_new_map.smf`) | `pymapconv.py:1356-1447` | ✅ all confirmed |
| 62 | *(not in draft)* `-v,` typo on `--version`; `numthreads` forced to 1 on Linux | `pymapconv.py:1447`; `:394-400` | ➕ gap filled |
| 63 | Regression tester allows only bytes 20–23 to differ | `regression_tester/regression_tester.py:156-160` | ✅ confirmed verbatim |
| 64 | SpringBoard rotation factor `-10185.925` unexplained | `src/springboard_model_lua_to_set_lua_feature_dumper.py:30` (37 lines total ✓); `64000/(2π) = 10185.91636` | 🔧 **RESOLVED** — it is `64000/(2π)`; correct value is `65536/(2π) = 10430.37835`; the script is 2.34 % low |
| 65 | `tools/` converter scripts | Cloned `tools/win/*.bat`, `tools/linux/*.sh` | 🔧 the `U8888_sinc.bat` line that actually runs omits `-quality_highest`; the "flipped" script's banner text is wrong; `dtx5` typo too |

### D. Ecosystem

| # | Claim | Source checked | Verdict |
|---|---|---|---|
| 66 | **SpringBoard's `CompileMap` implementation is unknown** | `SpringBoard-Core :: dist_cfg/exts/compiler.js` (found via `gh search code`) | 🔧 **RESOLVED** — it spawns `bin/windows/springMapConvNG.exe` / `bin/linux/mapcompile` (**MapConvNG**). Full CLI documented in §5.2. MapConvNG's own source: ❓ no public repo found |
| 67 | **How BAR's CDN produces `metadata.json`** | `maps-metadata :: scripts/js/src/maps_metadata.ts:20, :85-104, :137-147`; `cloud/map-parser/src/parse-worker.ts`; `npm view spring-map-parser` | 🔧 **RESOLVED** — Cloud Run service whose source is `cloud/map-parser/`, using npm `spring-map-parser` 6.4.2 = `beyond-all-reason/map-parser` (MIT). Full field list documented at §7 step 11 |
| 68 | maps-metadata checks exist (`check_archive_not_solid`, `check_startpos`, `check_startboxes`, `check_uses_mapinfo_lua`, `check_photo_aspect_ratio`) | All five fetched, HTTP 200 | ✅ confirmed; `isArchiveSolid` and the `Mescaline_V2` whitelist verified verbatim |
| 69 | `BrainDamage/MapConv` last commit 2009-10-07; `abma` 2014; `wxmapconv` 2010; `smf_tools` archived; `aeonios/SpringMapEdit` 2017/6★; `hendkai/bar-map-generator` 2026-05/2★ | GitHub API, all six repos | ✅ all confirmed |
| 70 | MapConv tile thresholds `2000c / 20000c / 80000c` | `TileHandler.cpp:35-37` | ✅ confirmed; 🔧 cite `:33-36` → `:35-37` |
| 71 | MapConv flips the heightmap on read; `-i` un-flips | `MapConv.cpp:291, :303, :308-317` | ✅ behaviour confirmed; 🔧 **cites `:143,158` were wrong** → `:291,:303` |
| 72 | MapConv lowpass kernel `max(0, 1−0.4√(dx²+dy²))`; tree `relativeSize ∈ [0.8,1.2]`; `h<5` skip; 16 TreeTypes + GeoVent + fs.txt | `MapConv.cpp:319-339`; `FeatureCreator.cpp:4, :33, :39-51, :70-101` | ✅ all confirmed; cites lightly re-pinned |
| 73 | MapConv section order heightmap/typemap/minimap/tiles/metalmap/vegmap/features | `MapConv.cpp:212-228` | ✅ confirmed |
| 74 | `smf_cc` CLI and resolution spec; "multiple of two, no smaller than four" | `smf_tools :: src/smf_cc.cpp:30-90, :55, :148`; `src/makemap.sh:109,113` | ✅ confirmed; ➕ `makemap.sh:723` uses `7z a -ms=off -mx=9` |
| 75 | SpringBoard: 14★, module staleness (BYAR 2020, ZK 2021, BA/EVO/S44 2017, XTA 2014) | GitHub org API | ✅ confirmed; 🔧 last push is **2026-08-19**, not the draft's 2026-02-18 |
| 76 | `doc/TerraformBrush.md` is 1184 lines; backlog #18 "Direct map-file workflow", MoSCoW S, complexity 9 | Fetched the file; `wc -l` = 1184; `:933` | ✅ **confirmed verbatim**, including the heightmap export/import steps (`:825-837`), radial symmetry 2–16 (`:597`), and the Perlin/Voronoi/FBM/Billow list (`:105-116`) |
| 77 | BAR checklist: 32×32 cap, wind 0–30, tidal 0–25, "hard pen 4px", Springboard pathability, no fixed feature Y | Live `beyondallreason.info/guide/map-checklist` | ✅ all six confirmed; 🔧 the draft's *wording* of the size quote was not the checklist's — replaced with the verbatim text |
| 78 | BAR file-structure guide: required dirs + tool list | Live `/guide/mapping-1-file-structure-prerequisites` | ✅ confirmed; 🔧 `LuaGaia/`/`LuaRules/` are **not** in the required list; 🔧 SpringBoard is listed for **three** uses ("DNTS painting, Object Placement and heightmap finetuning"), not one |
| 79 | `BlankMapGenerator.{cpp,h}` exists in the engine | HTTP 200 on the raw URL | ✅ confirmed |
| 80 | Gaea has no Spring-specific tooling | No primary source can prove a negative; not indexed | ❓ **unverified, still open** — see below |

### Open questions after this pass

| # | Question | Status |
|---|---|---|
| 1 | Beherith's *Advanced SpringRTS Mapping Guide* and RebelNode's *Beginner Guide* (Google Docs) | **Still open.** Not machine-fetchable. Needs a human read before implementation — they are BAR's canonical DNTS/splat recipes. |
| 2 | What SpringBoard's `CompileMap` actually runs | **Resolved** → MapConvNG, via `SpringBoard-Core :: dist_cfg/exts/compiler.js` (§5.2). *Residual:* MapConvNG's source/licence is still unknown. |
| 3 | How the per-map `metadata.json` is produced | **Resolved** → `maps-metadata :: cloud/map-parser/` + npm `spring-map-parser` 6.4.2 (§7 step 11). |
| 4 | The `-10185.925` rotation factor | **Resolved** → `64000/(2π)`; the correct constant is `65536/(2π)`, so the shipped script is 2.34 % low (§7 step 5). *Residual:* SpringBoard's rotation *sign* convention is still unconfirmed. |
| 5 | Does the engine tolerate `mapx % 128 != 0`? | **Partly resolved** → `CheckHeader` does not reject it, but `numBigTexX = mapx/128` truncation plus `static_assert(bigSquareSize == PATCH_SIZE)` means the remainder is unrendered. *Residual:* whether any shipped BAR map is odd-sized — still open. |
| 6 | Do newer `nvtt_export` builds emit DX10-header DDS? | **Reframed** → moot for pymapconv: the two `[128:]` slices never read `nvtt_export` output. *Residual:* whether `CompressonatorCLI -fd DXT1` can emit a DX10 header — still open, and relevant to any DDS reader TerraSmith ships. |
| 7 | Does anyone use Gaea for BAR maps? | **Still open.** Confirmed absent from BAR's guides, the wiki tool list and pymapconv; presence in Discord `#mapping` is not web-indexed. |
| 8 | *(new)* MapConvNG provenance, licence and exact flag semantics | **Open.** Only its invocation is known (`-t -h -ct -o -m -z -maxh -minh -minimap`, plus the disabled `-ccount -th -features`). Matters only if TerraSmith wants SpringBoard interop. |
| 9 | *(new)* Does `metalAmount × maxMetal` convert to metal/second, and how? | **Open.** Requires tracing BAR's extractor unitdefs and `CUnit`/`CExtractorBuilding` extraction logic, not done here. |
