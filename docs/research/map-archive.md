# BAR Map Archive Layout, Packaging & Publishing

Everything a map *builder* needs to emit an archive that Beyond All Reason / the Recoil engine
can actually open, index and render — plus how that archive reaches the live BAR map pool.

All engine claims below are taken from source at
`https://github.com/beyond-all-reason/RecoilEngine` (branch `master`, read 2026‑09‑13) and from
the vendored 7‑Zip SDK in `https://github.com/beyond-all-reason/pr-downloader`
(`src/lib/7z/`, which is where the engine's `7zip` CMake target comes from — see
`rts/CMakeLists.txt:88` and `rts/System/FileSystem/Archives/CMakeLists.txt:45`).

> **Adversarially re‑checked 2026‑09‑13.** Every load‑bearing claim below was re‑verified against
> primary sources (raw engine source fetched with `curl`, a fresh clone of `maps-metadata@main`,
> Beherith's `pymapconv` source, and a re‑download + re‑parse of `comet_catcher_remake_1.8.sd7`).
> Line numbers were corrected throughout, five substantive claims were corrected (see
> **Verification log** at the end: §2.1 `modinfo.lua`, §5.1 `bitmaps/foam.jpg`, §5.7
> `splatDetailTex`, §8 `derived_map_info` defaults, §10 `atmosphere.skyDir`), and everything that
> could not be confirmed from a primary source is now marked
> **UNVERIFIED — needs confirmation** inline.

All "what real BAR maps do" claims are measured from actual `.sd7` files downloaded from the BAR
CDN on 2026‑09‑13:

| archive | springname | map | engine dims |
|---|---|---|---|
| `comet_catcher_remake_1.8.sd7` (41.5 MB) | `Comet Catcher Remake 1.8` | 16×12 | mapx=1024 mapy=768 |
| `hooked_1.1.1.sd7` (20.2 MB) | `Hooked 1.1.1` | 6×4 | mapx=384 mapy=256 |
| `speedmetal_bar_v2.sd7` (25.7 MB) | `SpeedMetal BAR V2` | 26×4 | mapx=1664 mapy=256 |
| `coast_to_coast_bar_v1.0.sd7` (29.9 MB) | `Coast To Coast BAR v1.0` | 12×8 | mapx=768 mapy=512 |
| `altair_crossing_v4.1.sd7` (24.0 MB) | `Altair_Crossing_V4.1` | 8×8 | mapx=512 mapy=512 |
| `boreal_falls_1.0.2.sd7` (47.9 MB) | `Boreal Falls 1.0.2` | 14×14 | mapx=896 mapy=896 |

---

## 0. TL;DR for the builder

Emit **one non‑solid LZMA2 `.sd7`** whose filename is lowercase, space‑free, ends in `.sd7`,
containing at minimum:

```
mapinfo.lua                 <- Lua table; makes the archive a MAP archive
maps/<Name>.smf             <- terrain
maps/<Name>.smt             <- tile atlas, referenced by name from inside the .smf
```

and in practice also `maps/*.dds|tga|png|bmp` (normal / specular / splat‑distribution / 4 DNTS
normals / detail tex), `features/*.lua` + `objects3d/*.s3o` + `unittextures/*.tga` for decoration,
`mapconfig/featureplacer/{config,set}.lua` + `LuaGaia/{main,draw}.lua` +
`LuaGaia/Gadgets/FP_featureplacer.lua` to place them, `maphelper/mapinfo.lua`
(a one‑line back‑compat shim), and `mapoptions.lua`.

Pack with:

```
7z a -t7z -m0=lzma2 -mx=9 -ms=off -mmt=on out/<name>.sd7 ./<staging>/*
```

`-ms=off` (non‑solid) is **mandatory in practice** — BAR's CI rejects solid archives outright and the
whitelist is empty (`check_archive_not_solid.ts`). The *engine's* own class‑1 rejection path exists but
is currently **dormant** on RecoilEngine master (nothing overrides `HasLowReadingCost()`, §1.4), so a
solid archive still loads — just serialised onto one thread. Ship non‑solid anyway.

> ⚠ The flag set above is **inferred**, not quoted from BAR documentation. See the verification log:
> no `7z a` / `-ms=off` command line appears anywhere in the `beyond-all-reason` GitHub org or in the
> public mapping guides. What *is* measured is the result: all six sampled archives are LZMA2,
> `solid = False`, one folder per file — which is what `-t7z -m0=lzma2 -ms=off` produces. Dictionary
> size, `fb` and `mt` remain **UNVERIFIED — needs confirmation**.

---

## 1. Archive formats and the exact compression subset the engine supports

### 1.1 The five archive types

`rts/System/FileSystem/ArchiveLoader.cpp:19-34` registers exactly five factories, keyed on the
**lower‑cased file extension** (`ArchiveLoader.cpp:50`, `:65`):

| ext | class | `ARCHIVE_TYPE_*` | source |
|---|---|---|---|
| `sdp` | `CPoolArchive` | `SDP = 0` | rapid pool index |
| `sdd` | `CDirArchive` | `SDD = 1` | a plain **directory** on disk named `X.sdd` |
| `sdz` | `CZipArchive` | `SDZ = 2` | PKZIP, via bundled minizip + zlib |
| `sd7` | `CSevenZipArchive` | `SD7 = 3` | 7z, via the LZMA SDK `SzArEx_*` API |
| `sdv` | `CVirtualArchive` | `SDV = 4` | in‑memory, engine‑internal |

(`rts/System/FileSystem/Archives/ArchiveTypes.h:6-14`. The same enum also carries
`ARCHIVE_TYPE_CNT = 5` and `ARCHIVE_TYPE_BUF = 6`; neither is a loadable file type.)
The extension each factory claims is **not** hard‑coded in `ArchiveLoader` — it comes from
`factory.GetDefaultExtension()` (`ArchiveLoader.cpp:28`), and dispatch is a `std::lower_bound` over the
sorted `{extension, factory}` list (`:55`, `:71`).

Extension → factory is an exact string match on the lowercase extension, so `MyMap.SD7` works but
`MyMap.7z` does **not**.

**What BAR actually uses:** every one of the 226 maps in `maps-metadata/map_list.yaml` resolves
through the CDN to a `.sd7` file. Queried all 226 `springName`s against
`https://files-cdn.beyondallreason.dev/find?category=map&springname=…`: extension histogram
`{'sd7': 226}`; zero filenames contained a space or an uppercase letter. `.sdz` is *permitted* by
the metadata schema but unused in the pool.

`.sdd` is the development format — a directory whose name ends in `.sdd`, scanned recursively
(`Archives/DirArchive.cpp:37`, `FileQueryFlags::RECURSE`). It is the only archive type whose
`mapinfo.lua` mtime the scanner re‑checks, so edits are picked up without a cache bump
(`ArchiveScanner.cpp:814-818`). Use `.sdd` while iterating, `.sd7` to ship.

### 1.2 `.sd7` — which 7z features decode

The engine only ever calls `SzArEx_Open()` / `SzArEx_Extract()`
(`Archives/SevenZipArchive.cpp:284`, `:222`). Everything is therefore gated by `7zDec.c`'s
`CheckSupportedFolder()` and `SzFolder_Decode2()`.

**Compression methods accepted as the "main" coder** — `7zDec.c:279-294`:

```c
static BoolInt IS_MAIN_METHOD(UInt32 m) {
  switch (m) {
    case k_Copy:            /* 0x00      — store           */
    case k_LZMA:            /* 0x030101  — LZMA            */
    #ifndef _7Z_NO_METHOD_LZMA2
    case k_LZMA2:           /* 0x21      — LZMA2           */
    #endif
    #ifdef _7ZIP_PPMD_SUPPPORT
    case k_PPMD:            /* 0x30401 (7zDec.c:41)         */
    #endif
      return True;
  }
  return False;
}
```

and `7zDec.c:8` says:

```c
/* #define _7ZIP_PPMD_SUPPPORT */
```

— **commented out**. ⇒ **PPMd is NOT compiled in.** A `.sd7` written with `-m0=PPMd` opens as
`SZ_ERROR_UNSUPPORTED` ("Unsupported archive", `SevenZipArchive.cpp:112`) and the archive is
recorded as broken.

**Filters accepted as a second coder** — `7zDec.c:320-350`: `k_Delta (3)`, `k_BCJ (0x3030103)`,
`k_PPC`, `k_IA64`, `k_ARM`, `k_ARMT`, `k_SPARC`. Plus the 4‑coder `k_BCJ2 (0x303011B)` layout
(`7zDec.c:353-370`). So 7‑Zip's automatic x86 filter on executables is fine; there are none in a
map anyway.

**Folder shape limits** (`CheckSupportedFolder`, `7zDec.c:306-373`): `NumCoders` must be 1, 2 or 4;
with 2 coders exactly one bond `1→0` and one pack stream; the 4‑coder form must be exactly the
BCJ2 topology. Anything else ⇒ `SZ_ERROR_UNSUPPORTED`.

**Encryption: unsupported.** `7zDec.c` never references AES/`k_AES (0x06F10701)`; `Aes.c` is
compiled into the `7zip` target for pr‑downloader's own use but is not wired into the folder
decoder. So:
* `-p<password>` (data encryption) ⇒ archive unreadable.
* `-mhe=on` (encrypted headers) ⇒ `SzArEx_Open()` fails; the archive won't even list.

**Compressed (non‑encrypted) headers are fine.** 7‑Zip's default `-mhc=on` LZMA‑codes the metadata
block, and `SzArEx_Open` decodes it through the same `SzFolder_Decode2` path that already supports
LZMA. Every real BAR `.sd7` measured has a small compressed header (e.g. Comet Catcher
`header_size = 1690` for 83 entries).

**Filename encoding.** Names are stored UTF‑16 in 7z and converted to UTF‑8
(`SevenZipArchive.cpp:27-90`). `GetFileName()` uses a **2048‑element buffer** and returns
`std::nullopt` (file silently skipped, with an error log) if `SzArEx_GetFileNameUtf16` reports
`utf16len >= 2048` (`SevenZipArchive.cpp:74-81`). Keep paths well under 2048 UTF‑16 code units.

**Per‑file size is truncated to `int`.** `SevenZipArchive.cpp:152` casts
`SzArEx_GetFileSize()` to `int`, and `IArchive::ExtractedSize()` accumulates into `uint32_t`
("no archive should be larger than 4GB when extracted", `Archives/IArchive.h:93-103`). Keep every
single file < 2 GiB and the whole uncompressed archive < 4 GiB. Real maps are 37–90 MB packed /
37–120 MB unpacked.

**Directory entries are skipped** (`SzArEx_IsDir`, `SevenZipArchive.cpp:140-142`), so it does not
matter whether you store them. 7‑Zip stores them by default; Comet Catcher's archive contains 22
directory entries and 61 file entries.

### 1.3 `.sdz` — which zip features decode

`CZipArchive` uses the vendored minizip (`rts/lib/minizip/unzip.c`) over zlib.

* **Encryption is compiled out.** `rts/lib/minizip/CMakeLists.txt:21` —
  `add_definitions(-DNOCRYPT -DNOUNCRYPT)`, inside the `else(MINIZIP_FOUND)` branch that builds the
  vendored copy. (A build that finds a *system* minizip does not get those defines; every official
  Recoil/BAR build uses the vendored one.) Encrypted entries are unreadable.
* **Methods:** store (`0`) and **deflate** (`Z_DEFLATED = 8`) only.
  `unzip.c:1402-1408` also *lets through* `Z_BZIP2ED (12)`, but `unzip.c:1420-1445` only
  initialises a bzip2 stream `#ifdef HAVE_BZIP2`, which the engine's build never defines —
  the `#else` branch sets `raw = 1`, so you get the *compressed bytes* back as file content.
  **Never use bzip2 in a `.sdz`.** Deflate64, LZMA‑in‑zip, zstd‑in‑zip, XZ‑in‑zip: all rejected
  (`err = UNZ_BADZIPFILE`).
* **ZIP64:** minizip parses the ZIP64 end‑of‑central‑directory and ZIP64 extra fields
  (`unzip.c:925`), but the engine opens with `unzOpen()` (`ZipArchive.cpp:29`), i.e.
  `unzOpenInternal(path, NULL, 0)` with `is64bitOpenFunction = 0` (`unzip.c:698`). Stay under
  4 GiB and under 65535 entries to be safe.
* **Filename buffer is 512 bytes** (`char fName[512]`, `ZipArchive.cpp:44`, passed to
  `unzGetCurrentFileInfo` at `:46`); longer names are skipped by
  `unzGetCurrentFileInfo` failing.
* Entries whose name ends in `/` or `\` are treated as directories and skipped
  (`ZipArchive.cpp:54-56`).
* CRC is verified on read: `unzCloseCurrentFile() == UNZ_CRCERROR` ⇒ `GetFileImpl` returns 0 and
  the buffer is cleared (`ZipArchive.cpp:157-162`).
* `info.uncompressed_size` is cast to `int` (`ZipArchive.cpp:63`) — same < 2 GiB per‑file rule.

A zip is never "solid", so `CZipArchive::CheckForSolid()` inherits the base `return false`
(`IArchive.h:136`) and the solidity gate in §1.4 is a no‑op for `.sdz`. `maps-metadata`'s own
parser hardcodes this: `isMapArchiveSolid()` returns `false` for `.sdz` without looking
(`cloud/map-parser/src/parse-worker.ts:39-48`).

### 1.4 Solidity — the rule that actually bites

A solid 7z compresses many files into one LZMA stream, so reading `mapinfo.lua` costs a full
decompression of the block. The engine detects this heuristically at open time
(`SevenZipArchive.cpp:160-171`):

```cpp
considerSolid = (db.db.NumFolders == 1)
             || (fileEntries.size() > db.db.NumFolders
                 && db.db.NumFolders < ThreadPool::GetNumThreads());
parallelAccessNum = !CheckForSolid() ? ThreadPool::GetNumThreads() : 1;
```

and `CArchiveScanner::CheckCompression()` (`ArchiveScanner.cpp:571-599`) then **rejects the whole
archive** if a "class 1" meta file is expensive to read:

```
error += "reading primary meta-file " + fn + " too expensive; ";
error += "please repack this archive with non-solid compression";
```

Class‑1 meta files are `mapinfo.lua` and `modinfo.lua`; class‑2 (warning only) are
`modoptions.lua`, `engineoptions.lua`, `validmaps.lua`, `luaai.lua`, `armor.txt`,
`springignore.txt`, plus the dirs `sidepics/ gamedata/ units/ features/ weapons/`
(`ArchiveScanner.cpp:103-120`). A rejected archive is recorded in `brokenArchives` and never
appears in the map list.

> Note: `IArchive::HasLowReadingCost()` currently has no override anywhere in the tree
> (only the base `return true` at `IArchive.h:131`), so on current master the class‑1 rejection
> path is effectively dormant — **but BAR's CI enforces the same rule independently**
> (`scripts/js/src/check_archive_not_solid.ts`), by shelling out to `7za l -x!* <archive>` and
> parsing the `Solid = +/-` line (`cloud/map-parser/src/parse-worker.ts:19-37`). A solid map
> fails `make test` and the PR will not merge. The whitelist is empty.

Also note the first clause: **`NumFolders == 1` counts as solid even if `-ms=off` was used** —
which happens if your archive contains exactly one non‑empty file. Irrelevant for a real map
(always ≥ 3 files) but relevant for test fixtures.

Measured on the six real archives (`py7zr.archiveinfo()`):

| archive | `solid` | `method_names` | `blocks` (folders) | non‑dir files |
|---|---|---|---|---|
| comet_catcher_remake_1.8 | False | `['LZMA2']` | 61 | 61 |
| hooked_1.1.1 | False | `['LZMA2']` | 67 | 67 |
| speedmetal_bar_v2 | False | `['LZMA2']` | 10 | 10 |
| coast_to_coast_bar_v1.0 | False | `['LZMA2']` | 54 | 54 |
| altair_crossing_v4.1 | False | `['LZMA2']` | 95 | 95 |
| boreal_falls_1.0.2 | False | `['LZMA2']` | 85 | 85 |

One folder per file, LZMA2, every time.

### 1.5 The safe packing recipe

```sh
# from a staging dir that contains mapinfo.lua, maps/, features/, ...
7z a -t7z \
     -m0=lzma2 -mx=9 -md=64m -mfb=64 \
     -ms=off        `# NON-SOLID - required` \
     -mhc=on        `# compressed header: fine, this is the default` \
     -mmt=on \
     ../my_map_v1.0.sd7 ./*
```

Explicitly **do not** use: `-p` (encryption), `-mhe=on` (encrypted header), `-m0=PPMd`,
`-m0=BZip2`, `-t7z -mm=Copy` on huge files (works but pointless), `-ms=on`/`-ms=<N>f`.
`-m0=Copy` (store) is decodable and is what you want for already‑compressed payloads if you care
about pack time; `.smt` and `.dds` still compress ~50 % with LZMA2 so plain `-mx=9` is what
everyone ships.

For `.sdz`: `zip -r -9 my_map_v1.0.sdz .` (deflate, no `-e`).

### 1.6 What the engine hashes / ignores

`CArchiveScanner::GetArchiveChecksum()` (`ArchiveScanner.cpp:979-1090`) SHA‑512s every file, then
XORs `sha512(lowercase(filename)) ^ sha512(content)` over all files sorted case‑insensitively. The
ignore filter is built by `CreateIgnoreFilter()` (`ArchiveScanner.cpp:959-971`):

```cpp
ignore->AddRuleRegex("^\\..*$");                       // anything starting with '.'
if (ar->GetFile("springignore.txt", buf) && !buf.empty())
    ignore->AddRule(...);                               // one regex per line
```

So dotfiles (`.git`, `.DS_Store`, …) never affect the archive hash — but they *are* still in the
archive and still downloaded by every player. Strip them at pack time. Shipping a
`springignore.txt` lets you exclude e.g. source files from the sync hash. Note the rule is
`^\..*$` — a *leading* dot. Windows junk that does **not** start with a dot is hashed and shipped:
Comet Catcher carries six `desktop.ini` files (136 B each). Whether the regex is matched against the
full VFS path or only the basename (i.e. whether `maps/.foo` is ignored) was not traced into
`IFileFilter` — **UNVERIFIED — needs confirmation**.

The XOR fold is order‑independent, so the case‑insensitive `std::stable_sort` at
`ArchiveScanner.cpp:1056-1064` does not affect the result; what matters for reproducibility is only
the *set* of non‑ignored files and their lower‑cased names.

**Filename case is irrelevant to lookups.** Every archive builds `lcNameIndex` from
`StringToLower(origName)` (`SevenZipArchive.cpp:157`, `ZipArchive.cpp:69`, `DirArchive.cpp:48`),
and `IArchive::FileExists()` takes an already‑lower‑cased, forward‑slash path
(`IArchive.h:56-64`). Two files differing only in case collide in the index — don't do it.
Always use forward slashes.

---

## 2. Canonical internal directory layout

### 2.1 What the engine requires

Only three things are engine‑mandated for a map archive:

1. **`mapinfo.lua` at the archive root.** Its presence is what makes the archive a map:
   `ArchiveScanner.cpp:746` `const bool hasMapInfo = ar->FileExists("mapinfo.lua");`, then
   `ArchiveScanner.cpp:784-800` sets `modType = modtype::map` and auto‑adds the dependency
   `"Map Helper v1"` (`AddDependency(ad.GetDependencies(), GetMapHelperContentName())`).
   Without it, the scanner falls back to `SearchMapFile()` which scans for *any* `.smf`
   (`ArchiveScanner.cpp:601-615`) and still classifies it as a map — but BAR's CI rejects that:
   `scripts/js/src/check_uses_mapinfo_lua.ts` fails any pool map lacking `mapinfo.lua`
   (sole whitelist entry: `Mescaline_V2`).
2. **A `.smf`.** Located either via `mapinfo.lua`'s `mapfile` key or by linear extension scan.
3. **A `.smt`** reachable at `dirname(mapfile) + <name stored in the .smf tile header>`
   (§3.4).

**What if both `mapinfo.lua` and `modinfo.lua` are present?** Not ambiguous — `mapinfo.lua` wins,
cleanly. `ScanArchive()` reads `hasModInfo` / `hasMapInfo` at `ArchiveScanner.cpp:745-746` and then
branches `if (hasMapInfo) … else if (hasModInfo) … else …` (`:753-766`): only `mapinfo.lua` is
executed, `modinfo.lua` is never even opened, and the `if (hasMapInfo || !arMapFile.empty())` arm at
`:784` still classifies the archive as a map and forces `modType = modtype::map` (`:796`).
So shipping a stray `modinfo.lua` is harmless but pointless — and `modinfo.lua` *alone* makes the
archive a game. Don't ship one.

**`modtype = 3` in `mapinfo.lua` is belt‑and‑braces, not the switch.** The scanner overwrites it
with `modtype::map` for any archive it decides is a map (`ArchiveScanner.cpp:796`). It is still
listed as a *required* known tag (`knownTags`, `ArchiveScanner.cpp:83`: "0=hidden, 1=primary,
(2=unused), 3=map, 4=base, 5=menu"), and unitsync/lobbies read it, so set it.

### 2.2 The de‑facto BAR layout

Top‑level directories observed across the six sampled archives (a `·` means present):

| path | comet | hooked | speedmetal | c2c | altair | boreal | purpose |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `mapinfo.lua` | · | · | · | · | · | · | **required** — map config table |
| `mapoptions.lua` | · | · | | · | · | · | lobby‑exposed map options |
| `maps/` | · | · | · | · | · | · | `.smf`, `.smt`, all map textures |
| `maphelper/mapinfo.lua` | · | · | | · | · | · | 1‑line back‑compat shim (§2.4) |
| `mapconfig/` | ·¹ | · | | · | · | · | feature placement + mapinfo overrides |
| `LuaGaia/` | ·² | · | | · | · | · | Gaia gadget host + FeaturePlacer |
| `features/` | (empty) | · | | · | · | · | map‑local `FeatureDef` Lua |
| `objects3d/` | (empty) | · | | · | · | · | `.s3o` models for those features |
| `unittextures/` | (empty) | · | | · | · | · | textures for those models |
| `LuaUI/` | · | | | | | | map‑local widgets / ambient sound |
| `bitmaps/` | · | | | | | | water/foam overrides |
| `libs/` | · | | | | | | vendored Lua libs (s11n, LCS) |

¹ Comet Catcher's `mapconfig/` is **not** a feature‑placer directory: it holds `mapconfig/model.lua`
(9 B, `return {}`) and an *empty* `mapconfig/mapinfo/`. Only hooked / c2c / altair / boreal ship
`mapconfig/featureplacer/`.
² Comet Catcher's `LuaGaia/Gadgets/` holds `precipitation.lua`, `s11n_gadget_load.lua` and
`s11n_load_map_features.lua` — **no `FP_featureplacer.lua`**; it places its decoration through s11n
instead. Its `features/`, `objects3d/` and `unittextures/` directories are empty.

`speedmetal_bar_v2.sd7` is the minimum viable shape: `mapinfo.lua` + `maps/` and nothing else
(10 files total).

Comet Catcher also ships six `desktop.ini` files (Windows folder metadata, 136 B each) scattered
through `LuaGaia/` and `LuaUI/`. They do not start with `.`, so they are **not** filtered out of the
archive checksum (§1.6). Don't emit them.

### 2.3 Inside `maps/`

Everything the SMF and `mapinfo.resources` reference lives flat in `maps/`. The only subdirectories
observed are build‑source dumps, which ship by accident:

* `maps/source/` (altair, c2c) — `*.tmd` World Machine projects, `*_height.png`, `*_metal.bmp`
* `maps/map_source_files/` (hooked) — `pentos_v3.tmd` (1.1 MB)

Coast To Coast ships a 4.1 MB `.tmd`; Rowy has a dedicated **TMD** upload field precisely so you
*don't* have to (`maps-metadata` wiki, *Rowy Maps fields legend*: "You can upload your World
Machine TMD file there instead of including it into the map file to reduce map file size").
A builder should not emit these.

`maps/<mapname>/` as a texture *subfolder* is legal (see §5.1 — path resolution is
"literal path, else `maps/` + path") but is not used by any BAR pool map inspected.

Also commonly found in `maps/` but **not referenced by `mapinfo.lua`** (pymapconv build
by‑products, safe to drop): `mini.png`, `mini.dds`, `<Map>.jpg`, `<Map>.png`, `grass_NORM.dds`.
Comet Catcher ships `maps/mini.dds` at exactly 699 176 B = `MINIMAP_SIZE (699048)` + 128‑byte DDS
header, i.e. the raw embedded minimap round‑tripped out of the compiler; plus a 1.4 MB
`maps/mini.png` nobody reads. That's ~2.1 MB of dead weight.

### 2.4 `maphelper/mapinfo.lua` — what it is and whether you need it

The engine picks the map's config entry point in `MapParser`'s ctor
(`rts/Map/MapParser.cpp:19`, `:37`):

```cpp
static const char* mapInfos[] = {"maphelper/mapinfo.lua", "mapinfo.lua"};
MapParser::MapParser(const std::string& mapFileName)
  : parser(mapInfos[CFileHandler::FileExists(mapInfos[1], vfsModes)], vfsModes, vfsModes)
```

i.e. **if the archive root has `mapinfo.lua`, that file is executed directly**; otherwise the
`maphelper.sdz` base archive's `maphelper/mapinfo.lua` runs, which loads the legacy `.smd` TDF
(`cont/base/maphelper/maphelper/mapinfo.lua:65-89`, via `Map.configFile` = same path as the
`.smf` with extension `.smd` — `MapParser.cpp:23-33`).

Five of six sampled maps *also* ship their own `maphelper/mapinfo.lua`, all 412 bytes, all the
same file:

```lua
--  Backwardcompability with <=0.82
 return VFS.Include("mapinfo.lua")
```

It shadows the base archive's copy and is harmless. It is **not required** on any current engine —
`speedmetal_bar_v2.sd7` omits it. Emit it for convention‑matching, or don't.

The engine injects into that Lua environment before executing (`MapParser.cpp:40-52`):

```
Map.fileName   = "CCRXR.smf"           -- basename
Map.fullName   = "maps/CCRXR.smf"
Map.configFile = "maps/CCRXR.smd"
Spring.GetMapOptions()                  -- only outside unitsync/dedicated
```

### 2.5 `mapconfig/` — the map‑side hook directory

Four conventions, three of them BAR‑specific:

| file | consumer | what it does |
|---|---|---|
| `mapconfig/mapinfo/*.lua` | the map's own `mapinfo.lua` tail | sorted, `VFS.Include`d, `lowerkeys`'d and deep‑merged into `mapinfo`, with `mapinfo` exposed as a global. This is how mapoptions mutate mapinfo. Present in hooked/c2c/altair/boreal as `0_apply_options.lua`. |
| `mapconfig/featureplacer/config.lua` | `LuaGaia/Gadgets/FP_featureplacer.lua` | `return VFS.Include("mapconfig/featureplacer/set.lua")` |
| `mapconfig/featureplacer/set.lua` | ditto | the actual placement list (§6.3) |
| `mapconfig/map_metal_layout.lua` | BAR `luarules/gadgets/map_metal_spot_placer.lua` | Lua metal spots for maps with a blank SMF metalmap (§7.3) |
| `mapconfig/lava.lua` | BAR `modules/lava.lua` | per‑map lava config; "the lava configuration can also be included inside the map pack in `mapconfig/lava.lua` (recommended)" — `common/configs/LavaMaps/README.md` |

The `mapconfig/mapinfo/` merge block, verbatim from every BAR map's `mapinfo.lua` (and from
BAR's own `mapgenerator/mapinfo_template.lua`):

```lua
do
  local function tmerge(t1, t2)
    for i,v in pairs(t2) do
      if (type(v) == "table") then t1[i] = t1[i] or {}; tmerge(t1[i], v)
      else t1[i] = v end
    end
  end
  getfenv()["mapinfo"] = mapinfo
    local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
    table.sort(files)
    for i=1,#files do
      local newcfg = VFS.Include(files[i])
      if newcfg then lowerkeys(newcfg); tmerge(mapinfo, newcfg) end
    end
  getfenv()["mapinfo"] = nil
end
```

### 2.6 `LuaGaia/` — the gadget host

Three tiny files, identical across hooked / c2c / altair / boreal / comet:

```lua
-- LuaGaia/main.lua (129 B)
if AllowUnsafeChanges then AllowUnsafeChanges("USE AT YOUR OWN PERIL") end
VFS.Include("LuaGadgets/gadgets.lua",nil, VFS.BASE)

-- LuaGaia/draw.lua (53 B)
VFS.Include("LuaGadgets/gadgets.lua",nil, VFS.BASE)
```

plus `LuaGaia/Gadgets/<your gadgets>.lua`. Most BAR maps ship
`LuaGaia/Gadgets/FP_featureplacer.lua` (2 234 B, "feature placer, Gnome/Smoth") and sometimes
`LuaGaia/effects/{drop,snowflake}.png` (used by `custom.precipitation.texture` in `mapinfo.lua`).
Comet Catcher is the exception: it ships `precipitation.lua` + the s11n loader pair and no
FeaturePlacer at all.

`LuaRules/` is *permitted* in a map archive but none of the six sampled maps use it; BAR strongly
prefers `LuaGaia` for map gadgets (it runs in the Gaia context and cannot break game rules).
`luaui/` (case‑insensitive) is permitted — Comet Catcher ships `LuaUI/widgets/ambientplayer.lua`
plus 6.9 MB of `LuaUI/sounds/ambient/wind*.ogg`.

---

## 3. Naming: archive filename vs. springname vs. SMF filename

These are **four independent names** and confusing them is the most common packaging bug.

### 3.1 `mapinfo.name` + `mapinfo.version` ⇒ the **springname**

`CArchiveScanner::ArchiveData::ArchiveData()` (`ArchiveScanner.cpp:129`, body `:187-200`):

```cpp
const std::string& name    = GetNameVersioned();
const std::string& version = GetVersion();
if (!version.empty()) {
    if (name.find(version) == std::string::npos) {
        SetInfoItemValueString("name", name + " " + version);
    } else if (!fromCache) {
        LOG_L(L_WARNING, "[%s] version \"%s\" included in name \"%s\"", ...);
    }
}
```

So the canonical springname is **`name .. " " .. version`**, unless `version` is already a
substring of `name` (in which case a warning is logged and `name` is used as‑is). The un‑suffixed
name is kept as `name_pure` (`ArchiveScanner.cpp:199-200`).

> ⚠ `name` there is a `const std::string&` bound to the *stored* info item, and
> `SetInfoItemValueString("name", …)` mutates that item before `name_pure` is written, so on current
> master `name_pure` can end up holding the **versioned** name rather than the pure one. Do not rely
> on `name_pure`; derive your own. (Behaviour read from source, not executed —
> **UNVERIFIED — needs confirmation**.)

Worked from real files:

| `mapinfo.name` | `mapinfo.version` | resulting springname | CDN filename |
|---|---|---|---|
| `Comet Catcher Remake` | `1.8` | `Comet Catcher Remake 1.8` | `comet_catcher_remake_1.8.sd7` |
| `Hooked` | `1.1.1` | `Hooked 1.1.1` | `hooked_1.1.1.sd7` |
| `Boreal Falls` | `1.0.2` | `Boreal Falls 1.0.2` | `boreal_falls_1.0.2.sd7` |

Version‑suffix conventions in the live pool are not standardised — all of these exist:
`Comet Catcher Remake 1.8`, `Hooked 1.1.1`, `Altair_Crossing_V4.1`, `SpeedMetal BAR V2`,
`All That Glitters v2.2.3`, `Cloud9_V2`, `Mescaline_V2`, `Throne v2`, `BarR 1.1`.
`maps-metadata` copes with the mess in `scripts/js/src/derived_map_info.ts`:

```ts
// "Map Name 1.2.3", "Map_Name_V2", "Map Name v1.0"
const match = springName.match(/[_\s][vV]?(\d+(?:\.\d+)*)$/);
…
version = version.trim().replace(/^[vV]/, '');   // strip leading v/V
```

**Recommendation for a builder:** `name = "<Human Name>"`, `version = "<x.y[.z]>"` (digits and
dots only, no `v` prefix), which yields `"<Human Name> x.y.z"` and matches the regex cleanly.

The springname is the **primary key everywhere downstream**: `map_list.yaml`'s `springName` is
required and must be unique (`maps-metadata` wiki: "The static unique reference for the map,
usually created by `{name} {version}`. This field must be set. This field also needs to be
unique"); it is the CDN lookup key
(`files-cdn.beyondallreason.dev/find?category=map&springname=…`); it keys `mapDetails.lua` in
Chobby; and SPADS's `mapBoxes.conf` keys on **`<springName>.smf`**
(`scripts/js/src/gen_map_boxes_conf.ts`: `` `${m.springName}.smf:${s.length}|…` ``).

### 3.2 Archive filename

The engine cares about **nothing but the extension**. `ArchiveLoader::OpenArchive` dispatches on
`FileSystem::GetExtensionLowerCase(fileName)` (`ArchiveLoader.cpp:65`) and the filename is used
only as a cache key (lower‑cased, `ArchiveScanner.cpp:719`) and for duplicate detection.

BAR's infrastructure is stricter. `maps-metadata/schemas/cdn_maps.yaml` requires:

```yaml
filename:
  type: string
  pattern: '^[^ ]+\.(sd7|sdz)$'
```

— **no spaces**, and `.sd7`/`.sdz` only. All 226 pool filenames are additionally all‑lowercase with
`_` for spaces. Use `springname.toLowerCase().replace(/ /g, '_') + '.sd7'`.

Do **not** rely on the filename matching the springname: `Altair_Crossing_V4.1` →
`altair_crossing_v4.1.sd7` matches, but nothing enforces it and the `.smf` inside is
`maps/Altair_Crossing_V4.smf` (no `.1`).

### 3.3 `.smf` filename vs. everything else

The SMF basename is **completely free**. Observed:

| springname | `.smf` path | matches? |
|---|---|---|
| `Comet Catcher Remake 1.8` | `maps/CCRXR.smf` | no (uses `shortname`) |
| `Hooked 1.1.1` | `maps/Hooked.smf` | partial |
| `Coast To Coast BAR v1.0` | `maps/c2c.smf` | no |
| `Altair_Crossing_V4.1` | `maps/Altair_Crossing_V4.smf` | partial |
| `Boreal Falls 1.0.2` | `maps/BorealFalls.smf` | no (space removed) |
| `SpeedMetal BAR V2` | `maps/SpeedMetal_BAR_V2.smf` | yes‑ish |

Resolution order:

1. `mapinfo.mapfile` if set — e.g. `mapfile = "maps/CCRXR.smf"`. The scanner warns loudly if it's
   missing: *"set the 'mapfile' key in mapinfo.lua of archive X for faster loading!"*
   (`ArchiveScanner.cpp:756-761`). **Always set it.**
2. Otherwise `SearchMapFile()` walks every entry and returns the first whose lowercase extension is
   `smf` (`ArchiveScanner.cpp:601-615`) — O(NumFiles) and order‑dependent, so ship exactly one
   `.smf`.

`CArchiveScanner::MapNameToMapFile(versionedMapName)` (`ArchiveScanner.cpp:1652-1664`) maps the
springname back to that path at load time.

⚠ **Only one `.smf` per archive.** `SearchMapFile` returns the first match in archive order; with
two, which map you get is undefined.

### 3.4 `.smt` filename

The `.smt` name lives **inside the `.smf`**, as a NUL‑terminated string after `MapTileHeader`
(§4.2). `CSMFGroundTextures::LoadTiles()` (`rts/Map/SMF/SMFGroundTextures.cpp:131-153`) builds:

```cpp
const std::string& smfDir = FileSystem::GetDirectory(gameSetup->MapFileName());  // "maps/"
std::string smtFilePath = (!smtHeaderOverride) ? (smfDir + smtFileName)
                                               : (smfDir + smf.smtFileNames[a]);
CFileHandler tileFile(smtFilePath);
if (!tileFile.FileExists())                       // try absolute path
    tileFile.Open(smtFilePath = (!smtHeaderOverride) ? smtFileName : smf.smtFileNames[a]);
```

So the embedded name is **relative to the `.smf`'s directory**. Comet Catcher stores
`"CCRXR.smt"` → resolved to `maps/CCRXR.smt`. If the file is missing, all tiles are memset to
`0xAA` and the whole map renders red (`SMFGroundTextures.cpp:151-160`).

⚠ **Hard limit on the embedded name: 254 bytes.** `LoadTiles()` reads it into
`char fileNameBuffer[256] = {{0}}` and calls
`ifs->ReadString(&fileNameBuffer[0], sizeof(char) * (sizeof(fileNameBuffer) - 1))`
(`SMFGroundTextures.cpp:134`, `:137`), i.e. at most 255 bytes are read and the last is the
terminator. Longer names are silently truncated and the tile file will not be found.

`mapinfo.smf.smtFileName0..N` **override** the embedded names, but only when the count matches
`tileHeader.numTileFiles` exactly (`SMFGroundTextures.cpp:126-130`, else a warning and the override
is ignored; the engine then falls back to the embedded names). Note the override is *also* prefixed with `maps/` first, so Comet Catcher's
`smtFileName0 = "maps/CCRXR.smt"` first tries `maps/maps/CCRXR.smt`, fails, then falls back to the
bare string and works. Either spelling works; `"<Name>.smt"` is the cleaner one.

The `.smt` header is re‑validated: magic `"spring tilefile"`, `version == 1`, `tileSize == 32`,
`compressionType == 1` — any mismatch throws `content_error`
(`SMFGroundTextures.cpp:165-171`). Note the tile *payload* is read as
`numSmallTiles × SMALL_TILE_SIZE` raw bytes (`:173-175`), with no bounds check against the file's own
`numTiles`.

### 3.5 Summary of what must / mustn't match

| pair | must match? |
|---|---|
| archive filename ↔ springname | no (but BAR convention: lowercased, `_` for spaces) |
| archive filename ↔ `.smf` basename | no |
| springname ↔ `.smf` basename | no |
| `mapinfo.mapfile` ↔ actual `.smf` path | **yes** (or omit and rely on the scan) |
| SMF‑embedded `.smt` name ↔ actual file in `maps/` | **yes** |
| `mapinfo.name + " " + version` ↔ `map_list.yaml` `springName` | **yes** |
| `mapinfo.version` ↔ suffix in springname | yes, or the engine appends it for you |
| SPADS `mapBoxes.conf` key ↔ `<springName>.smf` | generated for you |

---

## 4. SMF / SMT layout, and a worked size calculation

(Full binary format lives in `smf-format.md` / `smt-format.md`; this section covers only what the
*packager* must get right, and gives one fully arithmetic‑checked example.)

### 4.1 `SMFHeader` — 80 bytes, little‑endian

`rts/Map/SMF/SMFFormat.h:49-70`:

| off | type | field | constraint |
|---:|---|---|---|
| 0 | `char[16]` | `magic` | `"spring map file\0"` |
| 16 | `int32` | `version` | must be `1` |
| 20 | `int32` | `mapid` | arbitrary GUID‑ish |
| 24 | `int32` | `mapx` | divisible by 128 |
| 28 | `int32` | `mapy` | divisible by 128 |
| 32 | `int32` | `squareSize` | must be `8` |
| 36 | `int32` | `texelPerSquare` | must be `8` |
| 40 | `int32` | `tilesize` | must be `32` |
| 44 | `float` | `minHeight` | world height at heightmap value 0 |
| 48 | `float` | `maxHeight` | world height at heightmap value 0xFFFF |
| 52 | `int32` | `heightmapPtr` | → `uint16[(mapy+1)*(mapx+1)]` |
| 56 | `int32` | `typeMapPtr` | → `uint8[(mapx/2)*(mapy/2)]` |
| 60 | `int32` | `tilesPtr` | → `MapTileHeader` |
| 64 | `int32` | `minimapPtr` | → 699 048 B DXT1 chain |
| 68 | `int32` | `metalmapPtr` | → `uint8[(mapx/2)*(mapy/2)]` |
| 72 | `int32` | `featurePtr` | → `MapFeatureHeader` |
| 76 | `int32` | `numExtraHeaders` | count of `ExtraHeader`s that follow at offset 80 |

Validation (`CheckHeader`, `rts/Map/SMF/SMFMapFile.cpp:16-28`) rejects anything where
`version != 1`, `tilesize != 32`, `texelPerSquare != 8`, `squareSize != 8`, or
`strcmp(h.magic, "spring map file") != 0`.

⚠ **`mapx`/`mapy` divisibility is *not* validated by `CheckHeader`.** The real constraint comes from
`CSMFReadMap::ParseHeader()`: `numBigTexX = header.mapx / bigSquareSize` with
`bigSquareSize = 32 * tileScale = 128` (`SMFReadMap.h:181-182`, `SMFReadMap.cpp:120-121`), and
`tileCount = (mapx * mapy) / 16` (`:125`). A `mapx` that is not a multiple of 128 silently truncates
the big‑texture grid and leaves a strip of the map untextured. Stick to multiples of 128
(= whole "map units" of 64 twice over; BAR sizes are `mapx / 64` × `mapy / 64`).

**Independent cross‑check of the whole struct set.** Beherith's compiler (`pymapconv`,
`github.com/Beherith/springrts_smf_compiler`, CC0‑1.0) declares exactly the same little‑endian
layouts in `src/pymapconv.py:38-79`, which is the definitive writer‑side confirmation:

```python
SMFHeader_struct       = struct.Struct('< 16s i i i i i i i f f i i i i i i i')   # 80 bytes
ExtraHeader_struct     = struct.Struct('< i i i')                                 # 12 (size,type,pos)
MapTileHeader_struct   = struct.Struct('< i i')                                   # 8
MapFeatureHeader_struct= struct.Struct('< i i')                                   # 8
MapFeatureStruct_struct= struct.Struct('< i f f f f f')                           # 24
TileFileHeader_struct  = struct.Struct('< 16s i i i i')                           # 32
MINIMAP_SIZE = 699048
```

and its write order (`pymapconv.py:1050-1069`) is exactly: grass/vegetation map → heightmap
(`'<H'`) → typemap → `minimapdata[:MINIMAP_SIZE]` ("dont even write more than needed, or else
produced map will crash!") → metalmap → `MapTileHeader` → `int count` + NUL‑terminated `.smt` name
→ `int32[mapx*mapy/16]` tile indices → `MapFeatureHeader` → NUL‑terminated type names →
`MapFeatureStruct[]`. That is the byte budget in §4.2, emitted by the reference implementation.

`ExtraHeader` = `{ int32 size; int32 type; }` (`SMFFormat.h:83-86`); `type == MEH_Vegetation (1)`
is followed by an `int32 pos` pointing at `uint8[(mapx/4)*(mapy/4)]` grass data
(`SMFMapFile.cpp:239-269`). All six sampled maps have `numExtraHeaders == 1` and it is the
vegetation header.

`MapTileHeader` = `{ int32 numTileFiles; int32 numTiles; }` followed, per tile file, by
`int32 count` + NUL‑terminated name; then `int32[(mapx/4)*(mapy/4)]` of tile indices
(`SMFFormat.h:107-127`).

`MapFeatureHeader` = `{ int32 numFeatureType; int32 numFeatures; }`, then `numFeatureType`
NUL‑terminated names, then `numFeatures × MapFeatureStruct` where the struct is 24 bytes:
`{int32 featureType; float xpos, ypos, zpos, rotation, relativeSize;}`
(`SMFFormat.h:135-157`).

Info‑map sizes are canonical in `CSMFMapFile::GetInfoMapSize` (`SMFMapFile.cpp:193-203`):

```cpp
"height" -> (mapx + 1, mapy + 1)
"grass"  -> (mapx / 4, mapy / 4)
"metal"  -> (mapx / 2, mapy / 2)
"type"   -> (mapx / 2, mapy / 2)
```

### 4.2 Worked example: `maps/CCRXR.smf` (Comet Catcher Remake 1.8)

Parsed header (exact values):

```
magic "spring map file\0"  version 1   mapid 509
mapx 1024  mapy 768  squareSize 8  texelPerSquare 8  tilesize 32
minHeight -50.0  maxHeight 100.0
heightmapPtr 49244   typeMapPtr 1625694   tilesPtr   2717958
minimapPtr  1822302  metalmapPtr 2521350  featurePtr 2914588
numExtraHeaders 1
```

Map size in "BAR units" = `mapx/64 × mapy/64` = **16 × 12**. World size in elmos =
`mapx*8 × mapy*8` = **8192 × 6144**.

Full byte budget — every pointer is reproduced by summing the block before it:

| block | offset | formula | bytes | end |
|---|---:|---|---:|---:|
| `SMFHeader` | 0 | `16 + 16×4` | 80 | 80 |
| `ExtraHeader` (vegetation) | 80 | `{size=12, type=1, pos=92}` | 12 | 92 |
| grass map | 92 | `(1024/4)×(768/4) = 256×192` | 49 152 | **49 244** = `heightmapPtr` ✔ |
| heightmap | 49 244 | `(1024+1)×(768+1)×2 = 1025×769×2` | 1 576 450 | **1 625 694** = `typeMapPtr` ✔ |
| typemap | 1 625 694 | `512×384` | 196 608 | **1 822 302** = `minimapPtr` ✔ |
| minimap | 1 822 302 | `MINIMAP_SIZE` | 699 048 | **2 521 350** = `metalmapPtr` ✔ |
| metalmap | 2 521 350 | `512×384` | 196 608 | **2 717 958** = `tilesPtr` ✔ |
| `MapTileHeader` | 2 717 958 | `8` (`numTileFiles=1, numTiles=49153`) | 8 | 2 717 966 |
| tile‑file entry | 2 717 966 | `4 + len("CCRXR.smt") + 1 = 4+9+1` | 14 | 2 717 980 |
| tile index map | 2 717 980 | `(1024/4)×(768/4)×4 = 49152×4` | 196 608 | **2 914 588** = `featurePtr` ✔ |
| `MapFeatureHeader` | 2 914 588 | `8` (`numFeatureType=17, numFeatures=0`) | 8 | 2 914 596 |
| feature type names | 2 914 596 | `TreeType0..9` (10×10) + `TreeType10..15` (6×11) + `GeoVent\0` (8) | 174 | **2 914 770** |
| feature structs | — | `0 × 24` | 0 | 2 914 770 |

**File size = 2 914 770 bytes**, which is exactly the size stored in the archive. ✔

> **Independently re‑verified 2026‑09‑13** by re‑downloading `comet_catcher_remake_1.8.sd7`
> (md5 `478e53f181d0940b76d028411093b47a`, 41 565 457 B) from the CDN and re‑parsing the header with
> `struct.unpack('<16s i i i i i i i f f i i i i i i i', b[:80])`. Every value above reproduces
> exactly, including `ExtraHeader = (12, 1, 92)`, `MapTileHeader = (1, 49153)`, the tile‑file entry
> `(49153, "CCRXR.smt")` ending at 2 717 980, and `MapFeatureHeader = (17, 0)` with the 17 names
> `TreeType0..TreeType15, GeoVent` occupying 174 bytes and ending at 2 914 770 = EOF.
> Note `numTiles` (49 153) is one more than the tile‑index count (49 152) — the `.smt` carries one
> extra tile; do not assume they are equal.

`MINIMAP_SIZE = 699048` (`SMFFormat.h:34`) is the 9‑level DXT1 chain for 1024²:
`Σ_{n=0..8} (max(1, 1024>>n)/4)² × 8` = 524288 + 131072 + 32768 + 8192 + 2048 + 512 + 128 + 32 + 8.
`MINIMAP_NUM_MIPMAP = 9` (`SMFFormat.h:31`). Level 0 is 1024×1024; the last level is 4×4.

### 4.3 Worked example: `maps/CCRXR.smt`

`TileFileHeader` = `char[16] magic ("spring tilefile\0") + int32 version + int32 numTiles +
int32 tileSize + int32 compressionType` = **32 bytes** (`SMFFormat.h:175-183`).

`SMALL_TILE_SIZE = (512>>0) + (512>>2) + (512>>4) + (512>>6) = 512 + 128 + 32 + 8 = 680`
(`SMFFormat.h:28`) — a 32×32 DXT1 tile with 4 mip levels (32², 16², 8², 4²).

```
32 + 49153 × 680 = 32 + 33 424 040 = 33 424 072 bytes
```

Archive entry size for `maps/CCRXR.smt`: **33 424 072**. ✔

### 4.4 Other sampled headers

| map | mapx×mapy | units | heightmapPtr | smf bytes | smt bytes | numTiles |
|---|---|---|---:|---:|---:|---:|
| Hooked | 384×256 | 6×4 | 6 236 | 977 107 | 4 177 952 | 6 144 |
| SpeedMetal BAR V2 | 1664×256 | 26×4 | 26 716 | 1 901 278 | 10 973 872 | 16 138 |
| Coast To Coast | 768×512 | 12×8 | 24 668 | 1 807 824 | 16 711 712 | 24 576 |
| Altair Crossing V4 | 512×512 | 8×8 | 16 476 | 1 438 743 | 11 141 152 | 16 384 |
| Boreal Falls | 896×896 | 14×14 | 50 268 | 2 960 912 | 34 092 512 | 50 136 |

(`numTiles` back‑computed as `(smt_bytes − 32) / 680`.)

---

## 5. External map textures (`mapinfo.resources`)

### 5.1 How a texture path is resolved

`rts/Map/MapInfo.cpp:35-45`:

```cpp
static void FIND_MAP_TEXTURE(std::string* filePath, const std::string& defaultDir = "maps/")
{
    if (filePath->empty()) return;
    if (CFileHandler::FileExists(*filePath, SPRING_VFS_ZIP))  // no RawFS
        return;
    *filePath = defaultDir + *filePath;
}
```

⇒ **a bare name like `"Hooked_normals.dds"` resolves to `maps/Hooked_normals.dds`**, and any path
that already exists verbatim is used as‑is. `"maps/foo/bar.dds"` therefore works too.

⚠ **`SPRING_VFS_ZIP` spans every mounted archive, not just yours.** Comet Catcher's mapinfo sets
`water.foamTexture = "bitmaps/foam.jpg"` — and that file is **not in the map archive** (the archive
ships `bitmaps/Foam.tga`, which nothing references). It resolves against BAR's own
`bitmaps/foam.jpg`. So "the path already exists" can be satisfied by the *game* archive, and a name
collision with game content silently changes which file you get. Prefer map‑unique filenames under
`maps/`.

The single exception is the *default* `detailTex`, which falls back to `bitmaps/` instead
(`MapInfo.cpp:378-382`): if `resources.detailTex` is empty, the engine reads
`gamedata/resources.lua → graphics.maps.detailtex` (default `"detailtex2.bmp"`) and looks for it
under `bitmaps/`.

### 5.2 The nine `resources` string keys

`CMapInfo::ReadSMF()` (`rts/Map/MapInfo.cpp:354-429`) reads exactly this table (`:361-371`):

```cpp
const std::array<std::pair<std::string*, std::string>, 9> texNames = {{
    {&smf.detailTexName,         "detailTex"},
    {&smf.specularTexName,       "specularTex"},
    {&smf.splatDetailTexName,    "splatDetailTex"},
    {&smf.splatDistrTexName,     "splatDistrTex"},
    {&smf.grassShadingTexName,   "grassShadingTex"},
    {&smf.skyReflectModTexName,  "skyReflectModTex"},
    {&smf.blendNormalsTexName,   "detailNormalTex"},     // NB: key != field name
    {&smf.lightEmissionTexName,  "lightEmissionTex"},
    {&smf.parallaxHeightTexName, "parallaxHeightTex"},
}};
```

plus `grassBladeTex` (`MapInfo.cpp:198-199`, read in `ReadGrass()`) and the DNTS array, which
accepts **two spellings** (`MapInfo.cpp:384-400`; the nested form's flag key is `alpha`, `:385`):

```lua
-- preferred, nested:
resources = { splatDetailNormalTex = { "a.tga","b.tga","c.tga","d.tga", alpha = true } }
-- legacy flat (what every BAR map actually uses):
resources = {
  splatDetailNormalDiffuseAlpha = 1,
  splatDetailNormalTex1 = "a.tga", splatDetailNormalTex2 = "b.tga",
  splatDetailNormalTex3 = "c.tga", splatDetailNormalTex4 = "d.tga",
}
```

The loop stops at the first missing index, and `CSMFReadMap` hard‑caps at
`NUM_SPLAT_DETAIL_NORMALS` = 4 (`SMFReadMap.cpp:304-306`).

There is a second, separate `smf = { … }` table for **overrides of compiled data**
(`MapInfo.cpp:404-428`): `minHeight`, `maxHeight` (`:406-409`), `minimapTex`, `metalmapTex`,
`typemapTex`, `grassmapTex` (`:411-419`) and `smtFileName0..N` (`:421-428`). The four `*Tex` ones
replace the corresponding data *inside* the `.smf`. Note the asymmetry: the four `*Tex` names are run
through `FIND_MAP_TEXTURE` (`:416-419`) but **`smtFileName*` is not** — `SMFGroundTextures` prefixes
it with the `.smf`'s directory itself (§3.4).

`metalmapTex`/`typemapTex`/`grassmapTex` are loaded with `CBitmap::LoadGrayscale` and must match the
SMF info‑map dimensions **exactly** or they are discarded with a warning and the embedded data is
used instead (`CSMFReadMap::GetInfoMap`, `SMFReadMap.cpp:924-970`; the size test is at `:951-962`).
`minimapTex` is handled separately in `LoadMinimap()` (`SMFReadMap.cpp:161-170`) and has **no** size
constraint — any bitmap replaces the 1024² DXT1 chain.

### 5.3 UV mapping — what each sampler is indexed by

From `cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl` and the uniforms in
`rts/Map/SMF/SMFRenderState.cpp` (`normalTexGen` `:185`, `infoTexGen` `:191`, `specularTexGen` `:193`):

```cpp
normalTexGen   = 1 / ((normTexSize.x - 1) * SQUARE_SIZE),  1 / ((normTexSize.y - 1) * SQUARE_SIZE)
infoTexGen     = 1 / (mapDims.pwr2mapx * SQUARE_SIZE),     1 / (mapDims.pwr2mapy * SQUARE_SIZE)
specularTexGen = 1 / (mapDims.mapx * SQUARE_SIZE),         1 / (mapDims.mapy * SQUARE_SIZE)
```

`normTexSize` is the engine's own heightmap‑derived normal texture, sized
`(mapDims.mapxp1, mapDims.mapyp1)` = `(mapx+1, mapy+1)` (`CreateNormalTex`, `SMFReadMap.cpp:388`),
so `normalTexGen = 1/((mapx+1-1)*8) = 1/(mapx*8) = specularTexGen`. **Both `specTexCoords`
and `normTexCoords` are therefore plain 0…1 across the whole world.**

| sampler | texcoord in shader | meaning |
|---|---|---|
| `specularTex` | `specTexCoords = worldPos.xz * specularTexGen` | stretched 0…1 over the map |
| `skyReflectModTex` | `specTexCoords` | stretched 0…1 |
| `lightEmissionTex` | `specTexCoords` | stretched 0…1 |
| `parallaxHeightTex` | `specTexCoords` | stretched 0…1 — **"specularTex and parallaxHeightTex must have equal size"** (`SMFFragProg.glsl:284-285`; the offset is then rescaled per‑sampler at `:291-293`) |
| `splatDistrTex` | `specTexCoords` (passed as `uv`) | stretched 0…1 |
| `blendNormalsTex` (= `detailNormalTex`) | `normTexCoords` | stretched 0…1 |
| `detailTex` | `worldPos.xz * SMF_DETAILTEX_RES` where `SMF_DETAILTEX_RES = 0.02` (`SMFFragProg.glsl:25`, used `:157`) | **tiles**, 1 repeat per 50 elmos |
| `splatDetailTex` / `splatDetailNormalTex1..4` | `worldPos.xzxz * splatTexScales.rrgg / .bbaa` | **tiles**, per‑channel scale from `mapinfo.splats.texScales` |
| `diffuseTex` (from `.smt`) | per‑square, `SMF_TEXSQUARE_SIZE = 1024.0` (`SMFFragProg.glsl:5`) | the compiled atlas |
| `grassShadingTex` | `worldPos.xz * (1/(mapx*8), 1/(mapy*8))` — `shadingTexCoords.pq` in `GrassVertProg.glsl:155`, uniform `mapSize` set in `GrassDrawer.cpp:329` | stretched 0…1, **same gen as `specularTex`** |

**Consequence:** the full‑map textures can be any pixel size — the GPU stretches them — but their
**aspect ratio should equal `mapx : mapy`** or the map is visibly distorted in specular/normal.

### 5.4 Expected dimensions (measured, and the community formula)

Let `S = mapx/64` and `T = mapy/64` (the "20×10" style map size). Then `mapx = 64S`.

| asset | rule | per map unit | source |
|---|---|---|---|
| heightmap (input) | `64S+1 × 64T+1` | — | `(mapx+1, mapy+1)`, `SMFMapFile.cpp:197` |
| metalmap (input) | `32S × 32T` | 32 | `(mapx/2, mapy/2)`, `SMFMapFile.cpp:199` |
| typemap (input) | `32S × 32T` | 32 | `(mapx/2, mapy/2)`, `SMFMapFile.cpp:200` |
| grassmap (input) | `16S × 16T` | 16 | `(mapx/4, mapy/4)`, `SMFMapFile.cpp:198` |
| diffuse/texture (input) | `512S × 512T` | 512 | `mapx × texelPerSquare(8)` |
| minimap (in `.smf`) | `1024 × 1024` DXT1 + 8 mips | fixed | `MINIMAP_SIZE` |
| `detailNormalTex` | `512S × 512T` | **512** | measured |
| `specularTex` | `256S × 256T` | **256** | measured |
| `skyReflectModTex` | = `specularTex` (one sample only — **UNVERIFIED**) | 256 | measured (Boreal) |
| `parallaxHeightTex` | **must equal** `specularTex` | 256 | shader comment (`SMFFragProg.glsl:284-285`) |
| `lightEmissionTex` | free; sampled with `specTexCoords`, so `mapx:mapy` aspect (**UNVERIFIED** — unused by any pool map) | 256 | shader only |
| `splatDistrTex` | `128S × 128T`, usually rounded up to pow‑2 | **128** | measured |
| `splatDetailNormalTex1..4` | tiling, 512² or 1024² (2048² for metal maps) | n/a | measured |
| `splatDetailTex` | tiling, 512²; only needed when *not* using DNTS | n/a | measured |
| `detailTex` | tiling, 256² or 512², 8‑bit BMP | n/a | measured |
| `grassShadingTex` | stretched over the whole map (§5.3); **defaults to the 1024² minimap** | n/a | `SMFReadMap.cpp:328-342` |
| skybox (`atmosphere.skyBox`) | DDS **cubemap**, 2048²/face | n/a | measured (Boreal) |

The public BAR guide ([File Structure & Prerequisites](https://www.beyondallreason.info/guide/mapping-1-file-structure-prerequisites))
states the same numbers for heightmap ("A 20x10 map has a 1281 x 641 px heightmap. Calculate:
64 x [yourmap size] + 1"), diffuse ("10240 x 5120 … Calculate: 512 x"), normalmap ("10240 x 5120 …
1:1 with the texture"), specular ("at least a 5120 x 2560 px specularmap. Calculate: 256 x") and
grass ("320 x 160 px (1/8 or 12.5% of the heightmap)" = `16 x`). Its *metal* and *type* entries say
"Calculate: 16 x [yourmap size]" but its own worked example contradicts that — "A 20x10 map has
a 640 x 320 px (1/4 or 25% of the heightmap)" = `32 x`. **Trust `32 x` (= `mapx/2`), which is what
the engine reads.**

The guide's DNTS entry ("A 20x10 map has a 2048 x 1024 px splatmap") also disagrees with the `128 x`
rule (`128 × 20 = 2560`); it looks like a pow‑2 convenience figure. The measured pool follows
`128 x` closely (Hooked 6×4 → 768×512; C2C 12×8 → 1536×1024; Altair 8×8 → 1024×1024; Boreal 14×14 →
2048² rounded up from 1792). Either is fine — the sampler is stretched 0…1 either way.
The guide's *Reflect map* section says only that it is "optional, and rarely used" and to consult
Beherith for specifications — so the `skyReflectModTex = specularTex size` rule below rests on a
single sample and is **UNVERIFIED — needs confirmation**.

Raw measurements (dimensions read from the actual file headers inside the archives):

| map (units) | `detailNormalTex` | `specularTex` | `splatDistrTex` | DNTS 1..4 | `detailTex` |
|---|---|---|---|---|---|
| Hooked (6×4) | `Hooked_normals.dds` **3072×2048** DXT1 12 mips | `Hooked_speculartex.dds` **1536×1024** DXT5 | `Hooked_splat_distribution.dds` **768×512** DXT5 | 4× TGA 1024² 32‑bit | `detailtexblurred.bmp` 512² 8‑bit |
| Coast To Coast (12×8) | `c2c_normals.dds` **6144×4096** DXT1 | `c2c_speculartex.dds` **3072×2048** DXT5 | `c2c_splat_distribution.dds` **1536×1024** DXT5 | 4× TGA 1024² RLE | 512² |
| Altair Crossing (8×8) | `…_normals.dds` **4096×4096** DXT1 | `…_speculartex.dds` **2048×2048** DXT5 | `shading-splat_distr.dds` **1024×1024** DXT5 | 2× TGA 1024², 2× DDS 512² | 256² |
| Boreal Falls (14×14) | `…_Normals_FG_D008.dds` **7168×7168** DXT1 | `…_Specular_Shade_WithAlpha_v095.dds` **3584×3584** DXT5 | `shading-splat_distr.dds` **2048×2048** DXT5 (pow‑2 round‑up from 1792) | 3× TGA 1024², 1× TGA 1024² | 256² |
| SpeedMetal (26×4) | *(none)* | `SpeedMetal_specular_barv2.dds` **8192×1024** DXT5 (nonconforming: `256S`=6656) | `SpeedMetal_splatdist_8k1k.dds` **8192×1024** | 3× DDS 2048², 1× DDS 1024² | *(none)* |
| Comet Catcher (16×12) | `normalmap.png` **2048×1024** (nonconforming) | `specular.png` **2048×1024** (nonconforming; `256S`=4096×3072) | `splat_distr.png` **2048×1024** | 3× TGA 1024², 1× TGA 512² | 512² |

Two of six deviate from the rule. The engine does not care — it stretches — so a builder that
follows `512S / 256S / 128S` is strictly safer than the pool average.

### 5.5 Channel semantics

**`splatDistrTex` (RGBA)** — per‑texel weights for the four DNTS layers.
`GetSplatDetailTextureNormal`, `SMFFragProg.glsl:174-198` (the `normalize(mix(...))` line is in
`main()` at `:328`):

```glsl
vec4 splatCofac = texture2D(splatDistrTex, uv) * splatTexMults;
splatDetailStrength.x = min(1.0, dot(splatCofac, vec4(1.0)));
splatDetailNormal  = ((texture2D(splatDetailNormalTex1, uv0.st)*2.0 - 1.0) * splatCofac.r);
splatDetailNormal += ((texture2D(splatDetailNormalTex2, uv0.pq)*2.0 - 1.0) * splatCofac.g);
splatDetailNormal += ((texture2D(splatDetailNormalTex3, uv1.st)*2.0 - 1.0) * splatCofac.b);
splatDetailNormal += ((texture2D(splatDetailNormalTex4, uv1.pq)*2.0 - 1.0) * splatCofac.a);
splatDetailNormal.y = max(splatDetailNormal.y, 0.01);
normal = normalize(mix(normal, normalize(stnMatrix * splatDetailNormal.xyz),
                       splatDetailStrength.x));
```

R→tex1, G→tex2, B→tex3, A→tex4. BAR maps comment the convention as
`--sand, rock, pebbles, cracks` (Hooked/C2C) and `--the order is cliffs, pebbles, grass, metalspots`
(Hooked/Altair) — i.e. **there is no fixed semantic, it's per‑map**. Weights are scaled by
`mapinfo.splats.texMults` and can sum > 1 (the mix factor is clamped, the normals are not).

Fallback if absent: `AllocDummy(SColor(255,0,0,0))` — all weight on channel R
(`SMFReadMap.cpp:284-295`).

**`splatDetailNormalTexN` (RGBA)** — RGB is a standard tangent‑space normal map in `[0,1]`
(decoded `*2-1`); **A is the diffuse‑detail term** when `splatDetailNormalDiffuseAlpha` is truthy
(define `SMF_DETAIL_NORMAL_DIFFUSE_ALPHA`, set from `mapRendering->splatDetailNormalDiffuseAlpha` in
`SMFRenderState.cpp:121`). The shader does
`splatDetailStrength.y = clamp(splatDetailNormal.a, -1.0, 1.0)` (`SMFFragProg.glsl:191-193`) and then
`detailCol = vec4(splatDetailStrength.y)` (`:323`) — a signed brightness offset added to the diffuse
at `:381`. Note the alpha is *already weighted* by `splatCofac`, so it is a weighted sum, not a
lookup. Every BAR map sets `splatDetailNormalDiffuseAlpha = 1`.

Fallback per‑channel if a DNTS file fails to load — a **1×1** RGBA bitmap
(`SMFReadMap.cpp:310-316`):
`{127, 127, 255, 127}` — "RGB is packed standard normal map… With a single upward (+Z) pointing
vector. Alpha is diffuse as in old‑style detail textures."

Note the tangent frame (`SMFFragProg.glsl:272-278`): "for a regular vertex normal equal to
`<0,1,0>`, the S‑ and T‑tangents are aligned with Spring's +x and +z axes", i.e. **+Z of your
normal map points up out of the terrain, +X is world +X, +Y is world +Z**. This is why the
fallback is `(127,127,255)`.

**`specularTex` (RGBA)** — `SMFFragProg.glsl:403-424`: RGB = specular colour, **A × 16.0 =
specular exponent** (`:413`). With no `specularTex`, `groundSpecularColor` and `groundSpecularExponent`
from `mapinfo.lighting` are used instead. Fallback bitmap is opaque white
(`AllocDummy(SColor(255,255,255,255))`, `SMFReadMap.cpp:202-205`).

**`detailNormalTex` / `blendNormalsTex` (RGBA)** — `SMFFragProg.glsl:299-307`:

```glsl
vec4 dtSample = texture2D(blendNormalsTex, normTexCoords);
vec3 dtNormal = (dtSample.xyz * 2.0) - 1.0;
normal = normalize(mix(normal, stnMatrix * dtNormal, dtSample.a));
```

RGB = tangent‑space normal, **A = blend strength against the heightmap normal**. A DXT1 normal map
(as every BAR map ships) has no alpha ⇒ alpha reads as 1.0 ⇒ full replacement. If you want partial
blending you need DXT5/RGBA.

**`skyReflectModTex` (RGB)** — `SMFFragProg.glsl:341-350`:
`diffuseCol.rgb = mix(diffuseCol.rgb, textureCube(skyReflectTex, reflectDir).rgb, reflectMod)`.
Per‑channel reflectivity mask. Requires `atmosphere.skyBox` to be set for the cubemap to exist.
No fallback texture — the feature is simply off if the file is missing
(`SMFReadMap.cpp:211-218`, "no default 1x1 textures for these").

**`lightEmissionTex` (RGBA)** — `SMFFragProg.glsl:392-401`:
`fragColor.rgb = fragColor.rgb * (1.0 - emissionCol.a) + emissionCol.rgb`. RGB = emitted colour,
A = how much it occludes lit colour. Unshadowed glow.

**`parallaxHeightTex` (RGBA)** — `GetParallaxUVOffset`, `SMFFragProg.glsl:123-141`, fully
documented in the shader:

```
// RG: height in [ 0.0, 1.0] (256^2 strata)
//  B: scale  in [ 0.0, 1.0] (256   strata), eg.  0.04 (~10.0/256.0)
//  A: bias   in [-0.5, 0.5] (256   strata), eg. -0.02 (~75.0/256.0)
heightValue  = dot(texel.rg, vec2(255.0*256.0, 256.0)) / 65536.0;
heightOffset = heightValue * texel.b + (texel.a - 0.5);
```

**`splatDetailTex` (RGBA, legacy non‑DNTS path)** — one channel per tiling scale,
each decoded `*2-1` and dotted with `splatCofac`; it is a *signed detail brightness*, not a colour.
Fallback `AllocDummy(SColor(127,127,127,127))` = neutral.

**`detailTex` (RGB)** — decoded `*2-1` and added to the diffuse. Fallback
`AllocDummy({127,127,127,0})`. `detailtexblurred.bmp` (8‑bit palettised BMP, 256²/512²) is shared
verbatim by four of the six maps.

**`grassShadingTex`** — if absent, `grassShadingTex` *is* the minimap texture, declared as
1024×1024 (`CreateGrassTex`, `SMFReadMap.cpp:328-342`; the default is set at `:331-332` and a
supplied bitmap simply replaces both id and size at `:340-341`). **Resolved:** it is sampled with
`shadingTexCoords.pq = worldPos.xz * mapSize` where
`mapSize = (1/(mapx*SQUARE_SIZE), 1/(mapy*SQUARE_SIZE))` (`GrassVertProg.glsl:155`,
`GrassDrawer.cpp:329`, consumed at `GrassFragProg.glsl:45`) — i.e. **stretched once over the whole
map, never tiled**, exactly like `specularTex`. A supplied texture should therefore have
`mapx : mapy` aspect; its pixel size is free.

### 5.6 Colour space: everything is raw, nothing is sRGB

There is **no** sRGB handling anywhere in the map texture path:

* `grep -ri srgb rts/Map/` → no hits.
* `grep -i srgb rts/Rendering/Textures/Bitmap.cpp` → no hits; the internal‑format table is
  `{GL_R8, GL_RG8, GL_RGB8, GL_RGBA8}` (`Bitmap.cpp:1182`), and DDS goes through `nv_dds` into the
  plain `GL_COMPRESSED_*_S3TC_DXT*` formats.
* `SMFFragProg.glsl` contains no `pow(col, 2.2)` / `linearToSrgb` anywhere; the only `pow()` is the
  specular exponent.

⇒ **Author every map texture so that the stored 8‑bit values are used directly.** In practice:
paint the specular/diffuse/emission maps to look right on screen (i.e. sRGB‑encoded bytes fed
straight into a "linear‑ish" pipeline), and author normal maps / splat distributions / parallax
data as *data* (no gamma, no colour management, no sRGB tag). Do not let your exporter apply a
gamma transform to `.dds`/`.tga`/`.png` outputs.

### 5.7 `splats` scaling

```lua
splats = {
  texScales = {0.02, 0.02, 0.02, 0.02},   -- world-units -> UV, per DNTS channel
  texMults  = {1.00, 1.00, 1.00, 1.00},   -- multiplies the splatDistr weight
}
```

Defaults from `MapInfo.cpp:179-182` (and `cont/base/maphelper/maphelper/mapdefaults.lua:92-95`).
A `texScale` of `0.02` means one tile repeat per 50 elmos; Boreal Falls uses
`{0.0075, 0.013888, 0.001806, 0.001806}` (133 / 72 / 554 / 554 elmos per repeat) with
`texMults = {0.437, 0.300, 0.23, 2.5}`.

⚠ **`splatDetailTex` placeholder: historically load‑bearing, no longer required on master.**

Every BAR map sets a deliberately nonexistent placeholder —
`splatDetailTex = "iwantDNTS.tga"` (Hooked, C2C, Altair, Boreal) or `"irrelevant.tga"`
(Comet Catcher, re‑verified in its `mapinfo.lua:101`). The file genuinely does not exist in the
archive; the engine logs *"Invalid SMF splatDetailTex … Creating fallback texture"* and carries on.

The reason was `SMFReadMap.cpp:68-69`:

```cpp
haveSpecularTexture           = !(mapInfo->smf.specularTexName.empty());
haveSplatDetailDistribTexture = (!splatDetailTexName.empty() && !splatDistrTexName.empty());
```

combined with an old early‑out in `CreateSplatDetailTextures()` that returned unless
`haveSplatDetailDistribTexture` was true — so an empty `splatDetailTex` killed the DNTS path.

**That was fixed.** On current master (`CreateSplatDetailTextures`, `SMFReadMap.cpp:249-325`, commit
`510b1aea` *"Fix SMF DNTS gating and fallback textures"*, 2026‑07‑23) the gate is:

```cpp
if (!haveSplatDetailDistribTexture && !haveSplatNormalDistribTexture)
    return;                                                   // :252-253
if (haveSplatNormalDistribTexture && !haveSplatDetailDistribTexture)
    LOG_L(L_DEBUG, "... DNTS active without complete classic splat pair; using fallback ...");
```

and both `splatDetailTex` (`:266-274`, dummy `SColor(127,127,127,127)`) and `splatDistrTex`
(`:284-292`, dummy `SColor(255,0,0,0)`) now get fallback bitmaps when the name is empty *or*
unloadable. The shader flag `SMF_DETAIL_NORMAL_TEXTURE_SPLATTING` only needs
`GetSplatDistrTexture() != 0 && HaveSplatNormalTexture()` (`SMFRenderState.cpp:120`), which the dummy
satisfies.

**Practical advice, unchanged:** keep the placeholder. It costs nothing, it is what every pool map
does, and BAR pins engine versions — a map that omits it breaks on any pre‑2026‑07 engine.
What *is* genuinely load‑bearing is **`splatDistrTex`**: its fallback is `(255,0,0,0)`, i.e. all
weight on channel R, so omitting it collapses your four DNTS layers into one.

---

## 6. Features and decoration models

### 6.1 Two independent placement mechanisms

**(a) SMF‑embedded features.** `MapFeatureHeader` + `MapFeatureStruct[]` inside the `.smf`
(§4.1). Positions are world elmos; `rotation` is documented as "−32768..32767 for full circle"
though stored as `float` (`SMFFormat.h:155`); `relativeSize` is "not used at the moment keep 1".
`featureType` indexes the NUL‑terminated name list, which is matched **case‑insensitively** against
FeatureDefs. Comet Catcher's `.smf` declares 17 types (`TreeType0`…`TreeType15`, `GeoVent`) and
**zero instances** — the compiler always emits the tree table.

**(b) Lua feature placer (what BAR maps actually use).**
`LuaGaia/Gadgets/FP_featureplacer.lua` runs at frame 0 in the Gaia context:

```lua
if VFS.FileExists("mapconfig/featureplacer/config.lua") then
  featurecfg   = VFS.Include("mapconfig/featureplacer/config.lua")
  featureslist = featurecfg.objectlist
  buildinglist = featurecfg.buildinglist
  unitlist     = featurecfg.unitlist
end
…
for i,fDef in pairs(featureslist) do
  CreateFeature(fDef.name, fDef.x, Spring.GetGroundHeight(fDef.x,fDef.z)+5, fDef.z, fDef.rot)
end
```

so features are spawned **5 elmos above ground** at runtime, not baked into the `.smf`.

### 6.2 Where FeatureDefs come from

BAR's `gamedata/featuredefs.lua` (the standard Spring featuredef parser) does:

```lua
local luaFiles = VFS.DirList("features/", "*.lua", nil, true)
```

with `VFS_MODES = VFS.MAP .. VFS.MOD .. VFS.BASE` (`gamedata/defs.lua`). ⇒ **`features/*.lua` in
the map archive are merged into the game's FeatureDefs**, and a map‑side name collides with (and
overrides) a game‑side one. Each file must `return lowerkeys({[name] = def})`.

A map‑local FeatureDef, verbatim (`features/agorm_rock1.lua`, Hooked):

```lua
local featureDef = {
    name            = "agorm_rock1",
    blocking        = true,
    category        = "rocks",
    damage          = 100,
    description     = "rock",
    energy          = 0,
    flammable       = false,
    footprintX      = 2,
    footprintZ      = 2,
    height          = "36",
    hitdensity      = "5",
    metal           = 10,
    object          = "rock1.s3o",          -- resolved under objects3d/
    reclaimable     = true,
    autoreclaimable = true,
    world           = "All Worlds",
    customparams    = { randomrotate = "true" },
}
return lowerkeys({[featureDef.name] = featureDef})
```

and a tree with a normal map (`features/ad0_senegal_1.lua`):

```lua
customparams = {
    model_author = "ad0",
    normalmaps   = "yes",
    normaltex    = "unittextures/ad0senegal_normal.tga",
    treeshader   = "yes",
},
```

`object` is resolved under `objects3d/` (so `object = "ad0_fir/fir_tree_tall_1__tree_fir_tall_1.s3o"`
for Altair's nested layout), and `.s3o` texture names resolve under `unittextures/`.

### 6.3 `mapconfig/featureplacer/set.lua`

Machine‑generated by Smoth's FeaturePlacer (or SpringBoard's exporter):

```lua
-- AutoCreated by FeaturePlacer (by smoth)
local setcfg = {
  unitlist = { },
  buildinglist = { },
  objectlist = {
    { name = 'allpinesb_ad0_brown_c_xs', x = 12, z = 4372, rot = "3268"  ,scale = 1.000000 },
    { name = 'allpinesb_ad0_green_a_xxl', x = 12, z = 6532, rot = "18515" ,scale = 1.000000 },
    …
  },
}
return setcfg
```

`x`/`z` are world elmos; `rot` is a *string* holding the Spring heading (−32768..32767);
`scale` is read but ignored by `FP_featureplacer.lua`. Sizes observed: 19 kB (C2C, ~250 objects)
to 117 kB (Hooked, ~1500 objects) to 42 kB (Altair).

### 6.4 Which features come from the game archive

BAR ships only **eight** `features/*.lua` files plus one disabled `.lua.test`
(`gh api repos/beyond-all-reason/Beyond-All-Reason/contents/features`, read 2026‑09‑13):

```
features/candycane.lua
features/enginetrees_override.lua
features/geovent.lua
features/pilha_crystal.lua
features/raptor_egg.lua
features/rocks30.lua
features/tombstones.lua
features/xmascomwreck.lua
features/invalid_models.lua.test   <- .lua.test, so VFS.DirList("features/","*.lua") skips it
```

* **Trees.** `features/enginetrees_override.lua` defines `treetype0` … `treetype15` (a 0‑A.D. fir
  set, `model_author = "Beherith, 0 A.D."`), overriding the engine's otherwise identical
  `cont/base/springcontent/features/treetype.lua` — the only changed value is `damage`, 5 → 250
  (both files compared field by field; `energy` is 250 in both). So an SMF that places `TreeType0..15` works out of the
  box with no map‑side assets. The file's own comment: *"In theory it's possible to have treetype16
  or higher. However in practice Spring struggles to render tree types higher than 15… making maps
  with them really rare."*
* **Rocks.** `features/rocks30.lua` generates `rocks30_{def,snow,moss,desert,map}_01..30` — 150
  rock defs (5 biomes × 30, `for i = 1, 30`) with `object = "rocks30/rocks30_<biome>_<nn>.s3o"`,
  ground decals (`decalinfo_texfile`), `randomrotate`, `metal = 9 + i`, `damage = 100 + i*50`,
  `footprintX/Z = floor(i/8) + 1`. **Use these instead of shipping your own rocks.** (The claim that
  BAR provides ~2 059 files under `objects3d/` was not re‑counted —
  **UNVERIFIED — needs confirmation**.)
* **Geo vents.** `features/geovent.lua` provides `editor_geovent` / `editor_geocrack`
  (`geothermal = true`). Historically the name in SMF feature tables is `GeoVent`; BAR's file notes
  it deliberately uses `editor_*` names "so maps that ship their own `geovent`/`geocrack`/`geo.dds`
  are never shadowed" — i.e. **maps are expected to ship their own `geovent` FeatureDef**, which is
  exactly what most BAR maps do.
* Everything else (`candycane`, `pilha_crystal`, `raptor_egg`, `tombstones`, `xmascomwreck`) is
  seasonal/PvE content, not map decoration.

⇒ In practice: **trees and rocks can come from the game**; palms/ferns/firs/crystals with bespoke
art come from the map (`features/` + `objects3d/` + `unittextures/`). Hooked ships 14 palm `.s3o`
+ 6 rock `.s3o` + 5 textures = ~2 MB. C2C reuses the same `ad0_senegal` palm set plus 8 ferns.
Altair ships 40 fir variants (5 rotations × 8 models) + 8 `pdrock` models.

There are **no map wrecks** in the modern BAR pool — none of the six archives ship wreck features.

---

## 7. Metal spots

### 7.1 The ground truth is the SMF metalmap

`CReadMap::LoadMap()` (`rts/Map/ReadMap.cpp:162-167`):

```cpp
unsigned char* metalmapPtr = rm->GetInfoMap("metal", &mbi);
assert(mbi.width  == mapDims.hmapx);      // mapx / 2
assert(mbi.height == mapDims.hmapy);      // mapy / 2
metalMap.Init(metalmapPtr, mbi.width, mbi.height, mapInfo->map.maxMetal);
```

and `CMetalMap::GetMetalAmount` (`rts/Map/MetalMap.cpp:76-83`; `metalScale` is set in
`CMetalMap::Init`, `:29-44` — note it is forced to `1.0f` when the source pointer is null):

```cpp
return distributionMap[(z * sizeX) + x] * metalScale;   // metalScale == mapInfo->map.maxMetal
```

So:

* **Metal map resolution = `mapx/2 × mapy/2`** = 32 px per map unit = one cell per **16 elmos**
  (`Game.metalMapSquareSize == 16`).
* Each cell is one byte, `0…255`.
* Metal income per cell = `byte × mapinfo.maxMetal`. `maxMetal` defaults to `0.02`
  (`MapInfo.cpp:106`, `cont/base/maphelper/maphelper/mapdefaults.lua:21`) and is clamped to
  `>= 0` (`MapInfo.cpp:115`). `extractorRadius` defaults to `500.0` (`MapInfo.cpp:107`,
  `mapdefaults.lua:22`).
* Authoring format is an **8‑bit RGB BMP where only the red channel matters**; the BAR guide says
  *"Full RED (255,0,0) is max metal. Preferably use a sharp pixel pen with the exact color‑value you
  want with a 4px radius dots (no anti‑aliasing/smoothing)."*

Real `maxMetal` values from the pool: `0.02` (template default), `0.75` (Comet Catcher),
`1.70` (Hooked), `2.0` (Boreal Falls). Combined with `extractorRadius` (`120`, `100`, `60`
respectively) these set the per‑mex yield.

### 7.2 Spot *detection* is runtime, game‑side, not stored anywhere

BAR does not ship a metal‑spot list per map, and **`maps-metadata` does not store one** — there is
no metal‑spot field anywhere in `schemas/map_list.yaml`. Instead
`common/upgets/api_resource_spot_finder.lua` (Niobium, 2010; "API Resource Spot Finder (mex/geo)")
clusters the live metal map at game start:

* runs as a hidden gadget at `layer = -9`, deliberately "layered after
  `gadgets/map_metal_spot_placer.lua` so that it works with maps with side‑configured metal spots";
* scans in `metalMapSquareSize`‑wide strips, unions adjacent strips into groups, and derives a
  buildable centre per group using `extractorRadius`;
* publishes results as game rules params for AIs:
  `mex_count`, `mex_x<i>`, `mex_y<i>`, `mex_z<i>`, `mex_metal<i>`;
* geo spots come from **features whose FeatureDef has `geoThermal = true`**, snapped to the
  building footprint grid (`Game.footprintScale * Game.squareSize` = 16).

It also hardcodes a metal‑map allowlist (maps with dense metal everywhere, for the mex‑denier):
`Oort_Cloud_V2`, `Asteroid_Mines_V2.1`, `Cloud9_V2`, `Iron_Isle_V1`, `Nine_Metal_Islands_V1`,
`SpeedMetal BAR V2`.

⇒ **A builder's job for metal is simply: paint the metalmap, set `maxMetal` and `extractorRadius`.**
There is no spot list to emit for the engine or for maps‑metadata.

### 7.3 The Lua escape hatch: `mapconfig/map_metal_layout.lua`

BAR's `luarules/gadgets/map_metal_spot_placer.lua` ("Map Lua Metal Spot Placer" / "Places metal spots
according to lua metal map", raaar, 2017, `layer = -10`, synced) lets a map declare spots in Lua
**only when the SMF metalmap is empty**:

```lua
local MAPSIDE_METALMAP = "mapconfig/map_metal_layout.lua"
local METAL_MAP_SQUARE_SIZE = 16
local mapConfig = VFS.FileExists(MAPSIDE_METALMAP) and VFS.Include(MAPSIDE_METALMAP) or false

function gadget:Initialize()
  -- dont add lua metal when map already has metal somewhere on it
  local hasMetalmap = false
  for x = 1, MAP_SIZE_X / 4 do for z = 1, MAP_SIZE_Z / 4 do
    if select(3, Spring.GetGroundInfo(x*4, z*4)) > 0 then hasMetalmap = true; break end
  end ... end

  if not hasMetalmap and mapConfig and Spring.GetGameFrame() == 0 then
    local spots = mapConfig.spots
    local metalFactor = 0.43 * 9 / 21
    for i = 1, #spots do
      local spot = spots[i]           -- { x = <elmos>, z = <elmos>, metal = <number> }
      local xIndex = math.floor(spot.x / METAL_MAP_SQUARE_SIZE)
      local zIndex = math.floor(spot.z / METAL_MAP_SQUARE_SIZE)
      for dxi = -2, 2 do for dzi = -2, 2 do
        if not (math.abs(dxi) == 2 and math.abs(dzi) == 2) then   -- skip corners
          Spring.SetMetalAmount(xIndex+dxi, zIndex+dzi, spot.metal * metalFactor * 255)
        end
      end end
    end
  end
end
```

File shape:

```lua
return {
  spots = {
    { x = 1234, z = 5678, metal = 2.0 },
    …
  },
}
```

It stamps a 21‑cell plus‑shaped blob (5×5 minus corners) per spot at
`metal × 0.43 × 9/21 × 255`. None of the six sampled archives use it; it exists for maps whose
metal was authored as a point list rather than a bitmap.

### 7.4 What `maps-metadata` *does* store

`maps-metadata` stores **start boxes, start positions and descriptive metadata** — not metal.
Repo structure (`github.com/beyond-all-reason/maps-metadata@main`, read 2026‑09‑13):

```
map_list.yaml              <- THE source of truth (778 KB, 226 maps), generated from Rowy
schemas/
  map_list.yaml            <- JSON Schema (draft 2020-12) for the above
  cdn_maps.yaml            <- shape of springfiles /find responses
  live_maps.yaml  lobby_maps.yaml  teiserver_maps.yaml  map_modoptions.yaml
scripts/js/src/            <- generators + `check_*.ts` validators
scripts/py/                <- yaml_to_json.py, gen_nextmap_maplists.py, update_spads_conf.py
cloud/map-parser/          <- Cloud Run service that parses an sd7 into images + metadata.json
cloud/serving/             <- Cloudflare worker serving gen/ + imagor image proxy
cloud/rowy/functions/      <- Rowy (Firestore) hooks
cloud/github-trigger/      <- "Open PR" button backend
gen/                       <- build output directory; empty in the repo, populated by `make`
                              (it is NOT listed in .gitignore)
Makefile                   <- the whole build/validate/deploy graph
```

**`map_list.yaml` entry shape** (keyed by an opaque Rowy document id, `schemas/map_list.yaml`).
Required: `springName, displayName, author, gameType, terrain, playerCount, teamCount, certified,
inPool, photo, backgroundImage, perspectiveShot, inGameShots`. A real entry, verbatim:

```yaml
0jMFtrg8MuFKGgxmk6Nm:
  springName: Boreal Falls 1.0.2
  displayName: Boreal Falls
  author: pk76, Anka
  description: 1v1, 2v2 or 3v3 battle on ice and snow.
  gameType: [team]
  terrain: [ice, hills, ...]
  playerCount: 6
  teamCount: 2
  minPlayerCount: 2
  certified: true
  inPool: true
  photo:
    - ref: maps/0jMFtrg8MuFKGgxmk6Nm/photo/CCrlJrjgVLcbz0b4Zh8Y-borealfallsmini.png
      downloadURL: https://firebasestorage.googleapis.com/...
      name: borealfallsmini.png
      type: image/png
      lastModifiedTS: 1771354022251
  startboxesSet:
    5sGkOgQ7Ao7M8vtxrBro:
      maxPlayersPerStartbox: 3
      startboxes:
        - poly: [{x: 0,   y: 130}, {x: 70,  y: 200}]
        - poly: [{x: 130, y: 0},   {x: 200, y: 70}]
```

**Start boxes.** Coordinates are in a **0…200 normalised space** (integers, `minimum: 0,
maximum: 200`). Two shapes, discriminated by point count:

* **2 points** = axis‑aligned rect (top‑left, bottom‑right). *"Every existing map ships this, and it
  is the only shape the engine, SPADS and TEIServer understand directly."*
* **3+ points** = closed polygon ring; each point may carry `strength` ∈ [0,1] for Catmull‑Rom
  tessellation (0/omitted = sharp corner, 1 = full curve; Rowy snaps to multiples of 0.025).

BAR converts to world space with `scaleX, scaleZ = Game.mapSizeX/200, Game.mapSizeZ/200`
(`luarules/gadgets/include/startbox_utilities.lua:168-169`).

`maxPlayersPerStartbox` ∈ [1,16]. CI (`check_startboxes.ts`) additionally enforces: at most one
configuration per team count; 2‑point rects must satisfy `a.x < b.x && a.y < b.y`; polygons must
have non‑degenerate shoelace area (`|2A| ≥ 1`); and
`startboxes.length × maxPlayersPerStartbox ≤ playerCount`.

**Start positions** (`startPos`, optional; only for the start‑position‑suggestion widget) are in
**world elmos**:

```json
{
  "positions": { "A": {"x":100,"y":100}, "B": {"x":200,"y":441}, ... },
  "team": [{
    "playersPerTeam": 2, "teamCount": 2,
    "sides": [
      { "starts": [ {"spawnPoint":"A","role":"air"},
                    {"spawnPoint":"B","role":"front","baseCenter":"E"} ] },
      { "starts": [ {"spawnPoint":"C","role":"air/front"},
                    {"spawnPoint":"D","role":"front"} ] }
    ]
  }]
}
```

`role` ∈ `air, air/front, air/sea, air/tech, front, front/sea, front/tech, sea, sea/tech, tech`.
Position keys match `^[a-zA-Z0-9 _.-]+$`. CI (`check_startpos.ts`) enforces
`teamCount == #sides`, `playersPerTeam == #side.starts`, all referenced position names exist, and
no duplicate `(teamCount, playersPerTeam)` pairs.

**`terrain` tag vocabulary** (enum, order is the website's display order):
`lava, ice, acidic, alien, asteroid, space, desert, forests, grassy, tropical, swamp, jungle,
wasteland, metal, industrial, ruins, sea, water, island, shallows, chokepoints, asymmetrical,
flat, hills`. **`gameType` enum:** `ffa, 1v1, team, pve`.

**How start boxes reach the game.** `gen_map_modoptions.ts` re‑keys `startboxesSet` by team count
and encodes it as **`base64url(zlib(json))` with `=` padding stripped**, published as modoption
`mapmetadata_startboxes_set` (and `mapmetadata_startpos` for start positions). The value pattern is
`^[a-zA-Z0-9_.-]+$`, which is why padding must go. BAR consumes it in
`luarules/gadgets/include/startbox_utilities.lua` with resolution order
`mapmetadata_startbox_override` → exact team‑count match → next larger → next smaller.

---

## 8. Publishing: getting a map into the live BAR pool

Authoritative source: the maps‑metadata wiki page **"Adding or updating a created map in the game"**
(`github.com/beyond-all-reason/maps-metadata/wiki`), quoted below.

> This instructions assume that your map was already reviewed and approved according to the process
> outlined on Discord `#mapping` channel. Those steps are for the final upload so the map is
> available in the game.

### Step 0 — review (prerequisite)

Per [beyondallreason.info/guide/map-reviews-process](https://www.beyondallreason.info/guide/map-reviews-process):
post in the BAR Discord `#mapping` channel, *"Create a thread where you attach and keep current map
files of the project"*, ping the `@mapper` role, iterate, then ask for a formal review. *"at least 2
reviewers have to weigh in for final approval, or @IceXuick if there is no consensus."*
Also run the public [Map Checklist](https://www.beyondallreason.info/guide/map-checklist) — note
its hard limit: *"Maps larger than 32x32 or 32 in any dimension will not be accepted."*

### Step 1 — upload the archive

> You can upload the map file to https://springfiles.springrts.com/. It makes it available across
> all Recoil/Spring Engine games.
>
> Alternatively, you can upload the file directly to BAR CDN, skipping SpringFiles. To do so, upload
> the map file to the Google Cloud Storage Bucket `bar-springfiles-syncer_assets-upload` from where
> it will be transferred directly to our CDN. All members of the BAR's Google Group (that included
> contributors) have permission to do this.

Mechanically: BAR's CDN worker (`beyond-all-reason/maps-hosting`, `fetcher/src/index.ts`) serves a
springfiles‑compatible API at `https://files-cdn.beyondallreason.dev/find?category=map&springname=…`.
On a KV miss it falls through to `https://springfiles.springrts.com/json.php`
(`lib/index.ts: fetchFromSpringFiles`) and queues a Pub/Sub `SyncRequest` to pull the file into the
three R2 buckets (weur / wnam / apac, chosen by client geo). It refuses ambiguity:
`result.length > 1` ⇒ 400, and `result[0].springname != springname` ⇒
*"Non‑deterministic springname requested"*. **So the springname you register must be exact and
unique.**

Response shape (this is `schemas/cdn_maps.yaml`):

```json
[{"filename":"comet_catcher_remake_1.8.sd7","springname":"Comet Catcher Remake 1.8",
  "md5":"478e53f181d0940b76d028411093b47a","category":"map","path":"maps","tags":[],
  "size":41565457,"timestamp":"2022-11-17T10:35:04.158",
  "mirrors":["https://files-cdn.beyondallreason.dev/file/478e53f181d0940b76d028411093b47a/comet_catcher_remake_1.8.sd7"]}]
```

Note: maps are **not** distributed via rapid (`.sdp`) — rapid is for the game archive. Map download
in‑client is pr‑downloader hitting this `/find` + `/download` API.

### Step 2 — add the row in Rowy

> Sign in to our Rowy instance: https://rowy.beyondallreason.dev/. By default you will only have a
> viewer role. You need to ask Marek, Nikuksis, Beherith or IceXuick to get an editor role.
>
> In the Maps table: If you are adding an entirely new map, click "Add row". …
> Start with the "spring name" column. When you fill it in, the "Parse" column will show text
> "Parsing…". Once parsing is successful it will change to "Done" and automatically fill in a few of
> the fields.

The parse step is the Cloud Run `map-parser` service (`cloud/map-parser/`): it downloads the map
from the CDN, runs `spring-map-parser` v6.4.2, and writes to
`gs://maps-cache-8512/<springName>/cache-v3/`:

```
texture.jpg  texture-preview.jpg  texture-dry.jpg  texture-dry-preview.jpg
height.png   type.png             metal.png        mini.jpg
res_detailNormalTex.png  res_specularTex.png  skybox.png
metadata.json   -- { mapInfo, minHeight, maxHeight, fileName, springName,
                     isArchiveSolid, smd, smf, cacheVersion, extractedFiles }
```

`metadata.json` is what every downstream `check_*` and generator reads, including
`isArchiveSolid` (the §1.4 gate) and `smf.mapWidth`/`smf.mapHeight` (used as
`meta.smf.mapWidth / 64` for the displayed map size).

Then fill: Author, Photo (min 1024 px, top‑down, aspect must match the map — see §9),
Terrain tags, Game Type, Team/Player Count, Startboxes (graphical editor — *"Remember to click save
button"*), Certified (*"All new maps should be marked as certified"*), Map Lists, optional StartPos
JSON and TMD upload.

### Step 3 — open the PR

> Click the "Open PR 🔀" button located in the last column of the row you added to Rowy. This will
> after a moment generate a new GitHub pull request in the maps-metadata repository containing your
> changes. … A map curator will review the pull request and merge it if there are no issues.
>
> If you forget to click the button, every 24 hours automation creates a pull request with *all*
> changes in Rowy to keep the repository and Rowy in sync.

(`.github/workflows/sync_map.yaml`: `schedule: cron '0 5 * * *'`, plus `workflow_dispatch` and a
`repository_dispatch: [sync_map]` from the Rowy button; it runs
`tsx scripts/js/src/update_from_rowy.ts map_list.yaml <id|all>` and opens/updates branch
`sync-map-<id>`.)

### Step 4 — CI validation

`.github/workflows/ci.yaml` runs `make -j` then `make -j test`. The validations that can block you:

| check | what it enforces |
|---|---|
| `validate_schema.ts` | `map_list.yaml` against `schemas/map_list.yaml` (Ajv, draft 2020‑12) |
| `check_archive_not_solid.ts` | **archive must be non‑solid** (whitelist empty) |
| `check_uses_mapinfo_lua.ts` | **archive must contain `mapinfo.lua`** (whitelist: `Mescaline_V2` only) |
| `check_photo_aspect_ratio.ts` | photo aspect must match `smf.mapWidth/mapHeight`; tolerance `\|inferredHeight − mapHeight/64\| ≤ 0.75` map units |
| `check_startboxes.ts` | §7.4 rules |
| `check_startpos.ts` | §7.4 rules |
| `typecheck_scripts` | `tsc --noEmit` |

`derived_map_info.ts` builds an `info` object and **throws** `Missing value for map X key K` if any
key is `undefined` or `''`, skipping only `windAvg` and `version`
(`scripts/js/src/derived_map_info.ts:126-152`). In practice only one field can actually be missing:

* `windMin` / `windMax` — wrapped in `orDefault(…, 5)` / `orDefault(…, 25)` (`:132-133`), so they
  are **not** required in `mapinfo.lua`.
* `voidWater` — `orDefault(…, false)` (`:140`), also not required.
* `minPlayerCount` — falls back to `Math.ceil(playerCount * 0.6)` (`:142`).
* **`tidalStrength` has no default** (`:138`) — `meta.mapInfo.tidalstrength` must be present in
  `mapinfo.lua` or the maps‑metadata build fails.

`width`/`height`/`mapHeightMin`/`mapHeightMax` come from the parsed archive, not from you.

### Step 5 — automatic fan‑out on merge

> After your pull request gets merged, there is nothing more to do, the automation takes over and
> pushes the map automatically to all the places it's supposed to be in. Your map will be available
> in game within a few minutes.

`ci.yaml` jobs on `main`:

| job | destination | artefacts |
|---|---|---|
| `deploy-cdn` | Cloudflare R2 via rclone, then an MQTT ping on `broker.hivemq.com` topic `dev.beyondallreason.maps-metadata/live_maps/updated:v1` | `gen/live_maps.validated.json` etc. |
| `deploy-chobby` | `beyond-all-reason/BYAR-Chobby` (auto‑commit) | `LuaMenu/configs/gameConfig/byar/mapDetails.lua`, `…/savedBoxes.dat`, `minimapOverride/*.jpg`, `minimapThumbnail/*.png` |
| `deploy-spads-config` | `beyond-all-reason/spads_config_bar` | `etc/mapBoxes.conf`, `mapLists.conf`, `mapPresets.conf`, `mapBattlePresets.conf`, patched `spads_cluster.conf` |
| `deploy-website` | Webflow CMS collection | via `sync_to_webflow.ts` |
| `deploy-teiserver` | TEIServer | via `sync_to_teiserver.ts` |
| `deploy-gdrive` | Google Drive | via `sync_to_gdrive.ts` |

Full `gen/` target list from the `Makefile`: `map_list.validated.json`, `mapDetails.lua`,
`live_maps.validated.json`, `mapBoxes.conf`, `mapLists.conf`, `custom_map_lists.json`,
`discordPresenceThumb`, `mapPresets.conf`, `mapBattlePresets.conf`, `lobby_maps.validated.json`,
`teiserver_maps.validated.json`, `webflow_rowy_data.json`.

---

## 9. Minimap and preview images

### 9.1 Inside the archive

* **The engine minimap lives in the `.smf`**: 1024×1024 DXT1 with 8 further mip levels
  (`MINIMAP_NUM_MIPMAP = 9` total), 699 048 bytes at `minimapPtr` (§4.2). It is uploaded level by
  level with `glCompressedTexImage2DARB(..., GL_COMPRESSED_RGBA_S3TC_DXT1_EXT, mipsize, mipsize, ...)`
  where `mipsize = 1024 >> i` and `size = ((mipsize+3)/4)² * 8` (`SMFReadMap.cpp:183-189`), so the
  chain must be exactly 9 levels, 1024² down to 4², tightly packed.
  pymapconv builds it by resizing the main texture to 1024×1024 with LANCZOS unless `-p/--minimap`
  supplies a custom image, then compresses with `dxt1a` "else we can get spurious alpha pixels"
  (`pymapconv.py:481-504`), and writes `minimapdata[:MINIMAP_SIZE]` — *"dont even write more than
  needed, or else produced map will crash!"* (`:1057`).
  The BAR **Map Checklist** says the minimap is *"sometimes required to lighten in a bit, use
  pymapconv"* — note there is **no explicit lighten/brighten flag** in `pymapconv.py`'s argument
  parser (`:1356-1447`); the intended workflow is presumably to brighten the source texture or feed
  a pre‑lightened image via `-p/--minimap`. **UNVERIFIED — needs confirmation.**
* `mapinfo.smf.minimapTex` can override it with an external file
  (`MapInfo.cpp:411`, loaded via `CBitmap::Load` → `CreateTexture`, `SMFReadMap.cpp:161-170`);
  unlike the metal/type/grass overrides there is **no dimension check**. **No BAR pool map uses
  this.**
* Loose preview images *do* get shipped but nothing reads them: Comet Catcher has
  `maps/mini.png` (1024×1024 PNG, 1.4 MB) and `maps/mini.dds` (1024×1024 DXT1 + 9 mips,
  = `MINIMAP_SIZE` + 128 B DDS header); Boreal Falls has `maps/BorealFalls.jpg` (1024×1024 JPEG)
  and `maps/BorealFalls.png` (128×128 PNG). **A builder should not emit these** — they are
  compiler by‑products and lobby previews come from maps‑metadata instead.

### 9.2 Outside the archive — what the map browser actually uses

The lobby/browser images are **not in the archive**. They are derived from the Rowy "Photo" upload
through an [imagor](https://github.com/cshum/imagor) proxy at
`https://maps-metadata.beyondallreason.dev/i/` and committed into BYAR‑Chobby
(`scripts/js/src/update_byar_chobby_images.ts`):

```ts
const minimapOverrideUrlBase  = `${imagorUrlBase}fit-in/1024x1024/filters:format(jpeg):quality(90)`;
const minimapThumbnailUrlBase = `${imagorUrlBase}fit-in/stretch/128x128/filters:fill(transparent):format(png)`;
…
LuaMenu/configs/gameConfig/byar/minimapOverride/<SpringName with ' '→'_'>.jpg   // 1024x1024 max
LuaMenu/configs/gameConfig/byar/minimapThumbnail/<SpringName with ' '→'_'>.png  // 128x128
```

(The filename mapper lowercases for dedup but writes `springName.replace(/ /g,'_')`.)

`check_photo_aspect_ratio.ts` fetches the same photo at `fit-in/512x512` and asserts

```ts
const inferedMapHeight = ((meta.smf.mapWidth / 64) * imgHeight) / imgWidth;
if (Math.abs(inferedMapHeight - meta.smf.mapHeight / 64) > 0.75) -> FAIL
```

⇒ **the uploaded photo's aspect ratio must match `mapx : mapy` within ±0.75 map units.**

Image requirements from the Rowy fields legend:

| field | requirement |
|---|---|
| **Photo** | top‑down in‑game shot, as flat as possible, low FOV, aligned to the minimap so metal spots line up. Hide UI (F5 / Ctrl+F7). `/featuredrawdistance 300000`, `/featurefadedistance 300000`, `/OverheadMaxHeightFactor 3`. **Min width/height: 1024 px.** |
| **Background image** | overall view, DOF widget on. **Min width 1920 px.** |
| **Perspective photo** | FOV 30–40, **transparent PNG**, not too low an angle. **Min width 1440 px.** |
| **In Game Shots** | interesting details, some units for scale. **Min width 1920 px.** |

---

## 10. Reference: a complete, correct `mapinfo.lua` skeleton

Distilled from the six real archives + BAR's own `mapgenerator/mapinfo_template.lua`. Keys are
case‑insensitive at the engine level (every BAR map calls `lowerkeys(mapinfo)` before returning),
but the `mapconfig/mapinfo/` merge runs `lowerkeys` too, so use CamelCase consistently and let the
helper normalise.

```lua
local mapinfo = {
  name        = "My Map",            -- springname = name .. " " .. version
  shortname   = "MM",
  description = "8v8 team map",
  author      = "you",
  version     = "1.0",
  mapfile     = "maps/MyMap.smf",    -- ALWAYS set: avoids the O(n) smf scan
  modtype     = 3,                   -- 3 = map (required by ArchiveScanner)
  depend      = {"Map Helper v1"},   -- the engine adds this anyway
  replace     = {},

  maphardness     = 100,
  notDeformable   = false,
  gravity         = 100,             -- engine: max(0.001, v) / (GAME_SPEED^2), negated
  tidalStrength   = 0,               -- BAR checklist: 0..25
  maxMetal        = 1.0,             -- metal per metalmap byte
  extractorRadius = 100.0,
  voidWater       = false,
  voidGround      = false,
  autoShowMetal   = true,

  smf = {
    minheight    = -60,              -- overrides SMFHeader.minHeight
    maxheight    = 940,
    smtFileName0 = "MyMap.smt",      -- optional; count must equal numTileFiles
  },

  sound = { preset = "default",
            passfilter = { gainlf = 1.0, gainhf = 1.0 }, reverb = {} },

  resources = {
    detailTex                     = "detailtexblurred.bmp",   -- -> maps/…
    specularTex                   = "MyMap_specular.dds",     -- 256S x 256T, RGB=color A*16=exp
    detailNormalTex               = "MyMap_normals.dds",      -- 512S x 512T, RGB=TS normal A=blend
    splatDistrTex                 = "MyMap_splatdist.dds",    -- 128S x 128T, RGBA weights
    splatDetailTex                = "iwantDNTS.tga",          -- PLACEHOLDER, must be non-empty
    splatDetailNormalDiffuseAlpha = 1,
    splatDetailNormalTex1         = "rock_dnts.tga",          -- tiling 1024^2 RGBA
    splatDetailNormalTex2         = "dirt_dnts.tga",
    splatDetailNormalTex3         = "grass_dnts.tga",
    splatDetailNormalTex4         = "sand_dnts.tga",
    -- optional:
    -- skyReflectModTex  = "MyMap_reflmask.dds",   -- same size as specularTex
    -- parallaxHeightTex = "MyMap_parallax.dds",   -- MUST equal specularTex size
    -- lightEmissionTex  = "MyMap_emit.dds",
    -- grassShadingTex   = "grass_shading.tga",    -- defaults to the 1024^2 minimap
    -- grassBladeTex     = "grass_blade.tga",
  },

  splats = {
    texScales = {0.0075, 0.0139, 0.0018, 0.0018},  -- world->UV per DNTS channel
    texMults  = {0.44,   0.30,   0.23,   2.50},
  },

  atmosphere = {
    minWind = 5, maxWind = 25,                     -- BAR checklist: 0..30; engine defaults 5/25
    fogStart = 0.6, fogEnd = 0.95,                 -- engine defaults are 0.1 / 1.0
    fogColor = {0.5,0.5,0.5}, skyColor = {0.43,0.58,0.64},
    sunColor = {1.0,0.92,0.78}, cloudColor = {0.9,0.9,0.9},
    -- skyDir = {0,0,-1},                          -- DEPRECATED: logged as L_DEPRECATED and ignored
    -- skyAxisAngle = {0,0,1, 0},                   -- use this instead (MapInfo.cpp:145-161)
    skyBox = "MyMap_Skybox.dds",                   -- DDS CUBEMAP, 2048^2/face
  },

  lighting = { sunDir = {1.0,1.0,1.0}, groundAmbientColor = {…}, … },
  water    = { … },

  teams = { [0] = {startPos = {x = 855, z = 6409}},   -- world elmos, MapParser::GetStartPos
            [1] = {startPos = {x = 6364, z = 688}} },

  terrainTypes = { [0] = {name="Default", hardness=1, receiveTracks=true,
                          moveSpeeds={tank=1,kbot=1,hover=1,ship=1}}, … },

  custom = { fog = {...}, precipitation = {...} },   -- read by map/game Lua only
}

local function lowerkeys(ta) … end                   -- (verbatim from any BAR map)
lowerkeys(mapinfo)

do  -- mapconfig/mapinfo/*.lua merge block, §2.5
  …
end

return mapinfo
```

Engine defaults worth knowing, all from `rts/Map/MapInfo.cpp` (the authority — `mapdefaults.lua` is
a *legacy TDF* default table and disagrees in places, see below):
`maphardness 100` (`:98`), `gravity 130` (`:101`), `tidalStrength 0` (`:105`), `maxMetal 0.02`
(`:106`), `extractorRadius 500` (`:107`), `voidAlphaMin 0.9` (`:108`), `voidWater/voidGround false`
(`:109-110`), `autoShowMetal true` (`:124`), `minWind 5 / maxWind 25` (`:135-136`),
`fogStart 0.1 / fogEnd 1.0` (`:138-139`), `cloudDensity 0.5` (`:166`),
`splats.texScales {0.02,…} / texMults {1.0,…}` (`:181-182`),
`grass.bladeWidth 0.7 / bladeHeight 4.5 / bladeAngle 1.0 / maxStrawsPerTurf 150` (`:192-195`),
`lighting.specularExponent 100` (`:222`).

⚠ Do **not** read grass defaults out of `mapdefaults.lua`: it lists
`grassBladeWidth 0.32 / grassBladeHeight 4.0 / grassBladeAngle 1.57` (`:85-90`) under *different key
names* from the ones `CMapInfo::ReadGrass()` actually reads (`bladeWidth`, `bladeHeight`,
`bladeAngle`). The engine's values above are what applies. `mapdefaults.lua` agrees with the engine
on `hardness/gravity/tidalStrength/maxMetal/extractorRadius` (`:18-22`) and on `splats` (`:92-95`).

---

## 11. Gotchas checklist for a map builder

1. **`-ms=off`.** Solid `.sd7` = rejected by BAR CI (empty whitelist). The engine's own rejection is
   currently dormant (§1.4) but a solid archive is still read single‑threaded.
2. **No password, no `-mhe=on`, no PPMd, no bzip2‑in‑zip.** No AES decoder is compiled in.
3. **`mapinfo.lua` at the archive root** and `modtype = 3`. A stray `modinfo.lua` alongside it is
   ignored (mapinfo wins, `ArchiveScanner.cpp:753-766`) but ship neither it nor a game archive's
   layout.
4. **Set `mapfile = "maps/<Name>.smf"`** — otherwise the scanner logs a warning and linear‑scans.
5. **Exactly one `.smf`.** `SearchMapFile` takes the first match in archive order.
6. **The `.smt` name inside the `.smf` must resolve** as `maps/<that name>`, or the map renders
   solid red (`memset(..., 0xaa, ...)`). Max 254 bytes — the read buffer is `char[256]`
   (`SMFGroundTextures.cpp:134`).
7. **`splatDistrTex` is the one you cannot omit** — its fallback is `(255,0,0,0)`, all weight on
   DNTS layer 1. `splatDetailTex` only *used* to be mandatory for the DNTS path; master fixed that
   in `510b1aea` (§5.7). Still ship the community placeholder `"iwantDNTS.tga"` (the file need not
   exist) for compatibility with pinned older engines.
8. **`parallaxHeightTex` must be exactly the same dimensions as `specularTex`** — the shader
   indexes both with `specTexCoords` and the offset rescale assumes equal size.
9. **Keep aspect ratios `mapx : mapy`** on specular / normal / splat‑distribution / reflect /
   emission. Two of six pool maps get this wrong and are visibly stretched.
10. **No sRGB anywhere.** Don't let an exporter gamma‑correct DDS/TGA/PNG output.
11. **DXT1 has no alpha.** A DXT1 `detailNormalTex` blends at strength 1.0 unconditionally; use
    DXT5 if you want the alpha blend factor. Same for `splatDetailNormalTexN` — the diffuse‑alpha
    feature needs an alpha channel, so those must be DXT5 or 32‑bit TGA.
12. **Metalmap is `mapx/2 × mapy/2`**, one byte per 16 elmos, red channel of an 8‑bit BMP; yield =
    `byte × maxMetal`. The BAR guide's "16 × [map size]" formula for metal/type is wrong; it is
    `32 ×`.
13. **Strip build sources** (`*.tmd`, `maps/source/`, `maps/map_source_files/`, `mini.png`,
    `mini.dds`) — upload the TMD to Rowy instead. Comet Catcher wastes ~2 MB, Coast To Coast
    ~4 MB.
14. **Strip dotfiles.** They're ignored by the checksum but still shipped to every player.
15. **Archive filename: lowercase, no spaces, `.sd7`** — enforced by
    `cdn_maps.yaml`'s `^[^ ]+\.(sd7|sdz)$` and by 226/226 pool convention.
16. **Springname must be globally unique and exactly reproducible** (`name + " " + version`); the
    CDN worker 400s on an ambiguous or mismatching springname.
17. **`tidalStrength` must be present** or `derived_map_info.ts` throws during the maps‑metadata
    build. `minWind`/`maxWind`/`voidWater` have defaults there (5 / 25 / false) and are not strictly
    required — but set them anyway; the BAR checklist ranges are wind 0..30, tidal 0..25.
18. **Map size hard limit for the pool:** *"Maps larger than 32x32 or 32 in any dimension will not
    be accepted."* (BAR Map Checklist) — i.e. `mapx ≤ 2048`. The engine constraint is separate:
    `mapx`/`mapy` must be multiples of **128** (`bigSquareSize = 32 * tileScale`,
    `SMFReadMap.h:181-182`), and this is *not* validated by `CheckHeader` — a bad value just
    truncates the big‑texture grid.
19. **`maphelper/mapinfo.lua`** inside the map is legacy and optional — but if you ship one, ship
    the exact 412‑byte shim, not a copy of your mapinfo.
20. **Case collisions.** The VFS index is lower‑cased; `Rock.tga` and `rock.tga` in the same
    archive is undefined behaviour.
21. **Don't collide with game content.** `FIND_MAP_TEXTURE` probes `SPRING_VFS_ZIP`, which spans the
    *game* archive too, so a bare path that also exists in BAR resolves to BAR's copy (§5.1).
22. **Strip `desktop.ini` / `Thumbs.db`.** They don't start with `.`, so the checksum ignore filter
    misses them and they ship to every player (Comet Catcher carries six).

---

## Sources

Engine (github.com/beyond-all-reason/RecoilEngine @ master, read 2026‑09‑13):
* `rts/System/FileSystem/ArchiveLoader.cpp` (:19‑34 factories, :48‑83 dispatch)
* `rts/System/FileSystem/ArchiveScanner.cpp` (:62 INTERNAL_VER, :74‑87 knownTags, :89‑120 meta
  classes, :571‑598 CheckCompression, :601‑615 SearchMapFile, :697‑830 ScanArchive,
  :958‑970 CreateIgnoreFilter, :979‑1090 checksum, :1652‑1664 MapNameToMapFile,
  :186‑200 name+version HACK)
* `rts/System/FileSystem/Archives/{ArchiveTypes.h,IArchive.h,IArchiveFactory.h,BufferedArchive.{h,cpp},SevenZipArchive.{h,cpp},ZipArchive.{h,cpp},DirArchive.cpp}`
* `rts/lib/minizip/unzip.c` + `rts/lib/minizip/CMakeLists.txt:23` (`-DNOCRYPT -DNOUNCRYPT`)
* `rts/Map/SMF/SMFFormat.h`, `rts/Map/SMF/SMFMapFile.cpp`, `rts/Map/SMF/SMFReadMap.cpp`,
  `rts/Map/SMF/SMFGroundTextures.cpp`, `rts/Map/SMF/SMFRenderState.cpp`
* `rts/Map/MapInfo.cpp`, `rts/Map/MapParser.cpp`, `rts/Map/ReadMap.cpp`, `rts/Map/MetalMap.cpp`
* `rts/Rendering/Textures/Bitmap.cpp`
* `cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl`
* `cont/base/maphelper/maphelper/{mapinfo.lua,mapdefaults.lua}`, `cont/base/maphelper/modinfo.lua`
* `cont/base/springcontent/features/treetype.lua`
* `rts/CMakeLists.txt:88`, `rts/System/FileSystem/Archives/CMakeLists.txt:45`

7‑Zip SDK (github.com/beyond-all-reason/pr-downloader @ master):
* `src/lib/7z/7zDec.c` (:8 PPMd disabled, :23‑36 method ids, :279‑372 CheckSupportedFolder)
* `src/lib/7z/CMakeLists.txt`

Game (github.com/beyond-all-reason/Beyond-All-Reason @ master):
* `gamedata/featuredefs.lua`, `gamedata/defs.lua`
* `features/{enginetrees_override,rocks30,geovent}.lua`
* `luarules/gadgets/map_metal_spot_placer.lua`
* `luarules/gadgets/include/startbox_utilities.lua`
* `common/upgets/api_resource_spot_finder.lua`
* `mapgenerator/mapinfo_template.lua`
* `common/configs/LavaMaps/README.md`, `modules/lava.lua`

Metadata & hosting:
* github.com/beyond-all-reason/maps-metadata — `map_list.yaml`, `schemas/*.yaml`, `Makefile`,
  `.github/workflows/{ci,sync_map}.yaml`, `scripts/js/src/*`, `cloud/map-parser/src/*`
* github.com/beyond-all-reason/maps-metadata/wiki —
  *Adding or updating a created map in the game*, *Rowy Maps fields legend*
* github.com/beyond-all-reason/maps-hosting — `fetcher/src/index.ts`, `lib/index.ts`

Community docs:
* https://www.beyondallreason.info/guide/mapping-1-file-structure-prerequisites
* https://www.beyondallreason.info/guide/map-checklist
* https://www.beyondallreason.info/guide/map-reviews-process
* https://www.beyondallreason.info/guide/mapmaking-resources
  (links Beherith's Spring Map Compiler — `github.com/Beherith/springrts_smf_compiler`,
  SpringBoard Editor, and 7‑Zip as the packing tool)

Measured artefacts (downloaded 2026‑09‑13 from `files-cdn.beyondallreason.dev`, inspected with
`py7zr` 1.1.3): `comet_catcher_remake_1.8.sd7`, `hooked_1.1.1.sd7`, `speedmetal_bar_v2.sd7`,
`coast_to_coast_bar_v1.0.sd7`, `altair_crossing_v4.1.sd7`, `boreal_falls_1.0.2.sd7`; plus the
`/find` responses for all 226 `springName`s in `map_list.yaml`.

Map compiler (github.com/**Beherith/springrts_smf_compiler** — note: *not* `Beherith/Spring_SMF_compiler`,
which 404s; CC0‑1.0, default branch `master`, last push 2026‑06‑24):
* `src/pymapconv.py` (:38‑79 struct definitions, :88 `MINIMAP_SIZE`, :481‑504 minimap generation,
  :734‑736 hardcoded `featuretypes`, :1050‑1069 SMF write order, :1356‑1447 CLI arguments)
* `resources/geovent.bmp`, `src/springrts_smf_minimapper.py`, `src/tree_placer_springrts.py`,
  `src/springboard_model_lua_to_set_lua_feature_dumper.py`

---

## Verification log

Adversarial re‑check performed 2026‑09‑13. Every engine file below was fetched raw from
`raw.githubusercontent.com/beyond-all-reason/RecoilEngine/master/…` with `curl` and read in full;
line numbers in this document have been corrected to match those exact files. Repository
`beyond-all-reason/maps-metadata` was cloned at `main`. `comet_catcher_remake_1.8.sd7` was
re‑downloaded from the CDN and re‑parsed independently.

| # | Claim | Source checked | Verdict |
|---:|---|---|---|
| 1 | `SMFHeader` is 80 B, LE, with the exact field order in §4.1 | `rts/Map/SMF/SMFFormat.h:49-70`; independently `pymapconv.py:38` (`'< 16s i i i i i i i f f i i i i i i i'`) | **confirmed** (two independent sources) |
| 2 | `MINIMAP_SIZE = 699048`, `MINIMAP_NUM_MIPMAP = 9`, `SMALL_TILE_SIZE = 680` | `SMFFormat.h:28`, `:31`, `:34`; `pymapconv.py:88` | **confirmed** |
| 3 | `ExtraHeader = {int32 size; int32 type;}`, `MEH_Vegetation = 1`; the vegetation variant adds `int32 pos` | `SMFFormat.h:83-86`, `:103`; `SMFMapFile.cpp:239-270`; `pymapconv.py:60` (`'< i i i'`) | **confirmed** |
| 4 | `MapTileHeader` 8 B, `MapFeatureHeader` 8 B, `MapFeatureStruct` 24 B, `TileFileHeader` 32 B | `SMFFormat.h:123-127`, `:135-139`, `:148-157`, `:175-183` | **confirmed** (doc's line refs corrected) |
| 5 | Header validation rejects `version != 1`, `tilesize != 32`, `texelPerSquare != 8`, `squareSize != 8`, bad magic | `SMFMapFile.cpp:16-28` | **confirmed**; **corrected**: divisibility of `mapx`/`mapy` is *not* validated — the 128 constraint comes from `SMFReadMap.h:181-182` + `SMFReadMap.cpp:120` |
| 6 | Info‑map sizes `height (mapx+1,mapy+1)`, `grass /4`, `metal /2`, `type /2` | `SMFMapFile.cpp:193-203` | **confirmed** |
| 7 | Comet Catcher `.smf` byte budget in §4.2 reproduces every stored pointer and EOF | re‑downloaded `comet_catcher_remake_1.8.sd7` (md5 `478e53f181d0940b76d028411093b47a`) and re‑parsed with Python `struct` | **confirmed exactly**, incl. `mapid 509`, `ExtraHeader (12,1,92)`, `MapTileHeader (1,49153)`, 17 feature‑type names = 174 B, EOF 2 914 770 |
| 8 | `.smt` = 32 + numTiles×680 = 33 424 072 | archive entry size for `maps/CCRXR.smt` | **confirmed** |
| 9 | Five archive factories keyed on lowercase extension; `ARCHIVE_TYPE_*` values | `ArchiveLoader.cpp:19-34`, `:50`, `:65`; `ArchiveTypes.h:6-14` | **confirmed**; **added**: `CNT=5`, `BUF=6`; extension comes from `GetDefaultExtension()` |
| 10 | PPMd is not compiled in; accepted main coders Copy/LZMA/LZMA2; folder shapes 1/2/4 coders; no AES | pr‑downloader `src/lib/7z/7zDec.c:8`, `:23-37`, `:41`, `:279-294`, `:306-373`; `src/lib/7z/CMakeLists.txt` | **confirmed**; line ranges **corrected** |
| 11 | Engine's `7zip` target is pr‑downloader's vendored SDK | `rts/CMakeLists.txt:88`, `rts/System/FileSystem/Archives/CMakeLists.txt:45` | **confirmed** |
| 12 | 7z filename buffer 2048 UTF‑16 units; per‑file size cast to `int`; dirs skipped; `lcNameIndex` lower‑cased | `SevenZipArchive.cpp:72-90`, `:140-142`, `:152`, `:157` | **confirmed** |
| 13 | `considerSolid` heuristic and `parallelAccessNum` | `SevenZipArchive.cpp:166-168`; `SevenZipArchive.h` (`CheckForSolid() override { return considerSolid; }`) | **confirmed** |
| 14 | `HasLowReadingCost()` has no override anywhere ⇒ engine class‑1 rejection dormant | GitHub code search `HasLowReadingCost repo:beyond-all-reason/RecoilEngine` → only `IArchive.h:131` (base) and the call site in `ArchiveScanner.cpp` | **confirmed** (open question resolved) |
| 15 | Class‑1/class‑2 meta files and dirs | `ArchiveScanner.cpp:103-112` (files), `:114-120` (dirs), `CheckCompression` `:571-599` | **confirmed** |
| 16 | minizip: `-DNOCRYPT -DNOUNCRYPT`; bzip2 falls through to `raw=1`; `unzOpen` is 32‑bit; 512‑byte name buffer | `rts/lib/minizip/CMakeLists.txt:21`; `unzip.c:1402-1408`, `:1420-1446`, `:698-700`; `ZipArchive.cpp:44`, `:63` | **corrected** (CMake line 21, not 23; the defines are only added in the `else(MINIZIP_FOUND)` branch) |
| 17 | Checksum = XOR over `sha512(lc(name))` and `sha512(content)`; ignore filter `^\..*$` + `springignore.txt` | `ArchiveScanner.cpp:959-971`, `:1011-1087` | **confirmed**; **added**: XOR is order‑independent, and non‑dot junk (`desktop.ini`) is *not* filtered |
| 18 | `mapinfo.lua` presence makes the archive a map; `Map Helper v1` auto‑dependency; `modType = modtype::map` | `ArchiveScanner.cpp:745-746`, `:753-766`, `:784-796`; `ArchiveScanner.h` `GetMapHelperContentName()`; `cont/base/maphelper/modinfo.lua` | **confirmed** |
| 19 | Behaviour when both `mapinfo.lua` and `modinfo.lua` are present | `ArchiveScanner.cpp:753-766` (`if (hasMapInfo) … else if (hasModInfo)`) | **corrected** — not ambiguous: `mapinfo.lua` wins outright and `modinfo.lua` is never executed (open question resolved) |
| 20 | springname = `name .. " " .. version` unless version already substrings name | `ArchiveScanner.cpp:187-197` | **confirmed**; **caveat added** about `name_pure` aliasing at `:199-200` |
| 21 | `knownTags`, `modtype 3 = map` | `ArchiveScanner.cpp:74-87` (`std::array<KnownInfoTag, 12>`) | **confirmed** |
| 22 | `SearchMapFile()` returns the first `.smf`; `mapfile` warning; `MapNameToMapFile` | `ArchiveScanner.cpp:601-615`, `:756-761`, `:1652-1663` | **confirmed** |
| 23 | `.sdd` is the only type whose lua‑info mtime is re‑checked | `ArchiveScanner.cpp:814-818` | **confirmed** |
| 24 | `MapParser` picks `mapinfo.lua` over the base archive's `maphelper/mapinfo.lua`; injects `Map.fileName/fullName/configFile` | `MapParser.cpp:19`, `:23-33`, `:37`, `:41-43`; `cont/base/maphelper/maphelper/mapinfo.lua:65-89` | **confirmed** |
| 25 | `FIND_MAP_TEXTURE` = "verbatim path if it exists in `SPRING_VFS_ZIP`, else `maps/` + path"; `detailTex` falls back to `bitmaps/` | `MapInfo.cpp:35-44`, `:378-382` | **confirmed**; **corrected**: the doc's `bitmaps/foam.jpg` example resolves against the *game* archive, not Comet Catcher's own `bitmaps/` (which contains `Foam.tga`) |
| 26 | The nine `resources` string keys and their field bindings, incl. `detailNormalTex → blendNormalsTexName` | `MapInfo.cpp:361-371` | **confirmed** |
| 27 | DNTS accepts nested (`splatDetailNormalTex = {…, alpha = true}`) and flat (`splatDetailNormalTex1..4`) spellings; capped at 4 | `MapInfo.cpp:384-400`; `SMFReadMap.cpp:304-306`; `SMFReadMap.h:183` (`NUM_SPLAT_DETAIL_NORMALS = 4`) | **confirmed** |
| 28 | `smf = {…}` overrides; metal/type/grass must match info‑map size exactly | `MapInfo.cpp:404-428`; `SMFReadMap.cpp:924-970` | **confirmed**; **added**: `smtFileName*` is *not* run through `FIND_MAP_TEXTURE`, and `minimapTex` has no size check |
| 29 | `specularTexGen == normalTexGen == 1/(mapx*8)`; all full‑map samplers are stretched 0…1 | `SMFRenderState.cpp:185`, `:191`, `:193`; `SMFReadMap.cpp:388`; `SMFFragProg.glsl:262-265` | **confirmed** |
| 30 | `splatDetailTex` must be non‑empty for the DNTS path | `SMFReadMap.cpp:249-325` on master + commit `510b1aea` "Fix SMF DNTS gating and fallback textures" (2026‑07‑23) | **corrected** — no longer true on master; both `splatDetailTex` and `splatDistrTex` now get fallback dummies. Advice kept for older pinned engines |
| 31 | Shader channel semantics: `splatCofac` R→tex1…A→tex4; `specularCol.a * 16` = exponent; `dtSample.a` = blend; parallax RG/B/A packing; emission `1-a` mix | `SMFFragProg.glsl:174-198`, `:299-307`, `:323`, `:328`, `:341-350`, `:392-401`, `:403-424`, `:123-141` | **confirmed**; all line refs **corrected** |
| 32 | Tangent frame: S‑tangent ≙ world +x, T‑tangent ≙ world +z, normal ≙ up | `SMFFragProg.glsl:272-278` (`mat3(sTangent, tTangent, normal)`) | **confirmed** |
| 33 | No sRGB anywhere in the map texture path | GitHub code search `SRGB repo:beyond-all-reason/RecoilEngine path:rts/Map` → 0 hits; `grep -i srgb Bitmap.cpp` → 0 hits; `Bitmap.cpp:1181-1185` int‑format table | **confirmed** |
| 34 | `grassShadingTex` sampling coordinates | `GrassVertProg.glsl:155` (`shadingTexCoords = worldPos.xzxz * vec4(mapSizePO2, mapSize)`), `GrassDrawer.cpp:329` (`mapSize = 1/(mapx*SQUARE_SIZE), 1/(mapy*SQUARE_SIZE)`), `GrassFragProg.glsl:45` (`.pq`) | **resolved (was an open question)** — stretched over the whole map, not tiled |
| 35 | `splats` defaults `{0.02…}` / `{1.0…}`; `maxMetal 0.02`; `extractorRadius 500`; `gravity 130`; `specularExponent 100` | `MapInfo.cpp:106-107`, `:101`, `:181-182`, `:222`; `mapdefaults.lua:18-22`, `:92-95` | **confirmed**; **corrected**: the grass defaults cited in §10 are `MapInfo.cpp`'s, *not* `mapdefaults.lua`'s (which uses different key names and different numbers) |
| 36 | `atmosphere.skyDir` | `MapInfo.cpp:145-147` — logs `L_DEPRECATED`, "was never used and now deprecated, use atmosphere.skyAxisAngle instead" | **corrected** — removed from the recommended skeleton |
| 37 | Metal map is `mapx/2 × mapy/2`, one byte, `amount = byte × maxMetal` | `ReadMap.cpp:162-167`; `MetalMap.cpp:29-44`, `:76-82` | **confirmed** |
| 38 | `mapconfig/map_metal_layout.lua`: only when the SMF metalmap is blank; 21‑cell plus at `metal × 0.43 × 9/21 × 255` | `luarules/gadgets/map_metal_spot_placer.lua:24-90` (BAR@master) | **confirmed**; **added** `layer = -10` |
| 39 | `api_resource_spot_finder.lua` layer `-9`, hidden, publishes `mex_*` rules params, geo via `geoThermal`, metal‑map allowlist | `common/upgets/api_resource_spot_finder.lua:1-40`, `:94`, `:211-221` | **confirmed** |
| 40 | Engine trees vs BAR override differ only in `damage` (5 → 250) | `cont/base/springcontent/features/treetype.lua` vs `features/enginetrees_override.lua` | **confirmed** |
| 41 | BAR ships nine `features/*.lua` | `gh api …/contents/features` → 8 `.lua` + `invalid_models.lua.test` | **corrected** to eight |
| 42 | `rocks30.lua` generates 150 defs, `metal = 9+i`, `damage = 100+i*50` | `features/rocks30.lua` | **confirmed** |
| 43 | `gamedata/featuredefs.lua` merges `features/*.lua` from the map archive; `VFS_MODES = VFS.MAP..VFS.MOD..VFS.BASE` | `gamedata/featuredefs.lua`, `gamedata/defs.lua:23` | **confirmed** |
| 44 | `map_list.yaml` has 226 maps; required fields; `terrain`/`gameType` enums; startboxes 0…200 ints; `maxPlayersPerStartbox` 1…16 | cloned `maps-metadata@main`: `map_list.yaml`, `schemas/map_list.yaml` | **confirmed** |
| 45 | `cdn_maps.yaml` filename pattern `^[^ ]+\.(sd7\|sdz)$` | `schemas/cdn_maps.yaml` | **confirmed** |
| 46 | `check_archive_not_solid.ts` whitelist empty; `check_uses_mapinfo_lua.ts` whitelist = `{Mescaline_V2}` | both files | **confirmed** |
| 47 | `check_photo_aspect_ratio.ts` tolerance ±0.75 map units at `fit-in/512x512` | that file | **confirmed** |
| 48 | `check_startboxes.ts` rules (one config per team count; `a.x<b.x && a.y<b.y`; `|2A| ≥ 1`; `boxes × maxPlayers ≤ playerCount`) | that file | **confirmed** |
| 49 | `derived_map_info.ts` throws on missing `windMin/windMax/tidalStrength` | `derived_map_info.ts:126-152` | **corrected** — only `tidalStrength` lacks a default; wind defaults to 5/25, `voidWater` to false |
| 50 | Version regex `/[_\s][vV]?(\d+(?:\.\d+)*)$/` and leading‑`v` strip | `derived_map_info.ts:52-72` | **confirmed** |
| 51 | `gen_map_boxes_conf.ts` key is `${springName}.smf:${nBoxes}` | that file | **confirmed** |
| 52 | Startbox modoption = `base64url(zlib(json))` with padding stripped; resolution order override → exact → larger → smaller; `scale = mapSize/200` | `gen_map_modoptions.ts:9-13`; `luarules/gadgets/include/startbox_utilities.lua:112-131`, `:168-169` | **confirmed** |
| 53 | `parse-worker.ts` shells `7za l -x!* <archive>` and parses `Solid = +/-`; `.sdz` ⇒ false; `spring-map-parser ^6.4.2`; cache `cache-v3`; output file list | `cloud/map-parser/src/parse-worker.ts:19-48`, `:93-103`, `:113-160`; `src/shared.ts:4`; `package.json` | **confirmed** |
| 54 | CDN worker: `result.length > 1` ⇒ 400, springname mismatch ⇒ "Non‑deterministic springname requested" | `beyond-all-reason/maps-hosting` `lib/index.ts:43-67`, `fetcher/src/index.ts` | **confirmed** |
| 55 | The `/find` response shape and Comet Catcher's exact record | live query to `files-cdn.beyondallreason.dev/find?category=map&springname=Comet%20Catcher%20Remake%201.8` | **confirmed** byte for byte, incl. `size: 41565457` |
| 56 | CI jobs, MQTT topic, `gen/` target list, `sync_map.yaml` cron `0 5 * * *` | `.github/workflows/ci.yaml`, `.github/workflows/sync_map.yaml`, `Makefile:2`, `:55-62` | **confirmed**; **corrected**: `gen/` is not gitignored, just empty in the repo |
| 57 | BAR guide dimension formulas and the metal/type `16 x` vs `32 x` contradiction | beyondallreason.info/guide/mapping-1-file-structure-prerequisites | **confirmed**, with the exact quotes now inlined; **added**: the guide's DNTS splatmap figure (2048×1024 for 20×10) also disagrees with `128 x` |
| 58 | "Maps larger than 32x32 or 32 in any dimension will not be accepted"; wind 0‑30; tidal 0‑25; "sometimes required to lighten in a bit, use pymapconv" | beyondallreason.info/guide/map-checklist | **confirmed** (all four quoted verbatim) |
| 59 | pymapconv writes the `TreeType0..15`/`GeoVent` table unconditionally | `Beherith/springrts_smf_compiler`, `src/pymapconv.py:734-736`, `:1067-1069` | **resolved (was an open question)** — the list is a module‑level constant and all 17 names are always written; `numFeatureType` is always 17 |
| 60 | pymapconv CLI flags / minimap "lighten" option | `src/pymapconv.py:1356-1447` | **partially resolved** — full flag list read (`-o -t -a -m -x -n -g -k -j -f -r -y -p -l -z -w -q -u -v -c --normalizemetal --specularscale --splatdistributionscale --highresheightmapfilter --numthreads -d -s`); **there is no lighten/brighten flag** |

### Still UNVERIFIED after this pass

1. **The exact 7‑Zip command line BAR map authors use.** `gh search code "org:beyond-all-reason
   \"-ms=off\""` and `"7z a"` both return nothing; neither public guide documents packing. The flag
   set in §0/§1.5 is *inferred* from the measured archive shape (LZMA2, non‑solid, one folder per
   file). Dictionary size, `fb`, `mt`: unknown.
2. **`lightEmissionTex` and `parallaxHeightTex` real‑world authored sizes/encodings.** No pool map
   uses either; everything in §5.4/§5.5 for them comes from the shader alone.
3. **`skyReflectModTex` sizing.** One data point (Boreal Falls). The public guide explicitly defers
   to Beherith ("optional, and rarely used").
4. **`maps/<mapname>/` as a texture subfolder.** Legal under `FIND_MAP_TEXTURE`, observed in zero
   pool maps; a code search of `Spring-SpringBoard/SpringBoard-Core` for an `.sd7` exporter returned
   nothing.
5. **CDN/springfiles filename normalisation.** All 226 stored filenames are lowercase with
   underscores, but no code path was found that performs the transformation; it may simply be
   uploader convention.
6. **Whether `CreateIgnoreFilter`'s `^\..*$` matches full VFS paths or only basenames** (i.e. is
   `maps/.foo` ignored?). Not traced into `IFileFilter`.
7. **`~2 059 files under objects3d/`** in the BAR game archive — not re‑counted.
8. **`name_pure` aliasing** in `ArchiveScanner::ArchiveData::ArchiveData` — read from source, not
   executed.
9. **The `special` field in `map_list.yaml`** is `type: string` with no further constraint and no
   consumer found; the Rowy legend itself says it may carry no semantic meaning. Treat as opaque.
