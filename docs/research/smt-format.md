# SMT Tile File Format & Texture Pipeline

Complete specification of the Spring Map Tiles (`.smt`) format and the map diffuse-texture
pipeline, as implemented by the **Recoil engine** (Beyond All Reason) and the **pymapconv**
compiler.

All byte layouts, constants and formulas below are quoted from source. Citations are inline as
`[REF:line]` or `[REF:first-last]`, where `REF` indexes the table below. Every claim was
independently re-verified against a primary source on 2026-09-13 — see the **Verification log** at
the end, which records what was confirmed, what was corrected, and what remains unverified.

**Primary sources**

| Ref | Location |
|---|---|
| `[FMT]` | [`rts/Map/SMF/SMFFormat.h`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFFormat.h) |
| `[GT]` | [`rts/Map/SMF/SMFGroundTextures.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFGroundTextures.cpp) |
| `[RM]` | [`rts/Map/SMF/SMFReadMap.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFReadMap.cpp) / `.h` |
| `[MF]` | [`rts/Map/SMF/SMFMapFile.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFMapFile.cpp) |
| `[GC]` | [`rts/Sim/Misc/GlobalConstants.h`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Sim/Misc/GlobalConstants.h) |
| `[FS]` | [`cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl) |
| `[RS]` | [`rts/Map/SMF/SMFRenderState.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/SMF/SMFRenderState.cpp) |
| `[MI]` | [`rts/Map/MapInfo.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/Map/MapInfo.cpp) |
| `[SQ]` | [`rts/lib/squish/colourblock.cpp`](https://github.com/beyond-all-reason/RecoilEngine/blob/master/rts/lib/squish/colourblock.cpp) — the DXT1 decoder **vendored inside the engine** |
| `[S3TC]` | [`EXT_texture_compression_s3tc.txt`](https://raw.githubusercontent.com/KhronosGroup/OpenGL-Registry/main/extensions/EXT/EXT_texture_compression_s3tc.txt) (Khronos OpenGL Registry) |
| `[PMC]` | [`src/pymapconv.py`](https://github.com/Beherith/springrts_smf_compiler/blob/master/src/pymapconv.py) — note the repo is **`Beherith/springrts_smf_compiler`**, not `Spring_SMF_compiler` (that URL 404s; verified HTTP 404 vs 200) |

> **Line numbers** below were re-checked against `master` as fetched on 2026-09-13. Files move; if a
> citation drifts, grep for the quoted code rather than trusting the number.

---

## 0. Executive summary / cheat sheet

```
.smt file = TileFileHeader (32 bytes) followed by numTiles * 680 bytes of raw tile payload.
            No padding, no index, no offset table, no per-tile header. Purely sequential.

1 tile    = 32x32 texels, DXT1, with a 4-level mip chain (32,16,8,4), packed back to back.
            512 + 128 + 32 + 8 = 680 bytes = SMALL_TILE_SIZE.

1 tile    covers 4x4 map squares = 32x32 elmos  =>  the diffuse texture is exactly
            1 texel per elmo (world unit).

Diffuse texture dimensions = (mapx * 8) x (mapy * 8) texels.
Tile index grid            = (mapx / 4) x (mapy / 4) int32 entries, stored in the .smf.
```

Everything is **little-endian on disk**. The engine byte-swaps on big-endian hosts via
`swabDWordInPlace` / `ReadInt` `[GT:138, MF:334-348]`.

**Three things a first-time writer usually gets wrong:**

1. `numTiles` is **not** `mapx*mapy/16`. Shipped maps exist with more *and* with fewer (§5). Emit
   what you actually wrote, and make `TileFileHeader.numTiles`, `MapTileHeader.numTiles` and the
   per-file count all agree.
2. Tile mips are cut out of the **parent 1024x1024 chunk's** mip chain, not generated per tile (§2).
3. Always order endpoints `color0 > color1`. Index 3 with `color0 <= color1` is transparent **black**,
   not a fourth color (§3).

Empirically calibrated against 10 shipped Beyond All Reason maps, md5-verified against the official
BAR file index and parsed byte-for-byte (§5, Appendix D).

---

## 1. `TileFileHeader` — exact byte layout

Declared at `[FMT:175-183]`:

```c
struct TileFileHeader
{
    char magic[16];      ///< "spring tilefile\0"
    int  version;        ///< Must be 1 for now
    int  numTiles;       ///< Total number of tiles in this file
    int  tileSize;       ///< Must be 32 for now
    int  compressionType;///< Must be 1 (= dxt1) for now
};
```

The reader `CSMFMapFile::ReadMapTileFileHeader` `[MF:341-348]` reads the fields **individually**
(`file.Read(&head.magic, sizeof(head.magic))` then four `ReadInt`),
so there is no struct padding ambiguity — the on-disk layout is exactly:

| Offset | Size | Type | Field | Required value |
|---:|---:|---|---|---|
| `0x00` | 16 | `char[16]` | `magic` | ASCII `spring tilefile` + `0x00` (exactly 16 bytes, no slack) |
| `0x10` | 4 | `int32 LE` | `version` | `1` |
| `0x14` | 4 | `int32 LE` | `numTiles` | number of tiles stored in *this* file |
| `0x18` | 4 | `int32 LE` | `tileSize` | `32` |
| `0x1C` | 4 | `int32 LE` | `compressionType` | `1` (= DXT1) |
| `0x20` | — | — | **end of header; tile payload starts here** | |

**Header size = 32 bytes.** pymapconv encodes it as `struct.Struct('< 16s i i i i')` `[PMC:79]`,
whose `.size` is 32, and writes it with
`TileFileHeader_struct.pack('spring tilefile\0'.encode(), 1, len(tilehash), 32, 1)` `[PMC:1013]`.

### Validation performed by the engine

`[GT:165]`:

```cpp
if (strcmp(tfh.magic, "spring tilefile") != 0 || tfh.version != 1 ||
    tfh.tileSize != 32 || tfh.compressionType != 1) {
    throw content_error(...);
}
```

Notes:
- The comparison is `strcmp`, so `magic` must be NUL-terminated within the 16 bytes. Writing
  16 non-NUL bytes is a buffer overrun in `strcmp` and will not match.
- `numTiles` is **not** validated, and, critically, **is not what the engine uses to decide how
  much to read** — see §6.
- No other value of `compressionType` has ever been defined. `1` = DXT1 is the only format.
- Nothing checks the file's byte length against `numTiles`. A short file is read past its end (§7).

### What the engine validates in the companion `.smf`

`CSMFMapFile::CheckHeader` `[MF:16-28]`, called from `Open` `[MF:50-54]`, rejects the map unless:

```cpp
h.version == 1 && h.tilesize == 32 && h.texelPerSquare == 8 && h.squareSize == 8
&& strcmp(h.magic, "spring map file") == 0
```

Note what is **not** checked: `mapx` and `mapy`. `SMFFormat.h` documents *"Must be divisible by 128"*
`[FMT:54-55]`, but no code enforces it. A non-conforming `mapx` silently truncates
`numBigTexX = mapx / 128` `[RM:120]`, leaving the right/bottom strip of the map untextured, and
`tileCount = mapx*mapy/16` `[RM:125]` will disagree with the true grid. Treat divisibility by 128 as
a hard requirement on *your writer*, not as something the engine will catch.

### File layout

```
+----------------------------------+ 0x00
|  TileFileHeader (32 bytes)       |
+----------------------------------+ 0x20
|  Tile 0   (680 bytes)            |
|  Tile 1   (680 bytes)            |
|  ...                             |
|  Tile N-1 (680 bytes)            |
+----------------------------------+ 0x20 + N*680  (= EOF)
```

`total_file_size = 32 + numTiles * 680`

`[FMT:160-174]`: *"In other words TileFileHeader is followed by the raw data for the tiles."*

---

## 2. The tile payload — 680 bytes, mips included

**Yes, each tile includes mipmaps: 4 levels (32x32, 16x16, 8x8, 4x4).**

The authoritative constant `[FMT:28]`:

```c
/// Size in bytes of a single tile in the .smt
static constexpr size_t SMALL_TILE_SIZE = (512 >> 0) + (512 >> 2) + (512 >> 4) + (512 >> 6);
```

and the doc comment `[FMT:172-173]`:

> *Each 32x32 tile is dxt1 compressed data with 4 mipmap levels. This takes up exactly
> SMALL_TILE_SIZE (680) bytes per tile (512 + 128 + 32 + 8).*

### The arithmetic, worked out

DXT1 stores one 8-byte block per 4x4 texel block. `blocks = ceil(w/4) * ceil(h/4)`,
`bytes = blocks * 8` (equivalently `w*h/2` for multiples of 4).

| Mip | Dimensions | Blocks | Bytes | = `512 >> 2n` |
|---:|---|---:|---:|---|
| 0 | 32 x 32 | 8 x 8 = 64 | **512** | `512 >> 0` |
| 1 | 16 x 16 | 4 x 4 = 16 | **128** | `512 >> 2` |
| 2 | 8 x 8 | 2 x 2 = 4 | **32** | `512 >> 4` |
| 3 | 4 x 4 | 1 x 1 = 1 | **8** | `512 >> 6` |
| | | **85 blocks** | **680 bytes** | |

`512 + 128 + 32 + 8 = 680`. The mip chain stops at 4x4 — it does **not** go down to 2x2 or 1x1
(those are not representable as distinct DXT1 blocks anyway; 4x4 is exactly one block).

Ratio versus mip-0 alone: `680 / 512 = 1.328125`. This factor recurs in every size calculation
below.

### In-tile byte layout

The engine indexes mip levels with `[GT:515]`:

```cpp
constexpr int TILE_MIP_OFFSET[] = {0, 512, 512+128, 512+128+32};   // = {0, 512, 640, 672}
```

| Mip | Byte range within tile | Length |
|---:|---|---:|
| 0 | `[0, 512)` | 512 |
| 1 | `[512, 640)` | 128 |
| 2 | `[640, 672)` | 32 |
| 3 | `[672, 680)` | 8 |

Within each mip level, blocks are stored **row-major, top-to-bottom, left-to-right** — the
standard linear DXT1 block raster. Confirmed by the writer `[PMC:953-965]`
(`for y in range(yp): for x in range(xp)`) and by the reader `[GT:519-541]`
(`numBlocks = SQUARE_SIZE >> mipLevel` = `8 >> mip` blocks per row; `sbuf = &tile[b*numBlocks*2]`
with `GLint` (4-byte) units, i.e. 8 bytes = 1 block).

So the full tile is:

```
byte 0   .. 511 : mip0, 64 blocks, row-major  (row 0: blocks (0,0)..(7,0), row 1: (0,1).., ...)
byte 512 .. 639 : mip1, 16 blocks, row-major
byte 640 .. 671 : mip2,  4 blocks, row-major
byte 672 .. 679 : mip3,  1 block
```

### Gotcha: mips are NOT generated per-tile

pymapconv does not downsample each 32x32 tile in isolation. It DXT1-compresses a whole
**1024x1024** chunk of the source texture with a 4-level mip chain, then *cuts the tile's mips
out of the big chunk's mips* `[PMC:953-965]`:

```python
def ReadTile(xpos, ypos, sourcebuf):   # xpos, ypos are multiples of 32
    outtile = b''
    sourceoffset = 0
    for i in range(4):                  # main + 3 mips
        div = 1 << i
        xp = 8 // div; yp = 8 // div    # blocks per row of the tile at this mip
        for y in range(yp):
            for x in range(xp):
                ptr = ((x + xpos//div//4) + ((y + ypos//div//4)) * (256//div)) * 8 + sourceoffset
                outtile += sourcebuf[ptr:ptr+8]
        sourceoffset += 524288 // (1 << (i * 2))
    return outtile
```

- `256 // div` = `256 >> i` = blocks per row of the 1024x1024 DDS at mip `i`.
- `524288 >> 2i` = `(1024>>i)^2 / 2` = byte size of DDS mip `i`.

Consequences:
1. Tile mips are **filtered across tile boundaries** — no seams at low mips. Good.
2. Two tiles with byte-identical mip 0 but different surroundings can have different mip 1..3
   bytes, so they will **not** dedup (dedup keys on all 680 bytes). This slightly reduces the
   dedup ratio but is correct behavior.
3. If you write your own compiler, generate mips from the *full* texture, not per tile.

---

## 3. DXT1 block layout (BC1)

Each block is 8 bytes, little-endian:

| Offset | Size | Type | Meaning |
|---:|---:|---|---|
| 0 | 2 | `uint16 LE` | `color0`, RGB565 |
| 2 | 2 | `uint16 LE` | `color1`, RGB565 |
| 4 | 4 | `uint32 LE` | `indices`, 2 bits per texel x 16 texels |

### RGB565 bit layout

```
bit:  15 14 13 12 11 | 10  9  8  7  6  5 |  4  3  2  1  0
      \____ R (5) ___/ \______ G (6) ____/ \___ B (5) ___/
```

Confirmed by the reference decoder `[PMC:96-108]`:

```python
c0, c1, bits = struct.unpack('<HHI', data[xb*8 : xb*8+8])
b0 =  (c0        & 0x1f) << 3
g0 = ((c0 >>  5) & 0x3f) << 2
r0 = ((c0 >> 11) & 0x1f) << 3
```

(The `<< 3` / `<< 2` in pymapconv is the *cheap* 5/6-bit -> 8-bit expansion. **The engine itself does
not use that form.** See "The engine's canonical decode" below.)

### The engine's canonical decode — `rts/lib/squish`

This is the decoder Recoil actually links and runs (it is what `RecompressTilesIfNeeded` feeds the
ETC1 repacker). It is fully specified, so it is the right oracle to validate an encoder against.

`squish::Unpack565` `[SQ:140-158]`:

```cpp
u8 red   = (value >> 11) & 0x1f;
u8 green = (value >>  5) & 0x3f;
u8 blue  =  value        & 0x1f;
colour[0] = (red   << 3) | (red   >> 2);   // 5 -> 8, replicate high bits
colour[1] = (green << 2) | (green >> 4);   // 6 -> 8
colour[2] = (blue  << 3) | (blue  >> 2);
colour[3] = 255;
```

`squish::DecompressColour` `[SQ:160-212]`:

```cpp
int a = Unpack565(bytes    , codes    );   // raw uint16 color0
int b = Unpack565(bytes + 2, codes + 4);   // raw uint16 color1
if (isDxt1 && a <= b) { codes[8+i] = (c + d)/2;      codes[12+i] = 0;   /* alpha 0 */ }
else                  { codes[8+i] = (2*c + d)/3;    codes[12+i] = (c + 2*d)/3; }
```

Three things are pinned down by this and matter to an encoder:

1. The 5/6-bit expansion is **bit-replication** (`(v<<3)|(v>>2)`, `(v<<2)|(v>>4)`), not a bare shift.
2. Interpolation happens in **8-bit space, after expansion**, with **truncating** integer division
   and **no rounding bias**.
3. Mode selection compares the **raw packed uint16s** `a` and `b`, not the expanded colors.

**This pins the engine's CPU path only.** The normal render path hands the raw DXT1 blocks to the
GPU, and the exact 5/6->8 expansion and index-2/3 rounding there is vendor-defined, not specified by
the format. The four known behaviors are enumerated by `rgbcx::bc1_approx_mode`
([`rgbcx.h:79-94`](https://github.com/richgel999/bc7enc_rdo/blob/master/rgbcx.h)) —
`cBC1Ideal` (D3D10 docs, no rounding on 4-color indices 2/3), `cBC1NVidia`, `cBC1AMD`, and
`cBC1IdealRound4` (D3D9 docs / matches AMD Compressonator: rounds the 4-color 2/3 but not the
3-color 2) — and by `stb_dxt.h:73-81`, which notes NVidia/Intel/DX9-ref decoders are closer to a
rounding bias while AMD/S3/DX10-ref round with none. **Encode for `cBC1Ideal` unless you are
targeting one vendor**; the residual difference is under one LSB per channel and is not worth
chasing.

### Index bit order

`[PMC:112-117]` consumes the index word two bits at a time, LSB first, in
`for yo in range(4): for xo in range(4)` order. So:

```
index of texel (x, y)  =  (indices >> (2 * (4*y + x))) & 3
```

Texel (0,0) is the **top-left** of the block and uses the **two least significant bits**. This is
verbatim the S3TC spec `[S3TC:694-699]`:
`code(x,y) = bits[2*(4*y+x)+1 .. 2*(4*y+x)+0]`, "where bit 31 is the most significant and bit 0 is
the least significant bit". `squish::DecompressColour` `[SQ:193-203]` agrees: byte `4+i` of the block
holds row `i`, low bits first.

### The two modes — and which one you may emit

The mode is selected by comparing `color0` and `color1` **as unsigned 16-bit integers**
`[PMC:123, 128]`, `[SQ:176]`, `[S3TC:701-715]` (`if c0 > c1`):

**Mode A — `color0 > color1` (4-color, fully opaque):**

| index | color | alpha |
|---|---|---|
| 0 | `c0` | 1 |
| 1 | `c1` | 1 |
| 2 | `(2*c0 + c1) / 3` | 1 |
| 3 | `(c0 + 2*c1) / 3` | 1 |

**Mode B — `color0 <= color1` (3-color + punchthrough):**

| index | color | alpha |
|---|---|---|
| 0 | `c0` | 1 |
| 1 | `c1` | 1 |
| 2 | `(c0 + c1) / 2` | 1 |
| 3 | **black (0,0,0)** | **0** |

### Is punchthrough allowed?

**Legal, but you should always emit Mode A (opaque 4-color) for terrain.**

- The engine uploads tiles as `GL_COMPRESSED_RGBA_S3TC_DXT1_EXT` `[GT:193]` — the **RGBA**
  variant, so per `EXT_texture_compression_s3tc` the hardware *does* honor 1-bit alpha and
  *does* decode index 3 of Mode B as transparent black. Nothing rejects it. Verbatim `[S3TC:724-728]`:
  alpha is `0.0, if color0 <= color1 and code(x,y) == 3`, `1.0` otherwise. The spec also warns
  `[S3TC:734-737]` that RGB goes to zero for those texels — for *both* the RGB and RGBA variants
  `[S3TC:713]`.
- **The real hazard is the RGB, not the alpha.** In Mode B, index 3 decodes to `(0,0,0)`.
  A naive encoder that lands on `c0 <= c1` and then uses index 3 as a "fourth color" produces
  **black speckles** scattered over terrain. This is the single most common visible artifact
  from a buggy BC1 encoder.
- **Alpha is only sampled for `voidGround` maps.** `[FS:337]` reads
  `vec4 diffuseCol = texture2D(diffuseTex, diffTexCoords);` and `[FS:379]` passes
  `diffuseCol.a` into `GetShadeInt`, but that alpha is only consumed under
  `#ifdef SMF_VOID_GROUND` `[FS:213-218]`:

  ```glsl
  #ifdef SMF_VOID_GROUND
      // assume the map(per)'s diffuse texture provides sensible alphas
      groundShadeInt.a = groundDiffuseAlpha;
  #endif
  ```

  That flag comes from `mapRendering->voidGround` `[RS:117]`, i.e. the `voidGround` key in
  `mapinfo.lua` `[MI:110]` (`topTable.GetBool("voidGround", false)` — default **false**). On a
  normal map `groundShadeInt.a` stays at its `1.0` initializer `[FS:203]` and the diffuse alpha is
  discarded. Two nuances: `SMF_VOID_WATER` `[FS:208-211]` also overwrites `groundShadeInt.a`, but
  from `vertexWorldPos.y >= 0.0`, not from the texture; and `[FS:387]` writes
  `fragColor.a = diffuseCol.a` in the **non-advanced** (`#else` of `SMF_ADV_SHADING`) path, so
  diffuse alpha is not *universally* dead — it is dead on the advanced path every map actually
  uses.
- **The ETC1 fallback destroys alpha entirely.** On drivers without S3TC, `RecompressTilesIfNeeded`
  `[GT:292-321]` decodes each block with `squish::Decompress(rgba, &tiles[i*8], squish::kDxt1)`
  `[GT:315]` and re-packs as `GL_COMPRESSED_RGB8_ETC2` `[GT:189]`, which has **no alpha channel at all**.
  Any map relying on punchthrough alpha renders differently there.
- **Flat blocks are safe.** Setting `c0 == c1` technically selects Mode B (since `c0 > c1` is
  false), but indices 0, 1 and 2 all decode to the same opaque color; only index 3 is the
  transparent-black trap. A flat block with `c0 == c1` and all-zero indices is perfectly fine.
  Defensive encoders nevertheless bias `c1` down by one quantization step so `c0 > c1` holds.

**Rule for an encoder targeting SMT: always order endpoints so `color0 > color1`, and never
emit index 3 in a block where `color0 <= color1`.**

---

## 4. Tile indices -> world space

### The constant chain

| Constant | Value | Source |
|---|---:|---|
| `SQUARE_SIZE` | `8` elmos per map square | `[GC:24]` |
| `texelPerSquare` | `8` texels per map square | `[FMT:57]` ("must be 8 for now") |
| `tilesize` | `32` texels per tile | `[FMT:58]` ("must be 32 for now") |
| `tileScale` | `4` map squares per tile | `[RM.h:181]` `static constexpr int tileScale = 4;` |
| `bigSquareSize` | `32 * tileScale` = `128` map squares | `[RM.h:182]` |
| `mapx`, `mapy` | map size in squares; **must be divisible by 128** (documented, *not* engine-enforced — see §1) | `[FMT:54-55]` |

`tileScale = 4` is exactly `tilesize / texelPerSquare = 32 / 8`.

### Derived dimensions `[RM:120-127]`

```cpp
numBigTexX      = (header.mapx / bigSquareSize);        // = mapx / 128
numBigTexY      = (header.mapy / bigSquareSize);
bigTexSize      = (SQUARE_SIZE * bigSquareSize);        // = 8 * 128 = 1024 texels
tileMapSizeX    = (header.mapx / tileScale);            // = mapx / 4
tileMapSizeY    = (header.mapy / tileScale);
tileCount       = (header.mapx * header.mapy) / (tileScale * tileScale);   // = mapx*mapy/16
mapSizeX        = (header.mapx * SQUARE_SIZE);          // world extent in elmos
mapSizeZ        = (header.mapy * SQUARE_SIZE);
```

### The key identities

```
1 map square  = 8 x 8 elmos   = 8 x 8 texels
1 tile        = 4 x 4 squares = 32 x 32 elmos = 32 x 32 texels
              => the diffuse texture is EXACTLY 1 texel per elmo
1 big square  = 128 x 128 squares = 32 x 32 tiles = 1024 x 1024 texels = 1024 x 1024 elmos

full diffuse texture = (mapx * texelPerSquare) x (mapy * texelPerSquare)
                     = (mapx * 8) x (mapy * 8) texels
tile index grid      = (mapx / 4) x (mapy / 4)  int32 entries
```

### The tile index array (lives in the `.smf`, not the `.smt`)

`[FMT:119-121]`:

> *After this follows an `int[mapx*texelPerSquare/tileSize * mapy*texelPerSquare/tileSize]`
> (this is `int[mapx/4 * mapy/4]` with currently hardcoded texelPerSquare=8 and tileSize=32)
> which are indices to the defined tiles.*

Stored **row-major**, `int32 LE`, immediately after the `MapTileHeader` + per-file
`(count, filename)` records. The engine slurps it in one read `[GT:178]`:

```cpp
ifs->Read(&tileMap[0], smfMap->tileCount * sizeof(int));
```

Lookup, from `ExtractSquareTiles` `[GT:530-531]`:

```cpp
const int tileIdx = tileMap[tileY * smfMap->tileMapSizeX + tileX];
const GLint* tile = (GLint*) &tiles[tileIdx * SMALL_TILE_SIZE + mipOffset];
```

To find the tile covering world position `(wx, wz)` in elmos:

```
tileX = floor(wx / 32)                  // 32 elmos per tile
tileY = floor(wz / 32)
tileIdx = tileMap[tileY * (mapx/4) + tileX]
```

pymapconv writes the same indexing `[PMC:996]`:
`tilepos = 32*tilex + x + (32*springmapx//2) * (32*tiley + y)`, where the row stride
`32*springmapx//2 = 16*springmapx = mapx/4 = tileMapSizeX`.

### How the engine assembles a renderable texture

The engine never materializes the whole diffuse texture. It builds **one GL texture per big
square** (1024x1024) by gathering that square's 32x32 tiles into a linear DXT1 block raster
`[GT:505-544]`, then uploading with `glCompressedTexImage2D` `[GT:582]` (streaming) / `[GT:624]`
(persistent).

`LoadSquareTexturePersistent` `[GT:590-628]` (the default, since `SMFTextureStreaming` has
`.defaultValue(false)` `[GT:46]`) uploads all four mip levels `0..3` with
`GL_TEXTURE_MAX_LEVEL = 3` `[GT:605]`. The streaming mode `LoadSquareTexture` `[GT:546-588]`
instead uploads a single level chosen by the distance/stretch heuristics in `DrawUpdate`
`[GT:342-434]`, which is why the config description says it gives "worse performance and image
quality" `[GT:46]`.

Note `GL_TEXTURE_MAX_LEVEL = 3` on a 1024x1024 texture: the mip chain **stops at 128x128**.
There is no 64x64-and-below mip for the ground diffuse — minification below that relies on the
map's separate minimap texture and on the detail/splat textures.

> **`mapx` and `mapy` are independent.** Nothing requires a square map, and shipped BAR maps are
> routinely rectangular — e.g. *Red Comet Remake 1.8* is `mapx=768, mapy=512` (12x8) and
> *Iron_Isle_V1* is `mapx=1536, mapy=768` (24x12), both read straight out of their `.smf` headers.
> Every formula below uses `mapx` and `mapy` separately; the "NxN" shorthand is only a naming
> convention.

### Worked example A — a 16x16 BAR map

BAR "16x16" means 16x16 units of 512 elmos. pymapconv derives this from the source texture
`[PMC:442-445]`:

```python
mapx = texw // 8;  mapy = texh // 8
springmapx = texw // 512;  springmapy = texh // 512
```

so `mapx = 64 * springmapx`.

| Quantity | Formula | Value |
|---|---|---:|
| `springmapx`, `springmapy` | — | 16, 16 |
| `mapx`, `mapy` (squares) | `64 * 16` | **1024 x 1024** |
| divisible by 128? | `1024 / 128 = 8` | yes |
| World extent (elmos) | `mapx * 8` | **8192 x 8192** |
| **Diffuse texture** | `mapx * 8` | **8192 x 8192 texels** |
| Source RGB24 size | `8192^2 * 3` | 201,326,592 B = **192 MiB** |
| `tileMapSizeX/Y` | `mapx / 4` | 256 x 256 |
| `tileCount` (index entries) | `256 * 256` | **65,536** |
| Index array bytes in `.smf` | `65536 * 4` | 262,144 B = **256 KiB** |
| `numBigTexX/Y` | `mapx / 128` | 8 x 8 = **64 big squares** |
| Each big square | — | 1024x1024 texels = 32x32 tiles |
| **`.smt` size, zero dedup** | `32 + 65536 * 680` | 44,564,512 B ≈ **42.5 MiB** |

**Measured**: *Tangerine_Remake 1.0* is exactly this map size, and its `maps/Tangerine_Remake.smt`
is **44,564,512 bytes** — byte-for-byte the zero-dedup figure. (Downloaded from
`files-cdn.beyondallreason.dev`, header parsed: `numTiles = 65536`.)

Sanity check: 42.5 MiB is exactly the size of an 8192x8192 DXT1 texture with 4 mip levels:
`8192*8192/2 * 1.328125 = 33,554,432 * 1.328125 = 44,564,480`. An un-deduped SMT is bit-for-bit
the same volume as the full mipped DXT1 texture — dedup is pure gain on top of that.

Compression vs. the RGB24 source: `192 / 42.5 = 4.52 : 1` before dedup (6:1 if you only count
mip 0).

### Worked example B — a 24x24 map

| Quantity | Formula | Value |
|---|---|---:|
| `mapx`, `mapy` (squares) | `64 * 24` | **1536 x 1536** |
| divisible by 128? | `1536 / 128 = 12` | yes |
| World extent (elmos) | `1536 * 8` | **12288 x 12288** |
| **Diffuse texture** | `1536 * 8` | **12288 x 12288 texels** |
| Source RGB24 size | `12288^2 * 3` | 452,984,832 B = **432 MiB** |
| `tileMapSizeX/Y` | `1536 / 4` | 384 x 384 |
| `tileCount` | `384 * 384` | **147,456** |
| Index array bytes in `.smf` | `147456 * 4` | 589,824 B = **576 KiB** |
| `numBigTexX/Y` | `1536 / 128` | 12 x 12 = **144 big squares** |
| **`.smt` size, zero dedup** | `32 + 147456 * 680` | 100,270,112 B ≈ **95.6 MiB** |

**Measured**: *Supreme Isthmus v2.1* is a 24x24 map and its `maps/supreme_green.smt` is
**100,270,112 bytes**, `numTiles = 147456`. Again exactly the zero-dedup figure.

> **Caution on "NxN" map sizes.** Not every `N` is legal. The hard constraint is
> `mapx % 128 == 0` `[FMT:54-55]` — a *documented* constraint the engine does not actually check
> (§1) — i.e. `64*N % 128 == 0`, i.e. **`N` must be even**. A "17x17" or
> "23x23" map cannot exist. Odd-sounding BAR map names refer to elmo extents, not to `N`.
> pymapconv additionally rejects any source texture whose dimensions are not a multiple of 1024
> `[PMC:446-448]`, which enforces exactly the same thing (`texw % 1024 == 0` => `mapx % 128 == 0`
> and `springmapx = texw/512` even). All six shipped BAR maps sampled for this document have even
> `N` in both axes.

---

## 5. Tile deduplication

### How pymapconv dedups

Dead simple and fully lossless: **a Python dict keyed on the raw 680 tile bytes**
`[PMC:976-1001]`.

```python
tilehash = {}     # yes, we are gonna use the tiles as keys to perform rapid lossless compresssion :D
tileindices = {}

for tilex in range(springmapx // 2):
    for tiley in range(springmapy // 2):
        ...
        ddsdata = ddsfile.read()[128:]          # strip the 128-byte DDS header
        for x in range(32):
            for y in range(32):
                tile = ReadTile(32 * x, 32 * y, ddsdata)
                if len(tile) != SMALL_TILE_SIZE:
                    raise
                if tile not in tilehash:
                    tilehash[tile] = len(tilehash)
                tilepos = 32*tilex + x + (32*springmapx//2) * (32*tiley + y)
                tileindices[tilepos] = tilehash[tile]
```

Properties:
- **Exact-match only.** Two tiles that differ in a single bit of a single mip level are stored
  twice. There is no perceptual clustering, no near-duplicate merging, no lossy quantization.
- **Keyed on all 680 bytes**, mips included. See the §2 gotcha — identical mip 0 with different
  mip 1..3 does not dedup.
- **First-seen wins**, so tile indices are assigned in scan order. The output order is then
  recovered by inverting the dict `[PMC:1014-1018]`:
  ```python
  inversetiledict = {}
  for tile, index in tilehash.items():
      inversetiledict[index] = tile
  for i in range(len(inversetiledict)):
      tilefile.write(inversetiledict[i])
  ```
- The scan is per-1024x1024-chunk, but `tilehash` is global across the whole map, so dedup is
  map-wide, not chunk-local.

### Typical ratios

pymapconv reports it `[PMC:1004]`:

```python
print('Lossless compression of 32x32 tiles: %i tiles used of %i maximum'
      % (len(tilehash), 256 * springmapx * springmapy))
```

(`256 * springmapx * springmapy` = `tileMapSizeX * tileMapSizeY` = `tileCount`.)

The ratio is entirely content-dependent, and DXT1 makes it *worse* than intuition suggests,
because DXT1 is deterministic but extremely sensitive: any change in the 16 source texels of any
block changes the endpoints, so two visually near-identical tiles almost never produce identical
bytes.

### Measured on shipped BAR maps

Ten map archives were downloaded from `files-cdn.beyondallreason.dev` (each md5-verified against
the official BAR file index), the `.smf` and `.smt` extracted, the headers parsed, and every stored
680-byte tile hashed. Every number below is measured, not estimated.

| Map (springname) | N | `mapx` x `mapy` | `tileCount` | `numTiles` in `.smt` | Byte-distinct stored tiles | `.smt` bytes | LZMA'd inside `.sd7` |
|---|---|---|---:|---:|---:|---:|---:|
| Hooked 1.1.1 | 6x4 | 384 x 256 | 6,144 | 6,144 | 6,144 | 4,177,952 | 48.7% |
| Altair_Crossing_V4.1 | 8x8 | 512 x 512 | 16,384 | 16,384 | 16,384 | 11,141,152 | 52.3% |
| Coast To Coast BAR v1.0 | 12x8 | 768 x 512 | 24,576 | 24,576 | 24,576 | 16,711,712 | 47.7% |
| Red Comet Remake 1.8 | 12x8 | 768 x 512 | 24,576 | **24,577** | 24,577 | 16,712,392 | 45.2% |
| Quicksilver Remake 1.24 | 14x14 | 896 x 896 | 50,176 | 50,176 | 50,176 | 34,119,712 | 58.1% |
| Boreal Falls 1.0.2 | 14x14 | 896 x 896 | 50,176 | **50,136** | 50,136 | 34,092,512 | 39.2% |
| Comet Catcher Remake 1.8 | 16x12 | 1024 x 768 | 49,152 | **49,153** | 49,153 | 33,424,072 | 50.0% |
| Tangerine_Remake 1.0 | 16x16 | 1024 x 1024 | 65,536 | 65,536 | 65,536 | 44,564,512 | 54.8% |
| Iron_Isle_V1 | 24x12 | 1536 x 768 | 73,728 | 73,728 | 73,728 | 50,135,072 | 31.0% |
| Supreme Isthmus v2.1 | 24x24 | 1536 x 1536 | 147,456 | 147,456 | 147,456 | 100,270,112 | 50.3% |

**Conclusions, in order of importance for a writer:**

1. **Real-world dedup is essentially zero.** In every one of the ten maps, *every stored tile is
   byte-distinct*. Nine of ten store at least `tileCount` tiles. The only map that dedups at all is
   Boreal Falls: 50,136 tiles for 50,176 grid cells — **40 tiles saved, 0.08%**. Plan your sizing
   and memory budget on `32 + tileCount * 680` and treat any dedup as a rounding error.
2. `32 + numTiles * 680` reproduced the exact on-disk `.smt` size for all ten files. The format
   formula is confirmed against real data, not just against source.
3. **`numTiles` is not bound to `tileCount` in either direction.** Two maps ship `tileCount + 1`
   tiles with exactly one tile that no `tileMap` entry references (index range `0..tileCount`,
   `tileCount` distinct values used). One ships fewer. Your reader must size everything off the
   headers, never off `mapx*mapy/16`.
4. All ten maps use `numTileFiles == 1`, and all store a bare filename (e.g. `"RCR.smt"`) with no
   directory component.

Why dedup fails in practice: BAR map diffuse textures are photographic/hand-painted at 1 texel per
elmo, and DXT1 endpoint fitting is exquisitely sensitive — one changed source texel anywhere in a
32x32 tile (or in the 1024x1024 chunk's mip chain, per the §2 gotcha) changes the bytes. Even large
"flat" ocean regions are painted seabed, not constant color.

Dedup only pays when the source texture is *literally* pixel-repeating on a 32-texel grid **and**
aligned to the 1024-texel chunk grid (because mips are cut from the chunk). Flattening genuinely
uniform areas to an exactly constant color before compiling is the one reliable lever; it is not
worth designing your pipeline around.

### Does the engine require unique tiles?

**No.** The engine never inspects tile content. Nothing dedups, nothing validates uniqueness,
nothing complains about duplicates. `tileMap` is a plain index array `[GT:530]`, and multiple
entries may point at the same index (that is the whole point) or every entry may point at a
distinct index. A perfectly valid `.smt` can contain 65,536 byte-identical tiles.

Conversely, **tiles may be unreferenced** — the engine loads all `numTiles` tiles into RAM
regardless of whether any `tileMap` entry points at them.

---

## 6. Multiple `.smt` files per `.smf`

**Yes.** The `.smf` may reference any number of tile files.

### Structure in the `.smf` at `SMFHeader.tilesPtr`

`[FMT:106-118]`:

```
MapTileHeader {
    int32 numTileFiles;   // number of .smt files to read (usually 1)
    int32 numTiles;       // TOTAL number of tiles across all files
}
then, repeated numTileFiles times:
    int32  tilesInThisFile
    char[] smtFileName    // NUL-terminated, variable length
then:
    int32 tileIndex[ (mapx/4) * (mapy/4) ]
```

### How the global index is split

`[FMT:115-117]`:

> *Each file defines as many tiles the int indicates with the following files starting where the
> last one ended so if there is 2 files with 100 tiles each the first defines 0-99 and the second
> 100-199.*

It is a simple **sequential concatenation** — no per-file base offsets are stored, they are
implied by accumulation. The loader `[GT:132-176]` keeps a running `curTile`:

```cpp
for (int a = 0, curTile = 0; a < tileHeader.numTileFiles; ++a) {
    int numSmallTiles = 0;
    char fileNameBuffer[256] = {0};

    ifs->Read(&numSmallTiles, sizeof(int));
    ifs->ReadString(&fileNameBuffer[0], sizeof(char) * (sizeof(fileNameBuffer) - 1));
    swabDWordInPlace(numSmallTiles);
    ...
    for (int b = 0; b < numSmallTiles; ++b) {
        tileFile.Read(&tiles[(curTile++) * SMALL_TILE_SIZE], SMALL_TILE_SIZE);
    }
}
```

So global tile index `i` lives in the first file whose cumulative count exceeds `i`, at local
index `i - (sum of counts of preceding files)`.

The destination buffer is sized from `MapTileHeader.numTiles` `[GT:117]`:

```cpp
tiles.assign(static_cast<size_t>(tileHeader.numTiles) * SMALL_TILE_SIZE, 0);
```

so `MapTileHeader.numTiles` **must equal** the sum of the per-file `tilesInThisFile` values, or
the loop writes past the end of the vector.

### File resolution

`[GT:140-163]`: the filename is first tried relative to the `.smf`'s directory
(`FileSystem::GetDirectory(gameSetup->MapFileName()) + smtFileName`), then as an absolute/VFS
path. `[FMT:110-113]` notes the engine prepends `maps/` when searching the VFS.

### `mapinfo.lua` override

`[MI:420-428]` and `[GT:126-131]`: a map can override the embedded filenames:

```lua
smf = {
    smtFileName0 = "something.smt",
    smtFileName1 = "other.smt",
}
```

Keys are scanned as `smtFileName%i` from 0 until the first missing key. The override is applied
**only if the count matches exactly**:

```cpp
if (!(smtHeaderOverride = (smf.smtFileNames.size() == tileHeader.numTileFiles))) {
    LOG_L(L_WARNING, "smtFileNames.size()=%zu != tileHeader.numTileFiles=%d", ...);
}
```

On mismatch it logs a warning and silently falls back to the embedded names.

### Missing `.smt` is non-fatal

`[GT:150-159]`: if a tile file cannot be opened, the engine fills that file's tile range with
`0xaa` and continues:

```cpp
memset(&tiles[curTile * SMALL_TILE_SIZE], 0xaa, numSmallTiles * SMALL_TILE_SIZE);
```

> **What that actually looks like on screen.** The log message says *"ALL %d SMALL TILES WILL BE
> MADE RED"* `[GT:153]`, and it is telling the truth. Decoding the fill: `c0 = c1 = 0xAAAA`
> (`0b1010101010101010`), so
> R = bits 15..11 = `0b10101` = 21,
> G = bits 10..5 = `0b010101` = 21,
> B = bits 4..0 = `0b01010` = 10.
> `indices = 0xAAAAAAAA`, i.e. every 2-bit pair is `0b10` = index 2; since `c0 == c1` this is
> Mode B and index 2 = `(c0+c1)/2` = the same color. Every texel is therefore a uniform
> desaturated brick red. Under the engine's own `Unpack565` `[SQ:151-153]` — bit replication,
> `(21<<3)|(21>>2)`, `(21<<2)|(21>>4)`, `(10<<3)|(10>>2)` — that is **`rgb(173, 85, 82)`**.
> (A bare-shift decoder such as pymapconv's gives `rgb(168, 84, 80)`; the ~2% difference is the
> expansion, not the data.) If your whole map renders in flat brick red, the engine could not open
> the `.smt`.

### pymapconv only ever writes one

pymapconv hardcodes `numtilefiles = 1` `[PMC:1039]` and names the `.smt` by substituting the
extension: `smtfilepath = myargs.outfile.replace('.smf', '.smt')` `[PMC:1006]`. Multi-SMT maps
must be produced by other tooling, or by sharing one `.smt` across several `.smf` files — which
is the feature's original purpose `[FMT:20-21]`: *"This file can be shared between different
maps."*

### Is any of this used in practice?

Measured and searched, rather than assumed:

- **Multi-file: no evidence of it anywhere.** All ten shipped BAR maps sampled in §5 have
  `MapTileHeader.numTileFiles == 1`. A GitHub code search for `smtFileName1` returns only commented-
  out template lines (`--smtFileName1 = "",` in the engine's own
  `cont/base/springcontent/mapgenerator/mapinfo_template.lua`, BAR's copy of it, and various map
  skeletons) — no map that actually sets it. Treat `numTileFiles > 1` as a format capability with
  **zero known live users**: implement the reader for it, never emit it.
- **The `smtFileName0` override: yes, genuinely used.** SpringBoard-Core emits it unconditionally
  from `scen_edit/command/export_map_info_command.lua:180`
  (`smtFileName0 = "maps/" .. SB.project.name .. ".smt"`), and real maps ship it — e.g.
  `lhog/spring-map-pbr` (`smtFileName0 = "maps/iceworld.smt"`) and
  `beyond-all-reason/map_blueprint`. Note those values carry a `maps/` prefix, so they do **not**
  resolve via `smfDir + name`; they land on the second attempt, the absolute/VFS path `[GT:148-149]`.

---

## 7. Practical limits, file size, memory cost

### Hard format limits

| Limit | Value | Why |
|---|---|---|
| Max tiles per file | `2^31 - 1` | `TileFileHeader.numTiles` is `int32` |
| Max total tiles | `2^31 - 1` | `MapTileHeader.numTiles` is `int32` |
| Max tile index | `2^31 - 1` | `tileMap` is `std::vector<int>` `[GT:51]`, read raw `[GT:178]`; values are signed |
| Max SMT filename | 255 bytes | `char fileNameBuffer[256]` with `sizeof(buffer)-1` read `[GT:134,137]` |
| Max `.smt` bytes | none structural | the file has no internal offsets; `numTiles * 680` is only bounded by `int32` |
| Tile size | fixed 32 | `tfh.tileSize != 32` -> `content_error` `[GT:165]` |
| Compression | fixed DXT1 | `tfh.compressionType != 1` -> `content_error` `[GT:165]` |

### The limit that actually binds

The *useful* upper bound on unique tiles is `tileCount = mapx*mapy/16` — beyond that you have more
tiles than index slots. pymapconv prints exactly this as the maximum `[PMC:1004]` and carries a live
`# TODO: tilehash is larger than max tiles sometimes!` `[PMC:1003]`.

**`numTiles > tileCount` is real and ships.** Two of the ten maps measured in §5 —
*Red Comet Remake 1.8* and *Comet Catcher Remake 1.8* — store exactly `tileCount + 1` tiles, with
index values spanning `0 .. tileCount` and exactly one stored tile that no `tileMap` entry
references. So this is not a hypothetical.

**Root cause: UNVERIFIED — needs confirmation.** Inside pymapconv it should be impossible:
`tilehash[tile] = len(tilehash)` runs once per distinct tile and the scan visits exactly
`(springmapx//2)*(springmapy//2)*1024 = 256*springmapx*springmapy = tileCount` tiles, so
`len(tilehash) <= tileCount` always, and every hashed tile is referenced. The observed maps have an
*unreferenced* tile, which pymapconv cannot produce — strongly suggesting those two `.smt` files
came from different tooling (the legacy C++ `mapconv`, SpringBoard, or a hand edit), not that
pymapconv's counter is wrong. Whatever the origin, it is harmless: the engine sizes its buffer from
`MapTileHeader.numTiles` `[GT:117]`, never from `tileCount`.

**Implication for your writer:** emit `numTiles = <however many tiles you actually wrote>` and make
`MapTileHeader.numTiles`, the per-file count, and `TileFileHeader.numTiles` all agree with it. Do
not clamp to `tileCount`, and do not assume a reader's `numTiles == tileCount`.

### File sizes

`file_size = 32 + numTiles * 680`

| Map | `tileCount` | `.smt`, zero dedup |
|---|---:|---:|
| 8x8 (`mapx=512`) | 16,384 | 11,141,152 B ≈ 10.6 MiB |
| 12x12 (`mapx=768`) | 36,864 | 25,067,552 B ≈ 23.9 MiB |
| 16x16 (`mapx=1024`) | 65,536 | 44,564,512 B ≈ 42.5 MiB |
| 24x24 (`mapx=1536`) | 147,456 | 100,270,112 B ≈ 95.6 MiB |
| 32x32 (`mapx=2048`) | 262,144 | 178,257,952 B = 170.0 MiB |

There is no 2 GiB structural limit inside the `.smt` (it has no internal offsets), but you would
need ~3.16M tiles to reach 2 GiB, far past anything practical. In practice the binding constraint
is download size — maps ship as `.sd7` (7-Zip/LZMA) or `.sdz` (zip) archives, and the `.smt` is the
dominant member.

**Correction to a common assumption: the `.smt` compresses well, roughly 2:1.** Measured LZMA ratios
for the `.smt` member of the ten `.sd7` archives in §5 range from **31.0%** (Iron_Isle_V1) to
**58.1%** (Quicksilver Remake), median around **49%**. DXT1 output is *not* high-entropy the way raw
compressed data usually is: endpoint pairs in adjacent blocks are strongly correlated and the index
words are far from uniform, and LZMA exploits both. Budget shipped map download size at roughly
`0.5 * (32 + numTiles * 680)`. (A rate-distortion-optimizing encoder pushes this further — see §8.)

### Memory cost

**System RAM** — the engine holds every tile, permanently, for the whole game `[GT:117]`:

```
RAM_for_tiles = numTiles * 680 bytes
```

This is a `static std::vector<char> tiles` (declared `[GTH:71]`, defined `[GT:52]`), never freed
while the map is loaded. For a
16x16 map with no dedup that is **42.5 MiB resident**, plus `tileCount * 4` for `tileMap`
(256 KiB). Dedup reduces this proportionally — it is a real runtime memory win, not just a disk
win.

**VRAM** — independent of dedup, because tiles are expanded into per-big-square textures:

```
VRAM = numBigTexX * numBigTexY * bigTexSize^2 / 2 * 1.328125      (persistent mode, mips 0..3)
```

For a 16x16 map: `64 * 1024*1024/2 * 1.328125 = 64 * 696,320 = 44,564,480 B` ≈ **42.5 MiB**.
Note this equals the un-deduped SMT size exactly — deduplication saves disk and RAM but **never**
saves VRAM, since every big square gets its own fully-expanded texture.

In streaming mode (`SMFTextureStreaming = true`) only one mip level per square is resident, and
squares out of view drop to level 3 after 120 unseen draw frames `[GT:368-373]`, trading image
quality and performance for VRAM `[GT:46]`.

**Transient**: `LoadSquareTexturePersistent` allocates one
`std::vector<GLint> tilesBuffer(bigTexSize*bigTexSize/2/sizeof(GLint))` `[GT:619]`
= `1024*1024/2/4` = 131,072 `GLint` = **512 KiB** per square, reused across all four mip levels
`[GT:620-625]`.

### Unchecked-input gotchas (relevant if you generate `.smt`/`.smf` yourself)

1. **`tileMap` values are never bounds-checked.** `[GT:530-531]` does
   `tiles[tileIdx * SMALL_TILE_SIZE + mipOffset]` with no validation of `tileIdx` against
   `numTiles`. An out-of-range index is an out-of-bounds read — garbage tiles or a crash.
   Negative indices are equally unchecked.
2. **`TileFileHeader.numTiles` is read but not used to size the read.** The engine reads
   `numSmallTiles` tiles, where `numSmallTiles` comes from the **`.smf`** `[GT:136, 173-175]`. If the
   `.smf` says 100 and the `.smt` header says 50, the engine reads 100 tiles' worth of bytes —
   running off the end of the `.smt`. Keep them consistent.
3. **`MapTileHeader.numTiles` must equal the sum of per-file counts**, or `tiles` is undersized
   (see §6).
4. **Truncated `.smt`**: `CFileHandler::Read` past EOF short-reads; the tail stays zero-filled
   from `tiles.assign(...)` `[GT:117]`. Zeroed tiles decode as `c0 = c1 = 0`, indices 0 -> solid
   black. Black terrain = truncated `.smt`.
5. **pymapconv writes `minimapdata[:MINIMAP_SIZE]` deliberately** `[PMC:1057]` — *"dont even
   write more than needed, or else produced map will crash!"* The minimap is a separate
   1024x1024 DXT1 + 8 mips = `MINIMAP_SIZE = 699048` bytes blob in the `.smf` `[FMT:31-34]`, not
   in the `.smt`. Verify: `524288+131072+32768+8192+2048+512+128+32+8 = 699048`.

---

## 8. Quality notes — DXT1 artifacts and encoder selection

### What DXT1 does wrong on terrain

DXT1 quantizes each 4x4 block to a line segment in RGB space (two RGB565 endpoints plus two
interpolated points). The characteristic failures on terrain:

- **Blocking / 4x4 banding.** Smooth gradients — sand-to-water transitions, gentle lighting
  ramps, large sky-lit slopes — get quantized to 4 levels per block, producing visible 4x4
  terraces. This is the dominant artifact on BAR-style maps, which are full of large smooth
  regions. Terrain is uniquely bad for DXT1 because it is viewed at grazing angles across huge
  continuous surfaces, so banding lines up into long visible contours.
- **Green/magenta shift.** RGB565 gives green an extra bit. Desaturated grey-brown terrain drifts
  toward green or magenta depending on which side of the quantization the endpoints land.
  Extremely visible on grey rock and snow.
- **Chroma bleed at sharp edges.** Road markings, cliff/beach boundaries, painted team-start
  circles — any high-contrast edge inside a 4x4 block forces both endpoints to straddle the edge,
  smearing color across it.
- **Black speckles.** Mode B index 3 (see §3). An encoder bug, not an inherent limitation.
- **Mip-chain drift.** Because pymapconv compresses the 1024x1024 chunk's mips independently
  (each mip level is separately DXT1-compressed by the external tool), quantization error differs
  per level, so the terrain can visibly *shift hue* as the camera zooms across a mip transition.
- **Tile-grid seams.** Rare, but if mips were ever generated per-32x32-tile instead of from the
  parent chunk, every 32-texel boundary would seam at mip 1+. Don't do that.

### Mitigations that actually matter here

1. **Pre-dither the source, or use a dithering encoder.** Ordered or error-diffusion dithering
   before quantization breaks up the 4x4 terracing at the cost of slight noise. On terrain viewed
   at distance this is almost always a net win. Note dithering **destroys tile dedup** (it makes
   every tile unique), so it trades file size for quality.
2. **Encode in perceptual/weighted color space.** Luma-weighted error metrics (roughly
   `0.2126 R, 0.7152 G, 0.0722 B`) match the eye far better than uniform RGB error and
   substantially reduce the green/magenta shift.
3. **Always force `c0 > c1`** (opaque 4-color mode) unless the map is `voidGround`.
4. **Generate mips from the full-resolution image, once**, with a good filter (Kaiser/Lanczos),
   then compress each level — and consider compressing mip levels at higher quality settings,
   since errors there are magnified across large screen areas.
5. **Don't re-compress.** If you have a DXT1 source, never decode-and-recompress; the error
   compounds. This is exactly what the ETC1 fallback path does `[GT:292-321]`, and it is
   acknowledged as a quality loss.
6. **Consider RDO.** Since the `.smt` ships inside an LZMA archive and compresses ~2:1 (§7), a
   rate-distortion-optimizing BC1 encoder buys real download size at a small, tunable quality cost —
   a more useful lever here than tile dedup, which measurably does nothing (§5).

### Open-source encoders

| Encoder | Language / usable from | Quality | Speed | Notes |
|---|---|---|---|---|
| **[stb_dxt](https://github.com/nothings/stb/blob/master/stb_dxt.h)** v1.12, 719 lines | single-header C, trivial WASM/native | Fair (`STB_DXT_HIGHQUAL` = good) | Very fast | Dual **public domain or MIT** (`stb_dxt.h:683,702`). The pragmatic default: zero dependencies, compiles to WASM in seconds, no build system. PCA endpoint fit plus refinement (`STB_DXT_HIGHQUAL` = 2 refine steps instead of 1, `stb_dxt.h:56,487`). **`STB_DXT_DITHER` is deprecated and does nothing** — the header says so verbatim: `// use dithering. was always dubious, now deprecated. does nothing!` (`stb_dxt.h:55`). Always emits 4-color mode: it swaps so `max16 > min16` before writing (`stb_dxt.h:526-530`) and constant blocks use the optimal-match tables with `mask = 0xaaaaaaaa` (`stb_dxt.h:494-498`). **Best starting point for a JS/WASM tool.** |
| **[rgbcx.h](https://github.com/richgel999/bc7enc_rdo/blob/master/rgbcx.h)** v1.13 (bc7enc / bc7enc_rdo, Rich Geldreich) | single-header C++, WASM-friendly | Very high CPU BC1 quality | Fast-to-moderate, `MIN_LEVEL = 0, MAX_LEVEL = 18` (`rgbcx.h:236`) | **"Public Domain or MIT license (you choose)"** (`rgbcx.h:3`; repo `LICENSE` confirms dual MIT / Unlicense for all non-`bc7e.ispc` files). Uses "prioritized cluster fit", which the author states is *"3-4x faster than traditional cluster fit (as implemented in libsquish with SSE2) at the same or slightly higher average quality"* and *"faster than both AMD Compressonator and libsquish at the same average quality"* (bc7enc README lines 10, 14 — author's own benchmark, not independently reproduced). **The quality choice.** Two APIs matter here: `encode_bc1(level, pDst, pPixels, allow_3color, use_transparent_texels_for_black)` — pass `allow_3color = false` to force Mode A — and `init(bc1_approx_mode)` to pick the decoder model (`cBC1Ideal` / `cBC1NVidia` / `cBC1AMD` / `cBC1IdealRound4`, `rgbcx.h:79-94`). `bc7enc_rdo` additionally offers RDO, which deliberately makes blocks more similar to improve downstream LZ compression — worth real money here, since the `.smt` ships LZMA'd at ~50% (§7). *Caveat: RDO does **not** meaningfully help SMT tile dedup, which requires byte-exact 680-byte matches and measures at ~0% on shipped maps (§5).* |
| **[ispc_texcomp](https://github.com/GameTechDev/ISPCTextureCompressor)** (Intel) | ISPC -> native lib; awkward from WASM | Good | **Fastest** (SIMD, multi-ISA) | MIT (confirmed via GitHub license API). Defines the low-quality/high-speed end of the quality/speed frontier. *(An earlier draft quoted "~33.1 dB on BC1" — that figure could not be located in any primary source and has been removed. **UNVERIFIED — needs confirmation** if you need a number.)* Requires the ISPC compiler in your build, and the SIMD focus makes WASM deployment painful. Choose it for bulk native pipelines, not for a browser tool. |
| **[libsquish](https://github.com/svn2github/libsquish)** | C++, easy native, WASM-able | Good (cluster fit) | Slow | MIT (confirmed via GitHub license API). **Already vendored in the engine at `rts/lib/squish`** (verified: `colourblock.cpp`, `clusterfit.cpp`, `rangefit.cpp`, … all present) and used by `RecompressTilesIfNeeded` `[GT:315]` — so it is the reference implementation for "what Recoil considers a correct DXT1 decode" (see §3). Its `kColourClusterFit` + `kColourMetricPerceptual` flags give solid perceptual quality. Superseded on quality-per-time by rgbcx, but its presence in-engine makes it the safe decode oracle. |
| **[Basis Universal](https://github.com/BinomialLLC/basis_universal)** | C++ / JS+WASM build shipped | N/A — transcoder | — | Apache-2.0 (confirmed via GitHub license API). **Not an appropriate choice here.** Basis is a *supercompressed intermediate* that transcodes to BC1 at load time; its BC1 output is deliberately quality-limited to keep transcoding cheap. SMT needs final, canonical BC1 bytes. Its BC1 *transcoder* is however a well-tested reference decoder if you need one. |
| **[icbc](https://github.com/castano/icbc)** (Ignacio Castaño, ex-NVTT) | single-header C++ | Very good (`icbc HQ`) | Moderate | MIT (confirmed via GitHub license API). The quality core extracted from NVIDIA Texture Tools. Competitive with rgbcx's high levels. Good second opinion / cross-check. |
| **[Compressonator](https://github.com/GPUOpen-Tools/compressonator)** (AMD) | CLI + lib | Good, tunable | Moderate | MIT (text at `license/license.txt`; GitHub's license API reports none because the file is not at the repo root). **This is what pymapconv actually uses on Linux** `[PMC:918]`: `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4`. The `-RefineSteps 2` flag is its endpoint-refinement iteration count. Its decode model is the one rgbcx calls `cBC1IdealRound4`. |
| **nvdxt.exe** (NVIDIA, legacy) | Windows binary only | Good | Slow | **Not open source, Windows-only, long deprecated.** pymapconv's Windows path shells out to it `[PMC:932-946]` with `-dxt1a -Sinc -quality_highest`. `-Sinc` is the mip filter; `-quality_highest` maximizes search. A modern rewrite should drop this entirely. |

### Recommendation for a from-scratch implementation

- **Prototype**: `stb_dxt.h` with `STB_DXT_HIGHQUAL`. One file, compiles to WASM immediately,
  correct 4-color-mode output, good enough to validate the whole pipeline.
- **Ship**: `rgbcx.h` at a high level (`MAX_LEVEL` is 18) with `allow_3color = false` and
  `init(cBC1Ideal)`. Same integration story (single header, WASM-friendly), materially better
  output. If download size matters, add `bc7enc_rdo`'s RDO — it pays off against the ~2:1 LZMA the
  `.sd7` already achieves on `.smt` data (§7), *not* against tile dedup (§5).
- **Validate**: decode with the engine's own vendored `libsquish`
  (`rts/lib/squish/colourblock.cpp`, `squish::kDxt1`) and compare — that is literally the code
  Recoil runs on the ETC1 fallback path `[GT:315]`, and the only decode the engine fully specifies
  (§3).

### What pymapconv does today, for reference

| Stage | Windows `[PMC:932-946]` | Linux `[PMC:918]` |
|---|---|---|
| Tile texture | `nvdxt.exe -file temp\temp*.BMP -dxt1a -outsamedir -nmips 4 -Sinc -quality_highest` | `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4` |
| Minimap `[PMC:515,519]` | `nvdxt.exe ... -nmips 9 -Sinc -quality_highest` | `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 9` |

Both operate on 1024x1024 BMP (or TIFF, if the source is RGBA `[PMC:901-903]`) chunks written
to `temp/` `[PMC:904-913]`, optionally sharded across threads. Note the Windows flags shown are the
*defaults*: `-Sinc -quality_highest` is used only when `--nvdxt_options` is not supplied
`[PMC:935, 946]`.

Note `-dxt1a` **explicitly enables the 1-bit-alpha mode**, with the comment at `[PMC:482]`:
`compressionmethod = 'dxt1a' #else we can get spurious alpha pixels in minimap`. Combined with
pymapconv's own loud warning about RGBA sources `[PMC:455-457]` —

> *"MEGA WARNING: Texture image %s is RGBA, thus has an alpha channel. Make absolutely sure that
> you need this or else consider removing the alpha, as this can cause undesired artefacts with
> voidground or voidwater tags!"*

— the practical advice is unambiguous: **feed the compiler an RGB source with no alpha channel**
unless you are deliberately authoring a `voidGround` map.

There is also a pure-Python `pythonEncodeDXT1` `[PMC:137-194]`, a naive bounding-box encoder.
Its own comment reads: *"this is absolutely trashy and slow and only exists because im too lazy
to include a linux compressor ... i havent even tested this yet, dont even think about using
it."* It contains at least three real bugs:

1. `[PMC:162]` — `maxes[c] = max(newpix[c], mins[c])` should be `max(newpix[c], maxes[c])`, so the
   upper bound of the bounding box is never actually tracked.
2. `[PMC:155]` — `mins = [10.0, 10.0, 10.0]` initializes the lower bound to 10 on a 0..255 scale
   instead of to `+inf`/255, so any channel above 10 can never lower it.
3. `[PMC:176]` — `bestdiff` is initialized once *outside* the per-pixel loop and never reset, so
   after the first pixel almost every subsequent pixel keeps the previous `best` index.

It also always writes `max` then `min` as `(color0, color1)` `[PMC:168]`, which does give Mode A
whenever the endpoints differ. **Do not use it as a reference for anything.**

---

## Appendix A — Minimal reader pseudocode

```python
import struct

SMALL_TILE_SIZE = 680
TILE_MIP_OFFSET = (0, 512, 640, 672)
TILE_MIP_BYTES  = (512, 128, 32, 8)
TILE_MIP_DIM    = (32, 16, 8, 4)

def read_smt(path):
    with open(path, 'rb') as f:
        magic, version, num_tiles, tile_size, comp = struct.unpack('<16siiii', f.read(32))
        assert magic.split(b'\0')[0] == b'spring tilefile'
        assert version == 1 and tile_size == 32 and comp == 1
        blob = f.read(num_tiles * SMALL_TILE_SIZE)
        assert len(blob) == num_tiles * SMALL_TILE_SIZE, "truncated .smt"
    return num_tiles, blob

def tile_mip(blob, tile_index, mip):
    base = tile_index * SMALL_TILE_SIZE + TILE_MIP_OFFSET[mip]
    return blob[base : base + TILE_MIP_BYTES[mip]]     # linear DXT1 block raster
```

## Appendix B — Minimal writer pseudocode

```python
def write_smt(path, tiles):        # tiles: list of 680-byte bytes objects
    with open(path, 'wb') as f:
        f.write(struct.pack('<16siiii', b'spring tilefile\0', 1, len(tiles), 32, 1))
        for t in tiles:
            assert len(t) == 680
            f.write(t)

def build_tiles(dxt1_mips, chunk_blocks_w):
    """dxt1_mips[i] = linear DXT1 block raster of the 1024x1024 chunk at mip i.
       Returns the 680-byte tile for tile (tx, ty) within the chunk."""
    def tile_bytes(tx, ty):
        out = b''
        for i in range(4):
            bpr  = chunk_blocks_w >> i          # blocks per row at this mip (256 >> i)
            n    = 8 >> i                       # tile is n x n blocks at this mip
            ox, oy = (tx * 8) >> i, (ty * 8) >> i
            for y in range(n):
                row = ((oy + y) * bpr + ox) * 8
                out += dxt1_mips[i][row : row + n * 8]
        return out
    return tile_bytes
```

## Appendix C — Constant reference

| Constant | Value | Source |
|---|---:|---|
| `SMALL_TILE_SIZE` | 680 | `[FMT:28]` |
| `MINIMAP_NUM_MIPMAP` | 9 | `[FMT:31]` |
| `MINIMAP_SIZE` | 699048 | `[FMT:34]` |
| `SQUARE_SIZE` | 8 | `[GC:24]` |
| `tileScale` | 4 | `[RM.h:181]` |
| `bigSquareSize` | 128 | `[RM.h:182]` |
| `bigTexSize` | 1024 | `[RM:122]` |
| `SMFHeader` size | 80 | `[FMT:49-70]`; verified against a real `.smf` (Appendix D) |
| `MapFeatureStruct` size | 24 | `[FMT:148-157]`, `[PMC:71]` |
| `TILE_MIP_OFFSET` | {0, 512, 640, 672} | `[GT:515]` |
| `TileFileHeader` size | 32 | `[FMT:175-183]`, `[PMC:79]` |
| `MapTileHeader` size | 8 | `[FMT:123-127]`, `[PMC:64]` |
| `texelPerSquare` | 8 | `[FMT:57]` |
| `tilesize` | 32 | `[FMT:58]` |
| DXT1 block size | 8 bytes / 4x4 texels | `[GT:304]` (comment), `[S3TC:659-660]` |

---

## Appendix D — The `.smf` side, verified end to end

The `.smt` is useless without the `.smf` that indexes it. This appendix specifies the whole `.smf`
container, because a writer has to emit both. Layout is from `[FMT:36-157]`; **every offset and
chunk length below was then confirmed byte-exactly against a real shipped map**
(*Red Comet Remake 1.8*, `maps/RCR.smf`, `mapx=768 mapy=512`, 1,807,824 bytes).

### `SMFHeader` — 80 bytes, offset 0

| Off | Size | Type | Field | RCR value |
|---:|---:|---|---|---|
| `0x00` | 16 | `char[16]` | `magic` | `"spring map file\0"` |
| `0x10` | 4 | `int32` | `version` | 1 (engine requires 1 `[MF:18]`) |
| `0x14` | 4 | `int32` | `mapid` | 292 — "sort of a GUID", any value |
| `0x18` | 4 | `int32` | `mapx` | 768 (documented: divisible by 128; **not** checked) |
| `0x1C` | 4 | `int32` | `mapy` | 512 |
| `0x20` | 4 | `int32` | `squareSize` | 8 (engine requires 8 `[MF:24]`) |
| `0x24` | 4 | `int32` | `texelPerSquare` | 8 (engine requires 8 `[MF:22]`) |
| `0x28` | 4 | `int32` | `tilesize` | 32 (engine requires 32 `[MF:20]`) |
| `0x2C` | 4 | `float32` | `minHeight` | 100.0 — world height at heightmap value `0` |
| `0x30` | 4 | `float32` | `maxHeight` | 320.0 — world height at heightmap value `0xffff` |
| `0x34` | 4 | `int32` | `heightmapPtr` | 24668 |
| `0x38` | 4 | `int32` | `typeMapPtr` | 813662 |
| `0x3C` | 4 | `int32` | `tilesPtr` | 1709318 |
| `0x40` | 4 | `int32` | `minimapPtr` | 911966 |
| `0x44` | 4 | `int32` | `metalmapPtr` | 1611014 |
| `0x48` | 4 | `int32` | `featurePtr` | 1807642 |
| `0x4C` | 4 | `int32` | `numExtraHeaders` | 1 |
| `0x50` | — | | **end of header** | |

Field order and types read straight out of `CSMFMapFile::ReadMapHeader` `[MF:293-313]`, which like
the tile-file reader reads each field individually — no struct padding. `struct.calcsize('<16s7i2f7i')`
= **80**, matching the real file.

### Chunk sizes

| Chunk | Length in bytes | RCR |
|---|---|---:|
| Vegetation map (`MEH_Vegetation`) | `(mapx/4) * (mapy/4)` u8 `[FMT:96-97]` | 24,576 |
| Heightmap | `(mapx+1) * (mapy+1) * 2` — `uint16` LE, row-major corner grid `[FMT:62]` | 788,994 |
| Type map | `(mapx/2) * (mapy/2)` u8 `[FMT:63]` | 98,304 |
| Minimap | `MINIMAP_SIZE` = 699,048, fixed `[FMT:34]` | 699,048 |
| Metal map | `(mapx/2) * (mapy/2)` u8 `[FMT:66]` | 98,304 |
| Tiles chunk | `8 + sum(4 + len(name)+1) + (mapx/4)*(mapy/4)*4` | 98,324 |
| Features chunk | `8 + sum(len(typename)+1) + numFeatures*24` | 182 |

### Verified chunk chaining in RCR

```
      0  SMFHeader                                   80 B
     80  ExtraHeader{size=12, type=1, offset=92}     12 B   <- numExtraHeaders = 1
     92  vegetation map      24,576 B  ->    24,668  == heightmapPtr
 24,668  heightmap          788,994 B  ->   813,662  == typeMapPtr
813,662  type map            98,304 B  ->   911,966  == minimapPtr
911,966  minimap            699,048 B  -> 1,611,014  == metalmapPtr
1,611,014 metal map          98,304 B  -> 1,709,318  == tilesPtr
1,709,318 tiles chunk        98,324 B  -> 1,807,642  == featurePtr
1,807,642 features chunk        182 B  -> 1,807,824  == EOF
```

Every arrow lands exactly on the next pointer. Note the chunks are **not** in header-field order —
`minimapPtr` sits between `typeMapPtr` and `metalmapPtr` in the file even though the header lists it
after `tilesPtr`. Nothing requires any particular order; follow the pointers.

### `ExtraHeader`

`[FMT:83-86]` declares only `{int size; int type;}`. In practice, for `type == MEH_Vegetation`
(`1`, `[FMT:103]`) a **third int follows** — the file offset of the vegetation map. pymapconv
documents this gap explicitly at `[PMC:60-63]`:
`ExtraHeader_struct = struct.Struct('< i i i')` with the comment
*"int extraoffset ; //MISSING FROM DOCS, only exists if type=1 (vegmap)"*. RCR confirms it:
`{size=12, type=1, extraoffset=92}`, and 92 = 80 + 12, i.e. the vegmap starts immediately after the
extra header. `size` is the size of the extra header itself (12), not of the data it points at.

### Tiles chunk, exact bytes

```
int32   numTileFiles                 // MapTileHeader [FMT:123-127]
int32   numTiles                     // TOTAL across all files
repeat numTileFiles times:
    int32   tilesInThisFile
    char[]  smtFileName              // NUL-terminated, variable length, <= 255 bytes [GT:134,137]
int32   tileIndex[(mapx/4)*(mapy/4)] // row-major [FMT:119-121]
```

All ten maps sampled in §5 store a bare filename with no directory part (`"RCR.smt"`, 8 bytes with
the NUL).

### `MapFeatureHeader` / `MapFeatureStruct`

```
int32 numFeatureType
int32 numFeatures
char[] featureTypeName   x numFeatureType   // NUL-terminated
MapFeatureStruct         x numFeatures      // 24 bytes each: int32 featureType, then 5 float32
```

`MapFeatureStruct` is `{int featureType; float xpos, ypos, zpos, rotation, relativeSize;}`
`[FMT:148-157]` = **24 bytes**, confirmed by `struct.Struct('< i f f f f f')` `[PMC:71]` and by RCR
(17 type names + 0 features = 8 + 174 + 0 = 182 bytes, landing exactly on EOF). Type names
`TreeType0..TreeType15` and `GeoVent` are the conventional set.

> `rotation` is documented as *"-32768..32767 for full circle"* `[FMT:155]` despite being a
> `float`. **UNVERIFIED — needs confirmation**: the engine-side interpretation of this field was not
> traced to `CFeatureHandler`/`MapFeatureLoader` for this document. If you emit features, verify it.

---

## Verification log

Adversarial re-check performed 2026-09-13. Every claim below was checked against a **primary**
source fetched at that date — engine source via `raw.githubusercontent.com`, the Khronos OpenGL
Registry, encoder repositories, or actual shipped `.smf`/`.smt` binaries downloaded from
`files-cdn.beyondallreason.dev` and md5-verified against the official BAR file index. Nothing below
was checked from memory.

### Format / engine claims

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 1 | `TileFileHeader` = `char[16] magic, int version, int numTiles, int tileSize, int compressionType`; 32 bytes; magic `"spring tilefile\0"` | `SMFFormat.h:175-183`; `SMFMapFile.cpp:341-348` (fields read individually, no padding) | **confirmed** |
| 2 | Engine validation `strcmp(magic)=="spring tilefile" && version==1 && tileSize==32 && compressionType==1` | `SMFGroundTextures.cpp:165` | **confirmed** (line number exact) |
| 3 | `SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6) = 680` | `SMFFormat.h:28` | **confirmed** |
| 4 | `TILE_MIP_OFFSET[] = {0, 512, 640, 672}` | `SMFGroundTextures.cpp:515` | **confirmed** |
| 5 | Blocks within a tile mip are row-major; `sbuf = &tile[b*numBlocks*2]` in 4-byte `GLint` units | `SMFGroundTextures.cpp:519-541` | **confirmed** (doc had cited `519-538`; **corrected**) |
| 6 | Tile lookup `tileMap[tileY * tileMapSizeX + tileX]`, unchecked | `SMFGroundTextures.cpp:530-531` | **confirmed**; doc cited `GT:522` — **corrected** to 530-531 |
| 7 | `tileScale = 4`, `bigSquareSize = 32*tileScale = 128` | `SMFReadMap.h:181-182` | **confirmed** |
| 8 | `numBigTexX = mapx/128`, `bigTexSize = 1024`, `tileMapSizeX = mapx/4`, `tileCount = mapx*mapy/16` | `SMFReadMap.cpp:120-127` | **confirmed** (doc said `120-128`; **corrected**) |
| 9 | `SQUARE_SIZE = 8` | `GlobalConstants.h:24` | **confirmed** |
| 10 | `mapx`/`mapy` "must be divisible by 128" | `SMFFormat.h:54-55` | **corrected**: doc cited `FMT:53`. More importantly, `CSMFMapFile::CheckHeader` (`SMFMapFile.cpp:16-28`) validates only `version`, `tilesize`, `texelPerSquare`, `squareSize`, `magic` — **`mapx` is never checked**. Added to §1 and §4. |
| 11 | `texelPerSquare` at `FMT:56`, `tilesize` at `FMT:57` | `SMFFormat.h:57`, `:58` | **corrected** (off by one) |
| 12 | Tile-index-array doc quote at `FMT:116-118`; per-file accumulation at `FMT:113-115`; `maps/` prefix at `FMT:107-109` | `SMFFormat.h:119-121`, `:115-117`, `:110-113` | **corrected** (all off by 2-3) |
| 13 | Multi-file loop, running `curTile`, `fileNameBuffer[256]`, `0xaa` fill, "MADE RED" log | `SMFGroundTextures.cpp:132-176` (memset at 157, log at 153) | **confirmed** |
| 14 | `tiles.assign(tileHeader.numTiles * SMALL_TILE_SIZE, 0)` sizes the buffer | `SMFGroundTextures.cpp:117` | **confirmed** |
| 15 | `smtFileName%i` override, applied only if count matches | `MapInfo.cpp:421-428`; `SMFGroundTextures.cpp:126-130` | **confirmed** |
| 16 | `voidGround` key, default false | `MapInfo.cpp:110` (`GetBool("voidGround", false)`); `SMFRenderState.cpp:117` | **confirmed** |
| 17 | Diffuse alpha only consumed under `SMF_VOID_GROUND` | `SMFFragProg.glsl:203, 208-218, 337, 379, 387` | **confirmed**, but **gap filled**: `SMF_VOID_WATER` (`:208-211`) also overwrites `groundShadeInt.a`, and `:387` uses `diffuseCol.a` on the non-advanced path. Added. |
| 18 | Uploads `GL_COMPRESSED_RGBA_S3TC_DXT1_EXT`; ETC2 fallback has no alpha | `SMFGroundTextures.cpp:189, 193` | **confirmed** |
| 19 | ETC1 recompress decodes with `squish::Decompress(..., squish::kDxt1)` | `SMFGroundTextures.cpp:292-321` (call at 315) | **confirmed**; doc cited `305-320` and `GT:313` for the 8-byte-block comment (actually `:304`) — **corrected** |
| 20 | Persistent path uploads mips 0-3, `GL_TEXTURE_MAX_LEVEL = 3`, 512 KiB scratch buffer | `SMFGroundTextures.cpp:590-628` (`:605`, `:619`, `:620-625`) | **confirmed**; scratch-buffer cite `GT:608` — **corrected** to `619`. 512 KiB arithmetic (`1024*1024/2/4*4`) re-derived and correct. |
| 21 | `SMFTextureStreaming` defaults false; 120-frame unload | `SMFGroundTextures.cpp:46`; `:368-373` | **confirmed**; doc cited `GT:50` and `GT:365-370` — **corrected** |
| 22 | `static std::vector<char> tiles` | `SMFGroundTextures.h:71` (decl), `.cpp:52` (defn) | **corrected** (doc said `GT:57`) |
| 23 | `MINIMAP_SIZE = 699048` = 9 DXT1 mip levels from 1024x1024 | `SMFFormat.h:31, 34`; arithmetic re-derived | **confirmed** |

### DXT1 / BC1 claims

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 24 | Block = `uint16 color0, uint16 color1, uint32 indices`, little-endian | `EXT_texture_compression_s3tc.txt:679-687` | **confirmed** |
| 25 | `index(x,y) = (indices >> (2*(4*y+x))) & 3`, texel (0,0) = LSBs | S3TC spec `:694-699`; `squish/colourblock.cpp:193-203`; `pymapconv.py:112-117` | **confirmed**; pymapconv cite `PMC:110-115` — **corrected** to `112-117` |
| 26 | Mode select on raw `uint16` compare; Mode B index 3 = black, alpha 0 | S3TC spec `:701-715, 724-728, 734-737`; `squish/colourblock.cpp:176-190`; `pymapconv.py:123, 128` | **confirmed**; pymapconv cite `PMC:118,126` — **corrected** to `123, 128` |
| 27 | 5/6-bit -> 8-bit expansion is unspecified / decoders vary | `squish/colourblock.cpp:140-158` — engine uses **bit replication** `(v<<3)\|(v>>2)`, `(v<<2)\|(v>>4)`, and interpolates in **888 space with truncating division**; `rgbcx.h:79-94` enumerates the four vendor models; `stb_dxt.h:73-81` documents the rounding-bias split | **gap filled** — this was an open question. The engine's CPU path is now fully specified in §3; only the GPU path remains vendor-dependent, and the known variants are now named. |
| 28 | Missing-`.smt` fill `0xaa` renders as `rgb(168,84,80)` | Recomputed with the engine's own `Unpack565` | **corrected** to **`rgb(173,85,82)`**; the old figure used a bare shift, not the engine's bit replication. Both now given. |

### pymapconv claims

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 29 | `TileFileHeader_struct = struct.Struct('< 16s i i i i')`, written with `(magic, 1, len(tilehash), 32, 1)` | `pymapconv.py:79`, `:1013` | **confirmed** |
| 30 | `ReadTile` cuts tile mips out of the 1024x1024 chunk's mips | `pymapconv.py:953-965` | **confirmed** (offsets `524288 >> 2i`, stride `256 >> i` re-derived) |
| 31 | Dedup is a dict keyed on all 680 bytes, first-seen-wins, global across chunks | `pymapconv.py:976-1001`, `:1014-1018` | **confirmed**; range cite `975-1001` — **corrected** to `976-1001` |
| 32 | `# TODO: tilehash is larger than max tiles sometimes!` | `pymapconv.py:1003` | **confirmed** it exists; **root cause UNVERIFIED** — see §7. Evidence added: two shipped maps really do have `numTiles == tileCount + 1` with one unreferenced tile, which pymapconv's own loop cannot produce, suggesting different tooling. |
| 33 | `numtilefiles = 1` hardcoded; `.smt` named by extension substitution | `pymapconv.py:1039`, `:1006` | **confirmed** |
| 34 | Texture dims must be multiples of 1024 | `pymapconv.py:446-448` | **confirmed**; cite `447-449` — **corrected** |
| 35 | TIFF only when source is RGBA | `pymapconv.py:901-903` | **confirmed**; cite `903-905` — **corrected** |
| 36 | Linux `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4`; Windows `nvdxt.exe -dxt1a ... -nmips 4 -Sinc -quality_highest` | `pymapconv.py:918`, `:932-946`, `:515`, `:519` | **confirmed**; **gap filled**: `-Sinc -quality_highest` is only the default when `--nvdxt_options` is unset (`:935, :946`) |
| 37 | `pythonEncodeDXT1` has a bounding-box bug at `PMC:160` | `pymapconv.py:137-194` | **corrected** to `:162`, and **two further bugs added**: `mins` initialized to `10.0` (`:155`) and `bestdiff` never reset per pixel (`:176`) |
| 38 | Repo is `Beherith/springrts_smf_compiler`, not `Spring_SMF_compiler` | HTTP status check: `Spring_SMF_compiler` -> **404**, `springrts_smf_compiler` -> **200** | **confirmed** |

### Empirical claims (previously unmeasured — the researcher's open question #1)

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 39 | `.smt` size `== 32 + numTiles * 680` | 10 shipped BAR `.smt` files, parsed | **confirmed on all 10** |
| 40 | "Typical" dedup ratio | Hashed every stored 680-byte tile in all 10 maps | **gap filled**: dedup is effectively **zero**. 9/10 maps store 100% byte-distinct tiles at >= `tileCount`; only Boreal Falls dedups at all (50,136 / 50,176 = **0.08%**). §5 rewritten around the measurement. |
| 41 | "DXT1 data is already high-entropy so the archive compresses it very little" | LZMA'd sizes of the `.smt` member inside each `.sd7` | **corrected — this was wrong.** Measured **31.0%-58.1%** (median ~49%), i.e. roughly **2:1**. §7 rewritten. |
| 42 | Multi-`.smt` maps exist in practice (open question #4) | `numTileFiles` in all 10 maps; GitHub code search for `smtFileName1` | **gap filled**: all 10 have `numTileFiles == 1`; every `smtFileName1` hit is a commented-out template line. `smtFileName0` **is** used in practice (SpringBoard-Core `export_map_info_command.lua:180`, `lhog/spring-map-pbr`, `beyond-all-reason/map_blueprint`), always with a `maps/` prefix that resolves via the VFS fallback `[GT:148-149]`. |
| 43 | `mapx`/`mapy` are independent; "N must be even" | Real headers: 768x512, 1536x768, 1024x768, 384x256, 896x896, … | **confirmed**; **gap filled**: added an explicit note that maps are routinely non-square, since every worked example in the doc was square. |
| 44 | Whole `.smf` chunk layout (open question #6) | `SMFFormat.h:36-157` + byte-exact walk of `RCR.smf` | **gap filled**: new Appendix D. Every pointer chains exactly (`80 -> 92 -> 24,668 -> 813,662 -> 911,966 -> 1,611,014 -> 1,709,318 -> 1,807,642 -> EOF`). `SMFHeader` = **80 bytes**, `MapFeatureStruct` = **24 bytes**, and the undocumented third `int` in `ExtraHeader` for `type == 1` is confirmed (`{12, 1, 92}`). |

### Encoder / license claims

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 45 | stb_dxt "Public domain"; has an ordered-dither option `STB_DXT_DITHER` | `stb_dxt.h` v1.12, lines 1, 55-56, 683, 702 | **corrected twice**: it is dual **public-domain or MIT**, and `STB_DXT_DITHER` is *"deprecated. does nothing!"* — the doc's advice about it was obsolete |
| 46 | stb_dxt always emits 4-color mode for opaque input | `stb_dxt.h:494-498, 526-530` (endpoint swap so `max16 > min16`) | **confirmed** |
| 47 | rgbcx "MIT / public domain", levels 0-18, "prioritized cluster fit 3-4x faster than libsquish cluster fit at same or better quality" | `rgbcx.h:3, 236`; `richgel999/bc7enc` README lines 10, 14 | **confirmed** (flagged in-doc as the author's own benchmark, not independently reproduced) |
| 48 | ispc_texcomp "~33.1 dB on BC1" | Searched `bc7enc_rdo` and `bc7enc` READMEs | **not found — removed** and marked UNVERIFIED. License MIT **confirmed** via GitHub API. |
| 49 | libsquish is vendored at `rts/lib/squish` and is MIT | GitHub contents API on `RecoilEngine/rts/lib/squish`; license API on `svn2github/libsquish` | **confirmed** |
| 50 | Compressonator MIT; icbc MIT; Basis Universal Apache-2.0 | GitHub license API (`icbc` MIT, `basis_universal` Apache-2.0); Compressonator text at `license/license.txt` | **confirmed**; noted that GitHub reports no license for Compressonator only because the file is not at the repo root |

### Still unverified

- **Root cause of `numTiles > tileCount`** (§7). Measured to be real in two shipped maps; the
  producing tool was not identified.
- **Exact GPU-side BC1 interpolation on any specific target** (§3). The four candidate models are now
  named and the engine's CPU decode is pinned, but which one a given driver uses was not tested
  against hardware.
- **`MapFeatureStruct.rotation` units** (Appendix D). The header comment says `-32768..32767` for a
  `float` field; the engine-side consumer was not traced.
- **ispc_texcomp BC1 PSNR figure** (§8). Removed rather than guessed.
