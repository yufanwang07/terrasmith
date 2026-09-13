# Web/GPU Implementation Stack & Feasibility

> Research brief for Terrasmith, 2026-09-13. Every version number below was read from the npm
> registry with `npm view <pkg> version` on that date; every browser-support claim was read from
> `mdn/browser-compat-data@main` (raw JSON) or from the WebGPU spec source, not from memory.
> Every performance number in §6 and §7 was **measured on this machine** — Apple M4, 10 cores,
> 16 GiB RAM, macOS Darwin 25.0.0, Node v26.0.0 — and the exact commands are given so you can
> re-run them.
>
> **Load-bearing experiment:** §7.4 contains a ~130-line TypeScript 7z writer that was written,
> run, and verified during this research. Its output was accepted by real 7-Zip 24.09 (the same
> LZMA SDK generation the Recoil engine vendors) with `Everything is Ok`, `Solid = -`,
> `Blocks = 67`, and round-tripped 67 files byte-identically. Hand-writing the container is not
> speculation; it works.
>
> Companion documents: `docs/research/map-archive.md` (what the engine accepts in an archive),
> `docs/research/smt-format.md` (the DXT1 tile format), `docs/research/smf-format.md`,
> `docs/research/toolchain.md`.
>
> **Adversarial fact-check pass, 2026-09-13.** Every falsifiable claim below that a binary writer
> depends on was re-checked against a primary source — engine and SDK source on GitHub fetched raw,
> the npm registry, published package tarballs unpacked and read, the WebGPU spec source, MDN BCD
> JSON, and a live V8 probe. **Ten substantive errors were found and corrected in place, two open
> questions were answered from source, and three material gaps were filled.** The corrections are
> marked inline and itemised in **§16 Verification log** at the end, which also records what could
> *not* be confirmed. The load-bearing ones: 7z-wasm is **not** MIT-adjacent (it is LGPL + unRAR,
> exactly like the package §7.3 rejected on licence grounds); the `ArrayBuffer` ceiling is 32 GiB−1,
> not 16 GiB; §1.5's second limits column is the **compatibility-mode** default, not a "tier"; §5
> omitted three mandatory `.smf` payloads including a whole second BC1 encode job; and the §7.4
> writer has a latent UTF-16 filename bug plus an `@napi-rs/lzma` API call that does not exist.

---

## 0. TL;DR — the stack

| Layer | Pick | Version (2026-09-13) | Why |
|---|---|---|---|
| GPU compute | **WebGPU**, required for the accelerated path only | — | Baseline-ish; **86.9 % global** (84.0 full + 3.0 partial, recomputed from caniuse's data file — §1.1). Never the only path. |
| GPU fallback | **CPU worker pool** (not WebGL2 compute) | — | WebGL2 has no compute shaders; a transform-feedback emulation costs more to write than the TS reference path you already need. |
| WebGPU in Node (CLI/tests) | **`webgpu`** (Dawn bindings) | `0.6.1` (2026-09-12) | Verified working here: prebuilt binaries for darwin-universal / linux-{x64,arm64} / win32-{x64,arm64}, real Metal device, `texture-compression-bc` + `shader-f16` + `timestamp-query`. Licence is unsettled (npm says MIT, GitHub detects BSD-3-Clause) — dev-only, so low risk. |
| 3D viewport | **three.js `WebGPURenderer`** | `three@0.186.0` (r186, 2026-09-08) | Automatic WebGL2 backend fallback in one class; TSL compiles one shader to both WGSL and GLSL; `renderer.compute()` gives you compute from the same renderer. |
| Terrain rendering | **Hand-rolled CDLOD/clipmap over a height texture** (no library) | — | BAR heightfields are 1025²–2305²; a fixed grid + vertex texture fetch covers everything up to 16×16, a 4-ring clipmap covers 36×36. Every terrain library on npm is aimed at geospatial tiles, not a single authored heightfield. |
| Node editor | **`@xyflow/react`** | `12.11.6` (2026-09-01) | MIT, 38.3 k stars, pushed 2026-09-10. Built-in MiniMap/Background/Controls/NodeResizer/NodeToolbar, parent-node groups, React custom nodes. The only live, React-native, MIT option. |
| State | **`zustand@5` + explicit command stack**, blobs outside the store | `zustand@5.0.15`, `immer@11.1.18` | Command pattern gives per-edit undo labels and lets you keep `Float32Array` field caches out of React entirely. |
| BC1 encoding | **`gputex` on GPU, pure-TS encoder as the reference/fallback** | `gputex@0.6.0` (MIT, 2026-07-13) | GPU: 0.26 ms per 2048² BC1 pass (author-measured). Pure TS measured here at **32.5 MPix/s**, i.e. 2.1 s for 8192² single-threaded — good enough that the CPU path is a real product path, not a token fallback. |
| Archive | **`.sd7` via `7z-wasm`**, `.sdz` via `fflate` as the fallback | `7z-wasm@1.2.0`, `fflate@0.8.3` | 7z-wasm is real 7-Zip 24.09; measured **6.2 MiB/s** at `-mx=6` in WASM, no COOP/COEP needed. **Licence caveat: 7z-wasm is LGPL-2.1 + unRAR, not MIT — §7.3.** `.sdz` **is** accepted by the engine and by BAR's metadata schema — it is 16.9 % bigger (measured). |
| Desktop | **Tauri v2** *only if* you drop Linux WebGPU; otherwise **Electron** | `@tauri-apps/cli@2.11.4`, `electron@44.3.0` (Chromium 152) | Tauri's Linux webview (WebKitGTK) has no WebGPU and no way to flag it on. If the desktop build must have GPU compute everywhere, Electron's bundled Chromium is the only answer. |
| Tests | **vitest 5** + golden files + **Dawn-in-Node** for GPU | `vitest@5.0.0`, `webgpu@0.6.1` | Verified: you can run the production WGSL headlessly in a plain Node test with no browser and no CI GPU driver hacks. |
| Build | **vite 8** + **pnpm 12 workspaces** (+ turbo when it hurts) | `vite@8.3.0`, `pnpm@12.4.1`, `turbo@2.10.12` | pnpm's strict `node_modules` is what mechanically enforces "`packages/format` must not touch the DOM". |

**The three decisions that actually matter:**

1. **The CPU path is the product, the GPU path is the accelerator.** Measured pure-JS BC1 at 32.5 MPix/s
   and measured WASM LZMA2 at 6.2 MiB/s mean a full 16×16 map exports in well under a minute with no
   GPU at all. Design for that and WebGPU becomes a pure win rather than a dependency.
2. **`.sdz` is a valid escape hatch.** The engine loads it (`CZipArchive`), BAR's `cdn_maps.yaml`
   schema permits it, and `fflate` writes it in 1.9 s with zero WASM. Ship `.sd7` as the default
   and `.sdz` as the "it didn't work" button.
3. **Cross-origin isolation (COOP/COEP) is a fork in the road.** `SharedArrayBuffer`,
   `@napi-rs/lzma`'s browser build, and multi-threaded WASM all require it; `7z-wasm`, `fflate`,
   OPFS, and WebGPU do not. Decide early — see §8.4.

---

## 1. WebGPU in 2026

### 1.1 Support, from `mdn/browser-compat-data@main`, `api/GPU.json`

| Engine | `version_added` | Notes (verbatim from BCD) |
|---|---|---|
| Chrome | **144** (full) | "Supported on ChromeOS, macOS, Windows, and Linux (Intel Gen12+ GPUs only)." 113–143 was `partial_implementation: true` — ChromeOS/macOS/Windows only. |
| Chrome Android | 121 | |
| Edge | mirrors Chrome | |
| Firefox | **141**, `partial_implementation: true` | "Supports Windows since Firefox 141 (bug 1972486). Supports macOS Tahoe on Apple silicon since Firefox 145 (bug 1992212). Supports older macOS versions on Apple silicon since Firefox 147 (bug 1993341). **Does not support macOS on Intel CPUs** (bug 2004105). **Does not support Linux** (bug 2006676)." Also: "Supports all contexts except service workers" (bug 1942431). |
| Firefox Android | **false** | |
| Safari / iOS Safari | **26** | Shipped Safari 26.0, Sept 2025 (macOS Tahoe 26, iOS/iPadOS 26, visionOS 26). |
| Samsung Internet | mirrors Chrome | |

Usage, computed from caniuse's own data file (`Fyrd/caniuse@main :: fulldata-json/data-2.0.json`,
`updated: 1787601763` = 2026-08-24) by summing `agents[browser].usage_global[version]` over the
`webgpu` feature's `stats`: **83.99 % full + 2.95 % partial = 86.94 % total**.
*(Corrected 2026-09-13 by the fact-check pass; the earlier "87.35 % = 85.72 + 1.63" figure did not
reproduce — the partial share in particular is nearly double what was stated, because Firefox 141+
is `partial_implementation` and carries real usage.)*

**The honest summary:** WebGPU is present for roughly nine users in ten, but the holes are exactly the
ones that bite a technical tool: **Linux Firefox has none, Intel-Mac Firefox has none, Chrome on Linux
is Intel-Gen12+-only.** A Linux user on Firefox or on an AMD/NVIDIA Chrome build is not an exotic
persona for a game-modding tool. Plan for a real fallback, not a banner.

### 1.2 Are compute shaders safe to depend on?

**Yes — if WebGPU is present at all, compute is present.** Compute shaders are not an optional feature
of WebGPU; `GPUComputePipeline`, `createComputePipeline`, and `@compute` are core. There is no
`GPUFeatureName` gating them and no adapter that exposes rendering without compute. The failure mode is
binary: `navigator.gpu === undefined` or `requestAdapter()` resolves `null`, and then you have nothing.

Two real caveats:

* **Firefox has no WebGPU in service workers** (bug 1942431). Dedicated workers are fine, which is
  what you want anyway.
* **Shader compilation is async and cold-start is slow.** `createComputePipelineAsync` on a large
  erosion kernel can take 100–300 ms on first use. Warm every pipeline behind the splash screen;
  three.js r186 added `compileComputeAsync()` for exactly this.

### 1.3 What the fallback should be

**CPU worker pool. Not WebGL2.**

WebGL2 has **no compute shaders** — that is not a gap you paper over, it is the whole feature. The
WebGL2 route means re-expressing every kernel as a fragment shader writing to a float render target,
with ping-pong FBOs and manual `readPixels` sync, and `EXT_color_buffer_float` for `RGBA32F` render
targets. For erosion — which is an iterative stencil over a Float32 field with scatter — that is a
second full implementation with its own precision bugs, and it will not be meaningfully faster than a
well-written worker pool for grids ≤ 2049².

You already committed to a CPU reference implementation in `docs/ARCHITECTURE.md` ("CPU first, in
TypeScript, with the option of a worker pool… what the tests assert against, what the CLI uses, and
what runs when WebGPU is unavailable"). That decision is correct and it *is* the fallback. Adding a
third path costs a third set of tolerance bugs.

The one place WebGL2 still earns its keep is **rendering** the viewport, and three.js's
`WebGPURenderer` gives you that for free (§2).

```ts
// packages/core/src/gpu/detect.ts — the whole fallback decision
export type Backend = 'webgpu' | 'cpu';

export async function pickBackend(): Promise<Backend> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return 'cpu';
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return 'cpu';
    // Ask for the limits you actually need up front — see §1.5, defaults are low.
    await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize } });
    return 'webgpu';
  } catch { return 'cpu'; }
}
```

### 1.4 WebGPU in Node — verified working

`webgpu@0.6.1` (https://github.com/dawn-gpu/node-webgpu, MIT, published **2026-09-12**) is the
maintained Dawn `dawn.node` plugin, republished with prebuilt binaries. Installed and run here:

```
$ ls node_modules/webgpu/dist/
darwin-universal  linux-arm64  linux-x64  win32-arm64  win32-x64
```

```js
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);                         // dawn toggles go in this array
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
const device  = await adapter.requestDevice({ requiredFeatures: ['texture-compression-bc'] });
```

Measured output on this machine (Apple M4, Metal backend):

```
ADAPTER maxTextureDimension2D 16384  maxBufferSize 4294967295  maxStorageBufferBindingSize 4294967292
DEVICE  features: [ 'timestamp-query', 'texture-compression-bc', 'shader-f16', 'core-features-and-limits' ]
```

Package is 90.5 MiB unpacked / 23 files — big, so it belongs in `devDependencies` of `packages/cli`
and in test-only dependencies, never in the web bundle.

`create()` accepts Dawn toggles and a backend selector, which is what makes it usable in CI:
`create(['backend=vulkan'])`, `create(['adapter=…'])`, `create(['enable-dawn-features=allow_unsafe_apis'])`.
Passing a non-existent backend or adapter name prints the available list — handy for CI diagnostics.

Alternative: `@kmamal/gpu@0.2.1` (also Dawn), last published 2025-08-28. Less current; prefer `webgpu`.

**Consequence for the architecture:** the exact same WGSL that runs in the browser runs under
`vitest` in Node with no browser, no headless-Chrome flags, and no CI GPU driver. This is the single
most useful fact in this document for testing (§10.3).

### 1.5 WebGPU limits — the numbers that will bite you

From the spec source (`gpuweb/gpuweb@main`, `spec/index.bs`, the "supported limits" table):

The table's two value columns are headed `Default` and **`Compatibility Mode Default`**
(`spec/index.bs:1657`) — the second column is *not* a "tier", it is what an adapter requested with
`featureLevel: "compatibility"` (a device lacking the `core-features-and-limits` feature) is given.
All six rows below were read verbatim from the file on 2026-09-13.

| Limit | Default | Compatibility-mode default | Line in `spec/index.bs` |
|---|---|---|---|
| `maxTextureDimension2D` | **8192** | **4096** | 1666–1667 |
| `maxStorageBuffersPerShaderStage` | **8** | 8 (one column spans both) | 1747–1748 |
| `maxStorageBufferBindingSize` | **134 217 728** (128 MiB) | 134 217 728 (one column) | 1811–1812 |
| `maxBufferSize` | **268 435 456** (256 MiB) | 268 435 456 (one column) | 1845–1846 |
| `maxComputeInvocationsPerWorkgroup` | **256** | **128** | 1890–1891 |
| `maxComputeWorkgroupsPerDimension` | **65535** | 65535 (one column) | 1914–1915 |

Real adapters commonly report far more than the defaults (this machine's Dawn adapter reported
`maxTextureDimension2D` 16384 and `maxBufferSize` 4 294 967 295) — but you only *get* more by asking
for it, see the end of this section. **Compatibility mode matters here:** a 4096 `maxTextureDimension2D`
halves the chunk budget, and 128 invocations per workgroup caps a `@workgroup_size(16,16)` kernel
exactly at the limit, so do not write `@workgroup_size(16,16,1)` and assume headroom.

Three consequences, all specific to this project:

1. **`maxTextureDimension2D` default is exactly 8192, and a 16×16 BAR map's diffuse texture is
   exactly 8192×8192.** You fit at the default with zero margin. A 24×24 map (`mapx = 1536`,
   texture 12288²) **does not fit** and must be tiled. Write the tiling path from day one; do not
   discover it at 24×24.
2. **`maxBufferSize` default is exactly 256 MiB, and 8192² RGBA8 is exactly 268 435 456 bytes.**
   A readback staging buffer for the full texture is exactly at the limit. Chunk it.
3. **`maxStorageBufferBindingSize` (128 MiB) is *half* an 8192² RGBA8 image.** So the BC1 encoder's
   *input* must be a `texture_2d<f32>` (sampled/loaded), not a `storage` buffer. The *output*
   (8192²/2 = 33 554 432 B = 32 MiB of BC1 blocks) fits comfortably as a storage buffer.

And the gotcha that catches everyone: **`requestDevice()` silently gives you the spec defaults**, not
the adapter's capability. Measured here — the adapter offered `maxBufferSize` 4 GiB−1, the device got
256 MiB, because nothing was requested. Always:

```ts
const device = await adapter.requestDevice({
  requiredFeatures: (['texture-compression-bc', 'shader-f16', 'timestamp-query'] as const)
    .filter(f => adapter.features.has(f)),
  requiredLimits: {
    maxTextureDimension2D:       adapter.limits.maxTextureDimension2D,
    maxBufferSize:               adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  },
});
```

---

## 2. 3D viewport

### 2.1 Recommendation: three.js r186 with `WebGPURenderer`

`three@0.186.0`, published 2026-09-08. MIT.

**The deciding argument is the fallback, and it is one line.** From
`mrdoob/three.js@r186 :: src/renderers/webgpu/WebGPURenderer.js:53-78`:

```js
constructor( parameters = {} ) {
  let BackendClass;
  if ( parameters.forceWebGL ) {
    BackendClass = WebGLBackend;
  } else {
    BackendClass = WebGPUBackend;
    parameters.getFallback = () => {
      warn( 'WebGPURenderer: WebGPU is not available, running under WebGL2 backend.' );
      return new WebGLBackend( parameters );
    };
  }
  const backend = new BackendClass( parameters );
  super( backend, parameters );
```

One renderer class, automatic WebGL2 backend when WebGPU is missing, and `forceWebGL: true` to
reproduce the fallback path deliberately in tests. Your splat shader, written once in TSL, compiles
to WGSL on one backend and GLSL on the other. Nothing else in this space gives you that.

Compute from the same renderer (`src/renderers/common/Renderer.js`):

| Method | Line | Note |
|---|---|---|
| `compute( computeNodes, dispatchSize = null )` | 2877 | Warns and defers to `computeAsync` if the backend is not yet initialised (line 2883). |
| `computeAsync( computeNodes, dispatchSize = null )` | 2992 | |
| `compileComputeAsync( computeNodes, onProgress = null )` | 1115 | New in r186; pre-warm pipelines. |
| `hasFeature( name )` | 3033 | Throws if called before `await renderer.init()` (line 3037). |

`hasFeatureAsync()` was deprecated in r181 — use `await renderer.init()` then `hasFeature()`.

### 2.2 Why not babylon.js

`@babylonjs/core@9.26.0`, Apache-2.0, published 2026-09-10. Babylon is a genuinely stronger *engine*
(better editor tooling, a real scene graph with built-in physics, a mature `WebGPUEngine`) and its
`DynamicTerrain` / `TerrainMaterial` extras are closer to out-of-the-box terrain than anything in
three. If you were building a game, this would be a coin flip.

For Terrasmith it loses on two points:

* **Bundle and API surface.** Babylon is an engine you live inside; three is a library you call.
  Terrasmith's viewport is one panel in a React app that mostly does graph editing, and the R3F
  ecosystem (`@react-three/fiber@9.7.0`, `@react-three/drei@10.7.8`) exists precisely to make that
  panel declarative and disposable.
* **Shader portability.** Babylon's WebGPU and WebGL paths want different shader sources (WGSL vs
  GLSL, or ShaderMaterial vs node materials with separate compilation). Three's TSL is one source.
  You are going to reimplement BAR's SSMF splat blend exactly; writing it twice is the expensive
  part.

`gputex` (§6) also ships a first-class `gputex/three` entry — but note its core entry is
engine-agnostic, so this is not a lock-in.

### 2.3 Why not hand-rolled

You would be writing, from scratch: a WebGPU *and* WebGL2 backend, render-pass and bind-group
management, a camera/controls rig, frustum culling, shadow maps, a glTF loader for feature previews,
and PBR materials — before drawing your first triangle of terrain. The terrain-specific part (the
clipmap, §2.4) is the part three.js does *not* give you, and that part is small. Hand-rolling buys
you nothing you need and costs the part you don't want to write.

### 2.4 Terrain rendering — build this yourself, it is small

**No terrain library is a good fit.** Everything on npm in this space is geospatial:
`@mapbox/martini@0.2.0` (RTIN mesh from a terrain-RGB tile, unmaintained since 2020),
`geo-three@0.1.15` (2024), `three-tile@0.12.2`, `@loaders.gl/terrain@4.5.1`. They all assume
web-mercator tile pyramids fetched over HTTP. `@interverse/three-terrain-lod@2.1.1` (MIT, 2026-04-20,
`peerDependencies: { three: '>=0.183.0' }`) is the closest — quadtree chunked LOD with swappable
materials — but it is a small single-author package and you will fight its material model when you
implement the SSMF splat blend.

**Size the problem first.** From `docs/research/smf-format.md:206-247`, a BAR heightfield is
`(mapx+1) × (mapy+1)` vertices:

| Map | `mapx × mapy` | Heightfield verts | Triangles |
|---|---|---|---|
| 8×8 | 512 × 512 | 513² = 263 169 | 524 288 |
| **16×16** | 1024 × 1024 | **1025² = 1 050 625** | 2 097 152 |
| 26×4 (SpeedMetal) | 1664 × 256 | 1665 × 257 = 427 905 | 851 968 |
| 36×36 (largest sane) | 2304 × 2304 | 2305² = 5 313 025 | 10 616 832 |

A 1025² grid — the common case — is **one million vertices**, which any 2026 GPU renders as a single
static `PlaneGeometry` with vertex-texture displacement at hundreds of FPS. You do not need LOD for
16×16 and below. For 24×24+ you need it.

**The implementation, in order of effort:**

1. **Phase 1 (ship this):** one `PlaneGeometry(mapx, mapy, mapx, mapy)` — or better, a flat XZ grid with
   only UVs — displaced in the vertex stage by sampling an `r32float` height texture. Heights live on
   the GPU as a texture, never as a `position` attribute, so a parameter change re-uploads one texture
   instead of rebuilding geometry. In TSL:
   ```ts
   import { texture, positionLocal, uv, vec3, float } from 'three/tsl';
   const h = texture(heightTex, uv()).r;               // elmos
   material.positionNode = vec3(positionLocal.x, h, positionLocal.z);
   ```
2. **Phase 2 (24×24+):** a **geometry clipmap** (Asirvatham & Hoppe) — a fixed set of nested rings of
   identical grid geometry, all instanced from one buffer, translated to snap to the camera in
   power-of-two steps. Because the height comes from a texture, all rings share one material and one
   geometry; the only per-ring uniform is the (offset, scale) of its footprint. This is ~200 lines and
   it is *why* the texture-displacement choice in phase 1 matters.
   CDLOD (continuous distance-dependent LOD) is the alternative and morphs better, but clipmaps are
   simpler and the camera in a terrain *editor* is usually top-down-ish, where clipmap popping is
   invisible.
3. **Splat texturing:** replicate the engine's SSMF blend. The map carries
   `<Name>_splat_distribution.dds` (RGBA weights) and four detail textures; the shader blends
   `detail[i]` by `splat.rgba[i]`. Writing it in TSL means the WebGL2 fallback gets the same visual.
   Cross-check against `docs/research/smt-format.md` §3 for the exact texel↔elmo mapping: the diffuse
   texture is `(mapx*8) × (mapy*8)` texels, i.e. **exactly 1 texel per elmo**
   (`smt-format.md:351,355,426-428`).

**Raycasting for brush tools:** do not raycast the displaced mesh (the CPU has no idea where the
vertices went). Ray-march the height texture on the CPU against your own `Float32Array` field —
you already have it, it is the authoritative data, and a DDA over a 1025² grid is microseconds.
`three-mesh-bvh@0.9.15` is the answer for feature meshes, not for terrain.

---

## 3. Node editor UI

### 3.1 The candidates, measured

| | `@xyflow/react` | `rete` | `litegraph.js` | `baklavajs` | hand-rolled canvas |
|---|---|---|---|---|---|
| Version | **12.11.6** | 2.0.6 | 0.7.18 | 2.8.1 | — |
| Published | **2026-09-01** | 2025-06-30 | **2024-01-08** | 2025-11-02 | — |
| Repo pushed | **2026-09-10** | 2026-09-13 | **2024-08-01** | 2026-06-17 | — |
| Stars | **38 353** | 12 251 | 8 134 | 2 093 | — |
| License | **MIT** | MIT | MIT | MIT | — |
| Rendering | DOM nodes + SVG edges | pluggable (React/Vue/Angular/Svelte) | HTML5 Canvas | Vue-first | canvas |
| Perf at 200 nodes | fine (see §3.2) | fine | excellent | fine | excellent |
| Perf at 2000 nodes | needs virtualisation | needs care | excellent | untested | excellent |
| Custom node rendering | **React components, unrestricted** | per-framework plugin | manual canvas draw calls | Vue components | you write it |
| Groups / comments | **parent nodes (`parentId` + `extent:'parent'`)** | plugin | groups built in | plugin | you write it |
| Minimap | **built in (`<MiniMap/>`)** | plugin | built in | plugin | you write it |
| Typed ports | via `isValidConnection` + your own type model | socket types built in | slot types built in | typed interfaces built in | you write it |
| Undo integration | none (you own it) — **good** | none | none | none | you own it |

### 3.2 Recommendation: `@xyflow/react@12.11.6`

It is the only option that is simultaneously **actively maintained, MIT, and React-native**.
`litegraph.js` has not been published since 2024-01-08 and its repo has not been pushed since
2024-08-01 — it survives only as ComfyUI's fork (`@comfyorg/litegraph@0.17.2`, npm 2025-08-06;
`Comfy-Org/litegraph.js` 253 stars, pushed 2026-01-14), which is maintained *for ComfyUI*, not as a
library. `baklavajs` is Vue-first. `rete@2` is framework-agnostic and genuinely well-engineered, but
you assemble it from ~6 plugin packages and its React renderer is a second-class citizen relative to
its own core.

