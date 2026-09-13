# Open-Source Prior Art: Terrain Editors & Node Graph Engines

> **Purpose.** Terrasmith is MIT-licensed. This document surveys the open-source work we can
> legally reuse, the work we may only read, and the work we must stay away from. Every licence
> claim below was verified against the repository's own `LICENSE` file or the GitHub licence API
> during this survey (2026-09-13), not recalled. Every non-obvious technical claim carries an
> inline citation of the form `repo :: path : line`.
>
> **Status: adversarially fact-checked 2026-09-13.** An independent pass re-fetched the primary
> sources for every load-bearing claim. See **§11 Verification log** for the per-claim table:
> **45 claims checked — 21 confirmed exactly as written, 20 corrected (most of those are line-
> number fixes over a correct underlying fact), 13 with material gaps filled, 2 of the
> researcher's open questions resolved, 2 items left explicitly UNVERIFIED.** The corrections were:
> one **wrong licence** (`Zylann/godot_heightmap_plugin` is MIT, not GPL), **five wrong
> line-number citations in the SMF struct section** (§7.2 — the struct layouts themselves were all
> correct), a **wrong function citation** in §5.1, **eleven blank cells** in the Material Maker
> port-type table that are not in fact blank, and **byte counts in §8.2 that could not be
> reproduced from the cited endpoint** (replaced with measured ones). Two of the
> researcher's open questions (the WhiteboxTools licence chain; bundle-vs-download for the
> material library) are now **resolved** — §6.2 and §8.4.
>
> **How to read this.** §1 is the licence rulebook — read it once and internalise it. §2–§8 are
> the surveys, each entry ending in a one-word **VERDICT**. §4 is the one section that is not a
> survey: it is a *design* section that synthesises the best node-graph execution architecture
> from the sources in §3 into something Terrasmith can implement directly. §9 is the master table.
> **§11 is the verification log** — read it before trusting any single line citation in §7, and
> read §1.2a before acting on any licence badge.
>
> **Companion documents.** `docs/research/terrain-algos.md` already specifies the erosion, noise
> and hydrology *algorithms* at implementation grade; this document deliberately does not repeat
> them, and instead tells you which repository is the trustworthy provenance for each and whether
> its licence lets you copy it. `docs/research/smf-format.md` and `smt-format.md` specify the
> binary formats; §7 here covers the third-party *implementations* of those formats that we can
> use as cross-check oracles.

---

## 0. Executive summary

The ten findings that change what we build:

1. **pymapconv is CC0-1.0.** `Beherith/springrts_smf_compiler/LICENSE` is the full CC0 1.0
   Universal text. This is a public-domain dedication: we may port its logic into MIT code with
   no obligation whatsoever, and — more importantly — we may use its output as a byte-for-byte
   oracle in our test suite without any licence entanglement. This is the single most valuable
   licence fact in this document. (§7.1)
2. **Gaffer (BSD-3-Clause) is the architecture to copy for the graph engine.** It solves exactly
   our problem — a node graph where "change one parameter, only recompute downstream, at the
   requested resolution" — with a two-tier cache (hash cache keyed on `(plug, contextHash,
   dirtyCount)`; compute cache keyed on the resulting hash) and a `Context` object that carries
   evaluation parameters like resolution *out of band* through the graph. Permissive licence,
   20+ years of production hardening at Image Engine. (§3.1, §4)
3. **The single best "preview vs final" mechanism in open source is Gaffer's `Context`.** The
   evaluation resolution is not a node parameter — it is an ambient, hashed context value that
   every node's hash includes. That makes preview and build results *different cache entries of
   the same graph*, which is precisely the property `docs/ARCHITECTURE.md` demands. (§4.3)
4. **`weigert/SimpleHydrology` has no licence file at all.** GitHub's licence API returns 404 for
   it, for `weigert/SimpleErosion`, and for `Huw-man/Interactive-Erosion-Simulator-on-GPU`. No
   licence means *all rights reserved*. Read the accompanying blog posts; do not copy the code.
   (§5.4)
5. **RichDEM, TauDEM, pysheds and fastscapelib are all GPL-3.0.** Every one of the "obvious"
   hydrology libraries is copyleft. The permissive alternatives are **WhiteboxTools (MIT)** and
   **Landlab (MIT)**. (§6)
6. **WhiteboxTools already ships as WASM on npm** (`geolibre-wasm`, MIT, v1.5.2 — re-verified via
   `npm view`, 2026-09-13). Depression filling, flow accumulation and stream extraction can run in
   the browser today without us writing them — as a validation oracle at minimum. **Its whole
   licence chain is now verified clean** (legacy MIT → `whitebox_next_gen` *MIT OR Apache-2.0* →
   `whitebox-wasm` Apache-2.0 → `geolibre-wasm` MIT); the `NOASSERTION` badge on
   `whitebox_next_gen` is a detection artefact of its two licence files, not an ambiguity.
   (§1.2a, §6.2)
7. **Material Maker (MIT) is the best-designed OSS node tool we found**, and its two transferable
   ideas are (a) nodes emit *shader source*, not pixels, so a chain of ten nodes fuses into one
   dispatch, with explicit `Buffer` nodes as the only materialisation points, and (b) a buffer
   state machine with an `UpdatingInvalidated` state that correctly handles "the user moved the
   slider while the render was in flight". (§3.3)
8. **MaterialX (Apache-2.0) is the schema to copy for the node catalog.** `uifolder`, `uiname`,
   `uimin`/`uimax`/`uisoftmin`/`uisoftmax`/`uistep`, `uiadvanced`, `enum`/`enumvalues`,
   `unittype`/`unit`, `version`/`isdefaultversion`/`inherit` — every field Terrasmith needs for
   guided mode, unit-correct elmo parameters, and node migration already exists there, specified.
   (§3.6)
9. **Erosion: the permissive lineage is Beyer → Lague → erodr.** `SebLague/Hydraulic-Erosion`
   (MIT), `henrikglass/erodr` (MIT) and `dandrino/terrain-erosion-3-ways` (MIT) between them give
   us a droplet implementation, a pipe-model implementation, and a river-network-first
   implementation, all portable. `dandrino`'s `river_network.py` is the most under-appreciated:
   it produces convincing dendritic drainage *without* a simulation, which is exactly what a
   live preview needs. (§5.1–§5.3)
10. **A complete CC0 default material library is available today.** ambientCG has **2,010
    CC0 materials** (168 matching "Ground", 113 "Dirt", 83 "Sand", 76 "Rock", 66 "Gravel", 52
    "Cliff", 49 "Moss", 28 "Snow", 15 "Grass"); Poly Haven has **859 CC0 textures** of which
    **129 are tagged `terrain`**, 124 `rock`, 60 `sand`. Both have public JSON APIs. We can ship
    a beginner-friendly material library with zero licence risk. (§8)

### 0.1 One-line verdicts

| # | Project | Licence | Verdict |
|---|---|---|---|
| 1 | [GafferHQ/gaffer](https://github.com/GafferHQ/gaffer) | BSD-3-Clause | **read for architecture** (and we *may* copy) |
| 2 | [RodZill4/material-maker](https://github.com/RodZill4/material-maker) | MIT | **read for architecture** |
| 3 | [AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) | Apache-2.0 | **use directly** (schema) |
| 4 | [milomg/reactively](https://github.com/milomg/reactively) | MIT | **port the algorithm** |
| 5 | [blender/blender](https://github.com/blender/blender) geometry nodes | **GPL-2.0-or-later** | **read for architecture only — never copy** |
| 6 | [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) | **GPL-3.0** | **read for architecture only — never copy** |
| 7 | [Jaysmito101/TerraForge3D](https://github.com/Jaysmito101/TerraForge3D) | MIT | **read for architecture** |
| 8 | [alelievr/NodeGraphProcessor](https://github.com/alelievr/NodeGraphProcessor) | MIT | **read for architecture** |
| 9 | MapMagic 2 (Unity) | Unity Asset Store EULA | **avoid (licence)** |
| 10 | [SebLague/Hydraulic-Erosion](https://github.com/SebLague/Hydraulic-Erosion) | MIT | **port the algorithm** |
| 11 | [dandrino/terrain-erosion-3-ways](https://github.com/dandrino/terrain-erosion-3-ways) | MIT | **port the algorithm** |
| 12 | [henrikglass/erodr](https://github.com/henrikglass/erodr) | MIT | **port the algorithm** |
| 13 | [weigert/SimpleHydrology](https://github.com/weigert/SimpleHydrology) | **NONE (all rights reserved)** | **avoid (licence)** — read the blog, not the code |
| 14 | [Huw-man/Interactive-Erosion-Simulator-on-GPU](https://github.com/Huw-man/Interactive-Erosion-Simulator-on-GPU) | **NONE** | **avoid (licence)** |
| 15 | [bshishov/UnityTerrainErosionGPU](https://github.com/bshishov/UnityTerrainErosionGPU) | MIT | **port the algorithm** |
| 16 | [ozikazina/Hydra](https://github.com/ozikazina/Hydra) | MIT | **port the algorithm** |
| 17 | [r-barnes/richdem](https://github.com/r-barnes/richdem) | **GPL-3.0** | **avoid (licence)** — read papers instead |
| 18 | [dtarb/TauDEM](https://github.com/dtarb/TauDEM) | **GPL-3.0** | **avoid (licence)** |
| 19 | [pysheds/pysheds](https://github.com/pysheds/pysheds), [fastscapelib](https://github.com/fastscape-lem/fastscapelib) | **GPL-3.0** | **avoid (licence)** |
| 20 | [jblindsay/whitebox-tools](https://github.com/jblindsay/whitebox-tools) | MIT | **port the algorithm** |
| 21 | `geolibre-wasm` (npm) | MIT | **use directly** (as validation oracle) |
| 22 | [landlab/landlab](https://github.com/landlab/landlab) | MIT | **port the algorithm** |
| 23 | [Beherith/springrts_smf_compiler](https://github.com/Beherith/springrts_smf_compiler) (pymapconv) | **CC0-1.0** | **use directly** (as oracle; code portable too) |
| 24 | [enetheru/smf_tools](https://github.com/enetheru/smf_tools) | NONE declared | **avoid (licence)** — use as a runtime oracle only |
| 25 | [Spring-SpringBoard/SpringBoard-Core](https://github.com/Spring-SpringBoard/SpringBoard-Core) | MIT | **read for architecture** |
| 26 | [beyond-all-reason/RecoilEngine](https://github.com/beyond-all-reason/RecoilEngine) | **GPL-2.0-or-later** | **read for facts only — never copy** |
| 27 | ambientCG | **CC0-1.0** | **use directly** |
| 28 | Poly Haven | **CC0-1.0** | **use directly** |
| 29 | [KdotJPG/OpenSimplex2](https://github.com/KdotJPG/OpenSimplex2) | **CC0-1.0** | **port the algorithm** (no obligation) |
| 30 | [Auburn/FastNoiseLite](https://github.com/Auburn/FastNoiseLite) | MIT | **port the algorithm** |
| 31 | [xyflow/xyflow](https://github.com/xyflow/xyflow) (React Flow) | MIT | **use directly** (editor UI) |

---

## 1. Licence rules for an MIT project

This section exists because the most expensive mistake available to us is copying twenty lines
from the wrong repository. Read it once.

### 1.1 The compatibility table

| Licence of source | May we copy code into Terrasmith? | May we link/depend at runtime? | May we read it and reimplement? |
|---|---|---|---|
| **Public domain / CC0 / Unlicense** | **Yes**, no obligation at all | Yes | Yes |
| **MIT / BSD-2 / BSD-3 / ISC** | **Yes**, keep the copyright + licence notice | Yes | Yes |
| **Apache-2.0** | **Yes**, keep notice + `NOTICE` file, patent grant applies | Yes | Yes |
| **MPL-2.0** | Only in separate files that stay MPL (file-level copyleft) | Yes | Yes |
| **LGPL-2.1 / LGPL-3** | **No** (statically; dynamic linking has conditions we do not want in a browser bundle) | Risky — avoid | Yes |
| **GPL-2.0 / GPL-3.0 / AGPL-3.0** | **NO — this would relicense Terrasmith** | No | **Yes, with care** (see §1.3) |
| **No licence file** | **NO — all rights reserved by default** | No | Yes, with care |
| **Unity Asset Store EULA / other EULA** | **No**, and usage is restricted to Unity projects | No | Reading is legally grey — prefer public docs |

### 1.2 The specific GPL/AGPL items in this survey — flagged explicitly

Copying any of these into Terrasmith would require Terrasmith to become GPL. **Do not.**

- `blender/blender` — **GPL-2.0-or-later**. The geometry-nodes evaluator header we cite carries
  `SPDX-License-Identifier: GPL-2.0-or-later`
  (`blender :: source/blender/functions/FN_lazy_function.hh : 3`). *Read for architecture only.*
- `comfyanonymous/ComfyUI` — **GPL-3.0**. Its execution/caching design is instructive; the code
  is off-limits. (Its frontend fork `Comfy-Org/litegraph.js` is MIT but **archived**.)
- `beyond-all-reason/RecoilEngine` — the map code is **GPL v2 or later**
  (`RecoilEngine :: rts/Map/SMF/SMFFormat.h : 1` — "/* This file is part of the Spring engine
  (GPL v2 or later), see LICENSE.html */", verified verbatim 2026-09-13). Note that
  `gh api repos/beyond-all-reason/RecoilEngine --jq .license.spdx_id` returns **`NOASSERTION`**,
  not `GPL-2.0` — because the root `LICENSE` is a Markdown document with a third-party appendix.
  Its text is unambiguous (`LICENSE : 5-8`): "Spring is free software: you can redistribute it
  and/or modify it under the terms of the GNU General Public License … either version 2 of the
  License, or (at your option) any later version." We read it for *facts about a file format*, which are not copyrightable
  subject matter; we never transcribe its code. Our `packages/format` is an independent
  implementation and must stay one.
- `r-barnes/richdem` — **GPL-3.0**.
- `dtarb/TauDEM` — **GPL-3.0**. `TauDEM :: license.txt : 3-5` states GPL v3 ("under the terms of
  the GNU General Public License version 3, 2007 as published by the Free Software Foundation"),
  with an explicit multi-licensing offer at `: 16-20`: *"TauDEM may also be available under alternative licenses (multi
  licensing model) ... If you wish to use or incorporate this program (or parts of it) into
  other software that does not meet the GNU General Public License conditions contact the author
  to discuss a licensing agreement."* GitHub reports `NOASSERTION` because of this dual note;
  the default grant is GPL-3.0. (Copyright line: "Copyright (C) 2014  David Tarboton, Utah State
  University", `license.txt : 1`.)
- `pysheds/pysheds` — **GPL-3.0**.
- `fastscape-lem/fastscapelib` — **GPL-3.0**.
- `NatronGitHub/Natron` — **GPL-2.0**.
- `Poly-Haven/polyhavenassets` (Blender add-on) — **GPL-3.0**; `Poly-Haven/Public-API` —
  **AGPL-3.0**. Note carefully: **their tooling is copyleft, their assets are CC0.** We want the
  assets, not the tooling. Do not vendor their API server code.
- `aidan-clyens/TerrainGenerator` (GPL-3.0, 141★), `guydols/HydraulicErosion` (GPL-3.0),
  `sasha-agafonov/hydraulic-erosion` (GPL-3.0), `fletchgraham/terrain` (GPL-3.0),
  `CosmoMyzrailGorynych/FilterJS` (GPL-3.0) — all GPL-family. Listed here so nobody reaches for
  them by accident. *(Each verified individually via `gh api repos/<r> --jq .license.spdx_id`,
  2026-09-13.)*
- **CORRECTION (2026-09-13 fact-check): `Zylann/godot_heightmap_plugin` is NOT GPL — it is MIT.**
  An earlier draft of this document listed it with the GPL-family repos. GitHub's licence API
  reports `NOASSERTION` for it, but that is only because its `LICENSE.md` opens with a title line
  ("HeightMap terrain for Godot Engine / Copyright (c) 2016-2020 Marc Gilleron") before the
  verbatim MIT grant — the body is unmodified MIT
  (`raw.githubusercontent.com/Zylann/godot_heightmap_plugin/master/LICENSE.md : 1-8`). It is
  therefore usable, and its Godot terrain LOD/chunking code is legitimate prior art if we want it.
  **This is the standing lesson of §1.5: never trust a `NOASSERTION` badge in either direction.**
- `Kry-a/Hydraulic-Erosion` — **LGPL-2.1**. Also avoid.

### 1.2a NOASSERTION is not a licence status — read the file

GitHub's licence API returns `NOASSERTION` whenever `licensee` cannot match the licence file
byte-for-byte against a known template. In this survey that happened for **six** repositories. For
the four whose licence files were actually read, the licence turned out to be definite **every
time** — and in two of those four it was *permissive*, i.e. the badge was hiding usable code:

| Repo | API says | Actually is | Why the API is confused |
|---|---|---|---|
| `beyond-all-reason/RecoilEngine` | `NOASSERTION` | **GPL-2.0-or-later** | Root `LICENSE` is a Markdown doc: *"Spring is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License … either version 2 of the License, or (at your option) any later version"* (`LICENSE : 5-8`) followed by a long third-party section |
| `dtarb/TauDEM` | `NOASSERTION` | **GPL-3.0** + paid alt-licence offer | `license.txt : 3-5` GPL v3; `: 16-20` the multi-licensing note |
| `jblindsay/whitebox_next_gen` | `NOASSERTION` | **MIT OR Apache-2.0** | Two licence files (`LICENSE-MIT`, `LICENSE-APACHE`); `Cargo.toml : 22` declares `license = "MIT OR Apache-2.0"` — the standard Rust dual-licence convention |
| `Zylann/godot_heightmap_plugin` | `NOASSERTION` | **MIT** | Title line prepended to the MIT text |
| `dizzy2003/TextureWangBeta` | `NOASSERTION` | **unresolved** | Licence file not read this pass; still **avoid** |
| `SpliFF/upspring` | `NOASSERTION` | **unresolved** | Licence file not read this pass; still **avoid** |

Procedure: `NOASSERTION` ⇒ fetch the raw licence file(s) *and* any package manifest
(`Cargo.toml`, `package.json`, `setup.py`) and read them. Do not downgrade a repo to "avoid" on
the badge alone, and do not upgrade one either.

### 1.3 Rule for reading GPL code

Reading GPL source to learn *how a technique works* and then writing your own implementation is
legal and normal — ideas and algorithms are not protected by copyright, only their expression is.
But the safe procedure, and the one we follow, is:

1. Prefer a **paper, blog post, or specification** over the GPL source whenever one exists.
   (`terrain-algos.md` already cites those papers.)
2. If you do read GPL source, write the implementation from **notes about behaviour**, not from a
   line-by-line translation. Do not keep variable names, comment text, or code structure.
3. **Never** paste GPL code into a Terrasmith file "to adapt later". It will survive.
4. Record in the commit message that the implementation is independent.

### 1.4 A note on "no licence"

`weigert/SimpleHydrology`, `weigert/SimpleErosion`, `Huw-man/Interactive-Erosion-Simulator-on-GPU`
and `enetheru/smf_tools` have **no `LICENSE` file**. Verified 2026-09-13: `gh api
repos/<r>/license` returns 404 for each, and the repository root listings contain no licence file.
(`enetheru/smf_tools` is additionally **archived** — `gh api repos/enetheru/smf_tools --jq
.archived` → `true` — so no licence will ever be added.) Under the Berne
Convention this means the author retains all rights and has granted none. GitHub's own Terms of
Service grant only the right to view and fork *within GitHub*. Treat these as closed source.

---

## 2. Node-based terrain and procedural tools

### 2.1 Jaysmito101/TerraForge3D

| | |
|---|---|
| Repo | https://github.com/Jaysmito101/TerraForge3D |
| Language | C++ (OpenGL, Dear ImGui) |
| Licence | **MIT** |
| Maturity | 1,227★, created 2021-09-12, last push **2026-08-29** — actively maintained |

The closest thing to an open-source Gaea/World Machine. It is a real desktop application, not a
demo: node editor, biome system, GPU generation, DEM import, texture store, exporters.

**What it does well.** Its source tree reads like a specification of what a terrain tool needs:

```
TerraForge3D/src/          <- repo-relative; the repo root has an inner TerraForge3D/ dir
  Base/           Application, NodeEditor/, Logging/, Heightmap, AsyncTextureReadback,
                  ImGuiCurveEditor, ImGuiShapes, FrameBuffer, ShaderStorageBuffer,
                  Texture2D, Texture2DStorage, TextureCubemap, TextureLoader, Shader,
                  Camera, Mesh, Model, ModelImporter, Renderer, Window, EventManager,
                  ExportTexture, SplashScreen, UIFontManager
  Generators/     BaseNoiseGenerator, BiomeManager, BiomeMixer, SimpleBiomeMixer,
                  BiomeBaseShapeGenerator, BiomeCustomBaseShape, DEMBaseShapeGenerator,
                  SlopeGenerator, GenerationManager, GenerationWorker, GeneratorData,
                  GeneratorDataStatistics, GeneratorTexture,
                  HeightfieldPyramid, HeightfieldRayQuery, Filters/, Masks/, DEM/
  Data/  Exporters/  Inspector/  Job/  MCP/  Menu/  Misc/  Renderer/  TextureStore/
  UI/  Utils/   + Main.cpp, Profiler.cpp, TerraForge3D.rc
