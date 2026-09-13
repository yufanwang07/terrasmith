# mapinfo.lua Schema for Recoil / BAR

Complete, implementation-grade reference for `mapinfo.lua` as parsed by the **Recoil** engine
(`beyond-all-reason/RecoilEngine`) and as written by real **Beyond All Reason** maps.

Every key, default, clamp and side effect below was read out of engine source at
`master` (fetched 2026-09-13) — not recalled. Inline citations give repo path + line numbers.

**Primary sources**

| What | Path |
| --- | --- |
| Runtime parser (authoritative key list) | `rts/Map/MapInfo.cpp` (543 lines), `rts/Map/MapInfo.h` (267 lines) |
| File discovery + `Map` table + start positions | `rts/Map/MapParser.cpp` (86 lines), `rts/Map/MapParser.h` |
| Archive metadata (name/version/depend/…) | `rts/System/FileSystem/ArchiveScanner.cpp` |
| Lua sandbox, key-lowering, type coercion | `rts/Lua/LuaParser.cpp`, `rts/Lua/LuaUtils.cpp` |
| Texture consumption / shader feature flags | `rts/Map/SMF/SMFReadMap.cpp`, `rts/Map/SMF/SMFRenderState.cpp` |
| Splat math | `cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl` |
| SMF binary header (what `smf.*` overrides) | `rts/Map/SMF/SMFFormat.h`, `rts/Map/SMF/SMFGroundTextures.cpp` |
| Legacy `.smd` → mapinfo bridge | `cont/base/maphelper/maphelper/{mapinfo,parse_tdf_map,mapdefaults}.lua` |
| BAR template | `beyond-all-reason/map_blueprint` → `mapinfo.lua` |
| BAR generated-map template | `beyond-all-reason/Beyond-All-Reason` → `mapgenerator/mapinfo_template.lua` |
| BAR start boxes / map metadata | `beyond-all-reason/maps-metadata` → `schemas/map_list.yaml` |
| BAR static mapinfo parser | `beyond-all-reason/map-parser` → `src/map-parser.ts`, `src/map-model.ts` |

---

## 1. How the engine loads `mapinfo.lua`

### 1.1 File discovery

`MapParser`'s constructor picks the file:

```cpp
// rts/Map/MapParser.cpp:19-20
static const char* mapInfos[] = {"maphelper/mapinfo.lua", "mapinfo.lua"};
static const char* vfsModes   = SPRING_VFS_MAP_BASE;          // "mb"

// rts/Map/MapParser.cpp:37
MapParser::MapParser(const std::string& mapFileName)
  : parser(mapInfos[CFileHandler::FileExists(mapInfos[1], vfsModes)], vfsModes, vfsModes)
```

`FileExists("mapinfo.lua")` returns `bool`, used as an index:

* `true` (index 1) → the map archive's own **`mapinfo.lua`** is executed.
* `false` (index 0) → **`maphelper/mapinfo.lua`** from `maphelper.sdz` runs instead; that script
  loads `Map.configFile` (the `.smd` next to the `.smf`) and, if it looks like TDF
  (first non-space char is `[` or `/`), converts it via `maphelper/parse_tdf_map.lua`
  (`cont/base/maphelper/maphelper/mapinfo.lua:53-89`).

VFS mode is `SPRING_VFS_MAP_BASE` = `"mb"` (`rts/System/FileSystem/VFSModes.h:9-14`) — **map archive +
base content only**. `mapinfo.lua` therefore *cannot* `VFS.Include` anything from the game
(mod) archive. It can only see files inside the map's own archive and inside
`springcontent.sdz` / `maphelper.sdz` / `bitmaps.sdz` / `cursors.sdz`.

### 1.2 Globals injected before execution

```cpp
// rts/Map/MapParser.cpp:40-53
parser.GetTable("Map");
parser.AddString("fileName",   FileSystem::GetFilename(mapFileName));   // "Foo_V1.smf"
parser.AddString("fullName",   mapFileName);                            // "maps/Foo_V1.smf"
parser.AddString("configFile", GetMapConfigName(mapFileName));          // "maps/Foo_V1.smd"
parser.EndTable();

#if !defined UNITSYNC && !defined DEDICATED && !defined BUILDING_AI
parser.GetTable("Spring");
parser.AddFunc("GetMapOptions", LuaSyncedRead::GetMapOptions);
parser.EndTable();
#endif
```

`GetMapConfigName` swaps a `.smf` extension for `.smd`, otherwise returns the path unchanged
(`MapParser.cpp:23-33`).

> **`Spring.GetMapOptions` is absent in unitsync, the dedicated server and AI builds.**
> Every real map guards it: `if (not Spring.GetMapOptions) then Spring.GetMapOptions = function() return {} end end`.

### 1.3 The Lua sandbox

`LuaParser::SetupEnv` (`rts/Lua/LuaParser.cpp:125-196`) gives the chunk:

* Standard Lua libs **minus** `dofile`, `loadfile`, `loadlib`, `require`, `gcinfo`,
  `collectgarbage`, `newproxy` (all set to `nil`).
* `math` + `LuaMathExtra`; `math.random`/`randomseed` are **no-ops** here (unsynced context
  → `DummyRandom`).
* `Spring.Echo`, `Spring.Log`, `Spring.TimeCheck`.
* `VFS.DirList`, `VFS.SubDirs`, `VFS.Include`, `VFS.LoadFile`, `VFS.FileExists` (+ `LuaVFS::PushCommon`
  outside unitsync/dedicated).
* `Engine.*` (`LuaConstEngine`), `Script.IsEngineMinVersion`, `LOG.*`, `Encoding.*`,
  `DontMessWithMyCase`.
* **No** `Game` table (only the defs-parser gets that), no `os`, no `io`.

The chunk **must return a table**. If it does not, the engine substitutes an empty table and
records `"no return table from …"` in the error log but keeps going
(`LuaParser.cpp` `Execute()`, the `#else` branch).

### 1.4 KEYS ARE LOWERCASED — the single most important gotcha

`LuaParser` is constructed with `lowerKeys = true` and `lowerCppKeys = true`
(`rts/Lua/LuaParser.cpp:59-60, 83-84`). After the chunk returns:

```cpp
if (lowerKeys) LuaUtils::LowerKeys(L, 1);     // LuaParser.cpp:283-284
```

`LuaUtils::LowerKeys` recurses over every nested table, deletes each mixed-case **string** key and
re-inserts it lowercased — unless the lowercase key already exists, in which case the mixed-case
one is simply dropped (`rts/Lua/LuaUtils.cpp:367-441`). Integer keys are untouched.

On the C++ side every lookup also lowercases the key
(`LuaParser.cpp:872`, `:1001`: `StringToLower(mixedKey)` when `lowerCppKeys`).

Consequences:

1. `maxHeight`, `maxheight`, `MAXHEIGHT` are all the same key. Real maps mix styles freely
   (`groundambientcolor` in one line, `unitAmbientColor` in the next).
2. If you write **both** `fogColor` and `fogcolor`, the lowercase one wins and the other is silently
   discarded.
3. Game-side Lua that does `VFS.Include("mapinfo.lua")` gets the table **as the map author wrote
   it** (no lowering), which is why every BAR map calls its own `lowerkeys(mapinfo)` helper before
   returning — see §11.1.

### 1.5 Value type coercion

| C++ getter | Accepts | Notes |
| --- | --- | --- |
| `GetString(k, def)` | Lua string, or number (Lua auto-coerces) | non-string → default |
| `GetFloat(k, def)` / `GetInt(k, def)` | number **or numeric string** | `lua_tonumber`; `0` with a non-number/non-string value → default (`LuaParser.cpp:1489-1497`) |
| `GetBool(k, def)` | boolean; number (`!= 0`); string `"1"`,`"true"`,`"0"`,`"false"` (case-insensitive) | anything else → default (`ParseBoolean`, `LuaParser.cpp:1452-1475`) |
| `GetFloat3(k, def)` | `{x,y,z}` array **or** string `"x y z"` (`sscanf "%f %f %f"`) | needs exactly 3 parsed (`LuaParser.cpp:1415-1430`) |
| `GetFloat4(k, def)` | `{x,y,z,w}` array **or** string `"x y z w"` | needs exactly 4 (`LuaParser.cpp:1433-1449`) |
| `KeyExists(k)` | — | used for "was this explicitly set?" semantics |
| `SubTable(k)` | — | a missing/invalid subtable makes every `Get*` on it return its default |

NaN/Inf in any numeric field is logged as a warning by `LuaUtils::CheckTableForNaNs` but not
rejected.

### 1.6 Two independent consumers

`mapinfo.lua` is executed **twice, by two different code paths, with different rules**:

| | `CArchiveScanner` (metadata) | `CMapInfo` (runtime) |
| --- | --- | --- |
| When | Archive scan / lobby listing | Map load |
| Code | `ArchiveScanner.cpp:923` `ScanArchiveLua` | `MapInfo.cpp:48` `CMapInfo::CMapInfo` |
| Lua env | `LuaParser p(<file bytes>, SPRING_VFS_ZIP)` — **no `Map` table, no `Spring.GetMapOptions`** | Full `MapParser` env (§1.2) |
| Reads | top-level scalars + `depend` / `replace` only | everything else |

`ScanArchiveLua` deliberately skips `LuaConstGame::PushEntries` "since that would invoke
ScanArchive again" (`ArchiveScanner.cpp:936-937`).

An archive is classified as a **map** iff it contains `mapinfo.lua` *or* a `.smf` file is found by
`SearchMapFile` (`ArchiveScanner.cpp:746, 784`). When it is a map the scanner force-sets
`modType = modtype::map` and appends the maphelper archive as a dependency
(`ArchiveScanner.cpp:795-796`).

---

## 2. Top-level: archive metadata

Read by `CArchiveScanner::ArchiveData` (`ArchiveScanner.cpp:70-142`). Any **string / number /
boolean** top-level key is stored verbatim as an "info item"; tables other than `depend`/`replace`
are ignored. The engine documents 12 "known" tags:

```cpp
// rts/System/FileSystem/ArchiveScanner.cpp:74-87
const std::array<KnownInfoTag, 12> knownTags = {
  {"name",        "example: Original Total Annihilation",                           true },
  {"shortname",   "example: OTA",                                                   false},
  {"version",     "example: v2.3",                                                  false},
  {"mutator",     "example: deployment",                                            false},
  {"game",        "example: Total Annihilation",                                    false},
  {"shortgame",   "example: TA",                                                    false},
  {"description", "example: Little units blowing up other little units",            false},
  {"mapfile",     "in case its a map, store location of smf file",                  false},
  {"modtype",     "0=hidden, 1=primary, (2=unused), 3=map, 4=base, 5=menu",         true },
  {"depend",      "a table with all archives that needs to be loaded for this one", false},
  {"replace",     "a table with archives that got replaced with this one",          false},
  {"onlyLocal",   "if true spring will not listen for incoming connections",        false}
};
```

| Key | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | (basename of the `.smf`) | Human/script name. Used as the map identifier everywhere (`Game.mapName`, lobby, `script.txt` `MapName`). |
| `shortname` | string | no | — | Short label. Cosmetic; BAR maps set it but nothing in the engine consumes it for maps. |
| `version` | string | no | `""` | **Appended to `name`** at scan time if not already contained: `SetInfoItemValueString("name", name + " " + version)` (`ArchiveScanner.cpp:187-193`). This is why BAR map names read `"Quicksilver Remake 1.24"`. If `version` is already a substring of `name` a warning is logged instead. |
| `description` | string | no | `map.name` | Also read at runtime into `mapInfo->map.description` and exposed as `Game.mapDescription`. |
| `author` | string | no | `""` | Runtime `mapInfo->map.author`; BAR's `gui_mapinfo` widget prints it. |
| `mapfile` | string | no | (auto-discovered) | Path of the `.smf` inside the archive, e.g. `"maps/Foo_V1.smf"`. If omitted the scanner calls `SearchMapFile()` and logs `"set the 'mapfile' key in mapinfo.lua … for faster loading!"` (`ArchiveScanner.cpp:756-761`). **Always set it.** |
| `modtype` | integer | **yes** | — | `0` hidden, `1` primary (game), `3` map, `4` base, `5` menu. Special-cased: always stored as an integer (`ArchiveScanner.cpp:144-147`). For a map archive the scanner overrides it to `3` anyway, so the value in the file is advisory. `MapOrbitalStation` ships `modtype = 4` and still loads as a map. |
| `depend` | array of string | no | `{}` | Archive names to load alongside. Read with `for (int dep = 1; _dependencies.KeyExists(dep); ++dep)` — **1-based and must be contiguous** (`ArchiveScanner.cpp:169-171`). The maphelper archive is appended automatically for maps. Typical BAR value: `{"Map Helper v1"}` or `{}`. |
| `replace` | array of string | no | `{}` | Archives this one supersedes; same 1-based contiguous rule (`:172-174`). |
| `mutator`, `game`, `shortgame`, `onlyLocal` | string / bool | no | — | Game-archive tags; harmless but meaningless on a map. |

`depend` and `replace` are "reserved keys" and are *not* also stored as info items
(`ArchiveScanner.cpp:216-218`).

If `name` ends up empty the scanner sets both `name` and `name_pure` to the `.smf` basename
(`ArchiveScanner.cpp:786-790`).

Deprecated / ignored: `startpic`, `StartMusic` (commented out in every template).

---

## 3. Top-level: map simulation settings

`CMapInfo::ReadGlobal()` — `rts/Map/MapInfo.cpp:90-117`, and `ReadGui()` at `:120-125`.