**On performance at 200+ nodes.** React Flow renders one DOM element per node. This is a real cost
and it is also a real feature — your node bodies are React, with inline previews, sliders, and
thumbnails, which is exactly what makes a terrain tool usable. The mitigations, in the order you
should apply them:

1. **Memoize every custom node** (`React.memo`) and never pass a new object literal as `data`.
   This single change is the difference between 200 nodes being smooth and being unusable.
2. **`onlyRenderVisibleElements`** on `<ReactFlow>` — culls off-viewport nodes.
3. **Never store node positions in the same store as your graph document.** React Flow owns
   positions; your document owns topology and parameters (§4.2). Dragging a node must not
   invalidate an evaluation cache.
4. **Debounce `onNodesChange`** for `type: 'position'` changes, and commit to the undo stack only on
   `dragstop`.

With those four, 200–500 nodes is comfortable. Beyond ~1500 you would need canvas rendering, and at
that point you are building a different product — Terrasmith graphs will be tens of nodes, with
hundreds only for machine-generated templates.

**API surface, verified by reading the installed `@xyflow/react@12.11.6` / `@xyflow/system@0.0.82`
type definitions** (not the docs site):

| Need | API | Where |
|---|---|---|
| Groups / frames | `node.parentId?: string` + `node.extent?: 'parent' \| CoordinateExtent \| null` (+ `expandParent`) | `@xyflow/system@0.0.82/dist/esm/types/nodes.d.ts:50` (`parentId`), `:56` (`extent`), `:61` (`expandParent`) |
| Minimap, grid, zoom buttons, resize, per-node toolbar, floating panels | exported components `MiniMap`, `Background`, `Controls`, `NodeResizer`, `NodeToolbar`, `Panel` | `@xyflow/react/dist/esm/index.js` |
| Culling | `<ReactFlow onlyRenderVisibleElements>` | `@xyflow/react/dist/esm/types/component-props.d.ts:331` |
| Typed ports | `<ReactFlow isValidConnection={fn}>` | `component-props.d.ts:613` |

One non-obvious note in their own types: *"we recommend you move this logic to the
`isValidConnection` prop on the main ReactFlow … rather than the `isValidConnection` prop on the
handle component **for performance reasons**"* (`component-props.d.ts:611`,
`@xyflow/system/dist/esm/types/handles.d.ts:47`). With one `isValidConnection` on the container you
get your whole port-type system (Field vs Scalar vs Colour) in one function that closes over your
node catalogue — which is the right place for it anyway.

**Note:** `@xyflow/react@12.11.6` declares `dependencies: { zustand: "^4.4.0", classcat: "^5.0.3",
"@xyflow/system": "0.0.82" }`. It carries its own zustand 4 internally, which will not dedupe with
your zustand 5. That is ~3 kB of duplicate and zero behavioural conflict (separate store instances) —
but it is worth knowing before you go looking for a phantom store.

**Layout:** `@dagrejs/dagre@3.1.1` (MIT) for quick auto-layout; `elkjs@0.12.0` if you need layered
layout with port constraints — note elkjs is **EPL-2.0 OR GPL-3.0-or-later**, which matters for an
MIT project (EPL-2.0 is fine to depend on, but read it before vendoring).

---

## 4. State management and undo/redo

### 4.1 Recommendation

**`zustand@5.0.15` for UI state + a hand-written command stack over a plain immutable graph document
+ binary blobs held entirely outside React.**

