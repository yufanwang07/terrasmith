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