```cpp
map.description  = topTable.GetString("description", map.name);
map.author       = topTable.GetString("author", "");
map.hardness     = topTable.GetFloat("maphardness", 100.0f);
map.notDeformable= topTable.GetBool("notDeformable", false);
map.gravity      = modInfo.forcedMapGravityStrength.value_or(topTable.GetFloat("gravity", 130.0f));
map.gravity      = std::max(0.001f, map.gravity);
map.gravity      = -map.gravity / (GAME_SPEED * GAME_SPEED);
map.tidalStrength   = topTable.GetFloat("tidalStrength", 0.0f);
map.maxMetal        = topTable.GetFloat("maxMetal", 0.02f);
map.extractorRadius = topTable.GetFloat("extractorRadius", 500.0f);
map.voidAlphaMin    = topTable.GetFloat("voidAlphaMin", 0.9f);
map.voidWater       = topTable.GetBool("voidWater", false);
map.voidGround      = topTable.GetBool("voidGround", false);
map.hardness        = std::max(0.001f, std::abs(map.hardness)) * std::copysign(1.0f, map.hardness);
map.tidalStrength   = std::max(0.000f, map.tidalStrength);
map.maxMetal        = std::max(0.000f, map.maxMetal);
map.extractorRadius = std::max(0.000f, map.extractorRadius);
gui.autoShowMetal   = mapInfoParser.GetRoot().GetBool("autoShowMetal", true);
```

| Key | Type | Default | Clamp / transform | Meaning & consumer |
| --- | --- | --- | --- | --- |
| `maphardness` | float | `100.0` | `sign(h) * max(0.001, abs(h))` — may be **negative** but never 0 | Crater resistance. `CBasicMapDamage::Init()` sets `mapHardness = mapInfo->map.hardness`; per-square hardness is `mapHardness * max(0.001, terrainTypes[tt].hardness)` (`rts/Map/BasicMapDamage.cpp:24, 67`). A negative value inverts craters (explosions raise terrain). Exposed as `Game.mapHardness`. BAR maps use 70–200. |
| `notDeformable` | bool | `false` | — | Disables `CBasicMapDamage` entirely (`rts/Map/MapDamage.cpp`); `Game.mapDamage` reports `!mapDamage->Disabled()`. |
| `gravity` | float | `130.0` | `max(0.001, g)`, then negated and divided by `GAME_SPEED²` = **900** | mapinfo units are **positive elmos/second²**; `mapInfo->map.gravity` is **negative elmos/frame²**. `130 → -0.14444` elmos/frame². `modInfo.forcedMapGravityStrength` (a game-side modinfo override) takes precedence over the map value. `Game.gravity` re-multiplies by 900 to give back the mapinfo value. |
| `tidalStrength` | float | `0.0` | `max(0, t)` | Tidal generator output. `envResHandler.LoadTidal(mapInfo->map.tidalStrength)` (`rts/Game/Game.cpp:725`). Exposed as `Game.tidal`; mutable at runtime via `Spring.SetTidal`. |
| `maxMetal` | float | `0.02` | `max(0, m)` | Metal yield that metalmap value **255** represents. `metalMap.Init(ptr, w, h, mapInfo->map.maxMetal)` (`rts/Map/ReadMap.cpp:167`). BAR maps use ~0.5–1.4 for normal maps and 100 for metal maps. |
| `extractorRadius` | float | `500.0` | `max(0, r)` | Radius (elmos) over which a mex sums metalmap cells. `Game.extractorRadius`. BAR: 90–150 typical; 2.0 on `Orbital_Station`. |
| `voidWater` | bool | `false` | — | No water rendered; below-zero terrain is the void. Copied to `mapRendering->voidWater` → shader flag `SMF_VOID_WATER` (`rts/Map/SMF/SMFRenderState.cpp:116`). BAR gadgets read `mapinfo.voidwater` to kill units that wander into the void (`luarules/gadgets/map_voidground.lua:25`), to disable lava (`modules/lava.lua:11`), to gate water-speed multipliers, area-timed-damage, decals, context build, and target placement. |
| `voidGround` | bool | `false` | — | Same idea for ground; shader flag `SMF_VOID_GROUND`. |
| `voidAlphaMin` | float | `0.9` | — | `glAlphaFunc(GL_GREATER, mapInfo->map.voidAlphaMin)` when drawing void passes (`rts/Map/SMF/SMFGroundDrawer.cpp:242, 291`). Undocumented in every template. |
| `autoShowMetal` | bool | `true` | — | `gui.autoShowMetal`; makes `CGuiHandler` flip to the metal info-map when a mex is selected. |

Runtime overrides: `Spring.SetMapRenderingParams{voidWater=…, voidGround=…}`
(`rts/Lua/LuaUnsyncedCtrl.cpp:4334-4337`), `Spring.SetTerrainTypeData` for hardness
(`rts/Lua/LuaSyncedCtrl.cpp:7155-7180`).

---

## 4. `smf` sub-table — SMF compile-time overrides

`CMapInfo::ReadSMF()` second half — `rts/Map/MapInfo.cpp:403-428`.

```cpp
const LuaTable& smfTable = mapInfoParser.GetRoot().SubTable("smf");

smf.minHeightOverride = smfTable.KeyExists("minHeight");
smf.maxHeightOverride = smfTable.KeyExists("maxHeight");
smf.minHeight         = smfTable.GetFloat("minHeight", 0.0f);
smf.maxHeight         = smfTable.GetFloat("maxHeight", 0.0f);

smf.minimapTexName  = smfTable.GetString("minimapTex",  "");
smf.metalmapTexName = smfTable.GetString("metalmapTex", "");
smf.typemapTexName  = smfTable.GetString("typemapTex",  "");
smf.grassmapTexName = smfTable.GetString("grassmapTex", "");
FIND_MAP_TEXTURE(&smf.minimapTexName);  /* … ×4 … */

for (int i = 0; /* no test */; i++) {
    const std::string key = IntToString(i, "smtFileName%i");
    if (!smfTable.KeyExists(key)) break;
    smf.smtFileNames.push_back(smfTable.GetString(key, ".smt"));
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `minHeight` | float | *(SMF header value)* | Overrides `SMFHeader.minHeight`. **Presence** is what matters — `KeyExists` sets `minHeightOverride`, so `minHeight = 0` is a real override, not a no-op. |
| `maxHeight` | float | *(SMF header value)* | Overrides `SMFHeader.maxHeight`. |
| `smtFileName0`, `smtFileName1`, … `smtFileNameN` | string | — | Replace the `.smt` filenames baked into the `.smf`'s `MapTileHeader`. Scanned from **index 0 upward, stopping at the first missing index**. |
| `minimapTex` | string | `""` | Replaces the DXT1 minimap block inside the `.smf`. Loaded as a normal `CBitmap` (`SMFReadMap.cpp:166`). |
| `metalmapTex` | string | `""` | Replaces the metal info-map. |
| `typemapTex` | string | `""` | Replaces the type info-map (terrain-type indices). |
| `grassmapTex` | string | `""` | Replaces the `MEH_Vegetation` grass info-map. |

**Height override semantics.** `CSMFReadMap` decodes the raw `uint16` heightmap as

```cpp
// rts/Map/SMF/SMFReadMap.cpp:146-147, 161
const float minHgt = mapInfo->smf.minHeightOverride ? mapInfo->smf.minHeight : header.minHeight;
const float maxHgt = mapInfo->smf.maxHeightOverride ? mapInfo->smf.maxHeight : header.maxHeight;
mapFile.ReadHeightmap(syncedData, unsyncedData, minHgt, (maxHgt - minHgt) / 65536.0f);
```

so `height(x,z) = minHgt + raw16(x,z) * (maxHgt - minHgt) / 65536`. Changing the pair both
**shifts** the terrain relative to sea level (y = 0) and **rescales** its vertical extent. This is
exactly how BAR's water-level map option works — `map_blueprint/mapconfig/mapinfo/0_apply_options.lua`
rewrites `mapinfo.smf.minheight/maxheight` to `(-505, 495)`, `(-300, 700)`, `(-610, 390)`,
`(-750, 250)` or `(-900, 100)` depending on `mapOptions.waterlevel`.

**Info-map override rules.** `CSMFReadMap::GetInfoMap` (`SMFReadMap.cpp:923-970`) loads the override
with `LoadGrayscale` and **requires exact dimensions** `hmapx × hmapy` = `(mapx/2) × (mapy/2)`:

```
if (infomapBM.xsize == bmInfo->width && infomapBM.ysize == bmInfo->height) -> use it
else LOG_L(L_WARNING, "invalid dimensions for override-texture …")         -> fall back to the .smf
```

`typemapTex` **must** be 8-bit grayscale: the byte value is the terrain-type index 0..255.

**`smtFileName%i` gotcha.** The override is honoured only if the count matches exactly:

```cpp
// rts/Map/SMF/SMFGroundTextures.cpp:126-149
if (!smf.smtFileNames.empty())
    if (!(smtHeaderOverride = (smf.smtFileNames.size() == tileHeader.numTileFiles)))
        LOG_L(L_WARNING, "smtFileNames.size()=%zu != tileHeader.numTileFiles=%d", …);
…
std::string smtFilePath = (!smtHeaderOverride) ? (smfDir + smtFileName) : (smfDir + smf.smtFileNames[a]);
CFileHandler tileFile(smtFilePath);
if (!tileFile.FileExists())                                  // try absolute path
    tileFile.Open(smtFilePath = (!smtHeaderOverride) ? smtFileName : smf.smtFileNames[a]);
```

`smfDir` is the directory of the `.smf` (normally `maps/`). So the canonical value is the **bare
filename** (`smtFileName0 = "Foo_V1.smt"`). `map_blueprint` writes `"maps/MAP_BLUEPRINT_V1.smt"`,
which fails the first `maps/maps/…` probe and is rescued by the absolute-path fallback — it works,
but it is not the intended form.

> `smf` is **only** these fields. `detailTex`, `specularTex`, `splatDistrTex`, … do **not** live
> here (see §5).

---

## 5. `resources` sub-table — all map override textures

`CMapInfo::ReadSMF()` first half — `rts/Map/MapInfo.cpp:354-400`.

```cpp
const LuaTable& mapResTable = mapInfoParser.GetRoot().SubTable("resources");
const LuaTable& sdnTexTable = mapResTable.SubTable("splatDetailNormalTex");

const std::array<std::pair<std::string*, std::string>, 9> texNames = {{
    {&smf.detailTexName,         "detailTex"},
    {&smf.specularTexName,       "specularTex"},
    {&smf.splatDetailTexName,    "splatDetailTex"},
    {&smf.splatDistrTexName,     "splatDistrTex"},
    {&smf.grassShadingTexName,   "grassShadingTex"},
    {&smf.skyReflectModTexName,  "skyReflectModTex"},
    {&smf.blendNormalsTexName,   "detailNormalTex"},
    {&smf.lightEmissionTexName,  "lightEmissionTex"},
    {&smf.parallaxHeightTexName, "parallaxHeightTex"},
}};

for (auto& pair: texNames) {
    *pair.first = mapResTable.GetString(pair.second, "");
    FIND_MAP_TEXTURE(pair.first);
}

if (smf.detailTexName.empty()) {
    const LuaTable& resGfxMaps = resTableRoot->SubTable("graphics").SubTable("maps");
    smf.detailTexName = resGfxMaps.GetString("detailtex", "detailtex2.bmp");
    FIND_MAP_TEXTURE(&smf.detailTexName, "bitmaps/");
}

