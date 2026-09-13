# SMF (Spring Map File) Binary Format

**Scope:** complete, byte-exact description of the `.smf` container (and its companion `.smt`)
as *actually parsed* by the **Recoil** engine (Beyond All Reason's Spring RTS fork).

**Primary source of truth:** [beyond-all-reason/RecoilEngine](https://github.com/beyond-all-reason/RecoilEngine),
commit `8f47fd283985eff93f4949060929d6290b71ddef` (branch `master`, 2026-09-13). All line
references below are against that commit.

> **Audit note (2026-09-13).** Every line reference in this document was re-checked against a fresh
> clone. `master` HEAD at audit time was `70ed4600e3ec113004beb407a79fc4295d5cfd33`;
> `git diff 8f47fd28 HEAD` is **empty** for `rts/Map/SMF/SMFFormat.h`, `SMFMapFile.cpp`,
> `SMFReadMap.cpp`, `SMFGroundTextures.cpp`, `rts/Map/ReadMap.cpp` and `rts/Map/MapInfo.cpp`,
> so the two commits are interchangeable for everything below. Line numbers that were wrong have
> been corrected in place; see the **Verification log** in §15.

| File | Role |
|---|---|
| [`rts/Map/SMF/SMFFormat.h`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFFormat.h) | struct definitions + size constants |
| [`rts/Map/SMF/SMFMapFile.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFMapFile.cpp) | the actual byte-level reader |
| [`rts/Map/SMF/SMFMapFile.h`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFMapFile.h) | reader state, `featureTypes[16384][32]` limit |
| [`rts/Map/SMF/SMFReadMap.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFReadMap.cpp) | header → engine dimensions, heightmap decode, minimap upload |
| [`rts/Map/SMF/SMFReadMap.h`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFReadMap.h) | `tileScale`, `bigSquareSize` constants |
| [`rts/Map/SMF/SMFGroundTextures.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFGroundTextures.cpp) | tile table + tile-index array + `.smt` loading |
| [`rts/Map/ReadMap.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/ReadMap.cpp) | generic constraints, metalmap/typemap wiring |
| [`rts/Map/MetalMap.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/MetalMap.cpp) | metal byte → metal amount |
| [`rts/Map/Generation/BlankMapGenerator.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/Generation/BlankMapGenerator.cpp) | Recoil-only in-memory SMF **writer** |
| [`rts/Rendering/Env/GrassDrawer.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Rendering/Env/GrassDrawer.cpp) | consumer of the `MEH_Vegetation` extra header |

**Cross-checked against real maps.** Every arithmetic claim in this document was validated
byte-for-byte against `maps/RCR.smf` from `red_comet_remake_1.8.sd7`
(springfiles fid 2632); its numbers appear as the worked example in §12 and were **re-derived from
a fresh download during the 2026-09-13 audit** — all 30+ values in §12.1–§12.4 reproduced exactly.
§12.6 adds a **36-map / 46-archive corpus survey** used to settle what is convention versus what is
format.

---

## 0. Executive summary / TL;DR

* A map is **3 files**: `X.smf` (this document), `X.smt` (shared DXT1 tile pool), and
  `mapinfo.lua` (Lua; supersedes the old `.smd` TDF file).
* Everything is **little-endian**, **packed with no padding**, 4-byte aligned by construction.
* The `.smf` is an **80-byte header** followed by `numExtraHeaders` variable-size extra headers,
  followed by six data blocks located **only** by absolute file offsets stored in the header.
  **The block order is not fixed** — only the pointers matter (the Recoil blank-map generator
  emits a different order from `pymapconv`).
* Version is **1** and has never changed. Recoil has made **zero** format changes relative to
  Spring 105; `SMFFormat.h` is byte-identical modulo three comment typo fixes and
  `#define` → `constexpr` (diffed in §10.1, confirmed in §15).
* **Three things a writer gets wrong if it trusts the `.smf` alone** (all measured over 46 shipped
  BAR archives, §12.6):
  1. the header's `minHeight`/`maxHeight` are overridden by `mapinfo.lua` in **45/46** maps, with
     *different* values in 29 of them (§2.7);
  2. the embedded DXT1 minimap is **never** overridden by `smf.minimapTex` (0/46), so it is
     mandatory, not optional (§6.4);
  3. tile deduplication effectively does not happen on modern maps — size the `.smt` for
     `32 + tileCount * 680` (§9.5).

---

## 1. File-level layout

```
offset 0                  SMFHeader                      (80 bytes, fixed)
offset 80                 ExtraHeader[0]                 (>= 8 bytes each, variable)
                          ExtraHeader[1]
                          ...  numExtraHeaders of them
                          -- blocks, in ANY order, located by the header's *Ptr fields --
                          vegetation/grass map           (pointed at by the MEH_Vegetation extra header)
                          heightmap                      (heightmapPtr)
                          typemap                        (typeMapPtr)
                          minimap                        (minimapPtr)
                          metalmap                       (metalmapPtr)
                          tile block                     (tilesPtr)
                          feature block                  (featurePtr)
```

The doc comment in `SMFFormat.h:39-47` states this explicitly:

> Map file (.smf) layout is like this: SMFHeader / ExtraHeader / ExtraHeader / ... /
> Chunk of data pointed to by header or extra headers / ...

**Only the 80-byte header and the extra-header chain are at fixed positions.** Everything else
is reached by seeking to an absolute offset. A reader must not assume block adjacency; a writer
may lay blocks out in any order it likes as long as the pointers are right.

### 1.1 Endianness

All multi-byte integers and floats are **little-endian** (the "files are _originally_ little
endian (win32 x86)" comment in
[`rts/System/Platform/byteorder.h:21-26`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/System/Platform/byteorder.h#L21-L26)).
On big-endian hosts the engine byte-swaps on read via `swabWord` / `swabDWord` / `swabFloat`
(`SMFMapFile.cpp:273-289`). Bytes (`uint8`) are of course unaffected — note the explicit
`/* char; no swabbing. */` in `ReadGrassMap` (`SMFMapFile.cpp:260`).

### 1.2 Struct packing

The engine reads the SMF header field-by-field (`CSMFMapFile::ReadMapHeader`,
`SMFMapFile.cpp:293-313`), so packing is not load-bearing on the read path. But Recoil's own
writer `memcpy`s the C struct straight into the file
(`BlankMapGenerator.cpp:216`, `AppendToBuffer(fileSMF, smfHeader)`), and `vegmapOffset` is
computed as `sizeof(smfHeader) + sizeof(vegHeader) + sizeof(int32_t)` = **92**
(`BlankMapGenerator.cpp:179`). That only works because every struct is naturally packed:

| struct | C++ `sizeof` | on-disk size |
|---|---|---|
| `SMFHeader` | 80 | 80 |
| `ExtraHeader` | 8 | 8 (+ per-type payload) |
| `MapTileHeader` | 8 | 8 |
| `MapFeatureHeader` | 8 | 8 |
| `MapFeatureStruct` | 24 | 24 |
| `TileFileHeader` | 32 | 32 |

---

## 2. `SMFHeader` — byte-exact

Source: `SMFFormat.h:49-70`.

```c
struct SMFHeader {
    char  magic[16];      // "spring map file\0"
    int   version;        // Must be 1 for now
    int   mapid;          // Sort of a GUID of the file, just set to a random value when writing a map

    int   mapx;           // Must be divisible by 128
    int   mapy;           // Must be divisible by 128
    int   squareSize;     // Distance between vertices. Must be 8
    int   texelPerSquare; // Number of texels per square, must be 8 for now
    int   tilesize;       // Number of texels in a tile, must be 32 for now
    float minHeight;      // Height value that 0 in the heightmap corresponds to
    float maxHeight;      // Height value that 0xffff in the heightmap corresponds to

    int   heightmapPtr;   // File offset to elevation data (short int[(mapy+1)*(mapx+1)])
    int   typeMapPtr;     // File offset to typedata (unsigned char[mapy/2 * mapx/2])
    int   tilesPtr;       // File offset to tile data (see MapTileHeader)
    int   minimapPtr;     // File offset to minimap (always 1024*1024 dxt1 compressed data plus 8 mipmap sublevels)
    int   metalmapPtr;    // File offset to metalmap (unsigned char[mapx/2 * mapy/2])
    int   featurePtr;     // File offset to feature data (see MapFeatureHeader)

    int   numExtraHeaders; // Numbers of extra headers following main header
};
```

### 2.1 Offset table

| Offset (dec) | Offset (hex) | Size | Type | Field | Legal / observed values |
|---:|---:|---:|---|---|---|
| 0 | `0x00` | 16 | `char[16]` | `magic` | exactly `"spring map file\0"` (15 chars + NUL; bytes 16..15 are the NUL, no trailing garbage allowed — see §2.2) |
| 16 | `0x10` | 4 | `int32` | `version` | **must be 1** |
| 20 | `0x14` | 4 | `int32` | `mapid` | arbitrary; **never read by the engine** |
| 24 | `0x18` | 4 | `int32` | `mapx` | heightmap *squares* in X; multiple of 128 |
| 28 | `0x1C` | 4 | `int32` | `mapy` | heightmap *squares* in Z; multiple of 128 |
| 32 | `0x20` | 4 | `int32` | `squareSize` | **must be 8** |
| 36 | `0x24` | 4 | `int32` | `texelPerSquare` | **must be 8** |
| 40 | `0x28` | 4 | `int32` | `tilesize` | **must be 32** |
| 44 | `0x2C` | 4 | `float32` | `minHeight` | world Y for heightmap sample `0x0000` |
| 48 | `0x30` | 4 | `float32` | `maxHeight` | nominal world Y for sample `0x10000` (see §4.2 gotcha) |
| 52 | `0x34` | 4 | `int32` | `heightmapPtr` | absolute file offset |
| 56 | `0x38` | 4 | `int32` | `typeMapPtr` | absolute file offset |
| 60 | `0x3C` | 4 | `int32` | `tilesPtr` | absolute file offset |
| 64 | `0x40` | 4 | `int32` | `minimapPtr` | absolute file offset |
| 68 | `0x44` | 4 | `int32` | `metalmapPtr` | absolute file offset |
| 72 | `0x48` | 4 | `int32` | `featurePtr` | absolute file offset |
| 76 | `0x4C` | 4 | `int32` | `numExtraHeaders` | typically 1 (vegetation) or 0 |
| **80** | `0x50` | — | — | *(end of header; first ExtraHeader starts here)* | |

### 2.2 Magic string

The check is `std::strcmp(h.magic, "spring map file") == 0` (`SMFMapFile.cpp:27`). `strcmp`
stops at the first NUL, so:

* bytes 0..14 must be `spring map file` (ASCII, lowercase, single spaces),
* byte 15 must be `0x00`.

`"spring map file"` is 15 characters, so the 16-byte field is exactly filled by
`strcpy(magic, "spring map file")` — see Recoil's writer at `BlankMapGenerator.cpp:142`.

### 2.3 Version

```c
static bool CheckHeader(const SMFHeader& h)
{
    if (h.version != 1)          return false;
    if (h.tilesize != 32)        return false;
    if (h.texelPerSquare != 8)   return false;
    if (h.squareSize != 8)       return false;
    return (std::strcmp(h.magic, "spring map file") == 0);
}
```
— `SMFMapFile.cpp:16-28`

**Version 1 is the only version that has ever existed.** There is no version 2, no
Recoil-specific version bump, and no forward-compat path. If any of the five checks fails,
`CSMFMapFile::Open` throws:

```
[SMFMapFile::Open] corrupt header for "<name>" (v=%d ts=%d tps=%d ss=%d)
```
— `SMFMapFile.cpp:50-54`

and map loading aborts.

### 2.4 `mapid`

"Sort of a GUID of the file, just set to a random value when writing a map." It is parsed into
the struct (`SMFMapFile.cpp:298`) and **never used anywhere in the engine or unitsync**
(grep for `mapid` finds only the parse site, the struct comment, and
`BlankMapGenerator.cpp:144` which sets it to 0). `pymapconv` writes
`random.randint(0, 31 ** 2)` — i.e. 0..961, which tells you how seriously anyone takes it.

### 2.5 `mapx` / `mapy` semantics — the single most important thing to get right

`mapx` and `mapy` are counts of **heightmap squares (faces/quads)**, *not* vertices, *not*
world units, *not* texels.

Derived quantities (`CSMFReadMap::ParseHeader`, `SMFReadMap.cpp:113-130`;
`MapDimensions::Initialize`, `MapDimensions.h:34-51`):

```c
mapDims.mapx        = header.mapx;                       // squares in X
mapDims.mapy        = header.mapy;                       // squares in Z
mapDims.mapxp1      = mapx + 1;                          // heightmap vertices in X
mapDims.mapyp1      = mapy + 1;
mapDims.hmapx       = mapx >> 1;                         // metalmap/typemap/slopemap width
mapDims.hmapy       = mapy >> 1;
mapDims.mapSquares  = mapx * mapy;

mapSizeX            = header.mapx * SQUARE_SIZE;         // world extent in elmos, SQUARE_SIZE == 8
mapSizeZ            = header.mapy * SQUARE_SIZE;
numBigTexX          = header.mapx / bigSquareSize;       // bigSquareSize == 32 * tileScale == 128
numBigTexY          = header.mapy / bigSquareSize;
bigTexSize          = SQUARE_SIZE * bigSquareSize;       // 8 * 128 == 1024 texels
tileMapSizeX        = header.mapx / tileScale;           // tileScale == 4  -> mapx/4
tileMapSizeY        = header.mapy / tileScale;           // mapy/4
tileCount           = (header.mapx * header.mapy) / (tileScale * tileScale);   // mapx*mapy/16
maxHeightMapIdx     = ((mapx + 1) * (mapy + 1)) - 1;
heightMapSizeX      = mapx + 1;
```

Constants: `SQUARE_SIZE = 8` (`rts/Sim/Misc/GlobalConstants.h:24`);
`tileScale = 4`, `bigSquareSize = 32 * tileScale = 128` (`SMFReadMap.h:181-182`).

**Unit ladder (memorize this):**

| unit | size | count | who uses it |
|---|---|---|---|
| elmo (world unit) | 1 | `mapx*8` × `mapy*8` | positions, feature x/z |
| heightmap square | 8 elmos | `mapx` × `mapy` | terrain faces, `centerHeightMap` |
| heightmap vertex | — | `(mapx+1)` × `(mapy+1)` | the heightmap block |
| half-square ("hmap") | 16 elmos | `mapx/2` × `mapy/2` | metalmap, typemap, slopemap |
| grass square | 32 elmos | `mapx/4` × `mapy/4` | vegetation extra header |
| texture tile | 32 elmos = 32 texels | `mapx/4` × `mapy/4` | tile index array |
| big square / patch | 1024 elmos = 128 squares | `mapx/128` × `mapy/128` | ground textures, ROAM patches |
| "Spring map size" unit | 512 elmos = 64 squares | `mapx/64` × `mapy/64` | how humans name maps ("16x16") |

Note the coincidence that makes the format tick: **a texture tile is 32 texels wide and, at
`texelPerSquare = 8`, covers exactly 4 heightmap squares**. That is why `tileScale == 4` and why
the tile-index array and the grass map happen to share the same `mapx/4 × mapy/4` dimensions
(they are otherwise unrelated).

#### Legal values / multiples

The engine **does not validate** `mapx % 128`; the "must be divisible by 128" comment
(`SMFFormat.h:54-55`) is a convention enforced by tooling and required by these consumers:

* `numBigTexX = mapx / 128` — ground-texture squares (`SMFReadMap.cpp:120`)
* `numPatchesX = mapDims.mapx / PATCH_SIZE` with `PATCH_SIZE = 128` — the ROAM mesh
  (`rts/Map/SMF/ROAM/RoamMeshDrawer.cpp:58-59`, `rts/Map/SMF/ROAM/Patch.h:23`) **and** the basic
  mesh drawer (`rts/Map/SMF/Basic/BasicMeshDrawer.cpp:23-24`). A remainder here silently drops
  the last strip of terrain from rendering.
* `mipCenterHeightMaps[i]` sized `(mapx >> i) * (mapy >> i)` for `i` up to `numHeightMipMaps-1 = 6`
  (`ReadMap.cpp:367`, `ReadMap.h:248`) — needs `mapx % 64 == 0`.

`pymapconv` enforces the multiple structurally: it requires the source texture to be a
multiple of 1024 texels on both axes, and sets `mapx = texw // 8`, therefore
`mapx = 128 * (texw / 1024)` (`pymapconv.py:441-447`).

**Practical constraints:**
* minimum sane map: `mapx = mapy = 128` (one big square, 1024×1024 elmos, "2x2" in human units).
  Smaller and `numBigTexX`/`numPatchesX` become 0 and nothing renders.
* `mapx / 64` and `mapy / 64` give the "NxN" number players use; because `mapx % 128 == 0`, that
  number is always **even**.
* No upper bound is enforced in code. The practical ceiling is memory: see §11.3.

### 2.6 `squareSize`, `texelPerSquare`, `tilesize`

All three are hard-validated and all three are effectively **constants baked into the engine**:

* `squareSize == 8` — but the engine uses its own `SQUARE_SIZE = 8` everywhere and never reads
  `header.squareSize` again after `CheckHeader`. Writing anything else just makes the map unloadable.
* `texelPerSquare == 8` — diffuse texture resolution is `mapx*8 × mapy*8` texels. Again never
  used after validation; `tileScale = 4` and `bigTexSize = 1024` are hardcoded.
* `tilesize == 32` — texels per tile edge. Never read after `CheckHeader`. The `.smt`'s
  `TileFileHeader.tileSize` is separately validated against the **literal 32**
  (`tfh.tileSize != 32`, `SMFGroundTextures.cpp:165`) — the two fields are *not* compared to each
  other, so a header claiming `tilesize = 32` while the `.smt` says otherwise fails on the `.smt`
  check, not on a mismatch check.

### 2.7 `minHeight` / `maxHeight`

World-space Y bounds used to decode the 16-bit heightmap (§4). They can be **overridden** from
`mapinfo.lua`:

```c
const float minHgt = mapInfo->smf.minHeightOverride ? mapInfo->smf.minHeight : header.minHeight;
const float maxHgt = mapInfo->smf.maxHeightOverride ? mapInfo->smf.maxHeight : header.maxHeight;
```
— `SMFReadMap.cpp:146-147`; the override flags are simply `smfTable.KeyExists("minHeight")` /
`KeyExists("maxHeight")` in the `smf = { ... }` sub-table (`rts/Map/MapInfo.cpp:406-410`).
This lets a map be re-scaled vertically without recompiling the `.smf`.

**Key lookup in `mapinfo.lua` is case-insensitive.** `CMapInfo` parses `mapinfo.lua` with a plain
`LuaParser`, whose `lowerKeys` and `lowerCppKeys` both default to **true**
(`rts/Lua/LuaParser.cpp:59-60,83-84`): the parsed table's own keys are lowercased via
`LuaUtils::LowerKeys` (`LuaParser.cpp:283-284`, `rts/Lua/LuaUtils.cpp:427`) and the C++-side key is
lowercased in `LuaTable::PushValue` (`LuaParser.cpp:1001`) / `SubTable` (`LuaParser.cpp:872`).
That is why every real map spells these keys `minheight` / `maxheight` (lowercase) and the override
still fires.

**GOTCHA — in BAR the header's `minHeight`/`maxHeight` are usually dead.** In a survey of 46 shipped
BAR map archives (§12.6), **45 set an uncommented `smf.minheight` *and* `smf.maxheight` in
`mapinfo.lua`**, and in **29 of them the `mapinfo.lua` values differ from the values in the `.smf`
header**. A very common pattern is a placeholder header of `-50.0 .. 100.0` with the real range
supplied only by `mapinfo.lua` (e.g. `altair_crossing_v4.1`: header `-50..100`, mapinfo
`-125..875`). A writer should still emit truthful header values — decompilers and `unitsync` read
them — but must not assume the engine will use them, and a *reader* that ignores `mapinfo.lua` will
compute wrong world heights for most BAR maps.

`minHeight > maxHeight` is not rejected; it just produces an inverted map. This is not theoretical:
`mariposa_island_v2.4.1` ships a header of `minHeight = 970.0, maxHeight = -230.0` (and overrides it
from `mapinfo.lua` to `-320 .. 425`).

---

## 3. `ExtraHeader` chain

Source: `SMFFormat.h:83-103`.

```c
struct ExtraHeader {
    int size;  ///< Size of extra header
    int type;  ///< Type of extra header
};

#define MEH_None       0
#define MEH_Vegetation 1
```

The chain starts at **file offset 80** (`sizeof(SMFHeader)`) and contains exactly
`numExtraHeaders` entries. `size` is the **total** size of the entry *including* the 8-byte
`size`+`type` prefix, so the next entry starts at `current + size`.

Only one type is defined and only one is consumed: `MEH_Vegetation`.

### 3.1 `MEH_Vegetation` (grass / ground-vegetation map)

Layout on disk:

| Offset (relative) | Size | Type | Field |
|---:|---:|---|---|
| +0 | 4 | `int32` | `size` (= 12 by convention) |
| +4 | 4 | `int32` | `type` (= 1 = `MEH_Vegetation`) |
| +8 | 4 | `int32` | absolute file offset of the vegetation map |

The reader:

```c
bool CSMFMapFile::ReadGrassMap(void *data)
{
    ifs.Seek(sizeof(SMFHeader));                    // 80

    for (int a = 0; a < header.numExtraHeaders; ++a) {
        int size; int type;
        ifs.Read(&size, 4);  ifs.Read(&type, 4);
        swabDWordInPlace(size);  swabDWordInPlace(type);

        if (type == MEH_Vegetation) {
            int pos;
            ifs.Read(&pos, 4);
            swabDWordInPlace(pos);
            ifs.Seek(pos);
            ifs.Read(data, header.mapx / 4 * header.mapy / 4);
            /* char; no swabbing. */
            return true;                            // we arent interested in other extensions anyway
        }

        // assumes we can use data as scratch memory
        assert((size - 8) <= (header.mapx / 4 * header.mapy / 4));
        ifs.Read(data, size - 8);                   // skip unknown extra header payload
    }
    return false;
}
```
— `SMFMapFile.cpp:239-270`

**Vegetation map block:** `uint8[(mapx/4) * (mapy/4)]`, row-major, X fastest.
Per `SMFFormat.h:94-103`: `0` = none, `1` = grass, "rest undefined so far". In practice
`pymapconv` writes the blue channel of the feature map clamped to `min(254, b)`, and only for
*odd* `(col, row)` pairs — `if col % 2 and row % 2:  # grass at half rez`
(`pymapconv.py:793-794`) — so three quarters of the block are left at 0 by that tool. The grass
drawer treats **any non-zero value as "grass here"** (`GrassDrawer.cpp:129`,
`if (!gd->grassMap[...]) continue;`); no density encoding is implemented anywhere, so values
`2..254` behave identically to `1` (see §15, open question 5).

Grass-square size: `grassSquareSize = 4` map squares = 32 elmos
(`rts/Rendering/Env/GrassDrawer.cpp:50`).

### 3.2 Is the vegetation header still read by Recoil?

**Yes.** `CGrassDrawer` is still constructed unconditionally at world-load
(`rts/Rendering/WorldDrawer.cpp:122-125`) and pulls the grass map through
`readMap->GetInfoMap("grass", &grassbm)` (`GrassDrawer.cpp:200-217`). If the map has no
`MEH_Vegetation` extra header, `ReadGrassMap` returns `false`, `GetInfoMap` returns `nullptr`,
and the drawer sets `grassOff = true` and disables itself — **no error**. BAR maps typically
either omit the header or fill the map with zeros (Red Comet Remake has the header with an
all-zero map).

A `mapinfo.lua` `smf.grassmapTex` (an 8-bit greyscale image of exactly `mapx/4 × mapy/4`) can
override the embedded block (`SMFReadMap.cpp:941`, `MapInfo.cpp:414`); a dimension mismatch there
throws `std::runtime_error("grass-map has wrong size ...")` (`GrassDrawer.cpp:208-213`).

### 3.3 Gotchas in the extra-header chain

* **The engine only ever walks the chain from `ReadGrassMap`.** If a map has zero extra
  headers, or if grass is never requested, the chain is never parsed at all. So a malformed
  chain in a grass-less map is harmless in practice.
* **`size` must be correct for *non*-vegetation headers**, because the skip path uses
  `Read(data, size - 8)`. A `size < 8` desyncs the stream; a large `size` overruns the caller's
  `mapx/4 * mapy/4` scratch buffer (guarded only by a debug `assert`).
* **Recoil's own writer emits an inconsistent `size`.** `BlankMapGenerator.cpp:161` sets
  `vegHeader.size = sizeof(int)` (**4**) while actually writing 12 bytes. This is harmless
  *only* because `type == MEH_Vegetation` short-circuits before `size` is used. `pymapconv`
  writes the correct `12` (`pymapconv.py:1049`). **Writers should emit 12.**
* The vegetation payload's offset is a full absolute file offset, so the vegetation map itself
  need not immediately follow the header — though both known writers place it at
  `80 + 12 = 92`, immediately after.

---

## 4. Heightmap block (`heightmapPtr`)

### 4.1 Layout

| property | value |
|---|---|
| element type | `uint16` (little-endian) |
| count | `(mapx + 1) * (mapy + 1)` — **vertex** grid, one more than squares on each axis |
| row order | row-major, **X fastest**, row stride `(mapx + 1)` elements = `2*(mapx+1)` bytes |
| block size | `2 * (mapx + 1) * (mapy + 1)` bytes |
| origin | index 0 = world `(x=0, z=0)`; index `i` ↔ `x = (i % (mapx+1)) * 8`, `z = (i / (mapx+1)) * 8` |

Reader (`SMFMapFile.cpp:97-110` and `113-135`):

```c
const int hmx = header.mapx + 1;
const int hmy = header.mapy + 1;
const int len = hmx * hmy;
ifs.Seek(header.heightmapPtr);
ifs.Read(heightmap, len * sizeof(unsigned short));
```

Index arithmetic is confirmed by `ReadMap.h:337`:
`hm[(sqz * mapDims.mapxp1) + sqx]`.

### 4.2 uint16 → world height

```c
mapFile.ReadHeightmap(cornerHeightMapSyncedData, cornerHeightMapUnsyncedData,
                      minHgt, (maxHgt - minHgt) / 65536.0f);
```
— `SMFReadMap.cpp:157`

```c
sHeightMap[i] = base + swabWord(word) * mod;
```
— `SMFMapFile.cpp:132`

So, with `base = minHeight` and `mod = (maxHeight - minHeight) / 65536`:

> **`worldY = minHeight + raw * (maxHeight - minHeight) / 65536.0f`**

**GOTCHA — the divisor is 65536, not 65535.** The header comment claims `maxHeight` is
"height value that 0xffff in the heightmap corresponds to", which is **wrong**. The largest
representable height is

```
minHeight + 65535/65536 * (maxHeight - minHeight)
```

i.e. exactly one quantization step (`(max-min)/65536`) *below* `maxHeight`. Verified on
`RCR.smf`: `minHeight = 100.0`, `maxHeight = 320.0`, raw max = `65535`, decoded max =
**319.99664** (step = 220/65536 = 0.003357). An encoder that maps its own max to `0xFFFF` will
therefore land one step low — usually irrelevant, occasionally not (e.g. exact water-line
alignment).

**Inverting for a writer:**
```
raw = clamp(round((worldY - minHeight) * 65536 / (maxHeight - minHeight)), 0, 65535)
```
`pymapconv` clamps to `[0, 65534]` on its high-res-downscale path (`pymapconv.py:640`) — harmless conservatism.

### 4.3 Derived maps (not stored in the file)

The engine derives, at load time, from the vertex heightmap: `centerHeightMap`
(`mapx*mapy`), `maxHeightMap`, `faceNormals{Synced,Unsynced}` (`2*mapx*mapy`), `centerNormals`,
`slopeMap` (`hmapx*hmapy`), and 6 mip levels of `centerHeightMap`
(`ReadMap.cpp:342-380`). **None of these are in the `.smf`.**

---

## 5. Typemap block (`typeMapPtr`)

| property | value |
|---|---|
| element type | `uint8` |
| dimensions | `(mapx/2) × (mapy/2)` — one entry per **2×2 heightmap squares** = 16×16 elmos |
| count / size | `mapx/2 * mapy/2` bytes |
| row order | row-major, X fastest, stride `mapx/2` |

Reader (`SMFMapFile.cpp:225-229`):
```c
case hashString("type"): {
    ifs.Seek(header.typeMapPtr);
    ifs.Read(data, header.mapx / 2 * header.mapy / 2);
    return true;
}
```
Size query (`SMFMapFile.cpp:200`): `MapBitmapInfo(header.mapx / 2, header.mapy / 2)`.

### 5.1 Semantics

Each byte is an **index into `mapinfo.lua`'s `terrainTypes` table**, 0..255
(`CMapInfo::NUM_TERRAIN_TYPES = 256`, `rts/Map/MapInfo.h:25`). Each terrain type carries:

```lua
terrainTypes = {
  [0] = {
    name = "Default",
    hardness = 1.0,           -- multiplied into map.maphardness for crater deformation
    receiveTracks = true,
    moveSpeeds = { tank = 1.0, kbot = 1.0, hover = 1.0, ship = 1.0 },
  },
  [150] = { ... },
}
```
— parsed in `CMapInfo::ReadTerrainTypes`, `MapInfo.cpp:432-459`. Unspecified indices default to
`name="Default"`, `hardness=1.0`, all `moveSpeeds=1.0`; all four speeds are clamped to `>= 0`
and hardness to `>= 0.001`.

Consumers:
* **Pathing / movement**: `readMap->GetTypeMapSynced()[(xSquare>>1) + (zSquare>>1)*hmapx]`
  → `tt.tankSpeed` / `kbotSpeed` / `hoverSpeed` / `shipSpeed` multiplied into the speed mod
  (`rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:87-104`).
* **Terrain deformation**: `rawHardness[tti]` per type (`rts/Map/BasicMapDamage.cpp:74-79,148,199`).
* **Lua**: `Spring.GetGroundInfo(x, z)` returns `ix, iz, terrainTypeIndex, name, metalExtraction,
  hardness, tankSpeed, kbotSpeed, hoverSpeed, shipSpeed, receiveTracks`
  (`rts/Lua/LuaSyncedRead.cpp:7886-7923`). `Spring.SetTerrainTypeData` / the typemap is writable
  at runtime (`LuaSyncedCtrl.cpp:7139`), clamped into `[0, 255]`.

### 5.2 If it is missing or wrong-sized

```c
if (typemapPtr != nullptr && tbi.width == mapDims.hmapx && tbi.height == mapDims.hmapy) {
    memcpy(typeMap.data(), typemapPtr, typeMap.size());
} else {
    LOG_L(L_WARNING, "[CReadMap::LoadMap] missing or illegal typemap for \"%s\" (dims=<%d,%d>)", ...);
}
```
— `ReadMap.cpp:172-178`. The engine's `typeMap` was pre-filled with **0** (`ReadMap.cpp:376-377`,
"by default, all squares are set to terrain-type 0"), so a broken typemap degrades to
"everything is terrain type 0" plus a warning. Not fatal.

A `mapinfo.lua` `smf.typemapTex` (greyscale image, exact `mapx/2 × mapy/2`) overrides the
embedded block (`SMFReadMap.cpp:940`, `MapInfo.cpp:413`).

---

## 6. Minimap block (`minimapPtr`)

### 6.1 Format

| property | value |
|---|---|
| format | **DXT1** (`GL_COMPRESSED_RGBA_S3TC_DXT1_EXT`), 8 bytes per 4×4 block |
| base dimensions | **always 1024 × 1024**, regardless of map size |
| mip levels | **9** (`MINIMAP_NUM_MIPMAP`), i.e. 1024, 512, 256, 128, 64, 32, 16, 8, **4** |
| total size | **699048 bytes** (`MINIMAP_SIZE`) |
| order | mip 0 first, then mip 1, ... mip 8, contiguous |

`SMFFormat.h:31-34`:
```c
static constexpr size_t MINIMAP_NUM_MIPMAP = 9;
static constexpr size_t MINIMAP_SIZE = 699048;
```

### 6.2 The arithmetic

Per-level size is `((mipsize + 3) / 4)^2 * 8` (`SMFMapFile.cpp:84,88`; `SMFReadMap.cpp:186`):

| level | dim | blocks (`dim/4`) | bytes (`blocks² × 8`) | cumulative |
|---:|---:|---:|---:|---:|
| 0 | 1024 | 256 | 524288 | 524288 |
| 1 | 512 | 128 | 131072 | 655360 |
| 2 | 256 | 64 | 32768 | 688128 |
| 3 | 128 | 32 | 8192 | 696320 |
| 4 | 64 | 16 | 2048 | 698368 |
| 5 | 32 | 8 | 512 | 698880 |
| 6 | 16 | 4 | 128 | 699008 |
| 7 | 8 | 2 | 32 | 699040 |
| 8 | 4 | 1 | 8 | **699048** ✔ |

**The chain stops at 4×4, not 1×1** (4×4 is the smallest meaningful DXT1 block). A full chain
to 1×1 would be 699064 bytes; that is *not* what the format wants. `nvdxt -nmips 9` /
`CompressonatorCLI -miplevels 9` produce exactly this (`pymapconv.py:515`, `:519`).

### 6.3 How it is read

```c
void CSMFMapFile::ReadMinimap(void* data) {
    ifs.Seek(header.minimapPtr);
    ifs.Read(data, MINIMAP_SIZE);          // unconditional 699048-byte read
}
```
— `SMFMapFile.cpp:70-75`

Single-mip access (used by unitsync `GetMinimap(mapName, mipLevel)`, `mipLevel` restricted to
0..8, `unitsync.cpp:970-971`):
```c
int offset = 0, mipsize = 1024;
for (i = 0; i < min(MINIMAP_NUM_MIPMAP, miplevel); i++) {
    offset += (Square((mipsize + 3) / 4) * 8);
    mipsize >>= 1;
}
data.resize(Square((mipsize + 3) / 4) * 8);
ifs.Seek(header.minimapPtr + offset);
ifs.Read(data.data(), data.size());
return mipsize;
```
— `SMFMapFile.cpp:77-93`

Upload (`SMFReadMap.cpp:178-189`): 9 `glCompressedTexImage2DARB` calls, `GL_TEXTURE_MAX_LEVEL`
set to `MINIMAP_NUM_MIPMAP - 1 = 8`.

### 6.4 Gotchas

* **`mapinfo.lua`'s `smf.minimapTex` wins.** `CSMFReadMap::LoadMinimap` first tries to load that
  bitmap and, if it succeeds, **never touches `minimapPtr` at all** (`SMFReadMap.cpp:164-170`).
  **But essentially nobody uses it:** of 46 shipped BAR map archives surveyed (§12.6), **zero** set
  an uncommented `smf.minimapTex` (only 1 sets `typemapTex`, 1 sets `metalmapTex`, 0 set
  `grassmapTex`). The embedded 699048-byte DXT1 block is therefore **load-bearing in practice** —
  a writer must emit a real one.
* The buffer is zero-initialized before the read (`std::vector<unsigned char> minimapTexBuf(MINIMAP_SIZE, 0)`,
  `SMFReadMap.cpp:173`), so a truncated file yields a black-ish minimap rather than a crash.
* The minimap is always square 1024×1024 even for non-square maps, so non-square maps' minimaps
  are stretched. That is the engine's problem, not the format's.
* `minimapPtr = 0` is *legal-ish*: Recoil's blank-map generator sets it to 0
  (`BlankMapGenerator.cpp:191`) and writes no minimap block at all; the engine then reads
  699048 bytes starting at file offset 0 (header bytes reinterpreted as DXT1 → garbage, or a
  short read → black). Do not imitate this.

---

## 7. Metalmap block (`metalmapPtr`)

| property | value |
|---|---|
| element type | `uint8` |
| dimensions | `(mapx/2) × (mapy/2)` — one entry per **2×2 heightmap squares** |
| square size | `METAL_MAP_SQUARE_SIZE = SQUARE_SIZE * 2 = 16` elmos (`rts/Map/MetalMap.h:13`) |
| count / size | `mapx/2 * mapy/2` bytes |
| row order | row-major, X fastest, stride `mapx/2` |

```c
case hashString("metal"): {
    ifs.Seek(header.metalmapPtr);
    ifs.Read(data, header.mapx / 2 * header.mapy / 2);
    return true;
}
```
— `SMFMapFile.cpp:219-223`

### 7.1 Byte → metal amount

`ReadMap.cpp:162-167`:
```c
unsigned char* metalmapPtr = rm->GetInfoMap("metal", &mbi);
metalMap.Init(metalmapPtr, mbi.width, mbi.height, mapInfo->map.maxMetal);
```

`MetalMap.cpp:29-52` stores the raw bytes in `distributionMap` and keeps
`metalScale = maxMetal`. Then:

```c
float CMetalMap::GetMetalAmount(int x, int z) const {
    x = std::clamp(x, 0, sizeX - 1);
    z = std::clamp(z, 0, sizeZ - 1);
    return distributionMap[(z * sizeX) + x] * metalScale;
}
```
— `MetalMap.cpp:76-83`

> **`metalAmount(mx, mz) = metalmapByte * mapinfo.maxMetal`**

where `maxMetal` comes from the **top level** of `mapinfo.lua`
(`map.maxMetal = topTable.GetFloat("maxMetal", 0.02f)`, `MapInfo.cpp:106`, clamped to `>= 0` at
`MapInfo.cpp:115`). There is no separate `metalScale` key — `metalScale` is just the engine's
internal name for `maxMetal` (`CMetalMap::Init`'s `_metalScale` parameter).

**Real-world values** (`mapinfo.lua` top level): engine default `0.02` (`MapInfo.cpp:106`).
Measured across 46 shipped BAR map archives (§12.6) the range is **`0.37` – `10`**, clustered
around `1.0`: median ≈ `1.2`, quartiles ≈ `0.9` / `1.8`. Concrete samples —
`raptor_crater_v2` `0.4`, `riverrun_v1` `0.45`, `red_comet_remake_1.8` `0.75`,
`altair_crossing_v4.1` `1.8`, `onyx_cauldron_2.2.2` `3.6`, `cloud9_v2` and `asteroid_mines_v3`
`7.5`, `speedmetal_bar_v2` `10`. The value is a pure scale factor, so a high `maxMetal` simply
means the metalmap bytes are small — there is no "correct" range.

The setter inverts it (`MetalMap.cpp:86-95`):
```c
distributionMap[(z*sizeX)+x] = (metalScale == 0.0f) ? 0
                             : std::clamp((int)(m / metalScale), 0, 255);
```

### 7.2 Extraction

An extractor accumulates, over every metalmap square inside `extractorRadius`
(`rts/Sim/Units/UnitTypes/ExtractorBuilding.cpp:140-142, 180-181`):

```c
msqr.extractionDepth = metalMap.RequestExtraction(x, z, unitDef->extractsMetal);
metalExtract += msqr.extractionDepth * metalMap.GetMetalAmount(msqr.x, msqr.z);
```

so end-to-end: **`income = Σ_squares extractsMetal × metalmapByte × maxMetal`**, with
`RequestExtraction` implementing the "deeper extractor wins, shallower gets nothing" sharing rule
(`MetalMap.cpp:98-114`).

### 7.3 Notes

* The stored byte is an arbitrary density 0..255; `255` is not special. In real maps the
  metalmap is nearly all `0` with small patches at `255` (Red Comet: 97824 zeros, 480 bytes of
  `255`).
* `pymapconv` takes the **red channel** of the supplied metalmap image, resizing bilinearly if
  the dimensions are wrong (`pymapconv.py:696-706`).
* `mapinfo.lua` `smf.metalmapTex` (greyscale, exact `mapx/2 × mapy/2`) overrides the embedded
  block (`SMFReadMap.cpp:939`).
* If `GetInfoMap("metal")` returns `nullptr`, `CMetalMap::Init` forces `metalScale = 1.0f` and a
  zero distribution (`MetalMap.cpp:41-45`) — i.e. no metal anywhere. For a valid SMF this cannot
  happen, since `ReadInfoMap("metal")` always returns `true`.

---

## 8. Feature block (`featurePtr`)

### 8.1 Layout

```
featurePtr ->  MapFeatureHeader          8 bytes
               char[] name0 '\0'         NUL-terminated ASCII
               char[] name1 '\0'
               ...                       numFeatureType strings, back to back
               MapFeatureStruct[0]       24 bytes
               MapFeatureStruct[1]
               ...                       numFeatures structs
```

```c
struct MapFeatureHeader {
    int numFeatureType;   // +0
    int numFeatures;      // +4
};                        // 8 bytes

struct MapFeatureStruct {
    int   featureType;    // +0   index into the name table above
    float xpos;           // +4   world X, elmos
    float ypos;           // +8   world Y (height)   -- IGNORED, see below
    float zpos;           // +12  world Z, elmos
    float rotation;       // +16  heading; -32768..32767 == full circle
    float relativeSize;   // +20  "Not used at the moment keep 1"  -- IGNORED
};                        // 24 bytes
```
— `SMFFormat.h:135-157`

Readers: `ReadMapFeatureHeader` (`SMFMapFile.cpp:316-320`), `ReadMapFeatureStruct`
(`SMFMapFile.cpp:323-331`).

### 8.2 Name-table parsing — the 30-character trap

```c
char featureTypes[16384][32];                     // SMFMapFile.h:62
...
constexpr size_t S = sizeof(featureTypes);        // 16384*32
constexpr size_t K = sizeof(featureTypes[0]);     // 32
constexpr size_t N = S / K;                       // 16384

if (featureHeader.numFeatureType > N) {
    // actual format string; prints (numFeatureType - N), not "N"
    snprintf(featureTypes[0], S - 1, "[SMFMapFile::%s] " _STPF_ " excess feature-types defined\n",
             __func__, static_cast<size_t>(featureHeader.numFeatureType) - N);
    throw content_error(featureTypes[0]);
}

for (int a = 0; a < featureHeader.numFeatureType; ++a) {
    char* featureType = featureTypes[a];
    for (size_t j = 0, n = K - 1; j < n; j++) {   // j = 0..30, i.e. 31 bytes max
        ifs.Read(&featureType[j], 1);
        if (featureType[j] == 0) break;
    }
}
featureFileOffset = ifs.GetPos();
```
— `SMFMapFile.cpp:138-165`

**Consequences a writer must respect:**

1. **Max 16384 feature types.** More → `content_error`, map fails to load.
2. **Max 30 characters + NUL per name.** The inner loop makes at most 31 read attempts. If the
   first 31 bytes contain no NUL, the loop exits *without consuming the terminator*, and every
   subsequent name (and then the whole `MapFeatureStruct` array) is read from a shifted offset.
   Silent, total corruption. Keep names ≤ 30 chars.
3. **Names are read strictly sequentially from `featurePtr + 8`.** There is no per-name offset
   table and no padding.
4. `featureFileOffset` — the start of the `MapFeatureStruct` array — is recorded *after* parsing
   the names, and `ReadFeatureInfo(MapFeatureInfo*)` asserts it is non-zero
   (`SMFMapFile.cpp:171`). So `CSMFMapFile::ReadFeatureInfo()` (no args) must run first; the
   engine does this at the end of `CSMFReadMap`'s constructor (`SMFReadMap.cpp:101`).

### 8.3 Instance semantics

`CSMFMapFile::ReadFeatureInfo(MapFeatureInfo* f)` (`SMFMapFile.cpp:168-182`) copies
`featureType`, `(xpos, ypos, zpos)` and `rotation`. Then `CFeatureHandler::LoadFeaturesFromMap`
(`rts/Sim/Features/FeatureHandler.cpp:64-105`):

```c
const FeatureDef* def = featureDefHandler->GetFeatureDef(readMap->GetFeatureTypeName(mfi[a].featureType), true);
if (def == nullptr) continue;

FeatureLoadParams params = {
    nullptr, nullptr, def,
    float3(mfi[a].pos.x, CGround::GetHeightReal(mfi[a].pos.x, mfi[a].pos.z), mfi[a].pos.z),
    ZeroVector,
    -1, -1, -1,                                   // featureID, teamID, allyTeamID
    static_cast<short int>(mfi[a].rotation),      // heading
    FACING_SOUTH,
    0, 0
};
LoadFeature(params);
```

* **`ypos` is discarded.** The feature is snapped to `CGround::GetHeightReal(x, z)`. Writers may
  emit 0.0 (both `pymapconv` and every real map do).
* **`relativeSize` is discarded.** Write `1.0`.
* **`rotation` → `short` heading.** Spring's angle unit is `SPRING_CIRCLE_DIVS = 65536` per full
  turn (`rts/System/SpringMath.h:16-17`), and `TAANG2RAD = PI / 32768`
  (`rts/Sim/Units/Scripts/CobInstance.h:25`). So:
  `radians = rotation * PI / 32768`; `rotation = degrees * 65536 / 360`.
  The `float` is C-cast to `short`, so it truncates toward zero and wraps outside
  `[-32768, 32767]`. Build facing is always `FACING_SOUTH`.
* Unknown names log an error (`could not find FeatureDef "<name>"`) and the instance is skipped;
  the map still loads.
* **Name lookup is case-insensitive-ish**: `LoadFeatureDefsFromMap` lowercases via
  `StringToLower` when creating default defs (`FeatureDefHandler.cpp:237`), and
  `GetFeatureDef` looks up a `featureDefIDs` map keyed by the (lowercased) def name.

### 8.4 The reserved `TreeType` / `GeoVent` names

`CFeatureDefHandler::LoadFeatureDefsFromMap` (`rts/Sim/Features/FeatureDefHandler.cpp:227-259`):

```c
const char* treeDefName = "treetype";
const char*  geoDefName =  "geovent";
const char* errorFormat = "[%s] unknown map default feature-type \"%s\" (only \"%s\" and \"%s\" are recognized)";

for (int i = 0, n = readMap->GetNumFeatureTypes(); i < n; ++i) {
    const std::string& name = StringToLower(readMap->GetFeatureTypeName(i));
    if (GetFeatureDef(name, false) != nullptr) continue;             // game already defines it
    if (name.find(treeDefName) != string::npos) { AddFeatureDef(name, CreateDefaultTreeFeatureDef(name), true); continue; }
    if (name.find(geoDefName)  != string::npos) { AddFeatureDef(name, CreateDefaultGeoFeatureDef(name),  true); continue; }
    LOG_L(L_ERROR, errorFormat, __func__, name.c_str(), treeDefName, geoDefName);
}

// add a default geovent FeatureDef if the map did not
if (GetFeatureDef(geoDefName, false) != nullptr) return;
AddFeatureDef(geoDefName, CreateDefaultGeoFeatureDef(geoDefName), true);
```

Rules:

* Resolution order is: **(1) a game-supplied `FeatureDef` with that (lowercased) name wins;
  (2) else, name *containing* `"treetype"` → engine default tree; (3) else, name *containing*
  `"geovent"` → engine default geo vent; (4) else, error, no def.**
  It is a substring test (`find(...) != npos`), not a prefix test.
* **Default tree** (`FeatureDefHandler.cpp:160-180`): `drawType = DRAWTYPE_TREE + atoi(name.substr(8))`.
  `substr(8)` skips exactly `"treetype"`, so the canonical spelling is `TreeType<N>` with the
  number immediately after. Properties: collidable, burnable, destructable, reclaimable,
  `cost = {metal 0, energy 250}`, `reclaimTime 1500`, `health 5`, `xsize = zsize = 2`, `mass 20`,
  spherical collision volume, description `"Tree"`.
* **Default geovent** (`FeatureDefHandler.cpp:182-205`): `geoThermal = true`,
  `drawType = DRAWTYPE_NONE` ("geos are (usually) rendered only as vents baked into the map's
  ground texture and emit smoke to be visible"), non-collidable, non-destructable,
  non-reclaimable, `xsize = zsize = 0`, zero cost/health.
* **A `geovent` def always exists**, injected by the engine even if the map never names one.

**Convention used by every real map / `pymapconv`** (`pymapconv.py:734-736`): the name table
*begins* with exactly 17 reserved entries, indices 0..16:

```
0..15 : "TreeType0" ... "TreeType15"
16    : "GeoVent"
17+   : game feature names, e.g. "btreeblo_1", "rock5x5", ...
```

This is a tooling convention, not an engine requirement — the engine only pattern-matches names —
but tools (and BAR's feature-map red/green-channel encoding) assume it. `pymapconv`'s feature-map
importer emits `GeoVent` for green == 255, `TreeType(g-200)` for green in 200..215 (`pixel[1] < 216 and pixel[1] > 199`), and looks up
the red channel in a user feature list as `featurelist[255 - pixel[0]]` (`pymapconv.py:790-814`).

### 8.5 Feature block gotchas

* **`numFeatures == 0` is common and fine** (Red Comet Remake has 17 types and 0 instances;
  BAR places its features from Lua instead). `CFeatureHandler::LoadFeaturesFromMap` early-returns.
* The name table is still written in full even with zero instances.
* There is **no cap on `numFeatures` in the SMF reader**. The hard ceiling is
  `MAX_FEATURES = 32000` (`rts/Sim/Misc/GlobalConstants.h:115`); the feature ID pool is exactly
  that size (`FeatureHandler.cpp:39-44`) and `LoadFeature` silently returns `nullptr` once it is
  exhausted.
* Positions are in **elmos**, not squares. `pymapconv` centers features on a heightmap square:
  `x = 8.0*col + 4`, `z = 8.0*row + 4` (`pymapconv.py:798`, `:802`, `:809`).

---

## 9. Tiles block (`tilesPtr`) and the `.smt` file

### 9.1 On-disk layout at `tilesPtr`

```
tilesPtr ->  MapTileHeader                     8 bytes
             { int numTilesInThisFile;         4 bytes  }   <- repeated
             { char smtFileName[] '\0';        variable }      numTileFiles times
             int32 tileIndex[ (mapx/4) * (mapy/4) ]        4 * mapx*mapy/16 bytes
```

```c
struct MapTileHeader {
    int numTileFiles;   // +0   Number of tile files to read in (usually 1)
    int numTiles;       // +4   Total number of tiles
};                      // 8 bytes
```
— `SMFFormat.h:123-127`

`SMFFormat.h:110-121` spells out the contract:

> MapTileHeader is followed by numTileFiles file definition where each file definition is an int
> followed by a zero terminated file name. ... Each file defines as many tiles the int indicates
> with the following files starting where the last one ended so if there is 2 files with 100 tiles
> each the first defines 0-99 and the second 100-199.
> After this follows an `int[mapx*texelPerSquare/tileSize * mapy*texelPerSquare/tileSize]`
> (this is `int[mapx/4 * mapy/4]` with currently hardcoded texelPerSquare=8 and tileSize=32)
> which are indices to the defined tiles.

### 9.2 Reader

`CSMFGroundTextures::LoadTiles` (`SMFGroundTextures.cpp:92-195`):

```c
ifs->Seek(header.tilesPtr);
MapTileHeader tileHeader;
CSMFMapFile::ReadMapTileHeader(tileHeader, *ifs);          // 2 x int32

if (smfMap->tileCount <= 0) throw content_error("... tileCount=%d <= 0");

tileMap.resize(smfMap->tileCount);                          // == mapx*mapy/16, NOT numTiles
tiles.assign(size_t(tileHeader.numTiles) * SMALL_TILE_SIZE, 0);
squares.resize(smfMap->numBigTexX * smfMap->numBigTexY);

for (int a = 0, curTile = 0; a < tileHeader.numTileFiles; ++a) {
    int numSmallTiles = 0;
    char fileNameBuffer[256] = {0};
    ifs->Read(&numSmallTiles, sizeof(int));
    ifs->ReadString(&fileNameBuffer[0], sizeof(fileNameBuffer) - 1);   // 255
    swabDWordInPlace(numSmallTiles);
    ... open  smfDir + smtFileName  (or the mapinfo override)  ...
    TileFileHeader tfh; CSMFMapFile::ReadMapTileFileHeader(tfh, tileFile);
    if (strcmp(tfh.magic, "spring tilefile") != 0 || tfh.version != 1
        || tfh.tileSize != 32 || tfh.compressionType != 1) throw content_error(...);
    for (int b = 0; b < numSmallTiles; ++b)
        tileFile.Read(&tiles[(curTile++) * SMALL_TILE_SIZE], SMALL_TILE_SIZE);
}

ifs->Read(&tileMap[0], smfMap->tileCount * sizeof(int));    // NO SEEK: sequential!
for (int i = 0; i < smfMap->tileCount; i++) swabDWordInPlace(tileMap[i]);
```

**Critical reading rules:**

* **The tile-index array is read sequentially, with no seek.** It must start immediately after
  the NUL of the last SMT filename. There is no pointer to it.
* `CFileHandler::ReadString(buf, 255)` reads up to 255 bytes then seeks back to
  `pos + strlen(buf) + 1` (`rts/System/FileSystem/FileHandler.cpp:195-211`), so the name is
  NUL-terminated and may be up to **255 characters**.
* `tileMap` is sized from **map geometry** (`tileCount = mapx*mapy/16`), never from
  `tileHeader.numTiles`. `numTiles` only sizes the in-memory tile *pool*.
* The `.smt` path is resolved as `FileSystem::GetDirectory(gameSetup->MapFileName()) + smtFileName`
  (usually `maps/` + name), with a fallback to the bare name treated as an absolute/VFS path
  (`SMFGroundTextures.cpp:123, 141-149`).
* `mapinfo.lua` may override the names via `smf = { smtFileName0 = "maps/X.smt", smtFileName1 = ... }`
  (`MapInfo.cpp:420-428`), but **only if the count matches `numTileFiles` exactly**; otherwise a
  warning is logged and the embedded names are used (`SMFGroundTextures.cpp:126-130`).

### 9.3 The tile-index array

| property | value |
|---|---|
| element type | `int32` (signed, little-endian) |
| dimensions | `tileMapSizeX × tileMapSizeY` = `(mapx/4) × (mapy/4)` |
| count | `tileCount = mapx*mapy/16` |
| size | `4 * mapx * mapy / 16` bytes |
| row order | row-major over the **whole map**, X fastest, stride `mapx/4` |
| value | global tile index `[0, numTiles)` across the concatenated `.smt` files |

Indexing is confirmed by `CSMFGroundTextures::ExtractSquareTiles`
(`SMFGroundTextures.cpp:505-544`):

```c
constexpr int TILE_MIP_OFFSET[] = {0, 512, 512+128, 512+128+32};
constexpr int BLOCK_SIZE = 32;                        // 32x32 tiles per big square
const int tileOffsetX = texSquareX * BLOCK_SIZE;
const int tileOffsetY = texSquareY * BLOCK_SIZE;
for (int y1 = 0; y1 < BLOCK_SIZE; y1++)
  for (int x1 = 0; x1 < BLOCK_SIZE; x1++) {
      const int tileX = tileOffsetX + x1;
      const int tileY = tileOffsetY + y1;
      const int tileIdx = tileMap[tileY * smfMap->tileMapSizeX + tileX];
      const GLint* tile = (GLint*) &tiles[tileIdx * SMALL_TILE_SIZE + mipOffset];
      ...
  }
```

and by `pymapconv`'s writer, `tilepos = 32*tilex + x + (32*springmapx//2)*(32*tiley + y)`
(`pymapconv.py:996`) — identical, since `32 * (springmapx/2) == mapx/4`.

### 9.4 Map squares ↔ tiles ↔ big squares — exact relationship

```
1 tile            = 32 x 32 texels
                  = 4 x 4 heightmap squares      (because texelPerSquare == 8)
                  = 32 x 32 elmos
1 big square      = 32 x 32 tiles
                  = 1024 x 1024 texels           (bigTexSize = SQUARE_SIZE * bigSquareSize)
                  = 128 x 128 heightmap squares  (bigSquareSize = 32 * tileScale = 128)
                  = 1024 x 1024 elmos
whole map texture = (mapx * 8) x (mapy * 8) texels
tile grid         = (mapx / 4) x (mapy / 4)
big-square grid   = (mapx / 128) x (mapy / 128)  == numBigTexX x numBigTexY
```

Each big square becomes one OpenGL texture, assembled at load (or streamed, config
`SMFTextureStreaming`, default `false`) by copying 32×32 tiles out of the tile pool.
Mip levels 0..3 of a big-square texture are `1024, 512, 256, 128` texels, sized
`(mipSqSize * mipSqSize) / 2` bytes each — DXT1's 0.5 bytes/texel
(`SMFGroundTextures.cpp:552-553`).

### 9.5 `.smt` (Spring Map Tiles) file

```c
struct TileFileHeader {
    char magic[16];      // +0   "spring tilefile\0"
    int  version;        // +16  Must be 1 for now
    int  numTiles;       // +20  Total number of tiles in this file
    int  tileSize;       // +24  Must be 32 for now
    int  compressionType;// +28  Must be 1 (= dxt1) for now
};                       // 32 bytes
```
— `SMFFormat.h:175-182`; reader `SMFMapFile.cpp:341-348`.

Body: `numTiles` tiles, back to back, each exactly `SMALL_TILE_SIZE` bytes.

```c
static constexpr size_t SMALL_TILE_SIZE = (512 >> 0) + (512 >> 2) + (512 >> 4) + (512 >> 6);
//                                      = 512 + 128 + 32 + 8 = 680
```
— `SMFFormat.h:27-28`

One tile = **DXT1, 4 mip levels**:

| mip | dim | blocks | bytes | offset in tile |
|---:|---:|---:|---:|---:|
| 0 | 32×32 | 8×8 | 512 | 0 |
| 1 | 16×16 | 4×4 | 128 | 512 |
| 2 | 8×8 | 2×2 | 32 | 640 |
| 3 | 4×4 | 1×1 | 8 | 672 |
| | | | **680** | |

(matches `TILE_MIP_OFFSET[] = {0, 512, 640, 672}` in `ExtractSquareTiles`.)

**Total `.smt` size = `32 + numTiles * 680`** — verified exactly on `RCR.smt`:
`32 + 24577 * 680 = 16 712 392` bytes = actual file size.

Tiles are deduplicated: identical 32×32 blocks share one index (`pymapconv.py:976,994-995` uses the
raw 680-byte tile as a dict key), and one `.smt` can be shared between maps.

**GOTCHA — do not count on dedup.** Across 36 shipped BAR maps (§12.6), **33 have
`numTiles >= tileCount`**, i.e. effectively *zero* deduplication; only 3 showed real savings
(`asteroid_mines_v3` 51.6 %, `cloud9_v2` 59.5 %, `boreal_falls_1.0.2` 99.9 %). Two maps even have
`numTiles == tileCount + 1` (`RCR` 24577/24576, `comet_catcher_remake_1.8` 49153/49152) — a spare
pool entry, which is legal because the pool size and the index-array size are independent. Modern
high-detail textures almost never produce duplicate 32×32 DXT1 blocks, so size the `.smt` for the
worst case `32 + tileCount * 680`.

If the referenced `.smt` cannot be opened, the engine **does not fail**; it fills that file's
whole tile range with `0xAA` and logs
`could not find .smt tile-file %d ("%s"; ALL %d SMALL TILES WILL BE MADE RED)`
(`SMFGroundTextures.cpp:151-160`).

On drivers without S3TC but with `GL_ARB_ES3_compatibility`, the whole tile pool is transcoded
DXT1 → ETC1 in place at load (`RecompressTilesIfNeeded`, `SMFGroundTextures.cpp:290-320`); both
formats are 8 bytes / 4×4 block, so the layout survives.

---

## 10. Recoil vs. classic Spring 105 — divergences

I diffed Recoil `master` @ `8f47fd28` against `spring/spring` `master`
(`rts/Map/SMF/SMFFormat.h`, `SMFMapFile.{h,cpp}`).

### 10.1 Format: **zero divergence**

`SMFFormat.h` differs only by:
* three typo fixes in comments (`refered`→`referred`, `compresed`→`compressed`, `followes`→`follows`);
* `#define SMALL_TILE_SIZE 680` / `#define MINIMAP_SIZE 699048` / `#define MINIMAP_NUM_MIPMAP 9`
  became `static constexpr size_t`, with `SMALL_TILE_SIZE` now written as the self-documenting
  `(512>>0)+(512>>2)+(512>>4)+(512>>6)` (still 680).

**No new fields. No new version. No new `ExtraHeader` types. No deprecations.** A `.smf` written
for Spring 105 loads bit-identically in Recoil and vice versa.

`SMFMapFile.cpp` differs only by added `RECOIL_DETAILED_TRACY_ZONE;` profiling macros and one
`static_cast<size_t>` in a format string. The parsing logic is character-for-character the same.

### 10.2 Recoil-side additions *around* the format

* **`CBlankMapGenerator`** (`rts/Map/Generation/BlankMapGenerator.{h,cpp}`) — a Recoil-only
  in-engine SMF+SMT **writer** that synthesizes a flat map into a virtual archive from
  map options `blank_map_x`, `blank_map_y`, `blank_map_height`, `blank_map_color_{r,g,b}`
  (legacy aliases `new_map_x`/`new_map_y`). Useful as a second reference writer, with three
  caveats already noted: it emits `ExtraHeader.size = 4` instead of 12; it sets
  `minimapPtr = 0` and writes no minimap; and it orders blocks
  `veg → heightmap → typemap → **tiles** → metalmap → features` — proving block order is free.
  `mapSize` there is in units of `bigSquareSize` (128 squares), and `blank_map_x` is halved into
  it, so `blank_map_x` counts 64-square units, i.e. the familiar "NxN".
* **Per-file diffuse-texture streaming toggle** `SMFTextureStreaming` (default **false** in
  Recoil; Spring 105 always streamed) plus `SMFTextureLodBias`
  (`SMFGroundTextures.cpp:46-47`). Pure rendering policy, no format impact.
* **ETC1/ETC2 transcode fallback** for the tile pool (also present in late 105 branches).
* `SM3` was removed long before Recoil — `CReadMap::LoadMap` throws
  `"SM3 maps are no longer supported as of Spring 95.0"` (`ReadMap.cpp:149`). SMF is the only
  supported map format.
* `mapinfo.lua` `smf.{minHeight,maxHeight,minimapTex,metalmapTex,typemapTex,grassmapTex,smtFileNameN}`
  overrides all predate Recoil but are the sanctioned way to patch an `.smf` without rebuilding it
  (`MapInfo.cpp:404-428`).

---

## 11. Hard constraints, validation and failure modes

### 11.1 Fatal (throws `content_error`, map does not load)

| Condition | Where | Message |
|---|---|---|
| `version != 1` | `SMFMapFile.cpp:18` | `corrupt header for "X" (v=.. ts=.. tps=.. ss=..)` |
| `tilesize != 32` | `SMFMapFile.cpp:20` | same |
| `texelPerSquare != 8` | `SMFMapFile.cpp:22` | same |
| `squareSize != 8` | `SMFMapFile.cpp:24` | same |
| `magic != "spring map file"` | `SMFMapFile.cpp:27` | same |
| file not found in VFS | `SMFMapFile.cpp:43-46` | `could not open "X"` |
| `numFeatureType > 16384` | `SMFMapFile.cpp:148-151` | `N excess feature-types defined` |
| `tileCount <= 0` (i.e. `mapx*mapy < 16`) | `SMFGroundTextures.cpp:110-113` | `smfMap->tileCount=%d <= 0` |
| `header.mapx/mapy != mapDims` | `SMFGroundTextures.cpp:100-103` | `header.{mapx,mapy} != mapDims.{mapx,mapy}` |
| `.smt` magic/version/tileSize/compressionType wrong | `SMFGroundTextures.cpp:165-171` | `tile-file %d (...) does not match .smt format` |
| grass override texture wrong size | `GrassDrawer.cpp:208-213` | `grass-map has wrong size (%dx%d, should be %dx%d)` (`std::runtime_error`) |

### 11.2 Non-fatal (warning, degraded behaviour)

| Condition | Result |
|---|---|
| `.smt` file missing | that file's tiles filled with byte `0xAA` → red terrain; game continues |
| typemap missing / wrong dims | `typeMap` stays all-zero (terrain type 0); warning |
| no `MEH_Vegetation` extra header | grass drawer disables itself silently |
| `mapinfo` override texture wrong dims | warning, falls back to the embedded block |
| `smtFileNameN` count ≠ `numTileFiles` | warning, embedded names used |
| feature type name not a `FeatureDef`, nor containing `treetype`/`geovent` | error logged, instances of that type skipped |
| `numFeatures > 32000` live features | extras silently dropped by the ID pool |

### 11.3 Unchecked — your writer must get these right

* **`mapx % 128` / `mapy % 128`.** Never validated. A remainder silently truncates rendering
  and pathing patches.
* **Tile indices are not range-checked.** `tiles[tileIdx * SMALL_TILE_SIZE + mipOffset]` with
  `tileIdx >= numTiles` or `< 0` is an out-of-bounds read on a `std::vector<char>` → garbage or
  a crash. `0 <= tileIdx < numTiles` is your responsibility.
* **Pointer fields are not sanity-checked.** A bogus `heightmapPtr` past EOF yields a short read
  into an uninitialized-but-sized buffer.
* **Feature-type names > 30 chars** desync the whole feature block (§8.2).
* **`ExtraHeader.size` for non-vegetation types** must be `>= 8` and exact, or the chain walk
  corrupts (§3.3).
* **No maximum map size is enforced anywhere.** The ceiling is memory: `CReadMap::Initialize`
  computes and displays `reqMemFootPrintKB` (`ReadMap.cpp:319-335`) covering 11 derived arrays
  plus 6 heightmap mip levels. Summing that expression exactly:

  | term | bytes per heightmap square |
  |---|---:|
  | `faceNormals{Synced,Unsynced}` — `mapx*mapy*2*2*sizeof(float3)` | 48 |
  | `centerNormals{Synced,Unsynced}` — `mapx*mapy*2*sizeof(float3)` | 24 |
  | `centerHeightMap` + `maxHeightMap` — `2 * mapx*mapy*sizeof(float)` | 8 |
  | `slopeMap` + `typeMap` + `extractionMap` + `metalMap` (all `hmapx*hmapy`) | 2.5 |
  | `mipCenterHeightMaps[1..6]` — `Σ mapx*mapy*4 / 4^i` | ≈1.3 |
  | **per-square subtotal** | **≈83.8** |

  | term | bytes per heightmap **vertex** |
  |---|---:|
  | `cornerHeightMap{Synced,Unsynced}` | 8 |
  | `originalHeightMap` | 4 |
  | `VisVertexNormals` — `sizeof(float3)` | 12 |
  | **per-vertex subtotal** | **24** |

  For a square map that works out to a flat **≈108 bytes per heightmap square** (verified: the
  expression yields exactly 107.9 B/square at 512², 1024², 1536² and 2048²). Concretely:

  | human size | `mapx`=`mapy` | `reqMemFootPrintKB` |
  |---|---:|---:|
  | 8×8 | 512 | 27 MiB |
  | 16×16 | 1024 | **108 MiB** |
  | 24×24 | 1536 | **243 MiB** |
  | 32×32 | 2048 | **431 MiB** |

  (The displayed figure *understates* the real allocation: `Initialize` also resizes
  `centerNormals2D` (+12 B/square) and `mapFileHeightMap` (+4 B/vertex), which are not in the sum —
  `ReadMap.cpp:341-358`. Add ~14 %.) The largest map in the surveyed BAR corpus is **24×24**
  (`mapx = mapy = 1536`); nothing bigger ships.
* **No maximum tile count.** `tiles` is `numTiles * 680` bytes in RAM, and with `SMFTextureStreaming`
  defaulting to **false** every big square is a resident 1024² DXT1 texture with 4 mips
  (≈0.68 MiB each). At 24×24 that is `12*12 = 144` big squares ≈ **98 MiB VRAM** plus a
  `147456 * 680` ≈ **96 MiB** tile pool in RAM; at 32×32, ≈175 MiB + ≈170 MiB. No limit is coded
  anywhere — this is the real ceiling on `numBigTexX * numBigTexY`.

---

## 12. Worked example — a real map, byte by byte

`maps/RCR.smf` from `red_comet_remake_1.8.sd7` (a 12×8 map). Total file size **1 807 824** bytes.

### 12.1 Header, as read

```
magic            = "spring map file\0"
version          = 1
mapid            = 292
mapx             = 768          -> 768/64 = 12 "spring units", 768/128 = 6 big squares
mapy             = 512          -> 512/64 =  8 "spring units", 512/128 = 4 big squares
squareSize       = 8
texelPerSquare   = 8
tilesize         = 32
minHeight        = 100.0
maxHeight        = 320.0
heightmapPtr     =   24668
typeMapPtr       =  813662
tilesPtr         = 1709318
minimapPtr       =  911966
metalmapPtr      = 1611014
featurePtr       = 1807642
numExtraHeaders  = 1
```

Derived: world size `768*8 × 512*8` = **6144 × 4096 elmos**; diffuse texture
`768*8 × 512*8` = **6144 × 4096 texels**; big-square grid **6 × 4** (= 24 textures of 1024²);
tile grid `768/4 × 512/4` = **192 × 128**; `tileCount` = **24576**;
half-map grid `384 × 256`; heightmap grid `769 × 513`.

### 12.2 Block map, with the arithmetic

| Offset | Size | Computation | Block |
|---:|---:|---|---|
| 0 | 80 | `sizeof(SMFHeader)` | SMFHeader |
| 80 | 12 | `size=12, type=1, pos=92` | `ExtraHeader` (MEH_Vegetation) |
| 92 | 24 576 | `(768/4) * (512/4) = 192*128` | vegetation map (all zeros here) |
| **24 668** | 788 994 | `2 * 769 * 513` | **heightmap** ✔ `= 92 + 24576` |
| **813 662** | 98 304 | `384 * 256` | **typemap** ✔ `= 24668 + 788994` |
| **911 966** | 699 048 | `MINIMAP_SIZE` | **minimap** ✔ `= 813662 + 98304` |
| **1 611 014** | 98 304 | `384 * 256` | **metalmap** ✔ `= 911966 + 699048` |
| **1 709 318** | 20 | `8 + 4 + len("RCR.smt")+1 = 8+4+8` | **MapTileHeader + file table** ✔ `= 1611014 + 98304` |
| 1 709 338 | 98 304 | `24576 * 4` | tile-index array |
| **1 807 642** | 8 | `sizeof(MapFeatureHeader)` | **feature header** ✔ `= 1709338 + 98304` |
| 1 807 650 | 174 | 17 names, `Σ(len+1)` | feature name table |
| 1 807 824 | 0 | `numFeatures = 0` | (EOF) ✔ |

Every pointer lands exactly where the arithmetic says. This is the layout `pymapconv` emits
(`pymapconv.py:1031-1077`); note that the **minimap sits between typemap and metalmap**, which is
*not* the order the fields appear in the header.

### 12.3 Tile block contents

```
MapTileHeader: numTileFiles = 1, numTiles = 24577
  file[0]: 24577 tiles, name = "RCR.smt"
tile-index array: 24576 int32, values observed in [0, 24576] (== numTiles-1)  ✔
RCR.smt: 32 + 24577*680 = 16 712 392 bytes  ==  actual file size  ✔
  TileFileHeader = ("spring tilefile\0", version 1, numTiles 24577, tileSize 32, compressionType 1)
```

Note `numTiles (24577) > tileCount (24576)`: the tile *pool* is independent of the number of
tile *slots*; dedup happened to be near-zero on this map.

### 12.4 Data sanity

```
heightmap raw min/max = 0 / 65535
  -> per the HEADER alone:  100.0 .. 100 + 65535*(320-100)/65536 = 319.99664    (see §4.2)
typemap values        = {0: 87505, 150: 8141, 255: 2658}           (3 terrain types in use)
metalmap values       = {0: 97824, 255: 480}
  -> mapinfo maxMetal = 0.75  ->  richest square = 255 * 0.75 = 191.25 metal units
vegetation map        = all zeros (header present, grass unused)
feature types (17)    = TreeType0..TreeType15, GeoVent            (the canonical reserved prefix)
numFeatures           = 0
```

**CORRECTION — the header heights are not what the engine uses here.** `red_comet_remake_1.8`'s
`mapinfo.lua` contains

```lua
smf = {
    minheight = 100,
    maxheight = 400,
},
```

so `minHeightOverride` / `maxHeightOverride` both fire (§2.7) and the **in-game** range is
`100.0 .. 100 + 65535*(400-100)/65536 = 399.99542`, not `319.99664`. The header's `maxHeight = 320`
is never read. This is the normal case in BAR, not an oddity — see §12.6.

### 12.5 Size formulas for a writer

For a map of `mapx × mapy` heightmap squares:

```
sizeof(SMFHeader)          = 80
extra header (vegetation)  = 12
vegetation map             = mapx*mapy/16
heightmap                  = 2*(mapx+1)*(mapy+1)
typemap                    = mapx*mapy/4
minimap                    = 699048                        (constant)
metalmap                   = mapx*mapy/4
tile block                 = 8 + Σ_files(4 + len(name)+1) + 4*mapx*mapy/16
feature block              = 8 + Σ_types(len(name)+1) + 24*numFeatures
--------------------------------------------------------------------
.smt                       = 32 + numTiles*680      (numTiles <= mapx*mapy/16)
```

Worked for a 16×16 BAR-scale map (`mapx = mapy = 1024`, 8192×8192 texels, 8×8 big squares):

```
header + extra                                 92
vegetation   256*256                       65 536
heightmap    2*1025*1025                2 101 250
typemap      512*512                      262 144
minimap                                   699 048
metalmap     512*512                      262 144
tiles        8 + (4+16) + 4*65536         262 172
features     8 + 174 + 0                      182
----------------------------------------------------
.smf total                             ~3 652 568   (~3.5 MiB)
.smt worst case  32 + 65536*680        44 564 512   (~42.5 MiB, before dedup)
```

### 12.6 Corpus survey — 36 shipped BAR maps

Because several claims in §2–§9 are about *convention* rather than *format*, the 2026-09-13 audit
parsed the `.smf` header, extra-header chain, tile block and feature block of **36 `.smf` files from
36 shipped Beyond-All-Reason map archives**, plus the `mapinfo.lua` of **46** archives. Method: the
`.sd7` (7-Zip) archives were opened with `py7zr`, the `.smf` extracted, and the structures decoded
with `struct.unpack_from` using exactly the offsets in §2, §3, §8 and §9. Every file parsed cleanly
with those offsets — which is itself the strongest available confirmation that §2.1's offset table
is right.

#### 12.6.1 Invariants — true in **36/36**

| property | observed |
|---|---|
| `magic` | `"spring map file\0"` (all 16 bytes identical) |
| `version` | `1` |
| `squareSize`, `texelPerSquare`, `tilesize` | `8`, `8`, `32` |
| `mapx % 128`, `mapy % 128` | `0`, `0` |
| `numExtraHeaders` | **`1`** |
| extra-header tuple | **`(size=12, type=1)`** — `MEH_Vegetation`, always |
| `numTileFiles` | **`1`** |
| block order (by pointer) | **heightmap → typemap → minimap → metalmap → tiles → features** |
| first 17 feature-type names | `TreeType0`..`TreeType15`, `GeoVent` |

**This settles the format's two biggest open risks for a writer:**

1. **No shipped map uses `numExtraHeaders > 1`, and no extra-header type other than
   `MEH_Vegetation` exists in the wild.** The `Read(data, size - 8)` skip path in `ReadGrassMap`
   (`SMFMapFile.cpp:266`) is therefore never exercised by real content. Its buffer-overrun hazard is
   real but unreachable in practice. A writer should emit exactly one `{12, 1, offset}` entry.
2. **The `size = 4` bug in `BlankMapGenerator` (§3.3) is not mirrored by any shipped map** — all 36
   write `12`, matching `pymapconv.py:1049`.

Block order being uniform across 36/36 also means: although the format permits any order (§1), every
real decompiler has only ever been *tested* against the `pymapconv` order. Follow it.

#### 12.6.2 Ranges

| quantity | min | max | note |
|---|---:|---:|---|
| `mapx` / `mapy` | 512 | 1536 | i.e. 8×8 to 24×24 in human units |
| `mapid` | 58 | 950 | consistent with `pymapconv`'s `random.randint(0, 31**2)` (§2.4) |
| `numFeatureType` | 17 | 37 | always the 17 reserved names first |
| `numFeatures` | 0 | 892 | 22/36 maps ship **0** instances |
| longest feature-type name | — | **19** chars | comfortably inside the 30-char limit of §8.2 |
| `numTiles / tileCount` | 51.6 % | 100.0 % | 33/36 are at 100 % — see §9.5 |
| `mapinfo.lua` `maxMetal` | 0.37 | 10.0 | median 1.175, quartiles 0.9 / 1.8 (46 archives) |

#### 12.6.3 `mapinfo.lua` override usage (46 archives, comment lines stripped)

| `smf.<key>` | archives using it |
|---|---:|
| `minheight` + `maxheight` | **45 / 46** (29 of them differ from the `.smf` header) |
| `smtFileName0` | 37 / 46 (each names the same `.smt` the tile block already names) |
| `typemapTex` | 1 / 46 |
| `metalmapTex` | 1 / 46 |
| `minimapTex` | **0 / 46** |
| `grassmapTex` | **0 / 46** |

Consequences already folded into §2.7, §6.4 and §7.1: the header's height range is usually
overridden, and the embedded minimap, typemap, metalmap and vegetation blocks are essentially always
the ones the engine actually uses.

#### 12.6.4 Full table

| map archive | `mapx`×`mapy` | human | `numTiles` / `tileCount` | `numFeatureType` | `numFeatures` | header `minHeight`..`maxHeight` |
|---|---:|---:|---:|---:|---:|---:|
| `ascendancy_v2.2` | 1536×1536 | 24×24 | 147456 / 147456 | 18 | 3 | -200 .. 1500 |
| `flats_and_forests_v2.2` | 1536×1536 | 24×24 | 147456 / 147456 | 18 | 2 | 150 .. 550 |
| `hellas_basin_v1.4` | 1536×1536 | 24×24 | 147456 / 147456 | 18 | 7 | -50 .. 100 |
| `raptor_crater_v2` | 1536×1536 | 24×24 | 147456 / 147456 | 17 | 0 | 100 .. 1100 |
| `riverrun_v1` | 1536×1536 | 24×24 | 147456 / 147456 | 17 | 8 | -15 .. 985 |
| `cells_1.2` | 1280×1280 | 20×20 | 102400 / 102400 | 17 | 0 | -0 .. 1280 |
| `kolmogorov_remake_3.0.1` | 1280×1280 | 20×20 | 102400 / 102400 | 17 | 0 | -50 .. 100 |
| `pentos_v1` | 1280×1280 | 20×20 | 102400 / 102400 | 37 | 892 | -150 .. 850 |
| `sand_crowns_1.0` | 1280×1280 | 20×20 | 102400 / 102400 | 17 | 0 | -50 .. 100 |
| `moonshine_run_v1.0.1` | 1536×1024 | 24×16 | 98304 / 98304 | 17 | 0 | -50 .. 100 |
| `point_of_no_return_v1.0.1` | 1024×1536 | 16×24 | 98304 / 98304 | 18 | 14 | -100 .. 500 |
| `cloud9_v2` | 1152×1152 | 18×18 | **49354 / 82944** | 17 | 0 | -220 .. 780 |
| `mariposa_island_v2.4.1` | 1152×1152 | 18×18 | 82944 / 82944 | 17 | 0 | **970 .. -230** (inverted) |
| `red_triangle_remake_v1.3` | 1152×1152 | 18×18 | 82944 / 82944 | 18 | 1 | -50 .. 100 |
| `azurite_shores_1.0.2` | 1152×1024 | 18×16 | 73728 / 73728 | 17 | 0 | -150 .. 605 |
| `angel_crossing_1.5.1` | 1024×1024 | 16×16 | 65536 / 65536 | 17 | 8 | -150 .. 850 |
| `archsimkats_valley_v1` | 1024×1024 | 16×16 | 65536 / 65536 | 17 | 4 | -370 .. 630 |
| `emainmacha_remake_2.1.1` | 1024×1024 | 16×16 | 65536 / 65536 | 17 | 0 | -50 .. 100 |
| `onyx_cauldron_2.2.2` | 1024×1024 | 16×16 | 65536 / 65536 | 17 | 0 | -100 .. 1180 |
| `all_that_glitters_v2.2.3` | 768×1280 | 12×20 | 61440 / 61440 | 18 | 2 | -50 .. 100 |
| `all_that_smolders_v1.2` | 768×1280 | 12×20 | 61440 / 61440 | 17 | 0 | 100 .. 800 |
| `gasbag_grabens_1.1.1` | 1152×768 | 18×12 | 55296 / 55296 | 17 | 0 | -130 .. 770 |
| `boreal_falls_1.0.2` | 896×896 | 14×14 | 50136 / 50176 | 18 | 2 | 100 .. 1100 |
| `comet_catcher_remake_1.8` | 1024×768 | 16×12 | **49153 / 49152** | 17 | 0 | -50 .. 100 |
| `death_valley_v1.0.1` | 768×896 | 12×14 | 43008 / 43008 | 17 | 0 | -50 .. 100 |
| `eye_of_horus_1.7.1` | 768×896 | 12×14 | 43008 / 43008 | 17 | 0 | -50 .. 100 |
| `acidicquarry_5.17` | 768×768 | 12×12 | 36864 / 36864 | 17 | 0 | -50 .. 100 |
| `asteroid_mines_v3` | 768×768 | 12×12 | **19006 / 36864** | 17 | 0 | -50 .. 100 |
| `gods_of_war_remake_v1.3` | 768×768 | 12×12 | 36864 / 36864 | 17 | 0 | -50 .. 100 |
| `into_battle_redux_v3.0.1` | 768×768 | 12×12 | 36864 / 36864 | 17 | 0 | 50 .. 200 |
| `ditched_v1` | 1024×512 | 16×8 | 32768 / 32768 | 17 | 4 | -50 .. 100 |
| `crater_islands_remake_v1.0.1` | 768×640 | 12×10 | 30720 / 30720 | 17 | 0 | -100 .. 400 |
| `altair` | 512×512 | 8×8 | 16384 / 16384 | 18 | 2 | -50 .. 100 |
| `altair_crossing_v4.1` | 512×512 | 8×8 | 16384 / 16384 | 18 | 2 | -50 .. 100 |
| `avalanche_3.4` | 512×512 | 8×8 | 16380 / 16384 | 17 | 0 | -50 .. 100 |
| `hotstepper_5_1.2.1` | 512×512 | 8×8 | 16384 / 16384 | 17 | 0 | -50 .. 100 |

(`red_comet_remake_1.8` / `RCR.smf`, the §12 worked example, is a 37th file and fits every invariant
above.)

---

## 13. Implementation checklist / gotcha digest

**Reading**
1. Read 80 bytes; validate magic (`strcmp` semantics: NUL at byte 15), `version==1`,
   `squareSize==8`, `texelPerSquare==8`, `tilesize==32`.
2. Derive `mapxp1`, `hmapx`, `tileMapSizeX = mapx/4`, `tileCount = mapx*mapy/16`,
   `numBigTexX = mapx/128`. Warn if `mapx % 128 != 0`.
3. Heightmap at `heightmapPtr`: `(mapx+1)*(mapy+1)` LE `uint16`;
   `y = minHeight + raw*(maxHeight-minHeight)/65536`.
4. Typemap at `typeMapPtr`: `mapx/2 * mapy/2` bytes, terrain-type indices 0..255.
5. Metalmap at `metalmapPtr`: `mapx/2 * mapy/2` bytes; `amount = byte * mapinfo.maxMetal`.
6. Minimap at `minimapPtr`: exactly 699048 bytes, DXT1, 9 mips from 1024² down to 4².
7. Tiles at `tilesPtr`: header, then `numTileFiles × (int32 + NUL-string)`, then **immediately**
   `mapx*mapy/16` LE `int32` indices. No seek between the name table and the index array.
8. Features at `featurePtr`: header, then `numFeatureType` NUL-strings **(≤ 30 chars each)**,
   then `numFeatures × 24` bytes. `ypos` and `relativeSize` are ignored by the engine.
9. Grass: walk the extra-header chain from offset 80; `type == 1` → read the following `int32`
   as an absolute offset to a `mapx/4 * mapy/4` byte array.

**Writing**
1. Emit `magic = "spring map file\0"`, `version = 1`, `squareSize = 8`, `texelPerSquare = 8`,
   `tilesize = 32`.
2. Make `mapx`, `mapy` multiples of **128**.
3. Emit `numExtraHeaders = 1` with `{size=12, type=1, vegmapOffset}` even for grass-less maps
   (write zeros) — that is what every real map does; `size` **must** be 12, not 4.
4. Keep feature-type names ≤ 30 chars; lead the table with the 17 reserved
   `TreeType0..15` + `GeoVent` entries if you want tooling compatibility.
5. Zero-fill `ypos`, write `relativeSize = 1.0`, write `rotation` in 65536-per-turn units.
6. Never emit a tile index `>= numTiles`.
7. Emit the minimap as a real 9-level DXT1 chain (1024² → 4²) totalling 699048 bytes — pad/truncate
   to exactly that, and do **not** include the 2×2/1×1 mips. This block is **not optional in
   practice**: 0 of 46 shipped BAR maps override it with `smf.minimapTex` (§12.6.3).
8. Block order is free *per the format*, but write header → extra header → vegmap → heightmap →
   typemap → minimap → metalmap → tiles → features — the `pymapconv` order, and the order used by
   **36 / 36** shipped BAR maps (§12.6.1). Third-party decompilers have only ever been tested
   against it.
9. Also emit a `mapinfo.lua`. The engine takes `maxMetal` (metalmap scale, §7.1) and `terrainTypes`
   (typemap semantics, §5.1) from there and from nowhere else, and — because 45/46 real maps do it —
   consumers may expect `smf = { minheight = ..., maxheight = ... }` to carry the authoritative
   height range (§2.7). Keep the header values and the `mapinfo.lua` values consistent unless you
   deliberately want the override.

---

## 14. References

Engine (all at commit `8f47fd283985eff93f4949060929d6290b71ddef`, branch `master`):

* `rts/Map/SMF/SMFFormat.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFFormat.h — L27-34 (size constants), L49-70 (`SMFHeader`), L83-103 (`ExtraHeader`, `MEH_*`), L107-127 (`MapTileHeader` + contract), L129-157 (`MapFeatureHeader`, `MapFeatureStruct`), L160-182 (`TileFileHeader`)
* `rts/Map/SMF/SMFMapFile.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFMapFile.cpp — L16-28 (`CheckHeader`), L31-55 (`Open`), L70-93 (minimap), L97-135 (heightmap), L138-182 (features), L193-236 (`GetInfoMapSize` / `ReadInfoMap`), L239-270 (`ReadGrassMap`), L273-348 (endian-aware primitive readers, all struct readers)
* `rts/Map/SMF/SMFMapFile.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFMapFile.h — L62 (`char featureTypes[16384][32]`)
* `rts/Map/SMF/SMFReadMap.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFReadMap.cpp — L113-130 (`ParseHeader`), L133-158 (`LoadHeightMap`, min/max override), L161-190 (`LoadMinimap`), L917-966 (`GetInfoMap`)
* `rts/Map/SMF/SMFReadMap.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFReadMap.h — L181-182 (`tileScale`, `bigSquareSize`)
* `rts/Map/SMF/SMFGroundTextures.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFGroundTextures.cpp — L92-195 (`LoadTiles`), L290-320 (ETC transcode), L505-544 (`ExtractSquareTiles`)
* `rts/Map/SMF/SMFGroundDrawer.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFGroundDrawer.cpp — L430-441 (`SetupBigSquare`)
* `rts/Map/ReadMap.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/ReadMap.cpp — L140-180 (`LoadMap`, metal/type wiring), L303-419 (`Initialize`, derived-array sizes)
* `rts/Map/ReadMap.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/ReadMap.h — L26-41 (`MapFeatureInfo`, `MapBitmapInfo`), L248 (`numHeightMipMaps`), L337-341 (heightmap indexing)
* `rts/Map/MapDimensions.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/MapDimensions.h — L34-51
* `rts/Map/MetalMap.{h,cpp}` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/MetalMap.cpp — L29-52 (`Init`), L76-83 (`GetMetalAmount`), L86-95 (`SetMetalAmount`)
* `rts/Map/MapInfo.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/MapInfo.cpp — L106/115 (`maxMetal`), L404-428 (`smf` overrides), L432-459 (`terrainTypes`)
* `rts/Map/Generation/BlankMapGenerator.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/Generation/BlankMapGenerator.cpp — L134-232 (`GenerateSMF`), L295-332 (`GenerateSMT`)
* `rts/Sim/Features/FeatureDefHandler.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Sim/Features/FeatureDefHandler.cpp — L160-205 (default tree/geo defs), L227-259 (`LoadFeatureDefsFromMap`)
* `rts/Sim/Features/FeatureHandler.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Sim/Features/FeatureHandler.cpp — L37-44 (`MAX_FEATURES` pool), L64-105 (`LoadFeaturesFromMap`)
* `rts/Rendering/Env/GrassDrawer.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Rendering/Env/GrassDrawer.cpp — L50-52 (grass constants), L180-230 (grass-map load)
* `rts/System/Platform/byteorder.h` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/System/Platform/byteorder.h
* `rts/System/FileSystem/FileHandler.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/System/FileSystem/FileHandler.cpp — L195-211 (`ReadString`)
* `tools/unitsync/unitsync.cpp` — https://github.com/beyond-all-reason/RecoilEngine/blob/master/tools/unitsync/unitsync.cpp — L587-670 (`internal_GetMapInfo`), L905-1018 (`GetMinimap`, `GetInfoMapSize`)

Third-party writers / decompilers consulted (cross-checks, not normative):

* **`Beherith/springrts_smf_compiler` (PyMapConv)** — https://github.com/Beherith/springrts_smf_compiler — commit `77a5f33e3bd1fe98e488adc971183f35934da73f` (2024-10-30), `src/pymapconv.py` (1601 lines): L38-88 (struct definitions), L441-447 (map-size derivation), L515/L519 (minimap DXT1 9-mip invocation), L640 (heightmap clamp), L690-700 (metalmap red-channel import), L734-736 (reserved feature-type list), L790-814 (feature-map channel encoding), L975-1004 (tile dedup + index layout), L1013-1079 (the SMF/SMT writer)
  *(The URL `github.com/Beherith/Spring_SMF_compiler` given in earlier drafts of this document 404s; `springrts_smf_compiler` is the real repository, and it is the one RecoilEngine's own docs link to — `doc/site/content/docs/guides/tools.md`.)*
* `spring/spring` `master` — https://github.com/spring/spring/blob/master/rts/Map/SMF/SMFFormat.h — used for the 105-vs-Recoil diff in §10

Empirical validation subjects:

* `red_comet_remake_1.8.sd7`, springfiles fid 2632 —
  https://springfiles.springrts.com/files/maps/red_comet_remake_1.8.sd7 — 36 616 210 bytes;
  `maps/RCR.smf` 1 807 824 B, `maps/RCR.smt` 16 712 392 B. Fully decoded in §12.
* A corpus of **36 further shipped Beyond-All-Reason map archives** (`.sd7`), whose `.smf` headers,
  extra-header chains, tile blocks and feature blocks, plus **46** `mapinfo.lua` files, were parsed
  independently. Per-map results in §12.6.4.

---

## 15. Verification log (adversarial audit, 2026-09-13)

**Method.** RecoilEngine was cloned fresh (`master` HEAD `70ed4600e3ec113004beb407a79fc4295d5cfd33`)
and every claim below was read out of the working tree, not from memory; the document's cited commit
`8f47fd28` was fetched separately and `git diff` against HEAD is empty for all SMF-related files, so
the two are interchangeable. `red_comet_remake_1.8.sd7` was re-downloaded from springfiles
(36 616 210 bytes) and decoded with an independent Python `struct` reader. 36 further BAR map
archives and 46 `mapinfo.lua` files were parsed the same way (§12.6). PyMapConv was cloned at
`77a5f33e3bd1fe98e488adc971183f35934da73f`.

### 15.1 Claims checked

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 1 | `SMFHeader` field order / offsets / 80-byte size (§2.1) | `SMFFormat.h:49-70`; field-by-field reader `SMFMapFile.cpp:293-313`; decoded 37 real `.smf` files | **confirmed** |
| 2 | `CheckHeader` validates version/tilesize/texelPerSquare/squareSize/magic and nothing else | `SMFMapFile.cpp:16-28` (exact five checks, in that order) | **confirmed** |
| 3 | Magic is `strcmp`-compared, so byte 15 must be `0x00` | `SMFMapFile.cpp:27`; writer `BlankMapGenerator.cpp:142` | **confirmed** |
| 4 | `mapid` is parsed and never used | `grep -rn mapid rts tools/unitsync` → only `SMFMapFile.cpp:298`, `SMFFormat.h:52`, `BlankMapGenerator.cpp:144` | **confirmed** |
| 5 | `mapid` in the wild is `pymapconv`'s `random.randint(0, 31**2)` | `pymapconv.py:1026`; corpus `mapid` ∈ [58, 950] | **confirmed** |
| 6 | Derived dims: `tileScale=4`, `bigSquareSize=128`, `tileCount = mapx*mapy/16` | `SMFReadMap.h:181-182`; `SMFReadMap.cpp:113-130`; `MapDimensions.h:34-51`; `GlobalConstants.h:24` | **confirmed** |
| 7 | `mapx % 128` is never validated; `PATCH_SIZE = 128` in both mesh drawers; mips need `% 64` | `Patch.h:23`, `RoamMeshDrawer.cpp:58-59`, `BasicMeshDrawer.cpp:23-24` / `.h:28`; `ReadMap.h:248` (`numHeightMipMaps = 7`), `ReadMap.cpp:365-370` | **confirmed** |
| 8 | Height decode divisor is **65536**, not 65535 | `SMFReadMap.cpp:157` passes `(maxHgt-minHgt)/65536.0f`; `SMFMapFile.cpp:132` | **confirmed** |
| 9 | `minHeight`/`maxHeight` overridable from `mapinfo.lua` | `SMFReadMap.cpp:146-147`; `MapInfo.cpp:406-410` | **confirmed**, and materially **extended** — key lookup is case-insensitive (`LuaParser.cpp:59-60,83-84,1001`) and 45/46 real maps override, 29 with different values (§2.7) |
| 10 | RCR decodes to a max world height of `319.99664` | header says so, but `red_comet_remake_1.8/mapinfo.lua` sets `maxheight = 400` | **corrected** — in-game max is `399.99542` (§12.4) |
| 11 | `ExtraHeader` = `{int size; int type;}`, `MEH_None=0`, `MEH_Vegetation=1`; `size` includes the 8-byte prefix | `SMFFormat.h:83-103`; `ReadGrassMap` `SMFMapFile.cpp:239-270` | **confirmed** |
| 12 | `BlankMapGenerator` writes `ExtraHeader.size = 4` while writing 12 bytes | `BlankMapGenerator.cpp:161` (`sizeof(int)`), `:218-219` | **confirmed** |
| 13 | `pymapconv` writes `size = 12`; `vegmapOffset = 92` | `pymapconv.py:1032,1049`; `BlankMapGenerator.cpp:179` | **confirmed** |
| 14 | Vegetation map is `uint8[(mapx/4)*(mapy/4)]`, any non-zero = grass | `SMFMapFile.cpp:259`; `GetInfoMapSize` `SMFMapFile.cpp:198`; `GrassDrawer.cpp:50,129` | **confirmed** |
| 15 | `pymapconv` writes `min(254, blue)` at line 812 | actually `pymapconv.py:794`, and only for odd `(col,row)` | **corrected** (line number + the half-res detail) |
| 16 | Heightmap is `uint16[(mapx+1)*(mapy+1)]`, row-major X-fastest | `SMFMapFile.cpp:97-110,113-135`; `ReadMap.h:337` | **confirmed** |
| 17 | Typemap / metalmap are `uint8[(mapx/2)*(mapy/2)]` | `SMFMapFile.cpp:199-200,219-229` | **confirmed** |
| 18 | Missing/wrong-size typemap degrades to type 0 + warning | `ReadMap.cpp:172-178`, `:375-377` | **confirmed** |
| 19 | `metalAmount = byte * mapinfo.maxMetal` | `ReadMap.cpp:162-167`; `MetalMap.cpp:29-52,76-83`; `MapInfo.cpp:106,115` | **confirmed** |
| 20 | Real-world `maxMetal` is `0.5`–`1.30` | 46 `mapinfo.lua` files | **corrected** — range is `0.37`–`10.0`, median `1.175` (§7.1) |
| 21 | Minimap = 699048 bytes, DXT1, 9 mips, 1024²→4² | `SMFFormat.h:31-34`; `SMFMapFile.cpp:70-93`; `SMFReadMap.cpp:178-189`; mip sum recomputed = 699048 | **confirmed** |
| 22 | unitsync restricts `mipLevel` to 0..8 | `tools/unitsync/unitsync.cpp:970-971` | **confirmed** |
| 23 | "Modern BAR maps set `smf.minimapTex`, so the embedded block is often dead weight" | 46 `mapinfo.lua` files, comments stripped | **corrected — this is false.** 0/46 set it; the embedded block is load-bearing (§6.4) |
| 24 | Feature block layout: 8-byte header, `numFeatureType` NUL-strings, then 24-byte structs | `SMFFormat.h:135-157`; `SMFMapFile.cpp:138-182,316-331` | **confirmed** |
| 25 | Max 16384 feature types; max **30** chars + NUL per name | `SMFMapFile.h:62`; `SMFMapFile.cpp:144-162` (`K-1 = 31` read attempts) | **confirmed**; longest name in 36 real maps is 19 chars |
| 26 | The excess-feature-type error text | actual format string prints `numFeatureType - N`, not the literal "N" | **corrected** (§8.2) |
| 27 | `ypos` and `relativeSize` are discarded; `rotation` C-cast to `short`; facing always `FACING_SOUTH` | `FeatureHandler.cpp:64-104` | **confirmed** |
| 28 | `SPRING_CIRCLE_DIVS = 65536`, `TAANG2RAD = PI/32768` | `SpringMath.h:16-17` (`SPRING_MAX_HEADING = 32768`); `CobInstance.h:21,25` | **confirmed** |
| 29 | `treetype` / `geovent` are *substring* matches; `drawType = DRAWTYPE_TREE + atoi(name.substr(8))`; a geovent def is always injected | `FeatureDefHandler.cpp:160-205,227-259`; `GetFeatureDef` lowercases (`:208-224`) | **confirmed** |
| 30 | `MAX_FEATURES = 32000` | `GlobalConstants.h:115`; `FeatureHandler.cpp:37-45` | **confirmed** |
| 31 | 17 reserved feature-type names is a tooling convention | `pymapconv.py:734-736`; **36/36** real maps start with exactly those 17 | **confirmed** |
| 32 | Tile block: header, then `numTileFiles × (int32 + NUL-string)`, then the index array **with no seek** | `SMFGroundTextures.cpp:92-195` (`ifs->Read(&tileMap[0], ...)` at `:178`, no `Seek`) | **confirmed** |
| 33 | `ReadString` allows names up to 255 chars and reseeks to `pos+strlen+1` | `FileHandler.cpp:195-211`; called with 255 at `SMFGroundTextures.cpp:137` | **confirmed** |
| 34 | `tileMap` sized from `tileCount`, not `numTiles` | `SMFGroundTextures.cpp:116-117` | **confirmed** |
| 35 | Tile index arithmetic `tileMap[tileY * tileMapSizeX + tileX]` | `SMFGroundTextures.cpp:505-544`; `pymapconv.py:996` | **confirmed** |
| 36 | `SMALL_TILE_SIZE = 680`, 4 mips at offsets `{0,512,640,672}`; `.smt` = `32 + numTiles*680` | `SMFFormat.h:27-28`; `SMFGroundTextures.cpp:515`; measured `RCR.smt` = 16 712 392 = `32 + 24577*680` | **confirmed** |
| 37 | `.smt` header is 32 bytes, magic `"spring tilefile\0"`, checks version/tileSize/compressionType | `SMFFormat.h:175-183`; `SMFMapFile.cpp:341-348`; `SMFGroundTextures.cpp:165-171`; decoded `RCR.smt` | **confirmed** |
| 38 | "`tilesize` is cross-checked against the `.smt`" | `SMFGroundTextures.cpp:165` compares to the **literal** 32 | **corrected** (§2.6) |
| 39 | "Tiles are deduplicated, so `numTiles` is usually far below `tileCount`" | 36-map corpus | **corrected — usually false.** 33/36 sit at 100 %; two exceed `tileCount` (§9.5) |
| 40 | Recoil vs Spring 105: zero format divergence, three comment typo fixes + `#define`→`constexpr` | `diff spring/spring master SMFFormat.h` vs Recoil: exactly `refered→referred`, `compresed→compressed`, `followes→follows`, and the constant declarations | **confirmed, exactly as described** |
| 41 | `SMFTextureStreaming` defaults to `false` | `SMFGroundTextures.cpp:46-47` (`.defaultValue(false).safemodeValue(true)`) | **confirmed** |
| 42 | `Spring.GetGroundInfo` return list | `LuaSyncedRead.cpp:7886-7923` — 11 values, in the order given | **confirmed** |
| 43 | Engine RAM ≈ `mapx*mapy*196` B; 16×16 ≈ 210 MB; 32×32 ≈ 800 MB | `ReadMap.cpp:319-335` summed term-by-term | **corrected** — ≈108 B/square; 16×16 ≈ **108 MiB**, 32×32 ≈ **431 MiB** (§11.3) |
| 44 | PyMapConv lives at `github.com/Beherith/Spring_SMF_compiler` | that URL returns **404** | **corrected** — it is `github.com/Beherith/springrts_smf_compiler` |
| 45 | The whole of §12 (RCR worked example) | re-downloaded and re-decoded the archive | **confirmed byte-for-byte** — header fields, all six pointers, the `(12,1,92)` extra header, heightmap min/max `0/65535`, typemap `{0:87505,150:8141,255:2658}`, metalmap `{0:97824,255:480}`, all-zero vegmap, `numTileFiles=1 numTiles=24577 name="RCR.smt"`, index array `[0,24576]` ending at 1 807 642, 17 feature names ending at 1 807 824 = file size, `.smt` = 16 712 392 B |

### 15.2 Resolution of the researcher's open questions

1. **Does any shipped map use `numExtraHeaders > 1` or a non-`MEH_Vegetation` type?**
   **Resolved — no.** All 36 surveyed BAR maps (plus RCR) have `numExtraHeaders == 1` with exactly
   `(size = 12, type = 1)`. The `Read(data, size - 8)` skip path is dead code against real content.
   *Caveat:* the corpus is BAR-only; classic Spring/Zero-K maps were not surveyed, so this is
   "unobserved in 37 BAR maps", not a proof about every `.smf` ever written.

2. **Practical upper bound on map size.** **Resolved for BAR.** No engine check exists; the largest
   shipped BAR map is **24×24** (`mapx = mapy = 1536`). The engine's own displayed estimate is
   **≈108 bytes per heightmap square** (exact term-by-term derivation in §11.3, not the ~196 B
   previously stated) → ≈243 MiB at 24×24, ≈431 MiB at 32×32, before textures. Add ≈98 MiB VRAM of
   resident big-square textures and ≈96 MiB of tile pool at 24×24.

3. **Do BAR tools impose stricter limits than the engine?** **Partially resolved.** PyMapConv
   (the only writer besides `BlankMapGenerator` that could be inspected) is stricter in two ways: it
   requires the source texture to be a multiple of **1024** texels on each axis (`pymapconv.py:446`,
   so `mapx % 128 == 0` is structural) and it hard-codes the 17 reserved feature-type names
   (`:734-736`). It imposes no tile-count or name-length limit of its own.
   **UNVERIFIED — needs confirmation:** SpringBoard-Core's writer was **not** inspected in this
   audit, and `maps-metadata` was not checked for validation rules. Treat any claim about their
   limits as unknown.

4. **Does `SMFTextureStreaming = false` cap `numBigTexX * numBigTexY`?** **Resolved — no coded cap.**
   Confirmed `.defaultValue(false)` at `SMFGroundTextures.cpp:46`. The cost is
   `numBigTexX * numBigTexY * ~0.68 MiB` of resident DXT1 (1024² + 3 mips), i.e. ≈98 MiB at the
   largest shipped size. Nothing in the engine refuses a larger value; it is a VRAM budget, not a
   limit. **UNVERIFIED — needs confirmation:** no measurement on real hardware was performed.

5. **Semantics of vegetation values > 1.** **Resolved — unimplemented, not reserved.**
   `SMFFormat.h:101` says "rest undefined so far"; `GrassDrawer` only ever tests non-zero
   (`:129`, `:480`, `:1052`) and `SetGrass`/`GetGrass` (`:1014-1052`) pass the byte through without
   interpreting it; `pymapconv` writes `min(254, blue)` (`:794`). There is no density decoding
   anywhere in the engine. A writer should emit only `0` or `1`.

### 15.3 Residual unverified items

These are marked here rather than left as bare assertions elsewhere in the document:

* **UNVERIFIED — needs confirmation:** the claim (§6.2) that `nvdxt`/`CompressonatorCLI` with
  9 mip levels emit *exactly* the 699048-byte layout. The `pymapconv` invocations
  (`:515`, `:519`) were read, but neither tool was run; the byte count was only verified from the
  engine side and from real map files.
* **UNVERIFIED — needs confirmation:** `maxMetal` values for `Quicksilver` and `Enceladus`, cited in
  an earlier draft of §7.1. Those maps were not in the surveyed corpus; the figures have been
  replaced with measured ones.
* **UNVERIFIED — needs confirmation:** behaviour of non-BAR (classic Spring, Zero-K) `.smf` content;
  the empirical corpus is entirely Beyond-All-Reason.
* **UNVERIFIED — needs confirmation:** SpringBoard-Core's SMF writer and any limits it imposes
  (open question 3 above).
* **UNVERIFIED — needs confirmation:** the §10.2 remark that the ETC1/ETC2 tile transcode is "also
  present in late 105 branches". Recoil's `RecompressTilesIfNeeded`
  (`SMFGroundTextures.cpp:292`) was read; `spring/spring` was diffed only for `SMFFormat.h`, which
  is where the format-divergence claim (§10.1) comes from and which **is** confirmed.