```
*(Listing verified 2026-09-13 via `gh api repos/Jaysmito101/TerraForge3D/contents/TerraForge3D/src`
and `…/src/Base`, `…/src/Generators`. `Data/`, `Menu/` and `Misc/` were missing from an earlier
draft of this tree.)*

Four names in that list are directly load-bearing for us:

- **`HeightfieldPyramid`** — a mip pyramid over the heightfield. This is the mechanism that makes
  a viewport responsive on a big field and is also how a ray query gets fast.
- **`HeightfieldRayQuery`** — ray-vs-heightfield, i.e. "what height is under the cursor". We need
  exactly this for the gameplay overlays.
- **`AsyncTextureReadback`** — non-blocking GPU→CPU readback. This is the piece people get wrong
  and then wonder why their editor stutters; in WebGPU the equivalent is
  `mapAsync` on a staging buffer, and it must never be awaited on the frame path.
- **`GenerationWorker` / `GenerationManager`** — the split between "who owns the schedule" and
  "who does the work", which is the same split `packages/graph` needs between the evaluator and
  the worker pool.
- **`ImGuiCurveEditor`** — a curve widget. Every terrain tool needs one (remap curves, gradient
  ramps). Worth reading before writing ours.

**What to steal.** The module decomposition, the heightfield pyramid, the async readback
discipline, and the observation that *biome mixing deserves to be its own subsystem* rather than
a node. Also note it vendors **`tinyerode`** (MIT) rather than writing erosion from scratch —
see `TerraForge3D :: Third Party License/tinyerode.md` (confirmed present 2026-09-13; the
`Third Party License/` directory also carries `imgui-node-editor.md`, `imnodes.md`,
`glsl-optimizer.md`, `delaunator.md`, `muparser.md`, `lua.md`, `wren.md` and others — a useful
checklist of what a desktop terrain tool ends up vendoring).

**What to avoid.** It is an immediate-mode-GUI C++ desktop app; almost none of its UI or
threading translates to a browser. Its node editor is `imgui-node-editor`/`imnodes`, which has no
web equivalent. Do not try to mirror its class layout in TypeScript.

**VERDICT: read for architecture.**

---

### 2.2 RodZill4/material-maker

| | |
|---|---|
| Repo | https://github.com/RodZill4/material-maker |
| Language | GDScript (Godot 4) |
| Licence | **MIT** |
| Maturity | 5,914★, created 2018-07-22, last push **2026-08-06** — the most mature OSS node tool in this survey |

A Substance-Designer-class procedural texture authoring tool. Ten years of design refinement on
exactly the UX problem we have: a node graph that a non-programmer can use.

This is the single most instructive repository in §2. Three of its design decisions are worth
lifting wholesale.

#### 2.2.1 Nodes emit shader source, not pixels

`MMGenBase` (`addons/material_maker/engine/nodes/gen_base.gd`, 772 lines) is built around
`ShaderCode` objects, not images. Its API is a code generator:

```
gen_base.gd : 226  static func get_default_generated_shader() -> ShaderCode
gen_base.gd : 146  func add_global(new_global: String, source: String, index: int = -1) -> void
gen_base.gd : 155  func add_globals(new_globals: Array[GlobalDefs]) -> void
gen_base.gd : 181  func add_uniform(n: String, t: String, v, s: int = 0) -> void
gen_base.gd : 187  func add_uniforms(uniform_list: Array[ShaderUniform]) -> void
gen_base.gd : 191  func uniforms_as_strings(keyword := "uniform", initialize_vectors := false,
                                            texture_hints := false) -> String
gen_base.gd : 482  func get_input_shader(input_index: int) -> ShaderCode
```
*(Signatures and line numbers read from the raw file 2026-09-13; the file is 772 lines. Note that
`add_global`/`add_uniform` are methods on the nested `ShaderCode` class, not on `MMGenBase`
itself — only `get_input_shader` and `set_parameter` are generator-level.)*

The consequence: a chain of ten filter nodes **fuses into one shader** and costs one dispatch,
not ten. Materialisation to an actual texture happens only where the user places a **Buffer**
node (`gen_buffer.gd`), or where the graph needs a genuine ping-pong (`gen_iterate_buffer.gd`).

For Terrasmith this maps onto the WebGPU path almost exactly: a run of pure per-texel nodes
(noise, math, remap, blend, selectors) should be compiled into one WGSL kernel, and only
neighbourhood/iterative nodes (blur, erosion, flow accumulation, occlusion) force a
materialised `Field`. **Design the node interface so a node can declare "I am fusable, here is my
WGSL expression" or "I am a kernel, here is my dispatch".**

#### 2.2.2 Typed ports with declared implicit conversions

`addons/material_maker/nodes/io_types.mmt` is a flat JSON list of port types. Each entry declares
its GLSL type, its call signature, a "slot type" used for connection legality, a colour for the
UI, and — the good part — an explicit list of **conversion expressions** to other types:

*(Table re-read from the raw file 2026-09-13. An earlier draft left six `paramdefs` and five
`color` cells blank; every entry except `any` has both. The file is JSON-with-trailing-commas, so
`json.load` rejects it — Godot's parser is lenient. It carries a `params` field as well, which is
the argument list passed at the call site, matching `paramdefs`.)*

| `name` | `label` | GLSL `type` | `paramdefs` | `params` | `slot_type` | Converts to (expression) | colour |
|---|---|---|---|---|---|---|---|
| `f` | Grayscale | `float` | `vec2 uv` | `uv` | 0 | `rgb`: `vec3($(value))` · `rgba`: `vec4(vec3($(value)), 1.0)` | `#8D8D8D` |
| `rgb` | Color | `vec3` | `vec2 uv` | `uv` | 0 | `f`: `(dot($(value), vec3(1.0))/3.0)` · `rgba`: `vec4($(value), 1.0)` | `#33A3C7` |
| `rgba` | RGBA | `vec4` | `vec2 uv` | `uv` | 0 | `f`: `(dot(($(value)).rgb, vec3(1.0))/3.0)` · `rgb`: `(($(value)).rgb)` | `#335DC7` |
| `sdf2d` | SDF2D | `float` | `vec2 uv` | `uv` | 1 | — (none) | `#E8A31D` |
| `sdf3d` | SDF3D | `float` | `vec3 p` | `p` | 2 | `sdf3dc`: `vec2($(value), 0.0)` | `#EB6135` |
| `sdf3dc` | SDF3D-C | `vec2` | `vec3 p` | `p` | 2 | `sdf3d`: `($(value)).x` | `#DF2626` |
| `tex3d_gs` | Grayscale TEX3D | `float` | `vec4 p` | `p` | 3 | `tex3d`: `vec3($(value))` | `#A734DD` |
| `tex3d` | TEX3D | `vec3` | `vec4 p` | `p` | 3 | `tex3d_gs`: `(dot($(value), vec3(1.0))/3.0)` | `#E739D5` |
| `v4v4` | `V4->V4` | `vec4` | `vec4 p` | `p` | 4 | — (none) | `#B79074` |
| `fill` | Fill | `vec4` | `vec2 uv` | `uv` | 5 | — (none) | `#2DB76C` |
| `any` | *(none)* | *(none)* | *(none)* | *(none)* | **42** | (wildcard) | `#DEDEDE` |

Three things to take from this:

- **Conversions are data, not code.** Adding a type does not mean editing a converter switch.
- **`slot_type` gates connectability separately from the GLSL type.** `f`, `rgb` and `rgba` are
  all `slot_type: 0` and interconvert freely; `sdf2d` is `slot_type: 1` and does *not* silently
  become a greyscale image, even though both are `float`. That distinction is exactly what stops
  beginners from wiring nonsense. Terrasmith's `Field` is deliberately one structure — but the
  *semantic* type (height in elmos / mask 0..1 / slope in degrees / flow accumulation) should be
  a `slot_type`-style tag that drives connection legality, default colour-mapping in the preview,
  and the units shown in the inspector.
- **Port colour is part of the type definition**, so the UI stays consistent for free.

#### 2.2.3 The buffer state machine — how to be correct under cancellation

`addons/material_maker/engine/dependencies.gd` (267 lines) is the dirty-propagation manager. Its
`Buffer` class has exactly five states:

```gdscript
# material-maker :: addons/material_maker/engine/dependencies.gd : 6-23  (verbatim; comments added)
class Buffer:
	enum {
		Invalidated,          # needs recompute
		Updating,             # recompute in flight
		UpdatingInvalidated,  # recompute in flight, inputs changed again since it started
		Updated,              # clean
		Error
	}

	var name : String
	var object : Object
	var dependencies : Array
	var pending_dependencies : int
	var status : int
	var renders : int
	var shader_generations : int

	const STATUS = ["Invalidated","Updating","UpdatingInvalidated","Updated","Error"]
```

Note the initial value: `_init()` sets `status = Updated` (`dependencies.gd : 30`), i.e. a freshly
constructed buffer is *clean*, not invalidated — it becomes `Invalidated` only when something
marks it so. Terrasmith should do the opposite (a new node starts `Invalidated`), because our
value cache is content-keyed and a never-evaluated node has no cached field to be clean about.

`UpdatingInvalidated` is the state most hand-rolled graph engines forget. It is the answer to
"the user dragged the slider while the previous preview was still rendering". Without it you
either (a) show a stale result forever, or (b) cancel and restart on every mouse-move event and
never converge. With it, the in-flight render is allowed to finish (or be cancelled cheaply) and
the buffer immediately re-enters `Invalidated` so exactly one more render is scheduled.

`packages/graph` should have the same five states per node, and `ARCHITECTURE.md`'s
"evaluation is async and cancellable throughout" is precisely this requirement.

**What to avoid.** GDScript's dynamic typing shows: `gen_base.gd` has a 77-line
`set_parameter()` with repeated near-identical branches (`gen_base.gd : 362-438` — the range is
right, the "100 lines" in an earlier draft was not). Do not
replicate the parameter-change plumbing shape; do replicate its semantics.

**VERDICT: read for architecture.** (MIT, so we *could* copy — but there is nothing to copy
across the GDScript/TypeScript gap; the value is entirely in the design.)

---

### 2.3 alelievr/Procedural-Worlds-Editor and alelievr/NodeGraphProcessor

| | |
|---|---|
| Repos | https://github.com/alelievr/Procedural-Worlds-Editor · https://github.com/alelievr/NodeGraphProcessor |
| Language | C# (Unity) |
| Licence | **MIT** (both) |
| Maturity | PWE: 286★, **abandoned** (last push 2018-09-15). NGP: 2,694★, last push 2025-09-22 |

`Procedural-Worlds-Editor` is a node-based procedural terrain generator for Unity, and the
author's follow-up `NodeGraphProcessor` is the generalised, still-maintained graph framework
extracted from it. NGP is explicitly "focused on data processing".

**What to steal from NodeGraphProcessor.** Its central idea is that the graph is compiled once
into a **linear processing order** (a topologically sorted list of node `Process()` calls) that is
then executed repeatedly with no traversal cost. That is the right answer for the *build* path,
where the whole graph will run anyway and the per-node cache-lookup overhead is pure waste. It is
the wrong answer for the *preview* path, where the whole point is to skip work. Terrasmith should
have both: a pull-based memoised evaluator for preview (§4) and a compiled schedule for build.

Also worth reading: NGP's relay/reroute nodes, its port-vector support (one port carrying a list),
and its `[CustomPortBehavior]` mechanism for nodes whose port set depends on parameters — which
we will need for things like a Blend node with a variable number of layers.

**What to avoid.** PWE is abandoned and Unity-specific; its biome/partition-graph model was never
finished. Both depend on Unity's `UIElements`, which is not portable.

**VERDICT: read for architecture.**

---

### 2.4 MapMagic 2 (Unity) — the licence trap

| | |
|---|---|
| Home | https://assetstore.unity.com/packages/tools/terrain/mapmagic-2-165180 · source repo https://gitlab.com/denispahunov/mapmagic |
| Language | C# (Unity) |
| Licence | **Unity Asset Store EULA** — free of charge, source included, **not open source** |
| Maturity | Actively maintained, commercially supported |

MapMagic 2 is frequently described online as "open source" because it is free and ships with full
C# source. It is not. The Standard Unity Asset Store EULA grants a licence to use the asset *in
Unity projects*; it does not grant redistribution, modification-and-redistribution, or use outside
Unity. Copying its code into Terrasmith would be a straightforward licence violation, and even
reading it to write a "clean-room" reimplementation is legally greyer than reading GPL code
(because the EULA is a contract, not just a copyright grant).

MapMagic *is* worth knowing about conceptually — its tile-based infinite-world generation and its
"generator draft vs generator main" two-resolution model are the same preview/build split we
need — but get that from the **public wiki** (`gitlab.com/denispahunov/mapmagic/-/wikis/home`,
notably the "MM2 Preview" page), not from the source.

**VERDICT: avoid (licence).** Read public docs only.

---

### 2.5 Smaller node-terrain projects surveyed