if (sdnTexTable.IsValid()) {                       // nested array form
    smf.splatDetailNormalDiffuseAlpha = sdnTexTable.GetBool("alpha", false);
    for (int i = 0; true; i++)
        if (!ParseSplatDetailNormalTexture(sdnTexTable, i + 1, smf.splatDetailNormalTexNames)) break;
} else {                                           // flat numbered form
    smf.splatDetailNormalDiffuseAlpha = mapResTable.GetBool("splatDetailNormalDiffuseAlpha", false);
    for (int i = 0; true; i++)
        if (!ParseSplatDetailNormalTexture(mapResTable, "splatDetailNormalTex" + IntToString(i + 1),
                                           smf.splatDetailNormalTexNames)) break;
}
```

### 5.1 Path resolution — `FIND_MAP_TEXTURE`

```cpp
// rts/Map/MapInfo.cpp:35-44
static void FIND_MAP_TEXTURE(std::string* filePath, const std::string& defaultDir = "maps/") {
    if (filePath->empty()) return;
    if (CFileHandler::FileExists(*filePath, SPRING_VFS_ZIP)) return;   // "Mmeb": mod+map+menu+base
    *filePath = defaultDir + *filePath;
}
```

So `detailTex = "myrock.dds"` resolves to `maps/myrock.dds` unless a file literally named
`myrock.dds` exists at an archive root. **RawFS is deliberately excluded** ("cause it's also used
for synced textures (typemap, metalmap, …)"). Engine-fallback textures use `defaultDir = "bitmaps/"`.

### 5.2 Complete key table

| mapinfo key | C++ field | Default | Purpose / enabling effect |
| --- | --- | --- | --- |
| `detailTex` | `smf.detailTexName` | falls back to `resources.lua → graphics.maps.detailtex`, then `"detailtex2.bmp"` under `bitmaps/` | Tiled RGB detail texture. Sampled at `worldPos.xz * SMF_DETAILTEX_RES` (**0.02**, `SMFFragProg.glsl:25`). Unused when detail-normal splatting is active. Fallback if `Load` fails: 1×1 `{127,127,127,0}`. |
| `specularTex` | `smf.specularTexName` | `""` | Map-sized RGB(A) specular/gloss map. **Presence flips `haveSpecularTexture` and the `SMF_SPECULAR_LIGHTING` shader flag** — i.e. this one texture is the master switch for the whole SSMF ("Spring Splatted Map Format") advanced shading path. Sampled with `specularTexGen = 1/(mapx*8), 1/(mapy*8)`. Fallback on load failure: 1×1 white. |
| `splatDetailTex` | `smf.splatDetailTexName` | `""` | 4-channel *intensity* detail texture for classic splatting. Enables splatting together with `splatDistrTex`: `haveSplatDetailDistribTexture = (!splatDetailTexName.empty() && !splatDistrTexName.empty())` (`SMFReadMap.cpp:69`). Fallback: 1×1 `{127,127,127,127}`. In BAR maps that use DNTS this is set to a **deliberately nonexistent filename** (`"iwantDNTS.tga"`) purely to satisfy the non-empty check. |
| `splatDistrTex` | `smf.splatDistrTexName` | `""` | Map-sized **RGBA distribution/weight map**: each channel is the blend weight of one of the four splat textures. Fallback: 1×1 `{255,0,0,0}` (all-red = channel 1 everywhere). |
| `grassShadingTex` | `smf.grassShadingTexName` | `""` → **defaults to the minimap texture** | Colourises engine grass. `CreateGrassTex` seeds `grassShadingTex` from `minimapTex` (1024×1024) and only overrides it if this loads (`SMFReadMap.cpp:334-346`). |
| `skyReflectModTex` | `smf.skyReflectModTexName` | `""` | Per-texel modulation of cube-map sky reflection. Must match `specularTex` dimensions. Sets `SMF_SKY_REFLECTIONS`. No 1×1 fallback — absent means feature off. |
| `detailNormalTex` | `smf.blendNormalsTexName` | `""` | **Note the name mismatch**: mapinfo key `detailNormalTex` → C++ `blendNormalsTexName`. A map-sized tangent-space normal map blended into the geometric normals. Sets `SMF_BLEND_NORMALS`. |
| `lightEmissionTex` | `smf.lightEmissionTexName` | `""` | Emissive RGB added after lighting. Sets `SMF_LIGHT_EMISSION`. |
| `parallaxHeightTex` | `smf.parallaxHeightTexName` | `""` | Height field for parallax-occlusion offset; **must be the same size as `specularTex`** (`SMFFragProg.glsl:285`). Sets `SMF_PARALLAX_MAPPING`. |
| `grassBladeTex` | `grass.bladeTexName` | `""` (internally generated) | Read in `ReadGrass()` from the **`resources`** table, not the `grass` table (`MapInfo.cpp:198`). |
| `splatDetailNormalTex1..4` | `smf.splatDetailNormalTexNames[0..3]` | — | Flat numbered form. Scanned from **1 upward**, stops at first missing index (`ParseSplatDetailNormalTexture`, `MapInfo.cpp:340-351`). |
| `splatDetailNormalDiffuseAlpha` | `smf.splatDetailNormalDiffuseAlpha` | `false` | When true the alpha channel of each DNTS texture is treated as an old-style greyscale diffuse detail value. Accepts `0`/`1` (real maps write `= 1`). |
| `splatDetailNormalTex = { [1]=…, [2]=…, [3]=…, [4]=…, alpha = bool }` | same | — | **Nested form.** If `resources.splatDetailNormalTex` is a valid table it wins: entries are read at integer keys `1,2,…` and `alpha` supplies `splatDetailNormalDiffuseAlpha` (the flat `splatDetailNormalDiffuseAlpha` key is then ignored). This is the form documented in `maphelper/mapdefaults.lua:108-114`; BAR maps in practice use the flat form. |

Only the **first four** DNTS entries are ever turned into textures
(`NUM_SPLAT_DETAIL_NORMALS = 4`, `rts/Map/SMF/SMFReadMap.h:183`; loop breaks at
`i == NUM_SPLAT_DETAIL_NORMALS`, `SMFReadMap.cpp:305`). A DNTS entry that fails to load becomes a
1×1 `{127,127,255,127}` (flat +Z normal, mid-grey diffuse alpha) rather than disabling the feature
(`SMFReadMap.cpp:310-317`).

### 5.3 `resources` vs a "flat smf form" — which does Recoil prefer?

**There is no flat form in `mapinfo.lua`.** Recoil reads every override texture *only* from the
nested `resources` table; `mapinfo.smf` holds nothing but heights, info-map overrides and
`smtFileName%i` (§4). Upstream Spring's `rts/Map/MapInfo.cpp` is byte-identical here, so this is not
a Recoil divergence.

The "flat form" people remember is the **legacy `.smd` TDF**, where the keys sit directly in
`[MAP]`. `maphelper/parse_tdf_map.lua:199-211` is the bridge that builds the nested table for the
engine:

```lua
map.resources = {
   detailTex            = map.detailtex,
   specularTex          = map.speculartex,
   splatDetailTex       = map.splatdetailtex,
   splatDistrTex        = map.splatdistrtex,
   grassBladeTex        = map.grassbladetex,
   grassShadingTex      = map.grassshadingtex,
   skyReflectModTex     = map.skyreflectmodtex,
   detailNormalTex      = map.detailnormaltex,
   lightEmissionTex     = map.lightemissiontex,
   parallaxHeightTex    = map.parallaxheighttex,
   splatDetailNormalTex = map.splatdetailnormaltex, -- table
}
```

The same file also rewrites `[MAP]\TerrainTypeN` → `terraintypes[N]`, `TeamN.StartPosX/Z` →
`teams[N].startpos.{x,z}`, `[MAP]\LIGHT` `*SunColor` → `lighting.*diffusecolor`,
`[SPLATS]\SplatTexScales` → `splats.texScales`, `[GRASS]\GrassBlade*` → `grass.blade*`, and strips
the `water` prefix from `[WATER]` keys (`parse_tdf_map.lua:31-161`).

### 5.4 Which shader features each texture unlocks

`CSMFRenderState::Init` (`rts/Map/SMF/SMFRenderState.cpp:116-127`):

```cpp
SetFlag("SMF_VOID_WATER",                      mapRendering->voidWater);
SetFlag("SMF_VOID_GROUND",                     mapRendering->voidGround);
SetFlag("SMF_SPECULAR_LIGHTING",               smfMap->GetSpecularTexture() != 0);
SetFlag("SMF_DETAIL_TEXTURE_SPLATTING",       (smfMap->GetSplatDistrTexture() != 0 && smfMap->GetSplatDetailTexture() != 0));
SetFlag("SMF_DETAIL_NORMAL_TEXTURE_SPLATTING",(smfMap->GetSplatDistrTexture() != 0 && smfMap->HaveSplatNormalTexture()));
SetFlag("SMF_DETAIL_NORMAL_DIFFUSE_ALPHA",     mapRendering->splatDetailNormalDiffuseAlpha);
SetFlag("SMF_WATER_ABSORPTION",                smfMap->HasVisibleWater());
SetFlag("SMF_SKY_REFLECTIONS",                 smfMap->GetSkyReflectModTexture() != 0);
SetFlag("SMF_BLEND_NORMALS",                   smfMap->GetBlendNormalsTexture() != 0);
SetFlag("SMF_LIGHT_EMISSION",                  smfMap->GetLightEmissionTexture() != 0);
SetFlag("SMF_PARALLAX_MAPPING",                smfMap->GetParallaxHeightTexture() != 0);
```

Texture units (same file, `:150-170`): `diffuseTex 0`, `heightMapTex 1`, `detailTex 2`,
`shadingTex 3` (basic shader only), `shadowTex 4`, `normalsTex 5`, `specularTex 6`,
`splatDetailTex 7`, `splatDistrTex 8`, `skyReflectTex 9`, `skyReflectModTex 10`,
`blendNormalsTex 11`, `lightEmissionTex 12`, `parallaxHeightTex 13`, `infoTex 14`,
`splatDetailNormalTex1..4 = 15,16,17,18`, `shadowColorTex 19`.

Practical recipe for a modern BAR-style map: ship `specularTex` (turns on SSMF),
`splatDistrTex`, a dummy `splatDetailTex`, and `splatDetailNormalTex1..4` +
`splatDetailNormalDiffuseAlpha = 1`.

---

## 6. `splats` sub-table + how the RGBA channels map

`CMapInfo::ReadSplats()` — `rts/Map/MapInfo.cpp:176-183`:

```cpp
splats.texScales = splatsTable.GetFloat4("texScales", float4(0.02f, 0.02f, 0.02f, 0.02f));
splats.texMults  = splatsTable.GetFloat4("texMults",  float4(1.0f, 1.0f, 1.0f, 1.0f));
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `texScales` | float4 | `{0.02, 0.02, 0.02, 0.02}` | World-space UV frequency per channel. `0.02` equals `SMF_DETAILTEX_RES`, i.e. one texture repeat every `1/0.02 = 50` elmos. Smaller = bigger tiles. |
| `texMults` | float4 | `{1, 1, 1, 1}` | Per-channel intensity multiplier applied to the distribution weights. |

Both are copied into the runtime-mutable `CMapRendering`
(`rts/Rendering/Env/MapRendering.cpp:24-28`) and uploaded as `splatTexScales` / `splatTexMults`
(`SMFRenderState.cpp:182-183`). `Spring.SetMapRenderingParams{splatTexScales=…, splatTexMults=…}`
changes them at runtime (`LuaUnsyncedCtrl.cpp:4316-4319`).

### 6.1 The channel mapping, straight from the shader

```glsl
// cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl:174-197
vec4 GetSplatDetailTextureNormal(vec2 uv, out vec2 splatDetailStrength) {
    vec4 splatTexCoord0 = vertexWorldPos.xzxz * splatTexScales.rrgg;
    vec4 splatTexCoord1 = vertexWorldPos.xzxz * splatTexScales.bbaa;
    vec4 splatCofac = texture2D(splatDistrTex, uv) * splatTexMults;

    splatDetailStrength.x = min(1.0, dot(splatCofac, vec4(1.0)));

    vec4 splatDetailNormal;
      splatDetailNormal  = ((texture2D(splatDetailNormalTex1, splatTexCoord0.st) * 2.0 - 1.0) * splatCofac.r);
      splatDetailNormal += ((texture2D(splatDetailNormalTex2, splatTexCoord0.pq) * 2.0 - 1.0) * splatCofac.g);
      splatDetailNormal += ((texture2D(splatDetailNormalTex3, splatTexCoord1.st) * 2.0 - 1.0) * splatCofac.b);
      splatDetailNormal += ((texture2D(splatDetailNormalTex4, splatTexCoord1.pq) * 2.0 - 1.0) * splatCofac.a);

    splatDetailNormal.y = max(splatDetailNormal.y, 0.01);   // never point down
    #ifdef SMF_DETAIL_NORMAL_DIFFUSE_ALPHA
      splatDetailStrength.y = clamp(splatDetailNormal.a, -1.0, 1.0);
    #endif
    return splatDetailNormal;
}
```

| `splatDistrTex` channel | weight | texture | UV scale | classic-splat source |
| --- | --- | --- | --- | --- |
| **R** | `distr.r * texMults[1]` | `splatDetailNormalTex1` | `texScales[1]` | `splatDetailTex`**.r** |
| **G** | `distr.g * texMults[2]` | `splatDetailNormalTex2` | `texScales[2]` | `splatDetailTex`**.g** |
| **B** | `distr.b * texMults[3]` | `splatDetailNormalTex3` | `texScales[3]` | `splatDetailTex`**.b** |
| **A** | `distr.a * texMults[4]` | `splatDetailNormalTex4` | `texScales[4]` | `splatDetailTex`**.a** |

(Lua arrays are 1-based; the shader's `.r/.g/.b/.a` swizzle of `splatTexScales` corresponds to
`texScales[1..4]`.)

Classic (non-DNTS) splatting uses the same weights but samples one channel of a single
intensity texture per splat and reduces to a scalar (`SMFFragProg.glsl:160-170`):

```glsl
splatDetails.r = texture2D(splatDetailTex, splatTexCoord0.st).r;   // etc for g,b,a
splatDetails   = (splatDetails * 2.0) - 1.0;
vec4 splatCofac = texture2D(splatDistrTex, uv) * splatTexMults;
vec4 detailCol  = vec4(dot(splatDetails, splatCofac));
```

The final normal blend is `normal = normalize(mix(normal, normalize(stnMatrix * splatDetailNormal.xyz), splatDetailStrength.x))`
(`SMFFragProg.glsl:328`), so `sum(distr * texMults)` clamped to 1 is how strongly the DNTS normals
replace the terrain normal — **your `texMults` are the master "how much detail" dial**, and total
weights well above 1 just saturate.

### 6.2 Worked splat example

`map_blueprint` ships:

```lua
splats = {
  texScales = {0.010, 0.005, 0.0075, 0.01},
  texMults  = {1.2,   0.4,   0.9,    0.25},   -- cliff, pebbles, longgrass, sand
}
```

At world position `(x, z) = (4096, 2048)`:

* channel 1 (`Rock_Brown_1k_dnts.dds`) UV = `(4096, 2048) * 0.010 = (40.96, 20.48)` → 40.96 tile
  repeats across 4096 elmos, i.e. one tile per **100 elmos**.
* channel 2 (`LargeScaleRockyDirt`) UV = `(20.48, 10.24)` → one tile per **200 elmos**.
* channel 3 (`GrassThickGreen`) → one tile per **133.3 elmos**.
* channel 4 (`earth_NORM`) → one tile per **100 elmos**.

If `splatDistrTex` at that texel is `(0.6, 0.2, 0.9, 0.1)` then
`splatCofac = (0.6*1.2, 0.2*0.4, 0.9*0.9, 0.1*0.25) = (0.72, 0.08, 0.81, 0.025)` and
`splatDetailStrength.x = min(1, 0.72+0.08+0.81+0.025) = min(1, 1.635) = 1.0` — fully detail-normal
driven, weighted 0.72 rock / 0.08 dirt / 0.81 grass / 0.025 earth (the shader does **not**
renormalise, so relative magnitude is what matters).

`splatDistrTex` is sampled at `specTexCoords = worldPos.xz * specularTexGen` where
`specularTexGen = (1/(mapx*8), 1/(mapy*8))` — i.e. **one distribution texel spans the whole map,
independent of the texture's own resolution**; it is a map-sized mask, not a tiled texture.

---

## 7. `atmosphere` sub-table

`CMapInfo::ReadAtmosphere()` — `rts/Map/MapInfo.cpp:128-173`.