Not Redux Toolkit (`@reduxjs/toolkit@2.12.0`): its value is the devtools/middleware ecosystem and
conventions for large teams; you get the devtools from zustand too and you pay RTK's ceremony on
every action. Not valtio (`valtio@2.3.2`): proxy-based mutation tracking is lovely for forms and
actively hostile to a system where you need *explicit, labelled, coalesced* edits with an undo name.
Not `zundo@2.3.0` (zustand's temporal middleware): it snapshots whole state slices, which is the
wrong granularity — you want "Undo: change Erosion.duration", you want ten slider drags to coalesce
into one entry, and you absolutely do not want a `Float32Array` appearing in a history snapshot.

### 4.2 The shape

Three stores, deliberately separate:

```ts
// 1. The document. Plain data. Serialisable. Never contains a typed array.
interface GraphDoc {
  readonly nodes: ReadonlyMap<NodeId, NodeSpec>;   // type, params, position is NOT here
  readonly edges: readonly Edge[];
  readonly groups: readonly Group[];
  readonly meta: { name: string; mapSize: [number, number] };
}

// 2. UI state. zustand. Selection, viewport, panel sizes, node positions.
//    React Flow already owns positions; mirror only what you must persist.

// 3. The blob cache. A module-level Map, NOT in any store, NOT in React.
const fieldCache = new Map<ContentHash, Float32Array>();
```

The command pattern, with immer for the ergonomics of writing reducers:

```ts
import { produce, type Patch, applyPatches, enablePatches } from 'immer';
enablePatches();

export interface Command { readonly label: string; readonly coalesceKey?: string; }

interface HistoryEntry { label: string; redo: Patch[]; undo: Patch[]; coalesceKey?: string; at: number; }

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  apply(doc: GraphDoc, cmd: Command, recipe: (d: Draft<GraphDoc>) => void): GraphDoc {
    let redo: Patch[] = [], undo: Patch[] = [];
    const next = produce(doc, recipe, (p, ip) => { redo = p; undo = ip; });
    const last = this.past.at(-1);
    // Coalesce: a slider dragged for 400 ms is ONE undo entry.
    if (last && cmd.coalesceKey && last.coalesceKey === cmd.coalesceKey && Date.now() - last.at < 600) {
      last.redo.push(...redo); last.undo.unshift(...undo); last.at = Date.now();
    } else {
      this.past.push({ label: cmd.label, redo, undo, coalesceKey: cmd.coalesceKey, at: Date.now() });
      this.future.length = 0;
    }
    return next;
  }

  undo(doc: GraphDoc): [GraphDoc, string | null] {
    const e = this.past.pop(); if (!e) return [doc, null];
    this.future.push(e);
    return [applyPatches(doc, e.undo), e.label];
  }
}
```

Why immer *patches* rather than immer snapshots: a patch list for "changed one parameter" is ~80
bytes, so a 500-entry history costs kilobytes. A snapshot history of a 200-node graph costs megabytes
and — worse — keeps every intermediate structure alive, which defeats the content-hash memoisation
in `packages/graph`.

`immer@11.1.18` is current. If you want a drop-in that is measurably faster, `mutative@1.3.0` (MIT)
implements the same `produce`/patches API; benchmark before switching, the difference only shows on
very large drafts.

### 4.3 Large binary blobs — keep them out of everything

The rules, in priority order:

1. **Nothing that is a `Float32Array`/`Uint8Array` ever enters a React store.** Stores hold
   `ContentHash` strings; a `useSyncExternalStore` subscription over the cache turns a hash into a
   preview when a component actually needs it.
2. **The cache is keyed on content, not identity** — you already specified this in
   `docs/ARCHITECTURE.md` ("keyed by a hash of its type, its parameters, its inputs' hashes, and the
   evaluation context"). That makes eviction safe: an evicted entry is recomputable, never lost.
3. **Evict on a byte budget, not an entry count.** A 1025² `Float32Array` is **4 202 500 B**; a 4097²
   one is **67 141 636 B**. Thirty of the latter is 2.01 GB (1.88 GiB). Track `buffer.byteLength` and run an LRU with
   a hard budget (start at 1 GiB, see §8.1).
4. **Transfer, don't clone, across worker boundaries.** `postMessage(msg, [buf.buffer])` moves the
   backing store in O(1) and leaves the sender's view detached (`byteLength === 0`). Always pass
   ownership explicitly in your protocol so a detached-buffer bug is a type error, not a runtime one.
   Fields that must be read by two workers simultaneously are the case for `SharedArrayBuffer` (§8.4)
   — and that case should be rare.
5. **Spill to OPFS, not IndexedDB** (§8.2), for anything you want to survive a reload.

---

## 5. Worked size calculation — the 16×16 map

Cross-checked against `docs/research/smt-format.md:426-440` and `smf-format.md:206-247`. This is the
concrete workload every number in §6 and §7 is sized against.

```
Map "16x16"           -> mapx = 1024, mapy = 1024   (heightmap squares; multiple of 128)
World extent          = mapx * 8  = 8192 x 8192 elmos                       [smf-format.md:221]
Heightfield           = (mapx+1) x (mapy+1) = 1025 x 1025 vertices          [smf-format.md:215,229]
Diffuse texture       = (mapx*8) x (mapy*8) = 8192 x 8192 texels            [smt-format.md:38,427]
                        i.e. EXACTLY 1 texel per elmo                        [smt-format.md:351]
Tile grid             = (mapx/4) x (mapy/4) = 256 x 256 = 65 536 tiles      [smf-format.md:226,228]
```

| Artefact | Formula | Bytes | |
|---|---|---|---|
| Heightfield, `Float32Array` (working) | `1025² × 4` | 4 202 500 | 4.01 MiB |
| Heightfield, `uint16` (as written to `.smf`) | `1025² × 2` | 2 101 250 | 2.00 MiB |
| Diffuse source, RGBA8 (GPU upload) | `8192² × 4` | **268 435 456** | **256.0 MiB** — equals `maxBufferSize` default |
| Diffuse source, RGB24 (per smt-format.md:428) | `8192² × 3` | 201 326 592 | 192.0 MiB |
| BC1 mip 0 | `8192²/2` | 33 554 432 | 32.0 MiB |
| BC1 + 4-level mip chain (what SMT stores) | `33 554 432 × 1.328125` | 44 564 480 | 42.50 MiB |
| `.smt`, zero dedup | `32 + 65 536 × 680` | **44 564 512** | 42.50 MiB [smt-format.md:434] |
| Tile index array in `.smf` | `65 536 × 4` | 262 144 | 256 KiB |
| **Minimap in `.smf`** (fixed size, mandatory) | `MINIMAP_SIZE` | **699 048** | 682.7 KiB — 1024² DXT1 + 8 mips |
| **Typemap in `.smf`** | `uint8[mapx/2 × mapy/2]` | 262 144 | 256 KiB |
| **Metalmap in `.smf`** | `uint8[mapx/2 × mapy/2]` | 262 144 | 256 KiB |
| `_specular.dds`, `_splat.dds`, `_normals.dds` | varies; real maps 0.5–16 MiB each | ~30 MiB | |
| **Total staging tree** | | **~130–160 MiB** | matches real maps: Boreal Falls 14×14 ships at 47.9 MB *packed* |

Sanity check from `smt-format.md:436-438`: an un-deduped `.smt` is bit-for-bit the same volume as a
full mipped DXT1 8192² texture. `1.328125 = 1 + 1/4 + 1/16 + 1/64`, the 4-level mip tail.

**The three `.smf` payloads added to the table above were missing from the first draft and are
mandatory.** Verified directly against the engine, not against the companion docs
(`beyond-all-reason/RecoilEngine@master :: rts/Map/SMF/SMFFormat.h`, read 2026-09-13):

* `MINIMAP_NUM_MIPMAP = 9` (`:31`) and `MINIMAP_SIZE = 699048` (`:34`); `minimapPtr` is documented as
  *"always 1024\*1024 dxt1 compressed data plus 8 mipmap sublevels"* (`:65`). The constant reproduces
  exactly: `sum((1024>>i)²/2 for i in 0..8) = 699 048` — levels 1024²→4² inclusive (DXT1's 8-byte
  block floor ends the chain at 4×4; there is no 2×2 or 1×1 level).
  **This is a second, independent BC1 encode job** — a 1024² image with a *nine*-level chain, not the
  four-level chain §6 describes — and §6 does not otherwise mention it. Budget it, and note that
  `gputex`'s `mipmaps: true` chain (down to 1×1) is the wrong length in *both* directions: too long
  here (stop at 4×4), too long for the tiles (stop at 128×128, see §6.4).
* `typeMapPtr` → `unsigned char[mapy/2 * mapx/2]` (`:63`) = 262 144 B at 16×16.
* `metalmapPtr` → `unsigned char[mapx/2 * mapy/2]` (`:66`) = 262 144 B at 16×16.

Also confirmed from the same file, because every number in §6 rests on it:
`squareSize` must be 8, `texelPerSquare` must be 8, `tilesize` must be 32 (`:56-58`) — which is *why*
the diffuse texture is `(mapx*8) × (mapy*8)` texels over a `mapx*8`-elmo world, i.e. exactly one texel
per elmo; the heightmap is `short int[(mapy+1)*(mapx+1)]` (`:62`); the tile index array is
`int[mapx/4 * mapy/4]` (`:119-120`); `SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6) = 680`
(`:28`); and `TileFileHeader` is `char magic[16] + 4 × int = 32 bytes` (`:175-183`), which is the `32`
in the zero-dedup `.smt` formula. Every one of these matches what §5/§6 already assumed.

**Peak browser memory during export**, if you are naive: 256 MiB (RGBA source) + 42.5 MiB (BC1) +
4 MiB (heights) + 130 MiB (staging copies for the archiver) + whatever the archiver's dictionary
needs. Call it **500 MiB**, which is fine. If you also keep the graph's intermediate fields alive,
add a few hundred MiB more — hence the byte-budget LRU in §4.3.

---

## 6. DXT1 / BC1 compression in the browser

### 6.1 What the target actually is

Not "one 8192×8192 image". From `docs/research/smt-format.md`:

* A tile is **32×32 texels, DXT1, with a 4-level mip chain (32, 16, 8, 4)**, packed back to back:
  `512 + 128 + 32 + 8 = 680 bytes = SMALL_TILE_SIZE` (`smt-format.md:32-33,122-129`).
* In-tile mip offsets are `{0, 512, 640, 672}` (`smt-format.md:155-158`).
* Blocks within each mip are **row-major, top-to-bottom, left-to-right** — standard linear DXT1
  block raster (`smt-format.md:165-169`).
* **Crucially, pymapconv does not mip each tile in isolation.** It DXT1-compresses a whole
  **1024×1024** chunk of the source with a 4-level chain, then cuts each tile's mips out of the
  chunk's mips (`smt-format.md:182-192`). Matching this is what makes your output visually identical
  to the incumbent tool, because a 4×4 box-downsample of a 32×32 tile is *not* the same as the
  corresponding region of a downsample of the 1024×1024 chunk near tile edges.

So the real operation is: **for each of the 64 big squares (1024×1024 texels each) of a 16×16 map,
generate a 4-level mip chain and BC1-encode all four levels; then slice 32×32-tile mip stacks out of
the result and dedup on the full 680 bytes.** That is 64 × (1024² + 512² + 256² + 128²) = 89.1 MPix
of BC1 encoding, equal to 67.1 MPix × 1.328.

### 6.2 The options, honestly evaluated

**(a) WASM build of stb_dxt / rgbcx / bc7enc — no maintained npm package exists.**

Searched: `stb-dxt`, `rgbcx`, `bc7enc`, `dxt-wasm`, `wasm-dxt`, `texpack`, `compressonator` — all
`NOT_FOUND` on npm. What *does* exist:

| Package | Version | Reality |
|---|---|---|
| `dxt-js` | 0.0.3 (2017-10-18) | emscripten port of libsquish. Nine years old, no types, no ESM. |
| `dxt` | 1.0.1 (2017-12-06) | native node bindings to libsquish. Node-only, needs a toolchain. |
| `silent-dxt-js` | 0.0.3 (2022-09-17) | fork of `dxt-js` that swallows exceptions. |
| `decode-dxt` | 1.0.1 | **decoder only**. |
| `@gpu-tex-enc/bc` | 1.0.11 (2024-02-16) | **Not WASM.** Ships `bin/{linux,win32,darwin-x64,darwin-arm64}/bc7enc` native executables (9 581 590 B unpacked = **9.14 MiB / 9.58 MB**; Apache-2.0). Node-only, unmaintained since 2024. |
| `crunch-js` | 1.2.0 | Crunch/CRN transcoder, not a BC1 encoder for arbitrary input. |

The source you'd compile is `richgel999/bc7enc_rdo` — **maintained; last push 2026-07-31, 277 stars**
(GitHub API, checked 2026-09-13; the "pushed 2026-09-11" in the first draft was wrong),
dual-licensed MIT / public domain (`LICENSE`, read verbatim: *"All other source code files in this repo are available under 2 licenses
-- choose whichever you prefer. ALTERNATIVE A - MIT License … ALTERNATIVE B - Public Domain"*; note
`bc7e.ispc` is Apache-2.0 and `LodePNG.cpp` carries its own licence — you need neither for BC1). `rgbcx.h` inside it is the best-in-class
BC1 encoder, with quality levels 0–18.

**Its killer feature for *this* project is RDO.** From the bc7enc_rdo README: *"the entropy reduction
transform is tuned for Deflate, LZHAM, or LZMA … Significant (10-50%) size reductions are possible."*
Your `.smt` gets LZMA2'd inside the `.sd7`, so RDO BC1 directly shrinks the shipped archive. That is
a genuine, measurable product win that no GPU encoder offers. **But** it requires you to build and
maintain an emscripten toolchain in CI, and RDO is slow. File it as a **v2 optimisation**, not v1.

**(b) `gputex@0.6.0` — a real, maintained, MIT npm package. Use this.**

https://github.com/verekia/gputex, MIT, npm 2026-07-13, repo pushed 2026-08-27. Runtime GPU texture
compression via **WebGPU compute shaders** with a **WebGL2 fragment-shader fallback**. Encoders:
BC1, BC5, BC7, ASTC 4×4, ETC2 RGB8.

Three entry points, and the one you want is the engine-agnostic core:

```ts
import { BC1Encoder, generateGpuMipChain } from 'gputex';   // no three.js import

const encoder = await BC1Encoder.create();
const { data, width, height, paddedWidth, paddedHeight } = await encoder.encodeToBytes(imageBitmap);
// `data` is a Uint8Array of BC1 blocks covering paddedWidth × paddedHeight, row-major. Exactly
// the raster smt-format.md:165-169 specifies.
```

And for the mip chain — which is what the SMT pipeline actually needs:

```ts
const { levels, encodeMs } = await encoder.encodeMipChainToBytes(generateMipChain(level0));
// encodeMipChainToBytes encodes EVERY level in a single GPU submission: one compute pass,
// one readback, one mapAsync wait instead of one per level.
// levels[i] = { data, width, height, paddedWidth, paddedHeight }  -- README, "Low-level encoders".
```

**Length mismatch you must handle yourself:** `generateMipChain` / `generateGpuMipChain` /
`mipmaps: true` build the **full** chain down to 1×1 (README, options table: *"Generate full mip chain
down to 1x1"*). SMT wants exactly four levels per 1024² chunk (1024, 512, 256, 128 — the engine sets
`GL_TEXTURE_MAX_LEVEL = 3`, see §6.4) and the `.smf` minimap wants exactly nine (1024 → 4). Slice
`levels[0..3]` and `levels[0..8]` respectively; do not ship whatever the helper returns.

The README also documents `generateGpuMipChain()` (box-filters the whole chain on the GPU in one
pass) and states its box filter is **integer-exact against the CPU one, so both paths emit identical
bytes** — which is precisely the CPU/GPU-agreement property `docs/ARCHITECTURE.md` demands.

Quality, from the README: principal-axis endpoint seed via per-block covariance power-iteration,
projection-based index assignment, and *"up to two least-squares endpoint refit rounds accepted per
block only when they lower the error"* for BC1. Measured by the author at **≤0.1 dB** of an
exhaustive per-block reference encoder on their test cards.

**Author-measured throughput** (Apple Silicon `metal-3`, Chrome, 2048×2048, WebGPU timestamp queries,
median of 20 runs; "GPU pass" is the compute shader alone, end-to-end adds ~2–4 ms of upload +
readback):

| Format | Shader | GPU pass @ 2048² |
|---|---|---|
| **BC1** | **f16 (default)** | **0.26 ms** |
| BC1 | f32 | 0.46 ms |
| BC7 | f16 | 0.26 ms |
| ASTC 4×4 | f16 | 0.26 ms |

**Extrapolated to our workload:** 8192² is 16× the pixels of 2048², so the BC1 compute pass is
~4.2 ms. The mip tail adds 33 %, so ~5.6 ms of *shader* time for a whole 16×16 map. The real cost is
data movement: 256 MiB up, 42.5 MiB back, plus the `maxBufferSize`/`maxTextureDimension2D` ceilings
from §1.5 forcing you into 1024²-chunk batches anyway (which is exactly the granularity
`smt-format.md:182-192` wants). **Budget 150–400 ms end-to-end** for a 16×16 map on a discrete GPU,
less on unified memory. Caveat the author gives: *"Timestamps are quantised to 100 µs by Chrome and
Apple GPU clock states swing timings by ~2×, so sub-millisecond figures are indicative (±0.1 ms)."*

**(c) A GPU compute-shader BC1 encoder in WGSL that you write yourself.**

Don't — `gputex` already is one, MIT-licensed, with its WGSL in `library/src/bc1.wgsl` and
`library/src/bc1_fast_f16.wgsl` for you to read and vendor if the package ever goes stale. Other
public WGSL BC1 encoders found via GitHub code search: `halgari/texconv-js` (`src/gpu/bcn.wgsl`,
`fn encodeBC1Color(c: array<vec3<f32>, 16>) -> vec2<u32>`), `dnasoftwares/Texture-Compression-
Simulator-HTML5` (`src/gpu/shaders/bc1-compress.wgsl`), and `tebjan/VL.OCIO`'s
`webgpu-bc-encoder`. None is published to npm.

**(d) Pure TypeScript — measured here, and it is genuinely viable.**

A minimal stb_dxt-style encoder (bounding box, `INSET_SHIFT = 4` inset, perceptual 3/6/1 channel
weights, no refinement) was written and benchmarked on this machine:

```
pure-JS BC1  2048x2048 (4.19 MPix) -> 2097152 bytes in 0.129s = 32.5 MPix/s
extrapolated 8192x8192 (67.11 MPix): 2.1s single-threaded
```

Add the mip tail (×1.328) → **2.8 s single-threaded for a 16×16 map**. Across 8 workers (M4 has 10
cores) → **~0.4 s**. Adding one least-squares refinement round roughly halves throughput and is
worth it; budget ~6 s single-threaded / ~0.8 s across workers for the quality mode.

**This changes the architecture conclusion.** Pure TS is not a token fallback here — it is a
perfectly shippable path, and it is the only path that runs identically in the CLI under Node with
no native or WASM dependency. Make it the reference implementation the tests assert against, exactly
as `docs/ARCHITECTURE.md` already says, and let `gputex` be the accelerator.

### 6.3 Recommendation

**Two encoders, one output contract.**

```
packages/core/src/texture/bc1-cpu.ts     pure TS, stb_dxt-style + 1 refit round. The reference.
                                          Runs in Node, in workers, in CI. 32.5 MPix/s/thread.
packages/core/src/texture/bc1-gpu.ts     thin wrapper over gputex's BC1Encoder. Used when
                                          pickBackend() === 'webgpu'. ~0.26 ms/2048² pass.
packages/core/src/texture/bc1.test.ts     asserts gpu and cpu agree within a PSNR tolerance on
                                          a fixed corpus, and that both produce byte-identical
                                          block rasters for flat/constant blocks.
```

Throughput expectations for the full 16×16 map (8192² + 4-level mips = 89.1 MPix of encode):

| Route | Encode time | Notes |
|---|---|---|
| `gputex` WebGPU (f16) | **~150–400 ms** end-to-end | shader ~6 ms; dominated by upload/readback |
| `gputex` WebGL2 fallback | ~0.5–2 s | fragment-shader encoder, `RGBA32UI` render target + readback |
| Pure TS, 8 workers | **~0.4 s** (fast) / ~0.8 s (with refit) | measured 32.5 MPix/s/thread |
| Pure TS, single thread | 2.8 s (fast) / ~6 s (with refit) | the CLI baseline |
| rgbcx WASM level 18 | ~20–60 s (est.) | v2, only for the RDO size win |

Every one of those is fast enough. **BC1 encoding is not the bottleneck in this pipeline — LZMA is
(§7).**

### 6.4 Gotchas specific to SMT

* **Deduplication keys on all 680 bytes** (`smt-format.md:207-208`) — including the mip tail. Tiles
  whose mip 0 matches but whose mips 1–3 differ (because the mips came from different parts of the
  1024² chunk) will **not** dedup, and that is correct behaviour, not a bug in your encoder.
* **Expect near-zero dedup on procedural terrain** (`smt-format.md:526-528`). Size your `.smt`
  budget at the zero-dedup number: **44 564 512 B for a 16×16 map**.
* **`GL_TEXTURE_MAX_LEVEL = 3`** on the 1024² big-square textures — the chain stops at 128×128.
  Confirmed independently in the engine, not just in the companion doc:
  `RecoilEngine@master :: rts/Map/SMF/SMFGroundTextures.cpp:605` (`glTexParameteri(ttarget,
  GL_TEXTURE_MAX_LEVEL, 3)`), with the in-tile mip offsets at `:515`
  (`constexpr int TILE_MIP_OFFSET[] = {0, 512, 512+128, 512+128+32};` — i.e. `{0, 512, 640, 672}`,
  exactly as `smt-format.md:155-158` says) and the 32×32-tiles-per-big-square loop at `:515-526`
  (`BLOCK_SIZE = 32` tiles × 32 texels = the 1024² chunk). Do not generate more levels than you store.
* **Encode in chunks of 1024×1024**, not the whole 8192². This is required by
  `maxTextureDimension2D`/`maxBufferSize` (§1.5) *and* it is what reproduces pymapconv's mip
  semantics. Two constraints, one answer.

---

## 7. Archive writing — `.sd7` vs `.sdz`

### 7.1 First, the definitive answer on `.sdz`

**Yes. `.sdz` (plain PKZIP + deflate) is accepted by the engine and by BAR's map pool schema. It is
a safe default and 7z is an optimisation.**

Evidence, all from `docs/research/map-archive.md`, which read it out of the engine source:

* `ArchiveLoader.cpp:19-34` registers five factories keyed on the lower-cased extension;
  `sdz → CZipArchive (SDZ = 2)`, "PKZIP, via bundled minizip + zlib" (`map-archive.md:65`).
* BAR's own metadata schema `maps-metadata/schemas/cdn_maps.yaml` requires
  `pattern: '^[^ ]+\.(sd7|sdz)$'` — **`.sdz` is explicitly permitted** (`map-archive.md:504-507`).
* `.sdz` is never solid, so the solidity gate that rejects badly-packed `.sd7` files is a no-op:
  `CZipArchive::CheckForSolid()` inherits `return false` (`IArchive.h:136`), and
  `maps-metadata`'s parser hardcodes `isMapArchiveSolid() === false` for `.sdz`
  (`cloud/map-parser/src/parse-worker.ts:39-48`) — `map-archive.md:179-183`.

The constraints on a `.sdz`, from `map-archive.md:157-177`:

* **Store (0) and deflate (8) only.** bzip2 is let through the method check at `unzip.c:1402-1408`
  but the engine never defines `HAVE_BZIP2`, so `unzip.c:1420-1445` takes the `#else` branch, sets
  `raw = 1`, and hands you the *compressed bytes as file content*. Silent corruption. Never bzip2.
  Deflate64, LZMA-in-zip, zstd-in-zip, XZ-in-zip: all rejected as `UNZ_BADZIPFILE`.
* **No encryption** — the bundled minizip is built with `-DNOCRYPT -DNOUNCRYPT`
  (`rts/lib/minizip/CMakeLists.txt:21`). Note this is inside the `else(MINIZIP_FOUND)` branch: a
  distro build that links a *system* minizip is not covered by that line. Never encrypt anyway.
* **No ZIP64.** The engine opens with `unzOpen()` = `unzOpenInternal(path, NULL, 0)`,
  `is64bitOpenFunction = 0` (`ZipArchive.cpp:29`, `unzip.c:698`). Stay under 4 GiB total and 65 535
  entries.
* **Filename buffer is 512 bytes** (`ZipArchive.cpp:44`, `char fName[512]`). **Correction: longer
  names are not "silently skipped" — they are worse than that.** minizip only NUL-terminates the
  caller's buffer when the name is *strictly shorter* than it
  (`unzip.c:858-864`: `if (file_info.size_filename < fileNameBufferSize) { *(szFileName +
  size_filename) = '\0'; … } else uSizeRead = fileNameBufferSize;`). A name of ≥512 bytes therefore
  fills `fName` with no terminator, and `ZipArchive.cpp:52` immediately calls `strlen(fName)` on it —
  an out-of-bounds read, with whatever garbage follows on the stack becoming the archived name. The
  practical rule is unchanged (**keep every path under 512 bytes**); the severity is not.
* **Per-file uncompressed size is cast to `int`** (`ZipArchive.cpp:63`) — under 2 GiB per file.
* CRC is verified on read; a mismatch returns 0 bytes (`ZipArchive.cpp:157-162`).

`fflate@0.8.3` satisfies all of these by construction. Verified by reading
`101arrowz/fflate@master :: src/index.ts` on 2026-09-13: the ZIP writer `wzh()` (line 2809) writes
32-bit sizes (`wbytes(d, b + 8, f.size)`, line 2823) and errors on filenames over 65 535 bytes
(line 3153, `err(11)` = `'filename too long'`, error table at lines 200-212) — **there is no ZIP64
write path**, only a ZIP64 *read* path (`z64hs()`, line 2772). That is exactly what you want against
`unzOpen()`.

**Gap found by the fact-check pass — fflate's ZIP output is NOT deterministic by default.** `wzh()`
bakes a DOS timestamp into every local and central header from `Date.now()` when the entry has no
`mtime` (line 2817: `const dt = new Date(f.mtime == null ? Date.now() : f.mtime)`), and rejects years
outside 1980-2099 (line 2818, `err(10)` = `'date not in range 1980-2099'`). §10.2's "every writer must
be deterministic" rule therefore **requires** setting an explicit fixed `mtime` on every entry:

```ts
const EPOCH = Date.UTC(1980, 0, 1);   // any fixed value in 1980..2099
zipSync(Object.fromEntries(entries.map(e => [e.name, [e.data, { level: 9, mtime: EPOCH }]])));
```

Without it, `sha256(.sdz)` changes on every run and the golden-file tests in §10.2 cannot exist for
the `.sdz` path. (The `.sd7` writer in §7.4 has no mtime property at all, so it is already
deterministic — §10.2 says so; the `.sdz` path was the unnoticed exception.)

### 7.2 Measured — what the size difference actually costs

Real BAR map `hooked_1.1.1.sd7` (downloaded from the BAR CDN, md5 `a20c461a5fd19d6b22e4894473637b89`),
**67 files, 37 023 076 B (35.31 MiB) uncompressed**, extracted then repacked every way:

| Method | Output bytes | vs shipped | Wall time | Throughput |
|---|---|---|---|---|
| **shipped `.sd7`** (7-Zip, LZMA2, non-solid) | 20 272 378 | — | — | — |
| `7z-wasm` 24.09 `a -t7z -m0=lzma2 -mx=6 -md=64m -ms=off` | **20 272 379** | +0.000 % | **5.73 s** | **6.16 MiB/s** |
| py7zr LZMA2 preset `9\|EXTREME`, non-solid | 20 181 097 | −0.45 % | 7.54 s | 4.68 MiB/s |
| hand-written TS 7z writer + `@napi-rs/lzma` LZMA2 preset 6, dict 64 MiB | 20 228 708 | −0.22 % | 9.16 s | 3.86 MiB/s |
| **`zip -r -9` → `.sdz`** | **23 688 354** | **+16.85 %** | **1.95 s** | 18.1 MiB/s |
| `zip -r -6` → `.sdz` | 23 759 644 | +17.20 % | 1.02 s | 34.6 MiB/s |

And the preset curve, `xz` (liblzma) on a 37 249 024 B solid tar of the same tree, single-threaded:

| Preset | Output | Time | Throughput | vs `-9` |
|---|---|---|---|---|
| `xz -1` | 21 448 076 | 2.25 s | 15.8 MiB/s | +6.31 % |
| `xz -3` | 21 228 364 | 3.96 s | 9.0 MiB/s | +5.22 % |
| `xz -6` | 20 184 004 | 7.66 s | 4.6 MiB/s | +0.05 % |
| `xz -9` | 20 174 880 | 7.18 s | 4.9 MiB/s | — |
| `xz -d` (decompress `-9`) | — | 0.65 s | **54.6 MiB/s** | — |

**Read those two tables together and the engineering answer falls out:**

* **`.sdz` costs 16.9 % more bytes and saves ~4 s.** For a 20 MB map that is 3.4 MB. Not free, not
  fatal.
* **Preset 1 → 9 is only a 6.3 % size difference but a 3.2× time difference.** `-mx=6` / preset 6 is
  the knee of the curve; `-mx=9` buys 0.05 % over `-mx=6` and is not worth it in a browser.
* **Decompression is 11× faster than compression**, so nothing you do here hurts load time.

### 7.3 The library survey

| Library | Version | Verdict |
|---|---|---|
| **`7z-wasm`** | **1.2.0** (2025-06-23) | **Recommended.** Real 7-Zip 24.09 built with emscripten (`7zz.wasm` contains the literal banner `7-Zip (z) 24.09 (LE) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29`), the *full `7zz` CLI* — creates archives, not just reads them. 1 831 989 B unpacked = **1.75 MiB / 1.83 MB**, 10 files. MEMFS + NODEFS + WORKERFS compiled in (all three appear in `7zz.es6.js`; `index.d.ts` exposes `FS`, `NODEFS`, `WORKERFS`, `callMain`). Verified single-threaded at the wasm level: the memory section's limits flag is `1` (max, **not** shared), and the glue has zero occurrences of `SharedArrayBuffer`, `pthread`, or `new Worker` — so **no COOP/COEP required**. **Licence: LGPL-2.1 + unRAR restriction — see the correction below.** |
| `sevenzip-wasm` | **26.3.0** (2026-09-06) | Newer upstream (7-Zip 26.03, Emscripten 6.0.1), same "Alone2" CLI-in-WASM model, MEMFS/NODEFS/WORKERFS. npm `license` field: `"GNU LGPL 2.1 with unRAR license restriction"`. **This is the same licence as `7z-wasm`** (see below), so it is *not* a reason to prefer one over the other. Keep as a fallback if 7z-wasm stalls; it is the more current 7-Zip. |
| **`@napi-rs/lzma`** | **1.5.1** (2026-07-14) | **Recommended for the CLI; conditional for the browser.** Pure-Rust `lzma-rust2` via napi-rs. Ships **raw LZMA2** with an explicit `dictSize` — exactly the coder a 7z folder needs, **but only through the streaming API; see the §7.4 correction.** **16 prebuilt native targets plus a `wasm32-wasi` build (17 total)**, the wasm one resolved through the `browser` export condition. **Its browser build spawns worker threads and allocates shared memory, so the page must be cross-origin isolated (COOP `same-origin` + COEP `require-corp`)** — stated in its own README. |
| `lzma` | 2.3.2 | Currently in your root `package.json`. This is LZMA-JS: slow, JS-only, and its *compressor* is not competitive. Replace it. |
| `lzma-js` / `lzma-purejs` / `lzma1` | 1.0.1 / 0.9.3 / 0.3.0 | All decoder-focused or very old. No. |
| `lzma-native` | 8.0.6 | node-gyp native liblzma. Works, but needs a compiler on install; `@napi-rs/lzma` ships prebuilts and has a browser story. |
| `libarchive.js` / `libarchive-wasm` | 2.0.2 / 1.2.0 | **Read-only.** libarchive's 7z *writer* is not what these expose. Not an option. |
| `xz-decompress` | 0.2.3 | Decoder only. |
| **`fflate`** | **0.8.3** (**2026-05-16**, not 2026-07-20 — registry `time` field) | **Recommended for `.sdz`.** MIT, ~8 kB for the zip path, sync + async + streaming, no WASM, no COOP/COEP, no ZIP64 write. **Set an explicit `mtime` on every entry or the output is not reproducible** — see §7.1. |
| `@zip.js/zip.js` | 2.14.1 (2026-09-12) | BSD-3-Clause, very capable (streams, workers, ZIP64). Heavier than fflate and you specifically *don't want* its ZIP64. |
| `client-zip` | 2.5.0 (2025-03-14) | Store-only streaming zip. Would make a `.sdz` that is 35 MiB instead of 23 MiB. No. |

**Licence correction — the most load-bearing error this fact-check pass found.** The first draft of
this table recommended `7z-wasm` over `sevenzip-wasm` on the grounds that the latter carries "GNU LGPL
2.1 with unRAR license restriction" and *"an unRAR clause in a map builder is a licence conversation
you do not need."* **That differentiator does not exist.** `7z-wasm@1.2.0`'s own `License.txt`,
extracted from the published tarball and read verbatim, says:

> Licenses for files are:
>   1) 7zz.\*.js, 7zz.wasm: GNU LGPL + unRAR restriction
>   2) All other files:  GNU LGPL

