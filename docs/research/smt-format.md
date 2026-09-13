# SMT Tile File Format & Texture Pipeline

Complete specification of the Spring Map Tiles (`.smt`) format and the map diffuse-texture
pipeline, as implemented by the **Recoil engine** (Beyond All Reason) and the **pymapconv**
compiler.

All byte layouts, constants and formulas below are quoted from source. Citations are inline as
`repo :: path :: line`.

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
| `[PMC]` | [`src/pymapconv.py`](https://github.com/Beherith/springrts_smf_compiler/blob/master/src/pymapconv.py) — note the repo is **`Beherith/springrts_smf_compiler`**, not `Spring_SMF_compiler` (that URL 404s) |

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

The reader `CSMFMapFile::ReadMapTileFileHeader` `[MF:341-348]` reads the fields **individually**,
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
(`for y in range(yp): for x in range(xp)`) and by the reader `[GT:519-538]`
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

Confirmed by the reference decoder `[PMC:96-105]`:

```python
c0, c1, bits = struct.unpack('<HHI', data[xb*8 : xb*8+8])
b0 =  (c0        & 0x1f) << 3
g0 = ((c0 >>  5) & 0x3f) << 2
r0 = ((c0 >> 11) & 0x1f) << 3
```

(The `<< 3` / `<< 2` is the cheap 5/6-bit -> 8-bit expansion; a higher-quality expansion is
`(v << 3) | (v >> 2)` for 5-bit and `(v << 2) | (v >> 4)` for 6-bit. Decoders vary; encoders
should assume the hardware's exact expansion is unspecified.)

### Index bit order

`[PMC:110-115]` consumes the index word two bits at a time, LSB first, in
`for yo in range(4): for xo in range(4)` order. So:

```
index of texel (x, y)  =  (indices >> (2 * (4*y + x))) & 3
```

Texel (0,0) is the **top-left** of the block and uses the **two least significant bits**.

### The two modes — and which one you may emit

The mode is selected by comparing `color0` and `color1` **as unsigned 16-bit integers**
`[PMC:118, 126]` (`if c0 > c1`):

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
  *does* decode index 3 of Mode B as transparent black. Nothing rejects it.
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
  `mapinfo.lua` `[MI:110]`. On a normal map `groundShadeInt.a` stays `1.0` and the diffuse
  alpha is discarded. `[FS:387]` also writes `fragColor.a = diffuseCol.a` in the non-advanced
  path.
- **The ETC1 fallback destroys alpha entirely.** On drivers without S3TC, `RecompressTilesIfNeeded`
  `[GT:305-320]` decodes each block with `squish::Decompress(rgba, &tiles[i*8], squish::kDxt1)`
  and re-packs as `GL_COMPRESSED_RGB8_ETC2` `[GT:189]`, which has **no alpha channel at all**.
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
| `texelPerSquare` | `8` texels per map square | `[FMT:56]` ("must be 8 for now") |
| `tilesize` | `32` texels per tile | `[FMT:57]` ("must be 32 for now") |
| `tileScale` | `4` map squares per tile | `[RM.h:181]` `static constexpr int tileScale = 4;` |
| `bigSquareSize` | `32 * tileScale` = `128` map squares | `[RM.h:182]` |
| `mapx`, `mapy` | map size in squares; **must be divisible by 128** | `[FMT:53-54]` |

`tileScale = 4` is exactly `tilesize / texelPerSquare = 32 / 8`.

### Derived dimensions `[RM:120-128]`

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

`[FMT:116-118]`:

> *After this follows an `int[mapx*texelPerSquare/tileSize * mapy*texelPerSquare/tileSize]`
> (this is `int[mapx/4 * mapy/4]` with currently hardcoded texelPerSquare=8 and tileSize=32)
> which are indices to the defined tiles.*

Stored **row-major**, `int32 LE`, immediately after the `MapTileHeader` + per-file
`(count, filename)` records. The engine slurps it in one read `[GT:178]`:

```cpp
ifs->Read(&tileMap[0], smfMap->tileCount * sizeof(int));
```

Lookup, from `ExtractSquareTiles` `[GT:522]`:

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
`[GT:508-547]`, then uploading with `glCompressedTexImage2D` `[GT:582 / 611]`.

`LoadSquareTexturePersistent` `[GT:590-625]` (the default, `SMFTextureStreaming = false`)
uploads all four mip levels `0..3` with `GL_TEXTURE_MAX_LEVEL = 3`. The streaming mode
`[GT:549-588]` instead uploads a single level chosen by distance/stretch heuristics
`[GT:340-430]`, which is why its docstring says it gives "worse performance and image quality"
`[GT:50]`.

Note `GL_TEXTURE_MAX_LEVEL = 3` on a 1024x1024 texture: the mip chain **stops at 128x128**.
There is no 64x64-and-below mip for the ground diffuse — minification below that relies on the
map's separate minimap texture and on the detail/splat textures.

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

> **Caution on "NxN" map sizes.** Not every `N` is legal. The hard constraint is
> `mapx % 128 == 0` `[FMT:53]`, i.e. `64*N % 128 == 0`, i.e. **`N` must be even**. A "17x17" or
> "23x23" map cannot exist. Odd-sounding BAR map names refer to elmo extents, not to `N`.
> pymapconv additionally rejects any source texture whose dimensions are not a multiple of 1024
> `[PMC:447-449]`, which enforces exactly the same thing.

---

## 5. Tile deduplication

### How pymapconv dedups

Dead simple and fully lossless: **a Python dict keyed on the raw 680 tile bytes**
`[PMC:975-1001]`.

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

Practical guidance:
- **Photographic / noisy / procedurally-textured terrain**: near-zero dedup. Expect 90-100% of
  tiles unique. This is the common case for modern BAR maps, which is why their `.smt` files land
  close to the "zero dedup" sizes computed in §4.
- **Large flat uniform regions** (deep water, solid black void, unpainted areas): excellent
  dedup, since a constant-color region collapses to a single tile. A map with a big ocean can
  drop noticeably.
- **Hand-tiled / stamped textures with pixel-exact repetition**: excellent dedup, but only if the
  repetition is aligned to the 32-texel tile grid *and* to the 1024-texel chunk grid (because of
  the shared-mip issue).

Because dedup is exact-match, the reliable way to raise it is to make the source texture actually
repeat on a 32-texel grid, or to flatten uniform areas to a constant color before compiling.

### Does the engine require unique tiles?

**No.** The engine never inspects tile content. Nothing dedups, nothing validates uniqueness,
nothing complains about duplicates. `tileMap` is a plain index array `[GT:522]`, and multiple
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

`[FMT:113-115]`:

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
path. `[FMT:107-109]` notes the engine prepends `maps/` when searching the VFS.

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
> MADE RED"*, and it is telling the truth. Decoding the fill: `c0 = c1 = 0xAAAA`
> (`0b1010101010101010`), so
> R = bits 15..11 = `0b10101` = 21 -> ~168,
> G = bits 10..5 = `0b010101` = 21 -> ~84,
> B = bits 4..0 = `0b01010` = 10 -> ~80.
> `indices = 0xAAAAAAAA`, i.e. every 2-bit pair is `0b10` = index 2; since `c0 == c1` this is
> Mode B and index 2 = `(c0+c1)/2` = the same color. Every texel is therefore a uniform
> desaturated brick red, **`rgb(168,84,80)`**. If your whole map renders in flat brick red, the
> engine could not open the `.smt`.

### pymapconv only ever writes one

pymapconv hardcodes `numtilefiles = 1` `[PMC:1039]` and names the `.smt` by substituting the
extension: `smtfilepath = myargs.outfile.replace('.smf', '.smt')` `[PMC:1006]`. Multi-SMT maps
must be produced by other tooling, or by sharing one `.smt` across several `.smf` files — which
is the feature's original purpose `[FMT:20-22]`: *"This file can be shared between different
maps."*

---

## 7. Practical limits, file size, memory cost

### Hard format limits

| Limit | Value | Why |
|---|---|---|
| Max tiles per file | `2^31 - 1` | `TileFileHeader.numTiles` is `int32` |
| Max total tiles | `2^31 - 1` | `MapTileHeader.numTiles` is `int32` |
| Max tile index | `2^31 - 1` | `tileMap` is `int32[]` `[GT:178]`; values are signed |
| Max SMT filename | 255 bytes | `char fileNameBuffer[256]` with `sizeof(buffer)-1` read `[GT:134,137]` |
| Tile size | fixed 32 | `tfh.tileSize != 32` -> `content_error` `[GT:165]` |
| Compression | fixed DXT1 | `tfh.compressionType != 1` -> `content_error` `[GT:165]` |

### The limit that actually binds

The *useful* upper bound on unique tiles is `tileCount = mapx*mapy/16` — beyond that you'd have
more tiles than index slots. pymapconv prints exactly this as the maximum `[PMC:1004]` and carries
a live `# TODO: tilehash is larger than max tiles sometimes!` `[PMC:1003]`, which means the
compiler has been observed producing more unique tiles than the nominal maximum. (This is
possible because `len(tilehash)` counts distinct byte strings while the "maximum" is the index
count; they can only diverge if a tile is counted more than once, so treat this as a known
compiler wart rather than a format property.)

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
is download size — maps ship as `.sd7`/`.sdz` archives, and the `.smt` is the dominant member;
DXT1 data is already high-entropy so the archive compresses it very little.

### Memory cost

**System RAM** — the engine holds every tile, permanently, for the whole game `[GT:117]`:

```
RAM_for_tiles = numTiles * 680 bytes
```

This is a `static std::vector<char> tiles` `[GT:57]`, never freed while the map is loaded. For a
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
distant squares drop to level 3 after 120 unseen frames `[GT:365-370]`, trading image quality and
performance for VRAM `[GT:50]`.

**Transient**: `LoadSquareTexturePersistent` allocates one
`std::vector<GLint> tilesBuffer(bigTexSize*bigTexSize/2/sizeof(GLint))` = 512 KiB per square,
reused across mip levels `[GT:608]`.

### Unchecked-input gotchas (relevant if you generate `.smt`/`.smf` yourself)

1. **`tileMap` values are never bounds-checked.** `[GT:522]` does
   `tiles[tileIdx * SMALL_TILE_SIZE + mipOffset]` with no validation of `tileIdx` against
   `numTiles`. An out-of-range index is an out-of-bounds read — garbage tiles or a crash.
   Negative indices are equally unchecked.
2. **`TileFileHeader.numTiles` is read but not used to size the read.** The engine reads
   `numSmallTiles` tiles, where `numSmallTiles` comes from the **`.smf`** `[GT:136, 173]`. If the
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
   compounds. This is exactly what the ETC1 fallback path does `[GT:305-320]`, and it is
   acknowledged as a quality loss.

### Open-source encoders

| Encoder | Language / usable from | Quality | Speed | Notes |
|---|---|---|---|---|
| **[stb_dxt](https://github.com/nothings/stb/blob/master/stb_dxt.h)** | single-header C, trivial WASM/native; ~700 lines | Fair (`STB_DXT_HIGHQUAL` = good) | Very fast | Public domain. The pragmatic default: zero dependencies, compiles to WASM in seconds, no build system. Does a PCA-ish endpoint fit plus iterative refinement. Has a built-in optional dither (`STB_DXT_DITHER`) — but it is ordered dither and generally considered inferior to just using a better encoder. Always emits 4-color mode for opaque input. **Best starting point for a JS/WASM tool.** |
| **[rgbcx.h](https://github.com/richgel999/bc7enc_rdo/blob/master/rgbcx.h)** (bc7enc / bc7enc_rdo, Rich Geldreich) | single-header C++, WASM-friendly | **Best CPU BC1 quality available** | Fast-to-moderate, level-tunable 0-18 | MIT / public domain. Uses "prioritized cluster fit", 3-4x faster than libsquish's cluster fit at equal-or-better quality. Levels 0-4 compete with stb_dxt; higher levels beat squish/NVTT/icbc. Geldreich's own Pareto analysis puts rgbcx on the BC1 frontier at every quality level above ispc_texcomp's fastest point. **The quality choice.** `bc7enc_rdo` additionally offers RDO (rate-distortion optimization) — it deliberately makes blocks more similar to improve downstream LZ compression. Note: RDO would also *increase SMT tile dedup*, which is an unusually good fit for this format. |
| **[ispc_texcomp](https://github.com/GameTechDev/ISPCTextureCompressor)** (Intel) | ISPC -> native lib; awkward from WASM | Good | **Fastest** (SIMD, multi-ISA) | MIT. Defines the low-quality/high-speed end of the Pareto frontier (~33.1 dB on BC1). Requires the ISPC compiler in your build, and the SIMD focus makes WASM deployment painful. Choose it for bulk native pipelines, not for a browser tool. |
| **[libsquish](https://github.com/svn2github/libsquish)** | C++, easy native, WASM-able | Good (cluster fit) | Slow | MIT. **Already vendored in the engine at `rts/lib/squish`** and used by `RecompressTilesIfNeeded` `[GT:315]` — so it is the reference implementation for "what Recoil considers a correct DXT1 decode". Its `kColourClusterFit` + `kColourMetricPerceptual` flags give solid perceptual quality. Superseded on quality-per-time by rgbcx, but its presence in-engine makes it a safe compatibility baseline. |
| **[Basis Universal](https://github.com/BinomialLLC/basis_universal)** | C++ / JS+WASM build shipped | N/A — transcoder | — | Apache-2.0. **Not an appropriate choice here.** Basis is a *supercompressed intermediate* that transcodes to BC1 at load time; its BC1 output is deliberately quality-limited to keep transcoding cheap. SMT needs final, canonical BC1 bytes. Its BC1 *transcoder* is however a well-tested reference decoder if you need one. |
| **[icbc](https://github.com/castano/icbc)** (Ignacio Castaño, ex-NVTT) | single-header C++ | Very good (`icbc HQ`) | Moderate | MIT. The quality core extracted from NVIDIA Texture Tools. Competitive with rgbcx's high levels. Good second opinion / cross-check. |
| **[Compressonator](https://github.com/GPUOpen-Tools/compressonator)** (AMD) | CLI + lib | Good, tunable | Moderate | MIT. **This is what pymapconv actually uses on Linux** `[PMC:918]`: `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4`. The `-RefineSteps 2` flag is its endpoint-refinement iteration count. |
| **nvdxt.exe** (NVIDIA, legacy) | Windows binary only | Good | Slow | **Not open source, Windows-only, long deprecated.** pymapconv's Windows path shells out to it `[PMC:932-946]` with `-dxt1a -Sinc -quality_highest`. `-Sinc` is the mip filter; `-quality_highest` maximizes search. A modern rewrite should drop this entirely. |

### Recommendation for a from-scratch implementation

- **Prototype**: `stb_dxt.h` with `STB_DXT_HIGHQUAL`. One file, compiles to WASM immediately,
  correct 4-color-mode output, good enough to validate the whole pipeline.
- **Ship**: `rgbcx.h` at level 10-18 with perceptual weighting. Same integration story
  (single header, WASM-friendly), materially better output, and `bc7enc_rdo`'s RDO mode is a
  genuine synergy with SMT's exact-match tile dedup.
- **Validate**: decode with `libsquish` (`squish::kDxt1`) and compare against the engine's own
  decode path — that is literally the code Recoil runs `[GT:315]`.

### What pymapconv does today, for reference

| Stage | Windows `[PMC:932-946]` | Linux `[PMC:918]` |
|---|---|---|
| Tile texture | `nvdxt.exe -file temp\temp*.BMP -dxt1a -outsamedir -nmips 4 -Sinc -quality_highest` | `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 4` |
| Minimap `[PMC:515,519]` | `nvdxt.exe ... -nmips 9 -Sinc -quality_highest` | `CompressonatorCLI -fd DXT1 -RefineSteps 2 -miplevels 9` |

Both operate on 1024x1024 BMP (or TIFF, if the source has alpha `[PMC:903-905]`) chunks written
to `temp/`, optionally sharded across threads.

Note `-dxt1a` **explicitly enables the 1-bit-alpha mode**, with the comment at `[PMC:482]`:
`compressionmethod = 'dxt1a' #else we can get spurious alpha pixels in minimap`. Combined with
pymapconv's own loud warning about RGBA sources `[PMC:455-457]` —

> *"MEGA WARNING: Texture image %s is RGBA, thus has an alpha channel. Make absolutely sure that
> you need this or else consider removing the alpha, as this can cause undesired artefacts with
> voidground or voidwater tags!"*

— the practical advice is unambiguous: **feed the compiler an RGB source with no alpha channel**
unless you are deliberately authoring a `voidGround` map.

There is also a pure-Python `pythonEncodeDXT1` `[PMC:137-190]`, a naive bounding-box encoder.
Its own comment reads: *"this is absolutely trashy and slow and only exists because im too lazy
to include a linux compressor ... i havent even tested this yet, dont even think about using
it."* It additionally contains a real bug at `[PMC:160]` —
`maxes[c] = max(newpix[c], mins[c])` should be `max(newpix[c], maxes[c])` — so it does not
compute a correct bounding box. **Do not use it as a reference.**

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
| `TileFileHeader` size | 32 | `[FMT:175-183]`, `[PMC:79]` |
| `MapTileHeader` size | 8 | `[FMT:123-127]`, `[PMC:64]` |
| `texelPerSquare` | 8 | `[FMT:56]` |
| `tilesize` | 32 | `[FMT:57]` |
| DXT1 block size | 8 bytes / 4x4 texels | `[GT:313 comment]` |