| Key | Type | Default | Clamp | Meaning |
| --- | --- | --- | --- | --- |
| `minWind` | float | `5.0` | `max(0, ·)` then `min(maxWind, ·)` | Wind floor. `envResHandler.LoadWind(min, max)` (`rts/Game/Game.cpp:726`); `Game.windMin`. |
| `maxWind` | float | `25.0` | `max(0, ·)` | Wind ceiling; `Game.windMax`. |
| `fogStart` | float | `0.1` | — | **Fraction of the camera far-plane** where linear fog starts: `glFogf(GL_FOG_START, camera->GetFarPlaneDist() * fogStart)` (`rts/Rendering/Env/ISky.cpp:60`). |
| `fogEnd` | float | `1.0` | — | Same, for fog end (`ISky.cpp:61`). Setting `fogStart`/`fogEnd` ≥ ~1.99/2.0 effectively disables fog — BAR's map generator does exactly that. |
| `fogColor` | float3 → `float4` | `{0.7, 0.7, 0.8}` | — | Stored in a `float4`; `.w` is left at `0.0` because it is read with `GetFloat3`. |
| `skyColor` | float3 | `{0.1, 0.15, 0.7}` | — | Procedural sky tint (ignored when a `skyBox` is set). |
| `skyDir` | float3 | — | — | **DEPRECATED.** `if (atmoTable.KeyExists("skyDir")) LOG_L(L_DEPRECATED, "atmosphere.skyDir in mapinfo.lua was never used and now deprecated, use atmosphere.skyAxisAngle instead")` (`MapInfo.cpp:145-147`). Every real BAR map still ships it; it does nothing but log. |
| `skyAxisAngle` | float4 | `{FwdVector, 0.0}` = `{0,0,1,0}` | axis renormalised (falls back to `FwdVector` if the axis length < `float3::nrm_eps()`); angle `ClampRad(w)` | Replacement for `skyDir`: `.xyz` rotation axis, `.w` angle in radians, applied to the sky/skybox orientation (`MapInfo.cpp:149-161`). |
| `sunColor` | float3 | `{1, 1, 1}` | — | Sun disc / sky sun tint. |
| `cloudColor` | float3 | `{1, 1, 1}` | — | Procedural cloud tint. |
| `cloudDensity` | float | `0.5` | `max(0, ·)` | Procedural cloud density. |
| `fluidDensity` | float | `1.2 * 0.25` = **0.3** | — | Air density in kg/m³ (quarter-scaled). Feeds aerodynamic drag: `GetDragAccelerationVec(mapInfo->atmosphere.fluidDensity, mapInfo->water.fluidDensity, 1.0f, 0.1f)` (`rts/Sim/Features/Feature.cpp:603`, also `GroundMoveType.cpp`). Not in any template. |
| `skyBox` | string | `""` | — | Cube-map / equirect skybox. **Path is hard-prefixed with `maps/`**, not run through `FIND_MAP_TEXTURE`: `sky = std::make_unique<CSkyBox>("maps/" + mapInfo->atmosphere.skyBox)` (`rts/Rendering/Env/ISky.cpp:75-79`). Non-empty → `CSkyBox`, empty → `CModernSky` (procedural). |

Runtime override: `Spring.SetAtmosphere{fogColor, skyColor, sunColor, cloudColor, skyAxisAngle,
fogStart, fogEnd}` (`LuaUnsyncedCtrl.cpp:4147-4176`).

---

## 8. `lighting` sub-table

`CMapInfo::ReadLight()` — `rts/Map/MapInfo.cpp:202-226`.

```cpp
light.sunDir = lightTable.GetFloat4("sunDir", float4(0.0f, 1.0f, 2.0f, 1.0f));
light.sunDir = {lightTable.GetFloat3("sunDir", light.sunDir), light.sunDir.w};
light.sunDir.ANormalize();
```

| mapinfo key | C++ field | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `sunDir` | `light.sunDir` | float3 **or** float4 | `{0, 1, 2, 1}` | Read as float4 first; if a 3-element value parses, `.xyz` is replaced and `.w` is kept from the float4 read (so a float3 leaves `.w = 1`). `.xyz` is then `ANormalize`d. `.w` is documented as "intensity" in `MapInfo.h:119`; BAR maps conventionally write `1e9` to mean "static sun". `ISkyLight` seeds itself from this (`rts/Rendering/Env/SkyLight.cpp:11`). |
| `groundAmbientColor` | `light.groundAmbientColor` | float3 | `{0.5, 0.5, 0.5}` | |
| `groundDiffuseColor` | `light.groundDiffuseColor` | float3 | `{0.5, 0.5, 0.5}` | Also the **default for `water.specularColor`** (§9) — `ReadLight` runs before `ReadWater`. |
| `groundSpecularColor` | `light.groundSpecularColor` | float3 | `{0.1, 0.1, 0.1}` | |
| `groundShadowDensity` | `light.groundShadowDensity` | float | `0.8` | `clamp(·, 0, 1)` |
| `unitAmbientColor` | `light.modelAmbientColor` | float3 → `float4` | `{0.4, 0.4, 0.4}` | **Key/field name mismatch**: mapinfo says "unit", C++ says "model". `.w` stays 0. |
| `unitDiffuseColor` | `light.modelDiffuseColor` | float3 → `float4` | `{0.7, 0.7, 0.7}` | |
| `unitSpecularColor` | `light.modelSpecularColor` | float3 | **defaults to `unitDiffuseColor`** | `light.modelSpecularColor = lightTable.GetFloat3("unitSpecularColor", light.modelDiffuseColor)` (`MapInfo.cpp:219`). |
| `unitShadowDensity` | `light.modelShadowDensity` | float | `0.8` | `clamp(·, 0, 1)` |
| `specularExponent` | `light.specularExponent` | float | `100.0` | Blinn-Phong exponent for both ground and models. |

**Keys real maps write that the engine ignores:** `sunStartAngle`, `sunOrbitTime`
(dynamic-sun leftovers from Spring 0.8x — removed from the parser),
`specularSunColor`, `groudspecularcolor` (a typo in `map_blueprint` for `groundSpecularColor`, so
that map silently gets the `{0.1,0.1,0.1}` default).

All nine values are copied into `CSunLighting` (`rts/Rendering/Env/SunLighting.cpp:56-75`), which is
what `Spring.SetSunLighting{...}` mutates at runtime; `Spring.SetSunDirection` changes the direction.
BAR's `gfx_deferred_rendering_GL4.lua:2479-2500` reads `mapinfo.lighting[<lowercased key>]`, scales
each component by a night factor, and pushes the result back through `Spring.SetSunLighting` —
which is why a BAR map that omits, say, `unitspecularcolor` gets a console warning
`"Deferred Lights GL4: Warning: This map does not specify …"`.

---

## 9. `water` sub-table

`CMapInfo::ReadWater()` — `rts/Map/MapInfo.cpp:229-337`. Struct: `MapInfo.h:133-174`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `damage` | float | `0.0` | **Multiplied by `UNIT_SLOWUPDATE_RATE * INV_GAME_SPEED` = `15/30` = 0.5 at parse time.** Applied in `CUnit::SlowUpdate → DoWaterDamage` once per 15 frames (`rts/Sim/Units/Unit.cpp:987, 1215-1229`), so 2×/s × 0.5 ⇒ **the mapinfo value is HP per second**. `Game.waterDamage` reports the already-scaled (halved) number. |
| `fluidDensity` | float | `960 * 0.25` = **240** | Water density kg/m³ for drag (`Feature.cpp:603`). Not in templates. |
| `repeatX`, `repeatY` | float | `0.0` each | Water texture repeat; `0` means "let the renderer compute it from map size". |
| `absorb` | float3 | `{0, 0, 0}` | Per-channel absorption **per elmo of depth**. Uniform `waterAbsorbColor` in the ground shader. |
| `baseColor` | float3 | `{0, 0, 0}` | Colour shallow water starts from (`waterBaseColor`). |
| `minColor` | float3 | `{0, 0, 0}` | Deep-water floor colour (`waterMinColor`). |
| `surfaceColor` | float3 | `{0.75, 0.8, 0.85}` | Tint of the water surface texture. |
| `surfaceAlpha` | float | `0.55` | Surface opacity. |
| `planeColor` | float3 → `float4` | `{0.0, 0.4, 0.0}` | Colour of the infinite off-map water plane. `.w` remains 0. |
| *(implicit)* `hasWaterPlane` | bool | `wt.KeyExists("planeColor")` | **Derived, not read.** Writing `planeColor` at all turns the off-map plane on. Writing `hasWaterPlane = false` in mapinfo does nothing (real maps do it anyway); only `Spring.SetWaterParams{hasWaterPlane=…}` can change it later. |
| `diffuseColor` | float3 | `{1, 1, 1}` | |
| `specularColor` | float3 | **`lighting.groundDiffuseColor`** | Cross-section default (`MapInfo.cpp:254`). |
| `ambientFactor` | float | `1.0` | |
| `diffuseFactor` | float | `1.0` | |
| `specularFactor` | float | `1.0` | |
| `specularPower` | float | `20.0` | |
| `fresnelMin` | float | `0.2` | Reflectivity looking straight down. |
| `fresnelMax` | float | `0.8` | Reflectivity at grazing angles. (`maphelper/mapdefaults.lua` claims `0.3`; the engine says `0.8`.) |
| `fresnelPower` | float | `4.0` | Fresnel curve exponent. |
| `reflectionDistortion` | float → `reflDistortion` | `1.0` | **Key/field name mismatch.** |
| `blurBase` | float | `2.0` | Reflection blur base. |
| `blurExponent` | float | `1.5` | Reflection blur falloff. |
| `perlinStartFreq` | float | `8.0` | Dynamic-wave noise base frequency. |
| `perlinLacunarity` | float | `3.0` | |
| `perlinAmplitude` | float | `0.9` | |
| `windSpeed` | float | `1.0` | Wave scroll speed multiplier. |
| `waveOffsetFactor` | float | `0.0` | Shore-wave offset. |
| `waveLength` | float | `0.15` | |
| `waveFoamDistortion` | float | `0.05` | |
| `waveFoamIntensity` | float | `0.5` | |
| `causticsResolution` | float | `75.0` | Caustic pattern world scale. |
| `causticsStrength` | float | `0.08` | |
| `shoreWaves` | bool | `true` | |
| `forceRendering` | bool | `false` | Render water even when `currentMinMapHeight >= 0` (`MapInfo.h:167`). |
| `numTiles` | int | `4` | `clamp(·, 1, 16)`. **Overwritten to 4 when `normalTexture` is empty** — the engine's built-in `waterbump_4tiles.dds` is a 4×4 tile set; user normal maps are expected to be 1×1 with no DynWaves (`MapInfo.cpp:301-313`). |
| `texture` | string | `""` → `resources.lua graphics.maps.watertex` → `"ocean.jpg"` | `FIND_MAP_TEXTURE` with `maps/` first, then `bitmaps/` for the fallback. |
| `foamTexture` | string | `""` → `graphics.maps.waterfoamtex` → `"foam.jpg"` | |
| `normalTexture` | string | `""` → `graphics.maps.waternormaltex` → `"waterbump_4tiles.dds"` | |
| `caustics` | array of string | *(see below)* | 1-based, contiguous, stops at the first empty string. |

**Caustics resolution order** (`MapInfo.cpp:315-336`):

1. `water.caustics` in mapinfo → each entry resolved with prefix `maps/`.
2. else `resources.lua → graphics.caustics` → prefix `bitmaps/`.
3. else 32 hardcoded `bitmaps/caustics/caustic00.jpg … caustic31.jpg`.

BAR reaches case 2: `gamedata/resources.lua` calls `AutoAdd("caustics", false)`, which enumerates
`bitmaps/caustics/` from the VFS (`Beyond-All-Reason/gamedata/resources.lua:104-124`).

All of these (minus `damage` and `fluidDensity`) are copied into `CWaterRendering`
(`rts/Rendering/Env/WaterRendering.cpp:19-65`), the struct that `Spring.SetWaterParams{...}` mutates
(`LuaUnsyncedCtrl.cpp:4652-4835` lists every accepted key — identical names to the mapinfo keys).

---

## 10. `grass`, `terrainTypes`, `pfs`, `sound`, `teams`, `custom`

### 10.1 `grass`

`CMapInfo::ReadGrass()` — `MapInfo.cpp:185-200`.

| mapinfo key | C++ field | Type | Engine default | Template value |
| --- | --- | --- | --- | --- |
| `bladeWaveScale` | `grass.bladeWaveScale` | float | `1.0` | `1.0` |
| `bladeWidth` | `grass.bladeWidth` | float | **`0.7`** | `0.32` |
| `bladeHeight` | `grass.bladeHeight` | float | **`4.5`** | `4.0` |
| `bladeAngle` | `grass.bladeAngle` | float | **`1.0`** | `1.57` |
| `maxStrawsPerTurf` | `grass.maxStrawsPerTurf` | int | `150` | (never written) |
| `bladeColor` | `grass.color` | float3 | `{0.10, 0.40, 0.10}` | `{0.59, 0.81, 0.57}` |
| *(in `resources`)* `grassBladeTex` | `grass.bladeTexName` | string | `""` | commented out |

Actual blade height is `bladeHeight + randf(0, bladeHeight)` (`MapInfo.h:110`); `bladeWaveScale = 0`
disables vertex animation. The `maphelper/mapdefaults.lua` numbers (`0.32 / 4.0 / 1.57`) differ from
the engine defaults and are what the BAR templates copied.

BAR does not use the engine grass drawer in practice — `luaui/Widgets/map_grass_gl4.lua` replaces it
and takes its configuration from `custom.grassConfig` (§12.4).

### 10.2 `terrainTypes` — 256 slots

`CMapInfo::ReadTerrainTypes()` — `MapInfo.cpp:432-458`, struct at `MapInfo.h:229-239`.

```cpp
static constexpr int NUM_TERRAIN_TYPES = 256;   // MapInfo.h:25

for (int tt = 0; tt < NUM_TERRAIN_TYPES; tt++) {
    const LuaTable& terrain   = terrTypeTable.SubTable(tt);      // NOTE: integer key
    const LuaTable& moveTable = terrain.SubTable("moveSpeeds");

    terrType.name          = terrain.GetString("name", "Default");
    terrType.hardness      = terrain.GetFloat("hardness",   1.0f);
    terrType.receiveTracks = terrain.GetBool("receiveTracks", true);
    terrType.tankSpeed     = moveTable.GetFloat("tank",  1.0f);
    terrType.kbotSpeed     = moveTable.GetFloat("kbot",  1.0f);
    terrType.hoverSpeed    = moveTable.GetFloat("hover", 1.0f);
    terrType.shipSpeed     = moveTable.GetFloat("ship",  1.0f);

    terrType.hardness   = std::max(0.001f, terrType.hardness);
    terrType.tankSpeed  = std::max(0.000f, terrType.tankSpeed);   // …kbot, hover, ship likewise
}
```

