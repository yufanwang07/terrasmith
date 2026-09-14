# Terrasmith architecture

## What this is

A terrain builder that targets Beyond All Reason specifically. That focus is the
whole design: a general terrain tool can only tell you a slope is 40 degrees,
whereas Terrasmith knows that 40 degrees stops every tank in the game and shows
you the pocket of map you just made unreachable.

Three things have to be true at once:

1. **As capable as World Machine.** A real node graph, real erosion, real
   masks and selectors, resolution-independent evaluation, a build step that
   produces final-quality output from the same graph as the preview.
2. **Usable by someone who has never opened a node editor.** Templates, a
   guided mode that is a real graph underneath, live preview, and parameters
   that explain themselves.
3. **Correct against the engine.** The output has to load in BAR, first try,
   with the right height range, working metal spots, and a texture that does
   not look like a photograph of noise.

## Package layout

```
packages/
  format/   Spring/Recoil binary formats. No DOM, no Node built-ins.
  core/     Terrain maths. Fields, noise, erosion, analysis, BAR rules.
  graph/    The node graph engine and the node catalog.
  build/    Graph output -> .smf/.smt/mapinfo.lua/.sd7. Depends on format + core.
  cli/      Headless builds, batch export, CI.
apps/
  studio/   The editor. React + WebGPU/WebGL + three.js.
```

Dependencies point one way: `format` and `core` know nothing about each other,
`graph` builds on `core`, `build` joins `graph` to `format`, and both `cli` and
`studio` sit on top. Nothing below `studio` touches the DOM, so every layer runs
in a worker, in Node, and in CI.

## The data model

One type carries almost everything: a `Field`, a row-major `Float32Array` with a
width and a height. Heights, masks, flow, wetness, curvature — all the same
structure, so any output can drive any input without a conversion node. That is
World Machine's model and it removes a whole category of beginner confusion.

Heights are in **elmos**, BAR's world unit, not normalised 0..1. Working in real
units is what lets the slope readout, the water line, and the "can a bot climb
this" overlay mean something without a mental conversion. A 16x16 map is 8192
elmos across and its heightfield is 1025x1025 samples.

## Resolution independence

Every generator samples a continuous domain, so the same graph evaluated at 512
and at 8192 produces the same terrain at different detail. This is not a nicety:
it is what makes the preview honest. A tool whose preview does not predict its
build is a tool you have to render to use.

Erosion is the exception — a simulation does depend on grid spacing — so erosion
parameters are expressed as densities and world distances rather than iteration
counts and pixel radii, and the engine scales them by the evaluation resolution.

## What the preview is for

The viewport's job is to predict `SMFFragProg.glsl`, not to look good. Recoil's
ground shader is not a physically based one, and every place three.js would do
the modern, correct thing is a place the preview would stop agreeing with the
game — so the studio reproduces the engine's equation instead of approximating
it with three's lights.

Three properties of that equation drive the whole design, and each of them was
a visible bug before it was understood:

- **The lighting multiply happens in gamma space.** There is no sRGB decode
  anywhere in the engine's map path, and the diffuse is uploaded as the
  non-sRGB `GL_COMPRESSED_RGBA_S3TC_DXT1_EXT`. Lighting in linear and encoding
  on the way out — what three does by default — compresses contrast rather than
  shifting it: with the engine's own light values it leaves ambient-only ground
  91% too bright and drops the ratio between lit and shadowed ground from 2.06
  to 1.48.
- **The ambient term is flat.** It does not vary with the normal and it is never
  shadowed, so a vertical cliff gets exactly as much of it as the plateau above.
  A `HemisphereLight` — a sky gradient the engine has no term for — halves it on
  the steep faces an RTS author most needs to judge.
- **Shading is not clamped.** `(0.4 + 0.9) x 0.8235` is 1.07 on a face square to
  the sun, so sun-facing slopes clip. That is a true warning about the declared
  lighting, not something to tune away, and `collectMapInfoProblems` says so
  when a block's peak goes further.

`packages/format/src/mapinfo/lighting.ts` is the tested reference for the
arithmetic; `apps/studio/src/components/groundMaterial.ts` reproduces it in
GLSL. GLSL cannot be unit-tested from Node, so the studio serves a
`shader-parity.html` in development that reads its own framebuffer back and
checks it against values taken off the engine's shader — run `npm run dev` in
`apps/studio` and open `/shader-parity.html`.

The same rule decides what the preview does *not* do. No runtime ambient
occlusion, because the bake already has it and a second pass would darken twice
and would change when the camera moved. No stochastic tiling to hide the detail
textures' repetition, because that repetition is a real property of the map
about to be exported and hiding it removes the author's only chance to see it.
No triplanar mapping on cliffs, because the engine samples detail on world XZ
and the vertical smear it produces is what the game will show.

## Evaluation

The graph is pull-based and memoised on content. Each node's result is keyed by
a hash of its type, its parameters, its inputs' hashes, and the evaluation
context. Change one parameter and only that node and its descendants recompute;
change it back and the cache still has the old result.

Evaluation is async and cancellable throughout, because a preview must be
abandonable the moment a slider moves again.

## Where the work happens

CPU first, in TypeScript, with the option of a worker pool. That path is the
reference implementation: it is what the tests assert against, what the CLI
uses, and what runs when WebGPU is unavailable. A WebGPU path accelerates the
expensive nodes (noise, erosion, blur, occlusion) and must agree with the CPU
path within tolerance — a GPU result that differs visibly from the CPU one is a
bug, not an optimisation.

## What makes it beginner-friendly

- **Templates** that are complete, playable maps, not empty graphs.
- **Guided mode** is the same graph with a curated parameter form over it.
  Switching to the graph reveals what the form was driving, which turns the
  simple mode into a teaching tool rather than a dead end.
- **Overlays** that answer gameplay questions directly: where can tanks drive,
  where can a lab be placed, where is the metal, is this symmetric.
- **Validation** against real BAR rules before export, not after a failed load.
- **One button** that produces a `.sd7` with everything in it.

## What the export produces

```
MyMap.sd7
  maps/MyMap.smf          heightmap, typemap, metalmap, minimap, tile indices, features
  maps/MyMap.smt          deduplicated DXT1 tiles
  maps/MyMap_specular.dds the master switch for advanced shading
  maps/MyMap_splat.dds    RGBA splat weights
  maps/MyMap_normals.dds  detail normals
  mapinfo.lua             literal-first, lowercased, mapconfig-mergeable
  maphelper/mapinfo.lua   legacy include
  mapconfig/...           map options, metal spot list
  README.md
```

plus the `maps-metadata` JSON (startboxes, metal spots, tags) a map needs to
enter BAR's curated pool.