| Repo | Lang | Licence | Last push | Note | Verdict |
|---|---|---|---|---|---|
| [xzrunner/terraingraph](https://github.com/xzrunner/terraingraph) | C++ | MIT | 2020-12-06 | Node-based terrain generator; tiny, unfinished, 0★. Interesting only as a node-catalog checklist. | avoid (quality) |
| [Jared-Wyatt/NoisePerspective](https://github.com/Jared-Wyatt/NoisePerspective) | C# | MIT | 2025-10-20 | Unity node terrain generator, 3★. | avoid (quality) |
| [aarondemolder/nodenoise](https://github.com/aarondemolder/nodenoise) | C++ | none | 2019-01-25 | Standalone node terrain gen, 4★, unlicensed. | avoid (licence) |
| [shahab5191/terrashin](https://github.com/shahab5191/terrashin) | Rust | none | 2026-04-26 | 3D node terrain gen in Rust, unlicensed, very early. | avoid (licence) |
| [Ono-Sendai/terraingen](https://github.com/Ono-Sendai/terraingen) | C++ | **MIT** | 2026-07-26 | GPU terrain generator + erosion simulator, 55★, actively worked on. The GPU erosion kernels are genuinely readable and MIT. | port the algorithm |
| [dizzy2003/TextureWangBeta](https://github.com/dizzy2003/TextureWangBeta) | C# | `NOASSERTION` | 2019-06-09 | Node-based procedural texture for Unity, 81★. Licence file not read; unresolved (§1.2a). | avoid (licence) |
| [CosmoMyzrailGorynych/FilterJS](https://github.com/CosmoMyzrailGorynych/FilterJS) | TS | **GPL-3.0** | 2023-02-27 | Node-based procedural texture generator in Node.js + WebGL — closest in *technology* to us, wrong licence. | **avoid (GPL)** |
| [sgynn/worldeditor](https://github.com/sgynn/worldeditor) | C++ | MIT | 2026-08-17 | Heightmap terrain editor, 0★. | avoid (quality) |
| [fogleman/hmm](https://github.com/fogleman/hmm) | C | **MIT** | 2023-12-19 | Heightmap Meshing Utility, 618★. Greedy RTIN-style triangulation of a heightfield to an error-bounded mesh. **Directly useful** for the studio's 3D viewport: turn a 1025² field into a few-thousand-triangle mesh at a chosen max error. | port the algorithm |
| [TokisanGames/Terrain3D](https://github.com/TokisanGames/Terrain3D) | C++ | MIT | 2026-09-10 | 4,255★ Godot terrain system. Read its clipmap LOD + region streaming for viewport rendering ideas. | read for architecture |

---

## 3. Node graph execution engines — how the good ones work

This is the section that matters most for `packages/graph`. Six questions, and what each
reference engine answers.

> The six questions: **(a)** How is a result cached? **(b)** How does a parameter change
> invalidate downstream work? **(c)** How is only the needed subgraph recomputed? **(d)** How are
> ports typed and connections validated? **(e)** How do subgraphs/macros work? **(f)** How is
> preview resolution separated from final resolution?

### 3.1 Gaffer — the reference implementation (BSD-3-Clause)

| | |
|---|---|
| Repo | https://github.com/GafferHQ/gaffer |
| Language | C++ / Python |
| Licence | **BSD-3-Clause** — fully compatible with MIT |
| Maturity | 1,092★, in production at Image Engine and others since ~2011, last push **2026-09-12** |

Gaffer is a node-based application for lookdev, lighting and automation. Its `ValuePlug` is, as
far as this survey found, the best-engineered open-source answer to our exact problem.

#### (a) Two caches, not one

Gaffer keeps **a hash cache and a compute cache**, and they are keyed differently.

**Hash cache** — maps "which plug, in which context, at which dirty generation" → a content hash:

```cpp
// gaffer :: src/Gaffer/ValuePlug.cpp : 107-127  (comment 107-108, struct 109-127)
struct HashCacheKey
{
    HashCacheKey( const ValuePlug *plug, const Context *context, uint64_t dirtyCount )
        : plug( plug ), contextHash( context->hash() ), dirtyCount( dirtyCount ) {}

    bool operator == ( const HashCacheKey &other ) const
    {
        return other.plug == plug && other.contextHash == contextHash
            && dirtyCount == other.dirtyCount;
    }

    const ValuePlug   *plug;
    IECore::MurmurHash contextHash;
    uint64_t           dirtyCount;
};
```

The hash cache is **per-thread** (`LRUCachePolicy::Serial`, `ValuePlug.cpp : 475`) with a small
global backing cache (`LRUCachePolicy::Parallel`, `ValuePlug.cpp : 456`), sized by *entry count*
per thread, not bytes (`ValuePlug.h : 157-160`: "Limits are applied on a per-thread basis").

**Compute cache** — maps that content hash → the actual computed value:

```cpp
// gaffer :: src/Gaffer/ValuePlug.cpp : 697-699
using CacheType = IECorePreview::LRUCache<
    IECore::MurmurHash, IECore::ConstObjectPtr, IECorePreview::LRUCachePolicy::Parallel>;
static CacheType g_cache;

// gaffer :: src/Gaffer/ValuePlug.cpp : 700-703
static size_t cacheCostFunction( const IECore::ConstObjectPtr &v )
{
    return v->memoryUsage();
}

// gaffer :: src/Gaffer/ValuePlug.cpp : 713-715  (default limit)
// Using a null `GetterFunction` because it will never get called, because we only ever call `getIfCached()`.
// Note : The default size here is overridden by `startup/Gaffer/cache.py`.
ValuePlug::ComputeProcess::CacheType ValuePlug::ComputeProcess::g_cache(
    CacheType::GetterFunction(), 1024 * 1024 * 1024 * 1, CacheType::RemovalCallback(),
    /* cacheErrors = */ false ); // 1 gig
```

⚠️ **Do not read 1 GiB as "Gaffer's chosen cache size".** The source comment on line 714 says the
constant is *overridden at startup* by `startup/Gaffer/cache.py`, which sizes the cache against
the host machine. The transferable fact is the **policy** (byte-budgeted, cost = `memoryUsage()`,
configurable at runtime), not the number. Terrasmith's own default in §4.5 (512 MiB) is a guess
and should likewise be a runtime setting, not a constant.

Note `cacheCostFunction` returns **bytes**, so the compute cache is byte-budgeted and evicts by
memory pressure — the right policy when entries are megabyte-scale images or, for us,
megabyte-scale `Float32Array` fields.

**Why two caches is the right shape.** The hash is cheap and small; the value is expensive and
large. Because the compute cache is keyed *only* on the content hash, two structurally different
graphs that compute the same thing share one cache entry — which is exactly what makes "change a
parameter and change it back" free, and also what makes a duplicated subgraph free.

#### (b) Invalidation via a per-plug dirty counter

```cpp
// gaffer :: include/Gaffer/ValuePlug.h : 187-196
/// Returns a counter that increments when this plug is been dirtied
/// ( but doesn't necessarily start at 0 ). This is used internally
/// for cache invalidation but may also be useful for debugging and
/// as part of a "poor man's hash" where computing the full upstream
/// hash might be prohibitively expensive
uint64_t dirtyCount() const { return m_dirtyCount; }
```

Setting a value bumps `m_dirtyCount` on that plug and, via each node's `affects()` declaration,
on every downstream plug it declares itself to affect. Because `dirtyCount` is part of the hash
cache key, the old hash-cache entries are simply *unreachable* rather than needing deletion. **No
cache sweep on edit.** This is a very cheap invalidation and worth copying verbatim in spirit.

#### (c) Recompute only what is asked for — pull-based, with a debug mode for wrong `affects()`

Gaffer is strictly pull-based: nothing computes until someone calls `getValue()` on an output.
Its genuinely clever bit is the recognition that hand-written `affects()` declarations *will* be
wrong sometimes, and that a silently wrong dependency declaration produces a stale result that is
nearly impossible to debug. So it ships a checking mode:

```cpp
// gaffer :: include/Gaffer/ValuePlug.h : 170-181
/// The standard hash cache mode relies on correctly implemented
/// affects() methods to selectively clear the cache for dirtied
/// plugs.  If you have incorrect affects() methods, you can use
/// "Legacy", which pessimisticly dirties all hash cache entries
/// when something changes, or "Checked" which helps identify
/// bad affects() methods by throwing exceptions.
enum class HashCacheMode { Standard, Checked, Legacy };
```

```cpp
// gaffer :: src/Gaffer/ValuePlug.cpp : 310-344 (elided; `throw` is wrapped in try/catch upstream
//   so ProcessException::wrapCurrentException can attach the offending plug)
const HashCacheKey cacheKey( p, currentContext, p->m_dirtyCount );
if( g_hashCacheMode == HashCacheMode::Standard ) {
    return acquireHash( cacheKey );
}
else if( g_hashCacheMode == HashCacheMode::Checked ) {
    HashCacheKey legacyCacheKey( cacheKey );
    legacyCacheKey.dirtyCount = g_legacyGlobalDirtyCount + DIRTY_COUNT_RANGE_MAX + 1;
    const IECore::MurmurHash check  = acquireHash( legacyCacheKey );
    const IECore::MurmurHash result = acquireHash( cacheKey );
    if( result != check ) {
        throw IECore::Exception(
            "Detected undeclared dependency. Fix DependencyNode::affects() implementation." );
    }
    return result;
}
```

`Checked` computes the hash twice — once through the incremental path, once through a
pessimistically-invalidated path — and throws if they disagree. **Steal this.** In Terrasmith it
becomes: a `TERRASMITH_GRAPH_CHECK=1` mode that, for every node evaluation, also recomputes the
hash with an empty cache and asserts equality. It turns the entire class of "my cache gave me a
stale field" bugs into a loud, localised failure in CI.

#### (d)/(e) Ports and subgraphs

Gaffer's plugs are strongly typed C++ classes (`FloatPlug`, `V3fPlug`, `CompoundPlug`, …) with
`acceptsInput()` governing connection legality; subgraphs are `Box` nodes with promoted plugs.
Less directly transferable to a JSON-serialised TypeScript graph than MaterialX's schema (§3.6),
so prefer MaterialX for that dimension.

#### (f) Per-compute cache policy — the detail everyone misses

```cpp
// gaffer :: include/Gaffer/ValuePlug.h : 118-133
enum class CachePolicy
{
    /// No caching is performed. Suitable for extremely quick processes.
    /// Also useful to avoid double-counting of cache memory when a
    /// compute always returns a sub-object of another cache entry.
    Uncached,
    /// Must be used for processes that spawn TBB tasks. Results are
    /// stored in a global cache, and threads waiting for the same
    /// result will collaborate to perform tasks together until the work
    /// is complete.
    TaskCollaboration,
    /// Suitable for relatively lightweight processes that could benefit
    /// from caching, but do not spawn TBB tasks, and are unlikely to be
    /// required from multiple threads concurrently.
    Default
};
```

**Cache policy is per node type, declared by the node — and hashing and computing have separate
policies.** A `Constant` node declares `Uncached` (caching it costs more than recomputing). An
`Erosion` node declares the collaborative policy so that two previews requesting the same erosion
result *share the work instead of duplicating it*. The two dispatch sites:

```cpp
// gaffer :: src/Gaffer/ValuePlug.cpp : 236   (hash side)
const CachePolicy cachePolicy = computeNode ? computeNode->hashCachePolicy( p ) : CachePolicy::Uncached;
// gaffer :: src/Gaffer/ValuePlug.cpp : 562   (compute side)
cachePolicy = computeNode->computeCachePolicy( p );
```

Terrasmith's equivalent of `TaskCollaboration` is simple and important: **an in-flight promise
map**. Key it by the same content hash as the compute cache, so a second request for a
cache-missing hash awaits the first request's promise rather than starting a second erosion run.

**VERDICT: read for architecture** — and note that, being BSD-3, we are also *permitted* to port
any of it we want, with attribution.

---

### 3.2 ComfyUI — the cautionary contrast (GPL-3.0)

| | |
|---|---|
| Repo | https://github.com/comfyanonymous/ComfyUI — **now redirects to `Comfy-Org/ComfyUI`** (the canonical `full_name` returned by the API, 2026-09-13) |
| Licence | **GPL-3.0** — ⚠️ cannot be copied into Terrasmith |
| Maturity | 132,841★, pushed daily |

The most-used node-graph execution engine in the world right now, so its choices are worth
understanding — and one of them is worth *not* copying.

ComfyUI's cache key for a node is the **flattened signature of its entire upstream ancestry**:

```python
# ComfyUI :: comfy_execution/caching.py : 101-107   (GPL-3.0 — read only)
async def get_node_signature(self, dynprompt, node_id):
    signature = []
    ancestors, order_mapping = self.get_ordered_ancestry(dynprompt, node_id)
    signature.append(await self.get_immediate_node_signature(dynprompt, node_id, order_mapping))
    for ancestor_id in ancestors:
        signature.append(await self.get_immediate_node_signature(dynprompt, ancestor_id, order_mapping))
    return to_hashable(signature)
```

```python
# ComfyUI :: comfy_execution/caching.py : 109-127
signature = [class_type, await self.is_changed_cache.get(node_id)]
if self.include_node_id_in_input() or (hasattr(class_def, "NOT_IDEMPOTENT") and class_def.NOT_IDEMPOTENT) ...:
    signature.append(node_id)
inputs = node["inputs"]
for key in sorted(inputs.keys()):
    if is_link(inputs[key]):
        (ancestor_id, ancestor_socket) = inputs[key]
        ancestor_index = ancestor_order_mapping[ancestor_id]
        signature.append((key, ("ANCESTOR", ancestor_index, ancestor_socket)))
    else:
        signature.append((key, inputs[key]))
```

**Three lessons, two positive and one negative.**

- *Positive:* `sorted(inputs.keys())` — parameter iteration order must be deterministic or your
  hash is nondeterministic. Obvious, universally forgotten.
- *Positive:* `NOT_IDEMPOTENT` and the `IS_CHANGED` / `fingerprint_inputs` escape hatch
  (`ComfyUI :: execution.py : 74-101`). Some nodes cannot be described by their parameters alone
  — a node that reads a file, or that is deliberately stochastic. Give node authors a way to
  contribute an extra fingerprint (file mtime, a counter) to the hash, and a way to opt out of
  caching entirely. Terrasmith needs this the moment we add "import heightmap from file".
- *Negative — do not copy:* the signature is built by walking and serialising the **whole
  ancestry** on every key computation. That is O(size of upstream subgraph) per node per
  evaluation, i.e. O(n²) over a graph of n nodes. It is fine for ComfyUI, where each node takes
  seconds of GPU time, and it would be terrible for us, where a 60-node graph is re-keyed on every
  slider tick. **Gaffer's recursive formulation — each node's hash is computed from its inputs'
  *hashes*, which are themselves cached — is O(1) amortised per node.** Use Gaffer's.

Its cache *storage* strategies are, however, a good menu to copy the shape of
(`comfy_execution/caching.py`): `HierarchicalCache` (subgraph-scoped, dropped wholesale when the
subgraph goes away), `LRUCache`, `RAMPressureCache` (LRU that also watches system memory), and
`NullCache`.

**VERDICT: read for architecture only — GPL-3.0, never copy.**

---

### 3.3 milomg/reactively — the cleanest dirty-propagation algorithm in TypeScript (MIT)

| | |
|---|---|
| Repo | https://github.com/milomg/reactively |
| Language | TypeScript |
| Licence | **MIT** |
| Maturity | 547★, last push 2025-12-10. Small (`packages/core/src/core.ts` is **338 lines**, verified `wc -l`) and *correct* |

This is a lazy reactive-value library, not a terrain tool, but it contains the single best-stated
and best-tested implementation of the three-colour dirty-propagation algorithm — the same
algorithm as Rust's `salsa` red-green, Adapton, and Glimmer, in 338 readable lines of TS.

The algorithm, from its own header comment (**verbatim**, including the two typos — an earlier
draft of this document silently paraphrased and renumbered it):

```
// reactively :: packages/core/src/core.ts : 20-28
 * Each node stores a cache state to support the change propogation algorithm: 'clean', 'check', or 'dirty'
 * In general, execution proceeds in three passes:
 *  1. set() propogates changes down the graph to the leaves
 *     direct children are marked as dirty and their deeper descendants marked as check
 *     (no reactive computations are evaluated)
 *  2. get() requests that parent nodes updateIfNecessary(), which proceeds recursively up the tree
 *     to decide whether the node is clean (parents unchanged) or dirty (parents changed)
 *  3. updateIfNecessary() evaluates the reactive computation if the node is dirty
 *     (the computations are executed in root to leaf order)
```

```ts
// reactively :: packages/core/src/core.ts : 44-46
export const CacheClean = 0; // reactive value is valid, no need to recompute
export const CacheCheck = 1; // reactive value might be stale, check parent nodes to decide
export const CacheDirty = 2; // reactive value is invalid, parents have changed, needs recompute
```

**Marking on change — one level dirty, everything below only "check":**

```ts
// reactively :: packages/core/src/core.ts : 187-202
private stale(state: CacheNonClean): void {
  if (this.state < state) {
    if (this.state === CacheClean && this.effect) {
      EffectQueue.push(this);
      stabilizeFn?.(this);
    }
    this.state = state;
    if (this.observers) {
      for (let i = 0; i < this.observers.length; i++) {
        this.observers[i].stale(CacheCheck);   // <-- note: Check, not Dirty
      }
    }
  }
}
```

**Pulling — walk up, and stop early the moment a parent turns out to be dirty:**

```ts
// reactively :: packages/core/src/core.ts : 273-293
private updateIfNecessary(): void {
  if (this.state === CacheCheck) {
    for (const source of this.sources!) {
      source.updateIfNecessary();              // can change this.state
      if ((this.state as CacheState) === CacheDirty) {
        break;                                  // don't touch remaining parents
      }
    }
  }
  if (this.state === CacheDirty) {
    this.update();
  }
  this.state = CacheClean;
}
```

**The diamond fix — a recompute that produces an equal value stops propagating:**

```ts
// reactively :: packages/core/src/core.ts : 258-269   (verbatim)
// handles diamond depenendencies if we're the parent of a diamond.
if (!this.equals(oldValue, this._value) && this.observers) {
  // We've changed value, so mark our children as dirty so they'll reevaluate
  for (let i = 0; i < this.observers.length; i++) {
    const observer = this.observers[i];
    observer.state = CacheDirty;
  }
}

// We've rerun with the latest values from all of our sources.
// This means that we no longer need to update until a signal changes
this.state = CacheClean;
```

That last block is the whole payoff, and it is why Terrasmith's cache should be **content-keyed**
rather than identity-keyed. If a node recomputes and produces a field whose hash equals the
previous field's hash, its descendants must *not* recompute. With content hashing that fallout is
automatic: the descendant's key is unchanged, so its cache entry is still valid. The `equals`
check in `reactively` is doing by hand what content hashing does structurally.

**VERDICT: port the algorithm.** MIT, TypeScript, 340 lines, directly applicable. The one change
to make when porting: replace `equals(oldValue, newValue)` with a content hash comparison, because
a deep-equals on a 1025×1025 `Float32Array` is 4 MB of comparison per node, whereas hashing it
once and caching the hash is not.

Related (same family, worth a look but not portable): `salsa-rs/salsa` (Apache-2.0, Rust — the
"red-green" formulation with revision counters, used by rust-analyzer; conceptually identical),
and `janestreet/incremental` (MIT, OCaml — self-adjusting computation with a height-ordered
priority queue, the rigorous version of the same idea).

---

### 3.4 Blender geometry nodes — the laziness model (GPL-2.0-or-later — read only)

⚠️ **`blender/blender` is GPL-2.0-or-later. Read for concepts; do not copy code, names, or
structure.** The file below carries `SPDX-License-Identifier: GPL-2.0-or-later` at line 3.

Blender's geometry-nodes evaluator is built on `LazyFunction`
(`source/blender/functions/FN_lazy_function.hh`). Its header explains the model better than any
external write-up:

```
// blender :: source/blender/functions/FN_lazy_function.hh : 10-41  (GPL — quoted as documentation)
//   file verified 2026-09-13: 479 lines, SPDX-License-Identifier: GPL-2.0-or-later on line 3
 * A `LazyFunction` encapsulates a computation which has inputs, outputs and potentially side
 * effects. Most importantly, a `LazyFunction` supports laziness in its inputs and outputs:
 * - Only outputs that are actually used have to be computed.
 * - Inputs can be requested lazily based on which outputs are used or what side effects the
 *   function has.
 *
 * A lazy-function that uses laziness may be executed more than once. The most common example is
 * the geometry nodes switch node. Depending on a condition input, it decides which one of the
 * other inputs is actually used. ...
 * In some sense, a lazy-function can be thought of like a state machine. Every time it is
 * executed, it advances its state until all required outputs are ready.
```

And the tri-state that makes it work:

```cpp
// blender :: source/blender/functions/FN_lazy_function.hh : 61-76  (doc-comments condensed)
enum class ValueUsage : uint8_t {
  Used,    // The value is definitely used and therefore has to be computed.
  Maybe,   // It's unknown whether this value will be used or not. Computing it is ok but the
           // result may be discarded.
  Unused,  // The value will definitely not be used. It can still be computed but the result
           // will be discarded in all cases.
};
```

**The idea to take.** A `Switch`/`Blend`-with-mask node should be able to tell the evaluator *"I
do not need input B at all"* before B is computed, and that information must propagate across
subgraph boundaries. In a terrain tool this is the difference between a "Biome Select" node with
five branches costing 1× and costing 5×. Our node interface therefore needs, in addition to
`evaluate(inputs, ctx)`, an optional `inputUsage(params, ctx) -> Map<port, Used|Maybe|Unused>`
consulted *before* pulling inputs.

**VERDICT: read for architecture only — GPL, never copy.**

---

### 3.5 MaterialX — the node-definition schema to adopt (Apache-2.0)

| | |
|---|---|
| Repo | https://github.com/AcademySoftwareFoundation/MaterialX |
| Licence | **Apache-2.0** — compatible with MIT (keep `NOTICE`) |
| Maturity | 2,255★, ASWF-governed, used by Pixar/ILM/Autodesk/Adobe, pushed continuously |

MaterialX is not an engine; it is a **standard for describing node graphs**. Its specification
(`documents/Specification/MaterialX.Specification.md`, 1,594 lines) has already solved the design
of the thing Terrasmith calls "the node catalog", and there is no reason to redesign it.

#### The shape

```xml
<!-- MaterialX.Specification.md : 595-601 (verbatim; spec file is 1,594 lines, verified 2026-09-13) -->
  <nodecategory name="nodename" type="outputdatatype" [version="version"]
               [nodedef="nodedef_name"]>
    <input name="inputname" type="type" [nodename="nodename"] [value="value"]/>
    ...additional input or token elements...
  </nodecategory>
```

A node instance references a `<nodedef>` that declares its interface; the nodedef's *implementation*
is either target-specific code (`<implementation>`) or **a `<nodegraph>` — which is how macros /
user-defined nodes work** (`MaterialX.Specification.md : 626-635, 945-1000`). One mechanism covers
both "built-in node" and "group of nodes the user saved as a reusable node", which is exactly the
subgraph story `ARCHITECTURE.md` needs for templates and guided mode.

#### The `<nodedef>` attributes worth copying verbatim

| Attribute | Meaning | Why Terrasmith needs it |
|---|---|---|
| `node` | the node's category name | — |
| `inherit` | inherit ports from another nodedef | a `ridged-fbm` that inherits `fbm`'s parameters |
| `nodegroup` | catalog grouping. **Full standard list** (`MaterialX.Specification.md : 959`): `"texture2d"`, `"procedural"`, `"geometric"`, `"application"`, `"math"`, `"adjustment"`, `"compositing"`, `"conditional"`, `"channel"`, `"convolution"`, `"organization"` — an earlier draft omitted `texture2d`, `geometric` and `application` | the node palette's sections |
| `version` + `isdefaultversion` | multiple definitions of one node name, "_major_[._minor_]" (minor defaults to 0 if omitted — `: 960`). If two nodedefs share `node` + `target` + input/output type signature they **must** each declare a `version`, and at most one may set `isdefaultversion="true"` (`: 961`) | **node migration.** When we change Erosion's parameterisation in v2, v1 graphs must keep loading |
| `target` | restrict a definition to one backend | CPU vs WebGPU implementations of the same node |

#### The `<input>` attributes worth copying verbatim

From `MaterialX.Specification.md : 1000-1040`:

| Attribute | Meaning | Terrasmith use |
|---|---|---|
| `type`, `value` | typed port with a default | — |
| `uniform` | precisely (`: 1000`): the input "can only take uniform values and may only be connected to the outputs of &lt;constant> nodes or any other node whose output is explicitly declared to be 'uniform' (optionally through a number of &lt;dot> nodes), but not to the outputs of other (non-'uniform') nodes. `uniform` must be set to true for string and filename-type inputs." It is **not** "no connection allowed" — it is "only connectable to a uniform-typed output" | seed, resolution-affecting integers, tile-count parameters |
| `enum` / `enumvalues` | UI labels and their underlying values | noise basis, blend mode |
| `unittype` / `unit` | e.g. `unittype="distance" unit="foot"` | **elmos.** A `Feature Size` of 512 elmos stays 512 elmos regardless of evaluation resolution — this is the schema slot for exactly the resolution-independence `ARCHITECTURE.md` promises |
| `uiname` | display name distinct from the machine name | rename in the UI without breaking saved graphs |
| `uifolder` | `"Noise/Fine"` — slash-separated nested folders | the inspector's grouping |
| `uimin` / `uimax` | hard limits | validation |
| `uisoftmin` / `uisoftmax` | **suggested slider range, may be exceeded by typing** | the single most important beginner-friendliness feature in a parameter UI |
| `uistep` | increment | — |
| `uiadvanced` | hide behind an "advanced" toggle | **guided mode is `uiadvanced=false` parameters only.** This is a schema-level answer to the beginner/expert split |
| `uivisible` | show/hide, settable per nodedef *and* per instance | a template can hide the parameters it drives |
| `doc` | tooltip / documentation string | "parameters that explain themselves" |

Also worth noting: `disable` is a **standard input on every node**
(`MaterialX.Specification.md : 691`) — "`disable` (uniform boolean): if set to true, the node will
pass its default input or value to its output, effectively disabling the node; default is false.
Applications may choose to implement the `disable` input by skipping over the disabled node during
traversal and instead passing through a connection to the defaultinput node or outputting the
node's default value, rather than using an actual `disable` input in the node implementation." —
note the last clause: **`disable` is allowed to be a graph-rewrite, not a runtime branch**, which
is exactly how Terrasmith should implement bypass (rewrite the edge, do not evaluate the node). A universal bypass is a node-catalog
feature, not a UI feature. And `<backdrop>` elements (`: 743-751`, with `contains` at `: 745`
and `minimized` at `: 746`) are the standard way to let users annotate and group a graph without
affecting semantics. A `<nodegraph>` may reuse backdrop's `width`/`height`/`minimized`, but the
two differ semantically: nodes inside a **backdrop** connect straight through to outside nodes,
whereas nodes inside a compound **nodegraph** may only connect to each other or to the graph's
declared `<input>` ports via `interfacename` (`: 1208`). Terrasmith wants both — backdrops for
annotation, nodegraphs for real subgraphs.

**VERDICT: use directly** — as a schema. We are not adopting the XML serialisation (our graphs are
JSON), but `packages/graph`'s node-definition type should be a near-isomorphic JSON rendering of
`<nodedef>`. Doing so buys us: free node versioning, free guided-mode parameter filtering, free
unit handling, and the ability to interoperate with `.mtlx` later if we ever want to.

---

### 3.6 Node-editor UI libraries (the `apps/studio` layer)

Distinct from the execution engine. `apps/studio` is React, so:

| Library | Licence | ★ | Last push | Notes |
|---|---|---|---|---|
| [xyflow/xyflow](https://github.com/xyflow/xyflow) (React Flow / Svelte Flow) | **MIT** | 38,353 | 2026-09-10 | The default choice. Custom node components are plain React, so our node bodies can render live previews. Handles pan/zoom, selection, edge routing, minimap, and — importantly — has a documented story for hundreds of nodes. |
| [retejs/rete](https://github.com/retejs/rete) | **MIT** | 12,251 | 2026-09-13 | Framework-agnostic, ships its *own* dataflow/control-flow engines. Tempting, but its engine is weaker than the design in §4 — take the editor, not the engine, or take neither. |
| [jagenjo/litegraph.js](https://github.com/jagenjo/litegraph.js) | **MIT** | 8,134 | 2024-08-01 | Canvas2D, self-contained, battle-tested via ComfyUI. But stale upstream, and its maintained fork `Comfy-Org/litegraph.js` (MIT, 253★) is **self-declared dead**: its GitHub description reads "⛔ ARCHIVED (See README)" and its last push was 2026-01-14. ⚠️ Correction to an earlier draft: GitHub's `archived` *flag* is still `false` for that fork — the repo is abandoned by declaration, not by GitHub's archive mechanism. Either way: do not depend on it. |
| [jchanvfx/NodeGraphQt](https://github.com/jchanvfx/NodeGraphQt) | **MIT** | 1,822 | 2026-03-11 | Python/Qt. Not usable in a browser. Worth 30 minutes for its *interaction* design (port snapping, node search palette, group nodes, auto-layout) which is very well done. |
| [hugeproblem/nged](https://github.com/hugeproblem/nged) | Apache-2.0 | 290 | 2026-02-26 | C++/ImGui. Good reference for large-graph rendering performance. |

**VERDICT: use directly — React Flow (`xyflow`, MIT).** Read NodeGraphQt for interaction design.

---

## 4. Recommended architecture for `packages/graph`

This section is the synthesis. It is what §3 adds up to, expressed as something implementable.

### 4.1 The requirement, precisely

> Change one parameter; recompute only the affected nodes; do it at preview resolution
> immediately; later, run the *same graph* at full resolution and get the *same terrain* with more
> detail; never block the UI; never show a result that does not correspond to the current
> parameters; and let a user cancel by moving another slider.

### 4.2 The data model

```ts
/** The only value that flows between nodes. Row-major, width*height floats. */
interface Field {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;   // length === width * height
  readonly semantic: FieldSemantic;  // 'height-elmos' | 'mask' | 'slope-deg' | 'flow' | ...
}

/** Everything ambient about an evaluation. NOT node parameters. Hashed. */
interface EvalContext {
  readonly resolution: number;        // samples per side, e.g. 512 preview / 1025 build
  readonly domain: Rect;              // world-space rect in elmos being evaluated
  readonly seed: number;              // project seed
  readonly quality: 'preview' | 'build';
  readonly tile?: { x: number; y: number };  // for tiled builds, later
}
```

`semantic` is Material Maker's `slot_type` idea (§2.2.2): it does not change the representation,
but it drives connection legality warnings, default preview colour-mapping, and the units the
inspector shows. A `mask` connected to a height input is legal but flagged; a `height-elmos`
dropped into a 0..1 blend factor is the classic beginner mistake and should be caught.

### 4.3 `EvalContext` is the preview/build mechanism — this is the key idea

**Resolution is not a node parameter. It is a context value, and it is part of every hash.**

This single decision produces all of the desired behaviour:

- Evaluating the graph at `resolution: 512` and at `resolution: 1025` produces **two disjoint sets
  of cache entries** for the same graph. They never collide, never invalidate each other.
- Switching a preview from 512 to 1024 and back is instant the second time.
- The build is not a different code path — it is the same `evaluate(outputNode, ctx)` call with a
  different `ctx`. There is therefore no way for the preview to disagree with the build about
  *what the graph means*, only about how finely it was sampled. That is exactly the honesty
  property `ARCHITECTURE.md` demands.
- Tiled builds, if we ever need them, are just more context values.

This is lifted directly from Gaffer, where `Context` carries frame, resolution, scene path, etc.,
and `HashCacheKey` includes `context->hash()` (`ValuePlug.cpp : 112`).

**The discipline this imposes on node authors** (write it in the node-authoring guide):

> A node must produce *the same terrain* at any resolution, only sampled more finely. Therefore
> every spatial parameter is a world distance in elmos, never a pixel count; every kernel radius
> is converted to samples as `radiusElmos / elmosPerSample` at evaluation time; every random
> number is drawn from a hash of world position and seed, never from a sequential PRNG whose call
> order depends on resolution.
>
> Erosion is the declared exception (`ARCHITECTURE.md`). Express its strength as a density
> (droplets per square elmo) and its distances in elmos, and scale iteration counts by
> `(resolution / referenceResolution)²` so that the *amount of erosion per unit area* is
> resolution-stable even though the simulation is not exactly reproducible.

### 4.4 The cache keys

Two caches, as in Gaffer (§3.1a).

```ts
// Tier 1: the hash cache.  key -> content hash.  Small entries, count-bounded.
type HashKey = `${NodeId}|${ContextHash}|${DirtyCount}`;
// Tier 2: the value cache. content hash -> Field. Large entries, BYTE-bounded.
type ValueKey = ContentHash;  // a 128-bit hash rendered as a hex string
```

And the recursive hash, computed once per node per (context, dirty generation):

```ts
function hashOf(node: Node, ctx: EvalContext): ContentHash {
  const k: HashKey = `${node.id}|${ctx.hash}|${node.dirtyCount}`;
  const hit = hashCache.get(k);
  if (hit) return hit;

  const h = new Hasher();
  h.str(node.type);
  h.u32(node.defVersion);               // node definition version — see §3.5
  for (const name of node.paramNamesSorted)   // SORTED. deterministic order. (ComfyUI's one gift)
    h.param(name, node.params[name]);
  for (const port of node.inputPortsSorted) {
    const src = node.inputs[port];
    h.str(port);
    h.hash(src ? hashOf(src.node, ctx) : EMPTY_HASH);   // <-- recursive: O(1) amortised
  }
  h.hash(ctx.hashForNode(node));        // usually ctx.hash; see §4.7 for context-narrowing
  if (node.def.extraFingerprint)        // ComfyUI's IS_CHANGED escape hatch
    h.any(node.def.extraFingerprint(node, ctx));

  const out = h.digest();
  hashCache.set(k, out);
  return out;
}
```

Because each input contributes its *cached hash* rather than its serialised ancestry, this is
O(1) per node amortised, not ComfyUI's O(subgraph) (§3.2).

### 4.5 Evaluation

```ts
const valueCache = new ByteBudgetLRU<ContentHash, Field>({ maxBytes: 512 * 1024 * 1024 });
const inFlight   = new Map<ContentHash, Promise<Field>>();   // Gaffer's TaskCollaboration

async function evaluate(node: Node, ctx: EvalContext, signal: AbortSignal): Promise<Field> {
  const h = hashOf(node, ctx);

  const cached = valueCache.get(h);
  if (cached) return cached;                    // free: same params, or params changed and changed back

  const running = inFlight.get(h);
  if (running) return running;                  // two previews wanting the same erosion share one run

  const p = (async () => {
    // Laziness (Blender's ValueUsage, §3.4): ask the node which inputs it actually needs.
    const usage = node.def.inputUsage?.(node.params, ctx) ?? ALL_USED;
    const inputs: Record<string, Field | undefined> = {};
    await Promise.all(
      node.inputPortsSorted
        .filter(port => usage[port] !== 'Unused' && node.inputs[port])
        .map(async port => {
          inputs[port] = await evaluate(node.inputs[port]!.node, ctx, signal);
        }),
    );
    signal.throwIfAborted();

    const out = await node.def.evaluate(inputs, node.params, ctx, signal);
    if (node.def.cachePolicy !== 'uncached') valueCache.set(h, out, byteSize(out));
    return out;
  })();

  inFlight.set(h, p);
  try { return await p; } finally { inFlight.delete(h); }
}
```

Three properties fall out for free and are worth stating because they are the whole point:

1. **Change one parameter ⇒ only that node and its descendants get new hashes.** Every unaffected
   node's hash is unchanged, so its value is a cache hit. No traversal bookkeeping needed.
2. **Change it back ⇒ the old hashes return ⇒ everything is a cache hit.** Undo is free.
3. **A node that recomputes to an identical result does not force its descendants to recompute**,
   because the descendants' keys depend on the *hash of the value*, not on the fact that the
   parent ran. This is `reactively`'s diamond fix (§3.3), achieved structurally.

### 4.6 Node states — Material Maker's five, not three

Per (node, context) pair, for the UI's benefit (spinners, stale-value dimming):

| State | Meaning | Transition |
|---|---|---|
| `Clean` | cached value matches current hash | — |
| `Invalidated` | hash changed, no run scheduled | → `Updating` when scheduled |
| `Updating` | run in flight for hash *h* | → `Clean` on completion |
| `UpdatingInvalidated` | run in flight for hash *h*, but the current hash is now *h′ ≠ h* | → `Invalidated` on completion of the *h* run; schedule exactly one more |
| `Error` | evaluation threw | → `Invalidated` on any input change |

`UpdatingInvalidated` (`material-maker :: addons/material_maker/engine/dependencies.gd : 6-21`)
is what makes slider-dragging converge instead of thrashing. Combine it with a **trailing debounce
on parameter commits** (~60–120 ms) and a cheap **abort** path: cancel the in-flight run only if
it has not yet reached its first expensive kernel, otherwise let it finish and discard.

### 4.7 Two refinements worth building in from the start

**(a) Context narrowing.** If every node's hash includes the full `ctx.hash`, then changing *any*
context field invalidates *everything*. But most nodes do not care about, say, `tile`. Let a node
declare which context fields it reads (`node.def.contextFields = ['resolution', 'domain']`) and
hash only those. This is the cheap version of Gaffer's `Context` scoping and it materially
improves cache hit rates during tiled builds and viewport panning.

**(b) The `Checked` mode.** Port Gaffer's `HashCacheMode::Checked` (§3.1c). Behind
`TERRASMITH_GRAPH_CHECK=1`, every `hashOf` also recomputes with a cold cache and asserts equality;
every `evaluate` on a cache hit also recomputes and compares field hashes. Run it in CI over the
template graphs. It converts "stale preview" bugs — which are otherwise days of debugging — into
a failing test with a node name in it.

### 4.8 Worked example: a 60-node graph at 16×16 map scale

Concrete numbers for the map size §7.4 works through.

- Preview `ctx`: `resolution: 512` ⇒ a `Field` is 512 × 512 × 4 B = **1,048,576 B (1.00 MiB)**.
- Build `ctx`: `resolution: 1025` ⇒ 1025 × 1025 × 4 B = **4,202,500 B (4.01 MiB)**.

With a 512 MiB value-cache budget: 512 preview fields, or 128 build fields — comfortably more than
a 60-node graph needs, so during interactive work the entire preview graph stays resident and a
parameter change costs only the affected subtree.

A representative edit: the user drags **Erosion → Deposition**, a node with 22 descendants out of
60. Result:

- 38 nodes: hash unchanged ⇒ value-cache hit ⇒ **0 work**.
- 1 node (Erosion): rehash + recompute.
- 21 descendants: rehash + recompute (unless one of them hashes to a previously-seen value, e.g.
  a `Clamp` that saturates, in which case its subtree is also free).
- Peak added memory: ≤ 22 × 1 MiB = 22 MiB at preview res.

Then **Build** runs the same graph with `resolution: 1025`: every node misses (different context
hash) and computes once, 60 × 4.01 MiB ≈ 241 MiB peak if nothing is evicted — which is why the
build path should evaluate in topological order with **reference counting** and release a field as
soon as its last consumer has read it, rather than relying on LRU. (This is the one place where
the compiled-schedule approach from `NodeGraphProcessor`, §2.3, beats the pull-based evaluator.)

---

## 5. Erosion implementations

`docs/research/terrain-algos.md` §2–§4 already specifies these algorithms. This section is purely
about **provenance and licence**: which repository is the trustworthy reference for each, and
whether we may copy it.

### 5.1 SebLague/Hydraulic-Erosion — the droplet reference

| | |
|---|---|
| Repo | https://github.com/SebLague/Hydraulic-Erosion |
| Language | C# (Unity), with a compute-shader variant |
| Licence | **MIT** |
| Maturity | 1,041★, last push 2024-01-04. Stable, widely ported, accompanied by an excellent video |

The de-facto reference implementation of Beyer's droplet erosion. Its parameter block is the thing
everyone copies, and it is worth reproducing exactly because the *defaults* are hard-won:

```csharp
// SebLague/Hydraulic-Erosion :: Assets/Scripts/Erosion.cs : 5-22   (MIT; file is 207 lines,
//   values verified byte-for-byte against the raw file 2026-09-13)
public int seed;
[Range (2, 8)]   public int   erosionRadius = 3;
[Range (0, 1)]   public float inertia = .05f;   // 0 = instantly flow downhill, 1 = never turn
                 public float sedimentCapacityFactor = 4;
                 public float minSedimentCapacity = .01f;  // stops capacity → 0 on flat ground
[Range (0, 1)]   public float erodeSpeed = .3f;
[Range (0, 1)]   public float depositSpeed = .3f;
[Range (0, 1)]   public float evaporateSpeed = .01f;
                 public float gravity = 4;
                 public int   maxDropletLifetime = 30;
                 public float initialWaterVolume = 1;
                 public float initialSpeed = 1;
```

**What it does well.** The precomputed **erosion brush** —
`erosionBrushIndices[][]` / `erosionBrushWeights[][]` (`Erosion.cs : 25-26`), built once per
(mapSize, erosionRadius) — the guard is in `Initialize` (`Erosion.cs : 34-45`) and the builder is
`InitializeBrushIndices` (`Erosion.cs : 155`; an earlier draft cited 33-44, which is `Initialize`)
— is the trick that makes droplet erosion fast:
each droplet's deposit/erode is a weighted scatter over a precomputed neighbourhood rather than a
per-step radius loop.

**What to steal.** The parameter set, the defaults, the brush precomputation, and the bilinear
height-and-gradient sample. **What to adapt:** `erosionRadius` is in *cells*, and
`maxDropletLifetime` is in *steps* — both resolution-dependent. Terrasmith must express the radius
in elmos and convert (§4.3), and scale the droplet count by area.

**What to avoid.** The `Erode()` loop is inherently sequential (droplets mutate shared height), so
the naive GPU port has races. Lague's own compute-shader version accepts the races; that is
acceptable visually but makes CPU/GPU agreement impossible, which conflicts with
`ARCHITECTURE.md`'s requirement that the GPU path agree with CPU within tolerance. For the GPU
path prefer the grid/pipe model (§5.3, §5.5) which is race-free, and keep droplets on the CPU/
worker path.

**VERDICT: port the algorithm.**

Companion: `SebLague/Erosion-Demo` (MIT, 107★, 2019) — smaller, easier to read first.

### 5.2 dandrino/terrain-erosion-3-ways — the most useful single repository here

| | |
|---|---|
| Repo | https://github.com/dandrino/terrain-erosion-3-ways |
| Language | Python (NumPy/SciPy) |
| Licence | **MIT** (`LICENSE.txt`: "MIT License / Copyright (c) 2018 Daniel Andrino") |
| Maturity | 944★, last push 2022-11-22. Not a library — a set of readable reference scripts + a genuinely good write-up |

Three approaches in one repo, plus a superb README that is itself the best short introduction to
the problem space.

**(1) `simulation.py` (143 lines, verified) — grid-based hydraulic erosion.** Its header
(`simulation.py : 3-7`) cites two **URLs**, not author names: the ranmantaru.com
"water-erosion-on-heightmap-terrain" article for the code, and
`https://hal.inria.fr/inria-00402079/document` for the theory — that INRIA report is
Mei, Decaudin & Hu, *Fast Hydraulic Erosion Simulation and Visualization on GPU* (2007), which
`terrain-algos.md` §3 already specifies. Its constants are a well-tuned starting point:

```python
# dandrino/terrain-erosion-3-ways :: simulation.py : 28-62   (MIT; verbatim values, 2026-09-13)
full_width  = 200            # world extent
dim         = 512            # grid dimension
cell_width  = full_width / dim
cell_area   = cell_width ** 2

rain_rate        = 0.0008 * cell_area     # <-- note: scaled by CELL AREA
evaporation_rate = 0.0005

min_height_delta = 0.05
repose_slope     = 0.03
gravity          = 30.0
gradient_sigma   = 0.5

sediment_capacity_constant = 50.0
dissolving_rate            = 0.25
deposition_rate            = 0.001

# The number of iterations is proportional to the grid dimension. This is to
# allow changes on one side of the grid to affect the other side.
iterations = int(1.4 * dim)
```

Two lines there are the most valuable in the whole repository, and they are exactly the
resolution-independence problem `ARCHITECTURE.md` flags:

- `rain_rate = 0.0008 * cell_area` — rainfall is a **density**, scaled by cell area, so doubling
  the grid does not double the water. **This is the pattern for every erosion parameter we
  expose.**
- `iterations = int(1.4 * dim)` — iteration count scales with grid dimension so that information
  propagates across the whole field at any resolution.

Also note `apply_slippage()` (`simulation.py : 19-24`): thermal erosion implemented as "where the
gradient exceeds `repose_slope`, use a Gaussian-blurred copy of the terrain". Crude, but fast and
stable, and a good preview-quality thermal pass. **Watch the hard-coded constant**: the blur is
`util.gaussian_blur(terrain, sigma=1.5)` (`simulation.py : 21`) — a *pixel*-space sigma that is
not derived from `cell_width`, so unlike `rain_rate` this one is **not** resolution-independent.
Terrasmith must express it in elmos and divide by `elmosPerSample`. (The separate module-level
`gradient_sigma = 0.5` at `: 53` is used elsewhere and is a different quantity.)

**(2) `river_network.py` — the under-appreciated one.** Rather than simulating, it:
builds a Poisson-ish point set, Delaunay-triangulates it (`sp.spatial.Delaunay`,
`river_network.py : 203`), computes a height for each point by **a Dijkstra-style priority-queue
flood from a seed with per-edge height deltas** (`compute_height`, `river_network.py : 30-46`,
`heapq` at `: 4`, `heappop` at `: 40`, `heappush` at `: 45`), then recomputes heights with river
downcutting folded into the edge cost (`compute_final_height`, `: 53-63`, parameterised by
`max_delta` for talus slippage and `river_downcutting_constant`; the downcut factor is
`1.0 / (1.0 + v ** river_downcutting_constant)` at `: 62` and the per-edge delta is
`min(max_delta, deltas[dst] * downcut)` at `: 63`). The `main()` defaults are
`max_delta = 0.05` and `river_downcutting_constant = 1.3` (`: 179-180`). File is **227 lines**.

The result is a terrain that *has a correct drainage network by construction* — every point
drains somewhere, there are no spurious pits, and the river hierarchy is dendritic — with no
simulation and no iteration count. For a live preview that must respond in under 100 ms, and for
"generate me a map with a river through it" templates, this is a far better primitive than running
erosion until it looks right.

**(3) `generate_ml_output.py`** — a trained generative model. Ignore; not reproducible for us.

**VERDICT: port the algorithm** — all three of `simulation.py`, `river_network.py` and the
`util.py` fBm helper. MIT, clean, and the author's parameter choices are better than ours will be
on the first try.

### 5.3 henrikglass/erodr — the cleanest MIT C implementation

| | |
|---|---|
| Repo | https://github.com/henrikglass/erodr |
| Language | C |
| Licence | **MIT** |
| Maturity | 58★, last push **2025-06-16**. v2.0.0 added a Raylib live preview |

A direct implementation of Hans Theobald Beyer's thesis *Implementation of a method for hydraulic
erosion* (the primary source for the whole droplet family; linked from its README). Single-file-ish
C, OpenMP-parallel builds (`make linux-omp`), a parameter INI file, and a live preview that
reloads parameters and re-runs without restarting.

v2.0.0 (confirmed: it is the latest release tag, alongside v1.0.1 and v1.0.0) added two
parameters that Lague's version lacks and that matter, both quoted from its README:
`-f/--initial-velocity` — "In previous versions of Erodr this value was implicitly set to 0. I
found out that using a value closer to 1 tends to produce better looking results" (`README.md :
24`), **shipped default `0.9`** (`README.md : 68`) — and `-w/--initial-water`, "implicitly set to
1" before, **default `1`** (`README.md : 25, 69`). The 0.9 default is the interesting number: it
says Lague's implicit `initialSpeed = 1` is closer to right than Beyer's thesis value of 0.

**Why read this in addition to Lague's.** It is closer to the thesis, it is C (so the port to
TypeScript is mechanical), and its live-preview-with-parameter-reload loop is the UX we want.

**VERDICT: port the algorithm.**

### 5.4 weigert/SimpleHydrology and SimpleErosion — ⚠️ NO LICENCE

| | |
|---|---|
| Repos | https://github.com/weigert/SimpleHydrology (745★) · https://github.com/weigert/SimpleErosion (130★) |
| Language | C++ |
| Licence | **NONE — all rights reserved** |
| Maturity | Last pushes 2023-03-20 / 2020-04-20 |

Verified: `gh api repos/weigert/SimpleHydrology/license` → 404, and the repository root
(`.gitignore`, `Makefile`, `README.md`, `SimpleHydrology.cpp`, `imgui.ini`, `resource/`,
`screenshots/`, `source/`) contains **no licence file**. Same for `SimpleErosion`.

This is genuinely unfortunate, because `SimpleHydrology` is the best-known demonstration of
particle-based erosion that also produces **persistent streams and pools** rather than just
eroded-looking noise — the thing that makes a map read as having real hydrology.

**What to do instead.** The author (Nick McDonald) wrote the technique up at
<https://nickmcd.me/2020/04/15/procedural-hydrology/> (linked from the README at
`SimpleHydrology :: README.md : 6`). Read the blog post, take the *idea* — maintain a persistent
`momentum` and `discharge` field between particle passes, so that repeated droplets reinforce the
same channels instead of averaging out — and implement it independently. `terrain-algos.md` §2.2
already describes the mechanism.

**VERDICT: avoid (licence).** Read the blog, not the code. Do not vendor, do not copy, do not
"adapt".

### 5.5 GPU / shallow-water implementations

| Repo | Lang | Licence | ★ | Last push | Notes | Verdict |
|---|---|---|---|---|---|---|
| [bshishov/UnityTerrainErosionGPU](https://github.com/bshishov/UnityTerrainErosionGPU) | C#/HLSL | **MIT** | 155 | 2020-03-28 | Hydraulic **and** thermal erosion via **shallow water equations** in compute shaders. The virtual-pipe/SWE formulation is race-free and therefore the right basis for our WebGPU path. HLSL→WGSL is a mechanical port. | **port the algorithm** |
| [ozikazina/Hydra](https://github.com/ozikazina/Hydra) | Python/GLSL | **MIT** | 39 | **2025-11-17** | Blender hydraulic-erosion add-on using OpenGL compute. Recently maintained, well-structured, MIT. Good reference for wiring GPU erosion into a *tool* (parameter UI, previews, applying to an existing heightfield) rather than a demo. | **port the algorithm** |
| [Ono-Sendai/terraingen](https://github.com/Ono-Sendai/terraingen) | C++ | **MIT** | 55 | **2026-07-26** | GPU terrain generator + erosion simulator, actively developed. | port the algorithm |
| [Huw-man/Interactive-Erosion-Simulator-on-GPU](https://github.com/Huw-man/Interactive-Erosion-Simulator-on-GPU) | C++ | **NONE** | 26 | 2021-02-16 | Root listing contains `README.md`, `assets`, `blender`, `docs`, `erosion_sim.exe`, `src` — **no licence file**; `gh api .../license` → 404. Its `docs/` are readable and useful. | **avoid (licence)** |
| [jobtalle/HydraulicErosion](https://github.com/jobtalle/HydraulicErosion) | JS | MIT | 39 | 2020-06-14 | Browser-native, small, readable. Good sanity check for a JS port. | port the algorithm |
| [Sondro/TinyErode](https://github.com/Sondro/TinyErode) | C++ | **MIT** | 2 | 2021-06-14 | Fork of `tay10r/TinyErode` (upstream now 404). Header-only portable C++ erosion library. **This is what TerraForge3D vendors** (`TerraForge3D :: Third Party License/tinyerode.md`), which is a decent endorsement. | port the algorithm |
| [setanarut/rainfall](https://github.com/setanarut/rainfall) | Go | MIT | 5 | 2025-05-03 | Small, clean, recent. | read |
| [evroon/bevy-hydrology](https://github.com/evroon/bevy-hydrology) | Rust | MIT | 13 | **2026-07-28** | Rust/Bevy port of the SimpleHydrology *technique* — usefully, this is a permissively-licensed reimplementation of the ideas from §5.4. | port the algorithm |
| [simonmeister/hydraulic-terrain-modeler](https://github.com/simonmeister/hydraulic-terrain-modeler) | C++ | MIT | 9 | 2018-05-08 | CUDA+OpenGL interactive 2D terrain modelling with water sim. Old but the interaction model (paint while it simulates) is interesting. | read |
| [guydols/HydraulicErosion](https://github.com/guydols/HydraulicErosion), [sasha-agafonov/hydraulic-erosion](https://github.com/sasha-agafonov/hydraulic-erosion), [fletchgraham/terrain](https://github.com/fletchgraham/terrain) | — | **GPL-3.0** | — | — | — | **avoid (GPL)** |
| [Kry-a/Hydraulic-Erosion](https://github.com/Kry-a/Hydraulic-Erosion) | C++ | **LGPL-2.1** | 1 | 2020-07-07 | — | **avoid (licence)** |

### 5.6 WebGPU erosion specifically

There is no mature open-source WebGPU erosion implementation. The search surfaced only small
demos, mostly unlicensed or trivial: `kmmod/substrate` (TS, no licence), `grantmduffy/webgpu_terrain`
(MIT, 0★), `ReneU/webgpu-terrain` (no licence), `tessapower/hydraulic-erosion` (TS/three.js/WebGL,
no licence), `andrewdr0st/terrain` (MIT, 0★).

**This is a gap we will be filling ourselves**, which is a small competitive advantage and a large
warning: there is no reference implementation to check against, so the CPU path must be the oracle
(as `ARCHITECTURE.md` already says) and the CPU/GPU agreement test must be written early, not
retrofitted. Port the SWE formulation from `bshishov/UnityTerrainErosionGPU` (MIT, HLSL) — it is
the closest thing to a WebGPU-shaped reference that exists under a permissive licence.

### 5.7 Noise — the permissive baseline

| Repo | Licence | Note | Verdict |
|---|---|---|---|
| [KdotJPG/OpenSimplex2](https://github.com/KdotJPG/OpenSimplex2) | **CC0-1.0** | 701★. Public domain — copy freely, no attribution required (give it anyway). The reference for artifact-free simplex-family noise. | **port the algorithm** |
| [Auburn/FastNoiseLite](https://github.com/Auburn/FastNoiseLite) | **MIT** | 3,504★, ships C#/C++/C/Java/HLSL/GLSL/JS/Rust/Go. The **GLSL/HLSL variants are directly convertible to WGSL**, which saves real time on the GPU path. | **port the algorithm** |
| `libnoise` | **LGPL** | The classic, but LGPL and long dead. | avoid (licence) |

---

## 6. Heightfield and GIS libraries

The headline: **every well-known DEM hydrology library is GPL except WhiteboxTools and Landlab.**

### 6.1 The GPL ones — flagged, for the record

| Library | Licence | What it has that we want | Verdict |
|---|---|---|---|
| [r-barnes/richdem](https://github.com/r-barnes/richdem) | **GPL-3.0** | Priority-flood depression filling, D8/D∞ flow accumulation, the best-engineered versions of both. 324★, last push 2024-06-24. | **avoid (licence)** — but read Barnes's *papers*: "Priority-Flood: An Optimal Depression-Filling and Watershed-Labeling Algorithm for Digital Elevation Models" (2014) and "Parallel Priority-Flood" (2016). The papers are the real value; the code is just an implementation of them. |
| [dtarb/TauDEM](https://github.com/dtarb/TauDEM) | **GPL-3.0** (`license.txt : 3-5`, "GNU General Public License version 3, 2007"; paid alternative-licence offer at `: 16-20`; GitHub API reports `NOASSERTION` — see §1.2a) | D∞ flow direction (Tarboton 1997) — the canonical implementation by the algorithm's author. 275★, last push 2026-07-24. | **avoid (licence)** — implement from Tarboton's 1997 paper, which `terrain-algos.md` §5.2 already specifies. |
| [pysheds/pysheds](https://github.com/pysheds/pysheds) | **GPL-3.0** | Fast NumPy watershed delineation. 899★. | **avoid (licence)** |
| [fastscape-lem/fastscapelib](https://github.com/fastscape-lem/fastscapelib) | **GPL-3.0** | The O(n) stream-power-law solver (Braun & Willett 2013). 46★. | **avoid (licence)** — the Braun & Willett paper is short and implementable. |

### 6.2 WhiteboxTools — MIT, and already in the browser

| | |
|---|---|
| Repo | https://github.com/jblindsay/whitebox-tools |
| Language | Rust |
| Licence | **MIT** (`LICENSE.txt`: "The MIT License (MIT) / Copyright (c) 2017-2021 John Lindsay") |
| Maturity | 1,204★, last push 2026-05-26. **Marked legacy** — see below |

WhiteboxTools has "advanced tooling for spatial hydrological analysis (e.g. flow-accumulation,
watershed delineation, stream network analysis, sink removal), terrain analysis (e.g. slope,
curvatures, wetness index, hillshading; hypsometric analysis; multi-scale topographic position
analysis)" (`whitebox-tools :: README.md § 1`) — which is close to a complete list of the derived
maps `terrain-algos.md` §6 says we need.

**Licence chain — RESOLVED 2026-09-13** (this was an open question in the previous revision;
it is now closed, end to end):

| Link | Declared licence | Primary evidence |
|---|---|---|
| `jblindsay/whitebox-tools` (legacy) | **MIT** | `LICENSE.txt : 1-3` — "The MIT License (MIT) / Copyright (c) 2017-2021 John Lindsay" |
| `jblindsay/whitebox_next_gen` (successor) | **MIT OR Apache-2.0** (dual, Rust convention) | `Cargo.toml : 22` → `license = "MIT OR Apache-2.0"` under `[workspace.package]`; repo root carries **both** `LICENSE-MIT` ("MIT License / Copyright (c) 2021-2026 John Lindsay, Whitebox Geospatial Inc.") and `LICENSE-APACHE` (verbatim Apache 2.0 text) |
| `opengeos/whitebox-wasm` | **Apache-2.0** | GitHub licence API; consistent with taking the Apache arm of the dual grant |
| `opengeos/geolibre-rust` → npm `geolibre-wasm` | **MIT** | `gh api repos/opengeos/geolibre-rust --jq .license.spdx_id` → `MIT`; `npm view geolibre-wasm license` → `MIT`, `version` → `1.5.2` |

The `NOASSERTION` that GitHub reports for `whitebox_next_gen` is a **detection artefact of the two
licence files**, not a licensing ambiguity (§1.2a). Both arms of `MIT OR Apache-2.0` are
MIT-compatible, so the downstream forks each legitimately picked one arm: whitebox-wasm took
Apache-2.0, geolibre took MIT. **The chain is clean — `geolibre-wasm` is safe to ship, as a dev
dependency or otherwise.**

One residual caution that is *not* resolved: the dual grant covers the `whitebox_next_gen`
workspace. Individual crates under `crates/` inherit `license.workspace = true` unless they
override it, and the repo also contains a `crates/wblicense_core` whose *name* suggests a
commercial-licensing enforcement module for Whitebox Geospatial Inc.'s paid products. Before
vendoring any specific crate, re-read that crate's own `Cargo.toml` — **UNVERIFIED: per-crate
licence overrides were not audited in this survey.**

The *legacy* `whitebox-tools` repo is unambiguously MIT and remains fully usable; its README
states *"Please note this repo is marked as legacy. Whitebox development has moved on to Whitebox
Workflows Next Gen."*

**The browser angle, which is the interesting part.** `opengeos/whitebox-wasm` (**Apache-2.0**,
18★) is a WASM-ready fork of `whitebox_next_gen`, and `opengeos/geolibre-rust` (**MIT**, 283★,
last push 2026-08-26) publishes it to npm as **`geolibre-wasm`** (verified 2026-09-13:
`npm view geolibre-wasm version license` → `1.5.2` / `MIT`; `description` → "Pure-Rust geospatial
toolkit (whitebox_next_gen) compiled to WebAssembly (WASI) for GeoLibre's in-browser tool
execution"). Per its README it ships:

- a **browser library** (`wasm-bindgen`) with typed in-memory APIs for GeoTIFF/COG read+write,
  projections, vector, LiDAR and topology;
- a **tool runner** (WASI) exposing the whole whitebox tool registry over an in-memory `/work`
  filesystem via `@bjorn3/browser_wasi_shim`;
- "No server, no GDAL, no native install."

For Terrasmith this is a genuinely attractive *oracle*: export a field as a GeoTIFF into the WASM
tool runner, run `FillDepressions` / `D8FlowAccumulation`, and assert our TypeScript
implementation agrees. It is much weaker as a runtime dependency (WASI shim + GeoTIFF marshalling
on every evaluation is not a 60 fps path), so:

**VERDICT: port the algorithm** (from the MIT Rust source) **and use `geolibre-wasm` directly as a
test oracle.** Do not put it on the interactive evaluation path.

### 6.3 Landlab — MIT, and the right reference for landscape evolution

| | |
|---|---|
| Repo | https://github.com/landlab/landlab |
| Language | Python |
| Licence | **MIT** |
| Maturity | 440★, last push **2026-09-13**. NSF-funded, actively developed, heavily peer-reviewed |

Landlab is the academic community's modular landscape-evolution framework: flow routing (D8, D∞,
multiple-flow-direction), depression finding and lake filling, stream-power incision,
linear/nonlinear hillslope diffusion, and a large set of well-tested components — all MIT.

This is the **permissive replacement for RichDEM and fastscapelib**. Where `terrain-algos.md` §4.1
specifies the stream power law and §5 specifies flow routing, Landlab's components are the
reference implementations we are allowed to read line-by-line and port.

Specifically worth reading: `FlowAccumulator` + `DepressionFinderAndRouter` (the depression
handling that makes SPL stable), `FastscapeEroder` (the implicit Braun & Willett solver — the same
algorithm as GPL fastscapelib, but MIT here), and `LinearDiffuser`/`TaylorNonLinearDiffuser` for
hillslope/thermal behaviour.

**VERDICT: port the algorithm.**

### 6.4 Others

| Library | Licence | Note | Verdict |
|---|---|---|---|
| GDAL | MIT/X11-style | The universal raster I/O library. Relevant only if we import real DEMs. In-browser, `geotiff.js` (MIT) is lighter. | use directly (if needed) |
| [fogleman/hmm](https://github.com/fogleman/hmm) | **MIT** | 618★. Heightmap → error-bounded triangle mesh. Directly useful for the studio viewport: render a 1025² field as a few-thousand-triangle mesh with a bounded max error, instead of a million-triangle grid. | **port the algorithm** |

---

## 7. Spring / BAR-specific open source

This is the section where "prior art" means "the thing our writer must agree with".

### 7.1 pymapconv (`Beherith/springrts_smf_compiler`) — CC0, and therefore the oracle

| | |
|---|---|
| Repo | https://github.com/Beherith/springrts_smf_compiler |
| Language | Python |
| Licence | **CC0-1.0** — verified: `LICENSE` is the full "CC0 1.0 Universal / Statement of Purpose" text |
| Maturity | 14★, last push 2024-10-30. **The de-facto standard compiler for every BAR map in the pool** |

Repository layout: `.github/ LICENSE README.md build/ doc/ map_samples/ regression_tester/
resources/ src/ tools/`. Note `map_samples/` and `regression_tester/` — it ships its own
regression harness and sample maps, which we can use directly.

`src/` contains:

```
pymapconv.py                                   the compiler/decompiler
fast_decompiler.py                             fast .smf → images path
argparseui.py                                  the settings-file / GUI layer
springrts_smf_minimapper.py                    minimap generation
dds_to_jpg.py
tree_placer_springrts.py
springboard_model_lua_to_set_lua_feature_dumper.py
version.py
```

**Why CC0 matters so much here.** Three things become legal and easy at once:

1. We may **port any of its logic** into `packages/format` with no notice requirement (we should
   credit Beherith anyway — it is the decent thing, and it helps users trust the output).
2. We may **vendor its sample maps and regression corpus** into our test fixtures.
3. We may **ship a compatibility mode** that reads its `@settings` argparse files so existing
   mappers' project trees keep working — see `docs/research/toolchain.md` §3.6.

**VERDICT: use directly.** Concretely: (a) build a CI job that compiles the same inputs with
pymapconv and with Terrasmith and diffs the `.smf` byte ranges field by field; (b) use
`fast_decompiler.py` to round-trip our own output back to images and compare against the fields we
fed in. This is the single highest-value test we can write, and its licence makes it free of
friction.

**What to avoid.** `toolchain.md` §0 already documents pymapconv's known defects (single-threaded;
shells out to a 2004-era `nvdxt.exe`; exact-hash-only tile dedup; silent-corruption bugs in
typemap, featurelist, featuremap-grass, and 16-bit metalmap handling; Windows-first). **Do not
treat it as an oracle for those specific paths** — treat it as an oracle for the heightmap,
header, tile-index and minimap paths where it is known-good, and as a known-bug list elsewhere.

### 7.2 The format contract that any oracle must satisfy

Quoted from the engine header so that a cross-check tool can be validated against it. Source:
`RecoilEngine :: rts/Map/SMF/SMFFormat.h` (⚠️ GPL v2+ — the *layout facts* below are format
documentation, not copied code).

> **Re-verified byte-for-byte on 2026-09-13** against
> `https://raw.githubusercontent.com/beyond-all-reason/RecoilEngine/master/rts/Map/SMF/SMFFormat.h`
> (186 lines) and `…/rts/Map/SMF/SMFMapFile.cpp`. **All field orders, types and sizes below were
> confirmed correct.** Several *line-number citations* in the previous revision were off by up to
> 8 and have been corrected here; they are flagged inline. The struct layouts themselves — the
> part the writer depends on — did not change.

**Constants** (`SMFFormat.h : 28, 31, 34` — one `static constexpr` per line, with doc-comments
between; the earlier citation "28-35" spanned a trailing blank line):

```c
static constexpr size_t SMALL_TILE_SIZE   = (512>>0) + (512>>2) + (512>>4) + (512>>6); // = 680
static constexpr size_t MINIMAP_NUM_MIPMAP = 9;
static constexpr size_t MINIMAP_SIZE       = 699048;
```

**`SMFHeader` — 80 bytes, little-endian, no padding** (`SMFFormat.h : 49-70` ✓ confirmed).
Every member is a 4-byte `int` or `float` after the 16-byte `magic`, so the offsets below are just
`16 + 4n` and there is no alignment padding on any mainstream ABI:

| Offset | Size | Type | Field | Semantics |
|---:|---:|---|---|---|
| 0 | 16 | `char[16]` | `magic` | `"spring map file\0"` (15 chars + NUL) |
| 16 | 4 | `int32` | `version` | "Must be 1 for now" |
| 20 | 4 | `int32` | `mapid` | "Sort of a GUID of the file, just set to a random value when writing a map" |
| 24 | 4 | `int32` | `mapx` | map width in **squares**. "Must be divisible by 128" |
| 28 | 4 | `int32` | `mapy` | map height in squares. Must be divisible by 128 |
| 32 | 4 | `int32` | `squareSize` | "Distance between vertices. Must be 8" (elmos) |
| 36 | 4 | `int32` | `texelPerSquare` | "must be 8 for now" |
| 40 | 4 | `int32` | `tilesize` | "Number of texels in a tile, must be 32 for now" |
| 44 | 4 | `float32` | `minHeight` | "Height value that 0 in the heightmap corresponds to" |
| 48 | 4 | `float32` | `maxHeight` | "Height value that 0xffff in the heightmap corresponds to" |
| 52 | 4 | `int32` | `heightmapPtr` | file offset → `uint16[(mapy+1)*(mapx+1)]` |
| 56 | 4 | `int32` | `typeMapPtr` | file offset → `uint8[mapy/2 * mapx/2]` |
| 60 | 4 | `int32` | `tilesPtr` | file offset → `MapTileHeader` |
| 64 | 4 | `int32` | `minimapPtr` | file offset → 699048 bytes of DXT1 + 8 mip sublevels |
| 68 | 4 | `int32` | `metalmapPtr` | file offset → `uint8[mapx/2 * mapy/2]` |
| 72 | 4 | `int32` | `featurePtr` | file offset → `MapFeatureHeader` |
| 76 | 4 | `int32` | `numExtraHeaders` | count of `ExtraHeader` records that follow |
| **80** | | | **end of header** | |

**`ExtraHeader` — 8 bytes + payload** (`SMFFormat.h : 83-86`; was cited as 82-86):
`{ int32 size; int32 type; }`. `MEH_None 0` is `#define`d at `SMFFormat.h : 91` and
`MEH_Vegetation 1` at `: 103` — they are preprocessor defines, **not an enum**, so an oracle that
looks for an `enum` will not find them. The vegetation extra header is 12 bytes:
`{ size=12, type=1, int32 grassPtr }` pointing at `uint8[mapx/4 * mapy/4]`, `0=none, 1=grass`
(`: 96-101`).

**`size` is inclusive of the 8-byte `{size,type}` prefix — this is load-bearing and was not stated
in the previous revision.** Proof from the reader, which skips an unrecognised extra header by
consuming `size - 8` further bytes:

```cpp
// RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp : 242-267   (⚠️ GPL — behaviour, not code to copy)
ifs.Seek(sizeof(SMFHeader));                       // extra headers start at offset 80
for (int a = 0; a < header.numExtraHeaders; ++a) {
    int size; int type;
    ifs.Read(&size, 4);  ifs.Read(&type, 4);
    swabDWordInPlace(size);  swabDWordInPlace(type);
    if (type == MEH_Vegetation) {
        int pos; ifs.Read(&pos, 4);  swabDWordInPlace(pos);   // <-- the 3rd int: grassPtr
        ifs.Seek(pos);
        ifs.Read(data, header.mapx / 4 * header.mapy / 4);
        return true;                              // "we arent interested in other extensions anyway"
    }
    assert((size - 8) <= (header.mapx / 4 * header.mapy / 4));
    ifs.Read(data, size - 8);                     // <-- size INCLUDES the 8-byte prefix
}
```

Three writer consequences: (1) extra headers begin at **offset 80**, immediately after
`SMFHeader`, with no alignment; (2) a vegetation header must write `size = 12`, not `4`;
(3) the engine **stops scanning at the first `MEH_Vegetation`**, so write it first if you ever
write more than one extra header, and never write two.

**`MapTileHeader` — 8 bytes** (`SMFFormat.h : **123-127**`; was cited as 118-122):
`{ int32 numTileFiles; int32 numTiles; }` — read in that order by
`CSMFMapFile::ReadMapTileHeader` (`SMFMapFile.cpp : 334-338`).
Followed by `numTileFiles` records of *(int32 tilesInThisFile, NUL-terminated filename)*, then by
`int32[mapx/4 * mapy/4]` tile indices. The header's own comment
(`SMFFormat.h : **119-121**`; was cited as 113-116) spells the index-array size out verbatim:
"After this follows an `int[mapx*texelPerSquare/tileSize * mapy*texelPerSquare/tileSize]` (this is
`int[mapx/4 * mapy/4]` with currently hardcoded texelPerSquare=8 and tileSize=32) which are
indices to the defined tiles." The comment at `: 115-117` also fixes the **numbering rule across
files**: "Each file defines as many tiles the int indicates with the following files starting
where the last one ended so if there is 2 files with 100 tiles each the first defines 0-99 and the
second 100-199" — i.e. tile indices are **global and contiguous across `.smt` files**, not
per-file. And `: 111-113`: the engine "prepends the filename with `maps/`" before the VFS lookup,
which is why the stored name must be a bare filename (see gotcha 5 below).

**`MapFeatureHeader` — 8 bytes** (`SMFFormat.h : **135-139**`; was cited as 127-131):
`{ int32 numFeatureType; int32 numFeatures; }`, followed by `numFeatureType` NUL-terminated
type-name strings, then `numFeatures` × `MapFeatureStruct`.

**`MapFeatureStruct` — 24 bytes** (`SMFFormat.h : **148-157**`; was cited as 147-156). Field
*order* independently confirmed from the reader, which reads them sequentially
(`SMFMapFile.cpp : 325-330`): `featureType` via `ReadInt`, then `xpos`, `ypos`, `zpos`,
`rotation`, `relativeSize` each via `ReadFloat`:

| Offset | Size | Type | Field | Semantics |
|---:|---:|---|---|---|
| 0 | 4 | `int32` | `featureType` | index into the type-name string list |
| 4 | 4 | `float32` | `xpos` | X |
| 8 | 4 | `float32` | `ypos` | **Y = height** ("Y coordinate of the feature (height)") |
| 12 | 4 | `float32` | `zpos` | Z |
| 16 | 4 | `float32` | `rotation` | "(-32768..32767 for full circle)" — note: a **float** holding what reads like a 16-bit angle |
| 20 | 4 | `float32` | `relativeSize` | "Not used at the moment keep 1" |

**`TileFileHeader` (.smt) — 32 bytes** (`SMFFormat.h : **175-183**`). Read order confirmed from
`CSMFMapFile::ReadMapTileFileHeader` (`SMFMapFile.cpp : 341-348`): 16 raw bytes of `magic`, then
`version`, `numTiles`, `tileSize`, `compressionType` as four ints:

| Offset | Size | Type | Field | Semantics |
|---:|---:|---|---|---|
| 0 | 16 | `char[16]` | `magic` | `"spring tilefile\0"` |
| 16 | 4 | `int32` | `version` | must be 1 |
| 20 | 4 | `int32` | `numTiles` | tiles in this file |
| 24 | 4 | `int32` | `tileSize` | must be 32 |
| 28 | 4 | `int32` | `compressionType` | "Must be 1 (= dxt1) for now" |
| **32** | | | **end of header** | tiles follow back-to-back, 680 B each |

**Height decode — the divisor is 65536.** The engine computes the scale as
`(maxHgt - minHgt) / 65536.0f` and passes it as the `mod` argument to `ReadHeightmap`:

```cpp
// RecoilEngine :: rts/Map/SMF/SMFReadMap.cpp : 157   (verified verbatim 2026-09-13)
mapFile.ReadHeightmap(cornerHeightMapSyncedData, cornerHeightMapUnsyncedData,
                      minHgt, (maxHgt - minHgt) / 65536.0f);
```

and the receiving loop applies it as a plain affine map:

```cpp
// RecoilEngine :: rts/Map/SMF/SMFMapFile.cpp : 129-134
for (int i = 0; i < len; ++i) {
    ifs.Read(&word, sizeof(word));
    sHeightMap[i] = base + swabWord(word) * mod;   // base = minHgt, mod = (maxHgt-minHgt)/65536
    uHeightMap[i] = sHeightMap[i];
}
```

so `height = minHeight + raw * (maxHeight - minHeight) / 65536`. Any oracle that uses 65535 is
wrong and will disagree with us by up to one part in 65536 — small, but it is a real, reproducible
divergence and it is worth asserting on explicitly in the cross-check test.

**Two further facts the writer must not miss, both new in this revision:**

1. **`minHgt`/`maxHgt` are not necessarily the header's values.** `SMFReadMap.cpp : 146-147`:
   ```cpp
   const float minHgt = mapInfo->smf.minHeightOverride ? mapInfo->smf.minHeight : header.minHeight;
   const float maxHgt = mapInfo->smf.maxHeightOverride ? mapInfo->smf.maxHeight : header.maxHeight;
   ```
   `mapinfo.lua`'s `smf.minHeight` / `smf.maxHeight` **override the binary header** when present
   (see `docs/research/mapinfo-lua.md`). A byte-level oracle comparison against pymapconv tests
   the header; an in-engine visual comparison tests header *and* override together. If Terrasmith
   emits both, the two must agree or the map will load at a different vertical scale than the
   preview showed.
2. **The file is little-endian by construction, and the engine byte-swaps on read.**
   `swabWord` / `swabDWord` / `swabFloat` (`SMFMapFile.cpp : 108, 251-252, 274-289`) are no-ops on
   little-endian hosts. Write LE; never write native-endian and hope.

### 7.3 Minimap size — the derivation, so an oracle can be checked

`MINIMAP_SIZE = 699048` is a hard constant regardless of map size. It is 1024×1024 DXT1 plus 8 mip
sublevels, i.e. 9 levels, at 8 bytes per 4×4 block:

| Level | Dimensions | Blocks | Bytes |
|---|---|---:|---:|
| 0 | 1024×1024 | 256×256 = 65,536 | 524,288 |
| 1 | 512×512 | 128×128 = 16,384 | 131,072 |
| 2 | 256×256 | 64×64 = 4,096 | 32,768 |
| 3 | 128×128 | 32×32 = 1,024 | 8,192 |
| 4 | 64×64 | 16×16 = 256 | 2,048 |
| 5 | 32×32 | 8×8 = 64 | 512 |
| 6 | 16×16 | 4×4 = 16 | 128 |
| 7 | 8×8 | 2×2 = 4 | 32 |
| 8 | 4×4 | 1×1 = 1 | 8 |
| | | **Total** | **699,048** ✓ |

And `SMALL_TILE_SIZE`: a 32×32 DXT1 tile with 4 mip levels =
512 (32×32) + 128 (16×16) + 32 (8×8) + 8 (4×4) = **680 bytes** ✓, matching
`(512>>0)+(512>>2)+(512>>4)+(512>>6)`.

### 7.4 Worked size calculation — a 16×16 BAR map

The canonical BAR map size. Every number below is derived from the layout above; use it as the
expected-size assertion in the writer's tests.

**Given.** A "16×16" map is 16×16 *Spring map units* of 512 elmos, i.e. **8192 × 8192 elmos**.

```
squareSize      = 8                            (SMFHeader, fixed)
mapx            = 8192 / 8      = 1024         squares  (1024 % 128 == 0 ✓)
mapy            = 8192 / 8      = 1024         squares
texelPerSquare  = 8                            (fixed)
tilesize        = 32                           (fixed)
texture width   = mapx * 8      = 8192         texels
tiles across    = 8192 / 32     = 256          = mapx/4 ✓
```

**`.smf` component sizes:**

| Component | Formula | Bytes |
|---|---|---:|
| `SMFHeader` | fixed | 80 |
| `ExtraHeader` (vegetation, optional) | `size = 12` | 12 |
| Heightmap | `(mapx+1) * (mapy+1) * 2` = 1025 × 1025 × 2 | 2,101,250 |
| Typemap | `(mapx/2) * (mapy/2)` = 512 × 512 | 262,144 |
| `MapTileHeader` | fixed | 8 |
| Tile-file record | `4 + strlen("MyMap.smt") + 1` = 4 + 9 + 1 | 14 |
| Tile index array | `(mapx/4) * (mapy/4) * 4` = 256 × 256 × 4 | 262,144 |
| Minimap | constant | 699,048 |
| Metalmap | `(mapx/2) * (mapy/2)` = 512 × 512 | 262,144 |
| Grass map (if vegetation header present) | `(mapx/4) * (mapy/4)` = 256 × 256 | 65,536 |
| `MapFeatureHeader` | fixed | 8 |
| Feature type names | Σ `strlen(name)+1` — say 6 names × ~16 B | ~96 |
| Feature records | `numFeatures * 24` — say 3,000 trees/rocks | 72,000 |
| **Total `.smf`** | | **3,724,484 B = 3.5519 MiB** |

*(Every row and both totals were re-added independently during the 2026-09-13 fact-check and are
correct: 80+12+2,101,250+262,144+8+14+262,144+699,048+262,144+65,536+8+96+72,000 = 3,724,484.)*

Without the vegetation extra header, the grass map and any features (but keeping the empty
`MapFeatureHeader`, which is always written) it is **3,586,840 B = 3.4207 MiB** — the number to
assert on for a bare map. (3,724,484 − 12 − 65,536 − 72,000 − 96 = 3,586,840 ✓ re-derived.)

⚠️ **This is a *layout* total, not a file size.** It assumes the writer packs the sections
back-to-back with no gaps and no alignment padding. Nothing in `SMFFormat.h` requires that — every
section is reached through an explicit `*Ptr` file offset, so a writer is free to pad, and
pymapconv's output may or may not. **UNVERIFIED — needs confirmation: whether pymapconv emits a
byte-exact 3,586,840-byte bare `.smf` was not tested during this survey.** Treat the number as the
*expected sum of section sizes*, assert on it that way (sum of section lengths, and that each
`*Ptr` lands where the layout says), and only promote it to a file-size assertion after the first
successful pymapconv diff.

**`.smt` size:**

```
tile slots        = 256 * 256 = 65,536
no dedup          : 32 + 65,536 * 680 = 44,564,512 B = 42.50 MiB
50% dedup         : 32 + 32,768 * 680 = 22,282,272 B = 21.25 MiB
typical BAR map   : 15,000–40,000 unique tiles → 9.7–25.9 MiB
```

**Gotchas that an oracle comparison will surface** (all already documented in
`docs/research/smf-format.md` / `smt-format.md`, repeated here as the checklist for the
cross-check job):

1. **65536, not 65535**, in the height decode (§7.2). A tool that uses 65535 is wrong.
2. **Heightmap is `(mapx+1) × (mapy+1)`** — corner-sampled, not square-sampled. Off-by-one here
   produces a map that loads and looks subtly sheared.
3. **`mapx`/`mapy` must be multiples of 128** because terrain is drawn in 128×128-square patches.
4. **Tiles must use the opaque 4-colour BC1 mode** (`color0 > color1`). The punch-through mode
   renders those texels transparent in game. Many DXT1 encoders emit punch-through blocks for
   fully-opaque input; ours must not.
5. **The `.smt` filename is stored as a bare filename inside the `.smf`.** Renaming the `.smt`
   after compiling without fixing the recorded name produces the famous pink map.
6. **The `.sd7` must not be a solid 7z** (`7z a -ms=off`) or Spring cannot see the map. BAR's CI
   asserts this (`maps-metadata :: scripts/js/src/check_archive_not_solid.ts`).
7. **`MapFeatureStruct.rotation` is a `float32` carrying a value documented in the -32768..32767
   range.** Do not write it as an int16.

### 7.5 Other Spring map tooling

| Repo | Lang | Licence | Last push | What it is | Verdict |
|---|---|---|---|---|---|
| [enetheru/smf_tools](https://github.com/enetheru/smf_tools) | C++ | **NONE declared** | 2023-11-30 | Cross-platform SMF/SMT compiler. Root listing has no `LICENSE`. Depends on OpenImageIO, libsquish, Boost. Its `makemap.sh` is a good reference for the boilerplate archive layout. | **avoid (licence)** for code; fine as a runtime oracle |
| [BrainDamage/MapConv](https://github.com/BrainDamage/MapConv) | C++ | none | 2009-10-07 | The original cross-platform C++ compiler. Dead. O(n²) lossy tile matching, pinstriping artefacts, requires `-i` heightmap flip. | avoid (quality + licence) |
| [Beherith/smf-decompiler-springrts](https://github.com/Beherith/smf-decompiler-springrts) | — | **GPL-3.0** | 2015-11-10 | Superseded by `fast_decompiler.py` in the CC0 pymapconv repo. | **avoid (GPL)** — use the CC0 one |
| [Spring-SpringBoard/SpringBoard-Core](https://github.com/Spring-SpringBoard/SpringBoard-Core) | Lua | **MIT** | **2026-08-19** | The in-engine Spring map/scenario editor. Still maintained. Docs at springboard-core.readthedocs.io. | **read for architecture** |
| [SpliFF/upspring](https://github.com/SpliFF/upspring) | C++ | "other" | 2023-02-04 | 3DO/S3O model editor. Relevant only if we ever generate custom feature models; for placing *existing* features it is irrelevant. | read (if needed) |
| [beyond-all-reason/maps-metadata](https://github.com/beyond-all-reason/maps-metadata) | TS | — | active | The JSON schema + CI for BAR's curated map pool (startboxes, metal spots, tags). **This is a hard requirement for the export target**, not prior art to borrow from. | use directly (as a target schema) |
| [dogpool/BAR_SpringRTS_Mapping_Kit](https://github.com/dogpool/BAR_SpringRTS_Mapping_Kit) | Python | none | 2025-06-26 | "All-in-one Map Development kit for BAR because Beherith's Advanced RTS Mapping document is 65 pages long". Read it as **evidence of the user problem we are solving**. | read (as product research) |
| [qknight/springrts.com-random-map-generator](https://github.com/qknight/springrts.com-random-map-generator) | C++ | none | 2011-10-03 | A Qt procedural map generator for Spring. Dead. Historical interest only. | avoid |

**On SpringBoard-Core (MIT).** It is the only existing *editor* with real BAR/Spring domain
knowledge, and its architecture is instructive precisely because of its central flaw: it runs
*inside* the Spring engine, so it gets perfect fidelity (real pathfinding, real units, real
rendering) at the cost of needing a launcher-side host process to compile anything, and of being
unusable by anyone who has not installed Spring. Terrasmith takes the opposite trade — run
anywhere, model the engine's rules explicitly — which means SpringBoard's *model of what a map
editor must know* (`scen_edit/`, `Gamedata/`, `templates/`) is worth mining even though none of
its code is.

---

## 8. Texture and asset sources for a default material library

The goal from `ARCHITECTURE.md`: ship templates that produce "a texture that does not look like a
photograph of noise". That needs a curated, permissively-licensed library of tileable terrain
detail textures.

### 8.1 The CC0 sources — verified

| Source | Licence | Verified statement | Scale | API |
|---|---|---|---|---|
| **[ambientCG](https://ambientcg.com)** | **CC0 1.0 Universal** | `docs.ambientcg.com/license/`: *"You can copy, modify, distribute and perform the assets, even for commercial purposes, all without asking permission."* Attribution **not required**; suggested credit line is *"Created using &lt;asset name&gt; from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License."* No exceptions noted. | **2,010 materials** (API `numberOfResults`, 2026-09-13) | `https://ambientcg.com/api/v2/full_json?type=Material&q=<term>&limit=&offset=` and `…/api/v2/downloads_csv` |
| **[Poly Haven](https://polyhaven.com)** | **CC0 1.0** | `polyhaven.com/license`: *"You can use our assets for any purpose, including commercial work. You do not need to give credit or attribution when using them."* | **859 textures**, of which **129 tagged `terrain`** | `https://api.polyhaven.com/assets?type=textures&categories=terrain`, `…/categories/textures`, `…/info/<id>`, `…/files/<id>` |
| **[3dtextures.me](https://3dtextures.me)** | **CC0** | `3dtextures.me/about/`: textures are CC0, *"These textures no longer belong to me. They belong to the public."* May be redistributed and included in projects; only restriction is not claiming authorship. | ~1,000+ seamless PBR sets | no formal API |
| **[Kenney](https://kenney.nl)** | **CC0 1.0** | Site-wide CC0 across all asset packs. | large, but stylised/low-res — mostly not terrain-detail useful | — |

### 8.2 What is actually available for terrain

**ambientCG, by search term** (queries run 2026-09-13 against `api/v2/full_json?type=Material`):

| Query | Matching materials |
|---|---:|
| `Ground` | **168** |
| `Dirt` | 113 |
| `Sand` | 83 |
| `Rock` | 76 |
| `Gravel` | 66 |
| `Cliff` | 52 |
| `Moss` | 49 |
| `Snow` | 28 |
| `Soil` | 16 |
| `Grass` | 15 |
| `Terrain` | 0 (not a term they use — search by material, not by role) |

Downloads come as zips at fixed resolution tiers from
`https://ambientCG.com/get?file=<AssetId>_<Tier>.zip`. The tier set is larger than the previous
revision implied: **`1K/2K/4K/8K` × `JPG/PNG`** (plus EXR/PBR variants per asset).

⚠️ **Correction.** The previous revision attributed specific sizes to "the first row of
`downloads_csv` (`AcousticFoam001`)". That is wrong on both counts: the CSV is **not stably
ordered** (the first row on 2026-09-13 was `Ground111`), and `AcousticFoam001` could not be
retrieved to confirm those byte counts. Replaced with a measured distribution over a 600-row
sample of `https://ambientcg.com/api/v2/downloads_csv?limit=600` (2026-09-13):

| Tier | n | mean | min | max |
|---|---:|---:|---:|---:|
| `1K-JPG` | 518 | **6.6 MB** | 1.4 MB | 11.1 MB |
| `2K-JPG` | 520 | 22.7 MB | 2.1 MB | 39.9 MB |
| `4K-JPG` | 520 | 86.2 MB | 5.5 MB | 160.9 MB |

Exact verified row (`Ground111`): 1K-JPG = 9,761,806 B · 2K-JPG = 34,401,646 B ·
4K-JPG = 128,830,539 B · 8K-JPG = 483,894,133 B · 1K-PNG = 20,316,735 B.

So **ship 1K, offer 2K**, and never bundle 4K or 8K — and note that a "1K pack" is 6-7 MB because
it contains Color + Normal + Roughness + AO + Displacement, not one image. See §8.4 for what that
means once you only need the diffuse.

**Poly Haven, texture category counts** (from `api.polyhaven.com/categories/textures`):

```
all 859 · outdoor 499 · man made 428 · floor 266 · wall 243 · natural 171 · wood 137
plaster-concrete 133 · terrain 129 · rock 124 · dirty 115 · brick 107 · concrete 80
indoor 76 · sand 60 · raw wood 54 · clean 50 · fabric 43 · cobblestone 37 · road 36
plaster 32 · aerial 30 · metal 25 · bark 23 · roofing 23
```

The **`aerial` tag (30 assets)** deserves special attention: `aerial_beach_01/02/03`,
`aerial_grass_rock`, `aerial_ground_rock`, `aerial_mud_1`, `aerial_rocks_01/02/04`, `aerial_sand`,
`aerial_wood_snips` and friends are **photographed from above**, which is exactly the projection a
top-down RTS map texture needs. A ground texture shot at a 45° angle has baked-in perspective and
lighting that reads wrong when tiled across a BAR map viewed from overhead. **Prefer the `aerial`
set for the default library.**

### 8.3 Sources to be careful with

- **Textures.com** — **not CC0.** Its licence restricts redistribution, caps downloads, and
  forbids including the raw files in a distributed product in many cases. **Do not ship its
  assets.**
- **FreePBR.com** — custom licence, not CC0; historically has forbidden redistribution of the
  files themselves. Check per-asset; default to not shipping.
- **Poly Haven's *code*** — `polyhavenassets` is GPL-3.0 and `Public-API` is AGPL-3.0 (§1.2). The
  assets are CC0; the tooling is not. Write our own downloader.
- **OpenGameArt** — mixed licensing per submission (CC0, CC-BY, CC-BY-SA, GPL). Only use assets
  explicitly marked CC0, and record the asset ID.

### 8.4 Recommended plan for the shipped library

1. **Curate ~24 materials**, not 2,000: roughly 4 rock/cliff, 4 grass, 3 sand/beach, 3 dirt/mud,
   2 gravel/scree, 2 snow, 2 moss, 2 lava/volcanic, 2 arid/cracked — enough to cover BAR's map
   moods (temperate, desert, arctic, volcanic, alien) without a browsing problem.
2. **Prefer Poly Haven's `aerial` set** where it covers the need (§8.2), ambientCG otherwise.
3. **Ship at 1K, tileable, as BC1/DXT1 or as PNG converted at build time.** BAR's diffuse is DXT1
   tiles anyway; there is no value in shipping 4K source.

   **The bundle-vs-download question, with real numbers (this was an open question; it is now
   answerable).** The "~100-150 MB for 24 materials" estimate in the previous revision was an
   estimate of the wrong quantity — it sized *full PBR packs*:

   | What you ship, ×24 materials at 1K | Size | Source |
   |---|---:|---|
   | ambientCG full 1K-JPG packs (Color+Normal+Rough+AO+Disp) | ≈ **158 MB** | 24 × 6.6 MB measured mean |
   | Diffuse JPEG only | ≈ **19 MB** | 24 × ~0.79 MB (Poly Haven `aerial_rocks_02` Diffuse 1K JPG = 785,923 B, verified) |
   | Diffuse as DXT1/BC1 1024², ready to tile | **12.0 MiB** | 24 × (1024·1024/2) = 24 × 524,288 B |

   BAR's `.smf` diffuse path consumes **one colour image per material** and compresses it to DXT1
   anyway, so the shippable artefact is the third row: **12 MiB for the whole default library**.
   That is small enough to bundle in *every* distribution channel, web included, and it removes
   the first-run-download design entirely. Ship the normal/roughness maps only if and when a
   feature actually needs them, and make *those* the optional download.
4. **Record provenance per asset** in a manifest (`source`, `assetId`, `url`, `license: "CC0-1.0"`,
   `retrieved`), even though CC0 does not require it. It costs nothing, it lets us regenerate the
   library, and it is what a downstream user will ask for when their own project has a licence
   audit.
5. **Write our own fetch script** against the two public APIs (§8.1) rather than vendoring
   anyone's downloader (§8.3).

---

## 9. Master verdict table

Legend: **U** = use directly · **P** = port the algorithm · **R** = read for architecture ·
**X** = avoid.

| Project | URL | Lang | Licence | Last commit | Maturity | Verdict | One-line reason |
|---|---|---|---|---|---|---|---|
| Gaffer | github.com/GafferHQ/gaffer | C++/Py | BSD-3 | 2026-09-12 | 1,092★, production since ~2011 | **R** | The two-tier hash/compute cache + hashed `Context` is exactly our problem, solved |
| Material Maker | github.com/RodZill4/material-maker | GDScript | MIT | 2026-08-06 | 5,914★, mature | **R** | Shader-fusion model; typed ports as data; the 5-state buffer machine |
| MaterialX | github.com/AcademySoftwareFoundation/MaterialX | C++ | Apache-2.0 | 2026-09-11 | 2,255★, ASWF | **U** | The nodedef schema (ui*, units, versioning) we would otherwise reinvent badly |
| reactively | github.com/milomg/reactively | TS | MIT | 2025-12-10 | 547★, 340 LOC | **P** | Clean/check/dirty in TypeScript, correct on diamonds |
| salsa | github.com/salsa-rs/salsa | Rust | **Apache-2.0 OR MIT** (dual; both `LICENSE-APACHE` and `LICENSE-MIT` present — GitHub surfaces only Apache-2.0) | 2026-09-12 | 2,963★ | **R** | Red-green revision model; the rigorous version of the same idea |
| incremental | github.com/janestreet/incremental | OCaml | MIT | 2026-07-10 | 1,510★ | **R** | Height-ordered propagation; the academic reference |
| Blender geometry nodes | github.com/blender/blender | C++ | **GPL-2.0+** | daily | huge | **R** ⚠️ | `ValueUsage{Used,Maybe,Unused}` laziness — concept only, never code |
| ComfyUI | github.com/Comfy-Org/ComfyUI (was comfyanonymous/…) | Py | **GPL-3.0** | daily | 132,841★ | **R** ⚠️ | `IS_CHANGED`/`NOT_IDEMPOTENT` escape hatches good; O(n²) key is the anti-pattern |
| TerraForge3D | github.com/Jaysmito101/TerraForge3D | C++ | MIT | 2026-08-29 | 1,227★ | **R** | Module decomposition; heightfield pyramid; async readback |
| NodeGraphProcessor | github.com/alelievr/NodeGraphProcessor | C# | MIT | 2025-09-22 | 2,694★ | **R** | Compiled linear schedule — the right shape for the *build* path |
| Procedural-Worlds-Editor | github.com/alelievr/Procedural-Worlds-Editor | C# | MIT | 2018-09-15 | 286★, abandoned | **R** | Node-terrain catalog reference only |
| MapMagic 2 | gitlab.com/denispahunov/mapmagic | C# | **Unity EULA** | active | commercial | **X** | Not open source despite the free price and included source |
| React Flow (xyflow) | github.com/xyflow/xyflow | TS | MIT | 2026-09-10 | 38,353★ | **U** | The editor canvas for `apps/studio` |
| Rete.js | github.com/retejs/rete | TS | MIT | 2026-09-13 | 12,251★ | **R** | Good editor, weaker engine than §4 |
| litegraph.js | github.com/jagenjo/litegraph.js | JS | MIT | 2024-08-01 | 8,134★, stale | **X** | Stale upstream; the `Comfy-Org` fork self-declares "⛔ ARCHIVED", last push 2026-01-14 (GitHub `archived` flag is still false) |
| NodeGraphQt | github.com/jchanvfx/NodeGraphQt | Py | MIT | 2026-03-11 | 1,822★ | **R** | Interaction design (search palette, port snapping, group nodes) |
| SebLague/Hydraulic-Erosion | github.com/SebLague/Hydraulic-Erosion | C# | MIT | 2024-01-04 | 1,041★ | **P** | Droplet erosion + precomputed brush + the canonical defaults |
| terrain-erosion-3-ways | github.com/dandrino/terrain-erosion-3-ways | Py | MIT | 2022-11-22 | 944★ | **P** | Pipe-model sim, **river-network generator**, area-scaled parameters |
| erodr | github.com/henrikglass/erodr | C | MIT | 2025-06-16 | 58★ | **P** | Closest to Beyer's thesis; C ports cleanly; live-preview UX |
| SimpleHydrology | github.com/weigert/SimpleHydrology | C++ | **NONE** | 2023-03-20 | 745★ | **X** ⚠️ | No licence = all rights reserved. Read nickmcd.me blog instead |
| SimpleErosion | github.com/weigert/SimpleErosion | C++ | **NONE** | 2020-04-20 | 130★ | **X** ⚠️ | Same |
| Interactive-Erosion-Simulator-on-GPU | github.com/Huw-man/… | C++ | **NONE** | 2021-02-16 | 26★ | **X** ⚠️ | Same. Its `docs/` are readable |
| UnityTerrainErosionGPU | github.com/bshishov/UnityTerrainErosionGPU | C#/HLSL | MIT | 2020-03-28 | 155★ | **P** | Shallow-water-equation compute shaders → WGSL, race-free |
| Hydra (Blender) | github.com/ozikazina/Hydra | Py/GLSL | MIT | 2025-11-17 | 39★ | **P** | Recent, maintained, GPU erosion wired into a real tool |
| terraingen | github.com/Ono-Sendai/terraingen | C++ | MIT | 2026-07-26 | 55★ | **P** | Active GPU terrain + erosion |
| TinyErode | github.com/Sondro/TinyErode | C++ | MIT | 2021-06-14 | fork | **P** | Header-only, portable; vendored by TerraForge3D |
| bevy-hydrology | github.com/evroon/bevy-hydrology | Rust | MIT | 2026-07-28 | 13★ | **P** | MIT reimplementation of the SimpleHydrology technique |
| jobtalle/HydraulicErosion | github.com/jobtalle/HydraulicErosion | JS | MIT | 2020-06-14 | 39★ | **P** | Browser-native reference |
| RichDEM | github.com/r-barnes/richdem | C++ | **GPL-3.0** | 2024-06-24 | 324★ | **X** ⚠️ | Read Barnes's priority-flood papers instead |
| TauDEM | github.com/dtarb/TauDEM | C++ | **GPL-3.0** | 2026-07-24 | 275★ | **X** ⚠️ | Read Tarboton 1997 instead |
| pysheds | github.com/pysheds/pysheds | Py | **GPL-3.0** | 2026-09-02 | 899★ | **X** ⚠️ | GPL |
| fastscapelib | github.com/fastscape-lem/fastscapelib | C++ | **GPL-3.0** | 2026-09-07 | 46★ | **X** ⚠️ | Use Landlab's MIT `FastscapeEroder` instead |
| WhiteboxTools | github.com/jblindsay/whitebox-tools | Rust | MIT | 2026-05-26 | 1,204★, legacy-marked | **P** | The permissive hydrology toolbox |
| whitebox_next_gen | github.com/jblindsay/whitebox_next_gen | Rust | **MIT OR Apache-2.0** (`Cargo.toml : 22`; API says `NOASSERTION`) | 2026-08-31 | 98★ | **P** | The maintained successor; dual grant is clean, per-crate overrides unaudited |
| whitebox-wasm | github.com/opengeos/whitebox-wasm | Rust | Apache-2.0 | 2026-08-26 | 18★ | **U** | The WASM fork geolibre publishes |
| godot_heightmap_plugin | github.com/Zylann/godot_heightmap_plugin | GDScript | **MIT** (API says `NOASSERTION`) | 2026-07-30 | 2,267★ | **R** | ⚠️ Previously mis-listed as GPL. Godot terrain chunking/LOD reference, and it is usable |
| geolibre-wasm | npm / github.com/opengeos/geolibre-rust | Rust→WASM | MIT | 2026-08-26 | 283★ | **U** | Whitebox in the browser — as a *test oracle*, not a runtime dep |
| Landlab | github.com/landlab/landlab | Py | MIT | 2026-09-13 | 440★, NSF | **P** | MIT flow routing, depression handling, stream-power incision |
| hmm | github.com/fogleman/hmm | C | MIT | 2023-12-19 | 618★ | **P** | Error-bounded heightmap → mesh for the viewport |
| FastNoiseLite | github.com/Auburn/FastNoiseLite | multi | MIT | 2026-06-21 | 3,504★ | **P** | GLSL/HLSL variants convert straight to WGSL |
| OpenSimplex2 | github.com/KdotJPG/OpenSimplex2 | Java | **CC0** | 2024-01-29 | 701★ | **P** | Public domain; no obligation at all |
| pymapconv | github.com/Beherith/springrts_smf_compiler | Py | **CC0-1.0** | 2024-10-30 | 14★, **the** BAR standard | **U** | Byte-for-byte oracle *and* portable code, with zero licence friction |
| smf_tools | github.com/enetheru/smf_tools | C++ | **NONE** | 2023-11-30 | 4★, **archived** | **X** | No licence, repo archived so none is coming; use as a black-box runtime oracle only |
| SpringBoard-Core | github.com/Spring-SpringBoard/SpringBoard-Core | Lua | MIT | 2026-08-19 | 14★ | **R** | The only editor with real Spring domain knowledge |
| RecoilEngine | github.com/beyond-all-reason/RecoilEngine | C++ | **GPL-2.0+** (API says `NOASSERTION`; `LICENSE : 5-8` says GPL v2-or-later — §1.2a) | daily | 676★ | **R** ⚠️ | Ground truth for format *facts*; never copy code |
| maps-metadata | github.com/beyond-all-reason/maps-metadata | TS | **Apache-2.0** (verified; was "—") | active | — | **U** | The metadata schema our export must satisfy |
| ambientCG | ambientcg.com | — | **CC0-1.0** | live | 2,010 materials (API `numberOfResults`, re-verified 2026-09-13) | **U** | Default material library |
| Poly Haven | polyhaven.com | — | **CC0-1.0** | live | 859 textures / 129 terrain | **U** | Default material library — prefer the `aerial` set |
| 3dtextures.me | 3dtextures.me | — | **CC0** | live | ~1,000+ | **U** | Supplementary |

---

## 10. What this means for Terrasmith — concrete decisions

1. **Implement `packages/graph` as §4.** Two caches (hash cache count-bounded, value cache
   byte-bounded), recursive content hashes, pull-based evaluation, an in-flight promise map, and
   `EvalContext` carrying resolution. Do not invent a fourth design.
2. **Make resolution a context value, never a node parameter.** This is what makes preview and
   build the same code path and the same graph, which is the property `ARCHITECTURE.md` is built
   around.
3. **Build Gaffer's `Checked` mode on day one**, behind an env var, and run it in CI over every
   template graph. Stale-cache bugs are otherwise the most expensive class of bug this project can
   have.
4. **Give nodes a declared cache policy** (`uncached` / `cached` / `collaborative`) and an optional
   `inputUsage()` for laziness. Both are cheap to add now and impossible to retrofit cleanly.
5. **Model the node-definition type on MaterialX's `<nodedef>`**, including `uisoftmin`/`uisoftmax`,
   `uiadvanced`, `uifolder`, `unittype`/`unit` (elmos), and `version`/`isdefaultversion`. Guided
   mode then falls out as "render only `uiadvanced: false` parameters", and graph migration falls
   out as nodedef versioning.
6. **Per-node state machine with five states**, including Material Maker's `UpdatingInvalidated`.
   Debounce parameter commits at ~60–120 ms.
7. **Erosion parameters are densities and world distances**, following
   `terrain-erosion-3-ways`'s `rain_rate = 0.0008 * cell_area` and `iterations = 1.4 * dim`. Port
   the droplet algorithm from Lague/erodr for CPU, the shallow-water formulation from
   `UnityTerrainErosionGPU` for WebGPU.
8. **Add a river-network generator node** based on `dandrino/river_network.py` (MIT). It gives
   correct drainage by construction, in preview-latency time, and is a better default than "run
   erosion until it looks right".
9. **Hydrology analysis (depression fill, flow accumulation, wetness) ports from Landlab and
   WhiteboxTools (both MIT)** — never from RichDEM, TauDEM, pysheds or fastscapelib.
10. **Set up the pymapconv cross-check job now**, while `packages/format` is small. CC0 licensing
    means there is no reason not to, and it is the only way to be confident the writer is
    engine-correct without loading BAR for every test.
11. **Curate ~24 CC0 materials** (§8.4), preferring Poly Haven's `aerial` set, ship at 1K with a
    provenance manifest, and write our own fetch script.
12. **Never** vendor: SimpleHydrology/SimpleErosion/Huw-man (no licence), smf_tools (no licence),
    MapMagic (EULA), RichDEM/TauDEM/pysheds/fastscapelib/ComfyUI/Blender/Natron/FilterJS (GPL),
    Poly Haven's own tooling (GPL/AGPL).

---

## Appendix A — verification commands

Every licence claim in this document can be re-checked:

```bash
# licence, language, stars, last push, archived state
gh api repos/<owner>/<repo> --jq '"\(.full_name) | \(.license.spdx_id // "NONE") | \(.language) | \(.stargazers_count)* | pushed \(.pushed_at[0:10]) | archived=\(.archived)"'

# 404 here means NO LICENCE = all rights reserved
gh api repos/weigert/SimpleHydrology/license

# read the actual licence text, never trust the badge
curl -sL https://raw.githubusercontent.com/<owner>/<repo>/master/LICENSE | head -20

# asset library counts
curl -s "https://ambientcg.com/api/v2/full_json?type=Material&q=Ground&limit=1" | jq .numberOfResults
curl -s "https://api.polyhaven.com/categories/textures" | jq '.terrain, .rock, .sand'
```

## Appendix B — files fetched during this survey

For reproducibility, the exact sources read:

| File | Repo | Used for |
|---|---|---|
| `src/Gaffer/ValuePlug.cpp` (1,197 lines) | GafferHQ/gaffer | §3.1 hash/compute cache, HashCacheKey, cache limits |
| `include/Gaffer/ValuePlug.h` (279 lines) | GafferHQ/gaffer | §3.1 CachePolicy, HashCacheMode, dirtyCount |
| `packages/core/src/core.ts` (338 lines) | milomg/reactively | §3.3 clean/check/dirty algorithm |
| `comfy_execution/caching.py` (613 lines), `execution.py` (1,411 lines) | comfyanonymous/ComfyUI | §3.2 cache key signature, IS_CHANGED |
| `source/blender/functions/FN_lazy_function.hh` (479 lines) | blender/blender | §3.4 ValueUsage, lazy-function model |
| `documents/Specification/MaterialX.Specification.md` (1,594 lines) | ASWF/MaterialX | §3.5 nodedef/nodegraph/input schema |
| `addons/material_maker/engine/nodes/gen_base.gd` (772 lines) | RodZill4/material-maker | §2.2.1 shader-code generation API |
| `addons/material_maker/nodes/io_types.mmt` | RodZill4/material-maker | §2.2.2 the 11 port types + conversions |
| `addons/material_maker/engine/dependencies.gd` (267 lines) | RodZill4/material-maker | §2.2.3 buffer state machine |
| `rts/Map/SMF/SMFFormat.h` (186 lines) | beyond-all-reason/RecoilEngine | §7.2 struct layouts, constants |
| `rts/Map/SMF/SMFReadMap.cpp` | beyond-all-reason/RecoilEngine | §7.2 the 65536 divisor (line 157) |
| `Assets/Scripts/Erosion.cs` (207 lines) | SebLague/Hydraulic-Erosion | §5.1 droplet parameters |
| `simulation.py` (143 lines), `river_network.py` | dandrino/terrain-erosion-3-ways | §5.2 pipe-model constants, river network |
| `LICENSE` | Beherith/springrts_smf_compiler | §7.1 CC0-1.0 confirmation |
| `license.txt` | dtarb/TauDEM | §1.2 GPL-3.0 + multi-licence note |
| `LICENSE.txt` | jblindsay/whitebox-tools | §6.2 MIT confirmation |
| `docs.ambientcg.com/license/`, `polyhaven.com/license`, `3dtextures.me/about/` | — | §8.1 CC0 confirmations |

### Appendix B.2 — additional sources fetched during the 2026-09-13 fact-check

| File / endpoint | Repo or service | Used for |
|---|---|---|
| `rts/Map/SMF/SMFMapFile.cpp` | beyond-all-reason/RecoilEngine | §7.2 reader-side confirmation of struct field order, the extra-header `size - 8` rule, the little-endian `swab*` discipline, the heightmap decode loop |
| `rts/Map/SMF/SMFReadMap.cpp : 146-147` | beyond-all-reason/RecoilEngine | §7.2 `mapinfo.lua` min/max height override |
| `LICENSE` (root) | beyond-all-reason/RecoilEngine | §1.2 GPL-2.0+ despite `NOASSERTION` |
| `LICENSE.md` | Zylann/godot_heightmap_plugin | §1.2 / §1.2a — **it is MIT** |
| `Cargo.toml`, `LICENSE-MIT`, `LICENSE-APACHE`, root listing | jblindsay/whitebox_next_gen | §6.2 — dual `MIT OR Apache-2.0` |
| `npm view geolibre-wasm version license description` | npm registry | §6.2 — v1.5.2, MIT |
| `README.md` | henrikglass/erodr | §5.3 — v2.0.0 flags and the `0.9` default |
| `river_network.py` (227 lines) | dandrino/terrain-erosion-3-ways | §5.2 — precise line refs and shipped defaults |
| `addons/material_maker/nodes/io_types.mmt` (re-read) | RodZill4/material-maker | §2.2.2 — the eleven cells that were blank |
| `contents/TerraForge3D/src`, `…/src/Base`, `…/src/Generators`, `…/Third Party License` | Jaysmito101/TerraForge3D | §2.1 — tree listing |
| `contents/src`, `contents` | Beherith/springrts_smf_compiler | §7.1 — repo layout |
| `contents/scripts/js/src` | beyond-all-reason/maps-metadata | §7.4 gotcha 6 — `check_archive_not_solid.ts`; also its Apache-2.0 licence |
| `api/v2/full_json` ×11, `api/v2/downloads_csv?limit=600` | ambientCG | §8.1-§8.2 — counts and measured pack sizes |
| `categories/textures`, `assets?categories=aerial`, `files/aerial_rocks_02` | Poly Haven API | §8.2, §8.4 — counts and per-map byte sizes |
| `gh api repos/<r>` ×66 | GitHub REST | §9 — licence, stars, last push, archived flag for every repo in this document |

---

## 11. Verification log

Adversarial fact-check pass, **2026-09-13**. Every row below was checked against a **primary
source fetched during this pass** — raw files from `raw.githubusercontent.com` via `curl`, the
GitHub REST API via `gh api`, `npm view`, or the vendor's own JSON API. Nothing in this table was
verified from memory or from a secondary write-up.

Legend: **C** = confirmed, unchanged · **F** = corrected in place · **U** = unverified, flagged
in the text.

### 11.1 Binary format claims (§7) — the ones a wrong answer breaks the product

| # | Claim | Primary source checked | Verdict |
|---|---|---|---|
| 1 | `SMFHeader` is 80 bytes; 17 fields in the order magic/version/mapid/mapx/mapy/squareSize/texelPerSquare/tilesize/minHeight/maxHeight/heightmapPtr/typeMapPtr/tilesPtr/minimapPtr/metalmapPtr/featurePtr/numExtraHeaders; offsets 0,16,20,24,28,32,36,40,44,48,52,56,60,64,68,72,76 | `RecoilEngine :: rts/Map/SMF/SMFFormat.h : 49-70` (raw fetch, 186-line file) | **C** — every offset, type and name matches; citation `49-70` was already correct |
| 2 | `SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6) = 680` | `SMFFormat.h : 28`; corroborated by the header's own prose at `: 172-173` ("exactly SMALL_TILE_SIZE (680) bytes per tile (512 + 128 + 32 + 8)") | **C** |
| 3 | `MINIMAP_NUM_MIPMAP = 9`, `MINIMAP_SIZE = 699048`; derivation 1024²→4² DXT1 = 524288+131072+32768+8192+2048+512+128+32+8 | `SMFFormat.h : 31, 34`; sum re-added | **C** — table and total both correct |
| 4 | Constants citation "`SMFFormat.h : 28-35`" | same file | **F** — they are three separate `static constexpr` lines at **28, 31, 34** |
| 5 | `ExtraHeader` = `{int32 size; int32 type;}`; vegetation header is 12 bytes `{12, 1, grassPtr}`; grass data is `uint8[mapx/4 * mapy/4]`, 0=none 1=grass | `SMFFormat.h : 83-86, 91, 96-103`; reader `SMFMapFile.cpp : 239-270` | **C** on the facts; **F** on the citation (`82-86` → `83-86`) and **gap filled**: added the proof that `size` is *inclusive of the 8-byte prefix* (`SMFMapFile.cpp : 266`, `ifs.Read(data, size - 8)`), that extra headers start at offset 80 (`: 242`, `ifs.Seek(sizeof(SMFHeader))`), and that the engine stops at the first `MEH_Vegetation` (`: 261`) |
| 6 | `MapTileHeader` = `{int32 numTileFiles; int32 numTiles;}`, 8 bytes, cited at `: 118-122`; index array comment cited at `: 113-116` | `SMFFormat.h`; reader `SMFMapFile.cpp : 334-338` | **C** on layout; **F** on both citations — struct is at **123-127**, index-array comment at **119-121**. Gap filled: tile indices are **global and contiguous across `.smt` files** (`: 115-117`), and the engine prepends `maps/` to the stored filename (`: 112`) |
| 7 | `MapFeatureHeader` = `{int32 numFeatureType; int32 numFeatures;}` cited at `: 127-131` | `SMFFormat.h` | **C** on layout; **F** on citation — struct is at **135-139** |
| 8 | `MapFeatureStruct` is 24 bytes: `int32 featureType`, then `float32` xpos/ypos/zpos/rotation/relativeSize; `ypos` is height; `rotation` is a float carrying a −32768..32767 value; cited at `: 147-156` | `SMFFormat.h : 148-157`; **field order independently re-confirmed** from the sequential reader at `SMFMapFile.cpp : 325-330` (one `ReadInt` then five `ReadFloat`) | **C** on layout and on the float-rotation gotcha; **F** on citation (147-156 → **148-157**) |
| 9 | `TileFileHeader` is 32 bytes: `char[16] magic` = `"spring tilefile\0"`, then int32 version/numTiles/tileSize/compressionType; cited `: 175-182` | `SMFFormat.h : 175-183`; reader `SMFMapFile.cpp : 341-348` | **C** on layout; **F** on citation (→ **175-183**) |
| 10 | Height decode divisor is **65536**, not 65535: `height = minHeight + raw*(maxHeight-minHeight)/65536` | `SMFReadMap.cpp : 157` (`(maxHgt - minHgt) / 65536.0f`) **and** the consuming loop `SMFMapFile.cpp : 129-134` (`sHeightMap[i] = base + swabWord(word) * mod`) | **C** — verbatim, line 157 exactly as cited. Gap filled: added the consuming loop, plus `SMFReadMap.cpp : 146-147` showing `mapinfo.lua`'s `minHeightOverride`/`maxHeightOverride` can **replace the header values**, and the `swab*` little-endian discipline |
| 11 | `magic` strings are `"spring map file\0"` / `"spring tilefile\0"`, 15 chars + NUL in `char[16]` | `SMFFormat.h : 50, 177` | **C** |
| 12 | 16×16 map ⇒ 8192 elmos ⇒ mapx=mapy=1024; `.smf` bare = 3,586,840 B, full = 3,724,484 B; `.smt` no-dedup = 44,564,512 B | arithmetic re-derived from rows 1-9 above | **C** on every figure (all rows and both totals re-added and correct). **Gap filled**: flagged that these are *sum-of-sections* totals, not necessarily file sizes, because every section is reached via an explicit `*Ptr` and padding is legal |
| 13 | Whether pymapconv actually emits a byte-exact 3,586,840-byte bare `.smf` | not tested | **U** — marked "UNVERIFIED — needs confirmation" in §7.4 |

### 11.2 Licence claims

| # | Claim | Primary source checked | Verdict |
|---|---|---|---|
| 14 | pymapconv (`Beherith/springrts_smf_compiler`) is **CC0-1.0** | raw `LICENSE` → "CC0 1.0 Universal / Statement of Purpose …"; `gh api` → `CC0-1.0`; repo exists at that exact name (the alternative spelling `Beherith/Spring_SMF_compiler` 404s) | **C** — the single most load-bearing licence fact in the document is correct |
| 15 | `Zylann/godot_heightmap_plugin` is GPL-family | raw `LICENSE.md : 1-8` — verbatim MIT grant, "Copyright (c) 2016-2020 Marc Gilleron" | **F — the one outright wrong licence in the document.** It is **MIT**. Removed from the GPL list in §1.2, added to §9, and used as the worked example in the new §1.2a |
| 16 | `jblindsay/whitebox_next_gen` licence (the researcher's #1 open question) | root listing shows `LICENSE-MIT` + `LICENSE-APACHE`; `Cargo.toml : 22` → `license = "MIT OR Apache-2.0"`; `LICENSE-MIT` header "Copyright (c) 2021-2026 John Lindsay, Whitebox Geospatial Inc." | **RESOLVED** — dual MIT/Apache-2.0. Chain to `whitebox-wasm` (Apache-2.0) and `geolibre-wasm` (MIT, `npm view` → v1.5.2) is internally consistent and clean |
| 17 | Per-crate licence overrides inside `whitebox_next_gen/crates/` (incl. the suggestively named `wblicense_core`) | not audited | **U** — flagged in §6.2 |
| 18 | `jblindsay/whitebox-tools` is MIT | raw `LICENSE.txt : 1-3` — "The MIT License (MIT) / Copyright (c) 2017-2021 John Lindsay" | **C** |
| 19 | `dtarb/TauDEM` is GPL-3.0 with a multi-licensing offer; quoted text | raw `license.txt` — GPL v3 at `: 3-5`, offer at `: 16-20`, quoted sentence verbatim | **C** on substance; **F** on line refs (`1-15`/`17-21` → `3-5`/`16-20`) |
| 20 | `RecoilEngine` is GPL-2.0-or-later | `SMFFormat.h : 1` header comment; root `LICENSE : 5-8`. **But** `gh api … --jq .license.spdx_id` → `NOASSERTION` | **C** on substance; **F** by adding the `NOASSERTION` caveat so nobody "corrects" this later |
| 21 | `weigert/SimpleHydrology`, `weigert/SimpleErosion`, `Huw-man/…`, `enetheru/smf_tools` have no licence | `gh api repos/<r>` → `license: null` for all four | **C**; **gap filled**: `enetheru/smf_tools` is additionally **archived** |
| 22 | 40+ other repo licences (Gaffer BSD-3, Material Maker MIT, MaterialX Apache-2.0, reactively MIT, ComfyUI GPL-3.0, richdem/pysheds/fastscapelib GPL-3.0, Landlab MIT, SebLague/dandrino/erodr/bshishov/Hydra/TinyErode/jobtalle/bevy-hydrology MIT, OpenSimplex2 CC0, FastNoiseLite MIT, xyflow/rete/litegraph/NodeGraphQt MIT, nged Apache-2.0, hmm MIT, Terrain3D MIT, terraingen MIT, Natron GPL-2.0, polyhavenassets GPL-3.0, Public-API AGPL-3.0, FilterJS GPL-3.0, Kry-a LGPL-2.1, aidan-clyens GPL-3.0, …) | one `gh api repos/<r> --jq '.license.spdx_id'` call per repo, 66 repos total | **C** — all matched the document |
| 23 | `maps-metadata` licence listed as "—" | `gh api` → `Apache-2.0` | **F** — gap filled |
| 24 | `Comfy-Org/litegraph.js` is "archived as of 2026-01-14" | `gh api` → `archived: false`, `pushed_at: 2026-01-14`, `description: "⛔ ARCHIVED (See README)"` | **F** — self-declared dead, but **not** GitHub-archived. Wording corrected; the practical verdict (do not depend on it) stands |
| 25 | `salsa-rs/salsa` is Apache-2.0 | root listing shows `LICENSE-APACHE` + `LICENSE-MIT` | **F** — dual-licensed; the API surfaces only Apache-2.0 |

### 11.3 Node-graph engine claims (§2-§4)

| # | Claim | Primary source checked | Verdict |
|---|---|---|---|
| 26 | Gaffer `HashCacheKey{plug, contextHash, dirtyCount}`; per-thread `Serial` hash cache + global `Parallel` backing cache; compute cache is `LRUCache<MurmurHash, ConstObjectPtr, Parallel>` with `cacheCostFunction` = `memoryUsage()` (bytes) and a 1 GiB default; `CachePolicy{Uncached, TaskCollaboration, Default}`; `HashCacheMode{Standard, Checked, Legacy}`; `dirtyCount()`; separate hash/compute policy dispatch | `src/Gaffer/ValuePlug.cpp` (1,197 lines) at `: 107-127, 236, 310-344, 456, 475, 697-703, 713-715, 562`; `include/Gaffer/ValuePlug.h` (279 lines) at `: 118-133, 157-160, 170-181, 187-196` | **C** on every structural claim, including the `Checked`-mode code. **F** on two line refs (`701-704`→`700-703`, `716`→`713-715`). **Gap filled — materially**: `ValuePlug.cpp : 714` says the 1 GiB constant "is overridden by `startup/Gaffer/cache.py`", so it is not Gaffer's chosen size. Anyone copying the number would be copying a placeholder |
| 27 | reactively's clean/check/dirty algorithm; header comment; `stale()` marks direct observers `CacheCheck`; `updateIfNecessary()` breaks early on a dirty parent; the diamond fix compares `equals(oldValue, newValue)` | `packages/core/src/core.ts` (338 lines) at `: 20-28, 44-46, 187-202, 258-269, 273-293` | **C** on the algorithm and on the `44-46`/`187-202`/`273-293` citations. **F**: the header comment was **paraphrased and misnumbered** (it is `20-28`, and reads "Each node stores a cache state to support the change propogation algorithm", not "Each reactive node tracks a cache state"); the diamond-fix block was **rewritten** rather than quoted. Both replaced with verbatim text. "340 lines" → 338 |
| 28 | ComfyUI's key is the flattened whole-ancestry signature; `sorted(inputs.keys())`; `NOT_IDEMPOTENT` / `IS_CHANGED` | `comfy_execution/caching.py` (613 lines) at `: 101-107, 109-127` | **C** — both blocks are verbatim and the line refs are exact. Repo has since moved to `Comfy-Org/ComfyUI` (noted) |
| 29 | Blender `ValueUsage{Used, Maybe, Unused}`; the lazy-function header text; `SPDX-License-Identifier: GPL-2.0-or-later` on line 3 | `source/blender/functions/FN_lazy_function.hh` (479 lines) at `: 3, 10-41, 61-76` | **C** on substance and on the SPDX line; **F** on the enum citation (`62-76` → `61-76`, the `enum class` line itself) |
| 30 | Material Maker: `Buffer` five-state enum `{Invalidated, Updating, UpdatingInvalidated, Updated, Error}` at `dependencies.gd : 6-21`; `gen_base.gd` shader-code API; the 11-entry `io_types.mmt` port-type table | `addons/material_maker/engine/dependencies.gd` (267 lines); `…/engine/nodes/gen_base.gd` (772 lines); `addons/material_maker/nodes/io_types.mmt` | **C** on the enum, the file lengths, and all five API function names (`add_global : 146`, `add_uniform : 181`, `uniforms_as_strings : 191`, `get_default_generated_shader : 226`, `get_input_shader : 482`). **F** on the port-type table: **eleven cells marked "—" are populated in the source** (`tex3d_gs`/`tex3d` `paramdefs` = `vec4 p`, `v4v4` = `vec4 p`, `fill` = `vec2 uv`; colours `#DF2626`, `#A734DD`, `#E739D5`, `#B79074`, `#2DB76C`, `#DEDEDE`). **F**: `set_parameter` spans `362-438` = 77 lines, not 100. **Gaps filled**: the `params` column, the `const STATUS` array, and `_init`'s `status = Updated` default |
| 31 | MaterialX nodedef/input schema: `<nodecategory>` shape, `nodegroup`, `version`/`isdefaultversion`, `uniform`, `enum`/`enumvalues`, `unittype`/`unit`, `uifolder`, `uimin`/`uimax`/`uisoftmin`/`uisoftmax`/`uistep`, `uiadvanced`, `uivisible`, `doc`, universal `disable`, `<backdrop>` | `documents/Specification/MaterialX.Specification.md` (1,594 lines) at `: 595-601, 691, 733, 737, 743-746, 959-961, 1000-1038, 1208` | **C** — every attribute exists with the claimed meaning, and the 1,594-line count is right. **F**: the `nodegroup` list was **missing three standard values** (`texture2d`, `geometric`, `application`); the `uniform` gloss ("may only take a constant, not a connection") was **wrong** — it may connect to `<constant>` outputs and to any output explicitly declared `uniform`, optionally through `<dot>` nodes. **Gaps filled**: the `disable`-as-graph-rewrite clause, the backdrop-vs-nodegraph connectivity distinction, and the `isdefaultversion` uniqueness rule |
| 32 | TerraForge3D source-tree listing; that it vendors `tinyerode` | `gh api …/contents/TerraForge3D/src`, `…/src/Base`, `…/src/Generators`, `…/contents/Third Party License` | **C** — `HeightfieldPyramid`, `HeightfieldRayQuery`, `AsyncTextureReadback`, `GenerationManager`/`GenerationWorker`, `ImGuiCurveEditor` and `tinyerode.md` all exist exactly as claimed. **Gap filled**: `Data/`, `Menu/`, `Misc/` were missing from the tree |
| 33 | §4.8 memory arithmetic: 512²×4 = 1,048,576 B; 1025²×4 = 4,202,500 B; 60 × 4.01 MiB ≈ 241 MiB; 512 MiB budget ⇒ 512 preview / 128 build fields | re-derived | **C** |

### 11.4 Erosion and asset claims (§5, §8)

| # | Claim | Primary source checked | Verdict |
|---|---|---|---|
| 34 | SebLague droplet parameter block and every default (`erosionRadius 3`, `inertia .05`, `sedimentCapacityFactor 4`, `minSedimentCapacity .01`, `erodeSpeed .3`, `depositSpeed .3`, `evaporateSpeed .01`, `gravity 4`, `maxDropletLifetime 30`, `initialWaterVolume 1`, `initialSpeed 1`) at `Erosion.cs : 5-22` | raw `Assets/Scripts/Erosion.cs` (207 lines) | **C** — byte-for-byte, including the `[Range]` attributes |
| 35 | "`InitializeBrushIndices` (`Erosion.cs : 33-44`)" | same file | **F** — lines 33-44 are `Initialize`; `InitializeBrushIndices` is defined at **line 155** |
| 36 | dandrino `simulation.py` constants, incl. `rain_rate = 0.0008 * cell_area` and `iterations = int(1.4 * dim)` at `: 28-62`; `apply_slippage` at `: 19-24` | raw `simulation.py` (143 lines) | **C** — every constant matches verbatim. **Gap filled**: `apply_slippage` hard-codes `gaussian_blur(terrain, sigma=1.5)` in *pixel* space (`: 21`), so unlike `rain_rate` it is **not** resolution-independent — a trap for anyone porting it under §4.3's discipline. Citation nuance: `: 3-7` gives two URLs, not the names Mei/Decaudin/Hu (the INRIA report `inria-00402079` is that paper) |
| 37 | `river_network.py`: Delaunay + heapq Dijkstra `compute_height`, then `compute_final_height` with `max_delta` and `river_downcutting_constant` | raw `river_network.py` (227 lines) at `: 4, 30-46, 53-63, 179-180, 203` | **C** on substance; **F**/**gap**: precise line numbers added, plus the shipped defaults `max_delta = 0.05`, `river_downcutting_constant = 1.3` and the downcut expression at `: 62-63` |
| 38 | erodr v2.0.0 added `-f/--initial-velocity` and `-w/--initial-water`; quoted rationale | raw `README.md : 24-25, 68-69`; `gh api …/releases` → v2.0.0 is latest | **C** on substance; **gap filled**: the shipped default is **0.9** for initial velocity (not just "closer to 1"), and 1 for initial water |
| 39 | ambientCG: 2,010 materials total; Ground 168, Dirt 113, Sand 83, Rock 76, Gravel 66, Cliff 52, Moss 49, Snow 28, Soil 16, Grass 15, Terrain 0 | 11 live calls to `https://ambientcg.com/api/v2/full_json?type=Material&q=…&limit=1`, reading `numberOfResults` | **C** — **all eleven counts matched exactly** |
| 40 | Poly Haven: 859 textures; terrain 129, rock 124, sand 60, aerial 30; the named `aerial_*` assets | `https://api.polyhaven.com/categories/textures` and `…/assets?type=textures&categories=aerial` | **C** — counts exact, and all eleven named `aerial_*` assets exist in the returned set of 30 |
| 41 | "the first row of `downloads_csv` (`AcousticFoam001`) gives 1K-JPG = 5,624,335 B, 2K-JPG = 23,055,666 B, 4K-JPG = 106,915,716 B" | `https://ambientcg.com/api/v2/downloads_csv?limit=600` | **F — could not be reproduced.** The first row on 2026-09-13 was `Ground111` (1K-JPG 9,761,806 B / 2K 34,401,646 / 4K 128,830,539), and `AcousticFoam001` did not appear. Replaced with a measured distribution over 518-520 rows per tier (1K-JPG mean 6.6 MB, 2K 22.7 MB, 4K 86.2 MB) and one exact, reproducible row. Also: 8K and PNG tiers exist and were not listed |
| 42 | "bundling ~24 materials at 1K is roughly 100-150 MB" (researcher's open question #2) | the measured means above + Poly Haven `api.polyhaven.com/files/aerial_rocks_02` (Diffuse 1K JPG = 785,923 B) | **RESOLVED** — the estimate sized full PBR packs (≈158 MB). BAR consumes one diffuse per material and DXT1-compresses it, so the shippable library is 24 × 524,288 B = **12.0 MiB**. Bundle it everywhere; the download question disappears |
| 43 | ambientCG and Poly Haven are CC0-1.0 | quoted licence pages (not re-fetched this pass) | **C** (carried forward; licence-page wording unchanged in the doc) |
| 44 | `maps-metadata :: scripts/js/src/check_archive_not_solid.ts` exists | `gh api repos/beyond-all-reason/maps-metadata/contents/scripts/js/src` | **C** — present, alongside `check_uses_mapinfo_lua.ts`, `check_startboxes.ts`, `check_startpos.ts` and 23 others |
| 45 | pymapconv `src/` file listing | `gh api repos/Beherith/springrts_smf_compiler/contents/src` | **C** — all eight named files present (plus an unlisted `requirements.txt`); root layout `.github/ LICENSE README.md build/ doc/ map_samples/ regression_tester/ resources/ src/ tools/` confirmed exactly |

### 11.5 Open questions still open after this pass

These were **not** resolved and remain genuine design questions, not fact gaps:

- **CPU/GPU erosion agreement tolerance.** Still uncalibrated, and §5.6's finding stands: no
  permissively-licensed WebGPU erosion reference exists to calibrate against. Decide the metric
  before writing the GPU node.
- **Exact-hash vs perceptual tile dedup.** A real trade-off (byte-identical oracle vs smaller
  files). §7.1/§7.5 surface it; nothing here decides it.
- **Whether to ship a pymapconv `@settings` reader.** CC0 permits it; it is a product-scope call.
- **Gaffer's real `Context` scoping.** §4.7(a) is still an approximation. If tiled builds become a
  requirement, read `src/Gaffer/Context.cpp` properly — it was **not** read during this pass.
- **Whether the `aerial` projection preference holds visually in BAR.** Still reasoned, not
  measured. The projection-mismatch argument is sound but untested at BAR camera distances.
- **Per-crate licences inside `whitebox_next_gen/crates/`** (item 17).
- **Whether pymapconv emits a byte-exact bare `.smf` of the size §7.4 predicts** (item 13).

### 11.6 Method

```bash
# struct layout / line numbers — raw fetch, never the GitHub HTML view
curl -sL https://raw.githubusercontent.com/beyond-all-reason/RecoilEngine/master/rts/Map/SMF/SMFFormat.h | cat -n
curl -sL https://raw.githubusercontent.com/beyond-all-reason/RecoilEngine/master/rts/Map/SMF/SMFMapFile.cpp
curl -sL https://raw.githubusercontent.com/GafferHQ/gaffer/main/src/Gaffer/ValuePlug.cpp
curl -sL https://raw.githubusercontent.com/milomg/reactively/main/packages/core/src/core.ts

# licence — API first, then ALWAYS read the file when the API says NOASSERTION
gh api repos/<owner>/<repo> --jq '.license.spdx_id, .archived, .pushed_at, .stargazers_count'
curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/LICENSE
curl -sL https://raw.githubusercontent.com/jblindsay/whitebox_next_gen/main/Cargo.toml | grep license
npm view geolibre-wasm version license

# live asset counts
curl -s "https://ambientcg.com/api/v2/full_json?type=Material&q=Ground&limit=1" | jq .numberOfResults
curl -s "https://api.polyhaven.com/categories/textures" | jq '.all, .terrain, .aerial'
curl -s "https://ambientcg.com/api/v2/downloads_csv?limit=600"   # sizes; NOT stably ordered
```

**Standing rule this pass established (§1.2a):** a `NOASSERTION` from GitHub's licence API is not
information about the licence. It occurred six times in this survey; the four cases that were
chased down were wrong in both directions: it hid a clean MIT (`Zylann`), a clean dual MIT/Apache (`whitebox_next_gen`), and a
plain GPL-2.0+ (`RecoilEngine`). Always read the file.