* Indexed **`[0] … [255]` with integer keys** (the typemap byte is the index). Missing slots are
  fully defaulted — you only need to define the ones your typemap actually uses.
* `name` — string, default `"Default"`. Feeds the typemap checksum (`ReadMap.cpp:484`) and is
  readable via `Spring.GetTerrainTypeData`.
* `hardness` — float, default `1.0`, `max(0.001, ·)`. **Multiplies `maphardness`**, it is not an
  absolute value.
* `receiveTracks` — bool, default `true`. `CGroundDecalHandler` gates unit tracks on it
  (`rts/Rendering/Env/Decals/GroundDecalHandler.cpp:1247`).
* `moveSpeeds = { tank, kbot, hover, ship }` — floats, default `1.0`, `max(0, ·)`. These are the
  **exact** key names (lowercase after key-lowering). Applied as a multiplier on the computed speed
  mod per move class:

  ```cpp
  // rts/Sim/MoveTypes/MoveMath/MoveMath.cpp:96-101
  case MoveDef::Tank:  return GroundSpeedMod(moveDef, height, slope) * tt.tankSpeed;
  case MoveDef::KBot:  return GroundSpeedMod(moveDef, height, slope) * tt.kbotSpeed;
  case MoveDef::Hover: return  HoverSpeedMod(moveDef, height, slope) * tt.hoverSpeed;
  case MoveDef::Ship:  return   ShipSpeedMod(moveDef, height, slope) * tt.shipSpeed;
  ```

  A speed of `0` makes the terrain type impassable for that class.

`CReadMap::CalcTypemapChecksum` hashes the typemap plus, for each of the 256 types, `name` and the
byte range from `hardness` up to (not including) `receiveTracks`
(`rts/Map/ReadMap.cpp:478-489`) — which is why `MapInfo.h:228` warns *"If this struct is changed,
please fix CReadMap::CalcTypemapChecksum accordingly"*. Terrain-type data is therefore **synced**.

Runtime mutation: `Spring.SetTerrainTypeData(typeIndex, tank, kbot, hover, ship, hardness,
receiveTracks, name)` (`rts/Lua/LuaSyncedCtrl.cpp:7155-7180`); `Spring.SetMapSquareTerrainType`
changes which type a square uses.

### 10.3 `pfs.qtpfsConstants`

`CMapInfo::ReadPFSConstants()` — `MapInfo.cpp:460-480`. Nested under `pfs`; a `legacyConstants`
sub-table is parsed for nothing (commented out).

| Key | Type | Default | Clamp |
| --- | --- | --- | --- |
| `layersPerUpdate` | uint | `5` | |
| `maxTeamSearches` | uint | `25` | |
| `minNodeSizeX` | uint | `8` | |
| `minNodeSizeZ` | uint | `8` | |
| `maxNodeDepth` | uint | `16` | |
| `numSpeedModBins` | uint | `10` | |
| `minSpeedModVal` | float | `0.0` | `max(0, ·)` |
| `maxSpeedModVal` | float | `2.0` | `max(minSpeedModVal, ·)` |
| `maxNodesSearched` | uint | `0` | |
| `maxRelativeNodesSearched` | float | `0.0` | |

No published BAR map sets these.

### 10.4 `sound`

`CMapInfo::ReadSound()` — `MapInfo.cpp:482-543`. Compiled out for `HEADLESS` / `NO_SOUND`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `preset` | string | `"default"` | Looked up in `eaxPresets`. If not found the props stay at their zero-initialised `EAXSfxProps()` values (there is no `"default"` entry in `EFXPresets.cpp` — the table has `"generic"`, `"room"`, `"cave"`, `"mountains"`, `"forest"`, `"plain"`, `"underwater"`, the `castle_*`/`city_*` families, etc.). |
| `passfilter.gainlf` | float | *(preset)* | `AL_LOWPASS_GAIN` |
| `passfilter.gainhf` | float | *(preset)* | `AL_LOWPASS_GAINHF` |
| `reverb.*` | — | — | **Read but never used — see below.** |

Only two names exist in `nameToALFilterParam` (`rts/System/Sound/OpenAL/EFXPresets.cpp:212-213`):
`"gainlf"` → `AL_LOWPASS_GAIN`, `"gainhf"` → `AL_LOWPASS_GAINHF`.

**Engine bug worth knowing.** `ReadSound` evaluates `soundTable.SubTable("reverb")` and *discards
the result*, then runs the second loop over `filterTable` (= `sound.passfilter`) again:

```cpp
// rts/Map/MapInfo.cpp:515-541
soundTable.SubTable("reverb");                 // <- return value thrown away

for (const auto& item: nameToALFilterParam) {  // <- still only gainlf/gainhf
    const int luaType = filterTable.GetType(name);     // <- still passfilter
    …
    case EFXParamTypes::FLOAT: efxprops->reverb_props_f[param] = filterTable.GetFloat(name, 0.0f);
}
```

Because `AL_LOWPASS_GAIN == AL_EAXREVERB_DENSITY == 0x0001` and
`AL_LOWPASS_GAINHF == AL_EAXREVERB_DIFFUSION == 0x0002`, writing `passfilter.gainlf`/`gainhf` also
overwrites reverb **density** and **diffusion**. The `reverb = { … }` table that every BAR map ships
(with all keys commented out) has no effect at all. Maps that set `gainlf = 1.0, gainhf = 1.0`
(the universal BAR idiom) are silently forcing density = 1 and diffusion = 1 on the preset.

The documented-but-unreachable reverb names, for reference (`EFXPresets.cpp:187-210`): `density`,
`diffusion`, `gain`, `gainhf`, `gainlf`, `decaytime`, `decayhflimit`, `decayhfratio`,
`decaylfratio`, `reflectionsgain`, `reflectionsdelay`, `reflectionspan`, `latereverbgain`,
`latereverbdelay`, `latereverbpan`, `echotime`, `echodepth`, `modtime`, `moddepth`,
`airabsorptiongainhf`, `hfreference`, `lfreference`, `roomrollofffactor`.

### 10.5 `custom` — pure passthrough

The engine **never reads `custom`**. `grep -n "custom" rts/Map/MapInfo.cpp` returns nothing.
It exists solely so that game-side Lua can `VFS.Include("mapinfo.lua")` and pull map-specific
configuration out of it. See §12.4 for what BAR actually consumes.

Same applies to any other unknown top-level key: `CMapInfo` ignores it; `CArchiveScanner` stores it
as a scalar info item if it is a string/number/bool and ignores it if it is a table.

---

## 11. `teams` — start positions, and how BAR really does start boxes

### 11.1 What the engine parses

```cpp
// rts/Map/MapParser.cpp:62-85
bool MapParser::GetStartPos(int team, float3& pos) {
    const LuaTable&  rootTable = parser.GetRoot();
    const LuaTable& teamsTable =  rootTable.SubTable("teams");
    const LuaTable&  teamTable = teamsTable.SubTable(team);      // integer key
    const LuaTable&   posTable =  teamTable.SubTable("startPos");

    if (!posTable.IsValid()) {
        errorLog = "[MapParser] start-position for team " + IntToString(team) + " not defined in the map's config";
        return false;
    }
    pos.x = posTable.GetFloat("x", pos.x);
    pos.z = posTable.GetFloat("z", pos.z);
    return true;
}
```

Shape:

```lua
teams = {
  [0] = {startPos = {x = 2560, z = 4810}},
  [1] = {startPos = {x = 2560, z =  310}},
  [2] = {startPos = {x = 4810, z = 2560}},
  [3] = {startPos = {x =  310, z = 2560}},
},
```

* **Indexed by `teamStartNum`, 0-based, integer keys.** `[0]` is mandatory if you want any.
* **Only `x` and `z` are read. There is no `y`.** Ground height is resolved later; `Spring.GetMapStartPositions`
  returns `{x, 0, z}` because `float3` default-constructs to zero (`LuaSyncedRead.cpp:1612-1630`).
* Coordinates are **world elmos**, i.e. `0 … mapx*8` by `0 … mapy*8`.
* A missing `startPos` sub-table is a soft failure: the engine logs a warning and **stops scanning
  further teams** (`CGameSetup::LoadStartPositions`, `rts/Game/GameSetup.cpp:285-298`). unitsync's
  `internal_GetMapInfo` likewise counts positions by walking `curTeam = 0, 1, 2, …` until the first
  failure (`tools/unitsync/unitsync.cpp:657-667`). **So the table must be contiguous from 0.**

Positions are only consulted when the start script says so
(`GAME\StartPosType` in `script.txt`, `GameSetup.h:171-177`):

| `startPosType` | Behaviour |
| --- | --- |
| `0` `StartPos_Fixed` | team *i* uses `teams[i]` |
| `1` `StartPos_Random` | the `teamStartNum → team` mapping is shuffled with a seed hashed from the setup text, then `teams[teamStartNum]` is used |
| `2` `StartPos_ChooseInGame` | mapinfo positions are **not loaded at all** (`GameSetup.cpp:282-283`) |
| `3` `StartPos_ChooseBeforeGame` | same |

`Spring.GetMapStartPositions()` re-reads them on demand for up to `MAX_TEAMS` (255) teams.

### 11.2 SMF and `.smd` — where else positions can come from

* The `.smf` binary format contains **no** start positions (`SMFHeader`, §13).
* The legacy `.smd` TDF did: `[MAP] { [TEAM0] { StartPosX=…; StartPosZ=…; } }`, converted by
  `maphelper/parse_tdf_map.lua:69-89` into exactly the `teams[n].startpos.{x,z}` shape above. So
  "mapinfo teams vs the .smf vs a separate file" reduces to: **mapinfo `teams` is the only source**;
  `.smd` is the same data in the old syntax; the `.smf` never had it.

### 11.3 BAR: start **boxes** live outside the map entirely

BAR plays with `StartPosType = 2/3` (choose in/before game) and allyteam start **rectangles**, which
the engine reads from the start script's `[ALLYTEAM]` `StartRectTop/Left/Right/Bottom`, not from the
map. Those rectangles are authored in **`beyond-all-reason/maps-metadata`**, keyed by `springName`,
and published as JSON for the lobby / SPADS / Teiserver
(`schemas/map_list.yaml`):

```yaml
startboxesSet:                 # keyed by a set name, e.g. "2", "4", "ffa"
  <setName>:
    startboxes:                # array, one per allyteam
      - poly: <StartboxRect | StartboxPolygon>
    maxPlayersPerStartbox: 1..16
startPos:
  positions: { <name>: {x, y} }        # named spawn/base points, integer elmos
  team:
    - playersPerTeam: int
      teamCount: int
      sides:
        - starts:
            - spawnPoint: <positions key>
              baseCenter: <positions key>
              role: air | air/front | air/sea | air/tech | front | front/sea | front/tech | sea | sea/tech | tech
startPosActive: bool
```

* `StartboxRect` — **2 points**, top-left and bottom-right, in a **0–200 normalized coordinate
  space**. The schema note is explicit: *"Every existing map ships this, and it is the only shape
  the engine, SPADS and TEIServer understand directly."*
* `StartboxPolygon` — 3+ points in the same 0–200 space, each with an optional Catmull-Rom
  `strength` in `[0,1]` for spline smoothing (game/lobby side only).

Other per-map metadata BAR keeps there (not in mapinfo): `springName`, `displayName`, `author`,
`title`, `description`, `gameType` (`ffa|1v1|team|pve`), `terrain` (an enum of 24 tags: `lava`,
`ice`, `acidic`, `alien`, `asteroid`, `space`, `desert`, `forests`, `grassy`, `tropical`, `swamp`,
`jungle`, `wasteland`, `metal`, `industrial`, `ruins`, `sea`, `water`, `island`, `shallows`,
`chokepoints`, `asymmetrical`, `flat`, `hills`), `playerCount`, `teamCount`, `certified`, `inPool`,
`special`, `photo`/`backgroundImage`/`perspectiveShot`/`inGameShots`, `mapLists`, `minPlayerCount`.

**Bottom line for a map author:** put sane `teams[0..N].startPos` in `mapinfo.lua` (so the map is
playable standalone / in other games / for AI-vs-AI), but expect BAR ranked play to ignore them and
use the maps-metadata startboxes instead.

---

## 12. BAR-specific conventions

### 12.1 The mandatory file skeleton

Every BAR map (and both BAR/engine templates) follows this exact shape:

```lua
local mapinfo = {  … one big literal table … }

local function lowerkeys(ta)  … recursive in-place key lowering … end
lowerkeys(mapinfo)

if (Spring) then
  local function tmerge(t1, t2) … deep merge … end
  if (not Spring.GetMapOptions) then Spring.GetMapOptions = function() return {} end end
  function tobool(val) … end

  getfenv()["mapinfo"] = mapinfo
    local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
    table.sort(files)
    for i = 1, #files do
      local newcfg = VFS.Include(files[i])
      if newcfg then lowerkeys(newcfg); tmerge(mapinfo, newcfg) end
    end
  getfenv()["mapinfo"] = nil
end

return mapinfo
```

Four things this buys you, all of which you must preserve:

1. **`local mapinfo = { … }` must be the first statement in the file.** BAR's `map-parser`
   (used by maps-metadata / the CDN pipeline) does **not execute** the Lua — it parses it with
   `luaparse` and takes `parsedMapInfo.body[0] as LocalStatement`, then the first
   `TableConstructorExpression` in its `init`
   (`beyond-all-reason/map-parser/src/map-parser.ts:426-433`). Anything computed, concatenated or
   assigned after the fact is invisible to BAR tooling. Only string / numeric / boolean literals,
   negated numeric literals, and nested table constructors survive
   (`parseMapInfoFields`, `map-parser.ts:436-476`).
2. **`lowerkeys(mapinfo)`** makes the table game-Lua-friendly. The engine lowercases anyway
   (§1.4), but `VFS.Include("mapinfo.lua")` from a widget/gadget does not — so without this call,
   `mapinfo.voidwater` in `map_voidground.lua` would be `nil` for a map that wrote `voidWater`.