Its `package.json` declares `"license": "SEE LICENSE IN License.txt"`, and it also ships
`unRarLicense.txt`. Both candidates are LGPL + unRAR; there is no clean-licence option among the
real-7-Zip WASM builds, because the unRAR clause travels with 7-Zip's own source.

What this actually means for an MIT project:

* **The LGPL is the part that matters, not the unRAR clause.** The unRAR restriction only forbids
  using the unRAR sources to build a RAR *compressor*; nothing in Terrasmith does that.
* **LGPL-2.1 + a bundled WASM blob is a dynamic-linking-shaped question.** You ship `7zz.wasm`
  unmodified and load it at runtime. The conventional reading is that this is LGPL §6-style use, not
  a derived work, and that you must (a) keep the licence text with the distribution, (b) not
  relabel the file as MIT, and (c) leave the user able to replace it. That is cheap to do: keep
  `License.txt` beside the asset and say so in the about box. **It is a decision to take
  deliberately, not a footnote — and the first draft skipped it by believing 7z-wasm was clean.**
* **`fflate` (MIT) and the hand-written writer in §7.4 (your own code) remain fully MIT paths.** If
  the LGPL blob is unacceptable, the answer is path 3 in §7.5, not path 2, because it produces
  `.sd7` with no 7-Zip code at all. That raises the strategic value of §7.4 considerably.
* The `readline-sync` runtime dependency 7z-wasm declares is referenced only by `cli.js`; the browser
  entries `7zz.es6.js` / `7zz.umd.js` contain zero references to it, so it never reaches a web bundle.

### 7.4 Hand-writing a minimal 7z — **verified practical**

This was the question worth actually answering, so it was answered by building it.

**The format, from the 7-Zip SDK's own `DOC/7zFormat.txt` (18.06).** Little-endian throughout
(`:102`, *"7z uses little endian encoding"*). **All line citations in this section were re-checked
against `mcmilk/7-Zip-zstd@master :: DOC/7zFormat.txt` (469 lines) on 2026-09-13 and corrected — the
first draft's ranges were each off by a few lines.**

`UINT64` in headers is a variable-length encoding (`7zFormat.txt:111-122`):

```
First_Byte (binary)   Extra        Value
0xxxxxxx              —          : (xxxxxxx)
10xxxxxx              BYTE y[1]  : (xxxxxx << 8)  + y
110xxxxx              BYTE y[2]  : (xxxxx  << 16) + y
...
1111110x              BYTE y[6]  : (x      << 48) + y
11111110              BYTE y[7]  : y
11111111              BYTE y[8]  : y                 <- always-legal 9-byte form; just use this
```

`REAL_UINT64` (in the SignatureHeader only) is a plain 8-byte LE integer.

**SignatureHeader — 32 bytes, fixed** (`7zFormat.txt:171-188`). Every offset below was re-derived
from that block and cross-checked against the working writer's output:

| Offset | Size | Type | Field | Value |
|---|---|---|---|---|
| `0x00` | 6 | `BYTE[6]` | `kSignature` | `37 7A BC AF 27 1C` = `'7','z',0xBC,0xAF,0x27,0x1C` |
| `0x06` | 1 | `BYTE` | `ArchiveVersion.Major` | `0x00` |
| `0x07` | 1 | `BYTE` | `ArchiveVersion.Minor` | `0x04` |
| `0x08` | 4 | `UINT32` | `StartHeaderCRC` | CRC32 of the **20 bytes at 0x0C** |
| `0x0C` | 8 | `REAL_UINT64` | `NextHeaderOffset` | offset of the Header **relative to byte 32** |
| `0x14` | 8 | `REAL_UINT64` | `NextHeaderSize` | byte length of the Header |
| `0x1C` | 4 | `UINT32` | `NextHeaderCRC` | CRC32 of the Header bytes |
| `0x20` | — | — | — | packed streams start here |

**Property IDs used** (`7zFormat.txt:129-165`; the full list runs `0x00 kEnd` … `0x19 kDummy`):

| ID | Name | | ID | Name |
|---|---|---|---|---|
| `0x00` | `kEnd` | | `0x0A` | `kCRC` |
| `0x01` | `kHeader` | | `0x0B` | `kFolder` |
| `0x04` | `kMainStreamsInfo` | | `0x0C` | `kCodersUnPackSize` |
| `0x05` | `kFilesInfo` | | `0x0D` | `kNumUnPackStream` |
| `0x06` | `kPackInfo` | | `0x11` | `kName` |
| `0x07` | `kUnPackInfo` | | `0x17` | `kEncodedHeader` |
| `0x08` | `kSubStreamsInfo` | | `0x0E` | `kEmptyStream` |
| `0x09` | `kSize` | | `0x0F` | `kEmptyFile` |