3. **`mapconfig/mapinfo/*.lua` merge.** Files are `table.sort`ed (hence the `0_`, `1_` prefix
   convention) and each may either mutate the `mapinfo` global directly (it is exposed via
   `getfenv()` for the duration) or return a table that is deep-merged in. This is BAR's map-option
   mechanism: `map_blueprint/mapconfig/mapinfo/0_apply_options.lua` reads
   `Spring.GetMapOptions().waterlevel / .waterdamage / .roads` and rewrites
   `mapinfo.smf.minheight/maxheight`, `mapinfo.water.*` and every
   `mapinfo.terraintypes[i].movespeeds[*]`. Note it addresses the **lowercased** names, because
   `lowerkeys` already ran.
4. `maphelper/mapinfo.lua` inside the map archive: `return VFS.Include("mapinfo.lua")` —
   backwards compatibility with engines ≤ 0.82, harmless today.

`mapoptions.lua` at the archive root declares the options the lobby shows
(`key`, `name`, `desc`, `type`, `def`, `min`, `max`, `step`, `items`, `maxlen`, `scope`).

### 12.2 `mapinfo.lua` vs `mapconfig/` — the split

| Path | Read by | Purpose |
| --- | --- | --- |
| `mapinfo.lua` | engine (`CMapInfo`, `CArchiveScanner`) + any game Lua via `VFS.Include` | everything in this document |
| `mapconfig/mapinfo/*.lua` | `mapinfo.lua` itself, at parse time | map-option-driven patches to the mapinfo table |
| `mapconfig/lava.lua` | BAR `modules/lava.lua:4` (`MAP_CONFIG_PATH`) | lava plane: level, grow, damage, textures, fog, tide rhythm, CEGs, sounds. Falls back to the game-side `common/configs/LavaMaps/<mapname>.lua`; map config wins unless the game config sets `overrideMap`. **Skipped entirely when `mapinfo.voidwater` is true.** |
| `mapconfig/map_metal_layout.lua` | BAR `luarules/gadgets/map_metal_spot_placer.lua:24` | explicit metal-spot list instead of a metalmap |
| `mapconfig/featureplacer/config.lua` + `set.lua` | the map's own `LuaGaia/Gadgets/FP_featureplacer.lua` | feature/unit placement |

So: **`mapinfo.lua` is engine-facing; `mapconfig/` is game-facing** (plus the one reflexive
`mapconfig/mapinfo/` hook).

### 12.3 What BAR's game code reads out of `mapinfo.lua`

All via `pcall(VFS.Include, "mapinfo.lua")` and all with **lowercased** keys:

| Consumer | Reads |
| --- | --- |
| `luarules/gadgets/map_voidground.lua:19-29` | `mapinfo.voidwater` — kills non-flying units in the void |
| `luarules/gadgets/unit_waterspeedmultiplier.lua:5-6` | `mapinfo.voidwater` |
| `luarules/gadgets/unit_area_timed_damage.lua:107-108` | `mapinfo.voidwater` |
| `luarules/gadgets/cmd_place_target_on_ground.lua:47-52` | `mapinfo.voidwater` |
| `luarules/gadgets/unit_sunfacing.lua:39-42` | `mapinfo.lighting.sundir` — orients solar collectors |
| `luaui/Widgets/cmd_context_build.lua:5-7` | `mapinfo.voidwater` |
| `luaui/Widgets/gfx_decals_gl4.lua:846-848` | `mapinfo.voidwater` |
| `luaui/Widgets/gfx_deferred_rendering_GL4.lua:2479-2500` | `mapinfo.lighting[<key>]` for the night-mode lighting rescale |
| `luaui/Widgets/gfx_volumetric_clouds.lua:42-48` | `mapinfo.custom.clouds` |
| `luaui/Widgets/map_grass_gl4.lua:130-158` | `mapinfo.custom.grassconfig` |
| `luaui/Widgets/gui_mapinfo.lua:56,148` | `mapinfo.author` |
| `modules/lava.lua:9-12` | `mapinfo.voidwater` |

### 12.4 The `custom.*` tables BAR understands

**`custom.clouds`** → `gfx_volumetric_clouds.lua`. Every key of the table is copied straight over the
widget's `CloudDefs`, so the accepted keys are exactly:

| Key | BAR default | Meaning |
| --- | --- | --- |
| `speed` | `0.5` | scroll speed multiplier vs. wind |
| `color` | `{0.6, 0.7, 0.8}` | diffuse fog colour |
| `height` | `4800` | altitude where opacity reaches zero |
| `bottom` | `1200` | no fog below this |
| `fade_alt` | `2500` | linear fade start (between `bottom` and `height`) |
| `scale` | `700` | cloud feature size |
| `opacity` | `0.65` | |
| `clamp_to_map` | `false` | slice the volume to the map, or extend to the horizon |
| `sun_penetration` | `50` | |

`height`, `bottom`, `fade_alt` accept an absolute number, the string `"auto"`, or a percentage
string like `"80%"` — resolved against `select(2, Spring.GetGroundExtremes())`
(`gfx_volumetric_clouds.lua:55-70`).

**`custom.grassConfig`** → `map_grass_gl4.lua`. Merged key-by-key over the widget defaults, with a
case-insensitive match against the default table's own CamelCase names
(`map_grass_gl4.lua:130-158`). Recognised keys and defaults:

`patchResolution` 32, `patchPlacementJitter` 0.66, `patchSize` 4, `grassBladeScale` 0.5,
`grassMinSize` 0.55, `grassMaxSize` 1.5, `grassBladeColorTex`, `mapGrassColorModTex` (`"$grass"`),
`grassWindPerturbTex`, `grassWindMult` 4.5, `maxWindSpeed` 20, `grassDistTGA` `""`, plus a nested
`grassShaderParams` table (merged the same way) with `MAPCOLORFACTOR` 0.6, `MAPCOLORBASE` 1.0,
`ALPHATHRESHOLD` 0.01, `WINDSTRENGTH` 0.06, `WINDSCALE` 0.33, `WINDSAMPLESCALE` 0.0007,
`FADESTART` 5000, `FADEEND` 8000, `SHADOWFACTOR` 0.25, `HASSHADOWS` 1, `GRASSBRIGHTNESS` 1.0,
`COMPACTVBO` 1, `UNITBENDENABLED` 1, `UNITBENDSTRENGTH` 5.5, `UNITBENDFALLOFF` 0.8,
`UNITBENDSHRINK` 0.55.

`grassDistTGA` must be an 8-bit uncompressed greyscale TGA sized
`Game.mapSizeX/patchResolution × Game.mapSizeZ/patchResolution`.

**`custom.fog`** (`color`, `height` — absolute or `"NN%"` of max height, `fogatten`) and
**`custom.precipitation`** (`weather`, `density`, `size`, `speed`, `windscale`, `texture`) appear in
every BAR map and in `mapgenerator/mapinfo_template.lua`, but a repo-wide code search of
`beyond-all-reason/Beyond-All-Reason` for `fogatten` / `precipitation` finds **only**
`mapgenerator/mapinfo_template.lua` and the unrelated weather-brush widgets. **Current BAR game code
does not consume `custom.fog` or `custom.precipitation`** — they are inherited boilerplate from the
Spring-era `gfx_fog` / precipitation widgets. Keep them if you want (they are typed by BAR's
`map-parser` `Custom` model), but do not expect them to do anything.

**`custom.pbr`** is not BAR core — it belongs to lhog's experimental PBR map shader
(`lhog/spring-map-pbr`, `lhog/enceladus_1a.sdd`) and carries `enabled`, a `textures` map of
integer slot → file, a `definitions` map of GLSL `#define` name → replacement text, and a `splats`
array of per-material `{workflow = "SPECULAR"|…, weight = "<glsl expr>", specularF0, …}` records.

### 12.5 `mapfile` hygiene

Set `mapfile = "maps/<Name>.smf"`. Without it the scanner walks the whole archive
(`SearchMapFile`) on every scan and logs a warning for any archive type other than `.sdv`
(`ArchiveScanner.cpp:756-761`).

---

## 13. What `smf.*` overrides, in binary terms

`rts/Map/SMF/SMFFormat.h`. The header is a packed, little-endian, 32-bit-int struct at file
offset 0:

| Offset | Size | Type | Field | Note |
| ---: | ---: | --- | --- | --- |
| 0 | 16 | `char[16]` | `magic` | `"spring map file\0"` |
| 16 | 4 | `int32` | `version` | must be 1 |
| 20 | 4 | `int32` | `mapid` | random GUID-ish |
| 24 | 4 | `int32` | `mapx` | squares; divisible by 128 |
| 28 | 4 | `int32` | `mapy` | squares; divisible by 128 |
| 32 | 4 | `int32` | `squareSize` | must be 8 |
| 36 | 4 | `int32` | `texelPerSquare` | must be 8 |
| 40 | 4 | `int32` | `tilesize` | must be 32 |
| 44 | 4 | `float` | `minHeight` | ← **`mapinfo.smf.minHeight` overrides this** |
| 48 | 4 | `float` | `maxHeight` | ← **`mapinfo.smf.maxHeight` overrides this** |
| 52 | 4 | `int32` | `heightmapPtr` | → `uint16[(mapy+1)*(mapx+1)]` |
| 56 | 4 | `int32` | `typeMapPtr` | → `uint8[(mapy/2)*(mapx/2)]` ← `typemapTex` overrides |
| 60 | 4 | `int32` | `tilesPtr` | → `MapTileHeader` ← `smtFileName%i` overrides the names in it |
| 64 | 4 | `int32` | `minimapPtr` | → 699048 bytes DXT1 + 8 mips ← `minimapTex` overrides |
| 68 | 4 | `int32` | `metalmapPtr` | → `uint8[(mapx/2)*(mapy/2)]` ← `metalmapTex` overrides |
| 72 | 4 | `int32` | `featurePtr` | → `MapFeatureHeader` |
| 76 | 4 | `int32` | `numExtraHeaders` | `ExtraHeader{int size; int type;}` records follow |
| **80** | | | *end of SMFHeader* | |

`ExtraHeader.type == MEH_Vegetation (1)` points at `uint8[(mapx/4)*(mapy/4)]` grass coverage
(0 = none, 1 = grass) ← `grassmapTex` overrides.

Constants: `MINIMAP_NUM_MIPMAP = 9`, `MINIMAP_SIZE = 699048`,
`SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6) = 512+128+32+8 = 680` bytes
(a 32×32 DXT1 tile plus 4 mips).

### 13.1 Worked size calculation — a 16×16 BAR map

"16×16" is the mapper's unit: `mapx = mapy = 16 * 64 = 1024` squares.

| Quantity | Formula | Value |
| --- | --- | --- |
| World size | `mapx * SQUARE_SIZE` | `1024 * 8` = **8192 × 8192 elmos** |
| `Game.mapX` / `mapY` | `mapDims.mapx / 64` | 16 × 16 |
| Heightmap | `(mapx+1)*(mapy+1) * 2` | `1025 * 1025 * 2` = **2 101 250 B** |
| Typemap / metalmap (each) | `(mapx/2)*(mapy/2)` | `512 * 512` = **262 144 B** |
| Grass map | `(mapx/4)*(mapy/4)` | `256 * 256` = **65 536 B** |
| Tile index map | `(mapx/4)*(mapy/4) * 4` | `256 * 256 * 4` = **262 144 B** |
| Minimap | fixed | **699 048 B** = 524288 + 131072 + 32768 + 8192 + 2048 + 512 + 128 + 32 + 8 (1024² DXT1 + 8 mips) |

So an override `typemapTex` or `metalmapTex` for this map must be **exactly 512 × 512** 8-bit
greyscale, and a `minimapTex` replacement is a normal image of any size (it is loaded as a plain
`CBitmap`, not as the raw DXT block).

### 13.2 Worked height calculation

`map_blueprint` ships `smf = { minheight = -340.0, maxheight = 760.0 }`.

```
span     = 760 - (-340)                 = 1100 elmos
step     = span / 65536                 = 0.0167846680 elmos per raw unit
raw 0    -> -340.0      (deepest point)
raw 20268-> -340 + 20268*0.01678467     = -2.79   (just below sea level)
raw 20435-> -340 + 20435*0.01678467     = +0.01   (sea level, y = 0, at raw ≈ 20254.5… )
raw 65535-> -340 + 65535*0.01678467     = +759.98 (peak)
```

Sea level sits at raw `= -minHeight / step = 340 / 0.01678467 = 20256`, i.e. 30.9 % of the raw
range. Switching to the water-level-2 option (`minheight = -610, maxheight = 390`,
span 1000, step 0.01525879) moves sea level to raw `= 610 / 0.01525879 = 39976`, i.e. 61 % of the
range — the same heightmap now has far more of itself underwater, and the whole terrain is 9 %
flatter vertically because the span shrank from 1100 to 1000.

---

## 14. Execution order and cross-field defaults

`CMapInfo::CMapInfo` (`MapInfo.cpp:65-75`) runs the readers in this order:

```
ReadGlobal → ReadAtmosphere → ReadGui → ReadSplats → ReadGrass →
ReadLight → ReadWater → ReadSMF → ReadTerrainTypes → ReadPFSConstants → ReadSound
```

This order is load-bearing exactly once: `water.specularColor` defaults to
`light.groundDiffuseColor`, and `ReadLight` runs before `ReadWater`.

`gamedata/resources.lua` is parsed **before** any of them
(`LuaParser resParser("gamedata/resources.lua", SPRING_VFS_MOD_BASE, SPRING_VFS_ZIP)`,
`MapInfo.cpp:56-63`) and kept in `resTableRoot` for the water/detail/caustic fallbacks. Note it is
loaded with `SPRING_VFS_MOD_BASE` ("Mb") — the **game's** resources.lua, not the map's.

### Runtime-mutable mirrors