**Coder record inside a Folder** (`7zFormat.txt:237-261`; bit 7 is *"There are more alternative
methods. (Not used anymore, must be 0)"*, line 248):

```
BYTE flags {
  bits 0:3  CodecIdSize
  bit  4    Is Complex Coder      (0 for LZMA2)
  bit  5    There Are Attributes  (1 for LZMA2 — it carries the dict-size prop)
  bit  6    Reserved
  bit  7    must be 0
}
BYTE CodecId[CodecIdSize]         // LZMA2 = 0x21 (1 byte); LZMA1 = 03 01 01 (3 bytes)
if (attrs) { UINT64 PropertiesSize; BYTE Properties[PropertiesSize]; }
```

So for LZMA2 the flag byte is `0x01 | 0x20 = 0x21`, CodecId is the single byte `0x21`,
`PropertiesSize` is `1`, and the property is the dictionary-size code.

**The LZMA2 dictionary-size property byte**, read out of the engine's own vendored decoder
(`beyond-all-reason/pr-downloader :: src/lib/7z/Lzma2Dec.c:35,57-69`):

```c
#define LZMA2_DIC_SIZE_FROM_PROP(p) (((UInt32)2 | ((p) & 1)) << ((p) / 2 + 11))

static SRes Lzma2Dec_GetOldProps(Byte prop, Byte *props) {
  UInt32 dicSize;
  if (prop > 40) return SZ_ERROR_UNSUPPORTED;
  dicSize = (prop == 40) ? 0xFFFFFFFF : LZMA2_DIC_SIZE_FROM_PROP(prop);
  ...
}
```

| prop | dictSize | | prop | dictSize |
|---|---|---|---|---|
| 0 | 4 KiB | | 20 | 4 MiB |
| 12 | 256 KiB | | 24 | **16 MiB** |
| 16 | 1 MiB | | 26 | 32 MiB |
| 18 | 2 MiB | | **28** | **64 MiB** |
| 19 | 3 MiB | | 40 | 0xFFFFFFFF |

(Even `p`: `2^(p/2 + 12)`. Odd `p`: `3 × 2^((p-1)/2 + 11)`.)

**Folder shape the engine will accept** (`CheckSupportedFolder`, `7zDec.c:306-373`, re-read
2026-09-13; quoted in `map-archive.md:143-146`):
`NumCoders` must be **1, 2, or 4** — the guard is `if (f->NumCoders < 1 || f->NumCoders > 4) return
SZ_ERROR_UNSUPPORTED;` (`:308-309`) and 3 then falls through to the trailing
`return SZ_ERROR_UNSUPPORTED;` (`:372`). With 2 coders, exactly one bond `1→0` and one pack stream
(`:325-333`); the 4-coder form must be exactly the BCJ2 topology (`:353-368`). The accepted main
methods are `k_Copy = 0`, `k_LZMA = 0x30101`, `k_LZMA2 = 0x21` (`7zDec.c:23-30`, `IS_MAIN_METHOD` at
`:279-294`), each with `NumStreams == 1` (`IS_SUPPORTED_CODER`, `:296-302`). A one-coder LZMA2 folder is the simplest legal case
and is what every real BAR `.sd7` uses — `map-archive.md:226-233` measured *"One folder per file,
LZMA2, every time"* across all six sampled maps.

**The writer.** Verified working; the whole thing is below (CRC32 table and file walking elided).

```ts
// --- 7z variable-length UINT64: always use the 9-byte 0xFF form. Legal, trivial, 8 bytes of slack.
// VERIFIED against the reader the engine actually runs: pr-downloader :: src/lib/7z/7zArcIn.c:195-230
// (ReadNumber). firstByte 0xFF sets every mask bit, so the loop at :216-228 consumes 8 more bytes
// little-endian and returns them verbatim. The 0xFF form is unambiguously accepted.
function writeNumber(out: number[], value: number | bigint) {
  let v = BigInt(value);
  if (v < 0x80n) { out.push(Number(v)); return; }
  out.push(0xFF);
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
}

// --- LZMA2 dict prop, inverting Lzma2Dec.c:35
function lzma2DictProp(dictSize: number): number {
  for (let p = 0; p < 40; p++) {
    if ((2 | (p & 1)) * 2 ** (Math.floor(p / 2) + 11) >= dictSize) return p;
  }
  return 40;
}

export async function write7z(
  entries: { name: string; data: Uint8Array }[],
  { preset = 6, dictSize = 1 << 26 } = {},
): Promise<Uint8Array> {
  const dictProp = lzma2DictProp(dictSize);
  const packed: Uint8Array[] = [];
  for (const e of entries) packed.push(await lzma2CompressRaw(e.data, preset, dictProp));

  const h: number[] = [];
  h.push(0x01);                                     // kHeader
  h.push(0x04);                                     //   kMainStreamsInfo
  // -- PackInfo
  h.push(0x06); writeNumber(h, 0); writeNumber(h, entries.length);   // PackPos=0, NumPackStreams
  h.push(0x09); for (const p of packed) writeNumber(h, p.length);    // kSize
  h.push(0x00);                                     //   kEnd (PackInfo)
  // -- UnPackInfo: one folder per file, one LZMA2 coder per folder  => NON-SOLID
  h.push(0x07);
  h.push(0x0B); writeNumber(h, entries.length); h.push(0x00);        // kFolder, NumFolders, External=0
  for (let i = 0; i < entries.length; i++) {
    writeNumber(h, 1);      // NumCoders = 1
    h.push(0x21);           // flags: CodecIdSize=1 | attributes present (0x20)
    h.push(0x21);           // CodecId = LZMA2
    writeNumber(h, 1);      // PropertiesSize = 1
    h.push(dictProp);       // the dictionary-size code
  }
  h.push(0x0C); for (const e of entries) writeNumber(h, e.data.length); // kCodersUnPackSize
  h.push(0x0A); h.push(0x01);                                          // kCRC, AllAreDefined = 1
  for (const e of entries) u32le(h, crc32(e.data));
  h.push(0x00);                                     //   kEnd (UnPackInfo)
  // -- SubStreamsInfo: exactly one substream per folder. kSize and kCRC are omitted because the
  //    folder unpack size and folder CRC already define them. THE ENGINE TOLERATES THIS SECTION
  //    BEING ABSENT ENTIRELY; py7zr DOES NOT (it dereferences num_unpackstreams_folders). Emit it.
  h.push(0x08);
  h.push(0x0D); for (let i = 0; i < entries.length; i++) writeNumber(h, 1);
  h.push(0x00);                                     //   kEnd (SubStreamsInfo)
  h.push(0x00);                                     //   kEnd (StreamsInfo)
  // -- FilesInfo: names only. No kEmptyStream property => every entry must have data.
  h.push(0x05); writeNumber(h, entries.length);
  const names: number[] = [0x00];                   // External = 0
  for (const e of entries) {
    // BUG FIXED BY THE FACT-CHECK PASS. The first draft wrote:
    //   for (const ch of e.name) { const c = ch.charCodeAt(0); ... }
    // `for...of` iterates by CODE POINT, so an astral character arrives as a 2-unit string and
    // charCodeAt(0) keeps only the high surrogate -- emitting invalid, truncated UTF-16. Iterate by
    // code UNIT instead. (ASCII map filenames never hit this; a user-named map can.)
    for (let i = 0; i < e.name.length; i++) {
      const c = e.name.charCodeAt(i);
      names.push(c & 0xff, (c >> 8) & 0xff);
    }
    names.push(0x00, 0x00);                         // UTF-16LE NUL terminator
  }
  // Also: `h.push(...names)` throws RangeError once `names` is large (spread becomes an argument
  // list). Append with a loop. The engine requires the property size to cover the External byte and
  // to end EXACTLY on the last terminator -- SzReadFileNames returns SZ_ERROR_ARCHIVE unless
  // `pos == size` (7zArcIn.c:1020-1046).
  h.push(0x11); writeNumber(h, names.length); for (const b of names) h.push(b);
  h.push(0x00);                                     //   kEnd (FilesInfo)
  h.push(0x00);                                     // kEnd (Header)

  const header = new Uint8Array(h);
  const packedTotal = packed.reduce((a, b) => a + b.length, 0);

  const sig = new Uint8Array(32);
  sig.set([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04], 0);
  const start = new DataView(new ArrayBuffer(20));
  start.setBigUint64(0, BigInt(packedTotal), true);   // NextHeaderOffset, relative to byte 32
  start.setBigUint64(8, BigInt(header.length), true); // NextHeaderSize
  start.setUint32(16, crc32(header), true);           // NextHeaderCRC
  const startBytes = new Uint8Array(start.buffer);
  sig.set(startBytes, 12);
  new DataView(sig.buffer).setUint32(8, crc32(startBytes), true); // StartHeaderCRC
  return concat([sig, ...packed, header]);
}
```

**Verification, run during this research.** Input: the 67 files extracted from `hooked_1.1.1.sd7`.

```
$ node write7z.mjs ext mine.7z
wrote mine.7z: 67 files, 20228708 bytes, 9.16s

$ node -e "…7z-wasm… callMain(['t','mine.7z'])"
7-Zip (z) 24.09 (LE) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29
Testing archive: mine.7z
--
Path = mine.7z
Type = 7z
Physical Size = 20228708
Headers Size = 5634
Method = LZMA2:26
Solid = -
Blocks = 67
Everything is Ok
Files: 67
Size:       37023076
Compressed: 20228708
```

And with py7zr: 67 entries extracted, **0 mismatches** against the originals, byte for byte.

`Solid = -` and `Blocks = 67` are the two properties `map-archive.md:186-196` says the engine's
`CheckForSolid()` heuristic and `CArchiveScanner::CheckCompression()` care about. The output is
**0.22 % smaller than the shipped BAR archive**.

**Five traps, two of them found by the fact-check pass:**

1. **`kSubStreamsInfo` is optional and the engine genuinely tolerates its absence — but emit it
   anyway.** *(This closes open question 8, from primary source.)* In the reader the engine runs,
   `pr-downloader :: src/lib/7z/7zArcIn.c:964-973`:

   ```c
   if (type == k7zIdSubStreamsInfo) { RINOK(ReadSubStreamsInfo(p, sd, ssi)); RINOK(ReadID(sd, &type)); }
   else { ssi->NumTotalSubStreams = p->NumFolders; }
   ```

   With the section absent, `NumTotalSubStreams` defaults to exactly one substream per folder — which
   is precisely the one-file-per-folder layout this writer emits — and the later consistency check
   `if (numFiles - numEmptyStreams != ssi.NumTotalSubStreams) return SZ_ERROR_ARCHIVE;` (`:1285-1286`)
   then passes. So the engine would load it. **Emit the section regardless**, because py7zr crashes
   without it (`AttributeError: 'NoneType' object has no attribute 'num_unpackstreams_folders'`) and
   BAR's own `maps-metadata` tooling parses archives in CI. It costs `2 + N` bytes.

   The writer's choice to omit `kSize` and `kCRC` *inside* `kSubStreamsInfo` is also verified correct:
   in `ReadSubStreamsInfo` (`7zArcIn.c:861-932`), `numStreams == 1` contributes `numStreams - 1 = 0`
   to `numUnpackSizesInData` (`:886`) and, because the folder CRC is defined, `0` to `numSubDigests`
   (`:887-888`). There is nothing left for either sub-property to carry.
2. **Folder CRCs are only *checked* if defined** — `7zDec.c:593-596`:
   ```c
   if (res == SZ_OK)
     if (SzBitWithVals_Check(&p->FolderCRCs, folderIndex))
       if (CrcCalc(outBuffer, outSize) != p->FolderCRCs.Vals[folderIndex])
         res = SZ_ERROR_CRC;
   ```
   So `kCRC` is optional, but omit it and a corrupted archive fails silently at load. Always emit it.
3. **Zero-byte files need `kEmptyStream`.** The writer above skips them, and the engine *enforces*
   this: `7zArcIn.c:1285-1286` rejects the archive outright unless
   `numFiles - numEmptyStreams == NumTotalSubStreams`. A zero-byte entry with no `kEmptyStream`
   (0x0E) bit vector is `SZ_ERROR_ARCHIVE`, not a silent oddity. Directory entries are irrelevant —
   `SzArEx_IsDir` entries are skipped by the engine
   (`RecoilEngine :: rts/System/FileSystem/Archives/SevenZipArchive.cpp:140-142`, re-verified
   2026-09-13; `map-archive.md:150-153`).

4. **`@napi-rs/lzma`'s one-shot API cannot set `preset` or `dictSize`, so `lzma2CompressRaw` above is
   not implementable as a one-liner.** Read from the published `1.5.1` type definitions:
   `lzma2.compress(input, signal?)` and `lzma2.compressSync(input)` take **no options object at all**
   (`index.d.ts:185-204`). `preset` (0..=9, default 6) and `dictSize` (default **8 MiB**) live only on
   `Lzma2CompressorOptions` (`index.d.ts:145-150`), which is accepted by the incremental
   `Lzma2Compressor` class and by `lzma2.compressStream()`. So:

   ```ts
   import { Lzma2Compressor } from '@napi-rs/lzma';
   async function lzma2CompressRaw(data: Uint8Array, preset: number, dictSize: number) {
     const c = new Lzma2Compressor({ preset, dictSize });   // NOT lzma2.compress(data, {...})
     const head = c.update(data);
     const tail = await c.finish();
     return concat([head, tail]);
   }
   ```

   And pass the **same** `dictSize` to `lzma2DictProp()`, not a separately-chosen one. Getting this
   wrong is not loud: a folder encoded with the 8 MiB default but labelled `dictProp` 28 still
   *decodes* correctly (a decoder dictionary larger than the encoder's is always safe), so every test
   passes while the engine allocates 64 MiB of dictionary per folder for nothing and `7z l -slt`
   misreports the method as `LZMA2:26`. The rounding direction in `lzma2DictProp` is likewise
   load-bearing and correct as written: it rounds **up** to the next representable size. Rounding
   down would declare a dictionary smaller than the encoder used and produce genuinely corrupt output.

5. **Names are UTF-16LE and the property size must land exactly.** `SzReadFileNames`
   (`7zArcIn.c:1020-1046`) requires the last two bytes of the `kName` payload to be `00 00` and
   returns `SZ_ERROR_ARCHIVE` unless the walk ends with `pos == size`. Off-by-one in the property
   size, or a lone surrogate (trap in the code comment above), fails the whole archive — it does not
   merely corrupt one name.

### 7.5 Definitive recommendation

**Ship three paths behind one interface.**

```ts
// packages/build/src/archive/index.ts
export interface ArchiveWriter {
  write(entries: { name: string; data: Uint8Array }[], onProgress: (f: number) => void): Promise<Uint8Array>;
}
```

| # | Path | Impl | When |
|---|---|---|---|
| **1** | `.sd7` (default) | **`7z-wasm@1.2.0`**, `a -t7z -m0=lzma2 -mx=6 -md=32m -ms=off -mmt=off` | Browser and CLI. Measured 6.2 MiB/s; ~25 s for a 150 MiB 16×16 staging tree. No COOP/COEP. One dependency, real 7-Zip, zero format risk. |
| **2** | `.sdz` (escape hatch) | **`fflate@0.8.3`** `zipSync` / `zip` with `level: 9` | When path 1 OOMs (see below), when the user is in a hurry, when debugging. 16.9 % bigger. Instant. |
| **3** | `.sd7` (streaming, v2) | the hand-written writer + `@napi-rs/lzma` | Only when you need per-file streaming progress, per-file parallelism across workers, or to compress each entry as it is produced instead of staging the whole tree. Proven to work (§7.4). |

**Why `7z-wasm` over the hand-written writer as the default:** it measured *faster* (5.73 s vs 9.16 s
on the same tree), produced the same size, and carries zero format-correctness risk. The hand-written
writer's advantage is control — streaming, worker fan-out, no MEMFS round-trip — and those are
optimisations you should buy only when you need them.

**The one hard limit on `7z-wasm`: its WebAssembly memory maxes at 2 GiB.** Parsed directly from the
shipped binary:

```
$ python3 parse-wasm-memory.py node_modules/7z-wasm/7zz.wasm
memory: flags 1 (max present, NOT shared); initial pages 260 = 16.25 MiB; max pages 32768 = 2048 MiB
```

(Re-parsed independently on 2026-09-13 from the published `7z-wasm@1.2.0` tarball: memory section,
`count 1`, `flags 1`, `initial 260`, `max 32768`. 260 × 64 KiB is **16.25** MiB, not 16 — immaterial,
but this document is supposed to be exact. `flags 1` rather than `3` is the machine-checkable proof
of the no-COOP/COEP claim: a shared memory would set bit 1.)

and it reports `32-bit ILP32 … Threads:1`. Everything — the MEMFS staging tree, the output archive,
and the LZMA match finder — lives in those 2 GiB. 7-Zip's BT4 match finder costs roughly
`11.5 × dictSize`, so:

| `-md` | encoder memory | staging headroom in 2 GiB |
|---|---|---|
| `16m` | ~190 MiB | ~1.8 GiB |
| `32m` | ~380 MiB | ~1.6 GiB |
| `64m` | ~740 MiB | ~1.2 GiB |

For a 150 MiB staging tree + 60 MiB output, `-md=64m` fits. For a 36×36 map (~700 MiB staging) it
does not. **Use `-md=32m` in the browser** — it costs ~0.2 % size over `-md=64m` on this corpus and
buys 360 MiB of headroom. Feed files in through **WORKERFS** (mount `File`/`Blob` objects read-only
from inside a worker) rather than `FS.writeFile` where you can, to avoid a second copy.

---

## 8. Gigabyte-scale data in a browser tab

### 8.1 Real ceilings

| Ceiling | Value | Source / how measured |
|---|---|---|
| `ArrayBuffer` max `byteLength` (V8, 64-bit, sandbox on) | **34 359 738 367 B = 32 GiB − 1** | `v8/v8@main :: include/v8-internal.h:281` — `constexpr size_t kMaxSafeBufferSizeForSandbox = 32ULL * GB - 1;`, used as `JSArrayBuffer::kMaxByteLength` whenever `V8_ENABLE_SANDBOX` (`src/objects/js-array-buffer.h:32-38`). Reproduced on Node v26.0.0 here: `new Uint8Array(2**35 - 1)` succeeds; `new Uint8Array(2**35)` **aborts the process** with a V8 `Check failed` fatal, not a catchable `RangeError`. *(Corrects the first draft's "2³⁴ − 1 ≈ 16 GiB": `new Uint8Array(2**34)` succeeds here, so that boundary was not the real one.)* |
| V8 JS *heap* (objects, not buffers) | ~4 GiB in a Chrome renderer | ArrayBuffer backing stores are **external** to the heap and do not count toward it. |
| wasm32 linear memory | **4 GiB** hard (2³² address space) | `memory64` lifts this but is not something to depend on in 2026. |
| `7z-wasm` linear memory | **2 GiB** | Parsed from `7zz.wasm` memory section: `max pages 32768`. |
| Practical renderer-process commit before the OOM killer | **~2–4 GiB** | Chrome shows "Aw, Snap! Error code 5". Varies with RAM and platform. |
| WebGPU `maxBufferSize` (default / typical adapter) | 256 MiB / 4 GiB − 1 | §1.5; adapter reported 4 294 967 295 here. |
| OPFS / storage quota | ~60 % of free disk (WebKit); Chrome similar, shared with IndexedDB + Cache | `navigator.storage.estimate()` |

**Budget for Terrasmith: treat 1.5 GiB of live JS-owned buffers as the hard ceiling**, and enforce it
with the byte-budget LRU from §4.3. The 16 GiB `ArrayBuffer` limit is real but the renderer process
will die long before you reach it, and a dead tab loses unsaved work.

### 8.2 OPFS — the right scratch store

`FileSystemSyncAccessHandle` support, from BCD (`api/FileSystemSyncAccessHandle.json`):
**Chrome 102, Edge (mirror), Firefox 111, Safari 15.2.** Universal. `createWritable()` on
`FileSystemFileHandle`: Chrome 86, Firefox 111, **Safari 26**.

Use it for:

* Erosion checkpoints and intermediate fields too big to keep resident.
* The export staging tree, so the archiver reads from disk instead of from a second in-memory copy.
* Autosave of the graph document.

The API to use, and its one hard rule — **`createSyncAccessHandle()` only works inside a dedicated
Web Worker**:

```ts
// inside a dedicated worker
const root   = await navigator.storage.getDirectory();
const dir    = await root.getDirectoryHandle('scratch', { create: true });
const handle = await dir.getFileHandle(`${contentHash}.f32`, { create: true });
const access = await handle.createSyncAccessHandle();   // worker-only, synchronous
access.write(field.buffer, { at: 0 });                   // fread/fwrite-style, byte offsets
access.flush();
access.close();
```

Gotchas:

* **Quota is shared** with IndexedDB and the Cache API. Poll `navigator.storage.estimate()` and call
  `navigator.storage.persist()` on first export so the browser stops treating your scratch as
  evictable.
* **Private browsing:** Chrome incognito caps OPFS around 100 MB; **Safari disables OPFS entirely**
  in private browsing. Detect and degrade to in-memory with a smaller budget.
* **OPFS is per-origin and invisible to the user.** Anything the user should keep goes out through
  §8.5, not into OPFS.

### 8.3 Transferable ArrayBuffers

Free and mandatory. `postMessage(payload, [buf.buffer])` moves ownership in O(1); the sender's view
becomes detached (`byteLength === 0`). Design the worker protocol so every message *states* whether
it transfers:

```ts
type Req = { kind: 'erode'; field: Float32Array; w: number; h: number; /* field IS transferred */ };
worker.postMessage(req, [req.field.buffer]);
// req.field.byteLength === 0 from here. Never read it again.
```

`ImageBitmap`, `OffscreenCanvas`, `MessagePort`, and `ReadableStream` are also transferable — use
`ImageBitmap` for previews so you never `postMessage` a 256 MiB RGBA array to the main thread.

### 8.4 SharedArrayBuffer and COOP/COEP — a fork in the road

`SharedArrayBuffer` requires the document to be **cross-origin isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

and `self.crossOriginIsolated === true`. In dev, `vite-plugin-cross-origin-isolation@0.1.6` sets the
headers; in production your host must.

**The cost is real and it is not about you — it is about everything you embed.** Every cross-origin
subresource (fonts, analytics, an embedded video, a CDN script) must serve `Cross-Origin-Resource-
Policy: cross-origin` or carry `crossorigin` on the tag, or it simply fails to load. For a tool with
a docs site and a gallery of example maps, this bites.

| Wants COOP/COEP | Does not |
|---|---|
| `SharedArrayBuffer` (multi-worker access to one field without copying) | `7z-wasm` (single-threaded — verified `Threads:1`) |
| `@napi-rs/lzma` **browser** build (spawns worker threads, shared memory — stated in its README) | `fflate` |
| Multi-threaded emscripten/Rust WASM generally | OPFS, WebGPU, transferable `ArrayBuffer`s |
| `Atomics.wait` for worker coordination | File System Access API |

**Recommendation: do not require cross-origin isolation for v1.** Use transferable `ArrayBuffer`s and
a shard-per-worker decomposition for erosion (each worker owns a horizontal band, halo rows are
exchanged by transfer at each iteration boundary). If you later find the halo exchange dominating,
turn COOP/COEP on behind a feature detect (`crossOriginIsolated`) and use `SharedArrayBuffer` — the
worker protocol above can carry either.

### 8.5 Saving the finished archive

Support levels, from BCD (`api/Window.json`):

| API | Chrome | Firefox | Safari |
|---|---|---|---|
| `showSaveFilePicker` | 86 (Android 132) | **false** | **false** |
| `showOpenFilePicker` | 86 (Android 132) | **false** | **false** |
| `showDirectoryPicker` | 86 (Android 132) | **false** | **false** |

So the File System Access API is **Chromium-only** in 2026. The ladder:

```ts
export async function saveArchive(bytes: Uint8Array, filename: string) {
  // 1. Chromium: stream straight to disk. No second copy in memory. Preferred.
  if ('showSaveFilePicker' in window) {
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'Spring map archive', accept: { 'application/x-7z-compressed': ['.sd7'] } }],
    });
    const w = await handle.createWritable();
    for (let o = 0; o < bytes.length; o += 8 << 20) await w.write(bytes.subarray(o, o + (8 << 20)));
    await w.close();
    return;
  }
  // 2. Everyone else: Blob + object URL. Costs one full copy; fine up to a few hundred MiB.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-7z-compressed' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
```

`browser-fs-access@0.38.0` (Apache-2.0) wraps exactly this ladder if you'd rather not own it.
`streamsaver@2.0.6` is a service-worker trick to stream downloads in Firefox/Safari — it has not been
published since 2022 and depends on a third-party ping origin; avoid.

**For a 20–60 MB `.sd7` the Blob path is completely fine.** The File System Access path matters only
if you later add "export uncompressed staging directory", where `showDirectoryPicker` genuinely is
the only sane API.

---

## 9. Desktop packaging

### 9.1 The candidates

| | Tauri v2 | Electron |
|---|---|---|
| Version | `@tauri-apps/cli@2.11.4`, `@tauri-apps/api@2.11.1` | `electron@44.3.0` (2026-09-08), `electron-builder@26.15.3` |
| Runtime | **system webview** — WebView2 (Win), WKWebView (macOS), WebKitGTK (Linux) | **bundled Chromium 152 + Node 24.20** |
| Installer size | ~3–10 MB | ~120–200 MB |
| Memory | notably lower | Chromium baseline |
| Backend | Rust | Node |
| Big-file IO | Rust `std::fs`, `tauri-plugin-fs`; zero-copy via IPC is awkward for >100 MB payloads | Node `fs`, `worker_threads`, native addons; buffers cross the boundary cheaply |

### 9.2 The deciding fact: Linux has no WebGPU under Tauri

Tauri on Linux uses **WebKitGTK**, which does not ship WebGPU. Both halves of that are now confirmed
from source rather than asserted:

* **WebKitGTK does not even build WebGPU.** `WebKit/WebKit@main :: Source/cmake/WebKitFeatures.cmake:312`
  defines `WEBKIT_OPTION_DEFINE(ENABLE_WEBGPU "Toggle WebGPU support" PRIVATE OFF)` — default **OFF** —
  and `Source/cmake/OptionsGTK.cmake` contains no occurrence of `WEBGPU` at all, so it never turns it
  on. At the preference layer,
  `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:7083-7094` gives `WebGPUEnabled`
  `defaultValue: { "ENABLE(WEBGPU_BY_DEFAULT)": true, default: false }` — only the Apple ports set
  that macro. There is therefore no runtime flag a user or an embedder can flip; the code is not in
  the build.
* **The Windows-only escape hatch is real and is Windows-only.** `tauri-apps/tauri@dev ::
  crates/tauri-utils/src/config.rs:2107` documents `additional_browser_args` verbatim as
  *"Defines additional browser arguments on Windows."* The macOS and Linux webviews expose no
  equivalent.

So a Tauri build's GPU story in 2026 is:

| Platform | Webview | WebGPU |
|---|---|---|
| Windows | WebView2 (Chromium, self-updating) | **yes** |
| macOS 26 Tahoe+ | WKWebView | **yes** (Safari 26 shipped it) |
| macOS ≤ 15 | WKWebView | **no** |
| Linux | WebKitGTK (`ENABLE_WEBGPU` OFF at build time) | **no** |

*Correction to the first draft's parenthetical:* it said Linux WebKitGTK is "distro-pinned; Ubuntu
22.04 ships webkit2gtk 2.36". The *release* pocket of jammy did ship `2.36.0-2ubuntu1`, but
`jammy-updates` and `jammy-security` currently publish **`2.50.4-0ubuntu0.22.04.1`** (Launchpad
published-sources API, checked 2026-09-13). WebKitGTK *is* security-updated in place on Ubuntu, so
"pinned to an ancient engine" overstates the case. It changes nothing about WebGPU — 2.50 does not
build it either — but it does weaken the version-skew argument in §9.4.

Electron 44.3.0 bundles **Chromium 152.0.7977.78 and Node 24.20.0**, released 2026-09-08
(`releases.electronjs.org/releases.json`, verified), and therefore has WebGPU on all three platforms,
identically, independent of what the user's OS ships.

### 9.3 Recommendation

**If the desktop build must have GPU compute on every platform: Electron 44.**

The 150 MB bundle is a real cost and you are paying it for exactly one thing — *the same Chromium
everywhere*. For a tool whose value proposition is "the preview predicts the build", a renderer that
silently differs between a Linux user and a Windows user is a correctness problem, not a polish one.
Electron also gives you Node in the main process for free, which means `packages/cli` and the desktop
build share one code path for file IO and for `@napi-rs/lzma`'s **native** binding (3.9 MiB/s
measured, no WASM, no COOP/COEP).

**If the desktop build is a convenience wrapper and the CPU path is acceptable on Linux: Tauri v2.**
It is the better product on Windows and modern macOS, and the CPU fallback (§1.3, §6.2d) is genuinely
good enough — 2.8 s of BC1 and ~25 s of LZMA is not a bad Linux experience.

**Honestly: ship the web app first and defer this.** Everything in §§1–8 runs in a browser tab today.
The only things a desktop shell buys you are (a) writing to arbitrary paths without a picker,
(b) no 2 GiB WASM ceiling, (c) native LZMA. None of those is blocking at 16×16.

### 9.4 Gotchas either way

* **Tauri:** the IPC boundary serialises. Do not route a 256 MiB `Uint8Array` through `invoke()`;
  write it to a temp file from Rust and hand back a path, or use the raw-payload channel.
  Webview version skew across Linux distros is the thing that will generate your bug reports.
* **Electron:** ASAR does not compress; a 42 MB `.smt` asset in the bundle is 42 MB. Set
  `contextIsolation: true` and route all file IO through a narrow preload bridge. Auto-update
  requires signing on both macOS and Windows — budget for certificates.
* **Both:** GPU process crashes are recoverable in Chromium and fatal-ish in WebKitGTK. If you go
  Tauri, handle `device.lost` and fall back to CPU rather than showing a dead canvas.

---

## 10. Testing

### 10.1 Runner

`vitest@5.0.0` (2026-09-03). Note that in v5 the browser providers are **separate packages**:
`@vitest/browser-playwright@5.0.0`, `@vitest/browser-webdriverio@5.0.0`, `@vitest/browser-preview@5.0.0`
(all listed in vitest's `peerDependencies`). Your root already has `vitest@^5.0.0` and
`vite@^8.3.0` — good.

### 10.2 Golden-file tests for binary formats

The format packages are where golden files earn their keep, because the failure mode is a map that
loads with a 3-elmo height offset and nobody notices for a month.

```
packages/format/test/
  golden/
    smf/16x16-flat.smf.sha256          # hash only for big artefacts
    smf/16x16-flat.header.json         # the parsed header, as readable JSON
    smt/single-tile.smt                # small enough to commit verbatim (712 bytes)
    sd7/minimal.sd7.sha256
  smf.golden.test.ts
```

Three assertion layers, in increasing strength:

```ts
// 1. Structural: decode what you encoded. Catches field-order and endianness bugs with a
//    readable diff. This is the test that actually tells you what broke.
expect(readSMFHeader(writeSMF(fixture))).toEqual(fixture.header);

// 2. Field-level golden: commit the PARSED header as JSON, not the bytes. When the format
//    changes deliberately, the diff is reviewable.
await expect(JSON.stringify(readSMFHeader(bytes), null, 2)).toMatchFileSnapshot('golden/smf/16x16-flat.header.json');

// 3. Byte-level golden: for artefacts over ~64 KiB, commit the SHA-256, not the bytes.
//    Git does not want a 42 MiB .smt and neither do you.
expect(sha256(smt)).toBe(readFileSync('golden/smt/16x16.smt.sha256', 'utf8').trim());
```

**Rules that make this not-painful:**

* **Every writer must be deterministic.** No timestamps, no `Math.random`, no `Date.now()`, no
  iteration over an unordered `Set`. Test this explicitly: `expect(write(x)).toEqual(write(x))`.
  (The 7z writer in §7.4 has no mtime property for exactly this reason — adding `kMTime` would make
  every archive byte-unique.)
* **Commit a regeneration script**, `npm run test:golden:update`, and make reviewing its diff part of
  the PR. A golden you cannot regenerate is a golden nobody updates.
* **Cross-validate against the incumbent.** The strongest test you can write is: take a real BAR
  `.sd7` from the CDN, extract it, re-encode the `.smf` header from the parsed values, and assert the
  bytes round-trip. The `hooked_1.1.1.sd7` used throughout this document is a good first fixture
  (20 272 378 B, md5 `a20c461a5fd19d6b22e4894473637b89`) — fetch it in a setup script, cache it in
  CI, do not commit it.
* **Test the archive against a real reader.** `7z-wasm`'s `callMain(['t', archive])` is a full
  integrity test using the actual 7-Zip code, in-process, in a unit test. That is as close to
  "the engine will load this" as you can get without the engine.

### 10.3 Headless GPU testing — use Dawn in Node, not headless Chrome

This is the finding worth acting on. `webgpu@0.6.1` gives you a real GPU device inside a plain Node
process (verified in §1.4), which means:

```ts
// packages/core/test/gpu/bc1.gpu.test.ts
import { beforeAll, expect, test } from 'vitest';
import { create, globals } from 'webgpu';

let device: GPUDevice;
beforeAll(async () => {
  Object.assign(globalThis, globals);
  const adapter = await create([]).requestAdapter();
  device = await adapter!.requestDevice({
    requiredFeatures: (['shader-f16', 'timestamp-query'] as const).filter(f => adapter!.features.has(f)),
  });
});

test('GPU BC1 agrees with the CPU reference', async () => {
  const gpu = await encodeBC1Gpu(device, fixture.rgba, 256, 256);
  const cpu = encodeBC1Cpu(fixture.rgba, 256, 256);
  expect(psnr(decodeBC1(gpu), decodeBC1(cpu))).toBeGreaterThan(45);
});
```

No browser, no `--enable-unsafe-swiftshader`, no Xvfb, no GPU-enabled CI runner needed if you run on
a machine with any GPU; and on a headless CI box, `create(['backend=vulkan'])` with lavapipe, or
Dawn's own null/software path, gives determinism. Compare this with the browser route (Playwright +
`--use-gl=egl` + `--enable-unsafe-swiftshader`, with WebGPU frequently needing `--headed`), which is
where most projects burn a week.

**Keep browser-mode tests for the things that are genuinely browser-shaped** — React Flow
interactions, OPFS, the save ladder — via `@vitest/browser-playwright@5.0.0`, and keep them few.

### 10.4 The test that matters most

An end-to-end "build a map" test in the CLI: evaluate a fixture graph at 8×8, write `.smf`/`.smt`/
`mapinfo.lua`, pack to `.sd7`, then verify with `7z-wasm t`, re-parse every file back out, and assert
the header fields and a SHA-256 of the heightmap block. Run it on every commit. It is slow (a few
seconds) and it is worth every one of them.

---

## 11. Build tooling

### 11.1 Versions

| Tool | Latest | Published | Note |
|---|---|---|---|
| `vite` | **8.3.0** | 2026-09-10 | `engines.node: ^20.19.0 \|\| >=22.12.0` — matches your root `>=22.12.0`. |
| `vitest` | **5.0.0** | 2026-09-03 | |
| `typescript` | **7.0.2** | 2026-07-08 | The Go-native compiler. Your root pins `~5.9.3` (5.9.3 was 2025-09-30). |
| `pnpm` | 12.4.1 | 2026-09-10 | |
| `turbo` | 2.10.12 | 2026-08-25 | |
| `nx` | 23.2.1 | 2026-09-09 | |
| `eslint` | 10.10.0 | | |
| `prettier` | 3.9.6 | | |
| `@vitejs/plugin-react` | 6.1.1 | | |

**On TypeScript 7:** it is GA and it is dramatically faster, but it is a rewrite and your
`tsc --build --force` project-references setup is exactly the kind of thing that finds its edges.
**Stay on `~5.9.3` for now**; add `tsgo` as a *second*, non-blocking typecheck job in CI
(`npx tsgo --noEmit`) and flip the default once it has been green for a month. The risk is not worth
carrying while you are still designing the format packages.

### 11.2 Monorepo tool

You are on **npm workspaces** today (`workspaces: ["packages/*", "apps/*"]`) with
`tsc --build --force` for typechecking. That is a perfectly good setup and you should not churn it
for its own sake. Two reasons to move to **pnpm workspaces**:

1. **Strict `node_modules` mechanically enforces your layering rule.** `docs/ARCHITECTURE.md` says
   *"Nothing below `studio` touches the DOM, so every layer runs in a worker, in Node, and in CI."*
   Under npm's hoisting, `packages/format` can `import` anything any sibling depends on and nothing
   complains until it breaks in the CLI. pnpm's symlinked store makes that an unresolved import at
   build time. For this project that is worth the migration on its own.
2. Disk and install speed across 6 packages plus three.js plus Dawn.

**Turborepo:** add it when `npm run build` across all packages starts annoying you, not before. Six
packages with `tsc --build` project references is already incremental. When you do add it, the
config is small:

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": ["*.tsbuildinfo"] },
    "test":      { "dependsOn": ["build"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

**Nx:** more powerful (project graph, generators, distributed task execution) and more opinionated.
For a six-package, one-team repo it is overhead. No.

### 11.3 Minimal vite config for `apps/studio`

The three non-obvious bits: WASM loading, worker format, and the COOP/COEP decision.

```ts
// apps/studio/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },              // required: your workers import ESM from packages/core
  optimizeDeps: {
    // 7z-wasm ships a large emscripten glue file; let esbuild leave it alone.
    exclude: ['7z-wasm'],
  },
  build: {
    target: 'es2022',                    // top-level await in the WASM init paths
    rollupOptions: {
      output: {
        manualChunks: {
          three:  ['three'],             // ~700 kB; keep it out of the app chunk
          flow:   ['@xyflow/react'],
          archive: ['7z-wasm', 'fflate'],
        },
      },
    },
  },
  // Uncomment ONLY if you decide to require SharedArrayBuffer (see §8.4). Doing so breaks every
  // cross-origin subresource that does not send Cross-Origin-Resource-Policy.
  // server: { headers: {
  //   'Cross-Origin-Opener-Policy': 'same-origin',
  //   'Cross-Origin-Embedder-Policy': 'require-corp',
  // } },
});
```

Notes:

* `vite-plugin-wasm@3.6.0` + `vite-plugin-top-level-await@1.6.0` are only needed if you import a
  `.wasm` module *directly*. `7z-wasm` and `gputex` ship their own loaders; you probably need neither.
* **Put every heavy dependency behind a dynamic `import()`.** `7z-wasm` is 1.8 MiB and should not be
  in the initial bundle — load it when the user clicks Export.
* `comlink@4.4.2` is a pleasant way to type the worker RPC, but it clones by default; if you use it,
  use `Comlink.transfer()` religiously for every field (§8.3).

---

## 12. Concrete dependency manifest

All versions verified with `npm view <pkg> version` on 2026-09-13.

```jsonc
// packages/core  — no DOM, no Node builtins
{ "dependencies": {} }                    // keep it zero-dep; the BC1 encoder is yours

// packages/format — no DOM, no Node builtins
{ "dependencies": {} }                    // binary readers/writers are pure TS

// packages/build
{
  "dependencies": {
    "7z-wasm": "^1.2.0",                  // .sd7 default   (1.83 MiB, single-threaded, no COOP/COEP)
    "fflate":  "^0.8.3"                   // .sdz fallback  (~8 kB, no ZIP64 write — correct for minizip)
  },
  "optionalDependencies": {
    "@napi-rs/lzma": "^1.5.1"             // native LZMA2 for the CLI; browser build needs COOP/COEP
  }
}

// apps/studio
{
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@xyflow/react": "^12.11.6",          // MIT, 38.3k stars, pushed 2026-09-10
    "three": "^0.186.0",                  // r186, WebGPURenderer + auto WebGL2 fallback
    "@react-three/fiber": "^9.7.0",
    "@react-three/drei": "^10.7.8",
    "gputex": "^0.6.0",                   // MIT, GPU BC1/BC7 + WebGL2 fallback
    "zustand": "^5.0.15",
    "immer": "^11.1.18",
    "comlink": "^4.4.2"
  }
}

// packages/cli
{
  "dependencies": { "@napi-rs/lzma": "^1.5.1" },
  "devDependencies": { "webgpu": "^0.6.1" }   // Dawn; 90.5 MiB — dev/test only
}

// root devDependencies
{
  "typescript": "~5.9.3",                 // 7.0.2 exists; add `tsgo --noEmit` as a non-blocking CI job
  "vite": "^8.3.0",
  "vitest": "^5.0.0",
  "@vitest/browser-playwright": "^5.0.0", // v5 split the providers out
  "@vitest/coverage-v8": "^5.0.0",
  "@vitejs/plugin-react": "^6.1.1",
  "eslint": "^10.10.0",
  "prettier": "^3.9.6",
  "webgpu": "^0.6.1"
}
```

**Remove `lzma@^2.3.2` from the root `package.json`.** It is LZMA-JS, its compressor is not
competitive, and nothing in the recommended stack uses it.

---

## 13. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | `7z-wasm`'s 2 GiB WASM ceiling is hit on a 36×36 map | medium | export fails | `-md=32m`; WORKERFS instead of MEMFS copies; fall back to `.sdz` (fflate streams, no WASM heap) |
| 2 | `gputex` is a single-author package (11 stars) and goes stale | medium | lose the GPU BC1 path | It is MIT and the WGSL is readable (`library/src/bc1.wgsl`); vendor it. The pure-TS path (32.5 MPix/s measured) is already a shippable fallback |
| 3 | WebGPU absent (Linux Firefox, Intel Mac Firefox, non-Intel Chrome/Linux) | **high** for some users | no GPU accel | The CPU path is the product (§1.3, §6.2d). Never gate a feature on WebGPU |
| 4 | `maxTextureDimension2D` = 8192 blocks 24×24+ maps | **certain** at 24×24 | export fails on big maps | Encode in 1024² chunks from day one — which is also what pymapconv's mip semantics require (`smt-format.md:182-192`) |
| 5 | React Flow DOM node count at 500+ | low | UI jank | `React.memo` + `onlyRenderVisibleElements` + positions out of the doc store |
| 6 | A hand-written 7z is subtly wrong in a way py7zr/7-Zip accept but the engine rejects | low | broken maps | Ship `7z-wasm` (real 7-Zip) as the default; the hand-written writer is v2 and is gated behind the `7z-wasm t` verification test |
| 7 | Cross-origin isolation gets required later and breaks the docs/gallery embeds | medium | site breakage | Decide now: **don't require it** (§8.4). Detect `crossOriginIsolated` and light up SAB only if present |
| 8 | Chrome renderer OOM ("Error code 5") during a big export | medium | lost work | Byte-budget LRU capped at 1.5 GiB; OPFS spill; autosave the graph doc before starting an export |

## 14. Open questions

1. **Does RDO BC1 actually shrink a real `.sd7`?** bc7enc_rdo claims 10–50 % for LZ-compressed
   textures and is explicitly tuned for LZMA. The `.smt` is ~40 % of the archive, so a 20 % RDO win
   would be ~8 % off the shipped file. Worth a one-day experiment before committing to an emscripten
   build in CI. **UNVERIFIED — needs confirmation.** (The 10-50 % claim *is* verified as a verbatim
   quote from bc7enc_rdo's README; whether it holds on BAR terrain inside a `.sd7` is not.)
2. **How much does tile dedup actually recover on procedurally-generated terrain?**
   `smt-format.md:526-528` predicts near-zero. If confirmed, the zero-dedup sizes in §5 are the real
   sizes and the dedup pass is pure cost — measure before optimising it.
   **UNVERIFIED — needs confirmation.**
3. **Is `.sdz` acceptable to BAR's human map-pool reviewers**, even though the schema permits it and
   0 of 226 pool maps use it (`map-archive.md:73-77`)? A social question, not a technical one, but
   it decides whether path 2 in §7.5 is a real ship path or only a debugging aid.
   **UNVERIFIED — needs confirmation, and it is not answerable from source.** What *is* verified:
   `schemas/cdn_maps.yaml` permits `.sdz` in CDN download entries, and the engine loads it. That
   schema is titled *"Map download info from springfiles API"*, so it is weaker evidence about the
   human map-pool process than the first draft implied.
4. ~~**Does WebKitGTK's WebGPU land in 2026?**~~ **Answered — no, and not imminently.** As of
   2026-09-13, WebKit trunk still defines `ENABLE_WEBGPU … OFF` for the CMake ports
   (`Source/cmake/WebKitFeatures.cmake:312`), `OptionsGTK.cmake` never enables it, and
   `WebGPUEnabled` defaults to `false` outside `ENABLE(WEBGPU_BY_DEFAULT)`
   (`UnifiedWebPreferences.yaml:7089-7091`), which only the Apple ports set. The gpuweb
   Implementation-Status wiki lists WebKit's WebGPU availability as macOS Tahoe 26 / iOS 26 /
   iPadOS 26 / visionOS 26 only, with no GTK entry. There is no runtime flag, because the code is
   not compiled in. **The Electron recommendation in §9.3 stands.** Re-check when WebKitGTK
   announces it; the trigger to watch is `ENABLE_WEBGPU` flipping in `OptionsGTK.cmake`.
5. **Erosion on GPU vs CPU crossover point.** Unmeasured. Worth a spike: a 1025² hydraulic erosion
   at 200 iterations, CPU-worker-pool vs a WGSL compute kernel, on this machine. That number decides
   how much WGSL you write. **UNVERIFIED — needs measurement. No number in this document bears on
   it.**
6. **Does the pure-TS BC1 encoder need the least-squares refinement round?** Throughput was measured
   here (it roughly halves); the PSNR delta on representative BAR terrain was **not**.
   **UNVERIFIED — needs measurement.** For reference, `gputex`'s GPU encoder does apply up to two
   refit rounds (README, "Encoding algorithm"), which is weak evidence that one round is worth it.
7. **Does 7z-wasm's WORKERFS avoid the second in-memory copy for large staging files in a worker?**
   `WORKERFS` is compiled in (verified: the string appears 23 times in `7zz.es6.js`, and `index.d.ts`
   exports it), but whether emscripten still buffers the whole file is **UNVERIFIED — needs an
   experiment**. It matters for the 2 GiB ceiling on 36×36 maps.
8. ~~**Will the engine's 7z reader accept an archive with `kSubStreamsInfo` entirely absent?**~~
   **Answered — yes.** `7zArcIn.c:964-973` defaults `NumTotalSubStreams` to `NumFolders` when the
   section is missing, and the `numFiles - numEmptyStreams == NumTotalSubStreams` check at `:1285`
   then passes for a one-file-per-folder archive. See trap 1 in §7.4 for the quoted code. The
   recommendation to emit the section anyway (for py7zr and BAR's CI tooling) is unchanged.

---

## 15. Sources

**Primary source read during this research (raw files, not summaries):**

* WebGPU spec — `gpuweb/gpuweb@main :: spec/index.bs` lines 1666, 1747, 1811, 1845, 1890, 1914
  (the supported-limits table).
* Browser support — `mdn/browser-compat-data@main :: api/GPU.json`, `api/Window.json`,
  `api/FileSystemSyncAccessHandle.json`, `api/FileSystemFileHandle.json`.
* three.js — `mrdoob/three.js@r186 :: src/renderers/webgpu/WebGPURenderer.js:53-78` (fallback),
  `src/renderers/common/Renderer.js:1115, 2877, 2992, 3033` (compute API).
  Release notes: https://github.com/mrdoob/three.js/releases/tag/r186
* 7z container format — `mcmilk/7-Zip-zstd@master :: DOC/7zFormat.txt` (7z Format description 18.06,
  469 lines). **Line ranges corrected 2026-09-13:** 111-122 (UINT64 encoding), 129-165 (property IDs),
  171-188 (SignatureHeader), 207-215 (Digests), 218-234 (PackInfo), 237-261 (Folder/coder record),
  281-312 (Coders Info), 316-338 (SubStreams Info), 341-358 (Streams Info), 361-432 (FilesInfo),
  435-457 (Header). The first draft's ranges were each off by 2-30 lines.
* LZMA2 dictionary property — `beyond-all-reason/pr-downloader@master :: src/lib/7z/Lzma2Dec.c:35,57-69`.
* 7z folder CRC check — `beyond-all-reason/pr-downloader@master :: src/lib/7z/7zDec.c:593-596`
  (verified verbatim).
* 7z accepted folder shapes and method IDs — same repo, `7zDec.c:23-30` (`k_Copy 0`, `k_LZMA2 0x21`,
  `k_LZMA 0x30101`, `k_BCJ2 0x303011B`), `:279-302` (`IS_MAIN_METHOD` / `IS_SUPPORTED_CODER`),
  `:306-373` (`CheckSupportedFolder`), `:436-459` (per-method decode dispatch).
* 7z header reader — same repo, `src/lib/7z/7zArcIn.c:195-230` (`ReadNumber`, proving the 9-byte 0xFF
  form is accepted), `:233-254` (`SzReadNumber32`), `:861-932` (`ReadSubStreamsInfo`), `:964-975`
  (SubStreamsInfo optionality, answering open question 8), `:1020-1046` (`SzReadFileNames`),
  `:1285-1286` (the `numFiles - numEmptyStreams == NumTotalSubStreams` check).
* Engine archive layer — `beyond-all-reason/RecoilEngine@master ::
  rts/System/FileSystem/ArchiveLoader.cpp:19-34` (five factories),
  `rts/System/FileSystem/Archives/IArchive.h:131,136` (`HasLowReadingCost`, `CheckForSolid` default
  `false`), `Archives/SevenZipArchive.cpp:140-142,166-171` (dir skip, solidity heuristic),
  `Archives/ZipArchive.cpp:29,44,52,63,157-162` (unzOpen, 512-byte name buffer, strlen, int cast, CRC),
  `ArchiveScanner.cpp:571-599,768-782` (`CheckCompression` and the broken-archive marking),
  `rts/lib/minizip/unzip.c:698-700,855-870,1402-1408,1420-1445`,
  `rts/lib/minizip/CMakeLists.txt:21`.
* SMF/SMT constants, read directly from the engine rather than from the companion docs —
  `RecoilEngine@master :: rts/Map/SMF/SMFFormat.h:28` (`SMALL_TILE_SIZE = 680`), `:31,34`
  (`MINIMAP_NUM_MIPMAP = 9`, `MINIMAP_SIZE = 699048`), `:49-70` (`SMFHeader` field order and the
  `squareSize`/`texelPerSquare`/`tilesize` constraints), `:119-120` (tile index array),
  `:175-183` (`TileFileHeader`, 32 bytes); `rts/Map/SMF/SMFGroundTextures.cpp:515`
  (`TILE_MIP_OFFSET[] = {0, 512, 640, 672}`, `BLOCK_SIZE = 32`), `:605`
  (`GL_TEXTURE_MAX_LEVEL, 3`).
* BAR map metadata — `beyond-all-reason/maps-metadata@main :: schemas/cdn_maps.yaml`
  (`filename.pattern: '^[^ ]+\.(sd7|sdz)$'`, verified verbatim),
  `cloud/map-parser/src/parse-worker.ts:40-49` (`isMapArchiveSolid` returns `false` for `.sdz`)
  and `:26-38` (it parses `Solid = +/-` out of 7-Zip's own output).
* V8 buffer ceiling — `v8/v8@main :: include/v8-internal.h:281`
  (`kMaxSafeBufferSizeForSandbox = 32ULL * GB - 1`), `src/objects/js-array-buffer.h:27-38`
  (`JSArrayBuffer::kMaxByteLength`), plus a live probe on Node v26.0.0.
* WebKitGTK WebGPU — `WebKit/WebKit@main :: Source/cmake/WebKitFeatures.cmake:312`
  (`ENABLE_WEBGPU … OFF`), `Source/cmake/OptionsGTK.cmake` (no `WEBGPU` occurrence),
  `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:7083-7094`.
* Tauri Windows-only browser args — `tauri-apps/tauri@dev :: crates/tauri-utils/src/config.rs:2107`.
* caniuse usage — `Fyrd/caniuse@main :: fulldata-json/data-2.0.json` (`updated` 2026-08-24), summed
  per-version `usage_global` over the `webgpu` feature's `stats`.
* Ubuntu WebKitGTK versions — Launchpad `getPublishedSources` for `webkit2gtk` in `jammy`.
* fflate zip writer — `101arrowz/fflate@master :: src/index.ts:2765-2790` (zip64 read),
  `2809-2834` (`wzh`, 32-bit write), `3153` (filename cap).
* `gputex` — https://github.com/verekia/gputex `README.md` (formats table, WebGL fallback section,
  encoding algorithm, benchmarks table), `library/src/bc1.wgsl`, `library/src/bc1_fast_f16.wgsl`.
* `bc7enc_rdo` — https://github.com/richgel999/bc7enc_rdo `README.md` (RDO/LZMA tuning), `LICENSE`
  (MIT / Unlicense dual).
* `7z-wasm` — the published `1.2.0` tarball, unpacked and inspected: `License.txt` (LGPL + unRAR —
  see the §7.3 correction), `package.json` (`"license": "SEE LICENSE IN License.txt"`), `index.d.ts`
  (`FS`/`NODEFS`/`WORKERFS`/`callMain`), and `7zz.wasm`'s memory section parsed directly
  (`flags 1`, initial 260 pages, max 32768 pages) plus its embedded version banner
  (`7-Zip (z) 24.09 (LE) … 2024-11-29`).
* `@napi-rs/lzma` — package tarball `1.5.1`: `index.d.ts:145-150` (`Lzma2CompressorOptions`:
  `preset` 0..=9 default 6, `dictSize` default 8 MiB) and `:185-204` (the one-shot `lzma2.compress` /
  `compressSync` signatures, which take **no** options — the basis for trap 4 in §7.4),
  `lzma2.d.ts`, `README.md` §Browser ("The wasm build allocates shared memory and spawns worker
  threads, so `SharedArrayBuffer` must be available — the page has to be cross-origin isolated,
  served with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.") and its note that raw LZMA2 carries no dictionary
  size in-band, so encoder and decoder must agree.
* `webgpu` (Dawn) — https://github.com/dawn-gpu/node-webgpu `README.md`; package installed and a
  real device created on this machine.
* Tauri webviews — https://v2.tauri.app/reference/webview-versions/
* Electron Chromium mapping — https://releases.electronjs.org/releases.json (44.3.0 → Chromium
  152.0.7977.78, Node 24.20.0, 2026-09-08).

**Companion Terrasmith research (re-read and cited inline):**

* `docs/research/map-archive.md` — §1.1 archive types (`ArchiveLoader.cpp:19-34`), §1.2 accepted 7z
  methods (`7zDec.c:279-294`), §1.3 `.sdz`/minizip constraints (`unzip.c`, `ZipArchive.cpp`),
  §1.4 solidity (`SevenZipArchive.cpp:160-171`), §1.5 packing recipe, §3.x filename rules
  (`cdn_maps.yaml`).
* `docs/research/smt-format.md` — `SMALL_TILE_SIZE = 680`, mip offsets `{0,512,640,672}`, block
  raster order, the 1024²-chunk mip trick, the 16×16 size table (lines 426-440), dedup expectations.
* `docs/research/smf-format.md` — `mapx`/`mapy` semantics and the derived grid table (lines 206-247).
* `docs/ARCHITECTURE.md` — package layering and the CPU-reference/GPU-accelerator contract.

**Package APIs verified by reading installed type definitions**, not documentation:
`@xyflow/react@12.11.6` + `@xyflow/system@0.0.82` (see §3.2 table),
`@napi-rs/lzma@1.5.1` (`lzma2.browser.d.ts`, `index.d.ts`),
`webgpu@0.6.1` (live device creation),
`7z-wasm@1.2.0` (`7zz.wasm` memory section, `callMain` behaviour).

**Measurements.** All timings in §6.2(d), §7.2, and §7.4 were produced on Apple M4 / 10 cores /
16 GiB / macOS Darwin 25.0.0 / Node v26.0.0, on 2026-09-13, against
`hooked_1.1.1.sd7` (BAR CDN, md5 `a20c461a5fd19d6b22e4894473637b89`, 20 272 378 B, 67 files,
37 023 076 B uncompressed). Reproduction scripts were left in the session scratchpad:
`write7z.mjs` (the 7z writer) and `bc1bench.mjs` (the pure-JS BC1 benchmark).

---

## 16. Verification log

Adversarial fact-check pass, **2026-09-13**. Every claim below was checked against a primary source
fetched during this pass — raw GitHub file, npm registry JSON, an unpacked package tarball, or a live
probe on this machine. Nothing here was confirmed from memory. Verdicts: **confirmed** (matched
exactly), **corrected** (the document has been edited), **unverified** (marked as such in the text).

### 16.1 Package versions, dates and licences — `registry.npmjs.org`

Queried directly (`/<pkg>` packument → `dist-tags.latest`, `time[latest]`, `versions[latest].license`).

| Claim | Source | Verdict |
|---|---|---|
| `three@0.186.0`, 2026-09-08, MIT | registry | confirmed |
| `@xyflow/react@12.11.6`, 2026-09-01, MIT; deps `{zustand ^4.4.0, classcat ^5.0.3, @xyflow/system 0.0.82}` | registry | confirmed (incl. the zustand-4 duplicate) |
| `zustand@5.0.15`, `immer@11.1.18`, `mutative@1.3.0`, `valtio@2.3.2`, `zundo@2.3.0`, `@reduxjs/toolkit@2.12.0` | registry | confirmed |
| `gputex@0.6.0`, 2026-07-13, MIT; `.`/`./three`/`./testing` entry points | registry | confirmed |
| `webgpu@0.6.1`, 2026-09-12; 94 898 547 B unpacked (= 90.50 MiB), 23 files | registry `dist` | confirmed |
| `7z-wasm@1.2.0`, 2025-06-23 | registry | confirmed |
| `fflate@0.8.3` published **2026-07-20** | registry `time` says **2026-05-16** | **corrected** |
| `sevenzip-wasm@26.3.0`, 2026-09-06, "GNU LGPL 2.1 with unRAR license restriction" | registry | confirmed |
| `@napi-rs/lzma@1.5.1`, 2026-07-14, MIT | registry | confirmed |
| `vite@8.3.0` (`engines.node: ^20.19.0 \|\| >=22.12.0`), `vitest@5.0.0`, `typescript@7.0.2`, `pnpm@12.4.1`, `turbo@2.10.12`, `nx@23.2.1`, `eslint@10.10.0`, `prettier@3.9.6`, `@vitejs/plugin-react@6.1.1` | registry | confirmed |
| vitest v5 splits browser providers into `@vitest/browser-{playwright,webdriverio,preview}@5.0.0`, all in `peerDependencies` | registry peerDeps | confirmed |
| `electron@44.3.0` 2026-09-08, `electron-builder@26.15.3`, `@tauri-apps/cli@2.11.4`, `@tauri-apps/api@2.11.1` | registry | confirmed |
| `rete@2.0.6`, `litegraph.js@0.7.18` (2024-01-08), `baklavajs@2.8.1`, `@comfyorg/litegraph@0.17.2` | registry | confirmed |
| `@dagrejs/dagre@3.1.1` MIT; `elkjs@0.12.0` **EPL-2.0 OR GPL-3.0-or-later** | registry | confirmed |
| The whole "no maintained BC1 encoder on npm" table (`dxt-js@0.0.3` 2017, `dxt@1.0.1` 2017, `silent-dxt-js@0.0.3` 2022, `decode-dxt@1.0.1`, `crunch-js@1.2.0` 2015, `lzma@2.3.2` 2016, `lzma-native@8.0.6` 2022, `libarchive.js@2.0.2`, `libarchive-wasm@1.2.0`, `xz-decompress@0.2.3`, `@zip.js/zip.js@2.14.1`, `client-zip@2.5.0`, `browser-fs-access@0.38.0`, `streamsaver@2.0.6` 2022, `comlink@4.4.2`, `three-mesh-bvh@0.9.15`) | registry | confirmed, every row |
| `@gpu-tex-enc/bc@1.0.11` "9.58 MiB unpacked" | registry `dist.unpackedSize` = 9 581 590 B = **9.14 MiB / 9.58 MB** | **corrected** (MiB/MB slip) |
| Terrain libs: `@mapbox/martini@0.2.0` (2020), `geo-three@0.1.15`, `three-tile@0.12.2`, `@loaders.gl/terrain@4.5.1`, `@interverse/three-terrain-lod@2.1.1` with `peerDependencies: {three: '>=0.183.0'}` | registry | confirmed |

### 16.2 GitHub repository facts — GitHub REST API, 2026-09-13

| Claim | Verdict |
|---|---|
| `xyflow/xyflow` 38 353 stars, pushed 2026-09-10, MIT | confirmed |
| `retejs/rete` 12 251 / 2026-09-13; `jagenjo/litegraph.js` 8 134 / **2024-08-01**; `Comfy-Org/litegraph.js` 253 / 2026-01-14; `newcat/baklavajs` 2 093 / 2026-06-17 | confirmed |
| `verekia/gputex` 11 stars, pushed 2026-08-27, MIT | confirmed |
| `richgel999/bc7enc_rdo` "pushed **2026-09-11**" | **corrected** — pushed **2026-07-31**, 277 stars |
| bc7enc_rdo dual MIT / public domain, `bc7e.ispc` Apache-2.0 | confirmed verbatim from `LICENSE` (which also carves out LodePNG — added to the text) |
| `webgpu` (node-webgpu) is MIT | **partly unverified** — npm metadata and the repo's `package.json` both say `MIT`, but GitHub's licence detection reports **BSD-3-Clause** for `dawn-gpu/node-webgpu` (Dawn itself is BSD-3-Clause) and no root `LICENSE` file is fetchable. It is a `devDependencies`-only package, so the exposure is low, but **treat the licence as unsettled** rather than as the flat "MIT" the first draft asserted |

### 16.3 The 7z container — `mcmilk/7-Zip-zstd@master :: DOC/7zFormat.txt`, fetched raw (469 lines)

| Claim | Verdict |
|---|---|
| Little-endian throughout | confirmed (`:102`) |
| `UINT64` variable-length scheme, incl. the `11111111 → BYTE y[8]` form | confirmed (`:111-122`); **line range corrected** (was "110-124") |
| Property IDs `0x00 kEnd` … `0x17 kEncodedHeader`, every ID used by the writer | confirmed (`:129-165`); **range corrected** (was "127-159"). The full list also contains `0x02 kArchiveProperties`, `0x03 kAdditionalStreamsInfo`, `0x10 kAnti`, `0x12-0x16`, `0x18 kStartPos`, `0x19 kDummy` |
| SignatureHeader: `37 7A BC AF 27 1C`, version `0.4`, `StartHeaderCRC` over the 20 bytes at `0x0C`, `NextHeaderOffset` relative to byte 32 | confirmed (`:171-188`); **range corrected** (was "168-186"). Every byte offset in the table is right |
| Coder flag byte bitfield (0:3 CodecIdSize, 4 complex, 5 attributes, 6 reserved, 7 must be 0) | confirmed (`:237-261`); **range corrected** (was "235-259") |
| SubStreamsInfo layout (`kNumUnPackStream`, `kSize`, `kCRC`, `kEnd`) | confirmed (`:316-338`) |
| FilesInfo: `PropertyType`, `UINT64 Size`, then data; `kNames` carries `External` then UTF-16 strings | confirmed (`:361-432`); **range corrected** (was "356-400") |

### 16.4 The reader the engine actually runs — `beyond-all-reason/pr-downloader@master :: src/lib/7z/*`

| Claim | Verdict |
|---|---|
| `LZMA2_DIC_SIZE_FROM_PROP(p) (((UInt32)2 \| ((p) & 1)) << ((p) / 2 + 11))` at `Lzma2Dec.c:35`, `Lzma2Dec_GetOldProps` at `:57-69` with `prop > 40 → SZ_ERROR_UNSUPPORTED` and `prop == 40 → 0xFFFFFFFF` | confirmed **verbatim, line-exact** |
| The dict-prop table (p=0→4 KiB, 12→256 KiB, 16→1 MiB, 18→2 MiB, 19→3 MiB, 20→4 MiB, 24→16 MiB, 26→32 MiB, 28→64 MiB, 40→0xFFFFFFFF) | confirmed by evaluating the macro |
| `lzma2DictProp()` in the writer inverts it correctly and rounds **up** | confirmed (re-derived; the rounding direction is the safe one and is now called out in the text) |
| Folder CRC check `7zDec.c:593-596` | confirmed verbatim |
| "NumCoders must be 1, 2 or 4", quoted as `7zDec.c:305-372` | confirmed in substance; **citation corrected to `:306-373`** |
| `k_LZMA2 = 0x21`, `k_LZMA = 0x30101`, `k_Copy = 0`, `k_BCJ2 = 0x303011B` | confirmed (`7zDec.c:23-30`) |
| The always-9-byte `0xFF` number form is accepted by the engine | **confirmed** — `7zArcIn.c:195-230`, `ReadNumber`; `0xFF` sets every mask bit so the loop reads 8 LE bytes |
| Omitting `kSize`/`kCRC` inside `kSubStreamsInfo` when every folder has 1 stream and a defined CRC | **confirmed** — `7zArcIn.c:886-888` yields `numUnpackSizesInData = 0` and `numSubDigests = 0` |
| *Open question 8:* does the reader accept `kSubStreamsInfo` being absent entirely? | **answered — yes.** `7zArcIn.c:964-973` defaults `NumTotalSubStreams = NumFolders`; `:1285-1286` then passes. Recommendation unchanged (emit it for py7zr / BAR CI) |
| Zero-byte files need `kEmptyStream` | **confirmed and strengthened** — `7zArcIn.c:1285-1286` returns `SZ_ERROR_ARCHIVE`, it is not a silent oddity |
| Filenames: UTF-16LE, NUL-terminated, property size must land exactly | confirmed (`SzReadFileNames`, `7zArcIn.c:1020-1046`) |

### 16.5 The engine — `beyond-all-reason/RecoilEngine@master`

| Claim | Verdict |
|---|---|
| `ArchiveLoader.cpp:19-34` registers five factories, `sdz → CZipArchive` | confirmed line-exact |
| `IArchive.h:136` — `virtual bool CheckForSolid() const { return false; }` | confirmed line-exact |
| The solidity gate rejects badly-packed `.sd7` | confirmed, with the mechanism now sourced: `SevenZipArchive.cpp:166` sets `considerSolid`; `ArchiveScanner.cpp:571-599` returns false on an expensive primary meta-file; `:768-782` then records a `BrokenArchive`. A one-folder-per-file archive is non-solid under that heuristic |
| `SzArEx_IsDir` entries skipped | confirmed (`SevenZipArchive.cpp:140-142`) |
| `.sdz`: `unzOpen()` = `unzOpenInternal(path, NULL, 0)`, no ZIP64 | confirmed (`ZipArchive.cpp:29`, `unzip.c:698-700`) |
| bzip2 is let through the method check then silently delivered **raw** | confirmed verbatim (`unzip.c:1402-1408` and the `#else pfile_in_zip_read_info->raw=1` at `:1443-1445`) |
| Filename buffer 512 bytes; "longer names are silently skipped" | **corrected** — `unzip.c:858-864` only NUL-terminates when `size_filename < bufferSize`; a ≥512-byte name leaves `char fName[512]` (`ZipArchive.cpp:44`) unterminated and `strlen` at `:52` reads out of bounds |
| Per-file size cast to `int`, cited `ZipArchive.cpp:64` | confirmed in substance; **citation corrected to `:63`** |
| CRC verified on read (`ZipArchive.cpp:157-162`) | confirmed |
| `-DNOCRYPT -DNOUNCRYPT`, cited `minizip/CMakeLists.txt:23` | **citation corrected to `:21`**, and it applies only to the bundled-minizip branch |
| `SMALL_TILE_SIZE = 680`; tile mip offsets `{0,512,640,672}`; `GL_TEXTURE_MAX_LEVEL = 3`; 1024² big squares; 1 texel per elmo; tile grid `mapx/4 × mapy/4`; heightfield `(mapx+1)(mapy+1)` uint16; `.smt` header 32 B | **all confirmed directly from the engine**, not just from the companion docs — `SMFFormat.h:28,49-70,119-120,175-183` and `SMFGroundTextures.cpp:515,605` |
| §5's size table is complete | **corrected — gap filled.** It omitted the mandatory minimap (`MINIMAP_SIZE = 699048`, `SMFFormat.h:34`; a *second*, nine-level BC1 encode job §6 never mentions), the typemap and the metalmap (`:63,66`) |

### 16.6 BAR map metadata — `beyond-all-reason/maps-metadata@main`

| Claim | Verdict |
|---|---|
| `schemas/cdn_maps.yaml` has `filename.pattern: '^[^ ]+\.(sd7\|sdz)$'` | confirmed verbatim. Nuance now worth stating: this schema is titled *"Map download info from springfiles API"* — it governs CDN download entries, which is weaker than "the map-pool admission schema permits `.sdz`" |
| `cloud/map-parser/src/parse-worker.ts` hardcodes `false` for `.sdz` solidity | confirmed (`:40-49`); **citation corrected** from `:39-48`. It also parses `Solid = +/-` out of 7-Zip's own output (`:26-38`), which is why `Solid = -` in §7.4's verification run matters |

### 16.7 WebGPU, browsers, the web platform

| Claim | Verdict |
|---|---|
| `spec/index.bs` limit defaults 8192 / 8 / 134 217 728 / 268 435 456 / 256 / 65535 at lines 1666, 1747, 1811, 1845, 1890, 1914 | **confirmed, line-exact, every value** |
| The second column is "Tier-2 / better" | **corrected** — the header at `:1657` reads `Default` \| **`Compatibility Mode Default`**. 4096 and 128 are compatibility-mode values (`featureLevel: "compatibility"`, i.e. no `core-features-and-limits`) |
| `requestDevice()` silently gives spec defaults unless `requiredLimits` asks | confirmed (`:2949-2952`, `:3043-3051`) |
| BCD `api/GPU.json`: Chrome 144 full (113-143 partial), Chrome Android 121, Firefox 141 partial with all six notes, Firefox Android false, Safari 26 | **confirmed verbatim, every note string** |
| caniuse "87.35 % = 85.72 full + 1.63 partial" | **corrected** — recomputed from `Fyrd/caniuse@main :: fulldata-json/data-2.0.json` (updated 2026-08-24): **83.99 full + 2.95 partial = 86.94 %** |
| BCD `FileSystemSyncAccessHandle`: Chrome 102, Firefox 111, Safari 15.2; `createWritable` Chrome 86 / FF 111 / **Safari 26**; `createSyncAccessHandle` Chrome 102 | confirmed |
| BCD `Window.show{Save,Open}FilePicker` / `showDirectoryPicker`: Chrome 86, Chrome Android 132, Firefox `false`, Safari `false` | confirmed |
| Compute shaders are core WebGPU, not a feature flag | confirmed (no `GPUFeatureName` gates them; §1.2 stands) |
| V8 `ArrayBuffer` max = 2³⁴−1 ≈ 16 GiB | **corrected** — `v8/v8@main :: include/v8-internal.h:281` gives `kMaxSafeBufferSizeForSandbox = 32 GiB − 1` as `JSArrayBuffer::kMaxByteLength` under `V8_ENABLE_SANDBOX` (`src/objects/js-array-buffer.h:32-38`); live probe on Node v26.0.0: `2**34` succeeds, `2**35 - 1` succeeds, `2**35` aborts the process |

### 16.8 three.js r186

| Claim | Verdict |
|---|---|
| `WebGPURenderer` constructor auto-installs a `WebGLBackend` fallback; `forceWebGL` forces it | **confirmed verbatim**; citation widened from `:54-73` to `:53-78` (the quote includes `const backend` / `super(...)`) |
| `Renderer.js`: `compileComputeAsync` **1115**, `compute` **2877**, `computeAsync` **2992**, `hasFeature` **3033** | **confirmed, all four line-exact** |
| `compute()` warns and defers to `computeAsync` when uninitialised (line 2883) | confirmed verbatim |
| `hasFeature()` throws if called before `init()` (line 3037) | confirmed verbatim |
| `hasFeatureAsync()` deprecated in r181 | confirmed — the deprecation comment literally reads `// @deprecated r181` (`:3010`) |
| `compileComputeAsync()` is new in r186 | **confirmed** — absent from `Renderer.js` in r183, r184 and r185 |

### 16.9 Packages inspected by unpacking the published tarball

| Claim | Verdict |
|---|---|
| `7z-wasm` is real 7-Zip 24.09, single-threaded, WORKERFS/NODEFS compiled in | confirmed — embedded banner `7-Zip (z) 24.09 (LE) … 2024-11-29`; memory section `flags 1` (not shared); zero `SharedArrayBuffer` / `pthread` / `new Worker` in the glue; `MEMFS`/`NODEFS`/`WORKERFS` all present; `index.d.ts` exports `FS`, `NODEFS`, `WORKERFS`, `callMain` |
| `7zz.wasm` memory: initial 260 pages = "16 MiB", max 32768 = 2048 MiB | max **confirmed**; initial **corrected** to 16.25 MiB |
| "1.83 MiB unpacked" | **corrected** — 1 831 989 B = **1.75 MiB** (1.83 **MB**) |
| **`7z-wasm` is licence-clean relative to `sevenzip-wasm`** | **CORRECTED — this was the most consequential error in the document.** `License.txt` in the published tarball: *"7zz.\*.js, 7zz.wasm: GNU LGPL + unRAR restriction"*; `package.json` declares `"SEE LICENSE IN License.txt"`; it also ships `unRarLicense.txt`. Both candidates carry the same licence, so §7.3's stated reason for choosing between them was void. §7.3 now carries the licence discussion an MIT project actually needs |
| `7z-wasm`'s `readline-sync` dependency would reach the web bundle | **no** — referenced only by `cli.js`; zero hits in `7zz.es6.js` / `7zz.umd.js` (noted in the text) |
| `@napi-rs/lzma` browser build needs COOP/COEP | **confirmed verbatim** from its README |
| "17 prebuilt native targets" | **corrected** — 16 native + 1 `wasm32-wasi` = 17 total |
| `lzma2CompressRaw(data, preset, dictProp)` is implementable on `@napi-rs/lzma` | **corrected** — `lzma2.compress` / `compressSync` take **no options** (`index.d.ts:185-204`); `preset` and `dictSize` exist only on `Lzma2CompressorOptions` (`:145-150`), i.e. on `Lzma2Compressor` / `compressStream`. The default dictionary is **8 MiB**. §7.4 trap 4 now carries working code |
| `@xyflow/system@0.0.82` `nodes.d.ts` `parentId:50`, `extent:56`, `expandParent:58` | first two **confirmed**; `expandParent` **corrected to `:61`** |
| `@xyflow/react@12.11.6` `component-props.d.ts` `onlyRenderVisibleElements:331`, `isValidConnection:613` with the perf note at `:611` | **confirmed, line-exact**; `MiniMap`/`Background`/`Controls`/`NodeResizer`/`NodeToolbar`/`Panel` all confirmed exported from `dist/esm/index.js` |

### 16.10 gputex, fflate, Tauri, WebKit, Electron, Ubuntu

| Claim | Verdict |
|---|---|
| gputex BC1 f16 **0.26 ms** / f32 0.46 ms at 2048², BC7 0.26, ASTC 0.26; the ~2-4 ms upload+readback note; the 100 µs / ~2× timestamp caveat | **confirmed verbatim** from `README.md` |
| gputex: WebGL2 fragment fallback into `RGBA32UI`, chain `WebGPU → WebGL2 → RGBA8`, BC1/BC5/BC7/ASTC/ETC2, "up to two least-squares endpoint refit rounds", "≤0.1 dB", `encodeMipChainToBytes` single submission, `generateGpuMipChain` box filter "integer-exact against the CPU one, so both paths emit identical bytes" | **confirmed verbatim, every one** |
| gputex's chain is the right length for SMT | **gap filled** — `mipmaps: true` / `generateMipChain` go *down to 1×1*; SMT needs 4 levels and the minimap needs 9. Slice the result |
| fflate `wzh()` at 2809 writes 32-bit sizes at `b+8` (2823); filename cap at 3153; ZIP64 read-only via `z64hs()` at 2772 | **confirmed, line-exact** |
| fflate output is deterministic | **gap filled / corrected** — `src/index.ts:2817` bakes `Date.now()` into the DOS date when `mtime` is absent, and `:2818` rejects years outside 1980-2099. §10.2's determinism rule needs an explicit fixed `mtime`; §7.1 now says so with code |
| Tauri `additionalBrowserArgs` is Windows-only | **confirmed verbatim** — `tauri-utils/src/config.rs:2107`, *"Defines additional browser arguments on Windows."* |
| WebKitGTK has no WebGPU and no flag to enable it *(open question 4)* | **answered from source** — `WebKitFeatures.cmake:312` `ENABLE_WEBGPU … OFF`; `OptionsGTK.cmake` has no `WEBGPU` occurrence; `UnifiedWebPreferences.yaml:7089-7091` defaults `WebGPUEnabled` false outside `ENABLE(WEBGPU_BY_DEFAULT)`. **Not compiled in.** The Electron recommendation stands |
| "Ubuntu 22.04 ships webkit2gtk 2.36" | **corrected** — the *release* pocket did (`2.36.0-2ubuntu1`), but jammy-updates/security currently publish `2.50.4-0ubuntu0.22.04.1` (Launchpad). WebKitGTK is security-updated in place; the WebGPU conclusion is unaffected |
| Electron 44.3.0 → Chromium 152 | **confirmed exactly** — `releases.electronjs.org/releases.json`: `chrome 152.0.7977.78`, `node 24.20.0`, `2026-09-08` |

### 16.11 Arithmetic re-derived (all from scratch)

Confirmed: `1025² × 4 = 4 202 500`; `8192² × 4 = 268 435 456` (= the `maxBufferSize` default exactly);
`8192² × 3 = 201 326 592`; `8192²/2 = 33 554 432`; `× 1.328125 = 44 564 480`;
`32 + 65 536 × 680 = 44 564 512`; `1.328125 = 1 + ¼ + 1⁄16 + 1⁄64`; `512+128+32+8 = 680`;
`64 × (1024²+512²+256²+128²) = 89 128 960` ≈ 89.1 MPix; the heightfield/triangle table for 8×8,
16×16, 26×4 and 36×36; `65 536 × 4 = 262 144`; every percentage in §7.2 (`+16.85 %`, `+17.20 %`,
`−0.45 %`, `−0.22 %`, `+6.31 %`, `+0.05 %`, the 3.2× and 11× ratios); `35.31 MiB / 5.73 s = 6.16 MiB/s`;
the pure-JS BC1 extrapolation chain (4.19 MPix / 0.129 s → 32.5 MPix/s → 2.1 s → ×1.328 → 2.8 s → /8 →
0.35 s); `260 × 64 KiB` and `32 768 × 64 KiB`; and — newly — `MINIMAP_SIZE`: `Σ (1024>>i)²/2` for
`i = 0..8` = **699 048**, matching the engine constant exactly.

**Corrected:** §4.3's `1025² Float32Array = 4 206 500 B` (→ **4 202 500**, and it contradicted §5's
own correct figure) and `4097² = 67 125 316 B` (→ **67 141 636**; thirty of them is 1.88 GiB, not 2).

### 16.12 Not verified — treat as assertions, not facts

* **`webgpu@0.6.1`'s licence** (npm says MIT, GitHub detects BSD-3-Clause; see §16.2) and its
  prebuilt-binary platform list (`darwin-universal`, `linux-{x64,arm64}`, `win32-{x64,arm64}`) — the
  latter is a `ls` from the original session that this pass did not re-run (the package is 90 MiB).
* **Every timing in §6.2(d), §7.2 and §7.4** — single-machine measurements from the original session
  (Apple M4, Node v26.0.0). Not re-run here. The *arithmetic* within them is checked (§16.11); the
  underlying stopwatch is not reproducible from this pass.
* **The `hooked_1.1.1.sd7` fixture** (md5, 20 272 378 B, 67 files, 37 023 076 B uncompressed) — not
  re-downloaded. If it becomes a CI fixture, re-verify the md5 at that point.
* **The claim that the hand-written 7z writer's output loads *in the engine***. It was verified
  against 7-Zip 24.09 (`Everything is Ok`) and py7zr. Everything the engine's reader requires has now
  been checked line-by-line against `7zArcIn.c` / `7zDec.c` (§16.4) and the writer satisfies all of
  it — but no actual Recoil binary has opened the file. Risk 6 in §13 remains correctly stated.
* **`fflate` "~8 kB for the zip path"** and **`three` "~700 kB"** — bundle-size estimates from the
  packages' own material, not measured here.
* **The LGPL-2.1 analysis in §7.3** is an engineering reading of the licence text, not legal advice.
  The *facts* (which files, which licence) are verified; the conclusion about what compliance
  requires is not a verified claim.
* **Open questions 1, 2, 3, 5, 6, 7** in §14 — RDO size win, tile-dedup yield, `.sdz` social
  acceptability, GPU/CPU erosion crossover, BC1 refit PSNR delta, and WORKERFS copy behaviour. All
  **UNVERIFIED — need experiments**; none is a claim this document relies on elsewhere.