| mapinfo section | Runtime struct | Lua setter |
| --- | --- | --- |
| `lighting` | `CSunLighting` (`SunLighting.cpp:56-75`) | `Spring.SetSunLighting`, `Spring.SetSunDirection` |
| `water` (render half) | `CWaterRendering` (`WaterRendering.cpp:19-65`) | `Spring.SetWaterParams` |
| `splats` + `voidWater`/`voidGround` + `splatDetailNormalDiffuseAlpha` | `CMapRendering` (`MapRendering.cpp:19-29`) | `Spring.SetMapRenderingParams` |
| `atmosphere` | `ISky` members (`ISky.cpp:23-35`) | `Spring.SetAtmosphere` |
| `terrainTypes` | `mapInfo->terrainTypes` (const-cast'ed) | `Spring.SetTerrainTypeData` (**synced**) |

`MapInfo.cpp:28-32` states this explicitly: *"Before delete, the const is const_cast'ed away. There
are no (other) situations where mapInfo may be modified, except LuaUnsyncedCtrl may change water,
LuaSyncedCtrl may change terrainTypes."*

### Values reflected into `Game.*`

`rts/Lua/LuaConstGame.cpp:168-177`: `Game.mapName`, `Game.mapDescription`, `Game.mapHardness`,
`Game.extractorRadius`, `Game.tidal`, `Game.waterDamage` (already halved), `Game.gravity`
(re-multiplied by 900 → the mapinfo value). Plus `Game.mapDamage = !mapDamage->Disabled()`
(from `notDeformable`), `Game.windMin`/`windMax`, and `Game.mapX/mapY/mapSizeX/mapSizeZ` from the
SMF header.

---

## 15. Gotcha checklist

1. **Keys are case-insensitive to the engine but case-SENSITIVE to game Lua.** Always ship
   `lowerkeys(mapinfo)`.
2. **`local mapinfo = { … }` must be statement #1** or BAR's maps-metadata pipeline reads nothing.
3. **No computed values.** BAR's static parser only understands literals; the engine executes the
   file, so anything dynamic diverges between tooling and game.
4. **`mapinfo.lua` cannot see the game archive** (`SPRING_VFS_MAP_BASE` = "mb").
5. **`gravity` in mapinfo is positive elmos/s²**; `mapInfo->map.gravity` is negative elmos/frame².
6. **`water.damage` in mapinfo is HP/second**; the stored value is half that.
7. **`smf.minHeight = 0` is a real override** — presence, not value, is tested.
8. **Override info-maps must be exactly `(mapx/2) × (mapy/2)` 8-bit greyscale** or they are ignored
   with a warning.
9. **`smtFileName%i` counts must equal `tileHeader.numTileFiles`** or the whole override is dropped;
   values are resolved relative to the `.smf`'s directory, so use bare filenames.
10. **`atmosphere.skyBox` is prefixed with `maps/` unconditionally** (no `FIND_MAP_TEXTURE`).
11. **`atmosphere.skyDir` is deprecated and does nothing** (logs `L_DEPRECATED`). Use `skyAxisAngle`.
12. **`lighting.sunStartAngle` / `sunOrbitTime` / `specularSunColor` do nothing.**
13. **`specularTex` is the master switch** for SSMF/advanced ground shading.
14. **DNTS splatting needs a non-empty `splatDetailTex` string too** on some paths — BAR maps set it
    to a deliberately missing filename. BAR's own mapgenerator template comments this:
    *"some engine paths still key splat activation on splatDetailTex being non-empty even when DNTS
    normals are provided."*
15. **`splatDistrTex` is sampled with map-wide UVs** (`specularTexGen`), not tiled.
16. **Only the first 4 `splatDetailNormalTex*` are used.**
17. **`resources.splatDetailNormalTex` (nested) beats `splatDetailNormalDiffuseAlpha` (flat)** — if
    the nested table exists, the flat alpha key is ignored.
18. **`grassBladeTex` lives in `resources`, not `grass`.**
19. **`water.hasWaterPlane` is derived from `KeyExists("planeColor")`** — you cannot turn the plane
    off by writing `hasWaterPlane = false`.
20. **`water.numTiles` is forced to 4 when `normalTexture` is empty.**
21. **`sound.reverb` is dead code, and `sound.passfilter.gainlf/gainhf` leak into reverb
    density/diffusion** (§10.4).
22. **`teams` must be contiguous from `[0]`**; only `x` and `z` are read.
23. **Engine grass defaults ≠ template grass values** (`bladeWidth` 0.7 vs 0.32, `bladeHeight` 4.5
    vs 4.0, `bladeAngle` 1.0 vs 1.57).
24. **Typos are silent.** `map_blueprint` ships `groudspecularcolor` and just gets the default.
    There is no unknown-key warning anywhere in `CMapInfo`.
25. **`version` is appended to `name`** by the archive scanner, so `name = "Foo"` + `version = "1.2"`
    becomes the script name `"Foo 1.2"`.

---

## 16. Annotated, copy-pasteable template

Sane BAR-map defaults; every engine-read key present, with its engine default noted where it
differs from what is written.

```lua
--------------------------------------------------------------------------------
-- mapinfo.lua  —  Recoil / Beyond All Reason
-- NOTE: `local mapinfo = { ... }` MUST be the first statement in this file:
--       BAR's maps-metadata tooling parses it statically (luaparse) and only
--       understands string / number / boolean literals and nested tables.
--------------------------------------------------------------------------------

local mapinfo = {
	--== archive metadata (read by CArchiveScanner) ============================
	name        = "My Map",          -- REQUIRED. `version` is appended to this.
	shortname   = "MyMap",
	description = "8 player team map, hills and a central lake.",
	author      = "Your Name",
	version     = "1.0",
	mapfile     = "maps/My_Map_V1.smf", -- ALWAYS set: avoids a full archive scan
	modtype     = 3,                 -- 0 hidden, 1 game, 3 map, 4 base, 5 menu
	depend      = { "Map Helper v1" },  -- 1-based, contiguous
	replace     = {},

	--== global map settings ==================================================
	maphardness     = 100,   -- engine default 100; may be negative (inverted craters)
	notDeformable   = false,
	gravity         = 130,   -- positive elmos/s^2; engine stores -g/900 per frame^2
	tidalStrength   = 0,
	maxMetal        = 1.0,   -- metal yield of metalmap value 255 (engine default 0.02)
	extractorRadius = 100.0, -- engine default 500
	voidWater       = false, -- BAR gadgets read mapinfo.voidwater
	voidGround      = false,
	voidAlphaMin    = 0.9,   -- alpha-test threshold for void passes
	autoShowMetal   = true,

	--== SMF compile-time overrides ===========================================
	smf = {
		minheight    = -200,                   -- presence == override, even if 0
		maxheight    =  600,
		smtFileName0 = "My_Map_V1.smt",        -- BARE filename, resolved next to the .smf
		-- smtFileName1 = "...",               -- count must equal the .smf's numTileFiles
		-- minimapTex  = "mymap_minimap.dds",
		-- metalmapTex = "mymap_metal.png",    -- MUST be (mapx/2)x(mapy/2) 8-bit grey
		-- typemapTex  = "mymap_type.png",     -- MUST be (mapx/2)x(mapy/2) 8-bit grey
		-- grassmapTex = "mymap_grass.png",    -- MUST be (mapx/4)x(mapy/4) 8-bit grey
	},

	--== sound ================================================================
	-- NB: `reverb` is parsed but discarded by the engine; passfilter gainlf/gainhf
	--     additionally (and accidentally) set reverb density/diffusion.
	sound = {
		preset = "default",
		passfilter = { gainlf = 1.0, gainhf = 1.0 },
		reverb = {},
	},

	--== override textures ====================================================
	-- All paths are looked up as-is in the VFS first, then under "maps/".
	resources = {
		detailTex   = "detailtexblurred.bmp",   -- fallback: gamedata resources.lua, then bitmaps/detailtex2.bmp
		specularTex = "My_Map_V1_specular.dds", -- MASTER SWITCH for SSMF shading

		-- Detail-normal (DNTS) splatting. splatDetailTex must be a non-empty
		-- string even when unused; a missing file is fine and intended.
		splatDetailTex = "iwantDNTS.tga",
		splatDistrTex  = "My_Map_V1_splatdistr.dds",   -- map-sized RGBA weight mask
		splatDetailNormalDiffuseAlpha = 1,             -- alpha of each DNTS = diffuse
		splatDetailNormalTex1 = "Rock_Brown_1k_dnts.dds",   -- <- splatDistrTex.R
		splatDetailNormalTex2 = "RockyDirt_1k_dnts.dds",    -- <- splatDistrTex.G
		splatDetailNormalTex3 = "GrassThick_1k_dnts.dds",   -- <- splatDistrTex.B
		splatDetailNormalTex4 = "Sand_1k_dnts.dds",         -- <- splatDistrTex.A

		detailNormalTex   = "My_Map_V1_normals.dds", -- map-sized; enables SMF_BLEND_NORMALS
		-- skyReflectModTex  = "",   -- must match specularTex dimensions
		-- lightEmissionTex  = "",
		-- parallaxHeightTex = "",   -- must match specularTex dimensions
		-- grassShadingTex   = "",   -- defaults to the minimap texture
		-- grassBladeTex     = "",   -- NOTE: lives here, not in `grass`
	},

	--== splat tiling / weighting ============================================
	splats = {
		-- 1/scale = elmos per texture repeat. 0.02 == the engine detail-tex default (50 elmos).
		texScales = { 0.010, 0.005, 0.0075, 0.010 },
		texMults  = { 1.20,  0.40,  0.90,   0.25  },  -- R, G, B, A of splatDistrTex
	},

	--== atmosphere ===========================================================
	atmosphere = {
		minWind = 5.0,
		maxWind = 25.0,

		fogStart = 0.1,    -- fraction of the camera far plane
		fogEnd   = 1.0,
		fogColor   = { 0.7, 0.7, 0.8 },
		skyColor   = { 0.1, 0.15, 0.7 },
		sunColor   = { 1.0, 1.0, 1.0 },
		cloudColor = { 1.0, 1.0, 1.0 },
		cloudDensity = 0.5,

		-- skyDir is DEPRECATED and ignored (logs a warning). Use skyAxisAngle.
		skyAxisAngle = { 0.0, 0.0, 1.0, 0.0 },  -- xyz axis, w angle in radians
		skyBox = "",       -- non-empty => CSkyBox; path is ALWAYS prefixed with "maps/"
		-- fluidDensity = 0.3,   -- air density kg/m^3 for drag; rarely touched
	},

	--== engine grass (BAR replaces this with map_grass_gl4) ===================
	grass = {
		bladeWaveScale = 1.0,
		bladeWidth     = 0.32,  -- engine default 0.7
		bladeHeight    = 4.0,   -- engine default 4.5
		bladeAngle     = 1.57,  -- engine default 1.0
		bladeColor     = { 0.59, 0.81, 0.57 },  -- ignored if resources.grassBladeTex is set
		-- maxStrawsPerTurf = 150,
	},

	--== lighting =============================================================
	lighting = {
		sunDir = { 0.8, 1.0, -0.7, 1e9 },  -- xyz normalised; w = "intensity", 1e9 == static sun

		groundAmbientColor  = { 0.40, 0.40, 0.40 },
		groundDiffuseColor  = { 0.90, 0.90, 0.85 },
		groundSpecularColor = { 0.70, 0.70, 0.70 },  -- WATCH THE SPELLING
		groundShadowDensity = 0.85,                  -- clamped to [0,1]

		unitAmbientColor  = { 0.50, 0.50, 0.55 },
		unitDiffuseColor  = { 0.99, 0.99, 0.95 },
		unitSpecularColor = { 0.80, 0.60, 0.60 },    -- defaults to unitDiffuseColor
		unitShadowDensity = 0.90,                    -- clamped to [0,1]

		specularExponent = 100.0,
		-- sunStartAngle / sunOrbitTime / specularSunColor are NOT read by the engine.
	},

	--== water ================================================================
	water = {
		damage = 0,          -- HP per SECOND (engine halves it internally)

		repeatX = 10.0,
		repeatY = 10.0,

		absorb    = { 0.05, 0.005, 0.001 },  -- per-elmo-of-depth absorption
		baseColor = { 0.30, 0.50, 0.50 },
		minColor  = { 0.00, 0.30, 0.30 },

		ambientFactor  = 1.0,
		diffuseFactor  = 1.0,
		specularFactor = 1.4,
		specularPower  = 40.0,

		surfaceColor  = { 0.67, 0.80, 1.00 },
		surfaceAlpha  = 0.02,
		diffuseColor  = { 0.00, 0.00, 0.00 },
		specularColor = { 0.50, 0.50, 0.50 },  -- defaults to lighting.groundDiffuseColor
		-- planeColor = { 0.00, 0.15, 0.15 },  -- WRITING THIS AT ALL ENABLES THE OFF-MAP PLANE

		fresnelMin   = 0.08,
		fresnelMax   = 0.50,
		fresnelPower = 8.0,

		reflectionDistortion = 1.0,
		blurBase     = 2.1,
		blurExponent = 1.5,

		perlinStartFreq  = 8.0,
		perlinLacunarity = 3.0,
		perlinAmplitude  = 0.85,
		windSpeed        = 0.5,

		waveOffsetFactor   = 0.3,
		waveLength         = 0.37,
		waveFoamDistortion = 0.10,
		waveFoamIntensity  = 1.0,

		causticsResolution = 100.0,
		causticsStrength   = 0.16,

		shoreWaves     = true,
		forceRendering = false,

		numTiles      = 4,     -- clamped [1,16]; forced to 4 when normalTexture is empty
		-- texture       = "",  -- undefined => gamedata resources.lua => bitmaps/ocean.jpg
		-- foamTexture   = "",  -- undefined => ... => bitmaps/foam.jpg
		-- normalTexture = "",  -- undefined => ... => bitmaps/waterbump_4tiles.dds (numTiles=4)
		-- caustics = { "caustic00.dds", "caustic01.dds" },  -- 1-based, contiguous, prefix "maps/"
	},

	--== start positions ======================================================
	-- 0-based, CONTIGUOUS integer keys. Only x and z are read (no y).
	-- Only used when the start script sets StartPosType = 0 (fixed) or 1 (random).
	-- BAR ranked play uses maps-metadata startboxes instead.
	teams = {
		[0] = { startPos = { x =  900, z = 7300 } },
		[1] = { startPos = { x = 7300, z =  900 } },
		[2] = { startPos = { x =  900, z =  900 } },
		[3] = { startPos = { x = 7300, z = 7300 } },
	},

	--== terrain types (256 slots, indexed by the typemap byte) ===============
	-- Undeclared slots default to: name "Default", hardness 1, all speeds 1, tracks on.
	terrainTypes = {
		[0] = {
			name = "Ground",
			hardness = 1.0,             -- MULTIPLIES maphardness; clamped to >= 0.001
			receiveTracks = true,
			moveSpeeds = { tank = 1.0, kbot = 1.0, hover = 1.0, ship = 1.0 },
		},
		[1] = {
			name = "Rock",
			hardness = 5.0,
			receiveTracks = false,
			moveSpeeds = { tank = 0.6, kbot = 0.8, hover = 1.0, ship = 1.0 },
		},
		[255] = {
			name = "Roads",
			hardness = 1.0,
			receiveTracks = true,
			moveSpeeds = { tank = 1.25, kbot = 1.25, hover = 1.25, ship = 1.0 },
		},
	},

	--== pathfinder tuning (optional; engine defaults shown) ===================
	-- pfs = {
	-- 	qtpfsConstants = {
	-- 		layersPerUpdate = 5,  maxTeamSearches = 25,
	-- 		minNodeSizeX    = 8,  minNodeSizeZ    = 8,
	-- 		maxNodeDepth    = 16, numSpeedModBins = 10,
	-- 		minSpeedModVal  = 0.0, maxSpeedModVal = 2.0,
	-- 		maxNodesSearched = 0, maxRelativeNodesSearched = 0.0,
	-- 	},
	-- },

	--== game-side passthrough (the ENGINE NEVER READS THIS) ==================
	custom = {
		-- Consumed by BAR's luaui/Widgets/gfx_volumetric_clouds.lua
		clouds = {
			speed           = 0.15,
			color           = { 0.25, 0.32, 0.24 },
			height          = 1200,     -- number, "auto", or "NN%" of max ground height
			bottom          = 30,
			fade_alt        = 30,
			scale           = 1400,
			opacity         = 0.35,
			clamp_to_map    = true,
			sun_penetration = 40,
		},
		-- Consumed by BAR's luaui/Widgets/map_grass_gl4.lua
		grassConfig = {
			grassMinSize = 0.8,
			grassMaxSize = 2.0,
			grassBladeColorTex = "maps/grass_field_dry.dds.cached.dds",
			-- grassDistTGA = "maps/My_Map_V1_grassdist.tga", -- 8-bit TGA, mapSize/patchResolution
			grassShaderParams = {
				MAPCOLORFACTOR = 0.6,
				MAPCOLORBASE   = 1.0,
			},
		},
		-- Legacy: present in every BAR map but NOT consumed by current BAR game code.
		fog = {
			color    = { 0.26, 0.32, 0.41 },
			height   = "80%",
			fogatten = 0.003,
		},
		precipitation = {
			density   = 30000,
			size      = 1.5,
			speed     = 50,
			windscale = 1.2,
			texture   = "LuaGaia/effects/snowflake.png",
		},
	},
}

--------------------------------------------------------------------------------
-- Helper: lowercase every string key, recursively.
-- The engine does this itself, but game-side `VFS.Include("mapinfo.lua")`
-- does not — BAR gadgets read mapinfo.voidwater, mapinfo.custom.grassconfig, ...
--------------------------------------------------------------------------------
local function lowerkeys(ta)
	local fix = {}
	for i, v in pairs(ta) do
		if type(i) == "string" and i ~= i:lower() then
			fix[#fix + 1] = i
		end
		if type(v) == "table" then
			lowerkeys(v)
		end
	end
	for i = 1, #fix do
		local idx = fix[i]
		ta[idx:lower()] = ta[idx]
		ta[idx] = nil
	end
end

lowerkeys(mapinfo)

--------------------------------------------------------------------------------
-- Map options: merge every mapconfig/mapinfo/*.lua (sorted) into `mapinfo`.
-- Those files may mutate the exposed `mapinfo` global directly and/or return a
-- table to be deep-merged. Remember they see LOWERCASED keys.
--------------------------------------------------------------------------------
if (Spring) then
	local function tmerge(t1, t2)
		for i, v in pairs(t2) do
			if type(v) == "table" then
				t1[i] = t1[i] or {}
				tmerge(t1[i], v)
			else
				t1[i] = v
			end
		end
	end

	-- Spring.GetMapOptions does not exist in unitsync / dedicated / AI builds.
	if (not Spring.GetMapOptions) then
		Spring.GetMapOptions = function() return {} end
	end

	function tobool(val)
		local t = type(val)
		if t == "nil" then return false
		elseif t == "boolean" then return val
		elseif t == "number" then return (val ~= 0)
		elseif t == "string" then return ((val ~= "0") and (val ~= "false")) end
		return false
	end

	getfenv()["mapinfo"] = mapinfo
		local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
		table.sort(files)
		for i = 1, #files do
			local newcfg = VFS.Include(files[i])
			if newcfg then
				lowerkeys(newcfg)
				tmerge(mapinfo, newcfg)
			end
		end
	getfenv()["mapinfo"] = nil
end

return mapinfo
```

Companion file, `maphelper/mapinfo.lua` inside the map archive (backwards compatibility with
engines ≤ 0.82, exactly as `map_blueprint` ships it):

```lua
return VFS.Include("mapinfo.lua")
```

---

## 17. Citations

Engine, `github.com/beyond-all-reason/RecoilEngine`, branch `master` (fetched 2026-09-13):

* `rts/Map/MapInfo.h` — struct definitions: `map_t` 62-77, `gui_t` 80-82, `atmosphere_t` 85-98,
  `splats_t` 101-104, `grass_t` 107-115, `light_t` 118-129, `water_t` 133-174, `smf_t` 177-207,
  `pfs_t` 209-225, `TerrainType` 229-239, `NUM_TERRAIN_TYPES` 25.
* `rts/Map/MapInfo.cpp` — `FIND_MAP_TEXTURE` 35-44, ctor/order 48-78, `ReadGlobal` 90-117,
  `ReadGui` 120-125, `ReadAtmosphere` 128-173, `ReadSplats` 176-183, `ReadGrass` 185-200,
  `ReadLight` 202-226, `ReadWater` 229-337, `ParseSplatDetailNormalTexture` 340-351,
  `ReadSMF` 354-429, `ReadTerrainTypes` 432-458, `ReadPFSConstants` 460-480, `ReadSound` 482-543.
* `rts/Map/MapParser.cpp` — file selection 19-37, injected globals 40-53, `GetStartPos` 62-85.
* `rts/System/FileSystem/ArchiveScanner.cpp` — `knownTags` 74-87, `ArchiveData` ctor 129-201,
  `IsReservedKey` 216-218, map-archive classification 742-800, `ScanArchiveLua` 923-941.
* `rts/Lua/LuaParser.cpp` — `lowerKeys`/`lowerCppKeys` 59-60, 83-84; `SetupEnv` 125-196;
  key lowering in `Execute` 283-284; `ParseFloat3/4` 1415-1449; `ParseBoolean` 1452-1475;
  getters 1480-1700.
* `rts/Lua/LuaUtils.cpp` — `LowerKeysReal`/`LowerKeys` 367-441.
* `rts/Map/SMF/SMFReadMap.cpp` — feature detection 68-79, height override 146-161,
  `LoadMinimap` 163-175, `CreateSpecularTex` 195-247, `CreateSplatDetailTextures` 249-330,
  `CreateGrassTex` 332-347, `CreateDetailTex` 349-359, texture reload 780-806,
  `GetInfoMap` 923-970.
* `rts/Map/SMF/SMFReadMap.h` — `NUM_SPLAT_DETAIL_NORMALS = 4` at 183.
* `rts/Map/SMF/SMFRenderState.cpp` — shader flags 113-128, sampler/uniform bindings 149-190.
* `rts/Map/SMF/SMFGroundTextures.cpp` — `smtFileNames` override 121-175.
* `rts/Map/SMF/SMFFormat.h` — `SMFHeader` 48-70, `ExtraHeader` 82-86, `MEH_Vegetation` 100,
  `SMALL_TILE_SIZE` 27, `MINIMAP_NUM_MIPMAP` 30, `MINIMAP_SIZE` 33.
* `rts/Map/SMF/SMFGroundDrawer.cpp` — `voidAlphaMin` 242, 291; void passes 326-330.
* `rts/Map/ReadMap.cpp` — `metalMap.Init` 167, `CalcTypemapChecksum` 478-489, info-map load 158-183.
* `rts/Map/BasicMapDamage.cpp` — `mapHardness` 24, per-type hardness 67-68.
* `rts/Rendering/Env/SunLighting.{h,cpp}` — struct 9-49 / `Init` 56-75.
* `rts/Rendering/Env/WaterRendering.{h,cpp}` — struct 12-60 / `Init` 19-65.
* `rts/Rendering/Env/MapRendering.{h,cpp}` — struct 8-18 / `Init` 19-29.
* `rts/Rendering/Env/ISky.cpp` — fog 56-63, skybox selection 70-82.
* `rts/Rendering/Env/SkyLight.cpp` — 9-30.
* `rts/Lua/LuaUnsyncedCtrl.cpp` — `SetAtmosphere` 4127-4190, `SetSunDirection` 4195-4214,
  `SetSunLighting` 4236-4290, `SetMapRenderingParams` 4293-4345, `SetWaterParams` 4648-4840.
* `rts/Lua/LuaSyncedCtrl.cpp` — `SetTerrainTypeData` 7146-7190.
* `rts/Lua/LuaSyncedRead.cpp` — `GetMapStartPositions` 1609-1630.
* `rts/Lua/LuaConstGame.cpp` — map constants 147-177.
* `rts/Game/GameSetup.cpp` — `LoadStartPositionsFromMap` 249-258, `LoadStartPositions` 260-300.
* `rts/Game/GameSetup.h` — `StartPosType` 171-177.
* `rts/Game/Game.cpp` — `LoadTidal` / `LoadWind` 725-726.
* `rts/Sim/Units/Unit.cpp` — `SlowUpdate` 982-987, `DoWaterDamage` 1215-1229.
* `rts/Sim/MoveTypes/MoveMath/MoveMath.cpp` — terrain speed mods 94-142.
* `rts/Sim/Features/Feature.cpp` — `fluidDensity` drag 603-604.
* `rts/Rendering/Env/Decals/GroundDecalHandler.cpp` — `receiveTracks` 1243-1248.
* `rts/Sim/Misc/GlobalConstants.h` — `SQUARE_SIZE 8` (24), `GAME_SPEED 30` (52),
  `UNIT_SLOWUPDATE_RATE 15` (60), `MAX_TEAMS 255` (77).
* `rts/System/FileSystem/VFSModes.h` — 6-20.
* `rts/System/Sound/OpenAL/EFXPresets.cpp` — presets 14-157, param tables 159-221.
* `rts/System/float4.h` — 13-52.
* `rts/Map/Generation/BlankMapGenerator.cpp` — template substitution 245-280.
* `cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl` — `SMF_DETAILTEX_RES` 25,
  splat uniforms 80-95, classic splat 154-171, DNTS splat 173-198, parallax 262-292,
  normal blend 310-330, specular 405.
* `cont/base/maphelper/maphelper/mapinfo.lua` — 1-106.
* `cont/base/maphelper/maphelper/mapdefaults.lua` — 16-127.
* `cont/base/maphelper/maphelper/parse_tdf_map.lua` — 31-223.
* `cont/base/maphelper/maphelper/applyopts.lua` — 24-190.
* `cont/base/springcontent/mapgenerator/mapinfo_template.lua`.
* `cont/base/springcontent/gamedata/resources.lua` — default caustics list.

Game / ecosystem:

* `github.com/beyond-all-reason/map_blueprint` — `mapinfo.lua` (360 lines, the canonical BAR map
  template), `mapconfig/mapinfo/0_apply_options.lua`, `mapoptions.lua`,
  `maphelper/mapinfo.lua`, `mapconfig/featureplacer/config.lua`.
* `github.com/beyond-all-reason/MapOrbitalStation` — `mapinfo.lua` (a shipped metal map:
  `voidWater = true`, `maxMetal = 100`, `extractorRadius = 2.0`, 8 terrain types).
* `github.com/lhog/Quicksilver-Remake` — `mapinfo.lua` (BAR-certified team map).
* `github.com/lhog/enceladus_1a.sdd` — `mapinfo.lua` (uses `smf.minimapTex` + `smf.typemapTex`
  overrides and a `custom.pbr` block).
* `github.com/lhog/spring-map-pbr` — `mapinfo.lua` (PBR shader `custom` schema).
* `github.com/beyond-all-reason/Beyond-All-Reason` —
  `mapgenerator/mapinfo_template.lua`; `gamedata/resources.lua:1-131`;
  `luarules/gadgets/map_voidground.lua:19-29`; `luarules/gadgets/unit_sunfacing.lua:39-42`;
  `luarules/gadgets/map_metal_spot_placer.lua:24-32`; `modules/lava.lua:1-115`;
  `luaui/Widgets/gfx_volumetric_clouds.lua:27-70`; `luaui/Widgets/map_grass_gl4.lua:44-215`;
  `luaui/Widgets/gfx_deferred_rendering_GL4.lua:2479-2500`; `luaui/Widgets/gui_mapinfo.lua:56,148`.
* `github.com/beyond-all-reason/maps-metadata` — `schemas/map_list.yaml`
  (`startboxesSet`, `startboxRect` 0–200 space, `startboxPolygon`, `startPos`, `terrainType` enum).
* `github.com/beyond-all-reason/map-parser` — `src/map-parser.ts:421-476` (static luaparse
  extraction), `src/map-model.ts` (the `MapInfo` TypeScript model BAR tooling expects).
* `github.com/spring/spring` — `rts/Map/MapInfo.cpp` (upstream, confirms `resources`-only texture
  parsing is not a Recoil divergence).
